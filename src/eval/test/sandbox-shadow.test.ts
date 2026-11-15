import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCheck, plannedAttemptIds, probePayload } from '../sandbox/check.ts';
import type { CheckItem, ProbeIdentity, ProbeReport, ProbeResult } from '../sandbox/check.ts';
import { accountCheckSetup } from '../sandbox/run-check.ts';
import { SHADOW_ATTEMPT_PREFIX, SHADOW_DEVICE, SHADOW_INVENTORY_MAX_AGE_MS, categorize, controlFileProblem, controlPathInCopy, enumerationProblem, judgeShadowResults, judgeShadowStability, planShadowAttempts, withoutShadowResults } from '../sandbox/shadow.ts';
import type { ShadowCopy, ShadowInventory } from '../sandbox/shadow.ts';
import { tempDir } from './helpers.ts';

// R4b Step 1D: the shadow-copy part of the enforcement check, on synthetic inventories only. Nothing
// here reads a real shadow copy, needs elevation, or runs under another identity (the one probe run is
// the developer's own process on a temp file).

const REPO_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO = 'C:\\GIT\\test-detective';
const NOW = new Date('2026-11-15T12:00:00Z');
const OPTIONS = { computer: 'TESTPC', repoRoot: REPO, now: NOW };
const CONTROL = 'GIT\\test-detective\\package.json';
const OLD_ACL = 'D:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)';
const C_VOLUME = '\\\\?\\Volume{11111111-2222-4333-8444-555555555555}\\';
const D_VOLUME = '\\\\?\\Volume{66666666-7777-4888-9999-aaaaaaaaaaaa}\\';
const guid = (n: number) => `{${String(n).padStart(8, '0')}-0000-4000-8000-000000000000}`;
const device = (n: number) => `\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy${n}`;
const minutes = (n: number) => n * 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function copy(n: number, edit: Partial<ShadowCopy> = {}): ShadowCopy {
  return {
    id: guid(n),
    createdAt: '2026-11-12T04:22:35.0000000Z',
    volume: 'C:',
    volumeName: C_VOLUME,
    device: device(n),
    repo: { path: 'GIT\\test-detective', exists: true, sddl: OLD_ACL },
    control: { path: CONTROL, exists: true, sddl: OLD_ACL },
    ...edit,
  };
}
const elsewhere = (n: number, edit: Partial<ShadowCopy> = {}) => copy(n, { volume: 'D:', volumeName: D_VOLUME, repo: { path: 'GIT\\test-detective', exists: null, sddl: null }, control: { path: CONTROL, exists: null, sddl: null }, ...edit });
/** A complete inventory: both enumerations agree with the listed copies. */
function inventory(copies: ShadowCopy[], edit: Partial<ShadowInventory> = {}): ShadowInventory {
  return {
    schema: 2,
    computer: 'TESTPC',
    collectedAt: at(-minutes(5)),
    repoRoot: REPO,
    repoVolumeName: C_VOLUME,
    enumeration: { wmiCount: copies.length, vssadminExitCode: copies.length === 0 ? 1 : 0, vssadminIds: copies.map((c) => c.id.toLowerCase()), vssadminNoItems: copies.length === 0 },
    copies,
    ...edit,
  };
}

const IDENTITY: ProbeIdentity = { username: 'td-eval', home: 'C:\\Users\\td-eval', userprofile: 'C:\\Users\\td-eval', temp: 'C:\\Users\\td-eval\\AppData\\Local\\Temp', sid: 'S-1-5-21-1-2-3-2002', envNames: ['PATH'], envMentioningForbidden: [], tokenGroups: [{ name: 'BUILTIN\\Users', sid: 'S-1-5-32-545', attributes: 'Mandatory group, Enabled by default, Enabled group' }] };
const EXPECT = { account: 'td-eval', developer: { username: 'dev', home: 'C:\\Users\\dev', sid: 'S-1-5-21-1-2-3-1001' } };
const COMMITTED = new Set(['a'.repeat(64)]);
const STABLE: CheckItem = { id: 'shadow-inventory-stable', status: 'pass', detail: 'stable' };
const denied = (id: string, code = 'EACCES'): ProbeResult => ({ id, outcome: 'error', code });

