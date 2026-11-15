import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCheck, parseProbeOutput, plannedAttemptIds, reportOf } from '../sandbox/check.ts';
import type { CheckItem, CheckReport, CheckSetup, ProbeIdentity, ProbeResult } from '../sandbox/check.ts';
import { DEFAULT_SANDBOX, runtimeDir, shadowInventoryFile, shadowPendingFile, stateDir } from '../sandbox/config.ts';
import { RestrictedLaunchError } from '../sandbox/launcher.ts';
import type { LaunchHost } from '../sandbox/launcher.ts';
import { checkPrivatePaths, createPrivateJson, dropInterruptedCreate, readPrivateJson, sha256Json, writePrivateJson } from '../sandbox/private-state.ts';
import { acquireSandboxLock, canonicalRepoRoot, committedControlHashes, discardShadowPending, finalizeShadowCheck, runAccountCheck } from '../sandbox/run-check.ts';
import type { AccountCheckSeams, CheckRun } from '../sandbox/run-check.ts';
import { combineWithShadow, controlPathInCopy, finalizeShadow, planShadowAttempts, SHADOW_CONTROL_FILE, shadowResultsOf, withoutShadowResults } from '../sandbox/shadow.ts';
import type { ShadowCopy, ShadowInventory, ShadowPending } from '../sandbox/shadow.ts';
import { tempDir } from './helpers.ts';

// R4b Step 1D.2B: the shadow-copy part of `check --account` and `check --finalize-shadow`, end to end
// with a fake probe (AccountCheckSeams.runScript), synthetic inventories and temp state folders. Nothing
// here reads a shadow copy, needs elevation, launches anything under another identity, or touches the
// repo's .work, the real %LOCALAPPDATA% or C:\td-eval.

const REPO_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SANDBOX_SRC = path.join(REPO_SRC, 'src', 'eval', 'sandbox');
const REPO = canonicalRepoRoot();
const OPTIONS = { computer: 'TESTPC', repoRoot: REPO };
const CONTROL = controlPathInCopy(REPO);
const C_VOLUME = '\\\\?\\Volume{11111111-2222-4333-8444-555555555555}\\';
const D_VOLUME = '\\\\?\\Volume{66666666-7777-4888-9999-aaaaaaaaaaaa}\\';
const T0 = new Date('2026-11-15T12:00:00Z');
const START = T0;
const END = new Date('2026-11-15T12:04:00Z');
const COMMITTED = 'c'.repeat(64);
const minutes = (n: number) => n * 60_000;
const at = (base: Date, offsetMs: number) => new Date(base.getTime() + offsetMs).toISOString();
const guid = (n: number) => `{${String(n).padStart(8, '0')}-0000-4000-8000-000000000000}`;
const device = (n: number) => `\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy${n}`;

function copy(n: number, edit: Partial<ShadowCopy> = {}): ShadowCopy {
  return {
    id: guid(n),
    createdAt: '2026-11-09T04:22:35.0000000Z',
    volume: 'C:',
    volumeName: C_VOLUME,
    device: device(n),
    repo: { path: CONTROL.slice(0, -`\\${SHADOW_CONTROL_FILE}`.length), exists: true, sddl: 'D:AI(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)' },
    control: { path: CONTROL, exists: true, sddl: 'D:AI(A;ID;0x1200a9;;;BU)' },
    ...edit,
  };
}
const onD = (n: number) => copy(n, { volume: 'D:', volumeName: D_VOLUME, repo: { path: copy(n).repo.path, exists: null, sddl: null }, control: { path: CONTROL, exists: null, sddl: null } });
function inventory(copies: ShadowCopy[], collectedAt: string, edit: Partial<ShadowInventory> = {}): ShadowInventory {
  return {
    schema: 2,
    computer: 'TESTPC',
    collectedAt,
    repoRoot: REPO,
    repoVolumeName: C_VOLUME,
    enumeration: { wmiCount: copies.length, vssadminExitCode: copies.length === 0 ? 1 : 0, vssadminIds: copies.map((c) => c.id.toLowerCase()), vssadminNoItems: copies.length === 0 },
    copies,
    ...edit,
  };
}
const statusOf = (report: CheckReport, id: string) => report.items.filter((i) => i.id === id).map((i) => i.status);
const denied = (id: string): ProbeResult => ({ id, outcome: 'error', code: 'EACCES' });

// ---------------------------------------------------------------------------------------------
// The workflow harness: before-inventory -> fake restricted probe -> after-inventory -> finalize.

const EVAL_IDENTITY: ProbeIdentity = {
  username: 'td-eval',
  home: 'C:\\Users\\td-eval',
  userprofile: 'C:\\Users\\td-eval',
  temp: 'C:\\Users\\td-eval\\AppData\\Local\\Temp',
  sid: 'S-1-5-21-9-9-9-2002',
  envNames: ['PATH'],
  envMentioningForbidden: [],
  tokenGroups: [
    { name: 'BUILTIN\\Users', sid: 'S-1-5-32-545', attributes: 'Mandatory group, Enabled by default, Enabled group' },
    { name: 'TESTPC\\td-eval-sandbox', sid: 'S-1-5-21-9-9-9-3003', attributes: 'Mandatory group, Enabled by default, Enabled group' },
  ],
};
type PlannedAttempt = { id: string; op: string; path: string };
type FakeProbe = {
  /** Answer for one attempt; undefined means the default (workspace read hashed for real, everything else EACCES). */
  answer?: (a: PlannedAttempt) => unknown[] | undefined;
  extra?: unknown[];
  identity?: ProbeIdentity;
  /** Raw stdout instead of a generated report. */
  stdout?: string;
  throws?: Error;
  teardown?: string | Error;
};
type Workflow = {
  local: string;
  host: LaunchHost;
  calls: { script: string; payload?: { attempts: PlannedAttempt[]; forbidden: string[] }; rawPayload?: string }[];
  account: () => Promise<CheckRun>;
  recordAfter: (inv: unknown) => Promise<void>;
  finalize: (now?: Date) => Promise<CheckRun>;
  clock: { now: number };
};

