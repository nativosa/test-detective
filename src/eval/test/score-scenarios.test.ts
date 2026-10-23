import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { applyReview } from '../report.ts';
import type { Review } from '../report.ts';
import { reportRun, SCORE_FILE, scoreRun } from '../runs.ts';
import { SCORER_VERSION, ScoreRecord } from '../score.ts';
import type { CheckId } from '../score.ts';
import { getFailureDetails, listFailures, loadReport } from '../../mcp/report.ts';
import { loadSnapshot, MANIFEST_FILE, sha256, SNAPSHOTS_DIR } from '../snapshots.ts';
import { SCENARIO_VARIANTS, writeScenarioRun } from './golden-scenarios.ts';
import { writeEvaluation, writeRunManifest } from './golden.ts';

// Scorer v6/v7 policy on SCORER-VALIDATION fixtures for the Stage 2.6 scenarios: scripted sessions,
// replayed through the unchanged runInvestigation and scored against the REAL truth files. Each
// variant states the category, acceptance and classification verdict it must get. Not agent data.

const base = await mkdtemp(path.join(tmpdir(), 'td-score26-'));
after(() => rm(base, { recursive: true, force: true }));
const { runDir, snapshotsRoot, ids } = await writeScenarioRun(base);
const records = new Map((await scoreRun(runDir, { snapshotsRoot })).records.map((r) => [r.evalId, r]));

function scoreOf(name: string): ScoreRecord {
  const record = records.get(ids[name]!);
  assert.ok(record, `no score for ${name}`);
  return record;
}
const statusOf = (r: ScoreRecord, id: CheckId) => r.checks.find((c) => c.id === id)!.status;
const summaryOf = (r: ScoreRecord) => `${r.category}/${r.acceptance.status}: ${r.reasons.join('; ')} | ${r.checks.map((c) => `${c.id}=${c.status} (${c.detail})`).join(' · ')}`;

describe('Stage 2.6 golden variants (current scorer)', () => {
  test('every variant was scored with the current scorer against its scenario truth', () => {
    assert.equal(records.size, SCENARIO_VARIANTS.length);
    for (const r of records.values()) {
      assert.equal(r.scorerVersion, SCORER_VERSION);
      assert.ok(r.failureType, `${r.evalId} has no failureType`);
      assert.equal(r.setup.ok, true, `${r.evalId}: ${r.setup.problems.join('; ')}`);
      assert.notEqual(r.audit.verdict, 'violation');
    }
  });

  for (const v of SCENARIO_VARIANTS) {
    test(`${v.scenarioId} ${v.name}: ${v.about}`, () => {
      const r = scoreOf(v.name);
      assert.equal(r.category, v.expect.category, summaryOf(r));
      assert.equal(r.acceptance.status, v.expect.acceptance, summaryOf(r));
      if (v.expect.verdict === null) assert.deepEqual(r.classification.tests, [], summaryOf(r));
      else assert.equal(r.classification.tests[0]?.verdict, v.expect.verdict, summaryOf(r));
      for (const [id, status] of Object.entries(v.expect.checks ?? {})) assert.equal(statusOf(r, id as CheckId), status, `${id}: ${summaryOf(r)}`);
    });
  }
});

describe('scorer v8 on sessions without get_trace_summary', () => {
  test('no trace claims to compare, no tool calls recorded; Bash trace reads count as Bash acquisition', () => {
    for (const r of records.values()) {
      assert.equal(statusOf(r, 'trace_consistency'), 'not_applicable', r.evalId);
      for (const t of r.traceEvidence?.tests ?? []) assert.deepEqual(t.summaries, [], r.evalId);
    }
    assert.equal(scoreOf('s07Correct').traceEvidence?.tests[0]?.acquisition, 'bash');
    assert.equal(scoreOf('s08Correct').traceEvidence?.tests[0]?.acquisition, 'no_trace');
  });
});

