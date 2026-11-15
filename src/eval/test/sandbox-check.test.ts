import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { aliasVariants, defaultJunctionVariants, evaluateCheck, judgeAttempt, judgeToken, observedToken, parseProbeOutput, plannedAttemptIds, prepareCheck, probePayload, verdictExitCode } from '../sandbox/check.ts';
import type { Attempt, ProbeIdentity, ProbeReport, ProbeResult, TokenGroup } from '../sandbox/check.ts';
import { RestrictedLaunchError } from '../sandbox/launcher.ts';
import { accountCheckSetup, acquireSandboxLock, launchItem, runSelfCheck } from '../sandbox/run-check.ts';
import type { ShortPathLookup } from '../workspace.ts';
import { tempDir } from './helpers.ts';

// R4b Step 1D: the enforcement check's verdict logic and its probe, run only as the developer in
// disposable folders. Nothing here runs under another identity.

const DEV = { username: 'dev', home: 'C:\\Users\\dev', sid: 'S-1-5-21-1-2-3-1001' };
const EXPECT = { account: 'td-eval', developer: DEV };
const TOKEN: TokenGroup[] = [
  { name: 'Everyone', sid: 'S-1-1-0', attributes: 'Mandatory group, Enabled by default, Enabled group' },
  { name: 'BUILTIN\\Users', sid: 'S-1-5-32-545', attributes: 'Mandatory group, Enabled by default, Enabled group' },
  { name: 'TESTPC\\td-eval-sandbox', sid: 'S-1-5-21-1-2-3-2001', attributes: 'Mandatory group, Enabled by default, Enabled group' },
];
const SANDBOXED: ProbeIdentity = { username: 'td-eval', home: 'C:\\Users\\td-eval', userprofile: 'C:\\Users\\td-eval', temp: 'C:\\Users\\td-eval\\AppData\\Local\\Temp', sid: 'S-1-5-21-1-2-3-2002', envNames: ['PATH', 'USERPROFILE'], envMentioningForbidden: [], tokenGroups: TOKEN };
const attempts: Attempt[] = [
  { id: 'workspace-read', op: 'read', path: 'C:\\td-eval\\work\\a\\allowed.txt', expect: 'allow', variant: 'long', sha256: 'aa' },
  { id: 'repo-read-short', op: 'read', path: 'C:\\GIT\\TEST-D~1\\x', expect: 'deny', variant: 'short' },
  { id: 'repo-write', op: 'write', path: 'C:\\GIT\\x', expect: 'deny', variant: 'long' },
];
const allDenied = (): ProbeReport => ({
  identity: SANDBOXED,
  results: [
    { id: 'workspace-read', outcome: 'ok', sha256: 'aa' },
    { id: 'repo-read-short', outcome: 'error', code: 'EACCES' },
    { id: 'repo-write', outcome: 'error', code: 'EPERM' },
  ],
});
const TEARDOWN = { selected: 0, killed: 0, remaining: 0 };

describe('alias variants', () => {
  test('8.3, slashes, device paths and admin shares over loopback, each reaching the same file', () => {
    const v = aliasVariants('C:\\GIT\\test-detective\\.work\\p\\s.txt', 'C:\\GIT\\TEST-D~1\\.work\\p\\s.txt');
    assert.deepEqual(v.map((x) => x.variant), ['long', 'short', 'forward-slashes', 'device-extended', 'device-dot', 'unc-localhost', 'unc-loopback', 'unc-extended']);
    assert.deepEqual(v.slice(3).map((x) => x.path), [
      '\\\\?\\C:\\GIT\\test-detective\\.work\\p\\s.txt',
      '\\\\.\\C:\\GIT\\test-detective\\.work\\p\\s.txt',
      '\\\\localhost\\C$\\GIT\\test-detective\\.work\\p\\s.txt',
      '\\\\127.0.0.1\\C$\\GIT\\test-detective\\.work\\p\\s.txt',
      '\\\\?\\UNC\\localhost\\C$\\GIT\\test-detective\\.work\\p\\s.txt',
    ]);
    assert.ok(!aliasVariants('C:\\a\\b', 'C:\\A\\B').some((x) => x.variant === 'short'), 'no short variant when it is the same name');
    assert.throws(() => aliasVariants('\\\\server\\share\\x', null), /drive path/);
  });

  test("Windows' default junctions over profile folders", () => {
    assert.deepEqual(defaultJunctionVariants('C:\\Users\\dev\\AppData\\Local\\Temp\\p\\s.txt', 'C:\\Users\\dev'), [
      { variant: 'junction-documents-and-settings', path: 'C:\\Documents and Settings\\dev\\AppData\\Local\\Temp\\p\\s.txt' },
      { variant: 'junction-local-settings', path: 'C:\\Users\\dev\\Local Settings\\Temp\\p\\s.txt' },
    ]);
    assert.deepEqual(defaultJunctionVariants('C:\\GIT\\x', 'C:\\Users\\dev'), []);
  });
});