async function workflow(t: TestContext, options: { before?: unknown; probe?: FakeProbe } = {}): Promise<Workflow> {
  const local = await tempDir(t, 'td-shadow-local-');
  const scratch = await tempDir(t, 'td-shadow-scratch-');
  const host: LaunchHost = { computer: 'TESTPC', localAppData: local, programFiles: 'C:\\Program Files', systemRoot: 'C:\\Windows', developer: { username: 'dev', home: homedir(), sid: null } };
  const clock = { now: T0.getTime() };
  const before = options.before === undefined ? inventory([copy(1)], at(T0, -minutes(10))) : options.before;
  if (before !== null) await writePrivateJson(local, shadowInventoryFile(local, 'before'), before);
  const calls: Workflow['calls'] = [];
  const probe = options.probe ?? {};
  const runScript: AccountCheckSeams['runScript'] = async (script, args) => {
    if (script === 'teardown.mjs') {
      calls.push({ script });
      if (probe.teardown instanceof Error) throw probe.teardown;
      return probe.teardown ?? '{"selected":0,"killed":0,"remaining":0}\n';
    }
    const raw = Buffer.from(args[0]!, 'base64').toString('utf8');
    const payload = JSON.parse(raw) as { attempts: PlannedAttempt[]; forbidden: string[] };
    calls.push({ script, payload, rawPayload: raw });
    clock.now += minutes(4);
    if (probe.throws) throw probe.throws;
    if (probe.stdout !== undefined) return probe.stdout;
    const results = payload.attempts.flatMap((a) => {
      const custom = probe.answer?.(a);
      if (custom) return custom;
      if (a.id === 'workspace-read') return [{ id: a.id, outcome: 'ok', sha256: createHash('sha256').update(readFileSync(a.path)).digest('hex') }];
      return [{ id: a.id, outcome: 'error', code: 'EACCES' }];
    });
    return `${JSON.stringify({ identity: probe.identity ?? EVAL_IDENTITY, results: [...results, ...(probe.extra ?? [])] })}\n`;
  };
  const checkSetup = (workspace: string): CheckSetup => ({
    workspace,
    protectedParents: [{ label: 'repo', dir: path.join(scratch, 'repo', '.work') }],
    writeTargets: [{ label: 'deny-root', dir: path.join(scratch, 'repo') }],
    listTargets: [{ label: 'repo-root', dir: path.join(scratch, 'repo') }],
    workspaceWrite: 'deny',
    developerProfile: homedir(),
    shortPaths: async (p) => p.map(() => null),
  });
  const seams: AccountCheckSeams = {
    verifyRuntime: async () => ({ problems: [] }),
    workRoot: scratch,
    grantWorkspace: async () => {},
    checkSetup,
    runScript,
    committedHashes: async () => [COMMITTED],
    clock: () => new Date(clock.now),
  };
  return {
    local,
    host,
    calls,
    clock,
    account: () => runAccountCheck(DEFAULT_SANDBOX, { shortPaths: async (p) => p.map(() => null), host, seams }),
    recordAfter: (inv) => writePrivateJson(local, shadowInventoryFile(local, 'after'), inv),
    finalize: (now) => finalizeShadowCheck({ computer: 'TESTPC', localAppData: local, now: now ?? new Date(clock.now + minutes(10)) }),
  };
}
const discard = (w: Workflow, runId: string) => discardShadowPending({ computer: 'TESTPC', localAppData: w.local, runId });
/** The after-inventory a correct operator takes: the same copies, a few minutes after the probe ended. */
const afterOf = (w: Workflow, copies: ShadowCopy[] = [copy(1)], offset = minutes(3)) => inventory(copies, new Date(w.clock.now + offset).toISOString());
const shadowOk = (sha256: string) => (a: PlannedAttempt) => (a.id.startsWith('shadow-') ? [{ id: a.id, outcome: 'ok', sha256 }] : undefined);