describe('scorer v6 policies', () => {
  test('S07: the observed flaky outcome is recorded per test and checked against the truth', () => {
    const r = scoreOf('s07Correct');
    assert.equal(r.classification.tests[0]!.outcome, 'flaky');
    assert.match(r.checks.find((c) => c.id === 'coverage')!.items[0]!.detail, /outcome flaky/);
    assert.equal(scoreOf('s01Correct').classification.tests[0]!.outcome, 'unexpected');
  });

  test('S07: High confidence is accepted when the evidence shows the server error; a frequency claim fails as a definitive claim', () => {
    assert.equal(scoreOf('s07Correct').classification.tests[0]!.confidence, 'High');
    const items = scoreOf('s07FrequencyClaim').checks.find((c) => c.id === 'root_cause')!.items;
    assert.deepEqual(
      items.filter((i) => i.status === 'fail').map((i) => [i.id, i.tag]),
      [['forbidden:frequency-claim', 'forbidden_definitive']],
    );
    const hedged = scoreOf('s07HedgedRecurrence').checks.find((c) => c.id === 'root_cause')!.items.find((i) => i.id === 'forbidden:frequency-claim');
    assert.equal(hedged?.status, 'review');
    assert.match(hedged!.detail, /hedged or negated/);
  });

  test('a reviewable alternative is never high-confidence incorrect and keeps exact agreement separate', () => {
    for (const name of ['s01RequirementsAmbiguity', 's07Environment', 's08CautiousEnvironment', 's09Inconclusive']) {
      const t = scoreOf(name).classification.tests[0]!;
      assert.equal(t.verdict, 'reviewable_alternative');
      assert.equal(t.highConfidenceIncorrect, false);
      assert.ok(scoreOf(name).acceptance.pending.includes('classification'), name);
    }
  });

  test('S08: definitive unsupported claims fail; the missing trace and screenshot must be acknowledged', () => {
    const definitive = scoreOf('s08DefinitiveApp').checks.find((c) => c.id === 'root_cause')!;
    assert.ok(definitive.items.some((i) => i.id === 'forbidden:definite-server' && i.status === 'fail'));
    assert.equal(scoreOf('s08DefinitiveApp').classification.tests[0]!.highConfidenceIncorrect, true);
    const sufficiency = scoreOf('s08MissingUnavailable').checks.find((c) => c.id === 'evidence_sufficiency')!;
    assert.deepEqual(
      sufficiency.items.filter((i) => i.id.startsWith('unavailable:')).map((i) => [i.id, i.status, i.tag]),
      [
        ['unavailable:trace', 'fail', 'unacknowledged'],
        ['unavailable:screenshot', 'fail', 'unacknowledged'],
      ],
    );
    const ok = scoreOf('s08Correct').checks.find((c) => c.id === 'evidence_sufficiency')!;
    assert.deepEqual(ok.items.filter((i) => i.id.startsWith('unavailable:')).map((i) => i.status), ['pass', 'pass']);
  });

  test('S10: no failures, no get_failure_details, nothing to classify', () => {
    const r = scoreOf('s10Correct');
    assert.deepEqual(r.classification, { expected: null, tests: [] });
    for (const id of ['classification', 'confidence', 'source_mismatch', 'evidence_sufficiency', 'root_cause', 'recommendation'] as const) assert.equal(statusOf(r, id), 'not_applicable', id);
    assert.ok(!r.checks.find((c) => c.id === 'process')!.items.some((i) => i.id.startsWith('get_failure_details')));
  });
});