describe('verdicts', () => {
  test('PASS only when the control works, every forbidden attempt is denied by Windows, the identity is isolated and teardown is clean', () => {
    const report = evaluateCheck(attempts, allDenied(), EXPECT, TEARDOWN);
    assert.equal(report.verdict, 'PASS');
    assert.equal(report.counts.fail + report.counts.inconclusive, 0);
    assert.equal(verdictExitCode('PASS'), 0);
  });

  test('any forbidden success, a changed control file, the developer identity or leftover processes is a BLOCKER', () => {
    const leaked = allDenied();
    leaked.results[1] = { id: 'repo-read-short', outcome: 'ok', sha256: 'bb' };
    assert.equal(evaluateCheck(attempts, leaked, EXPECT, TEARDOWN).verdict, 'BLOCKER');
    const changed = allDenied();
    changed.results[0] = { id: 'workspace-read', outcome: 'ok', sha256: 'cc' };
    assert.equal(evaluateCheck(attempts, changed, EXPECT, TEARDOWN).verdict, 'BLOCKER');
    const developer = allDenied();
    developer.identity = { ...SANDBOXED, username: 'dev', sid: DEV.sid, home: DEV.home };
    const report = evaluateCheck(attempts, developer, EXPECT, TEARDOWN);
    assert.equal(report.verdict, 'BLOCKER');
    assert.deepEqual(report.items.filter((i) => i.status === 'fail').map((i) => i.id), ['identity-account', 'identity-not-developer', 'profile-isolated']);
    const env = allDenied();
    env.identity = { ...SANDBOXED, envNames: [...SANDBOXED.envNames, 'ANTHROPIC_API_KEY'], envMentioningForbidden: ['TEMP'] };
    assert.deepEqual(evaluateCheck(attempts, env, EXPECT, TEARDOWN).items.filter((i) => i.status === 'fail').map((i) => i.id), ['env-isolated', 'env-no-auth']);
    assert.equal(evaluateCheck(attempts, allDenied(), EXPECT, { selected: 2, killed: 1, remaining: 1 }).verdict, 'BLOCKER');
    assert.equal(verdictExitCode('BLOCKER'), 2);
  });

  test('a missing attempt, a non-denial error, a failed control, no probe report or no teardown is INCONCLUSIVE, never a pass', () => {
    const missing = allDenied();
    missing.results.pop();
    assert.equal(evaluateCheck(attempts, missing, EXPECT, TEARDOWN).verdict, 'INCONCLUSIVE');
    for (const code of ['ENOENT', 'ENOTDIR', 'UNKNOWN', 'EBUSY', 'EINVAL']) {
      assert.equal(judgeAttempt(attempts[1]!, { id: 'repo-read-short', outcome: 'error', code }).status, 'inconclusive', code);
    }
    const control = allDenied();
    control.results[0] = { id: 'workspace-read', outcome: 'error', code: 'EACCES' };
    assert.equal(evaluateCheck(attempts, control, EXPECT, TEARDOWN).verdict, 'INCONCLUSIVE');
    assert.equal(evaluateCheck(attempts, null, EXPECT, TEARDOWN).verdict, 'INCONCLUSIVE');
    assert.equal(evaluateCheck(attempts, allDenied(), EXPECT, null).verdict, 'INCONCLUSIVE');
    assert.equal(verdictExitCode('INCONCLUSIVE'), 3);
  });
});