describe('section 4: the historical control file', () => {
  test('every planned read is <inventoried device>\\<repo path>\\package.json, nothing else', () => {
    const plan = planShadowAttempts(inventory([copy(1), copy(7), onD(9)], at(T0, -minutes(1))), { ...OPTIONS, now: T0 });
    assert.deepEqual(plan.attempts.map((a) => a.path), [`${device(1)}\\${CONTROL}`, `${device(7)}\\${CONTROL}`]);
    assert.ok(plan.attempts.every((a) => a.path.endsWith(`\\${SHADOW_CONTROL_FILE}`) && a.op === 'read' && a.expect === 'deny'));
  });

  test("a caller can't choose another control file: an extra `control` option is ignored", () => {
    const plan = planShadowAttempts(inventory([copy(1)], at(T0, -minutes(1))), { ...OPTIONS, now: T0, control: 'evals/scenarios/S01/truth.json' } as never);
    assert.deepEqual(plan.attempts.map((a) => a.path), [`${device(1)}\\${CONTROL}`]);
    assert.doesNotMatch(readFileSync(path.join(SANDBOX_SRC, 'shadow.ts'), 'utf8'), /options\.control/);
  });

  test('an inventory naming other paths (truths, results, transcripts, credentials, .claude, another repo) plans nothing', () => {
    const base = copy(1).repo.path;
    const others = [`${base}\\evals\\scenarios\\S01\\truth.json`, `${base}\\evals\\runs\\x\\score.json`, `${base}\\evals\\runs\\x\\transcript.jsonl`, `${base}\\.claude\\settings.json`, 'Users\\dev\\AppData\\Local\\test-detective\\eval-account.xml', `${base}\\..\\other\\package.json`, `${base}\\PACKAGE.JSON.bak`];
    for (const p of others) {
      const plan = planShadowAttempts(inventory([copy(1, { control: { path: p, exists: true, sddl: null } })], at(T0, -minutes(1))), { ...OPTIONS, now: T0 });
      assert.deepEqual(plan.attempts, [], p);
      assert.deepEqual(plan.items.map((i) => i.status), ['inconclusive'], p);
    }
    const otherRepo = planShadowAttempts(inventory([copy(1, { repo: { path: 'GIT\\other', exists: true, sddl: null } })], at(T0, -minutes(1))), { ...OPTIONS, now: T0 });
    assert.deepEqual(otherRepo.attempts, []);
  });

  test('device paths other than \\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopyN are never attempted', () => {
    for (const d of [`${device(1)}\\..\\..`, `${device(1)}\\GIT`, '\\\\?\\C:\\', '\\\\localhost\\C$', 'C:\\GIT', `${device(0)}`, '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3']) {
      const plan = planShadowAttempts(inventory([copy(1, { device: d })], at(T0, -minutes(1))), { ...OPTIONS, now: T0 });
      assert.deepEqual(plan.attempts, [], d);
    }
  });

  test('the probe receives only attempt IDs, operations and paths: no expected hashes, inventory, SDDL or state paths', async (t) => {
    const w = await workflow(t);
    await w.account();
    const raw = w.calls.find((c) => c.script === 'probe.mjs')!.rawPayload!;
    const payload = JSON.parse(raw) as { attempts: Record<string, unknown>[] };
    assert.ok(payload.attempts.every((a) => Object.keys(a).sort().join() === 'id,op,path'));
    for (const secret of [COMMITTED, 'sddl', 'D:AI', 'eval-vss', 'shadow-pending', 'test-detective\\\\eval', 'collectedAt', 'vssadmin']) assert.ok(!raw.includes(secret), secret);
    assert.deepEqual(payload.attempts.filter((a) => String(a.id).startsWith('shadow-')), [{ id: 'shadow-1-read', op: 'read', path: `${device(1)}\\${CONTROL}` }]);
  });

  test('the host computes expected hashes from git; the restricted runtime never runs git', async () => {
    const hashes = await committedControlHashes(REPO_SRC);
    const head = execFileSync('git', ['-C', REPO_SRC, 'show', `HEAD:${SHADOW_CONTROL_FILE}`]);
    assert.ok(hashes.includes(createHash('sha256').update(head).digest('hex')));
    assert.ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h)));
    for (const f of ['probe.mjs', 'stage2.mjs', 'teardown.mjs']) assert.doesNotMatch(readFileSync(path.join(REPO_SRC, 'scripts', 'eval-sandbox', 'runtime', f), 'utf8'), /\bgit\b/, f);
  });

  test('a successful read is a BLOCKER whether or not its hash matches a committed version', async (t) => {
    for (const [sha, words] of [[COMMITTED, /matches a committed version/], ['d'.repeat(64), /matches no committed version/]] as const) {
      const w = await workflow(t, { probe: { answer: shadowOk(sha) } });
      assert.equal((await w.account()).report.verdict, 'BLOCKER');
      await w.recordAfter(afterOf(w));
      const final = await w.finalize();
      assert.equal(final.report.verdict, 'BLOCKER');
      assert.deepEqual(statusOf(final.report, 'shadow-1-read'), ['fail']);
      assert.match(final.report.items.find((i) => i.id === 'shadow-1-read')!.detail, words);
    }
  });
});

