import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { CliArgs } from '../../agent/args.ts';
import type { QueryFn } from '../../agent/run.ts';
import { args } from '../../agent/test/helpers.ts';
import { EVAL_MAX_BUDGET_USD, LiveRefusal, parseLiveArgs, runLiveEvaluation } from '../live.ts';
import type { LiveDeps, LiveResult } from '../live.ts';
import { loadRunManifest, OUTCOME_FILE, RESULT_FILE, RunOutcome, SCORE_FILE, ScoreConflictError, scoreRun, SUMMARY_JSON, SUMMARY_MD, TRANSCRIPT_FILE } from '../runs.ts';
import { SCENARIOS_DIR } from '../scenarios.ts';
import { sha256 } from '../snapshots.ts';
import { CONFIG_FILES } from '../workspace.ts';
import { goldenSnapshot, REPO_ROOT, VARIANTS, variantQuery, writeRunManifest } from './golden.ts';
import type { Variant } from './golden.ts';

// The live adapter, fully offline: every session is a fake SDK stream (golden.ts variants) against
// a real workspace made from a fake-Playwright S02 snapshot. No test can reach a model: `query` is
// always injected, and the CLI tests only use arguments that are refused before any session.

const base = await mkdtemp(path.join(tmpdir(), 'td-live-'));
after(() => rm(base, { recursive: true, force: true }));
const { snapshot, snapshotsRoot } = await goldenSnapshot(path.join(base, 'fixture'));
const truthSha = sha256(await readFile(path.join(SCENARIOS_DIR, 'S02', 'truth.json')));

type Setup = { deps: LiveDeps; calls: { n: number }; runsRoot: string; workParent: string };