describe('human review of a reviewable alternative', () => {
  const review = (r: ScoreRecord, checks: Review['checks']): Review => ({ evalId: r.evalId, reviewer: 'tester', reviewedAt: '2026-10-22', scoreSha256: 'f'.repeat(64), checks, note: '' });

  test('a reviewer can accept a defensible alternative; only then is the diagnosis accepted', () => {
    const r = scoreOf('s08CautiousEnvironment');
    assert.deepEqual(r.acceptance, { status: 'pending_review', blockers: [], pending: ['classification'] });
    const accepted = applyReview(r, 'f'.repeat(64), review(r, { classification: { status: 'pass', note: 'cautious and defensible' } }));
    assert.equal(accepted.status, 'applied');
    assert.equal(accepted.category, 'scored');
    assert.deepEqual(accepted.acceptance, { status: 'accepted', blockers: [], pending: [] });
    assert.equal(r.classification.tests[0]!.verdict, 'reviewable_alternative', 'the verdict itself is unchanged');
  });

  test('a rejected alternative blocks acceptance', () => {
    const r = scoreOf('s07Environment');
    const rejected = applyReview(r, 'f'.repeat(64), review(r, { classification: { status: 'fail', note: 'the 500 points at the app' } }));
    assert.equal(rejected.acceptance.status, 'not_accepted');
    assert.match(rejected.acceptance.blockers.join('; '), /reviewable_alternative \(reviewed: fail\)/);
  });

  test('review cannot change an exact, incorrect or abstained verdict', () => {
    for (const name of ['s01Correct', 's01AppDefect']) {
      const r = scoreOf(name);
      const reviewed = applyReview(r, 'f'.repeat(64), review(r, { classification: { status: 'pass', note: 'x' } }));
      assert.equal(reviewed.status, 'partly_rejected');
      assert.deepEqual(reviewed.acceptance, r.acceptance);
      assert.match(reviewed.notes.join('; '), /review decides only a reviewable alternative/);
    }
  });
});