describe('section 5: the four-step workflow', () => {
  test('one relevant copy, read denied, every other check passing, stable inventories: PASS (and only after finalization)', async (t) => {
    const w = await workflow(t);
    const account = await w.account();
    assert.equal(account.report.verdict, 'INCONCLUSIVE', 'the account step alone never passes');
    assert.deepEqual(statusOf(account.report, 'shadow-inventory-stable'), ['inconclusive']);
    assert.ok(account.report.items.filter((i) => !i.id.startsWith('shadow-')).every((i) => i.status === 'pass'), 'every other check passed');
    await w.recordAfter(afterOf(w));
    const final = await w.finalize();
    assert.equal(final.report.verdict, 'PASS');
    assert.equal(final.runId, account.runId);
    assert.equal(final.shadow?.denied, 1);
    assert.deepEqual(statusOf(final.report, 'shadow-1-read'), ['pass']);
  });

  test('a successful read with malformed or duplicated metadata is still a BLOCKER', async (t) => {
    const variants: ((a: PlannedAttempt) => unknown[] | undefined)[] = [
      (a) => (a.id.startsWith('shadow-') ? [{ id: a.id, outcome: 'ok', sha256: 'not-a-hash' }] : undefined),
      (a) => (a.id.startsWith('shadow-') ? [{ id: a.id, outcome: 'ok', unexpected: true }] : undefined),
      (a) => (a.id.startsWith('shadow-') ? [{ id: a.id, outcome: 'error', code: 'EACCES' }, { id: a.id, outcome: 'ok', sha256: COMMITTED }] : undefined),
      (a) => (a.id.startsWith('shadow-') ? [{ id: a.id, outcome: 'ok', sha256: COMMITTED }, { id: a.id, outcome: 'ok', sha256: COMMITTED }] : undefined),
    ];
    for (const answer of variants) {
      const w = await workflow(t, { probe: { answer } });
      assert.equal((await w.account()).report.verdict, 'BLOCKER');
      await w.recordAfter(afterOf(w));
      assert.equal((await w.finalize()).report.verdict, 'BLOCKER');
    }
  });

  test('a malformed success for an ordinary forbidden read, listing or write blocks the account check and its finalization', async (t) => {
    for (const [id, entry] of [
      ['repo-read-long', { id: 'repo-read-long', outcome: 'ok', sha256: 'not-a-hash' }],
      ['repo-list', { id: 'repo-list', outcome: 'ok', count: 'three' }],
      ['deny-root-write', { id: 'deny-root-write', outcome: 'ok', cleaned: 1 }],
    ] as const) {
      const w = await workflow(t, { probe: { answer: (a) => (a.id === id ? [entry] : undefined) } });
      const account = await w.account();
      assert.equal(account.report.verdict, 'BLOCKER', id);
      assert.deepEqual(statusOf(account.report, id), ['fail'], id);
      assert.deepEqual(statusOf(account.report, 'probe-malformed-results'), ['inconclusive'], id);
      await w.recordAfter(afterOf(w));
      const final = await w.finalize();
      assert.equal(final.report.verdict, 'BLOCKER', id);
      assert.deepEqual(statusOf(final.report, 'shadow-1-read'), ['pass'], `${id}: the denied shadow read can't offset it`);
    }
  });

  test('no relevant copy, from a complete inventory before and after: eligible for PASS', async (t) => {
    for (const copies of [[], [onD(4)], [copy(5, { repo: { path: copy(5).repo.path, exists: false, sddl: null }, control: { path: CONTROL, exists: false, sddl: null } })]]) {
      const w = await workflow(t, { before: inventory(copies, at(T0, -minutes(2))) });
      assert.equal((await w.account()).report.verdict, 'INCONCLUSIVE', 'no copies is no shortcut: the after-inventory is still required');
      assert.ok(!w.calls[0]!.payload!.attempts.some((a) => a.id.startsWith('shadow-')), 'nothing to attempt');
      assert.equal((await w.finalize()).report.verdict, 'INCONCLUSIVE', 'still no after-inventory');
      await w.recordAfter(afterOf(w, copies));
      assert.equal((await w.finalize()).report.verdict, 'PASS', JSON.stringify(copies.map((c) => c.volume)));
    }
  });

  test('a missing, expired, invalid, incomplete, foreign or unreadable before-inventory: the probe never starts and no record is written', async (t) => {
    const cases: [string, unknown, RegExp][] = [
      ['missing', null, /No shadow-copy inventory/],
      ['expired', inventory([copy(1)], at(T0, -minutes(31))), /older than the allowed age/],
      ['future', inventory([copy(1)], at(T0, minutes(1))), /in the future/],
      ['invalid', { schema: 2, computer: 'TESTPC' }, /malformed/],
      ['incomplete', inventory([copy(1)], at(T0, -minutes(1)), { enumeration: { wmiCount: 1, vssadminExitCode: 0, vssadminIds: [], vssadminNoItems: false } }), /incomplete/],
      ['other computer', inventory([copy(1)], at(T0, -minutes(1)), { computer: 'OTHERPC' }), /collected on OTHERPC/],
    ];
    for (const [label, before, message] of cases) {
      const w = await workflow(t, { before });
      await assert.rejects(w.account(), message, label);
      assert.deepEqual(w.calls, [], `${label}: nothing launched`);
      assert.ok(!existsSync(shadowPendingFile(w.local)), `${label}: no pending record`);
    }
    const unreadable = await workflow(t, { before: null });
    await mkdir(stateDir(unreadable.local));
    await writeFile(shadowInventoryFile(unreadable.local, 'before'), '{ not json');
    await assert.rejects(unreadable.account(), /not JSON/);
    assert.deepEqual(unreadable.calls, []);
  });

  test('a missing, invalid, stale, inconsistent, early or future-dated after-inventory is INCONCLUSIVE', async (t) => {
    const w = await workflow(t);
    await w.account();
    assert.equal((await w.finalize()).report.verdict, 'INCONCLUSIVE', 'missing');
    const end = w.clock.now;
    const cases: [string, unknown, Date?][] = [
      ['invalid', { schema: 2 }],
      ['stale', inventory([copy(1)], new Date(end + minutes(31)).toISOString()), new Date(end + minutes(40))],
      ['before the probe ended', inventory([copy(1)], new Date(end - minutes(1)).toISOString())],
      ['copy gone', afterOf(w, [])],
      ['copy added', afterOf(w, [copy(1), copy(2)])],
      ['other device', afterOf(w, [copy(1, { device: device(3) })])],
      ['other creation time', afterOf(w, [copy(1, { createdAt: '2026-11-10T00:00:00Z' })])],
      ['control gone', afterOf(w, [copy(1, { control: { path: CONTROL, exists: false, sddl: null } })])],
      ['other volume', inventory([copy(1)], new Date(end + minutes(2)).toISOString(), { repoVolumeName: D_VOLUME })],
      ['incomplete', inventory([copy(1)], new Date(end + minutes(2)).toISOString(), { enumeration: { wmiCount: 1, vssadminExitCode: 0, vssadminIds: [], vssadminNoItems: false } })],
      ['future-dated', afterOf(w, [copy(1)], minutes(5)), new Date(end + minutes(2))],
    ];
    for (const [label, after, now] of cases) {
      await w.recordAfter(after);
      const final = await w.finalize(now);
      assert.equal(final.report.verdict, 'INCONCLUSIVE', label);
      assert.deepEqual(statusOf(final.report, 'shadow-inventory-stable'), ['inconclusive'], label);
    }
    await writeFile(shadowInventoryFile(w.local, 'after'), 'garbage');
    assert.equal((await w.finalize()).report.verdict, 'INCONCLUSIVE', 'unreadable');
  });

  test('missing, unexpected or duplicate shadow results never PASS', async (t) => {
    const probes: FakeProbe[] = [
      { answer: (a) => (a.id.startsWith('shadow-') ? [] : undefined) },
      { extra: [{ id: 'shadow-99-read', outcome: 'error', code: 'EACCES' }] },
      { answer: (a) => (a.id.startsWith('shadow-') ? [denied(a.id), denied(a.id)] : undefined) },
      { answer: (a) => (a.id.startsWith('shadow-') ? [{ id: a.id, outcome: 'error', code: 'ENOENT' }] : undefined) },
    ];
    for (const probe of probes) {
      const w = await workflow(t, { probe });
      await w.account();
      await w.recordAfter(afterOf(w));
      assert.equal((await w.finalize()).report.verdict, 'INCONCLUSIVE', JSON.stringify(probe));
    }
  });

  test('a failure of the ordinary filesystem checks is kept in the final result', async (t) => {
    const w = await workflow(t, { probe: { answer: (a) => (a.id === 'repo-read-long' ? [{ id: a.id, outcome: 'ok', sha256: 'e'.repeat(64) }] : undefined) } });
    await w.account();
    await w.recordAfter(afterOf(w));
    const final = await w.finalize();
    assert.equal(final.report.verdict, 'BLOCKER');
    assert.deepEqual(statusOf(final.report, 'repo-read-long'), ['fail']);
    assert.deepEqual(statusOf(final.report, 'shadow-1-read'), ['pass'], 'the shadow part passing does not hide it');
  });

  test('a wrong process identity is a BLOCKER: in the probe report, or refused at the launch handshake', async (t) => {
    const developer = { ...EVAL_IDENTITY, username: 'dev', sid: null, home: homedir() };
    for (const probe of [{ identity: developer }, { throws: new RestrictedLaunchError('runs as the developer', true) }] as FakeProbe[]) {
      const w = await workflow(t, { probe });
      await w.account();
      await w.recordAfter(afterOf(w));
      assert.equal((await w.finalize()).report.verdict, 'BLOCKER');
    }
  });

  test('a failed or missing process cleanup never PASSes', async (t) => {
    for (const [teardown, verdict] of [['{"selected":2,"killed":1,"remaining":1}', 'BLOCKER'], ['', 'INCONCLUSIVE'], [new RestrictedLaunchError('no handshake', false), 'INCONCLUSIVE']] as const) {
      const w = await workflow(t, { probe: { teardown } });
      await w.account();
      await w.recordAfter(afterOf(w));
      assert.equal((await w.finalize()).report.verdict, verdict, String(teardown));
    }
  });

  test('no probe report at all is INCONCLUSIVE for every part', async (t) => {
    const w = await workflow(t, { probe: { stdout: 'nothing useful' } });
    await w.account();
    await w.recordAfter(afterOf(w));
    const final = await w.finalize();
    assert.equal(final.report.verdict, 'INCONCLUSIVE');
    assert.deepEqual(statusOf(final.report, 'shadow-1-read'), ['inconclusive']);
  });
});