const fakeShort: ShortPathLookup = async (paths) => paths.map((p) => p.replace(/\\td-acl-probe-[^\\]+/, '\\TD-ACL~1'));
const outcomes = (attempts: Attempt[]): ProbeResult[] => attempts.map((a) => (a.expect === 'allow' ? { id: a.id, outcome: 'ok', sha256: a.sha256 } : { id: a.id, outcome: 'error', code: 'EACCES' }));

describe('B1: the account-mode check has unique attempt IDs and never masks a forbidden success', () => {
  test('the real account-mode configuration: unique IDs; the TEMP probe folder and the TEMP root are separate checks; the original false PASS is now a BLOCKER', async (t) => {
    const root = await tempDir(t, 'td-b1-');
    const paths = { repoRoot: path.join(root, 'GIT', 'repo'), temp: path.join(root, 'temp'), profile: path.join(root, 'profile'), runtime: path.join(root, 'runtime'), workspace: path.join(root, 'ws') };
    for (const d of [paths.repoRoot, paths.temp, paths.profile, paths.workspace]) await mkdir(d, { recursive: true });
    const prepared = await prepareCheck(accountCheckSetup(paths, fakeShort));
    t.after(() => prepared.cleanup());
    const ids = prepared.attempts.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length, 'every attempt ID is unique');
    for (const id of ['temp-list', 'temp-root-list', 'repo-list', 'repo-root-list', 'deny-root-write', 'deny-root-list', 'runtime-write', 'profile-list', 'temp-read-short', 'repo-read-junction']) assert.ok(ids.includes(id), id);
    assert.equal(prepared.attempts.find((a) => a.id === 'temp-root-list')!.path, paths.temp);
    assert.notEqual(prepared.attempts.find((a) => a.id === 'temp-list')!.path, paths.temp, 'temp-list is the probe folder, not TEMP itself');

    const clean = outcomes(prepared.attempts);
    assert.equal(evaluateCheck(prepared.attempts, { identity: SANDBOXED, results: clean }, EXPECT, TEARDOWN).verdict, 'PASS', 'only a complete, valid set of denials passes');
    // The audit's false PASS: listing the TEMP probe folder succeeds, listing TEMP itself is denied.
    const leaked = clean.map((r): ProbeResult => (r.id === 'temp-list' ? { id: 'temp-list', outcome: 'ok', count: 1 } : r));
    const report = evaluateCheck(prepared.attempts, { identity: SANDBOXED, results: leaked }, EXPECT, TEARDOWN);
    assert.equal(report.verdict, 'BLOCKER');
    assert.equal(report.items.find((i) => i.id === 'temp-list')!.status, 'fail');
    assert.equal(report.items.find((i) => i.id === 'temp-root-list')!.status, 'pass');
  });

  test('the pre-fix configuration (both labelled temp) is refused before anything is created', async (t) => {
    const root = await tempDir(t, 'td-b1-');
    const workspace = path.join(root, 'ws');
    await mkdir(workspace);
    const old = { protectedParents: [{ label: 'temp', dir: path.join(root, 'temp') }], writeTargets: [], listTargets: [{ label: 'temp', dir: path.join(root, 'temp') }] };
    assert.throws(() => plannedAttemptIds(old), /duplicated: temp-list/);
    await assert.rejects(prepareCheck({ ...old, workspace, workspaceWrite: 'deny', developerProfile: root, shortPaths: fakeShort }), /duplicated: temp-list/);
    assert.deepEqual(await readdir(root), ['ws'], 'no probe folder was created');
    assert.deepEqual(await readdir(workspace), []);
    assert.throws(() => plannedAttemptIds({ protectedParents: [], writeTargets: [{ label: 'Bad Label', dir: root }], listTargets: [] }), /Invalid check labels/);
  });

  test('the collision at evaluation time: duplicate IDs or duplicate results never pass, and a forbidden success among them is a BLOCKER', () => {
    const dup: Attempt[] = [
      { id: 'temp-list', op: 'list', path: 'C:\\t\\probe', expect: 'deny', variant: 'long' },
      { id: 'temp-list', op: 'list', path: 'C:\\t', expect: 'deny', variant: 'long' },
    ];
    const run = (attempts: Attempt[], results: ProbeResult[]) => evaluateCheck(attempts, { identity: SANDBOXED, results }, EXPECT, TEARDOWN);
    const ok: ProbeResult = { id: 'temp-list', outcome: 'ok', count: 3 };
    const denied: ProbeResult = { id: 'temp-list', outcome: 'error', code: 'EACCES' };
    // The old Map kept the last result, so [ok, denied] read as denied.
    assert.equal(run(dup, [ok, denied]).verdict, 'BLOCKER');
    assert.equal(run(dup, [denied, ok]).verdict, 'BLOCKER');
    const twiceDenied = run(dup, [denied, denied]);
    assert.equal(twiceDenied.verdict, 'INCONCLUSIVE');
    assert.ok(twiceDenied.items.some((i) => i.id === 'attempt-ids'));
    assert.equal(run([dup[0]!], [denied, denied]).verdict, 'INCONCLUSIVE', 'one attempt, two results');
    assert.equal(run([dup[0]!], [denied, ok]).verdict, 'BLOCKER');
  });

  test('unknown, malformed or missing results never pass; a valid forbidden success among malformed ones is still a BLOCKER', () => {
    const unknown = allDenied();
    unknown.results.push({ id: 'not-requested', outcome: 'error', code: 'EACCES' });
    assert.equal(evaluateCheck(attempts, unknown, EXPECT, TEARDOWN).verdict, 'INCONCLUSIVE');

    const line = (results: unknown[], identity: unknown = SANDBOXED) => JSON.stringify({ identity, results });
    const hash = 'a'.repeat(64);
    const atts: Attempt[] = [{ ...attempts[0]!, sha256: hash }, attempts[1]!, attempts[2]!];
    const good = [{ id: 'workspace-read', outcome: 'ok', sha256: hash }, { id: 'repo-read-short', outcome: 'error', code: 'EACCES' }, { id: 'repo-write', outcome: 'error', code: 'EPERM' }];
    assert.equal(evaluateCheck(atts, parseProbeOutput(line(good)), EXPECT, TEARDOWN).verdict, 'PASS');
    const malformed = parseProbeOutput(line([...good.slice(0, 2), { id: 'repo-write', outcome: 'maybe' }]))!;
    assert.equal(malformed.invalidResults, 1);
    assert.equal(evaluateCheck(atts, malformed, EXPECT, TEARDOWN).verdict, 'INCONCLUSIVE');
    const leakAmongJunk = parseProbeOutput(line([good[0], { id: 'repo-read-short', outcome: 'ok', sha256: 'b'.repeat(64) }, { garbage: true }]))!;
    assert.equal(evaluateCheck(atts, leakAmongJunk, EXPECT, TEARDOWN).verdict, 'BLOCKER');
    for (const bad of ['', 'not json', `${line(good)}\n${line(good)}`, line(good, { ...SANDBOXED, tokenGroups: undefined }), line(good, { username: 'td-eval' }), JSON.stringify({ identity: SANDBOXED, results: 'x' })]) {
      assert.equal(parseProbeOutput(bad), null, bad.slice(0, 40));
    }
    assert.equal(evaluateCheck(atts, parseProbeOutput('not json'), EXPECT, TEARDOWN).verdict, 'INCONCLUSIVE');
  });
});

