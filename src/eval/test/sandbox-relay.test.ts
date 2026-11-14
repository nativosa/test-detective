import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_SANDBOX, RUNTIME_SCRIPTS_DIR } from '../sandbox/config.ts';
import { buildLaunch, hostFromEnv, parseIdentityLine } from '../sandbox/launcher.ts';

// R4b Step 1D: the launcher's relay and job object (scripts/eval-sandbox/TdSandboxRelay.cs),
// compiled exactly as launch-as.ps1 compiles it, under the minimal environment buildLaunch gives
// the launcher, and run against children started AS THE CURRENT USER only (a test harness without
// UserName or Password). Nothing here logs on as, or starts anything under, another identity, and
// no credential is involved.

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'sandbox');
const HARNESS = path.join(FIXTURES, 'relay-harness.ps1');
const CHILD = path.join(FIXTURES, 'relay-child.mjs');
const windows = process.platform === 'win32';
const me = userInfo().username;

/** The launcher's real environment (buildLaunch), minus the request: what PowerShell and Add-Type get in production. */
function minimalEnv(): { command: string; env: Record<string, string> } {
  const host = hostFromEnv(process.env, { username: me, home: homedir(), sid: null });
  const launch = buildLaunch(DEFAULT_SANDBOX, host, { target: { kind: 'script', script: 'probe.mjs', args: [] }, env: {}, expect: { account: DEFAULT_SANDBOX.account } }, 'C:\\td-eval\\work\\relay-test');
  const { TD_LAUNCH_REQUEST: _request, ...env } = launch.env;
  return { command: launch.command, env };
}

type Run = { child: ChildProcess; done: Promise<{ code: number | null; stdout: string; stderr: string }>; lines: (predicate: (l: string) => boolean) => Promise<string> };

function relay(script: string, args: string, input?: string): Run {
  const { command, env } = minimalEnv();
  const child = spawn(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HARNESS, '-Node', process.execPath, '-Script', script, '-Arguments', args], { env, windowsHide: true });
  let stdout = '';
  let stderr = '';
  const waiters: { predicate: (l: string) => boolean; resolve: (l: string) => void }[] = [];
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => {
    stdout += d;
    for (const w of [...waiters]) {
      const line = stdout.split(/\r?\n/).find(w.predicate);
      if (line) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
  });
  child.stderr!.on('data', (d) => (stderr += d));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
  if (input !== undefined) child.stdin!.end(input);
  return {
    child,
    done,
    lines: (predicate) =>
      new Promise((resolve, reject) => {
        const found = stdout.split(/\r?\n/).find(predicate);
        if (found) return resolve(found);
        waiters.push({ predicate, resolve });
        setTimeout(() => reject(new Error(`no matching line; stdout so far: ${stdout}; stderr: ${stderr}`)), 60_000).unref();
      }),
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
async function gone(pid: number, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (!alive(pid)) return true;
  return !alive(pid);
}
const pidOf = (line: string) => Number(line.split(' ')[1]);

describe('relay and job object (same-user children only)', { skip: !windows && 'Windows only', timeout: 180_000 }, () => {
  test('compiles under the minimal launch environment; relays stdin to EOF, stdout, stderr and the exit code; confirms the job first', async () => {
    const r = relay(CHILD, 'echo', 'hello\nworld');
    const { code, stdout, stderr } = await r.done;
    assert.equal(code, 7, stderr);
    // .NET Framework may put a UTF-8 BOM before the confirmation (stage2.mjs consumes it); nothing else may precede it.
    assert.match(stdout, /^FIRST (\uFEFF)?TD-JOB-ASSIGNED\r?$/m, 'the job confirmation is the first thing the child reads');
    assert.match(stdout, /^REST HELLO\nWORLD$/m, 'host stdin follows unchanged and reaches EOF');
    assert.match(stderr, /ERR line/);
  });

  test('when the child exits, the job ends its descendants (also a detached one); an unrelated process survives', async () => {
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      const r = relay(CHILD, 'tree', '');
      const { code, stdout, stderr } = await r.done;
      assert.equal(code, 0, stderr);
      const pids = stdout.split(/\r?\n/).filter((l) => /^D?PID \d+$/.test(l)).map(pidOf);
      assert.equal(pids.length, 2, `a grandchild and a detached grandchild were started: ${stdout}`);
      for (const pid of pids) assert.ok(await gone(pid), `grandchild ${pid} was ended by the job`);
      assert.ok(alive(bystander.pid!), 'a process outside the job is untouched');
    } finally {
      bystander.kill();
    }
  });

  test('killing the launcher (as the host does on any failure) ends the child and its grandchild', async () => {
    const r = relay(CHILD, 'hang');
    const grandchild = pidOf(await r.lines((l) => /^PID \d+$/.test(l)));
    await r.lines((l) => l === 'HANGING');
    assert.ok(alive(grandchild));
    r.child.kill();
    await r.done;
    assert.ok(await gone(grandchild), 'the grandchild died with the job');
  });

  test('the real chain relay -> stage2 -> target: stage2 waits for the confirmation and the target gets the rest of stdin byte for byte', async () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
    const domain = process.env.USERDOMAIN ?? 'X';
    const header = { target: { kind: 'script', script: 'teardown.mjs', args: ['--account', me, '--plan', '--from-stdin'] }, env: {}, expect: { account: me } };
    // If a BOM or the confirmation leaked through, the first row would not start with a quote and 101 would be missing.
    const tasklist = `"node.exe","101","Console","1","1 K","Running","${domain}\\${me}","0:00:00","N/A"\r\n"node.exe","102","Console","1","1 K","Running","${domain}\\${me}","0:00:00","N/A"\r\n`;
    const r = relay(path.join(RUNTIME_SCRIPTS_DIR, 'stage2.mjs'), b64(header), tasklist);
    const { code, stdout, stderr } = await r.done;
    assert.equal(code, 0, stderr);
    assert.equal(parseIdentityLine(stderr.split(/\r?\n/).find((l) => l.startsWith('TD-SANDBOX-IDENTITY')) ?? '')?.username, me);
    assert.deepEqual((JSON.parse(stdout.trim()) as { plan: number[] }).plan, [101, 102]);
  });
});