describe('section 7: the pending record', () => {
  test('a missing, edited, truncated or malformed record is rejected (no verdict at all)', async (t) => {
    const w = await workflow(t);
    await assert.rejects(w.finalize(), /No pending account check/);
    await w.account();
    await w.recordAfter(afterOf(w));
    const file = shadowPendingFile(w.local);
    const original = await readFile(file, 'utf8');
    const sealed = JSON.parse(original) as { record: ShadowPending; sha256: string };
    const edits: [string, string][] = [
      ['edited result', JSON.stringify({ ...sealed, record: { ...sealed.record, results: [denied('shadow-1-read'), denied('shadow-2-read')] } })],
      ['edited verdict', JSON.stringify({ ...sealed, record: { ...sealed.record, base: { ...sealed.record.base, verdict: 'BLOCKER' } } })],
      ['truncated', original.slice(0, original.length / 2)],
      ['no seal', JSON.stringify(sealed.record)],
      ['malformed but sealed', JSON.stringify({ record: { ...sealed.record, schema: 1 }, sha256: sha256Json({ ...sealed.record, schema: 1 }) })],
      ['resealed with a base report that does not add up', (() => { const r = { ...sealed.record, base: { ...sealed.record.base, verdict: 'PASS' as const, items: [{ id: 'teardown', status: 'fail' as const, detail: 'x' }] } }; return JSON.stringify({ record: r, sha256: sha256Json(r) }); })()],
      ['resealed for another computer', (() => { const r = { ...sealed.record, computer: 'OTHERPC' }; return JSON.stringify({ record: r, sha256: sha256Json(r) }); })()],
      ['resealed with another inventory than its hash', (() => { const r = { ...sealed.record, before: inventory([copy(1)], at(T0, -minutes(9))) }; return JSON.stringify({ record: r, sha256: sha256Json(r) }); })()],
    ];
    for (const [label, text] of edits) {
      await writeFile(file, text);
      await assert.rejects(w.finalize(), /rejected|No pending|can't be used/, label);
    }
    await writeFile(file, original);
    assert.equal((await w.finalize()).report.verdict, 'PASS', 'the untouched record still finalizes');
  });

  test('a record planned from another inventory than the one recorded now is rejected', async (t) => {
    const w = await workflow(t);
    await w.account();
    await w.recordAfter(afterOf(w));
    await writePrivateJson(w.local, shadowInventoryFile(w.local, 'before'), inventory([copy(1)], at(T0, -minutes(3))));
    await assert.rejects(w.finalize(), /planned from another inventory/);
    await (await import('node:fs/promises')).unlink(shadowInventoryFile(w.local, 'before'));
    await assert.rejects(w.finalize(), /planned from another inventory/);
  });

  test("a second account check can't overwrite a pending record: it refuses before anything starts, until the record is discarded", async (t) => {
    const w = await workflow(t);
    const first = await w.account();
    const file = shadowPendingFile(w.local);
    const original = await readFile(file, 'utf8');
    const launched = w.calls.length;
    await assert.rejects(w.account(), /A pending account check exists/);
    assert.equal(w.calls.length, launched, 'nothing launched');
    assert.equal(await readFile(file, 'utf8'), original, 'the record is unchanged');
    await assert.rejects(createPrivateJson(w.local, file, { other: true }), (e: NodeJS.ErrnoException) => e.code === 'EEXIST');
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await discard(w, first.runId!), { removed: true, runId: first.runId });
    assert.deepEqual(await discard(w, first.runId!), { removed: false, runId: null });
    const second = await w.account();
    assert.notEqual(second.runId, first.runId);
  });

  test('discard removes only the exact expected record: the named run, intact, of this computer and repo; anything else stays for review', async (t) => {
    const w = await workflow(t);
    const run = await w.account();
    const file = shadowPendingFile(w.local);
    const original = await readFile(file, 'utf8');
    const other = '1'.repeat(32);
    await assert.rejects(discard(w, ''), /Name the pending run/);
    await assert.rejects(discard(w, '..\\eval-vss-before'), /Name the pending run/);
    await assert.rejects(discard(w, other), new RegExp(`is run ${run.runId}, not ${other}\\. Nothing was removed`));
    await assert.rejects(discardShadowPending({ computer: 'OTHERPC', localAppData: w.local, runId: run.runId! }), /another computer or repo\. Nothing was removed/);
    assert.equal(await readFile(file, 'utf8'), original);

    const sealed = JSON.parse(original) as { record: ShadowPending; sha256: string };
    for (const edited of [JSON.stringify({ ...sealed, record: { ...sealed.record, account: 'someone' } }), original.slice(0, 50), JSON.stringify({ record: { ...sealed.record, schema: 1 }, sha256: sha256Json({ ...sealed.record, schema: 1 }) })]) {
      await writeFile(file, edited);
      await assert.rejects(discard(w, run.runId!), /can't be identified.* Nothing was removed; review %LOCALAPPDATA%\\test-detective\\eval-shadow-pending\.json/);
      assert.equal(await readFile(file, 'utf8'), edited, 'left in place');
    }
    await writeFile(file, original);

    const elsewhere = path.join(await tempDir(t, 'td-shadow-other-'), 'second-name.json');
    await link(file, elsewhere);
    await assert.rejects(discard(w, run.runId!), /another name \(a hard link\)/);
    assert.ok(existsSync(file) && existsSync(elsewhere));
    await (await import('node:fs/promises')).unlink(elsewhere);

    const release = await acquireSandboxLock(w.local);
    await assert.rejects(discard(w, run.runId!), /Another sandbox session/);
    await release();
    assert.equal(await readFile(file, 'utf8'), original, 'not removed while another session holds the lock');

    const unrelated = path.join(stateDir(w.local), 'notes.json');
    await writeFile(unrelated, '{}');
    await w.recordAfter(afterOf(w));
    const keep = [unrelated, shadowInventoryFile(w.local, 'before'), shadowInventoryFile(w.local, 'after')];
    const kept = await Promise.all(keep.map((f) => readFile(f, 'utf8')));
    assert.deepEqual(await discard(w, run.runId!), { removed: true, runId: run.runId });
    assert.ok(!existsSync(file));
    assert.deepEqual(await Promise.all(keep.map((f) => readFile(f, 'utf8'))), kept, 'only the record file was removed');
  });

  test('a record create interrupted between link and unlink is recoverable: refused everywhere, then discarded by its run ID', async (t) => {
    const w = await workflow(t);
    const run = await w.account();
    const file = shadowPendingFile(w.local);
    await link(file, `${file}.tmp`);
    await assert.rejects(w.finalize(), /another name \(a hard link\)/);
    await assert.rejects(w.account(), /A pending account check exists/);
    const lone = `${shadowInventoryFile(w.local, 'after')}.tmp`;
    await writeFile(lone, 'x');
    assert.equal(await dropInterruptedCreate(w.local, shadowInventoryFile(w.local, 'after')), false, 'a temp file that is not the same file stays');
    assert.ok(existsSync(lone));
    assert.deepEqual(await discard(w, run.runId!), { removed: true, runId: run.runId });
    assert.ok(!existsSync(file) && !existsSync(`${file}.tmp`));
    assert.notEqual((await w.account()).runId, run.runId);
  });

  test("finalization is read-only and repeatable, and never mixes runs: a later run's after-inventory doesn't fit an earlier run", async (t) => {
    const w = await workflow(t);
    await w.account();
    await w.recordAfter(afterOf(w));
    const files = async () => Promise.all([shadowPendingFile(w.local), shadowInventoryFile(w.local, 'before'), shadowInventoryFile(w.local, 'after')].map((f) => readFile(f, 'utf8')));
    const snapshot = await files();
    const a = await w.finalize();
    const b = await w.finalize();
    assert.deepEqual(a, b);
    assert.deepEqual(await files(), snapshot, 'nothing changed');
    await w.recordAfter(inventory([copy(1)], new Date(w.clock.now + minutes(45)).toISOString()));
    assert.equal((await w.finalize(new Date(w.clock.now + minutes(50)))).report.verdict, 'INCONCLUSIVE', 'an inventory from much later is not this run’s');
  });

  test('the record binds the run: ID, computer, repo, account, inventory hash, exact attempts, outcomes and timing; no file contents', async (t) => {
    const w = await workflow(t);
    const run = await w.account();
    const { record } = JSON.parse(await readFile(shadowPendingFile(w.local), 'utf8')) as { record: ShadowPending };
    assert.equal(record.runId, run.runId);
    assert.deepEqual([record.computer, record.repoRoot, record.account], ['TESTPC', REPO, 'td-eval']);
    assert.equal(record.beforeSha256, sha256Json(record.before));
    assert.deepEqual(record.attempts, [{ id: 'shadow-1-read', path: `${device(1)}\\${CONTROL}` }]);
    assert.deepEqual(record.results, [denied('shadow-1-read')]);
    assert.deepEqual([record.probeStartedAt, record.probeEndedAt], [T0.toISOString(), new Date(T0.getTime() + minutes(4)).toISOString()]);
    assert.deepEqual(record.committedHashes, [COMMITTED]);
    assert.ok(record.results.every((r) => Object.keys(r).every((k) => ['id', 'outcome', 'code', 'sha256'].includes(k))), 'outcomes and hashes only');
  });

  test('the attempts sent must equal the plan rebuilt from the inventory, ID and path', () => {
    const before = inventory([copy(1)], at(START, -minutes(10)));
    const record = (attempts: ShadowPending['attempts']): ShadowPending => ({ schema: 2, runId: '0'.repeat(32), ...OPTIONS, account: 'td-eval', probeStartedAt: START.toISOString(), probeEndedAt: END.toISOString(), before, beforeSha256: sha256Json(before), attempts, results: [denied('shadow-1-read')], committedHashes: [], base: reportOf([]) });
    const after = inventory([copy(1)], at(END, minutes(2)));
    assert.equal(finalizeShadow(record([{ id: 'shadow-1-read', path: `${device(1)}\\${CONTROL}` }]), after, OPTIONS).report.verdict, 'PASS');
    for (const attempts of [[], [{ id: 'shadow-1-read', path: `${device(1)}\\GIT\\x.json` }], [{ id: 'shadow-2-read', path: `${device(1)}\\${CONTROL}` }], [{ id: 'shadow-1-read', path: `${device(1)}\\${CONTROL}` }, { id: 'shadow-1-read', path: `${device(1)}\\${CONTROL}` }]]) {
      assert.equal(finalizeShadow(record(attempts), after, OPTIONS).report.verdict, 'INCONCLUSIVE', JSON.stringify(attempts));
    }
  });
});

describe('section 7: private state files', () => {
  test('fixed names directly in %LOCALAPPDATA%\\test-detective, never in the runtime; the runtime allowlist never names them', () => {
    const local = 'C:\\Users\\dev\\AppData\\Local';
    for (const file of [shadowInventoryFile(local, 'before'), shadowInventoryFile(local, 'after'), shadowPendingFile(local)]) {
      assert.equal(path.win32.dirname(file), stateDir(local));
      assert.ok(!file.toLowerCase().startsWith(runtimeDir(DEFAULT_SANDBOX).toLowerCase()));
    }
    assert.doesNotMatch(readFileSync(path.join(SANDBOX_SRC, 'runtime.ts'), 'utf8'), /eval-vss|shadow-pending|shadowInventoryFile|shadowPendingFile|private-state|LOCALAPPDATA/i);
  });

  test('a linked state folder, a hard-linked file, a file elsewhere or an odd LOCALAPPDATA is refused', async (t) => {
    const real = await tempDir(t, 'td-shadow-real-');
    await mkdir(stateDir(real));
    const linked = await tempDir(t, 'td-shadow-linked-');
    await symlink(stateDir(real), stateDir(linked), 'junction');
    assert.match((await readPrivateJson(linked, shadowInventoryFile(linked, 'before')) as { problem: string }).problem, /is a link/);
    await assert.rejects(writePrivateJson(linked, shadowInventoryFile(linked, 'before'), {}), /is a link/);

    const file = shadowInventoryFile(real, 'before');
    await writeFile(path.join(real, 'elsewhere.json'), '{}');
    await link(path.join(real, 'elsewhere.json'), file);
    assert.match((await readPrivateJson(real, file) as { problem: string }).problem, /another name/);

    await assert.rejects(checkPrivatePaths(real, [path.join(real, 'x.json')], { create: false }), /not directly in the private state folder/);
    for (const odd of ['relative\\dir', 'C:\\Users\\..\\x', 'C:/Users/dev', '\\\\server\\share']) await assert.rejects(checkPrivatePaths(odd, [], { create: false }), /not a plain absolute drive path/, odd);
  });

  test('messages name state files relative to %LOCALAPPDATA%, never by the profile path', async (t) => {
    const w = await workflow(t, { before: null });
    await assert.rejects(w.account(), (e: Error) => e.message.includes('%LOCALAPPDATA%\\test-detective\\eval-vss-before.json') && !e.message.includes(w.local));
    await assert.rejects(w.finalize(), (e: Error) => !e.message.includes(w.local));
  });
});

describe('section 6: malformed successes (one rule for every forbidden attempt)', () => {
  test('a malformed success is a BLOCKER for a shadow attempt and for an ordinary forbidden attempt alike', () => {
    const identity: ProbeIdentity = { ...EVAL_IDENTITY };
    const line = JSON.stringify({ identity, results: [{ id: 'shadow-1-read', outcome: 'ok', sha256: 'NOT-A-HASH' }, { id: 'repo-read-long', outcome: 'ok', sha256: 'NOT-A-HASH' }] });
    const probe = parseProbeOutput(line)!;
    assert.deepEqual(probe.invalidOkIds, ['shadow-1-read', 'repo-read-long']);
    assert.deepEqual(withoutShadowResults(probe).invalidOkIds, ['repo-read-long'], 'the shadow claim is judged only by the shadow checker');
    const base = evaluateCheck([{ id: 'repo-read-long', op: 'read', path: 'C:\\x', expect: 'deny', variant: 'long' }], withoutShadowResults(probe), { account: 'td-eval', developer: { username: 'dev', home: 'C:\\Users\\dev', sid: null } }, { selected: 0, killed: 0, remaining: 0 });
    assert.equal(base.verdict, 'BLOCKER', 'ordinary attempt: a reported forbidden success blocks, malformed or not');
    assert.deepEqual(statusOf(base, 'repo-read-long'), ['fail']);
    assert.deepEqual(statusOf(base, 'probe-malformed-results'), ['inconclusive'], 'the malformed diagnostic stays');
    const before = inventory([copy(1)], at(START, -minutes(10)));
    const record: ShadowPending = { schema: 2, runId: '0'.repeat(32), ...OPTIONS, account: 'td-eval', probeStartedAt: START.toISOString(), probeEndedAt: END.toISOString(), before, beforeSha256: sha256Json(before), attempts: [{ id: 'shadow-1-read', path: `${device(1)}\\${CONTROL}` }], results: shadowResultsOf(probe), committedHashes: [], base };
    const final = finalizeShadow(record, inventory([copy(1)], at(END, minutes(2))), OPTIONS).report;
    assert.equal(final.verdict, 'BLOCKER');
    assert.deepEqual(statusOf(final, 'shadow-1-read'), ['fail']);
  });
});

describe('verdict aggregation', () => {
  test('a shadow item reusing a base ID keeps both and adds an inconclusive collision item; the base verdict is never improved', () => {
    const shadow: CheckItem[] = [{ id: 'shadow-1-read', status: 'pass', detail: 'denied' }];
    const combined = combineWithShadow(reportOf([{ id: 'shadow-1-read', status: 'fail', detail: 'a base result' }]), shadow);
    assert.deepEqual(statusOf(combined, 'shadow-1-read'), ['fail', 'pass']);
    assert.deepEqual(statusOf(combined, 'shadow-id-collision'), ['inconclusive']);
    assert.equal(combined.verdict, 'BLOCKER');
    assert.equal(combineWithShadow(reportOf([{ id: 'shadow-1-read', status: 'pass', detail: 'x' }]), shadow).verdict, 'INCONCLUSIVE');
    assert.equal(combineWithShadow({ ...reportOf([]), verdict: 'BLOCKER' }, []).verdict, 'BLOCKER');
  });

  test('no check label can produce a shadow- ID', () => {
    for (const label of ['shadow', 'shadow-1']) assert.throws(() => plannedAttemptIds({ protectedParents: [{ label, dir: 'C:\\x' }], writeTargets: [], listTargets: [] }), /Invalid check labels/);
    assert.doesNotThrow(() => plannedAttemptIds({ protectedParents: [], writeTargets: [], listTargets: [{ label: 'shadowy', dir: 'C:\\x' }] }));
  });
});

describe('static guarantees', () => {
  const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]!);

  test('finalization and discarding launch nothing: no spawn, exec, launcher, probe, git or SDK', () => {
    const source = readFileSync(path.join(SANDBOX_SRC, 'run-check.ts'), 'utf8');
    const body = (name: string) => new RegExp(`(?:async function ${name}[\\s\\S]*?\\n}\\n)`).exec(source)![0];
    for (const name of ['loadPending', 'finalizeShadowCheck', 'discardShadowPending']) {
      assert.doesNotMatch(body(name), /spawn|exec|launch|runScript|run\(|committedControlHashes|prepareCheck|icacls|probe\.mjs|teardown\.mjs/, name);
    }
  });

  test('shadow-record.ts and private-state.ts reach only Node built-ins and config.ts (they run elevated)', () => {
    assert.deepEqual(importsOf(path.join(SANDBOX_SRC, 'shadow-record.ts')).sort(), ['./config.ts', './private-state.ts']);
    assert.deepEqual(importsOf(path.join(SANDBOX_SRC, 'private-state.ts')).filter((s) => !s.startsWith('node:')), ['./config.ts']);
    assert.ok(importsOf(path.join(SANDBOX_SRC, 'config.ts')).every((s) => s.startsWith('node:')));
  });
});

