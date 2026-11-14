import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ShortPathLookup } from '../workspace.ts';
import { evaluateCheck, observedToken, parseProbeOutput, prepareCheck, probePayload } from './check.ts';
import type { CheckItem, CheckReport, CheckSetup, ProbeReport, TeardownReport } from './check.ts';
import { denyRootFor, REPO_ROOT, RUNTIME_SCRIPTS_DIR, runtimeDir, stateDir, tokenFile, workDir } from './config.ts';
import type { SandboxConfig } from './config.ts';
import { hostFromEnv, launchRestricted, RestrictedLaunchError } from './launcher.ts';
import type { LaunchHost, SpawnFn } from './launcher.ts';
import { verifyStagedRuntime } from './runtime.ts';

// R4b Step 1D: runs the enforcement check. "self" runs the probe as the current (developer) user in
// temp folders: an offline test of the probe and the verdict logic, never an isolation proof (it
// must end BLOCKER, because the developer can read everything). "account" runs it as the evaluation
// account through the launcher; it needs the account, the staged runtime and the per-run workspace
// grant, and is not run in this step.

const exec = promisify(execFile);
export type CheckRun = { mode: 'self' | 'account'; report: CheckReport };

export async function developerSid(): Promise<string | null> {
  try {
    const { stdout } = await exec(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    return /"(S-1-[0-9-]+)"/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

function collect(child: { stdout: NodeJS.ReadableStream; once(event: 'exit', listener: (code: number | null) => void): unknown; kill(): boolean }, timeoutMs: number): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, code });
    });
  });
}

/**
 * The account-mode attempts, as a pure function so tests exercise exactly this configuration. Labels
 * are unique across the three lists (prepareCheck refuses collisions): the TEMP probe folder is
 * `temp`, the TEMP root listing `temp-root`.
 */
export function accountCheckSetup(paths: { repoRoot: string; temp: string; profile: string; runtime: string; workspace: string }, shortPaths: ShortPathLookup): CheckSetup {
  const denyRoot = denyRootFor(paths.repoRoot);
  return {
    workspace: paths.workspace,
    protectedParents: [{ label: 'repo', dir: path.join(paths.repoRoot, '.work') }, { label: 'temp', dir: paths.temp }],
    writeTargets: [{ label: 'deny-root', dir: denyRoot }, { label: 'runtime', dir: paths.runtime }],
    listTargets: [{ label: 'repo-root', dir: paths.repoRoot }, { label: 'deny-root', dir: denyRoot }, { label: 'profile', dir: paths.profile }, { label: 'temp-root', dir: paths.temp }],
    workspaceWrite: 'deny',
    developerProfile: paths.profile,
    shortPaths,
  };
}

/**
 * One sandbox session at a time: teardown.mjs ends every process of the evaluation account, so a
 * second concurrent session would be killed by the first one's teardown. The lock lives in the
 * developer's private folder; a lock whose process is gone is stale and replaced.
 */