/** The shadow verdict as the check would report it: the shadow items through evaluateCheck, with nothing else attempted. */
function verdict(items: CheckItem[]) {
  return evaluateCheck([], { identity: IDENTITY, results: [] }, EXPECT, { selected: 0, killed: 0, remaining: 0 }, items).verdict;
}
const only = (plan: ReturnType<typeof planShadowAttempts>) => plan.items.map((i) => [i.id, i.status]);

describe('inventory completeness', () => {
  test('a complete empty inventory is an explicit pass; an empty list without vssadmin saying "no items" is not', () => {
    const empty = planShadowAttempts(inventory([]), OPTIONS);
    assert.deepEqual(empty.attempts, []);
    assert.deepEqual(only(empty), [['shadow-inventory', 'pass']]);
    assert.match(empty.items[0]!.detail, /complete enumeration .*no shadow copies/);
    assert.equal(verdict(judgeShadowResults(empty, [], COMMITTED, STABLE).items), 'PASS');

    const silent = inventory([], { enumeration: { wmiCount: 0, vssadminExitCode: 1, vssadminIds: [], vssadminNoItems: false } });
    assert.match(enumerationProblem(silent)!, /did not report "no items"/);
    assert.deepEqual(only(planShadowAttempts(silent, OPTIONS)), [['shadow-inventory', 'inconclusive']]);
  });

  test('the two enumerations must agree with the listed copies, or nothing is planned', () => {
    const copies = [copy(3), copy(4)];
    const base = inventory(copies).enumeration;
    const cases: [ShadowInventory['enumeration'], RegExp][] = [
      [{ ...base, wmiCount: 3 }, /counted 3 copies/],
      [{ ...base, vssadminIds: [guid(3).toLowerCase()] }, /different shadow copies/],
      [{ ...base, vssadminIds: [...base.vssadminIds, guid(5).toLowerCase()] }, /different shadow copies/],
      [{ ...base, vssadminIds: [guid(3), guid(3)] }, /twice/],
      [{ ...base, vssadminIds: [guid(3), 'not-a-guid'] }, /not a GUID/],
      [{ ...base, vssadminExitCode: 2 }, /exit 2/],
      [{ ...base, vssadminNoItems: true }, /did not list the copies cleanly/],
    ];
    for (const [enumeration, problem] of cases) {
      const inv = inventory(copies, { enumeration });
      assert.match(enumerationProblem(inv) ?? '', problem);
      const plan = planShadowAttempts(inv, OPTIONS);
      assert.deepEqual(plan.attempts, [], 'no attempt from an incomplete inventory');
      assert.deepEqual(only(plan), [['shadow-inventory', 'inconclusive']]);
    }
    assert.equal(enumerationProblem(inventory(copies, { enumeration: { ...base, vssadminIds: base.vssadminIds.map((id) => id.toUpperCase()) } })), null, 'IDs compare without case');
  });

  test('a malformed, stale, future, foreign or mismatched inventory plans nothing and is inconclusive', () => {
    const { enumeration: _drop, ...noEnumeration } = inventory([copy(1)]);
    const cases: unknown[] = [
      { ...inventory([copy(1)]), schema: 1 },
      { ...inventory([copy(1)]), extra: true },
      noEnumeration,
      inventory([copy(1)], { repoVolumeName: 'C:\\' }),
      { ...inventory([]), copies: [{ ...copy(1), sddlRaw: 'x' }] },
      { ...inventory([]), copies: [{ ...copy(1), volume: 'c:' }] },
      inventory([copy(1)], { collectedAt: at(-SHADOW_INVENTORY_MAX_AGE_MS - 1) }),
      inventory([copy(1)], { collectedAt: at(minutes(1)) }),
      inventory([copy(1)], { collectedAt: 'yesterday' }),
      inventory([copy(1)], { computer: 'OTHERPC' }),
      inventory([copy(1)], { repoRoot: 'C:\\GIT\\other' }),
      null,
      'TD-VSS-INVENTORY {}',
    ];
    for (const raw of cases) {
      const plan = planShadowAttempts(raw, OPTIONS);
      assert.deepEqual(plan.attempts, [], JSON.stringify(raw)?.slice(0, 80));
      assert.deepEqual(only(plan), [['shadow-inventory', 'inconclusive']]);
    }
    assert.equal(SHADOW_INVENTORY_MAX_AGE_MS, 30 * 60_000, 'the planning inventory must be at most 30 minutes old');
  });
});

