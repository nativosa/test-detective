import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { credentialFile, DEFAULT_SANDBOX, LAUNCHER_SCRIPT, RUNTIME_SCRIPTS_DIR } from '../sandbox/config.ts';
import { buildLaunch, encodeHeader, hostFromEnv, identityProblems, launchRestricted, parseIdentityLine, RestrictedLaunchError } from '../sandbox/launcher.ts';
import type { LaunchHost, SandboxIdentity, SpawnFn, Stage2Header } from '../sandbox/launcher.ts';
import { tempDir } from './helpers.ts';

// R4b Step 1D: the restricted launcher without the evaluation account. Request building and
// validation, the identity handshake (fake process), stage2/teardown run as the developer only
// where they must refuse or only plan, and launch-as.ps1's refusals before any logon.

const exec = promisify(execFile);
const HOST: LaunchHost = {
  computer: 'TESTPC',
  localAppData: 'C:\\Users\\dev\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  systemRoot: 'C:\\Windows',
  developer: { username: 'dev', home: 'C:\\Users\\dev', sid: 'S-1-5-21-1-2-3-1001' },
};
const header = (edit: (h: Stage2Header) => void = () => {}): Stage2Header => {
  const h: Stage2Header = { target: { kind: 'script', script: 'probe.mjs', args: ['e30='] }, env: {}, expect: { account: 'td-eval' } };
  edit(h);
  return h;
};
const CWD = 'C:\\td-eval\\work\\check-1';
const GOOD: SandboxIdentity = { username: 'td-eval', domain: 'TESTPC', home: 'C:\\Users\\td-eval', sid: 'S-1-5-21-1-2-3-2002' };