export async function acquireSandboxLock(localAppData: string): Promise<() => Promise<void>> {
  const file = path.join(stateDir(localAppData), 'sandbox.lock');
  await mkdir(stateDir(localAppData), { recursive: true });
  const mine = `${process.pid} ${Date.now()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(mine);
      await handle.close();
      return async () => {
        if ((await readFile(file, 'utf8').catch(() => '')) === mine) await unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number((await readFile(file, 'utf8').catch(() => '')).split(' ')[0]);
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      }
      if (alive) throw new Error(`Another sandbox session (process ${pid}) holds ${file}; only one may run at a time.`);
      await unlink(file).catch(() => {});
    }
  }
  throw new Error(`Could not take ${file}.`);
}

/** The probe as the current user, in disposable temp folders only. */
export async function runSelfCheck(options: { shortPaths: ShortPathLookup; parent?: string }): Promise<CheckRun> {
  const root = await mkdtemp(path.join(options.parent ?? tmpdir(), 'td-selfcheck-'));
  try {
    const dirs = { workspace: path.join(root, 'workspace'), repo: path.join(root, 'repo'), temp: path.join(root, 'temp') };
    for (const d of Object.values(dirs)) await mkdir(d);
    const setup: CheckSetup = {
      workspace: dirs.workspace,
      protectedParents: [{ label: 'repo', dir: path.join(dirs.repo, '.work') }, { label: 'temp', dir: dirs.temp }],
      writeTargets: [{ label: 'deny-root', dir: dirs.repo }],
      listTargets: [{ label: 'repo-root', dir: dirs.repo }, { label: 'temp-root', dir: dirs.temp }],
      workspaceWrite: 'deny',
      developerProfile: homedir(),
      shortPaths: options.shortPaths,
    };
    const prepared = await prepareCheck(setup);
    try {
      const child = spawn(process.execPath, [path.join(RUNTIME_SCRIPTS_DIR, 'probe.mjs'), probePayload(prepared.attempts, [homedir()])], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
      const { stdout } = await collect(child, 60_000);
      const expect = { account: '(none: self mode)', developer: { username: userInfo().username, home: homedir(), sid: await developerSid() } };
      return { mode: 'self', report: evaluateCheck(prepared.attempts, parseProbeOutput(stdout), expect, null) };
    } finally {
      await prepared.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A refused launch as a check item: a wrong identity is a BLOCKER, anything else (no start, timeout) inconclusive. */
export function launchItem(id: string, error: unknown): CheckItem {
  const wrongIdentity = error instanceof RestrictedLaunchError && error.identity;
  return { id, status: wrongIdentity ? 'fail' : 'inconclusive', detail: error instanceof Error ? error.message : String(error) };
}

/**
 * The probe and the teardown as the evaluation account. Refuses unless the staged runtime matches a
 * manifest built now from the repo. Grants the group read on one fresh workspace under <sandbox>\work
 * and removes it after. On a check whose identity items pass, records the observed token for
 * setup.ps1 -Verify. NOT RUN in Step 1D.1: it needs the account (setup.ps1 -Apply) and a staged runtime.
 */
export async function runAccountCheck(config: SandboxConfig, options: { shortPaths: ShortPathLookup; spawn?: SpawnFn; host?: LaunchHost }): Promise<CheckRun> {
  const runtime = runtimeDir(config);
  const { problems } = await verifyStagedRuntime(REPO_ROOT, runtime);
  if (problems.length > 0) throw new Error(`The staged runtime does not match the repo: ${problems.slice(0, 5).join('; ')}`);
  const developer = { username: userInfo().username, home: homedir(), sid: await developerSid() };
  const host = options.host ?? hostFromEnv(process.env, developer);
  const release = await acquireSandboxLock(host.localAppData);
  try {
    const workspace = await mkdtemp(path.join(workDir(config), 'check-'));
    try {
      await exec(path.join(host.systemRoot, 'System32', 'icacls.exe'), [workspace, '/grant', `${host.computer}\\${config.group}:(OI)(CI)RX`], { windowsHide: true });
      const prepared = await prepareCheck(accountCheckSetup({ repoRoot: REPO_ROOT, temp: tmpdir(), profile: homedir(), runtime, workspace }, options.shortPaths));
      try {
        const run = async (script: 'probe.mjs' | 'teardown.mjs', args: string[]) => {
          const launched = launchRestricted(config, host, { target: { kind: 'script', script, args }, env: {}, expect: { account: config.account } }, workspace, { spawn: options.spawn });
          const output = collect(launched.child, 120_000);
          launched.child.stdin.end();
          await launched.identity;
          return (await output).stdout;
        };
        const extra: CheckItem[] = [];
        let probe: ProbeReport | null = null;
        let teardown: TeardownReport | null = null;
        try {
          probe = parseProbeOutput(await run('probe.mjs', [probePayload(prepared.attempts, [homedir(), developer.username])]));
        } catch (error) {
          extra.push(launchItem('launch-probe', error));
        } finally {
          try {
            const line = (await run('teardown.mjs', ['--account', config.account])).split(/\r?\n/).find((l) => l.startsWith('{'));
            const parsed = line ? (JSON.parse(line) as Partial<TeardownReport>) : null;
            teardown = parsed && typeof parsed.remaining === 'number' ? (parsed as TeardownReport) : null;
          } catch (error) {
            extra.push(launchItem('launch-teardown', error));
            teardown = null;
          }
        }
        const expect = { account: config.account, developer, tokenGroup: `${host.computer}\\${config.group}` };
        const report = evaluateCheck(prepared.attempts, probe, expect, teardown, extra);
        const identityOk = ['identity-account', 'identity-not-developer', 'token-observed'].every((id) => report.items.find((i) => i.id === id)?.status === 'pass');
        const token = probe && identityOk ? observedToken(probe.identity, config.account) : null;
        if (token) {
          const file = tokenFile(host.localAppData);
          await writeFile(`${file}.tmp`, `${JSON.stringify(token, null, 2)}\n`);
          await rename(`${file}.tmp`, file);
        }
        return { mode: 'account', report };
      } finally {
        await prepared.cleanup();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  } finally {
    await release();
  }
}
