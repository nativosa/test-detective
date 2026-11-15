import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ShortPathLookup } from '../workspace.ts';
import { duplicateIds, evaluateCheck, observedToken, parseProbeOutput, prepareCheck, probePayload } from './check.ts';
import type { CheckItem, CheckReport, CheckSetup, ProbeReport, TeardownReport } from './check.ts';
import { denyRootFor, REPO_ROOT, RUNTIME_SCRIPTS_DIR, runtimeDir, shadowInventoryFile, shadowPendingFile, stateDir, tokenFile, workDir } from './config.ts';
import type { SandboxConfig } from './config.ts';
import { hostFromEnv, launchRestricted, RestrictedLaunchError } from './launcher.ts';
import type { LaunchHost, SpawnFn } from './launcher.ts';
import { createPrivateJson, dropInterruptedCreate, readPrivateJson, removePrivateFile, sha256Json, shownPath } from './private-state.ts';
import { verifyStagedRuntime } from './runtime.ts';
import { finalizeShadow, pendingProblems, planShadowAttempts, SHADOW_CONTROL_FILE, ShadowPending, ShadowPendingFile, shadowResultsOf, withoutShadowResults } from './shadow.ts';
import type { ShadowJudgement } from './shadow.ts';

// R4b Step 1D: runs the enforcement check. "self" runs the probe as the current (developer) user in
// temp folders: an offline test of the probe and the verdict logic, never an isolation proof (it
// must end BLOCKER, because the developer can read everything). "account" runs it as the evaluation
// account through the launcher; it needs the account, the staged runtime, the per-run workspace
// grant and a recorded shadow-copy inventory, and is not run in this step. Its shadow part stays
// INCONCLUSIVE until `check --finalize-shadow` judges it with the inventory taken after the probe.

const exec = promisify(execFile);
export type CheckRun = { mode: 'self' | 'account' | 'finalize-shadow'; report: CheckReport; shadow?: ShadowJudgement['categories']; runId?: string };

/** The repo root as the inventory spells it: drive letter upper-case, no trailing separator. */
export function canonicalRepoRoot(repoRoot: string = REPO_ROOT): string {
  const resolved = path.win32.resolve(repoRoot);
  return resolved.slice(0, 1).toUpperCase() + resolved.slice(1);
}

/**
 * SHA-256s of every committed version of the control file, computed on the host from git objects
 * (never from a shadow copy, never by the evaluation account). They stay in the host's pending
 * record; the probe never receives them.
 */
export async function committedControlHashes(repoRoot: string = REPO_ROOT): Promise<string[]> {
  const { stdout } = await exec('git', ['-C', repoRoot, 'rev-list', '--all', '--', SHADOW_CONTROL_FILE], { windowsHide: true });
  const hashes = new Set<string>();
  for (const commit of stdout.split(/\r?\n/).filter((l) => /^[0-9a-f]{40}$/.test(l))) {
    try {
      const blob = await exec('git', ['-C', repoRoot, 'show', `${commit}:${SHADOW_CONTROL_FILE}`], { encoding: 'buffer', windowsHide: true, maxBuffer: 1 << 20 });
      hashes.add(createHash('sha256').update(blob.stdout).digest('hex'));
    } catch {
      // The file was deleted in that commit: no version to compare with.
    }
  }
  return [...hashes].sort();
}

/** The recorded inventory from before the check, or an error that stops the check before anything starts. */
async function inventoryBefore(localAppData: string): Promise<unknown> {
  const file = shadowInventoryFile(localAppData, 'before');
  const loaded = await readPrivateJson(localAppData, file);
  if ('missing' in loaded) throw new Error(`No shadow-copy inventory at ${shownPath(file)}. In an elevated shell, run: scripts\\eval-sandbox\\vss-inventory.ps1 | node src\\eval\\sandbox\\shadow-record.ts before`);
  if ('problem' in loaded) throw new Error(`The shadow-copy inventory can't be used: ${loaded.problem}.`);
  return loaded.value;
}