describe('planning from the elevated inventory', () => {
  test('one read of the control file per copy that contains the repo, through exactly the inventoried device; no device numbers are guessed', () => {
    const plan = planShadowAttempts(inventory([
      copy(3),
      copy(5, { createdAt: '2026-10-01T00:00:00Z', repo: { path: 'GIT\\test-detective', exists: false, sddl: null }, control: { path: CONTROL, exists: false, sddl: null } }),
      elsewhere(7),
      copy(41),
    ]), OPTIONS);
    assert.deepEqual(plan.attempts, [
      { id: 'shadow-3-read', op: 'read', path: `${device(3)}\\${CONTROL}`, expect: 'deny', variant: 'shadow-copy' },
      { id: 'shadow-41-read', op: 'read', path: `${device(41)}\\${CONTROL}`, expect: 'deny', variant: 'shadow-copy' },
    ]);
    assert.deepEqual(only(plan), [['shadow-5-scope', 'pass'], ['shadow-7-scope', 'pass']]);
    assert.equal(plan.copyOf['shadow-41-read'], guid(41));
    assert.ok(plan.attempts.every((a) => !/evals|truth|score|run|credential/i.test(a.path)), 'only the public control file is attempted');
  });

  test('the source volume is decided by its GUID: a copy without a drive letter is still tested; an unresolved or contradictory volume is inconclusive', () => {
    const plan = planShadowAttempts(inventory([
      copy(2, { volume: null }),
      elsewhere(3, { volume: null }),
      copy(4, { volumeName: '' }),
      copy(5, { volumeName: 'C:\\' }),
      copy(6, { volumeName: D_VOLUME }),
      copy(8, { volume: 'D:' }),
    ]), OPTIONS);
    assert.deepEqual(plan.attempts.map((a) => a.id), ['shadow-2-read'], 'no drive letter, but the repo volume: tested');
    assert.deepEqual(only(plan), [['shadow-3-scope', 'pass'], ['shadow-4-scope', 'inconclusive'], ['shadow-5-scope', 'inconclusive'], ['shadow-6-scope', 'inconclusive'], ['shadow-8-scope', 'inconclusive']]);
  });

  test('invalid, duplicated or undecidable entries are inconclusive and never attempted', () => {
    const bad = [
      copy(1, { device: '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3' }),
      copy(2, { device: '\\\\.\\HarddiskVolumeShadowCopy2' }),
      copy(3, { device: 'C:\\GIT' }),
      copy(4, { device: `${device(4)}\\..\\HarddiskVolume3` }),
      copy(5, { device: device(0) }),
      copy(8),
      copy(10, { device: device(8) }),
      copy(11, { repo: { path: 'GIT\\test-detective', exists: null, sddl: null } }),
      copy(12, { control: { path: CONTROL, exists: false, sddl: null } }),
      copy(13, { control: { path: 'GIT\\test-detective\\evals\\x\\truth.json', exists: true, sddl: null } }),
    ];
    const plan = planShadowAttempts(inventory(bad), OPTIONS);
    assert.deepEqual(plan.attempts.map((a) => a.id), ['shadow-8-read'], 'only the one valid, decidable copy');
    assert.equal(plan.items.length, bad.length - 1);
    assert.ok(plan.items.every((i) => i.status === 'inconclusive'), plan.items.map((i) => `${i.id}: ${i.detail}`).join('\n'));
    assert.equal(new Set(plan.items.map((i) => i.id)).size, plan.items.length, 'each finding has its own ID');
    const badId = planShadowAttempts(inventory([copy(8), copy(6, { id: 'not-a-guid' })]), OPTIONS);
    assert.deepEqual(badId.attempts, [], 'a copy ID that is not a GUID makes the whole inventory unusable');
    assert.deepEqual(only(badId), [['shadow-inventory', 'inconclusive']]);
    assert.ok(SHADOW_DEVICE.test(device(123456)) && !SHADOW_DEVICE.test(device(1234567)));
  });

  test('duplicate copy IDs or device paths are rejected', () => {
    const dupDevice = planShadowAttempts(inventory([copy(8), copy(9, { device: device(8) })]), OPTIONS);
    assert.deepEqual(dupDevice.attempts.map((a) => a.id), ['shadow-8-read']);
    assert.deepEqual(only(dupDevice), [['shadow-8-device', 'inconclusive']]);
    const dupId = inventory([copy(8), copy(9, { id: guid(8) })]);
    assert.notEqual(enumerationProblem(dupId), null, 'a duplicate ID never agrees with a vssadmin list of unique IDs');
    assert.deepEqual(planShadowAttempts(dupId, OPTIONS).attempts, []);
  });

  test('no copy of the repo volume, or none that contains the repo, is a pass with nothing to attempt', () => {
    for (const copies of [[elsewhere(2)], [copy(4, { repo: { path: 'GIT\\test-detective', exists: false, sddl: null } })]]) {
      const plan = planShadowAttempts(inventory(copies), OPTIONS);
      assert.deepEqual(plan.attempts, []);
      assert.equal(plan.items.at(-1)!.id, 'shadow-inventory');
      assert.match(plan.items.at(-1)!.detail, /none of C: contains the repo/);
      assert.equal(verdict(judgeShadowResults(plan, [], COMMITTED, STABLE).items), 'PASS');
    }
  });

  test('the control file is public, committed content: answers, eval code, Claude configuration and odd paths are refused', () => {
    assert.equal(controlFileProblem('package.json'), null);
    assert.equal(controlPathInCopy(REPO), CONTROL);
    for (const bad of ['evals/scenarios/S01/truth.json', 'src/eval/score.ts', 'evals/runs/x/score.json', '.claude/settings.json', '.claude/skills/investigate-failure/SKILL.md', 'scenarios/S01/control/a.spec.ts', '../package.json', 'a\\b', '/etc/passwd', 'C:/x', '.env', 'transcript.jsonl']) {
      assert.notEqual(controlFileProblem(bad), null, bad);
    }
    assert.throws(() => controlPathInCopy(REPO, 'evals/scenarios/S01/truth.json'), /can't be the shadow-copy control/);
    assert.throws(() => controlPathInCopy('C:\\', 'package.json'), /canonical drive path/);
  });
});

describe('freshness: the copy set must be unchanged around the probe', () => {
  const window = { computer: 'TESTPC', repoRoot: REPO, probeStartedAt: NOW, probeEndedAt: new Date(NOW.getTime() + minutes(2)) };
  const before = inventory([copy(3), copy(4)], { collectedAt: at(-minutes(5)) });
  const after = (copies: ShadowCopy[] = [copy(3), copy(4)], edit: Partial<ShadowInventory> = {}) => inventory(copies, { collectedAt: at(minutes(4)), ...edit });

  test('the same complete copy set just before and just after is a pass', () => {
    assert.equal(judgeShadowStability(before, after(), window).status, 'pass');
    assert.equal(judgeShadowStability(inventory([], { collectedAt: at(-minutes(5)) }), after([]), window).status, 'pass', 'empty before and after');
  });

  test('a missing, incomplete, foreign, late or different inventory is inconclusive', () => {
    const cases: [unknown, unknown, RegExp][] = [
      [before, null, /no inventory was taken after the probe/],
      [before, undefined, /no inventory was taken after the probe/],
      [before, after([copy(3), copy(4), copy(5)]), /1 copies appeared/],
      [before, after([copy(3)]), /1 disappeared/],
      [before, after([copy(3), copy(4, { createdAt: '2026-11-15T11:59:00Z' })]), /appeared .* disappeared or changed/],
      [before, after([copy(3), copy(4, { device: device(14) })]), /disappeared or changed/],
      [before, after([copy(3), copy(4, { control: { path: CONTROL, exists: false, sddl: null } })]), /disappeared or changed/],
      [before, after(undefined, { enumeration: { wmiCount: 2, vssadminExitCode: 0, vssadminIds: [guid(3).toLowerCase()], vssadminNoItems: false } }), /after the probe: .*incomplete/],
      [inventory([copy(3), copy(4)], { collectedAt: at(-minutes(5)), computer: 'OTHERPC' }), after(), /before the probe: .*OTHERPC/],
      [before, after(undefined, { repoVolumeName: D_VOLUME }), /repo volume changed/],
      [inventory([copy(3), copy(4)], { collectedAt: at(-SHADOW_INVENTORY_MAX_AGE_MS - 1) }), after(), /not taken shortly before/],
      [inventory([copy(3), copy(4)], { collectedAt: at(minutes(1)) }), after(), /not taken shortly before/],
      [before, after(undefined, { collectedAt: at(minutes(1)) }), /not taken shortly after/],
      [before, after(undefined, { collectedAt: at(minutes(2) + SHADOW_INVENTORY_MAX_AGE_MS + 1) }), /not taken shortly after/],
      [{ ...before, schema: 1 }, after(), /malformed/],
    ];
    for (const [b, a, detail] of cases) {
      const item = judgeShadowStability(b, a, window);
      assert.equal(item.status, 'inconclusive', item.detail);
      assert.match(item.detail, detail);
    }
    assert.equal(judgeShadowStability(before, after(), { ...window, probeEndedAt: new Date(NOW.getTime() - 1) }).status, 'inconclusive', 'an invalid window');
  });

  test('every planned read denied is still INCONCLUSIVE without a confirmed stable copy set', () => {
    const plan = planShadowAttempts(before, OPTIONS);
    const results = [denied('shadow-3-read'), denied('shadow-4-read')];
    assert.equal(verdict(judgeShadowResults(plan, results, COMMITTED, STABLE).items), 'PASS');
    assert.equal(verdict(judgeShadowResults(plan, results, COMMITTED, null).items), 'INCONCLUSIVE');
    assert.equal(verdict(judgeShadowResults(plan, results, COMMITTED, judgeShadowStability(before, after([copy(3)]), window)).items), 'INCONCLUSIVE');
    assert.equal(verdict(judgeShadowResults(planShadowAttempts(inventory([]), OPTIONS), [], COMMITTED, null).items), 'INCONCLUSIVE', 'even an empty inventory needs the second one');
  });
});

describe('judging the probe results', () => {
  const plan = planShadowAttempts(inventory([copy(3), copy(4)]), OPTIONS);

  test('PASS needs a Windows denial for every planned copy', () => {
    const j = judgeShadowResults(plan, [denied('shadow-3-read'), denied('shadow-4-read', 'EPERM')], COMMITTED, STABLE);
    assert.deepEqual(j.items.map((i) => i.status), ['pass', 'pass', 'pass']);
    assert.equal(j.categories.denied, 2);
    assert.equal(verdict(j.items), 'PASS');
    assert.equal(verdict(judgeShadowResults(plan, [denied('shadow-3-read')], COMMITTED, STABLE).items), 'INCONCLUSIVE', 'an unattempted copy is not a pass');
  });

  test('any successful read is a BLOCKER, whatever else is reported; the hash tells only whether it matches a committed version', () => {
    const reads: [ProbeResult, RegExp][] = [
      [{ id: 'shadow-3-read', outcome: 'ok', sha256: 'a'.repeat(64) }, /matches a committed version/],
      [{ id: 'shadow-3-read', outcome: 'ok', sha256: 'b'.repeat(64) }, /matches no committed version/],
      [{ id: 'shadow-3-read', outcome: 'ok' }, /no hash was reported/],
      [{ id: 'shadow-3-read', outcome: 'ok', sha256: 'a'.repeat(64), count: 3 }, /READ/],
    ];
    for (const [result, detail] of reads) {
      for (const stability of [STABLE, null]) {
        const j = judgeShadowResults(plan, [result, denied('shadow-4-read')], COMMITTED, stability);
        assert.equal(j.items[0]!.status, 'fail');
        assert.match(j.items[0]!.detail, detail);
        assert.equal(verdict(j.items), 'BLOCKER', 'a read is a BLOCKER even when stability is unconfirmed');
      }
    }
    const dup = judgeShadowResults(plan, [denied('shadow-3-read'), { id: 'shadow-3-read', outcome: 'ok', sha256: 'a'.repeat(64) }, denied('shadow-4-read')], COMMITTED, STABLE);
    assert.equal(dup.items[0]!.status, 'fail', 'a duplicate never hides a successful read');
    assert.equal(verdict(dup.items), 'BLOCKER');
  });

  test('not-found, invalid device, unsupported, missing, duplicate and malformed results are kept apart and are all inconclusive', () => {
    const cases: [ProbeResult[], string][] = [
      [[denied('shadow-3-read', 'ENOENT')], 'not-found'],
      [[denied('shadow-3-read', 'ENOTDIR')], 'not-found'],
      [[denied('shadow-3-read', 'EINVAL')], 'invalid-device'],
      [[denied('shadow-3-read', 'ENODEV')], 'invalid-device'],
      [[denied('shadow-3-read', 'UNKNOWN')], 'unsupported'],
      [[denied('shadow-3-read', 'EBUSY')], 'unsupported'],
      [[], 'missing'],
      [[denied('shadow-3-read'), denied('shadow-3-read')], 'duplicate'],
      [[{ id: 'shadow-3-read', outcome: 'error', code: 'EACCES', sha256: 'a'.repeat(64) }], 'malformed'],
      [[{ id: 'shadow-3-read', outcome: 'error' }], 'malformed'],
      [[{ id: 'shadow-3-read', outcome: 'error', code: 'EACCES', count: 0 }], 'malformed'],
    ];
    for (const [results, category] of cases) {
      const j = judgeShadowResults(plan, [...results, denied('shadow-4-read')], COMMITTED, STABLE);
      assert.equal(j.items[0]!.status, 'inconclusive', `${category}: ${j.items[0]!.detail}`);
      assert.equal(j.categories[category as keyof typeof j.categories], 1, category);
      assert.equal(j.categories.denied, 1, 'only the other copy counts as denied');
      assert.equal(verdict(j.items), 'INCONCLUSIVE');
    }
    assert.equal(categorize(denied('x', 'EPERM')), 'denied');
  });

  test('results for unplanned shadow attempts are inconclusive; results of the other attempts are left to evaluateCheck', () => {
    const j = judgeShadowResults(plan, [denied('shadow-3-read'), denied('shadow-4-read'), denied('shadow-9-read'), denied('repo-read-long')], COMMITTED, STABLE);
    assert.ok(j.items.some((i) => i.id === 'shadow-unknown-results' && i.status === 'inconclusive'));
    assert.equal(verdict(j.items), 'INCONCLUSIVE');
    const report: ProbeReport = { identity: IDENTITY, results: [denied('shadow-3-read'), denied('repo-read-long')] };
    assert.deepEqual(withoutShadowResults(report).results.map((r) => r.id), ['repo-read-long']);
  });

  test('an inconclusive inventory item keeps the verdict inconclusive even when every planned read was denied', () => {
    const mixed = planShadowAttempts(inventory([copy(3), copy(6, { device: 'C:\\x' })]), OPTIONS);
    assert.equal(verdict(judgeShadowResults(mixed, [denied('shadow-3-read')], COMMITTED, STABLE).items), 'INCONCLUSIVE');
  });

  test("shadow attempt IDs can't collide with the account check's own attempts", () => {
    const setup = accountCheckSetup({ repoRoot: REPO, temp: 'C:\\Users\\dev\\AppData\\Local\\Temp', profile: 'C:\\Users\\dev', runtime: 'C:\\td-eval\\runtime', workspace: 'C:\\td-eval\\work\\ws' }, async (p) => p.map(() => null));
    assert.ok(plannedAttemptIds(setup).every((id) => !id.startsWith(SHADOW_ATTEMPT_PREFIX)));
  });

  test('the probe reports a read as its SHA-256 only, never the contents (run as the developer on a temp file)', async (t) => {
    const dir = await tempDir(t, 'td-shadow-probe-');
    const file = path.join(dir, 'package.json');
    const marker = 'TD-SHADOW-CONTENT-MARKER-7f3a';
    await writeFile(file, `{"name":"${marker}"}`);
    const payload = probePayload([{ id: 'shadow-1-read', op: 'read', path: file, expect: 'deny', variant: 'shadow-copy' }, { id: 'shadow-2-read', op: 'read', path: path.join(dir, 'missing.json'), expect: 'deny', variant: 'shadow-copy' }], []);
    const run = spawnSync(process.execPath, [path.join(REPO_SRC, 'scripts', 'eval-sandbox', 'runtime', 'probe.mjs'), payload], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes(marker) && !run.stderr.includes(marker), 'no contents on stdout or stderr');
    const results = (JSON.parse(run.stdout.trim()) as { results: Record<string, unknown>[] }).results;
    assert.deepEqual(Object.keys(results[0]!).sort(), ['id', 'outcome', 'sha256']);
    assert.match(String(results[0]!.sha256), /^[0-9a-f]{64}$/);
    assert.deepEqual(results[1], { id: 'shadow-2-read', outcome: 'error', code: 'ENOENT' });
    assert.equal(categorize(results[1] as ProbeResult), 'not-found', 'a missing file is never a denial');
  });
});

describe('static guarantees', () => {
  test('shadow.ts does no I/O of its own: no file system, process, network or SDK access', () => {
    const source = readFileSync(path.join(REPO_SRC, 'src', 'eval', 'sandbox', 'shadow.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['./check.ts', './check.ts', './runtime.ts', 'zod']);
    assert.doesNotMatch(source, /node:(fs|child_process|net|http|https)|readFile|writeFile|spawn|execFile|execSync|fetch\(/);
  });

  test('the shadow checker is wired into the account-mode check only (Step 1D.2B); the launcher and the probe know nothing of it', () => {
    const source = (file: string) => readFileSync(path.join(REPO_SRC, 'src', 'eval', 'sandbox', file), 'utf8');
    assert.match(source('run-check.ts'), /from '\.\/shadow\.ts'/);
    assert.doesNotMatch(source('launcher.ts'), /shadow/i, "launcher.ts doesn't use the shadow checker");
    assert.doesNotMatch(source('check.ts'), /from '\.\/shadow\.ts'/, 'check.ts does not import the shadow checker');
    const self = /export async function runSelfCheck[\s\S]*?\n}\n/.exec(source('run-check.ts'))![0];
    assert.doesNotMatch(self, /shadow/i, 'self mode has no shadow part');
    assert.doesNotMatch(readFileSync(path.join(REPO_SRC, 'scripts', 'eval-sandbox', 'runtime', 'probe.mjs'), 'utf8'), /shadow|GLOBALROOT/i, 'the probe has no shadow-specific code; it reads only what the host plans');
  });

  test('vss-inventory.ps1 only reads: no change to copies, settings or ACLs, no folder listing or file reads, no downloads, no dynamic code, nothing written or sent', () => {
    const script = readFileSync(path.join(REPO_SRC, 'scripts', 'eval-sandbox', 'vss-inventory.ps1'), 'utf8');
    const code = script.replace(/<#[\s\S]*?#>/, '').split(/\r?\n/).filter((l) => !l.trimStart().startsWith('#')).join('\n');
    assert.doesNotMatch(code, /\b(delete|resize|create|add|revert|Remove-|Set-(?!StrictMode)|New-|Clear-|Rename-|Move-|Copy-|Out-File|Add-Content|Export-|icacls|takeown|Disable-ComputerRestore|Enable-ComputerRestore|Checkpoint-Computer|Invoke-CimMethod|Invoke-WmiMethod|Invoke-Expression|\biex\b|Invoke-Command|Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|Start-Process|Start-Service|Add-Type|Import-Module|ScriptBlock|WriteAll|ReadAll|OpenRead|GetFiles|GetDirectories|EnumerateFile|EnumerateDirector|Get-ChildItem|Get-Content|SetAccessControl|Get-Credential|Import-Clixml|ConvertTo-SecureString)\b/i);
    assert.doesNotMatch(code, /^\s*\.\s+\S/m, 'no dot-sourcing');
    assert.doesNotMatch(code, /evals|truth|score|transcript|credential|\.claude|https?:/i, 'never names answer, secret or network locations');
    assert.deepEqual([...code.matchAll(/& \$Vssadmin (.+?)(?: 2>&1|$)/gm)].map((m) => m[1]), ['list shadows', 'list shadowstorage'], 'vssadmin only lists');
    assert.match(code, /\$Vssadmin = Join-Path \$env:SystemRoot 'System32\\vssadmin\.exe'/, 'vssadmin from System32, not from PATH');
    assert.match(code, /\$controlRel = "\$repoRel\\package\.json"/, 'the only file checked is the public control');
    assert.ok(code.includes(SHADOW_DEVICE.source.replace('([1-9][0-9]{0,5})', '[1-9][0-9]{0,5}')), 'the script attempts only device paths the planner accepts');
    assert.match(code, /Get-CimInstance Win32_ShadowCopy -ErrorAction Stop/, 'a failed enumeration stops the script');
    assert.match(code, /schema += 2/);
    assert.match(code, /'TD-VSS-INVENTORY ' \+ \(ConvertTo-Json -InputObject \$inventory/);
  });
});