describe('shadow-record.ts', () => {
  const entry = path.join(SANDBOX_SRC, 'shadow-record.ts');
  const record = (local: string, phase: string, stdin: string) => spawnSync(process.execPath, [entry, phase], { input: stdin, encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, LOCALAPPDATA: local } });
  const BEFORE = inventory([copy(1)], at(T0, -minutes(10)));

  test('records exactly one TD-VSS-INVENTORY line atomically into the fixed file; anything else records nothing', async (t) => {
    const local = await tempDir(t, 'td-shadow-record-');
    const line = `TD-VSS-INVENTORY ${JSON.stringify(BEFORE)}`;
    const ok = record(local, 'before', `== vssadmin list shadows\r\nsome output\r\n${line}\r\n`);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(await readFile(shadowInventoryFile(local, 'before'), 'utf8')), BEFORE);
    assert.ok(!existsSync(`${shadowInventoryFile(local, 'before')}.tmp`), 'no temp file left');
    assert.ok(!(ok.stdout + ok.stderr).toLowerCase().includes(local.toLowerCase()), 'the message does not print the profile path');

    for (const [phase, input] of [['after', `${line}\n${line}\n`], ['after', 'no inventory'], ['after', 'TD-VSS-INVENTORY {'], ['after', 'TD-VSS-INVENTORY {"schema":1}'], ['after', 'TD-VSS-INVENTORY [2]'], ['middle', line], ['C:\\elsewhere', line]] as const) {
      assert.equal(record(local, phase, input).status, 1, `${phase}: ${input.slice(0, 30)}`);
    }
    assert.ok(!existsSync(shadowInventoryFile(local, 'after')), 'nothing was recorded');
  });

  test('refuses a linked state folder', async (t) => {
    const real = await tempDir(t, 'td-shadow-real-');
    await mkdir(stateDir(real));
    const local = await tempDir(t, 'td-shadow-link-');
    await symlink(stateDir(real), stateDir(local), 'junction');
    const r = record(local, 'before', `TD-VSS-INVENTORY ${JSON.stringify(BEFORE)}\n`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is a link/);
    assert.ok(!existsSync(shadowInventoryFile(real, 'before')));
  });
});