describe('forbidden successes in malformed results (Step 1D.2B)', () => {
  const sentinel = 'd'.repeat(64);
  const hash = 'a'.repeat(64);
  const forbidden: Attempt[] = [
    { id: 'workspace-read', op: 'read', path: 'C:\\td-eval\\work\\a\\allowed.txt', expect: 'allow', variant: 'long', sha256: hash },
    { id: 'repo-read-long', op: 'read', path: 'C:\\GIT\\x\\sentinel.txt', expect: 'deny', variant: 'long', sha256: sentinel },
    { id: 'repo-list', op: 'list', path: 'C:\\GIT\\x', expect: 'deny', variant: 'long' },
    { id: 'repo-write', op: 'write', path: 'C:\\GIT\\x', expect: 'deny', variant: 'long' },
  ];
  const valid = (): unknown[] => [{ id: 'workspace-read', outcome: 'ok', sha256: hash }, ...forbidden.slice(1).map((a) => ({ id: a.id, outcome: 'error', code: 'EACCES' }))];
  const judge = (results: unknown[]) => evaluateCheck(forbidden, parseProbeOutput(JSON.stringify({ identity: SANDBOXED, results })), EXPECT, TEARDOWN);
  const item = (report: ReturnType<typeof judge>, id: string) => report.items.filter((i) => i.id === id);

  test('a malformed success for a forbidden read, listing or write is a BLOCKER; the malformed diagnostic stays', () => {
    assert.equal(judge(valid()).verdict, 'PASS');
    const malformedOk: Record<string, unknown> = {
      'repo-read-long': { id: 'repo-read-long', outcome: 'ok', sha256: 'NOT-A-HASH' },
      'repo-list': { id: 'repo-list', outcome: 'ok', count: -1 },
      'repo-write': { id: 'repo-write', outcome: 'ok', cleaned: 'yes' },
    };
    for (const [id, entry] of Object.entries(malformedOk)) {
      const results = valid().filter((r) => (r as { id: string }).id !== id);
      const report = judge([...results, entry]);
      assert.equal(report.verdict, 'BLOCKER', id);
      const [attempt] = item(report, id);
      assert.equal(attempt!.status, 'fail', id);
      assert.match(attempt!.detail, /reported as SUCCEEDED by a malformed result \(reported by the probe, not independently verified/, id);
      assert.deepEqual(item(report, 'probe-malformed-results').map((i) => i.status), ['inconclusive'], `${id}: the diagnostic is kept`);
      // Next to a valid denial for the same ID, the claimed success still wins.
      const withDenial = judge([...valid(), entry]);
      assert.equal(withDenial.verdict, 'BLOCKER', `${id} with a valid denial`);
      assert.equal(item(withDenial, id).length, 1, 'one item per attempt: the malformed entry overwrites no other evidence');
    }
  });

  test('reported is told apart from verified: only a forbidden read returning the sentinel hash is verified access', () => {
    const results = valid().filter((r) => (r as { id: string }).id !== 'repo-read-long');
    const verified = item(judge([...results, { id: 'repo-read-long', outcome: 'ok', sha256: sentinel }]), 'repo-read-long')[0]!;
    assert.equal(verified.status, 'fail');
    assert.match(verified.detail, /verified: the content matches the sentinel/);
    const reported = item(judge([...results, { id: 'repo-read-long', outcome: 'ok', sha256: 'b'.repeat(64) }]), 'repo-read-long')[0]!;
    assert.equal(reported.status, 'fail');
    assert.match(reported.detail, /reported by the probe, not independently verified/);
    const listed = item(judge([...valid().filter((r) => (r as { id: string }).id !== 'repo-list'), { id: 'repo-list', outcome: 'ok', count: 1 }]), 'repo-list')[0]!;
    assert.match(listed.detail, /SUCCEEDED \(1 entries\) \(reported by the probe, not independently verified\)/);
    const both = item(judge([...valid().filter((r) => (r as { id: string }).id !== 'repo-read-long'), { id: 'repo-read-long', outcome: 'ok', sha256: sentinel }, { id: 'repo-read-long', outcome: 'ok', sha256: 1 }]), 'repo-read-long')[0]!;
    assert.match(both.detail, /verified: the content matches the sentinel.*1 malformed result for this ID claimed success/);
  });

  test('without a credible reported success, malformed, unknown or ambiguous entries stay INCONCLUSIVE', () => {
    const rest = valid().filter((r) => (r as { id: string }).id !== 'repo-write');
    for (const [label, entry] of [
      ['no outcome', { id: 'repo-write', code: 'EACCES', extra: 1 }],
      ['another outcome', { id: 'repo-write', outcome: 'maybe' }],
      ['"OK" is not ok', { id: 'repo-write', outcome: 'OK', extra: 1 }],
      ['an ID in another case', { id: 'REPO-WRITE', outcome: 'ok', extra: 1 }],
      ['a numeric ID', { id: 7, outcome: 'ok' }],
      ['not an object', 'ok'],
      ['an unrequested ID', { id: 'repo-elsewhere-read', outcome: 'ok', extra: 1 }],
    ] as const) {
      const report = judge([...rest, entry]);
      assert.equal(report.verdict, 'INCONCLUSIVE', label);
      assert.deepEqual(item(report, 'repo-write').map((i) => i.status), ['inconclusive'], label);
    }
  });

  test('a malformed success for an allowed control proves nothing: the failed control stays INCONCLUSIVE, never PASS', () => {
    const report = judge([...valid().slice(1), { id: 'workspace-read', outcome: 'ok', sha256: 'NOT-A-HASH' }]);
    assert.equal(report.verdict, 'INCONCLUSIVE');
    assert.deepEqual(item(report, 'workspace-read').map((i) => i.status), ['inconclusive']);
    const failedControl = judge([{ id: 'workspace-read', outcome: 'error', code: 'EACCES' }, ...valid().slice(1)]);
    assert.equal(failedControl.verdict, 'INCONCLUSIVE');
  });
});

describe('token and launch outcomes', () => {
  test('the token must hold the denied group and no Administrators; an unobserved token is inconclusive', () => {
    const group = 'TESTPC\\td-eval-sandbox';
    const status = (items: { id: string; status: string }[]) => Object.fromEntries(items.map((i) => [i.id, i.status]));
    assert.deepEqual(status(judgeToken(TOKEN, group)), { 'token-observed': 'pass', 'token-standard': 'pass', 'token-has-group': 'pass' });
    assert.deepEqual(status(judgeToken(null, group)), { 'token-observed': 'inconclusive' });
    assert.equal(status(judgeToken(TOKEN.slice(0, 2), group))['token-has-group'], 'fail', 'without the group the deny ACE would not apply');
    assert.equal(status(judgeToken([...TOKEN, { name: 'BUILTIN\\Administrators', sid: 'S-1-5-32-544', attributes: 'Group used for deny only' }], group))['token-standard'], 'fail');
    const withGroup = evaluateCheck(attempts, allDenied(), { ...EXPECT, tokenGroup: group }, TEARDOWN);
    assert.equal(withGroup.verdict, 'PASS');
    assert.deepEqual(observedToken(SANDBOXED, 'td-eval'), { schema: 1, account: 'td-eval', userSid: SANDBOXED.sid, groups: TOKEN.map(({ sid, name }) => ({ sid, name })) });
    assert.equal(observedToken({ ...SANDBOXED, tokenGroups: null }, 'td-eval'), null);
  });

  test('a refused launch: a wrong identity is a BLOCKER, a start failure or a timeout is INCONCLUSIVE', () => {
    assert.equal(launchItem('launch-probe', new RestrictedLaunchError('runs as dev', true)).status, 'fail');
    assert.equal(launchItem('launch-probe', new RestrictedLaunchError('no identity handshake in time', false)).status, 'inconclusive');
    assert.equal(launchItem('launch-probe', new Error('spawn failed')).status, 'inconclusive');
    assert.equal(evaluateCheck(attempts, allDenied(), EXPECT, TEARDOWN, [launchItem('launch-teardown', new RestrictedLaunchError('x', true))]).verdict, 'BLOCKER');
  });

  test('one sandbox session at a time (teardown would end a concurrent one); a stale lock is replaced; release removes only its own lock', async (t) => {
    const localAppData = await tempDir(t, 'td-lock-');
    const release = await acquireSandboxLock(localAppData);
    await assert.rejects(acquireSandboxLock(localAppData), /Another sandbox session \(process \d+\)/);
    await release();
    assert.deepEqual(await readdir(path.join(localAppData, 'test-detective')), []);
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    await writeFile(path.join(localAppData, 'test-detective', 'sandbox.lock'), `${exited.stdout} 1`);
    const again = await acquireSandboxLock(localAppData);
    await writeFile(path.join(localAppData, 'test-detective', 'sandbox.lock'), `${process.pid} 2`);
    await again();
    assert.deepEqual(await readdir(path.join(localAppData, 'test-detective')), ['sandbox.lock'], "another session's lock is never removed");
  });
});

describe('prepared sentinels', () => {

  test('creates disposable sentinels and junctions, lists every attempt, and cleanup removes exactly them', { skip: process.platform !== 'win32' && 'junctions are Windows-only' }, async (t) => {
    const root = await tempDir(t, 'td-check-');
    const dirs = { workspace: path.join(root, 'ws'), repo: path.join(root, 'repo', '.work'), temp: path.join(root, 'temp') };
    await mkdir(dirs.workspace);
    const prepared = await prepareCheck({
      workspace: dirs.workspace,
      protectedParents: [{ label: 'repo', dir: dirs.repo }, { label: 'temp', dir: dirs.temp }],
      writeTargets: [{ label: 'deny-root', dir: path.join(root, 'repo') }],
      listTargets: [{ label: 'repo-root', dir: path.join(root, 'repo') }],
      workspaceWrite: 'deny',
      developerProfile: homedir(),
      shortPaths: fakeShort,
    });
    const ids = prepared.attempts.map((a) => a.id);
    for (const label of ['repo', 'temp']) {
      for (const v of ['long', 'short', 'forward-slashes', 'device-extended', 'device-dot', 'unc-localhost', 'unc-loopback', 'unc-extended', 'junction']) assert.ok(ids.includes(`${label}-read-${v}`), `${label}-read-${v}`);
      assert.ok(ids.includes(`${label}-write`) && ids.includes(`${label}-list`));
    }
    assert.ok(ids.includes('workspace-read') && ids.includes('workspace-write') && ids.includes('deny-root-write') && ids.includes('repo-root-list'));
    assert.equal(prepared.attempts.filter((a) => a.expect === 'allow').length, 1, 'only the workspace sentinel may be read');

    const sentinels = await Promise.all(prepared.attempts.filter((a) => a.variant === 'long' && a.op === 'read').map((a) => readFile(a.path)));
    const payload = Buffer.from(probePayload(prepared.attempts, [homedir()]), 'base64').toString('utf8');
    for (const s of sentinels) {
      assert.ok(!payload.includes(s.toString('hex')) && !payload.includes(s.toString('base64')), 'the payload never carries sentinel bytes');
    }
    assert.doesNotMatch(payload, /"expect"|"sha256"/, 'the probe is not told what to expect');

    await prepared.cleanup();
    assert.deepEqual(await readdir(dirs.workspace), []);
    assert.deepEqual(await readdir(dirs.repo), []);
    assert.deepEqual(await readdir(dirs.temp), []);
  });
});

describe('self check (the probe as the developer, disposable folders)', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  test('ends BLOCKER, because the developer can read everything; no sentinel content or names are reported; nothing is left behind', async (t) => {
    const parent = await tempDir(t, 'td-selfcheck-parent-');
    const { windowsShortPaths } = await import('../live.ts');
    const run = await runSelfCheck({ shortPaths: windowsShortPaths, parent });
    assert.equal(run.mode, 'self');
    assert.equal(run.report.verdict, 'BLOCKER');
    const item = (id: string) => run.report.items.find((i) => i.id === id)!;
    assert.equal(item('workspace-read').status, 'pass', 'the probe reads and hashes correctly');
    assert.equal(item('repo-read-long').status, 'fail');
    assert.equal(item('repo-read-short').status, 'fail', 'the 8.3 alias reaches the file for the developer');
    assert.equal(item('identity-account').status, 'fail');
    assert.match(item('identity-account').detail, new RegExp(`runs as ${userInfo().username}`));
    assert.equal(item('teardown').status, 'inconclusive', 'self mode never ends processes');
    assert.equal(item('temp-list').status, 'fail', 'the probe folder listing');
    assert.equal(item('temp-root-list').status, 'fail', 'the TEMP root listing, a separate check');
    const json = JSON.stringify(run);
    assert.ok(!json.toLowerCase().includes(parent.toLowerCase()) && !json.includes(parent.replaceAll('\\', '\\\\')), 'items carry IDs and statuses, never the paths they probed');
    assert.deepEqual(await readdir(parent), [], 'the temp folders were removed');
    assert.ok(!existsSync(path.join(parent, 'workspace')));
  });
});