/**
 * Test seams for the account check, so the whole before/probe/after/finalize flow runs offline with
 * a fake probe. The defaults are the real operations; tests never reach them.
 */
export type AccountCheckSeams = {
  verifyRuntime?: (repoRoot: string, runtime: string) => Promise<{ problems: string[] }>;
  /** Folder that receives the per-check workspace (default <sandbox>\work). */
  workRoot?: string;
  grantWorkspace?: (workspace: string) => Promise<void>;
  /** The other attempts' setup (default accountCheckSetup over the repo, TEMP and profile). */
  checkSetup?: (workspace: string) => CheckSetup;
  /** Runs probe.mjs or teardown.mjs as the evaluation account and returns its stdout. */
  runScript?: (script: 'probe.mjs' | 'teardown.mjs', args: string[], workspace: string) => Promise<string>;
  committedHashes?: () => Promise<string[]>;
  clock?: () => Date;
};

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
 * manifest built now from the repo, and unless a usable, fresh elevated shadow-copy inventory was
 * recorded (shadow-record.ts before). Grants the group read on one fresh workspace under
 * <sandbox>\work and removes it after. The probe also reads the control file once through every
 * relevant shadow copy; those results are judged apart from the other attempts (whose report they
 * never change) and kept in the private pending record, so the report stays INCONCLUSIVE until
 * finalizeShadowCheck has the inventory taken after the probe. A pending record from an earlier run
 * blocks a new one until it is discarded (discardShadowPending), and the record is created without
 * ever replacing a file, so no run overwrites another's. On a check whose identity items pass,
 * records the observed token for setup.ps1 -Verify. NOT RUN yet: it needs the account
 * (setup.ps1 -Apply) and a staged runtime.
 */