describe('launch request', () => {
  test('starts Windows PowerShell on launch-as.ps1 with a minimal environment and no secret anywhere', () => {
    const launch = buildLaunch(DEFAULT_SANDBOX, HOST, header(), CWD);
    assert.equal(launch.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(launch.args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER_SCRIPT]);
    assert.deepEqual(Object.keys(launch.env).sort(), ['COMPUTERNAME', 'LOCALAPPDATA', 'PATH', 'ProgramFiles', 'SystemRoot', 'TD_LAUNCH_REQUEST', 'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'windir']);
    assert.deepEqual(launch.request, {
      account: 'td-eval',
      node: 'C:\\Program Files\\nodejs\\node.exe',
      credentialFile: 'C:\\Users\\dev\\AppData\\Local\\test-detective\\eval-account.xml',
      runtime: 'C:\\td-eval\\runtime',
      cwd: CWD,
      header: launch.request.header,
    });
    assert.deepEqual(JSON.parse(Buffer.from(launch.request.header, 'base64').toString('utf8')), header());
    assert.equal(launch.request.credentialFile, credentialFile(HOST.localAppData), 'only the path, never the contents');
    assert.doesNotMatch(JSON.stringify(launch), /password|ANTHROPIC|OAUTH|apiKey/i);
  });

  test('the inherited environment never leaks into the launch, whatever the host process holds', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-should-never-appear';
    try {
      assert.doesNotMatch(JSON.stringify(buildLaunch(DEFAULT_SANDBOX, HOST, header(), CWD)), /sk-should-never-appear|ANTHROPIC/);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('refuses the developer as account, a foreign expectation, a working directory outside the sandbox', () => {
    assert.throws(() => buildLaunch({ ...DEFAULT_SANDBOX, account: 'dev' }, HOST, header((h) => (h.expect.account = 'dev')), CWD), /cannot be the developer/);
    assert.throws(() => buildLaunch({ ...DEFAULT_SANDBOX, account: 'td eval' }, HOST, header(), CWD), /Invalid account/);
    assert.throws(() => buildLaunch(DEFAULT_SANDBOX, HOST, header((h) => (h.expect.account = 'other')), CWD), /expect the configured account/);
    assert.throws(() => buildLaunch(DEFAULT_SANDBOX, HOST, header(), 'C:\\GIT\\test-detective'), /inside C:\\td-eval/);
    assert.throws(() => buildLaunch(DEFAULT_SANDBOX, HOST, header(), 'C:\\td-eval\\..\\GIT'), /inside C:\\td-eval/);
    assert.throws(() => buildLaunch(DEFAULT_SANDBOX, HOST, header(), 'work\\x'), /inside C:\\td-eval/);
  });

  test('only allowlisted targets, arguments and configuration variables; auth and provider variables never pass', () => {
    assert.throws(() => encodeHeader(header((h) => (h.target = { kind: 'script', script: 'evil.mjs' as 'probe.mjs', args: [] }))), /Unknown stage2 target/);
    assert.throws(() => encodeHeader(header((h) => (h.target.args = ['a\0b']))), /without NUL/);
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_ACCESS_KEY_ID', 'PATH', 'NODE_OPTIONS', 'TEST_DETECTIVE_REPO_ROOT']) {
      assert.throws(() => encodeHeader(header((h) => (h.env = { [name]: 'x' }))), /may not be passed/, name);
    }
    assert.doesNotThrow(() => encodeHeader(header((h) => (h.env = { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.302' }))));
    assert.throws(() => encodeHeader(header((h) => (h.target.args = ['x'.repeat(20_000)]))), /too long/);
  });
});

describe('identity handshake', () => {
  test('parses the stage2 line and accepts only the evaluation account', () => {
    const line = `TD-SANDBOX-IDENTITY ${JSON.stringify(GOOD)}`;
    assert.deepEqual(parseIdentityLine(line), GOOD);
    assert.equal(parseIdentityLine('TD-SANDBOX-IDENTITY {broken'), null);
    assert.equal(parseIdentityLine('anything else'), null);
    assert.deepEqual(identityProblems(GOOD, DEFAULT_SANDBOX, HOST), []);
  });

  test('never accepts the developer, the developer SID or profile, another machine, or a missing SID', () => {
    assert.match(identityProblems({ ...GOOD, username: 'dev' }, DEFAULT_SANDBOX, HOST).join(), /runs as the developer/);
    assert.match(identityProblems({ ...GOOD, sid: HOST.developer.sid }, DEFAULT_SANDBOX, HOST).join(), /developer SID/);
    assert.match(identityProblems({ ...GOOD, home: 'C:\\Users\\DEV' }, DEFAULT_SANDBOX, HOST).join(), /developer profile/);
    assert.match(identityProblems({ ...GOOD, domain: 'CORP' }, DEFAULT_SANDBOX, HOST).join(), /not this computer/);
    assert.match(identityProblems({ ...GOOD, sid: null }, DEFAULT_SANDBOX, HOST).join(), /no SID/);
  });

  class FakeChild extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    kill() {
      this.killed = true;
      return true;
    }
  }
  const fake = () => {
    const child = new FakeChild();
    const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
    const spawnFn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    return { child, calls, spawnFn };
  };

  test('resolves with the verified identity; diagnostics before and after go to onStderr', async () => {
    const { child, calls, spawnFn } = fake();
    const lines: string[] = [];
    const launched = launchRestricted(DEFAULT_SANDBOX, HOST, header(), CWD, { spawn: spawnFn, onStderr: (l) => lines.push(l) });
    child.stderr.write('warming up\n');
    child.stderr.write(`TD-SANDBOX-IDENTITY ${JSON.stringify(GOOD)}\n`);
    assert.deepEqual(await launched.identity, GOOD);
    child.stderr.write('later\n');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lines, ['warming up', 'later']);
    assert.equal(child.killed, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args.at(-1), LAUNCHER_SCRIPT);
  });

  test('a wrong identity, no handshake, or an early exit kills the launcher and rejects: never a fallback', async () => {
    const wrong = fake();
    const a = launchRestricted(DEFAULT_SANDBOX, HOST, header(), CWD, { spawn: wrong.spawnFn });
    wrong.child.stderr.write(`TD-SANDBOX-IDENTITY ${JSON.stringify({ ...GOOD, username: 'dev', sid: HOST.developer.sid })}\n`);
    await assert.rejects(a.identity, (e: unknown) => e instanceof RestrictedLaunchError && e.identity && /runs as dev.*developer/.test(e.message));
    assert.equal(wrong.child.killed, true);

    const silent = fake();
    const b = launchRestricted(DEFAULT_SANDBOX, HOST, header(), CWD, { spawn: silent.spawnFn, handshakeTimeoutMs: 20 });
    await assert.rejects(b.identity, (e: unknown) => e instanceof RestrictedLaunchError && !e.identity && /no identity handshake/.test(e.message));
    assert.equal(silent.child.killed, true);

    const exited = fake();
    const c = launchRestricted(DEFAULT_SANDBOX, HOST, header(), CWD, { spawn: exited.spawnFn });
    exited.child.emit('exit', 91);
    await assert.rejects(c.identity, (e: unknown) => e instanceof RestrictedLaunchError && !e.identity && /exited \(91\) before the handshake/.test(e.message));
  });
});

describe('runtime scripts run as the developer only where they must refuse or only plan', () => {
  const stage2 = path.join(RUNTIME_SCRIPTS_DIR, 'stage2.mjs');
  const teardown = path.join(RUNTIME_SCRIPTS_DIR, 'teardown.mjs');
  const runNode = (args: string[], input?: string | Buffer): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.end(input ?? '');
    });
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
  const me = userInfo().username;
  // What the relay writes once the child is in its job (TdSandboxRelay.cs); sandbox-relay.test.ts runs the real relay.
  const GO = 'TD-JOB-ASSIGNED\n';

  test('stage2 starts nothing, not even its identity check, until the launcher confirms the job object', async () => {
    for (const input of ['', 'hello\n', 'TD-JOB-ASSIGNED', 'TD-JOB-ASSIGNEDX\n', Buffer.from([0xef, 0xbb, ...Buffer.from('TD-JOB-ASSIGNED\n')])]) {
      const r = await runNode([stage2, b64(header((h) => (h.expect.account = me)))], input);
      assert.equal(r.code, 95, JSON.stringify(input));
      assert.doesNotMatch(r.stderr, /TD-SANDBOX-IDENTITY/, 'no identity line: whoami never ran');
      assert.equal(r.stdout, '');
    }
  });

  test('stage2 announces who it runs as and refuses to start anything under an unexpected account', async () => {
    const r = await runNode([stage2, b64(header())], GO);
    assert.equal(r.code, 97);
    const reported = parseIdentityLine(r.stderr.split(/\r?\n/)[0]!);
    assert.equal(reported?.username, me);
    assert.equal(r.stdout, '', 'the probe never started');
  });

  test('stage2 refuses an auth variable or an unknown target even under the expected account', async () => {
    const auth = await runNode([stage2, b64(header((h) => ((h.expect.account = me), (h.env = { ANTHROPIC_API_KEY: 'x' }))))], GO);
    assert.equal(auth.code, 90);
    assert.match(auth.stderr, /ANTHROPIC_API_KEY is not allowed/);
    const unknown = await runNode([stage2, b64({ target: { kind: 'script', script: '../../x.mjs', args: [] }, env: {}, expect: { account: me } })], GO);
    assert.equal(unknown.code, 90);
    assert.match(unknown.stderr, /unknown target/);
  });

  test('stage2 starts the allowlisted probe with inherited stdio when the account matches (with or without a leading BOM)', async () => {
    for (const go of [GO, `﻿${GO}`]) {
      const r = await runNode([stage2, b64(header((h) => ((h.expect.account = me), (h.target = { kind: 'script', script: 'probe.mjs', args: [b64({ attempts: [], forbidden: [] })] }))))], go);
      assert.equal(r.code, 0, r.stderr);
      assert.equal((JSON.parse(r.stdout) as { identity: { username: string } }).identity.username, me);
    }
  });

  const domain = process.env.USERDOMAIN ?? 'TESTPC';
  const tasklist = [
    'INFO: No tasks are running which match the specified criteria.',
    `"node.exe","101","Console","1","10,000 K","Running","${domain}\\${me}","0:00:01","N/A"`,
    `"claude.exe","102","Console","1","10,000 K","Running","${domain.toLowerCase()}\\${me.toUpperCase()}","0:00:01","N/A"`,
    `"explorer.exe","103","Console","1","10,000 K","Running","${domain}\\someone-else","0:00:01","N/A"`,
    '"svchost.exe","104","Services","0","1,000 K","Unknown","N/A","0:00:00","N/A"',
    `"node.exe","105","Console","1","1,000 K","Running","OTHERPC\\${me}","0:00:00","N/A"`,
    `"node.exe","106","Console","1","1,000 K","Running","${domain}\\${me}x","0:00:00","N/A"`,
  ].join('\r\n');

  test('teardown selects exactly its own account’s processes (full user name), never another user, machine or a longer name', async () => {
    const r = await runNode([teardown, '--account', me, '--plan', '--from-stdin'], tasklist);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { user: string; plan: number[] };
    assert.equal(out.user.toLowerCase(), `${domain}\\${me}`.toLowerCase());
    assert.deepEqual(out.plan, [101, 102]);
  });

  test('teardown refuses to run for another account than its own (it can never end the developer’s processes for td-eval)', async () => {
    const r = await runNode([teardown, '--account', 'td-eval', '--plan', '--from-stdin'], tasklist);
    assert.equal(r.code, 97);
    assert.deepEqual(JSON.parse(r.stdout), { refused: 'identity' });
  });

  test('ending processes is guarded three times: own account, a stage2 parent, and no Administrators in the token', () => {
    const source = readFileSync(teardown, 'utf8');
    const kill = source.indexOf("'taskkill.exe'");
    for (const guard of ["out({ refused: 'identity' }, 97)", "out({ refused: 'not-stage2' }, 96)", "out({ refused: 'administrator' }, 98)", "out({ user, plan: targets }, 0)"]) {
      const at = source.indexOf(guard);
      assert.ok(at > 0 && at < kill, `${guard} comes before taskkill`);
    }
    assert.doesNotMatch(source, /taskkill[^\n]*\/T/, 'never kills a tree by PID: each process is checked to be the account’s own');
  });
});

describe('launch-as.ps1 refuses before any logon, under the minimal environment buildLaunch produces', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  /**
   * Runs launch-as.ps1 exactly as launchRestricted would (buildLaunch's command, arguments and
   * environment), with LOCALAPPDATA pointed at a disposable folder so the credential it looks for is
   * a test file, never the real one. Only the request is replaced per case.
   */
  const run = async (localAppData: string, request: unknown) => {
    const host = { ...hostFromEnv(process.env, { username: userInfo().username, home: process.env.USERPROFILE ?? '', sid: null }), localAppData };
    const launch = buildLaunch(DEFAULT_SANDBOX, host, header(), CWD);
    const env = { ...launch.env };
    if (request === undefined) delete (env as Record<string, string | undefined>).TD_LAUNCH_REQUEST;
    else env.TD_LAUNCH_REQUEST = JSON.stringify(request);
    assert.deepEqual(Object.keys(env).filter((k) => !Object.keys(launch.env).includes(k)), [], 'nothing beyond the production environment');
    try {
      await exec(launch.command, launch.args, { env, windowsHide: true, timeout: 60_000 });
      return { code: 0, stderr: '' };
    } catch (error) {
      return { code: (error as { code: number }).code, stderr: (error as { stderr: string }).stderr };
    }
  };
  /** A disposable sandbox layout (<root>\runtime\bin\stage2.mjs, <root>\work\w) and LOCALAPPDATA. */
  const layout = async (t: Parameters<typeof tempDir>[0]) => {
    const root = await tempDir(t, 'td-launch-');
    const runtime = path.join(root, 'runtime');
    const cwd = path.join(root, 'work', 'w');
    const localAppData = path.join(root, 'appdata');
    await mkdir(path.join(runtime, 'bin'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(localAppData, 'Temp'), { recursive: true });
    await writeFile(path.join(runtime, 'bin', 'stage2.mjs'), '');
    const good = { account: 'td-eval', node: path.join(process.env.ProgramFiles ?? '', 'nodejs', 'node.exe'), credentialFile: credentialFile(localAppData), runtime, cwd, header: 'e30=' };
    return { root, runtime, cwd, localAppData, good };
  };

  test('no request, a wrong executable, a wrong credential path, the current user, bad paths: refused with 90', async (t) => {
    const { root, runtime, localAppData, good } = await layout(t);
    assert.equal((await run(localAppData, undefined)).code, 90);
    const refused = async (edit: Record<string, unknown>, pattern: RegExp) => {
      const r = await run(localAppData, { ...good, ...edit });
      assert.equal(r.code, 90, `${JSON.stringify(edit)}: ${r.stderr}`);
      assert.match(r.stderr, pattern);
    };
    await refused({ node: 'C:\\Windows\\System32\\cmd.exe' }, /Only .*node\.exe may be started/);
    await refused({ credentialFile: path.join(root, 'cred.xml') }, /Unexpected credential file/);
    await refused({ account: userInfo().username }, /cannot be the current user/);
    await refused({ header: 'not base64!' }, /must be base64/);
    await refused({ account: 7 }, /account must be a string/);
    await refused({ runtime: `${runtime}\\..\\runtime` }, /normalized absolute paths/);
    await refused({ cwd: `${good.cwd}\\` }, /absolute drive paths|normalized/);
    await refused({ runtime: path.join(root, 'work') }, /must be <sandbox root>\\runtime/);
    await refused({ cwd: runtime }, /inside <sandbox root>\\work/);
    await refused({ cwd: path.join(root, 'workshop') }, /inside <sandbox root>\\work/);
  });

  test('links in the runtime or working directory are refused', async (t) => {
    const { root, localAppData, good } = await layout(t);
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(root, 'work', 'linked'), 'junction');
    const r = await run(localAppData, { ...good, cwd: path.join(root, 'work', 'linked') });
    assert.equal(r.code, 90);
    assert.match(r.stderr, /must not be links/);
  });

  test('without a stored credential it stops with 91; a credential for another account (decrypted under the minimal environment) also stops with 91', async (t) => {
    const { localAppData, good } = await layout(t);
    const none = await run(localAppData, good);
    assert.equal(none.code, 91);
    assert.match(none.stderr, /No stored evaluation credential/);
    // A throwaway credential for a name that is not the evaluation account: Import-Clixml must work
    // under the minimal environment, and the user-name check must stop before any logon is tried.
    await mkdir(path.dirname(good.credentialFile), { recursive: true });
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$s = New-Object System.Security.SecureString; 'x'.ToCharArray() | ForEach-Object { $s.AppendChar($_) }; New-Object System.Management.Automation.PSCredential('${process.env.COMPUTERNAME}\\not-the-account', $s) | Export-Clixml -LiteralPath '${good.credentialFile}'`], { windowsHide: true });
    const other = await run(localAppData, good);
    assert.equal(other.code, 91, other.stderr);
    assert.match(other.stderr, /credential is for a different account/);
    assert.doesNotMatch(`${none.stderr}${other.stderr}`, /password/i);
  });

  test('the script never puts the password anywhere but ProcessStartInfo.Password, and never touches the environment block', () => {
    const script = readFileSync(LAUNCHER_SCRIPT, 'utf8');
    const uses = [...script.matchAll(/\$credential\.Password/g)];
    assert.equal(uses.length, 1);
    assert.match(script, /\$info\.Password = \$credential\.Password/);
    assert.doesNotMatch(script, /EnvironmentVariables\s*[=.[]|\.Environment\b|GetNetworkCredential|ConvertFrom-SecureString|Write-Host|Invoke-Expression/);
    assert.doesNotMatch(script, /(Write-|Stop-Launch)[^\n]*\$credential/);
    assert.match(script, /Add-Type -Path \(Join-Path \$PSScriptRoot 'TdSandboxRelay\.cs'\)/);
    const relay = readFileSync(path.join(path.dirname(LAUNCHER_SCRIPT), 'TdSandboxRelay.cs'), 'utf8');
    assert.match(relay, /KillOnJobClose = 0x2000/);
    assert.match(relay, /if \(!AssignProcessToJobObject\(job, child\.Handle\) \|\| !IsProcessInJob\(child\.Handle, job, out inJob\) \|\| !inJob\) \{\s*Kill\(child\);\s*return 96;/);
    assert.ok(relay.indexOf('childIn.Write(go') > relay.indexOf('AssignProcessToJobObject(job, child.Handle)'), 'the confirmation is written only after the job assignment');
    assert.ok(relay.indexOf('Pump(Console.OpenStandardInput()') > relay.indexOf('childIn.Write(go'), 'host stdin is relayed only after the confirmation');
  });
});