async function setup(t: TestContext, overrides: Partial<LiveDeps> & { variant?: Variant; during?: (cwd: string) => Promise<void> } = {}): Promise<Setup> {
  const dir = await mkdtemp(path.join(base, 'case-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = { n: 0 };
  const runsRoot = path.join(dir, 'runs');
  const workParent = path.join(dir, 'work');
  await cp(path.join(base, 'fixture', 'snapshots'), path.join(dir, 'snapshots'), { recursive: true, preserveTimestamps: true });
  const { variant, during, ...rest } = overrides;
  const deps: LiveDeps = {
    repoRoot: REPO_ROOT,
    snapshotsRoot: path.join(dir, 'snapshots'),
    runsRoot,
    workParent,
    query: variantQuery(variant ?? VARIANTS.correct!, 'S02', calls, during),
    env: {},
    repoState: async () => 'unchanged',
    sdkVersion: '0.3.302',
    now: () => new Date('2026-10-21T12:00:00.000Z'),
    ...rest,
  };
  await mkdir(workParent, { recursive: true });
  return { deps, calls, runsRoot, workParent };
}

const request = (overrides: Partial<CliArgs> = {}) => ({ scenarioId: 'S02', args: args({ maxBudgetUsd: 0.5, ...overrides }), runDir: null });

async function saved(r: LiveResult) {
  const dir = path.join(r.runDir, r.evalId);
  const read = (f: string) => readFile(path.join(dir, f), 'utf8').catch(() => null);
  const transcript = await read(TRANSCRIPT_FILE);
  return {
    outcome: RunOutcome.parse(JSON.parse((await read(OUTCOME_FILE))!)),
    result: await read(RESULT_FILE),
    transcript: transcript === null ? null : transcript.split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    score: await read(SCORE_FILE),
  };
}

async function leftovers(workParent: string): Promise<string[]> {
  return readdir(workParent).catch(() => []);
}

describe('successful live evaluation (fake SDK stream)', () => {
  test('saves the run, records preflight metadata, scores and reports it, and cleans up', async (t) => {
    const s = await setup(t);
    const r = await runLiveEvaluation(request(), s.deps);
    assert.equal(s.calls.n, 1, 'exactly one session');
    assert.equal(r.evalId, 'S02-01');
    assert.equal((await loadRunManifest(r.runDir)).source, 'scorer_validation', 'an injected query never produces a live run');
    assert.match(path.basename(r.runDir), /^validation-S02-/);
    assert.match(r.summaryMarkdown!, /NOT measurements of agent performance/);

    const { outcome, result, transcript, score } = await saved(r);
    assert.equal(outcome.harness.status, 'session_finished');
    assert.equal(r.result?.runStatus, 'completed');
    assert.ok(result && score);
    assert.equal(outcome.preflight.truthSha256, truthSha, 'truth hash captured before the session');
    assert.equal(outcome.preflight.skillSha256, sha256(await readFile(path.join(REPO_ROOT, ...CONFIG_FILES[0].split('/')))));
    assert.equal(outcome.preflight.settingsSha256, sha256(await readFile(path.join(REPO_ROOT, ...CONFIG_FILES[1].split('/')))));
    assert.equal(outcome.preflight.sdkVersion, '0.3.302');
    assert.equal(outcome.snapshot?.manifestSha256, sha256(await readFile(path.join(snapshot.dir, 'manifest.json'))));
    assert.equal(outcome.snapshot?.reportFingerprint, snapshot.manifest.reportFingerprint);
    const session = outcome.preflight.session!;
    assert.equal(session.permissionMode, 'dontAsk');
    assert.equal(session.maxBudgetUsd, 0.5);
    assert.equal(session.maxTurns, 30);
    assert.ok(!('env' in session) && !('abortController' in session));
    assert.deepEqual(outcome.configDifferences?.options.map((d) => d.path), ['cwd', 'mcpServers.test-detective.env', 'settings.permissions.deny']);
    assert.deepEqual(outcome.workspace?.integrityAfter, []);
    assert.deepEqual(outcome.repo, { unchanged: true });
    assert.deepEqual({ ...outcome.cleanup, elapsedMs: undefined }, { removed: true, error: null, attempts: 1, elapsedMs: undefined, transient: [] });

    assert.equal(r.score?.category, 'scored', r.score?.reasons.join('; '));
    assert.equal(r.score?.acceptance.status, 'accepted');
    assert.ok(await stat(path.join(r.runDir, SUMMARY_JSON)));
    assert.match(await readFile(path.join(r.runDir, SUMMARY_MD), 'utf8'), /Fully accepted diagnoses:\*\* 1\/1/);
    assert.equal(r.transcriptMessages, transcript!.length);
    assert.deepEqual(await leftovers(s.workParent), [], 'workspace removed');
  });

  test('records usage: tokens, duration, estimated cost and permission denials', async (t) => {
    const r = await runLiveEvaluation(request(), (await setup(t)).deps);
    assert.deepEqual(
      { in: r.result!.usage.inputTokens, out: r.result!.usage.outputTokens, cost: r.result!.usage.estimatedUsageCostUsd, turns: r.result!.usage.numTurns },
      { in: 1500, out: 200, cost: 0.0512, turns: 7 },
    );
    assert.equal(r.score?.metrics.permissionDenials, 0);
    assert.equal(typeof r.result!.usage.durationMs, 'number');
  });

  test('captures the raw stream: every message and full tool inputs, in order', async (t) => {
    const r = await runLiveEvaluation(request(), (await setup(t)).deps);
    const { transcript } = await saved(r);
    assert.deepEqual(transcript!.map((m: { type: string }) => m.type), ['system', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'result']);
    const read = transcript!.find((m: any) => m.type === 'assistant' && m.message.content[0].name === 'Read');
    assert.ok(path.isAbsolute(read.message.content[0].input.file_path), 'full, untruncated tool input');
    assert.equal(transcript![0].cwd, (await saved(r)).outcome.workspace!.root, 'the session ran in the workspace');
  });

  test('an incorrect classification is saved and scored as such', async (t) => {
    const r = await runLiveEvaluation(request(), (await setup(t, { variant: VARIANTS.wrongClassification })).deps);
    assert.equal(r.score?.classification.tests[0]?.verdict, 'incorrect');
    assert.equal(r.score?.classification.tests[0]?.highConfidenceIncorrect, true);
    assert.equal(r.score?.acceptance.status, 'not_accepted');
  });

  test('a further invocation with --run adds the next attempt to the same run', async (t) => {
    const s = await setup(t);
    const first = await runLiveEvaluation(request(), s.deps);
    const second = await runLiveEvaluation({ ...request(), runDir: first.runDir }, s.deps);
    assert.equal(second.evalId, 'S02-02');
    assert.equal(second.runDir, first.runDir);
    assert.equal(s.calls.n, 2, 'one session per invocation');
    assert.match(second.summaryMarkdown!, /\*\*2 evaluation\(s\) attempted\.\*\*/);
  });
});

describe('failed and interrupted sessions are preserved', () => {
  test('SDK error: saved with its partial transcript, never retried', async (t) => {
    const s = await setup(t, { variant: VARIANTS.sessionError });
    const r = await runLiveEvaluation(request(), s.deps);
    assert.equal(s.calls.n, 1, 'no retry');
    assert.equal(r.result?.runStatus, 'session_error');
    assert.equal(r.score?.category, 'session_error');
    const { transcript } = await saved(r);
    assert.equal(transcript!.at(-1).subtype, 'error_during_execution');
    assert.deepEqual(await readdir(r.runDir).then((e) => e.filter((n) => /^S\d{2}-\d{2}$/.test(n))), ['S02-01'], 'no second attempt');
  });

  test('authentication refusal before the session: no SDK call at all', async (t) => {
    const s = await setup(t, { env: { ANTHROPIC_API_KEY: 'not-a-real-key' } });
    const r = await runLiveEvaluation(request(), s.deps);
    assert.equal(s.calls.n, 0, 'subscription preflight refused before any query');
    assert.equal(r.result?.runStatus, 'auth_refused');
    assert.equal(r.score?.category, 'session_error');
    assert.deepEqual((await saved(r)).transcript, []);
    assert.ok(!JSON.stringify(await saved(r)).includes('not-a-real-key'), 'credential values are never saved');
  });

  test('authentication refusal reported by the session: aborted, recorded, not switched', async (t) => {
    const s = await setup(t, { variant: VARIANTS.authRefused });
    const r = await runLiveEvaluation(request(), s.deps);
    assert.equal(r.result?.runStatus, 'auth_refused');
    assert.equal(r.result?.observed.auth.mode, 'subscription');
    assert.equal(s.calls.n, 1);
  });

  test('missing Skill invocation and missing MCP calls are unverified', async (t) => {
    assert.equal((await runLiveEvaluation(request(), (await setup(t, { variant: VARIANTS.missingSkill })).deps)).score?.category, 'unverified');
    assert.equal((await runLiveEvaluation(request(), (await setup(t, { variant: VARIANTS.missingMcp })).deps)).score?.category, 'unverified');
  });

  test('timeout: the partial transcript is kept and the workspace removed', async (t) => {
    const s = await setup(t, { variant: VARIANTS.timeout });
    const r = await runLiveEvaluation(request({ timeoutMs: 50 }), s.deps);
    assert.equal(r.result?.runStatus, 'timeout');
    assert.equal(r.score?.category, 'timeout');
    assert.ok((await saved(r)).transcript!.length >= 3, 'messages before the hang are saved');
    assert.equal(s.calls.n, 1);
    assert.deepEqual(await leftovers(s.workParent), []);
  });

  test('cancellation (Ctrl+C): interrupted, partial transcript kept, workspace removed', async (t) => {
    const interrupt = new AbortController();
    const s = await setup(t, { variant: VARIANTS.timeout, signal: interrupt.signal, during: async () => interrupt.abort() });
    const r = await runLiveEvaluation(request(), s.deps);
    assert.equal(r.result?.runStatus, 'interrupted');
    assert.equal(r.score?.category, 'session_error');
    assert.ok((await saved(r)).transcript!.length >= 1);
    assert.deepEqual(await leftovers(s.workParent), []);
  });

  test('a query that throws is a session error; the run is saved and cleaned up', async (t) => {
    const calls = { n: 0 };
    const throwing: QueryFn = () => {
      calls.n++;
      throw new Error('spawn failed');
    };
    const s = await setup(t, { query: throwing });
    const r = await runLiveEvaluation(request(), s.deps);
    assert.equal(calls.n, 1);
    assert.equal(r.result?.runStatus, 'session_error');
    assert.match(r.result!.issues.join(' '), /spawn failed/);
    assert.deepEqual(await leftovers(s.workParent), []);
  });

  test('a harness failure after the session is recorded; the result and transcript are kept, the workspace removed', async (t) => {
    let n = 0;
    const s = await setup(t, {
      repoState: async () => {
        if (++n === 2) throw new Error('git unavailable');
        return 'unchanged';
      },
    });
    const r = await runLiveEvaluation(request(), s.deps);
    const { outcome, result, transcript } = await saved(r);
    assert.equal(outcome.harness.status, 'harness_error');
    assert.match(outcome.harness.detail!, /after the session: git unavailable/);
    assert.ok(result && transcript!.length > 0);
    assert.equal(r.score?.category, 'invalid_setup');
    assert.deepEqual(await leftovers(s.workParent), []);
  });
});

describe('integrity', () => {
  test('a tampered snapshot is refused before any session; the refusal is saved', async (t) => {
    const s = await setup(t);
    await writeFile(path.join(s.deps.snapshotsRoot!, 'S02', 'files', 'tests', 'ui', 'login.spec.ts'), 'changed');
    const r = await runLiveEvaluation(request(), s.deps);
    assert.equal(s.calls.n, 0);
    const { outcome, result, transcript } = await saved(r);
    assert.equal(outcome.harness.status, 'setup_failed');
    assert.match(outcome.harness.detail!, /hash mismatch: tests\/ui\/login\.spec\.ts/);
    assert.equal(outcome.preflight.truthSha256, truthSha, 'what was captured before the failure is kept');
    assert.equal(result, null);
    assert.equal(transcript, null);
    assert.equal(r.score?.category, 'invalid_setup');
    assert.deepEqual(await leftovers(s.workParent), []);
  });

  test('a missing snapshot is refused before any session', async (t) => {
    const s = await setup(t);
    await rm(path.join(s.deps.snapshotsRoot!, 'S02'), { recursive: true });
    const r = await runLiveEvaluation(request(), s.deps);
    assert.equal(s.calls.n, 0);
    assert.equal(r.outcome.harness.status, 'setup_failed');
    assert.match(r.outcome.harness.detail!, /No readable snapshot manifest/);
  });

  test('a workspace changed during the session is a confirmed violation, and is still removed', async (t) => {
    const s = await setup(t, { during: async (cwd) => writeFile(path.join(cwd, 'tests', 'ui', 'login.spec.ts'), 'edited by the agent') });
    const r = await runLiveEvaluation(request(), s.deps);
    assert.deepEqual(r.outcome.workspace?.integrityAfter, ['hash mismatch: tests/ui/login.spec.ts']);
    assert.equal(r.score?.category, 'confirmed_violation');
    assert.deepEqual(await leftovers(s.workParent), []);
  });

  test('a repository change during the session is a confirmed violation', async (t) => {
    let n = 0;
    const s = await setup(t, { repoState: async () => (++n === 1 ? 'before' : 'after') });
    const r = await runLiveEvaluation(request(), s.deps);
    assert.deepEqual(r.outcome.repo, { unchanged: false });
    assert.equal(r.score?.category, 'confirmed_violation');
  });

  test('ground truth changed after the run: re-scoring is refused, and forced rescoring marks it invalid', async (t) => {
    const s = await setup(t);
    const r = await runLiveEvaluation(request(), s.deps);
    const scenariosRoot = await mkdtemp(path.join(base, 'truth-'));
    t.after(() => rm(scenariosRoot, { recursive: true, force: true }));
    await cp(SCENARIOS_DIR, scenariosRoot, { recursive: true });
    const file = path.join(scenariosRoot, 'S02', 'truth.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"description": "', '"description": "Edited. '));
    await assert.rejects(scoreRun(r.runDir, { snapshotsRoot: s.deps.snapshotsRoot, scenariosRoot }), ScoreConflictError);
    const { records } = await scoreRun(r.runDir, { snapshotsRoot: s.deps.snapshotsRoot, scenariosRoot, rescore: true });
    assert.equal(records[0]!.category, 'invalid_setup');
    assert.match(records[0]!.setup.problems.join(' '), /ground truth changed since the run \(captured [0-9a-f]{12}/);
  });
});

describe('workspace cleanup after the session (Windows EBUSY)', () => {
  // A fake clock makes the bounded wait instant and exact.
  const fakeTime = () => {
    let now = 0;
    return { now: () => now, sleep: async (ms: number) => void (now += ms) };
  };
  const busy = (dir: string) => Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path.join(dir, 'project')}'`), { code: 'EBUSY' });

  test('transient EBUSY: the workspace is removed and the retries are kept in outcome.json, the score and the report', async (t) => {
    let calls = 0;
    const s = await setup(t, {
      removal: { ...fakeTime(), rm: async (dir) => { if (++calls <= 2) throw busy(dir); await rm(dir, { recursive: true, force: true }); } },
    });
    const r = await runLiveEvaluation(request(), s.deps);
    const { outcome } = await saved(r);
    assert.equal(outcome.cleanup.removed, true);
    assert.equal(outcome.cleanup.attempts, 3);
    assert.equal(outcome.cleanup.transient?.length, 2);
    assert.equal(r.score?.cleanup.status, 'removed_after_retry');
    assert.equal(r.score?.category, 'scored', 'infrastructure only');
    assert.match(r.summaryMarkdown!, /workspace removed after 2 retried attempt\(s\)/);
    assert.deepEqual(await leftovers(s.workParent), []);
  });

  test('persistent EBUSY: the failure is saved, scored as infrastructure, reported, and the diagnosis still scored', async (t) => {
    const s = await setup(t, { removal: { ...fakeTime(), rm: async (dir) => { throw busy(dir); } } });
    const r = await runLiveEvaluation(request(), s.deps);
    const { outcome, score } = await saved(r);
    assert.equal(outcome.cleanup.removed, false);
    assert.match(outcome.cleanup.error!, /^EBUSY: .*a process may still be using the workspace\)$/);
    assert.ok(outcome.cleanup.attempts! > 1);
    assert.equal(outcome.cleanup.transient?.length, outcome.cleanup.attempts! - 1);
    assert.ok(score, 'scored despite the leftover');
    assert.equal(r.score?.cleanup.status, 'failed');
    assert.equal(r.score?.category, 'scored');
    assert.equal(r.score?.acceptance.status, 'accepted');
    const md = await readFile(path.join(r.runDir, SUMMARY_MD), 'utf8');
    assert.match(md, /\*\*Infrastructure: workspace NOT removed\*\* \(EBUSY/);
    assert.match(md, /Workspace cleanup: failed 1\./);
    assert.match(md, /\*\*Workspaces left behind \(not a scoring problem\):\*\*\n- S02-01: EBUSY/);
    assert.deepEqual(JSON.parse(await readFile(path.join(r.runDir, SUMMARY_JSON), 'utf8')).infrastructure, { cleanup: { failed: 1 } });
    assert.equal((await leftovers(s.workParent)).length, 1, 'left in place, not force-deleted');
  });
});

describe('limits and single-scenario enforcement', () => {
  test('a missing or excessive budget is refused before anything is created', async (t) => {
    for (const maxBudgetUsd of [null, EVAL_MAX_BUDGET_USD + 0.01]) {
      const s = await setup(t);
      await assert.rejects(runLiveEvaluation(request({ maxBudgetUsd }), s.deps), LiveRefusal);
      assert.equal(s.calls.n, 0);
      assert.equal(await stat(s.runsRoot).then(() => true, () => false), false, 'no run directory');
    }
  });

  test('a test filter is refused: a live evaluation investigates the whole snapshot', async (t) => {
    await assert.rejects(runLiveEvaluation(request({ filter: 'login' }), (await setup(t)).deps), /--test is not allowed/);
  });

  test('parseLiveArgs: exactly one scenario, explicit budget, production limits', () => {
    const err = (argv: string[]) => {
      const p = parseLiveArgs(argv);
      assert.equal(p.kind, 'error', argv.join(' '));
      return (p as { message: string }).message;
    };
    assert.match(err(['--max-budget-usd', '1']), /exactly one --scenario is required, got 0/);
    assert.match(err(['--scenario', 'S02', '--scenario', 'S04', '--max-budget-usd', '1']), /exactly one --scenario is required, got 2/);
    assert.match(err(['--scenario', 'S02,S04', '--max-budget-usd', '1']), /one scenario ID like S02/);
    assert.match(err(['--all', '--max-budget-usd', '1']), /there is no --all/);
    assert.match(err(['--scenario', 'S02', 'S04', '--max-budget-usd', '1']), /unexpected argument/);
    assert.match(err(['--scenario', 'S02']), /--max-budget-usd is required/);
    assert.match(err(['--scenario', 'S02', '--max-budget-usd', '3']), /exceeds the evaluation limit of 2/);
    assert.match(err(['--scenario', 'S02', '--max-budget-usd', '150']), /limited to 100/);
    assert.match(err(['--scenario', 'S02', '--max-budget-usd', '1', '--max-turns', '500']), /--max-turns must be 1-100/);
    assert.match(err(['--scenario', 'S02', '--max-budget-usd', '1', '--timeout', '5']), /--timeout must be 10-3600 seconds/);
    assert.match(err(['--scenario', 'S02', '--max-budget-usd', '1', '--auth', 'other']), /--auth must be/);
    const ok = parseLiveArgs(['--scenario', 'S02', '--max-budget-usd', '0.5', '--max-turns', '20', '--timeout', '120']);
    assert.equal(ok.kind, 'run');
    assert.deepEqual((ok as { request: unknown }).request, {
      scenarioId: 'S02',
      args: { filter: null, model: null, maxTurns: 20, timeoutMs: 120_000, maxBudgetUsd: 0.5, auth: 'subscription', json: false },
      runDir: null,
    });
  });

  test('attempts of a different source cannot be mixed into a run', async (t) => {
    const s = await setup(t);
    const dir = path.join(s.runsRoot, 'live-run');
    await writeRunManifest(dir, 'live-run');
    const file = path.join(dir, 'run.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"scorer_validation"', '"live"'));
    await assert.rejects(runLiveEvaluation({ ...request(), runDir: dir }, s.deps), /is a live run; this attempt is scorer_validation/);
    assert.equal(s.calls.n, 0);
  });

  test('CLI refusals exit 2 before any session (no SDK is started)', async () => {
    const cli = (...argv: string[]) => promisify(execFile)(process.execPath, [path.join(REPO_ROOT, 'src', 'eval', 'main.ts'), 'live', ...argv], { cwd: REPO_ROOT });
    for (const argv of [['--scenario', 'S02'], ['--all', '--max-budget-usd', '1'], ['--scenario', 'S02', '--scenario', 'S04', '--max-budget-usd', '1'], ['--scenario', 'S02', '--max-budget-usd', '5']]) {
      await assert.rejects(cli(...argv), (e: { code: number; stderr: string }) => e.code === 2 && /^eval live: /.test(e.stderr), argv.join(' '));
    }
  });
});

describe('reproducibility', () => {
  test('a saved live run re-scores byte-identically, in place and after being moved', async (t) => {
    const s = await setup(t);
    const r = await runLiveEvaluation(request(), s.deps);
    const original = await readFile(path.join(r.runDir, r.evalId, SCORE_FILE), 'utf8');
    assert.deepEqual((await scoreRun(r.runDir, { snapshotsRoot: s.deps.snapshotsRoot })).rescored, []);
    const moved = path.join(base, `moved-${path.basename(r.runDir)}`);
    await cp(r.runDir, moved, { recursive: true });
    t.after(() => rm(moved, { recursive: true, force: true }));
    await rm(path.join(moved, r.evalId, SCORE_FILE));
    await scoreRun(moved, { snapshotsRoot: s.deps.snapshotsRoot });
    assert.equal(await readFile(path.join(moved, r.evalId, SCORE_FILE), 'utf8'), original);
  });
});