describe('report: outcome and failure type', () => {
  test('per-test outcome, failure type and a by-failure-type table', async () => {
    const { summary, markdown } = await reportRun(runDir);
    const s07 = summary.evaluations.find((e) => e.evalId === ids.s07Correct)!;
    assert.equal(s07.failureType, 'intermittent_failure');
    assert.equal(s07.tests[0]!.outcome, 'flaky');
    const s10 = summary.byFailureType.find((t) => t.failureType === 'negative_control')!;
    assert.deepEqual(s10, { failureType: 'negative_control', evaluations: 3, eligible: 2, investigations: 0, exact: 0, reviewableAlternative: 0, accepted: 1 });
    assert.equal(summary.automatic.classification.verdicts.reviewable_alternative, 5, "S01, S07, S09 and two S08 variants");
    assert.ok(summary.automatic.rootCause.definitiveClaims >= 5);
    assert.match(markdown, /## By failure type \(automatic\)/);
    assert.match(markdown, /\| intermittent_failure \| 11 \|/);
    assert.match(markdown, /Application defect \(exact; flaky\)/);
    assert.match(markdown, /reviewable alternative 5/);
  });

  test('score files carry the failure type and the scorer version', async () => {
    const stored = JSON.parse(await readFile(path.join(runDir, ids.s09Correct!, SCORE_FILE), 'utf8')) as ScoreRecord;
    assert.equal(stored.failureType, 'source_mismatch');
    assert.equal(stored.scorerVersion, SCORER_VERSION);
    assert.equal(sha256(JSON.stringify(stored)).length, 64);
  });
});

describe('score files from before version 6', () => {
  test('parse with a null failure type and null test outcomes, and report as "unknown"', async () => {
    const v6 = scoreOf('s01Correct');
    const v5 = JSON.parse(JSON.stringify({ ...v6, scorerVersion: 5 })) as Record<string, any>;
    delete v5.failureType;
    for (const t of v5.classification.tests) delete t.outcome;
    const parsed = ScoreRecord.parse(v5);
    assert.equal(parsed.failureType, null);
    assert.equal(parsed.classification.tests[0]!.outcome, null);
  });
});

describe('scorer v7: verification steps and denied access', () => {
  const items = (name: string, check: CheckId) => scoreOf(name).checks.find((c) => c.id === check)!.items;
  const tagged = (name: string, check: CheckId, id: RegExp) => items(name, check).filter((i) => id.test(i.id)).map((i) => [i.status, i.tag]);

  test('a verification-only criterion and recommendation are met from verificationSteps, and say so', () => {
    const rerun = items('s09RerunOnlyInSteps', 'root_cause').find((i) => i.id === 'rerun')!;
    assert.deepEqual([rerun.status, rerun.detail], ['pass', 'matched /npx playwright test/ in verificationSteps (verification-only criterion)']);
    assert.match(items('s09RerunOnlyInSteps', 'recommendation').find((i) => i.id === 'acceptable')!.detail, /rerun \(in verificationSteps\)/);
  });

  test('causal and fix criteria are never met from verificationSteps', () => {
    assert.equal(items('s07FlakyOnlyInSteps', 'root_cause').find((i) => i.id === 'flaky')!.status, 'review');
    assert.equal(items('s03FixOnlyInSteps', 'recommendation').find((i) => i.id === 'acceptable')!.status, 'review');
  });

  test('forbidden recommendations are found in verificationSteps and are not hidden by a valid re-run', () => {
    assert.ok(items('s03SleepInSteps', 'recommendation').some((i) => i.id === 'forbidden:sleep'));
    const r = items('s09RerunHidesSleep', 'recommendation');
    assert.ok(r.some((i) => i.id === 'forbidden:sleep') && r.some((i) => i.id === 'acceptable' && i.status === 'pass'));
  });

  test('S07 shape: honest "not available" passes, the citation goes to review, required evidence still fails', () => {
    assert.deepEqual(tagged('s07AccessDenied', 'evidence_validity', /^trace:/), [['pass', 'access_denied']]);
    assert.deepEqual(tagged('s07AccessDenied', 'citations', /trace\.zip$/), [['review', 'access_denied']]);
    assert.deepEqual(tagged('s07AccessDenied', 'evidence_sufficiency', /^trace:/), [['fail', 'access_denied']]);
    assert.ok(scoreOf('s07AccessDenied').acceptance.blockers.some((b) => b.includes('evidence_sufficiency')), scoreOf('s07AccessDenied').acceptance.blockers.join('; '));
  });

  test('denial is not an excuse: a later successful read is verified, and a claimed inspection stays false', () => {
    assert.deepEqual(tagged('s07DeniedThenRetried', 'evidence_validity', /^trace:/), [['pass', 'verified']]);
    assert.deepEqual(tagged('s07DeniedClaimsInspected', 'evidence_validity', /^trace:/), [['fail', 'confirmed_false']]);
    assert.deepEqual(tagged('s07DeniedClaimsInspected', 'evidence_sufficiency', /^trace:/), [['fail', 'confirmed_false']]);
  });

  test('a failed command without a permission denial keeps the v6 labels', () => {
    assert.deepEqual(tagged('s07TraceCommandFailed', 'evidence_validity', /^trace:/), [['fail', 'false_unavailable']]);
    assert.deepEqual(tagged('s07TraceCommandFailed', 'citations', /trace\.zip$/), [['fail', 'confirmed_false']]);
    assert.deepEqual(tagged('s07TraceCommandFailed', 'evidence_sufficiency', /^trace:/), [['fail', 'not_inspected']]);
  });
});

describe('artifact availability (absent vs present but not inspected vs false claims)', () => {
  const items = (name: string, check: CheckId) => scoreOf(name).checks.find((c) => c.id === check)!.items;
  const item = (name: string, check: CheckId, id: string) => {
    const found = items(name, check).find((i) => i.id === id);
    assert.ok(found, `${name}: no ${check} item ${id} (${items(name, check).map((i) => i.id).join(', ')})`);
    return found;
  };

  test('genuinely absent (S08 trace and screenshot, reported not available): passes in both evidence checks', () => {
    for (const id of ['trace:(no ref)', 'screenshot:(no ref)']) {
      assert.deepEqual([item('s08Correct', 'evidence_validity', id).status, item('s08Correct', 'evidence_validity', id).tag], ['pass', 'unavailable']);
    }
    for (const id of ['unavailable:trace', 'unavailable:screenshot']) assert.equal(item('s08Correct', 'evidence_sufficiency', id).tag, 'unavailable');
  });

  test('present but optional and skipped (S01 screenshot and trace): no penalty', () => {
    assert.deepEqual([item('s01Correct', 'evidence_validity', 'screenshot:(no ref)').status, item('s01Correct', 'evidence_validity', 'screenshot:(no ref)').tag], ['pass', 'skipped']);
    assert.equal(scoreOf('s01Correct').acceptance.status, 'accepted');
  });

  test('present and required, but neither read nor reported: not_inspected', () => {
    const required = items('s01ContextNotInspected', 'evidence_sufficiency').find((i) => i.id.startsWith('error_context:'))!;
    assert.deepEqual([required.status, required.tag], ['fail', 'not_inspected']);
  });

  test('present, but claimed not available: false_unavailable', () => {
    const claim = items('s01ContextFalselyUnavailable', 'evidence_validity').find((i) => i.id.startsWith('error_context:'))!;
    assert.deepEqual([claim.status, claim.tag], ['fail', 'false_unavailable']);
  });

  test('present and claimed inspected, but never read: unsupported', () => {
    const claim = items('s01ContextUnsupported', 'evidence_validity').find((i) => i.id.startsWith('error_context:'))!;
    assert.deepEqual([claim.status, claim.tag], ['fail', 'unsupported']);
  });

  test('absent, but claimed inspected: confirmed false with a path, unresolved without one, and never acknowledged as unavailable', () => {
    const withPath = item('s08ClaimsTrace', 'evidence_validity', 'trace:test-results/x/trace.zip');
    assert.deepEqual([withPath.status, withPath.tag], ['fail', 'confirmed_false']);
    const noRef = item('s08ClaimsTraceNoRef', 'evidence_validity', 'trace:(no ref)');
    assert.deepEqual([noRef.status, noRef.tag], ['review', 'unresolved']);
    for (const name of ['s08ClaimsTrace', 's08ClaimsTraceNoRef']) {
      const unavailable = item(name, 'evidence_sufficiency', 'unavailable:trace');
      assert.deepEqual([unavailable.status, unavailable.tag], ['fail', 'confirmed_false'], name);
    }
  });
});

describe('real S08 snapshot (if present)', () => {
  test('fingerprint, attachments and scoring against the stored snapshot', async (t) => {
    const present = await stat(path.join(SNAPSHOTS_DIR, 'S08', MANIFEST_FILE)).then(() => true, () => false);
    if (!present) return t.skip('no S08 snapshot');
    const snapshot = await loadSnapshot('S08');
    assert.equal(snapshot.manifest.reportFingerprint, '3e9afc1329e3');
    const files = snapshot.manifest.files.map((f) => f.path);
    assert.ok(!files.some((f) => /\.(zip|png)$/.test(f)), files.join(', '));
    const loaded = await loadReport(snapshot.filesDir);
    const [failure] = listFailures(loaded).failures;
    const details = await getFailureDetails(loaded, failure!.testId);
    assert.deepEqual(details.attempts.map((a) => a.attachments.map((x) => x.name)), [['error-context']], 'the agent is shown no trace or screenshot');

    const dir = await mkdtemp(path.join(tmpdir(), 'td-real-s08-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const run = path.join(dir, 'run');
    await writeRunManifest(run, 'scorer-validation-real-s08');
    const variants = ['s08Correct', 's08ClaimsTrace', 's08MissingUnavailable'];
    for (const [i, name] of variants.entries()) await writeEvaluation(run, `S08-0${i + 1}`, snapshot, SCENARIO_VARIANTS.find((v) => v.name === name)!, path.join(dir, 'work'));
    const scored = (await scoreRun(run)).records;
    for (const [i, name] of variants.entries()) {
      const expect = SCENARIO_VARIANTS.find((v) => v.name === name)!.expect;
      const r = scored[i]!;
      assert.equal(r.inputs.snapshotFingerprint, '3e9afc1329e3');
      assert.equal(r.setup.ok, true, r.setup.problems.join('; '));
      assert.deepEqual([r.category, r.acceptance.status, r.classification.tests[0]?.verdict], [expect.category, expect.acceptance, expect.verdict], `${name}: ${r.reasons.join('; ')}`);
    }
  });
});