export async function runAccountCheck(config: SandboxConfig, options: { shortPaths: ShortPathLookup; spawn?: SpawnFn; host?: LaunchHost; seams?: AccountCheckSeams }): Promise<CheckRun> {
  const seams = options.seams ?? {};
  const clock = seams.clock ?? (() => new Date());
  const runtime = runtimeDir(config);
  const { problems } = await (seams.verifyRuntime ?? verifyStagedRuntime)(REPO_ROOT, runtime);
  if (problems.length > 0) throw new Error(`The staged runtime does not match the repo: ${problems.slice(0, 5).join('; ')}`);
  const developer = { username: userInfo().username, home: homedir(), sid: await developerSid() };
  const host = options.host ?? hostFromEnv(process.env, developer);
  const shadowOptions = { computer: host.computer, repoRoot: canonicalRepoRoot() };
  const pendingFile = shadowPendingFile(host.localAppData);
  const before = await inventoryBefore(host.localAppData);
  const unusable = planShadowAttempts(before, { ...shadowOptions, now: clock() }).items.find((i) => i.id === 'shadow-inventory' && i.status !== 'pass');
  if (unusable) throw new Error(`${unusable.detail}. Nothing was started.`);
  const committedHashes = await (seams.committedHashes ?? committedControlHashes)();
  const release = await acquireSandboxLock(host.localAppData);
  try {
    const existing = await readPrivateJson(host.localAppData, pendingFile);
    if (!('missing' in existing)) throw new Error(`A pending account check exists (${shownPath(pendingFile)}). Finalize it (check --finalize-shadow) and discard it (check --discard-shadow-pending <run ID>) first. Nothing was started.`);
    const runId = randomBytes(16).toString('hex');
    const workspace = await mkdtemp(path.join(seams.workRoot ?? workDir(config), 'check-'));
    try {
      if (seams.grantWorkspace) await seams.grantWorkspace(workspace);
      else await exec(path.join(host.systemRoot, 'System32', 'icacls.exe'), [workspace, '/grant', `${host.computer}\\${config.group}:(OI)(CI)RX`], { windowsHide: true });
      const prepared = await prepareCheck(seams.checkSetup ? seams.checkSetup(workspace) : accountCheckSetup({ repoRoot: REPO_ROOT, temp: tmpdir(), profile: homedir(), runtime, workspace }, options.shortPaths));
      try {
        const run = async (script: 'probe.mjs' | 'teardown.mjs', args: string[]) => {
          if (seams.runScript) return seams.runScript(script, args, workspace);
          const launched = launchRestricted(config, host, { target: { kind: 'script', script, args }, env: {}, expect: { account: config.account } }, workspace, { spawn: options.spawn });
          const output = collect(launched.child, 120_000);
          launched.child.stdin.end();
          await launched.identity;
          return (await output).stdout;
        };
        const extra: CheckItem[] = [];
        let probe: ProbeReport | null = null;
        let teardown: TeardownReport | null = null;
        // Planned at the probe's start, so the inventory's age is measured from then.
        const probeStartedAt = clock();
        const shadowPlan = planShadowAttempts(before, { ...shadowOptions, now: probeStartedAt });
        const attempts = [...prepared.attempts, ...shadowPlan.attempts];
        const clashes = duplicateIds(attempts);
        if (clashes.length > 0) throw new Error(`Check attempts need unique IDs; duplicated: ${clashes.join(', ')}.`);
        try {
          probe = parseProbeOutput(await run('probe.mjs', [probePayload(attempts, [homedir(), developer.username])]));
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
        const probeEndedAt = clock();
        const expect = { account: config.account, developer, tokenGroup: `${host.computer}\\${config.group}` };
        const base = evaluateCheck(prepared.attempts, probe ? withoutShadowResults(probe) : null, expect, teardown, extra);
        const identityOk = ['identity-account', 'identity-not-developer', 'token-observed'].every((id) => base.items.find((i) => i.id === id)?.status === 'pass');
        const token = probe && identityOk ? observedToken(probe.identity, config.account) : null;
        if (token) {
          const file = tokenFile(host.localAppData);
          await writeFile(`${file}.tmp`, `${JSON.stringify(token, null, 2)}\n`);
          await rename(`${file}.tmp`, file);
        }
        const pending: ShadowPending = {
          schema: 2,
          runId,
          ...shadowOptions,
          account: config.account,
          probeStartedAt: probeStartedAt.toISOString(),
          probeEndedAt: probeEndedAt.toISOString(),
          before,
          beforeSha256: sha256Json(before),
          attempts: shadowPlan.attempts.map(({ id, path: p }) => ({ id, path: p })),
          results: shadowResultsOf(probe),
          committedHashes,
          base,
        };
        await createPrivateJson(host.localAppData, pendingFile, { record: pending, sha256: sha256Json(pending) });
        const { report, categories } = finalizeShadow(pending, null, shadowOptions);
        return { mode: 'account', report, shadow: categories, runId };
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

/** The pending record, validated: sealed hash, schema, binding to this host and repo, and its own consistency. Throws (exit 1, no verdict) otherwise. */
async function loadPending(localAppData: string, options: { computer: string; repoRoot: string }): Promise<ShadowPending> {
  const file = shadowPendingFile(localAppData);
  const loaded = await readPrivateJson(localAppData, file);
  if ('missing' in loaded) throw new Error(`No pending account check at ${shownPath(file)}; run check --account first.`);
  if ('problem' in loaded) throw new Error(`The pending account check can't be used: ${loaded.problem}.`);
  const sealed = ShadowPendingFile.safeParse(loaded.value);
  if (!sealed.success || sha256Json(sealed.data.record) !== sealed.data.sha256) throw new Error('The pending account check was changed or is incomplete (its seal does not match); it was rejected.');
  const pending = ShadowPending.safeParse(sealed.data.record);
  if (!pending.success) throw new Error(`The pending account check is malformed (${pending.error.issues.length} problems); it was rejected.`);
  const problems = pendingProblems(pending.data, options);
  if (sha256Json(pending.data.before) !== pending.data.beforeSha256) problems.push('its inventory does not match the hash it recorded');
  if (problems.length > 0) throw new Error(`The pending account check was rejected: ${problems.join('; ')}.`);
  return pending.data;
}

/**
 * The account check's final report: its pending record judged with the elevated inventory taken
 * after the probe (shadow-record.ts after). It reads three private files and judges; it launches
 * nothing (no probe, no git, no process) and changes nothing, so a failed or repeated finalization
 * leaves the same state. The record must be intact, of this computer and repo, and of the
 * before-inventory still recorded now (a record of another inventory is rejected). A missing,
 * linked, unreadable, stale, early, future-dated or inconsistent second inventory leaves the
 * shadow part INCONCLUSIVE, never PASS.
 */
export async function finalizeShadowCheck(options: { computer: string; localAppData: string; now?: Date }): Promise<CheckRun> {
  const identity = { computer: options.computer, repoRoot: canonicalRepoRoot() };
  const pending = await loadPending(options.localAppData, identity);
  const before = await readPrivateJson(options.localAppData, shadowInventoryFile(options.localAppData, 'before'));
  if (!('value' in before) || sha256Json(before.value) !== pending.beforeSha256) throw new Error(`The pending account check (run ${pending.runId}) was planned from another inventory than the one recorded now; it was rejected.`);
  const after = await readPrivateJson(options.localAppData, shadowInventoryFile(options.localAppData, 'after'));
  // A problem stays visible as an unusable inventory (judgeShadowStability reports it malformed), not as a missing one.
  const afterValue = 'value' in after ? after.value : 'missing' in after ? null : { unusable: after.problem };
  const { report, categories } = finalizeShadow(pending, afterValue, { ...identity, now: options.now ?? new Date() });
  return { mode: 'finalize-shadow', report, shadow: categories, runId: pending.runId };
}

/**
 * Deletes the pending record (after it was finalized, or to give up on it), so a new account check may
 * run. Only the exact expected record: intact (seal and schema), of this computer and repo, and of the
 * run ID the caller names; under the sandbox lock, so no account check runs meanwhile, and unchanged
 * between reading and removing it. Anything else (a link, an alias, a second hard link, an unreadable,
 * edited or foreign record, another run) is refused and left in place for a person to review. Only the
 * fixed record file is ever removed, plus its own temp name left by an interrupted create.
 */
export async function discardShadowPending(options: { computer: string; localAppData: string; runId: string }): Promise<{ removed: boolean; runId: string | null }> {
  if (!/^[0-9a-f]{32}$/.test(options.runId)) throw new Error('Name the pending run to discard: its 32-character run ID from check --account.');
  const file = shadowPendingFile(options.localAppData);
  const release = await acquireSandboxLock(options.localAppData);
  try {
    await dropInterruptedCreate(options.localAppData, file);
    const loaded = await readPrivateJson(options.localAppData, file);
    if ('missing' in loaded) return { removed: false, runId: null };
    const review = `Nothing was removed; review ${shownPath(file)} and remove it by hand if it should go.`;
    if ('problem' in loaded) throw new Error(`The pending account check can't be identified: ${loaded.problem}. ${review}`);
    const sealed = ShadowPendingFile.safeParse(loaded.value);
    const pending = sealed.success && sha256Json(sealed.data.record) === sealed.data.sha256 ? ShadowPending.safeParse(sealed.data.record) : null;
    if (!pending?.success) throw new Error(`The pending account check is changed, incomplete or malformed, so it can't be identified. ${review}`);
    if (pending.data.runId !== options.runId) throw new Error(`The pending account check is run ${pending.data.runId}, not ${options.runId}. Nothing was removed.`);
    if (pending.data.computer.toLowerCase() !== options.computer.toLowerCase() || pending.data.repoRoot.toLowerCase() !== canonicalRepoRoot().toLowerCase()) throw new Error(`The pending account check belongs to another computer or repo. ${review}`);
    const again = await readPrivateJson(options.localAppData, file);
    if (!('value' in again) || sha256Json(again.value) !== sha256Json(loaded.value)) throw new Error(`The pending account check changed while it was being discarded. ${review}`);
    return { removed: await removePrivateFile(options.localAppData, file), runId: pending.data.runId };
  } finally {
    await release();
  }
}
