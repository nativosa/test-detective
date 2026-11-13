import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInvestigation } from '../../agent/result.ts';
import { report, success, toolResult, toolUse } from '../../agent/test/helpers.ts';
import { leakMarkers } from '../isolation.ts';
import { aggregate } from '../report.ts';
import { OUTCOME_FILE, RESULT_FILE, RunOutcome, SCORE_FILE, SCORE_HISTORY_DIR, ScoreConflictError, scoreRun, snapshotInfo, TRANSCRIPT_FILE } from '../runs.ts';
import { evaluatePolarity, POLARITY_LIMITS } from '../polarity.ts';
import { SCENARIOS_DIR } from '../scenarios.ts';
import { CHECK_IDS, SCORER_VERSION, ScoreRecord, scoreEvaluation } from '../score.ts';
import type { Check, CheckId, ScoreInput } from '../score.ts';
import { sha256 } from '../snapshots.ts';
import { loadGroundTruth } from '../truth.ts';
import type { GroundTruth } from '../truth.ts';
import { correctInvestigation, goldenSnapshot, VARIANTS, writeEvaluation, writeMixedRun, writeRunManifest } from './golden.ts';

// Scoring policy regression tests on SCORER-VALIDATION fixtures: synthetic saved runs produced by
// the unchanged runInvestigation from scripted SDK streams (see golden.ts). They test the scorer;
// they are not measurements of agent performance. One mixed run is built and scored once.

const base = await mkdtemp(path.join(tmpdir(), 'td-score-'));
after(() => rm(base, { recursive: true, force: true }));
const { runDir, snapshotsRoot, ids } = await writeMixedRun(base);
const records = new Map((await scoreRun(runDir, { snapshotsRoot })).records.map((r) => [r.evalId, r]));
const markers = await leakMarkers();
const truthS02 = await loadGroundTruth('S02');

function score(name: string): ScoreRecord {
  const record = records.get(ids[name]!);
  assert.ok(record, `no score for ${name}`);
  return record;
}
const checkOf = (r: ScoreRecord, id: CheckId): Check => r.checks.find((c) => c.id === id)!;
const status = (r: ScoreRecord, id: CheckId) => checkOf(r, id).status;
const tags = (r: ScoreRecord, id: CheckId) => checkOf(r, id).items.map((i) => i.tag);
const only = (r: ScoreRecord) => {
  assert.equal(r.classification.tests.length, 1);
  return r.classification.tests[0]!;
};

describe('classification verdicts (no partial credit)', () => {
  test('exact: separate category, and the record carries no credit field', () => {
    const r = score('correct');
    assert.equal(r.category, 'scored', r.reasons.join('; '));
    assert.deepEqual(r.classification, {
      expected: 'Test-code defect',
      tests: [{ title: 'signs in with valid credentials', file: 'tests/ui/login.spec.ts', testId: only(r).testId, predicted: 'Test-code defect', confidence: 'High', verdict: 'exact', highConfidenceIncorrect: false, outcome: 'unexpected' }],
    });
    assert.ok(!('credit' in r.classification));
    // A session without get_trace_summary makes no trace claims to compare (scorer v8).
    for (const c of r.checks) assert.equal(c.status, c.id === 'trace_consistency' ? 'not_applicable' : 'pass', `${c.id}: ${c.detail}`);
  });

  test('incorrect and abstained are distinct verdicts', () => {
    assert.equal(only(score('wrongClassification')).verdict, 'incorrect');
    assert.equal(only(score('abstention')).verdict, 'abstained');
    assert.equal(only(score('abstention')).predicted, 'Inconclusive');
  });

  test('an acceptable alternative is its own verdict, a partial check and not an accepted diagnosis', async () => {
    const input = withTruth(await inputFor('wrongClassification'), (t) => (t.expected.acceptableAlternatives = [{ classification: 'Application defect', maxConfidence: 'High', note: 'test' }]));
    const r = scoreEvaluation(input);
    assert.equal(only(r).verdict, 'acceptable_alternative');
    assert.equal(status(r, 'classification'), 'partial');
    assert.equal(only(r).highConfidenceIncorrect, false);
    assert.equal(r.acceptance.status, 'not_accepted');
    assert.ok(r.acceptance.blockers.some((b) => b.includes('acceptable_alternative')));
  });

  test('an alternative above its confidence cap is incorrect (and flagged when High)', async () => {
    const input = withTruth(await inputFor('wrongClassification'), (t) => (t.expected.acceptableAlternatives = [{ classification: 'Application defect', maxConfidence: 'Low', note: 'test' }]));
    const r = scoreEvaluation(input);
    assert.equal(only(r).verdict, 'incorrect');
    assert.equal(only(r).highConfidenceIncorrect, true);
  });
});

describe('high-confidence incorrect diagnoses', () => {
  test('flagged on the verdict and failed in the confidence check', () => {
    const r = score('wrongClassification');
    assert.equal(only(r).highConfidenceIncorrect, true);
    assert.equal(status(r, 'confidence'), 'fail');
    assert.deepEqual(tags(r, 'confidence'), ['high_confidence_incorrect']);
  });

  test('an exact classification with confidence outside the expected range needs review, not failure', async () => {
    const r = scoreEvaluation(mutateAnalysis(await inputFor('correct'), (a) => (a.confidence = { level: 'Low', justification: 'x' })));
    assert.equal(only(r).verdict, 'exact');
    assert.equal(status(r, 'confidence'), 'review');
    assert.deepEqual(tags(r, 'confidence'), ['confidence_outside_range']);
    assert.equal(r.category, 'needs_review');
    assert.deepEqual(r.acceptance, { status: 'pending_review', blockers: [], pending: ['confidence'] });
  });

  test('an incorrect answer at Medium confidence is not flagged', async () => {
    const r = scoreEvaluation(mutateAnalysis(await inputFor('wrongClassification'), (a) => (a.confidence = { level: 'Medium', justification: 'x' })));
    assert.equal(only(r).verdict, 'incorrect');
    assert.equal(only(r).highConfidenceIncorrect, false);
    assert.equal(status(r, 'confidence'), 'not_applicable');
  });
});

describe('fully accepted diagnosis (separate from the label)', () => {
  test('correct diagnosis with verified evidence is accepted', () => {
    assert.deepEqual(score('correct').acceptance, { status: 'accepted', blockers: [], pending: [] });
  });

  test('a correct label with unsupported evidence is a correct label but not an accepted investigation', () => {
    const r = score('unsupportedEvidence');
    assert.equal(only(r).verdict, 'exact');
    assert.equal(r.acceptance.status, 'not_accepted');
    assert.deepEqual(r.acceptance.blockers, ['evidence_validity: fail', 'evidence_sufficiency: fail', 'citations: fail']);
  });

  test('a correct label with an undecided root cause is pending review', () => {
    const r = score('wrongRootCause');
    assert.equal(r.category, 'needs_review');
    assert.equal(only(r).verdict, 'exact');
    assert.deepEqual(r.acceptance, { status: 'pending_review', blockers: [], pending: ['root_cause', 'recommendation'] });
  });

  test('a decided failure blocks acceptance even while other reviews are pending', () => {
    const r = score('wrongClassification');
    assert.equal(r.acceptance.status, 'not_accepted');
    assert.ok(r.acceptance.pending.includes('root_cause'));
  });

  test('suspicious audit findings keep acceptance pending', () => {
    assert.deepEqual(score('suspiciousPaths').acceptance, { status: 'pending_review', blockers: [], pending: ['audit'] });
  });

  test('excluded runs are not eligible', () => {
    for (const name of ['missingSkill', 'timeout', 'leak', 'mcpUnavailable']) assert.equal(score(name).acceptance.status, 'not_eligible', name);
  });
});

describe('evidence provenance', () => {
  test('verified: every claim backed by a successful tool call or MCP result', () => {
    const r = score('correct');
    assert.deepEqual(tags(r, 'evidence_validity'), ['verified', 'verified', 'verified', 'skipped', 'skipped']);
    assert.deepEqual(tags(r, 'evidence_sufficiency'), ['verified', 'verified', 'verified']);
    assert.deepEqual(tags(r, 'citations'), ['verified', 'verified', 'verified']);
  });

  test('unsupported: no channel shows the file; fails, but is not called fabricated', () => {
    const r = score('unsupportedEvidence');
    assert.deepEqual(tags(r, 'evidence_validity'), ['verified', 'unsupported', 'unsupported', 'skipped', 'unsupported']);
    assert.equal(status(r, 'evidence_validity'), 'fail');
  });

  test('confirmed false: the only read of the file failed', () => {
    const r = score('failedRead');
    assert.ok(checkOf(r, 'evidence_validity').items.some((i) => i.tag === 'confirmed_false' && i.id === 'source:tests/ui/login.spec.ts'));
    assert.ok(checkOf(r, 'citations').items.some((i) => i.tag === 'confirmed_false' && i.id === 'tests/ui/login.spec.ts'));
  });

  test('confirmed false: a nonexistent file, and a file wrongly claimed unavailable', () => {
    const items = checkOf(score('unavailableEvidence'), 'evidence_validity').items;
    assert.ok(items.some((i) => i.tag === 'false_unavailable' && i.status === 'fail' && i.detail.includes('test-failed-1.png')));
    assert.ok(items.some((i) => i.tag === 'confirmed_false' && i.id.endsWith('video.webm') && /no such file/.test(i.detail)));
  });

  test('an MCP error snippet alone does not establish that the file was inspected', () => {
    const r = score('mcpSnippetOnly');
    assert.equal(r.transcript.complete, true);
    const source = checkOf(r, 'evidence_validity').items.find((i) => i.id === 'source:tests/ui/login.spec.ts')!;
    assert.deepEqual([source.status, source.tag], ['fail', 'unsupported']);
    assert.equal(r.acceptance.status, 'not_accepted');
  });

  test('with an incomplete transcript, a missing read is unresolved rather than unsupported', async () => {
    const input = await inputFor('unsupportedEvidence');
    const transcript = transcriptOf(input);
    // A tool call with no recorded result: the transcript no longer accounts for everything that happened.
    transcript.splice(transcript.length - 1, 0, bashCall('b-lost', 'cat tests/ui/other.ts')[0]!);
    const r = scoreEvaluation({ ...input, transcript: { state: 'ok', value: transcript } });
    assert.equal(r.transcript.complete, false);
    assert.deepEqual(r.transcript.problems, ['1 tool call(s) without a recorded result']);
    const source = checkOf(r, 'evidence_validity').items.find((i) => i.id === 'source:tests/ui/login.spec.ts')!;
    assert.deepEqual([source.status, source.tag], ['review', 'unresolved']);
    assert.match(source.detail, /transcript is incomplete/);
  });

  test('a complete transcript is recorded as complete', () => {
    assert.deepEqual(score('correct').transcript, { complete: true, problems: [] });
  });

  test('a Bash command naming only the base name is unresolved, not verified', async () => {
    const input = await inputFor('unsupportedEvidence');
    const transcript = transcriptOf(input);
    transcript.splice(transcript.length - 1, 0, ...bashCall('b1', 'cd tests/ui && cat login.spec.ts'));
    const r = scoreEvaluation({ ...input, transcript: { state: 'ok', value: transcript } });
    const source = checkOf(r, 'evidence_validity').items.find((i) => i.id === 'source:tests/ui/login.spec.ts')!;
    assert.deepEqual([source.status, source.tag], ['review', 'unresolved']);
  });

  test('genuinely unavailable evidence passes when the snapshot really lacks it', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'td-score-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { snapshot, snapshotsRoot: root } = await goldenSnapshot(path.join(dir, 'fixture'), { attachments: ['screenshot', 'error-context'] });
    const run = path.join(dir, 'run');
    await writeRunManifest(run, 'no-trace');
    await writeEvaluation(
      run,
      'S02-01',
      snapshot,
      {
        name: 'noTrace',
        about: 'trace reported as not available',
        session: async (f) => {
          const inv = correctInvestigation(f);
          inv.evidence = inv.evidence.map((e) => (e.kind === 'trace' ? { ...e, status: 'not_available', note: 'No trace attachment' } : e));
          // The correct stream with its final report swapped.
          return { messages: [...(await VARIANTS.correct!.session(f)).messages.slice(0, -1), successWith(inv)] };
        },
      },
      path.join(dir, 'work'),
    );
    const [r] = (await scoreRun(run, { snapshotsRoot: root })).records;
    assert.equal(r!.category, 'scored', r!.reasons.join('; '));
    assert.ok(checkOf(r!, 'evidence_validity').items.some((i) => i.id === 'trace:(no ref)' && i.tag === 'unavailable' && i.status === 'pass'));
  });
});

describe('citations', () => {
  test('a bare file name resolves to the unique snapshot file', async () => {
    const r = scoreEvaluation(mutateAnalysis(await inputFor('correct'), (a) => (a.analysis[1]!.evidenceRefs = ['error-context.md'])));
    assert.ok(checkOf(r, 'citations').items.some((i) => i.id === 'error-context.md' && i.tag === 'verified'));
  });

  test('free text goes to review; a path that does not exist fails', async () => {
    const r = scoreEvaluation(mutateAnalysis(await inputFor('correct'), (a) => (a.analysis[0]!.evidenceRefs = ['the page snapshot', 'tests/ui/logout.spec.ts'])));
    const items = checkOf(r, 'citations').items.filter((i) => i.id === 'the page snapshot' || i.id === 'tests/ui/logout.spec.ts');
    assert.deepEqual(
      items.map((i) => [i.id, i.status, i.tag]),
      [
        ['the page snapshot', 'review', 'unresolved'],
        ['tests/ui/logout.spec.ts', 'fail', 'confirmed_false'],
      ],
    );
  });
});

describe('root cause and recommendation heuristics', () => {
  test('a wrong root cause with a correct label goes to review, never auto-fails', () => {
    const r = score('wrongRootCause');
    assert.equal(status(r, 'root_cause'), 'review');
    assert.ok(checkOf(r, 'root_cause').items.every((i) => i.status === 'review'));
  });

  test('a forbidden claim flags review', () => {
    assert.ok(checkOf(score('wrongClassification'), 'root_cause').items.some((i) => i.id === 'forbidden:login-broken' && i.status === 'review'));
  });

  test('a forbidden recommendation flags review even when an acceptable pattern also matches', () => {
    const items = checkOf(score('incorrectRecommendation'), 'recommendation').items;
    assert.ok(items.some((i) => i.id === 'acceptable' && i.status === 'pass'));
    assert.ok(items.some((i) => i.id === 'forbidden:sleep' && i.status === 'review'));
  });
});

describe('recommendation roles (scorer v10, synthetic truth)', () => {
  // S02's real truth plus a corrective alternative and two supporting fixes; the second supporting
  // one is verification-only (its pattern describes a re-run), so it may match in verificationSteps.
  const roles = (t: GroundTruth) =>
    (t.recommendations.acceptable = [
      { id: 'use-log-in', description: "Locate the button by its real name 'Log in'", anyOf: ["name: ?['\"]log in['\"]"] },
      { id: 'use-test-id', description: 'A corrective alternative', anyOf: ['getByTestId'] },
      { id: 'list-buttons', role: 'supporting', description: 'Log the button names first', anyOf: ['log (the )?button names'] },
      { id: 'rerun', role: 'supporting', description: 'Re-run the test', anyOf: ['re-?run'] },
    ]);
  const scoreWith = async (fix: string, steps?: string[], truth: (t: GroundTruth) => void = roles) =>
    scoreEvaluation(
      withTruth(
        mutateAnalysis(await inputFor('correct'), (a) => {
          a.proposedFix = fix;
          if (steps) a.verificationSteps = steps;
        }),
        truth,
      ),
    );
  const acceptableOf = (r: ScoreRecord) => checkOf(r, 'recommendation').items.find((i) => i.id === 'acceptable');
  const CORRECT = "Locate the button by its real name: page.getByRole('button', { name: 'Log in' }).";
  const NO_CORRECTIVE = 'no corrective fix matched (use-log-in, use-test-id)';

  test('one corrective match passes, as before', async () => {
    const r = await scoreWith(CORRECT);
    assert.deepEqual(acceptableOf(r), { id: 'acceptable', status: 'pass', detail: 'matched use-log-in', tag: 'acceptable' });
    assert.equal(status(r, 'recommendation'), 'pass');
    assert.equal(r.acceptance.status, 'accepted');
  });

  test('of two corrective alternatives, either one alone is sufficient', async () => {
    const r = await scoreWith("Locate the button with page.getByTestId('login').");
    assert.equal(acceptableOf(r)!.status, 'pass');
    assert.equal(acceptableOf(r)!.detail, 'matched use-test-id');
    assert.equal(r.acceptance.status, 'accepted');
  });

  test('corrective plus supporting passes and records both, the supporting one labelled', async () => {
    const r = await scoreWith(`First log the button names. ${CORRECT}`);
    assert.equal(acceptableOf(r)!.status, 'pass');
    assert.equal(acceptableOf(r)!.detail, 'matched use-log-in, list-buttons (supporting)');
    assert.equal(r.acceptance.status, 'accepted');
  });

  test('supporting only goes to review, with an explanation that says so', async () => {
    const r = await scoreWith('Log the button names before clicking.');
    assert.deepEqual(acceptableOf(r), { id: 'acceptable', status: 'review', detail: `only a supporting recommendation matched (list-buttons); ${NO_CORRECTIVE}`, tag: 'acceptable' });
    assert.equal(status(r, 'recommendation'), 'review');
    assert.deepEqual(r.acceptance, { status: 'pending_review', blockers: [], pending: ['recommendation'] });
  });

  test('a supporting fix that matches only in verificationSteps never satisfies the check', async () => {
    const r = await scoreWith('Look at the page first.', ['Rerun the test.']);
    assert.equal(acceptableOf(r)!.status, 'review');
    assert.equal(acceptableOf(r)!.detail, `only a supporting recommendation matched (rerun (in verificationSteps)); ${NO_CORRECTIVE}`);
    // The same verification-only criterion without a role keeps its v7 meaning: met from the steps.
    const corrective = await scoreWith('Look at the page first.', ['Rerun the test.'], (t) => {
      roles(t);
      delete t.recommendations.acceptable[3]!.role;
    });
    assert.equal(acceptableOf(corrective)!.status, 'pass');
    assert.equal(acceptableOf(corrective)!.detail, 'matched rerun (in verificationSteps)');
  });

  test('a corrective fix never hides forbidden advice', async () => {
    const r = await scoreWith(`${CORRECT} Add await page.waitForTimeout(500) first.`);
    assert.equal(acceptableOf(r)!.status, 'pass');
    assert.ok(checkOf(r, 'recommendation').items.some((i) => i.id === 'forbidden:sleep' && i.status === 'review' && i.tag === 'forbidden'));
    assert.equal(status(r, 'recommendation'), 'review');
    assert.deepEqual(r.acceptance.pending, ['recommendation']);
  });

  test('supporting only next to forbidden advice: both reasons are recorded', async () => {
    const r = await scoreWith('Log the button names, then add a sleep.');
    assert.equal(acceptableOf(r)!.status, 'review');
    assert.match(acceptableOf(r)!.detail, /^only a supporting recommendation matched/);
    assert.ok(checkOf(r, 'recommendation').items.some((i) => i.id === 'forbidden:sleep' && i.status === 'review'));
  });

  test('no match, or no proposed fix, goes to review as before', async () => {
    assert.deepEqual(acceptableOf(await scoreWith('Restart the browser.')), { id: 'acceptable', status: 'review', detail: 'no acceptable fix pattern matched', tag: 'acceptable' });
    assert.deepEqual(acceptableOf(await scoreWith('')), { id: 'acceptable', status: 'review', detail: 'no proposed fix', tag: 'acceptable' });
  });

  test('an empty acceptable list adds no acceptable item and requires no fix (unchanged)', async () => {
    const onlyForbidden = await scoreWith(CORRECT, undefined, (t) => (t.recommendations.acceptable = []));
    assert.equal(acceptableOf(onlyForbidden), undefined);
    assert.equal(status(onlyForbidden, 'recommendation'), 'not_applicable', 'no item: no acceptable list and no forbidden match');
    const withSleep = await scoreWith(`${CORRECT} Add a sleep.`, undefined, (t) => (t.recommendations.acceptable = []));
    assert.deepEqual(checkOf(withSleep, 'recommendation').items.map((i) => `${i.id}=${i.status}`), ['forbidden:sleep=review']);
    const none = await scoreWith(CORRECT, undefined, (t) => (t.recommendations = { acceptable: [], forbidden: [] }));
    assert.equal(status(none, 'recommendation'), 'not_applicable');
    assert.equal(checkOf(none, 'recommendation').detail, 'no recommendation criteria');
  });

  test('an explicit corrective role scores exactly like an omitted one', async () => {
    const omitted = await scoreWith(`First log the button names. ${CORRECT}`, undefined, (t) => {
      roles(t);
      for (const a of t.recommendations.acceptable) if (a.role === 'corrective') delete a.role;
    });
    const explicit = await scoreWith(`First log the button names. ${CORRECT}`, undefined, (t) => {
      roles(t);
      for (const a of t.recommendations.acceptable) a.role ??= 'corrective';
    });
    assert.deepEqual(explicit.checks, omitted.checks);
  });

  test('supporting-only records serialize and aggregate like other reviews (not counted as matched)', async () => {
    const supportingOnly = await scoreWith('Log the button names before clicking.');
    const corrective = await scoreWith(`First log the button names. ${CORRECT}`);
    for (const r of [supportingOnly, corrective]) assert.deepEqual(ScoreRecord.parse(JSON.parse(JSON.stringify(r))), r);
    const summary = aggregate(
      { formatVersion: 1, runId: 'roles', createdAt: '2026-11-12T00:00:00.000Z', source: 'scorer_validation', description: '' },
      [
        { record: { ...supportingOnly, evalId: 'S02-01' }, sha256: 'a'.repeat(64) },
        { record: { ...corrective, evalId: 'S02-02' }, sha256: 'b'.repeat(64) },
      ],
      null,
    );
    assert.deepEqual(summary.automatic.recommendation, { passed: { count: 1, of: 2 }, acceptableMatched: { count: 1, of: 2 }, forbiddenHits: 0 });
    assert.deepEqual(summary.automatic.acceptance.statuses, { accepted: 1, not_accepted: 0, pending_review: 1 });
  });
});

describe('recommendation roles on the real truths (scorer v10)', () => {
  // Each scenario's real recommendations replace S02's (the recommendation check reads nothing else
  // from the truth), and each acceptable fix is proposed on its own.
  const acceptableFor = async (id: string, fix: string) => {
    const real = await loadGroundTruth(id);
    const r = await scoreEvaluation(withTruth(mutateAnalysis(await inputFor('correct'), (a) => (a.proposedFix = fix)), (t) => (t.recommendations = real.recommendations)));
    return checkOf(r, 'recommendation').items.find((i) => i.id === 'acceptable');
  };

  test('only S13 check-status is supporting; every other acceptable fix is corrective', async () => {
    const roles: string[] = [];
    for (let n = 1; n <= 14; n++) {
      const id = `S${String(n).padStart(2, '0')}`;
      for (const a of (await loadGroundTruth(id)).recommendations.acceptable) if (a.role !== undefined) roles.push(`${id}/${a.id}=${a.role}`);
    }
    assert.deepEqual(roles, ['S13/check-status=supporting']);
  });

  const SUFFICIENT: [scenario: string, fix: string, matched: string][] = [
    ['S04', 'Investigate the backend endpoint that returns 500.', 'fix-backend'],
    ['S04', 'No change is needed to the test.', 'keep-test'],
    ['S05', 'Remove the page.route mock that fulfills the 500.', 'remove-mock'],
    ['S05', 'Make the mock answer with status: 200.', 'mock-success'],
    ['S05', 'Expect the error alert that the mocked response produces.', 'expect-error'],
    ['S07', 'Check the server logs for the intermittent 500.', 'fix-backend'],
    ['S07', 'The test is correct; no change is needed to the test.', 'keep-test'],
    ['S08', 'Enable trace collection and capture the network logs on the next failure.', 'collect-evidence'],
    ['S13', 'Check the server logs for /reports/monthly.csv.', 'fix-server'],
    ['S13', 'The test is correct and needs no change.', 'keep-test'],
    ['S14', 'Use a locator instead of the element handle.', 'use-locator'],
    ['S14', 'Re-query the checkbox after the reset.', 'reacquire'],
  ];
  for (const [scenario, fix, matched] of SUFFICIENT) {
    test(`${scenario} ${matched} alone is still sufficient`, async () => {
      assert.deepEqual(await acceptableFor(scenario, fix), { id: 'acceptable', status: 'pass', detail: `matched ${matched}`, tag: 'acceptable' });
    });
  }

  test('S10 (no failures) has no acceptable fixes, so no acceptable item', async () => {
    assert.equal(await acceptableFor('S10', 'Nothing to fix.'), undefined);
  });
});

describe('acceptable-fix polarity on the real truths (scorer v11)', () => {
  // As above: each scenario's real recommendations replace S02's; every other check of the 'correct'
  // input passes, so the recommendation decides acceptance.
  const scoreWith = async (id: string, fix: string, steps?: string[]) => {
    const real = await loadGroundTruth(id);
    const input = mutateAnalysis(await inputFor('correct'), (a) => {
      a.proposedFix = fix;
      if (steps) a.verificationSteps = steps;
    });
    return scoreEvaluation(withTruth(input, (t) => (t.recommendations = real.recommendations)));
  };
  const acceptableOf = (r: ScoreRecord) => checkOf(r, 'recommendation').items.find((i) => i.id === 'acceptable')!;

  const CASES: [scenario: string, fix: string, steps: string[] | undefined, status: 'pass' | 'review', detail: string][] = [
    // keep-test's own negation is inside its pattern: positive (S04, S07, S13 share the patterns' form).
    ['S04', 'No fix is required in the test; investigate the backend endpoint.', undefined, 'pass', 'matched fix-backend, keep-test'],
    ['S07', 'The test is correct; no change is needed to the test.', undefined, 'pass', 'matched keep-test'],
    ['S04', 'Do not assume the test is correct; investigate the backend.', undefined, 'pass', 'matched fix-backend; not counted: keep-test (rejected: "test is correct" negated: negator_before)'],
    // S05: alternatives in separate criteria.
    ['S05', 'Do not remove the mock; make the mock answer with status: 200.', undefined, 'pass', 'matched mock-success; not counted: remove-mock (rejected: "remove the mock" negated: negator_before)'],
    ['S05', 'Remove the route mock. Do not expect the error alert.', undefined, 'pass', 'matched remove-mock; not counted: expect-error (rejected: "expect the error alert" negated: negator_before)'],
    // S08: collect-evidence (corrective for an inconclusive diagnosis).
    ['S08', 'Not applied. First collect the trace and the network logs on the next failure.', undefined, 'pass', 'matched collect-evidence'],
    ['S08', 'Do not collect more logs.', undefined, 'review', 'no acceptable fix endorsed; not counted: collect-evidence (rejected: "collect more logs" negated: negator_before)'],
    // S09: rerun is verification-only, so each verification step is its own field.
    ['S09', 'No further change is needed.', ['Run the test again.'], 'pass', 'matched rerun (in verificationSteps)'],
    ['S09', 'No further change is needed.', ['Do not rerun the test.'], 'review', 'no acceptable fix endorsed; not counted: rerun (rejected: "rerun" negated: negator_before)'],
    // Joined, v10's text would read "Do not change the code run the test again": the negation stays in its step.
    ['S09', 'No further change is needed.', ['Do not change the code', 'run the test again'], 'pass', 'matched rerun (in verificationSteps)'],
    // A negated step and a positive one of the same criterion: unresolved, not a positive-wins.
    ['S09', 'No further change is needed.', ['Do not rerun the flaky step', 'Run the test again.'], 'review', 'no acceptable fix endorsed; not counted: rerun (unresolved: "rerun" negated: negator_before, "Run the test again" positive: no_negation)'],
    // Multi-line and code-containing fixes.
    ['S12', 'Capture the popup:\n```ts\nconst popup = await page.waitForEvent(\'popup\');\n```', undefined, 'pass', 'matched capture-popup'],
    ['S11', '1. Do not change the CSS.\n2. Hover over the photo first.', undefined, 'pass', 'matched hover-first'],
  ];
  for (const [scenario, fix, steps, status, detail] of CASES) {
    test(`${scenario}: ${JSON.stringify(fix)}${steps ? ` + steps ${JSON.stringify(steps)}` : ''} → ${status}`, async () => {
      const r = await scoreWith(scenario, fix, steps);
      assert.deepEqual(acceptableOf(r), { id: 'acceptable', status, detail, tag: 'acceptable' });
      assert.equal(r.acceptance.status, status === 'pass' && checkOf(r, 'recommendation').status === 'pass' ? 'accepted' : 'pending_review', JSON.stringify(checkOf(r, 'recommendation').items));
    });
  }

  test('S10 stays not applicable: no acceptable fixes, no forbidden ones', async () => {
    const r = await scoreWith('S10', 'Do not fix anything.');
    assert.equal(checkOf(r, 'recommendation').status, 'not_applicable');
  });

  test('a truncated analysis is never an endorsement; a discounted criterion is never listed as matched; details stay bounded', async () => {
    // 80 matches of fix-server: over maxMatches, so unresolved even though positive matches were seen.
    const r = await scoreWith('S13', `${"Fix the server. Don't fix the server. ".repeat(40)}Add waitForResponse.`);
    const { detail, status } = acceptableOf(r);
    assert.equal(status, 'review');
    assert.match(detail, /^only a supporting recommendation matched \(check-status\); no corrective fix endorsed \(fix-server, keep-test\); not counted: fix-server \(unresolved: .*, 47 more, analysis incomplete\)$/);
    assert.ok(detail.length <= 600, `${detail.length} characters`);
    // Within the limits, the same retraction is a conflict.
    assert.match(acceptableOf(await scoreWith('S13', "Fix the server. Don't fix the server. ".repeat(4))).detail, /^no acceptable fix endorsed; not counted: fix-server \(conflict: .*, 5 more\)$/);
  });

  test('truncation invariant: a positive match before the limit never endorses when the contradiction lies beyond it', async () => {
    const early = 'Fix the server. ';
    const late = 'Do not fix the server.';
    // maxMatches: 60 more fix-server matches between the early positive and the late negation.
    const byMatches = `${early}${'Check the backend. '.repeat(60)}${late}`;
    // maxClauses: the late negation sits after more clauses than the analysis reads.
    const byClauses = `${early.replace('. ', '; ')}${'wait, '.repeat(POLARITY_LIMITS.maxClauses + 5)}${late}`;
    for (const [limit, fix] of [['maxMatches', byMatches], ['maxClauses', byClauses]] as const) {
      const r = await scoreWith('S13', fix);
      const { detail, status } = acceptableOf(r);
      assert.equal(status, 'review', limit);
      assert.match(detail, /^no acceptable fix endorsed; not counted: fix-server \(unresolved: .*analysis incomplete\)$/, limit);
      assert.equal(checkOf(r, 'recommendation').status, 'review', limit);
      assert.equal(r.acceptance.status, 'pending_review', limit);
      assert.ok(detail.length <= 600, `${limit}: ${detail.length} characters`);
    }
    // A separate corrective criterion endorsed within the limits still suffices (maxMatches is per pattern) ...
    const independent = await scoreWith('S13', `The test is correct. ${byMatches}`);
    assert.match(acceptableOf(independent).detail, /^matched keep-test; not counted: fix-server \(unresolved: .*analysis incomplete\)$/);
    assert.equal(independent.acceptance.status, 'accepted');
    // ... but a field over maxClauses is incomplete as a whole, so nothing in it endorses.
    const wholeField = await scoreWith('S13', `The test is correct; ${byClauses}`);
    assert.match(acceptableOf(wholeField).detail, /^no acceptable fix endorsed; not counted: fix-server \(unresolved: .*analysis incomplete\); keep-test \(unresolved: .*analysis incomplete\)$/);
    assert.equal(wholeField.acceptance.status, 'pending_review');
  });

  test('monotonic: every counted criterion matched v10\'s regex on the same text', async () => {
    const texts = [...CASES.map(([, fix]) => fix), 'Fix the server; do not mock it.', 'I recommend that you investigate the backend.', 'Re-query the checkbox.', 'Use a locator.', 'Hover over the photo first.'];
    for (let n = 1; n <= 14; n++) {
      const id = `S${String(n).padStart(2, '0')}`;
      const { acceptable } = (await loadGroundTruth(id)).recommendations;
      for (const fix of texts) {
        const item = acceptableOf(await scoreWith(id, fix, ['Run the test again.'])) as { detail: string } | undefined;
        if (!item) continue;
        const counted = /^matched (.*?)(?:; not counted: |$)/.exec(item.detail)?.[1] ?? /^only a supporting recommendation matched \((.*?)\)/.exec(item.detail)?.[1] ?? '';
        for (const label of counted.split(', ').filter(Boolean)) {
          const a = acceptable.find((x) => x.id === label.split(' ')[0])!;
          const where = label.includes('in verificationSteps') ? 'Run the test again.' : fix.replace(/\s+/g, ' ');
          assert.ok(a.anyOf.some((p) => new RegExp(p, 'i').test(where)), `${id}/${a.id} counted without a v10 match in ${JSON.stringify(where)}`);
        }
      }
    }
  });
});

describe('forbidden items with line breaks (scorer v12)', () => {
  // Each scenario's real recommendations replace S02's; with `summary`, its real forbidden claims
  // replace S02's too. Every other check of the 'correct' input passes.
  const inputWith = async (id: string, fix: string, opts: { steps?: string[]; summary?: string } = {}) => {
    const real = await loadGroundTruth(id);
    const input = mutateAnalysis(await inputFor('correct'), (a) => {
      a.proposedFix = fix;
      if (opts.steps) a.verificationSteps = opts.steps;
      if (opts.summary !== undefined) a.failureSummary = opts.summary;
    });
    return withTruth(input, (t) => {
      t.recommendations = real.recommendations;
      if (opts.summary !== undefined) t.rootCause.forbiddenClaims = real.rootCause.forbiddenClaims;
    });
  };
  const itemOf = (r: ScoreRecord, check: CheckId, id: string) => checkOf(r, check).items.find((i) => i.id === id);

  test('without line breaks, or when both readings agree, every detail is that of v11', async () => {
    // Recorded under v11 (75af6a5) for the same texts.
    const inline = await scoreEvaluation(await inputWith('S13', "Restore the report endpoint. Don't mock it - add retries: 2"));
    assert.equal(itemOf(inline, 'recommendation', 'forbidden:retries')?.detail, 'negated recommendation (Hides the failure with retries), not counted: "add retries" in "Don\'t mock it - add retries: 2" (negated: negator_before)');
    const agreed = await scoreEvaluation(await inputWith('S11', 'Hover over the photo first.\n\nDo not use force: true.\n- Instead, hover over the element.'));
    assert.equal(itemOf(agreed, 'recommendation', 'forbidden:force')?.detail, 'negated recommendation (Bypasses actionability checks), not counted: "force: true" in "Do not use force: true" (negated: negator_before)');
    const cross = await scoreEvaluation(await inputWith('S13', 'Restore the report endpoint and increase the', { steps: ['timeout to 60 s.'] }));
    assert.equal(itemOf(cross, 'recommendation', 'forbidden:more-time')?.detail, 'suspicious recommendation (Raises timeouts): "increase the timeout" (matched only across report fields)');
  });

  test('each occurrence is judged on its own: one positive bullet among negated ones is the finding', async () => {
    const r = await scoreEvaluation(await inputWith('S14', "Use a locator.\n- Don't add retries\n- add retries: 2\n- Don't add retries"));
    assert.deepEqual(itemOf(r, 'recommendation', 'forbidden:retries'), { id: 'forbidden:retries', status: 'review', detail: 'suspicious recommendation (Relies on retries): "add retries" in "- add retries: 2" (positive: no_negation)', tag: 'forbidden' });
    assert.equal(r.acceptance.status, 'pending_review');
  });

  test('a line-break finding serializes and aggregates like any forbidden hit', async () => {
    const lined = await scoreEvaluation(await inputWith('S13', "Restore the report endpoint.\n- Don't mock it\n- add retries: 2"));
    const plain = await scoreEvaluation(await inputWith('S13', 'Restore the report endpoint.'));
    for (const r of [lined, plain]) assert.deepEqual(ScoreRecord.parse(JSON.parse(JSON.stringify(r))), r);
    const summary = aggregate(
      { formatVersion: 1, runId: 'lines', createdAt: '2026-11-14T00:00:00.000Z', source: 'scorer_validation', description: '' },
      [
        { record: { ...lined, evalId: 'S02-01' }, sha256: 'a'.repeat(64) },
        { record: { ...plain, evalId: 'S02-02' }, sha256: 'b'.repeat(64) },
      ],
      null,
    );
    assert.deepEqual(summary.automatic.recommendation, { passed: { count: 1, of: 2 }, acceptableMatched: { count: 2, of: 2 }, forbiddenHits: 1 });
    assert.deepEqual(summary.automatic.acceptance.statuses, { accepted: 1, not_accepted: 0, pending_review: 1 });
  });

  test('monotonic: every review trigger of the v11 reading is still a review in v12, for claims and recommendations', async () => {
    const recs: [fix: string, steps?: string[]][] = [
      ['Do not add retries; add a sleep instead.'],
      ['Another report suggested to increase the timeout, but that would hide the defect.'],
      ['Fix the report endpoint. Do not change anything else and increase the timeout.'],
      ["Use a locator.\n- Don't add retries\n- add retries: 2\n- Don't add retries"],
      ['Use a locator. Another engineer suggested several things\n\nDo not increase the timeout.'],
      ['If the backend may be flaky\n\n- do not add retries or a sleep'],
      ["Restore the report endpoint.\n- Don't mock it\n- add retries: 2"],
      ['Never use force: true or\nwaitForTimeout.'],
      ["Click with { force: true },\n\nthen page.route('**/api') to mock the endpoint."],
      [`${'Do not add a sleep. '.repeat(55)}Add a sleep.`],
      ['Restore the report endpoint and increase the', ['timeout to 60 seconds.']],
    ];
    const claims = ['It is not a race condition.\n- a race condition in the reset', 'A teammate said\n\n- it is not a race condition', 'The checkbox is not missing\n- the checkbox is missing', 'If the app may be broken\n\nthe app is not broken.'];
    const flat = (t: string) => t.replace(/\s+/g, ' ');
    // The v11 reading's triggers: a non-negated per-field match, a truncation, or a match only in the joined text.
    const triggers = (pattern: string, fields: string[]) => {
      const results = fields.map((f) => evaluatePolarity(pattern, flat(f)));
      const joinedOnly = results.every((r) => r.matches.length === 0) && new RegExp(pattern, 'i').test(flat(fields.join('\n')));
      return { open: joinedOnly || results.some((r) => r.matches.some((m) => m.polarity !== 'negated')), truncated: results.some((r) => r.truncated.length > 0) };
    };
    let checked = 0;
    for (let n = 1; n <= 14; n++) {
      const id = `S${String(n).padStart(2, '0')}`;
      const truth = await loadGroundTruth(id);
      const cases: { fix: string; steps?: string[]; summary?: string }[] = [...recs.map(([fix, steps]) => ({ fix, steps })), ...claims.map((summary) => ({ fix: 'Fix it.', summary }))];
      for (const c of cases) {
        const input = await inputWith(id, c.fix, c);
        const r = await scoreEvaluation(input);
        const a = (input.result as { value: { investigations: { analysis: ModelInvestigation }[] } }).value.investigations[0]!.analysis;
        const groups = [
          { check: 'recommendation' as const, list: truth.recommendations.forbidden, fields: [a.proposedFix, ...a.verificationSteps] },
          ...(c.summary !== undefined ? [{ check: 'root_cause' as const, list: truth.rootCause.forbiddenClaims, fields: [a.failureSummary, ...a.analysis.map((x) => x.point), a.confidence.justification] }] : []),
        ];
        for (const g of groups) {
          for (const f of g.list.filter((x) => (x.severity ?? 'review') === 'review')) {
            const v11 = triggers(f.pattern, g.fields);
            const where = `${id} ${g.check} ${f.id} on ${JSON.stringify(c.summary ?? c.fix).slice(0, 80)}`;
            // A forbidden_negated audit item (status pass) is not a review.
            if (v11.open) assert.equal(itemOf(r, g.check, `forbidden:${f.id}`)?.status, 'review', where);
            if (v11.truncated) assert.equal(itemOf(r, g.check, 'forbidden-analysis')?.status, 'review', where);
            if (v11.open || v11.truncated) checked++;
          }
        }
      }
    }
    assert.ok(checked >= 100, `only ${checked} v11 triggers checked`);
  });
});

describe('isolation outcomes', () => {
  test('a canary in the transcript is a confirmed violation, never printed', () => {
    const r = score('leak');
    assert.equal(r.category, 'confirmed_violation');
    assert.deepEqual(r.audit.violations.map((v) => v.kind).sort(), ['canary', 'protected-path']);
    assert.ok(!JSON.stringify(r).includes(truthS02.canary));
    assert.deepEqual(r.classification.tests, [], 'a leaked run is not scored');
  });

  test('a successful read inside a protected root is a confirmed violation even without a canary', () => {
    const r = score('protectedRead');
    assert.equal(r.category, 'confirmed_violation');
    assert.deepEqual(r.audit.violations.map((v) => v.kind), ['protected-path']);
  });

  test('a denied protected attempt and an outside path stay warnings requiring review', () => {
    const r = score('suspiciousPaths');
    assert.equal(r.category, 'needs_review');
    assert.deepEqual(r.audit.suspicious.map((s) => s.kind), ['protected-path', 'outside-workspace']);
    assert.match(r.audit.suspicious[0]!.detail, /attempt did not succeed/);
  });

  test('a changed workspace file is a confirmed violation', () => {
    assert.deepEqual(score('tampering').audit.violations.map((v) => v.kind), ['tampering']);
  });

  test("the SDK's StructuredOutput retry is recorded as expected, not suspicious, and the run is accepted", async () => {
    const r = scoreEvaluation(await withStructuredOutputRetry());
    assert.equal(r.category, 'scored', r.reasons.join('; '));
    assert.equal(r.audit.verdict, 'clean');
    assert.deepEqual(r.audit.suspicious, []);
    assert.deepEqual(
      r.audit.expected.map((e) => [e.toolUseId, e.detail.split('; ')[1]]),
      [
        ['toolu_fixture01', 'rejected with an error result (validation), retried by the model'],
        ['toolu_fixture02', 'accepted'],
      ],
    );
    assert.deepEqual(r.review, { needed: false, reasons: [] });
    assert.equal(r.acceptance.status, 'accepted');
    assert.equal(r.metrics.toolCalls, score('correct').metrics.toolCalls! + 2, 'still counted as tool calls');
  });

  describe('a Bash variable assigned after && (the live S04 shape)', () => {
    const DENIED = "Permission to use Bash has been denied because Claude Code is running in don't ask mode.";
    const s04 = (root: string) =>
      `cd "${root.replaceAll('\\', '/')}" && T=test-results/x/trace.zip; unzip -l $T; echo ---; unzip -p $T '*.network' | head -n 40; echo ---; unzip -p $T '*.trace' | head -n 30`;

    test('denied by the permission system and never run: dismissed, visible, and the run is accepted', async () => {
      const r = scoreEvaluation(await withBashCall(s04, { result: DENIED, isError: true, denied: true }));
      assert.equal(r.audit.verdict, 'clean');
      assert.deepEqual(r.audit.suspicious, []);
      assert.deepEqual(r.audit.dismissed.map((d) => [d.kind, d.toolUseId]), Array(3).fill(['conditional-expansion', 'toolu_bash']));
      assert.match(r.audit.dismissed[0]!.detail, /denied by the permission system and never ran$/);
      assert.equal(r.category, 'scored', r.reasons.join('; '));
      assert.equal(r.acceptance.status, 'accepted');
    });

    test('a call that ran keeps the warnings: the inherited fallback is unknown', async () => {
      const r = scoreEvaluation(await withBashCall(s04, { result: 'Archive: ...', isError: false, denied: false }));
      assert.deepEqual(r.audit.suspicious.map((s) => s.kind), Array(3).fill('conditional-expansion'));
      assert.deepEqual(r.audit.dismissed, []);
      assert.equal(r.category, 'needs_review');
    });

    test('an error result without a recorded permission denial (the command ran and failed) keeps the warnings', async () => {
      const r = scoreEvaluation(await withBashCall(s04, { result: 'unzip: cannot find', isError: true, denied: false }));
      assert.deepEqual(r.audit.suspicious.map((s) => s.kind), Array(3).fill('conditional-expansion'));
    });

    test('a denied call does not dismiss an expansion the audit cannot resolve', async () => {
      const r = scoreEvaluation(await withBashCall(() => 'ls $HOME/.claude', { result: DENIED, isError: true, denied: true }));
      assert.deepEqual(r.audit.suspicious.map((s) => s.kind), ['unresolved-path']);
      assert.deepEqual(r.audit.dismissed, []);
      assert.equal(r.category, 'needs_review');
    });
  });

  test('without outputFormat in the recorded session options, the same calls stay suspicious', async () => {
    const input = await withStructuredOutputRetry();
    const outcome = structuredClone((input.outcome as { value: RunOutcome }).value);
    delete outcome.preflight.session!.outputFormatSha256;
    const r = scoreEvaluation({ ...input, outcome: { ok: true, value: outcome } });
    assert.equal(r.category, 'needs_review');
    assert.deepEqual(r.audit.suspicious.map((s) => s.kind), ['unexpected-tool', 'unexpected-tool']);
    assert.deepEqual(r.acceptance.pending, ['audit']);
  });
});

describe('workspace cleanup (infrastructure only)', () => {
  const withCleanup = async (cleanup: RunOutcome['cleanup']) => {
    const input = await inputFor('correct');
    const outcome = structuredClone((input.outcome as { value: RunOutcome }).value);
    return scoreEvaluation({ ...input, outcome: { ok: true, value: { ...outcome, cleanup } } });
  };

  test('a failed removal is recorded but changes neither category nor acceptance', async () => {
    const r = await withCleanup({ removed: false, error: 'EBUSY: resource busy or locked, rmdir', attempts: 13, elapsedMs: 10_050, transient: Array(12).fill('EBUSY') });
    assert.deepEqual(r.cleanup, { status: 'failed', attempts: 13, elapsedMs: 10_050, transient: Array(12).fill('EBUSY'), error: 'EBUSY: resource busy or locked, rmdir' });
    assert.equal(r.category, 'scored');
    assert.equal(r.acceptance.status, 'accepted');
  });

  test('a removal that needed retries is visible as such', async () => {
    assert.equal((await withCleanup({ removed: true, error: null, attempts: 3, elapsedMs: 300, transient: ['EBUSY', 'EBUSY'] })).cleanup.status, 'removed_after_retry');
    assert.equal((await withCleanup({ removed: true, error: null, attempts: 1, elapsedMs: 5, transient: [] })).cleanup.status, 'removed');
  });

  test('outcomes saved before attempts were recorded still score (the first live S02 run)', async () => {
    const r = await withCleanup({ removed: false, error: "EBUSY: resource busy or locked, rmdir 'C:\\x\\ws-a\\project'" });
    assert.deepEqual(r.cleanup, { status: 'failed', attempts: null, elapsedMs: null, transient: [], error: "EBUSY: resource busy or locked, rmdir 'C:\\x\\ws-a\\project'" });
    assert.equal(score('setupFailure').cleanup.status, 'no_workspace');
  });
});

describe('execution and setup outcomes', () => {
  test('MCP unavailable when the scenario does not expect it is an execution/setup failure', () => {
    const r = score('mcpUnavailable');
    assert.equal(r.runStatus, 'mcp_unavailable');
    assert.equal(r.category, 'invalid_setup');
    assert.match(r.reasons.join(' '), /execution\/setup failure/);
  });

  test('MCP unavailable when the scenario expects it is scored', async () => {
    const input = withTruth(await inputFor('mcpUnavailable'), (t) => {
      t.expected = { ...t.expected, reportStatus: 'mcp_unavailable', tests: [], classification: null };
      t.requiredEvidence = [];
    });
    const r = scoreEvaluation(input);
    assert.equal(r.category, 'scored', r.reasons.join('; '));
    assert.equal(status(r, 'report_status'), 'pass');
    assert.equal(r.acceptance.status, 'accepted');
  });

  test('missing Skill invocation and missing MCP calls are unverified', () => {
    assert.equal(score('missingSkill').category, 'unverified');
    assert.match(checkOf(score('missingSkill'), 'process').detail, /SKILL\.md was read as a file instead/);
    assert.equal(score('missingMcp').category, 'unverified');
    assert.equal(only(score('missingMcp')).verdict, 'missing');
  });

  test('invalid output, timeout, session and auth errors, setup failure', () => {
    assert.equal(score('invalidOutput').category, 'invalid_output');
    assert.equal(score('timeout').category, 'timeout');
    assert.equal(score('sessionError').category, 'session_error');
    assert.equal(score('authRefused').category, 'session_error');
    assert.equal(score('setupFailure').category, 'invalid_setup');
    assert.equal(status(score('setupFailure'), 'structured_output'), 'not_applicable');
  });

  test('fingerprint mismatch and a changed snapshot are invalid setup', () => {
    assert.ok(score('fingerprintMismatch').setup.problems.some((p) => /the session read report ffffffffffff/.test(p)));
    assert.ok(score('snapshotChanged').setup.problems.includes('the snapshot manifest changed since the run (manifest sha256 differs)'));
  });

  test('metrics come from the saved result and transcript', () => {
    assert.deepEqual(score('correct').metrics, { wallClockMs: 45000, durationMs: 20000, numTurns: 7, inputTokens: 1500, outputTokens: 200, estimatedUsageCostUsd: 0.0512, toolCalls: 5, permissionDenials: 0 });
  });
});

describe('multiple-test scenarios', () => {
  test('each expected test keeps its own verdict; nothing is collapsed to the worst case', async () => {
    const r = scoreEvaluation(await secondTestInput('Application defect'));
    assert.deepEqual(
      r.classification.tests.map((t) => [t.title, t.verdict, t.highConfidenceIncorrect]),
      [
        ['signs in with valid credentials', 'exact', false],
        ['signs out', 'incorrect', true],
      ],
    );
    assert.deepEqual(
      checkOf(r, 'classification').items.map((i) => [i.id, i.status]),
      [
        ['signs in with valid credentials', 'pass'],
        ['signs out', 'fail'],
      ],
    );
    assert.equal(r.acceptance.status, 'not_accepted');
    assert.deepEqual(r.acceptance.blockers.filter((b) => b.startsWith('classification')), ['classification of "signs out": incorrect']);
  });
});

describe('ground truth version protection', () => {
  test('the truth hash captured before the run must match the truth used for scoring', async () => {
    const input = await inputFor('correct');
    const outcome = structuredClone((input.outcome as { value: RunOutcome }).value);
    outcome.preflight.truthSha256 = 'a'.repeat(64);
    const r = scoreEvaluation({ ...input, outcome: { ok: true, value: outcome } });
    assert.equal(r.category, 'invalid_setup');
    assert.match(r.setup.problems.join(' '), /ground truth changed since the run \(captured aaaaaaaaaaaa, current [0-9a-f]{12}\)/);
  });

  test('a finished session without a captured truth hash is invalid setup', async () => {
    const input = await inputFor('correct');
    const outcome = structuredClone((input.outcome as { value: RunOutcome }).value);
    outcome.preflight.truthSha256 = null;
    assert.ok(scoreEvaluation({ ...input, outcome: { ok: true, value: outcome } }).setup.problems.includes('the ground truth hash was not captured before the session'));
  });

  test('a repository change during the session is a confirmed violation', async () => {
    const input = await inputFor('correct');
    const outcome = structuredClone((input.outcome as { value: RunOutcome }).value);
    outcome.repo.unchanged = false;
    const r = scoreEvaluation({ ...input, outcome: { ok: true, value: outcome } });
    assert.equal(r.category, 'confirmed_violation');
    assert.deepEqual(r.audit.violations.map((v) => v.kind), ['repo-changed']);
  });

  test('a stored v3 score explains the version change and what it does to the verdict', async () => {
    const copy = path.join(base, 'v3-copy');
    await cp(runDir, copy, { recursive: true });
    const file = path.join(copy, ids.correct!, SCORE_FILE);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...stored, scorerVersion: 3, category: 'needs_review', audit: { ...stored.audit, verdict: 'suspicious' } }, null, 2) + '\n');
    await assert.rejects(scoreRun(copy, { snapshotsRoot }), (e: unknown) => {
      assert.ok(e instanceof ScoreConflictError);
      assert.deepEqual(e.changes.find((c) => c.evalId === ids.correct)!.reasons, [`scorer version changed (3 -> ${SCORER_VERSION})`, 'category needs_review -> scored', 'audit suspicious -> clean']);
      return true;
    });
  });

  test('re-scoring with unchanged inputs is byte-identical and allowed', async () => {
    const before = await readFile(path.join(runDir, ids.correct!, SCORE_FILE), 'utf8');
    const { rescored } = await scoreRun(runDir, { snapshotsRoot });
    assert.deepEqual(rescored, []);
    assert.equal(await readFile(path.join(runDir, ids.correct!, SCORE_FILE), 'utf8'), before);
  });

  test('a changed truth.json is refused without --rescore, and nothing is written', async (t) => {
    const scenariosRoot = await changedTruthRoot(t);
    const before = await readFile(path.join(runDir, ids.correct!, SCORE_FILE), 'utf8');
    await assert.rejects(scoreRun(runDir, { snapshotsRoot, scenariosRoot }), (e: unknown) => {
      assert.ok(e instanceof ScoreConflictError);
      assert.ok(e.changes.length > 0);
      assert.match(e.changes.find((c) => c.evalId === ids.correct)!.reasons[0]!, /^truth\.json changed \(scored with [0-9a-f]{12}, current [0-9a-f]{12}\)$/);
      return true;
    });
    assert.equal(await readFile(path.join(runDir, ids.correct!, SCORE_FILE), 'utf8'), before, 'score.json untouched');
  });

  test('--rescore after a truth change archives the original; the rescored run is invalid (truth differs from the one it ran with)', async (t) => {
    const copy = path.join(base, 'rescore-copy');
    await cp(runDir, copy, { recursive: true });
    const scenariosRoot = await changedTruthRoot(t);
    const original = await readFile(path.join(copy, ids.correct!, SCORE_FILE), 'utf8');
    const { records: fresh, rescored } = await scoreRun(copy, { snapshotsRoot, scenariosRoot, rescore: true });
    assert.ok(rescored.some((c) => c.evalId === ids.correct));
    const history = await readdir(path.join(copy, ids.correct!, SCORE_HISTORY_DIR));
    assert.equal(history.length, 1);
    assert.match(history[0]!, new RegExp(`^score\\.v${SCORER_VERSION}\\.truth-[0-9a-f]{12}\\.[0-9a-f]{8}\\.json$`));
    assert.equal(await readFile(path.join(copy, ids.correct!, SCORE_HISTORY_DIR, history[0]!), 'utf8'), original, 'original kept byte for byte');
    const now = fresh.find((r) => r.evalId === ids.correct)!;
    assert.notEqual(now.inputs.truthSha256, JSON.parse(original).inputs.truthSha256);
    assert.equal(now.category, 'invalid_setup');
    assert.match(now.setup.problems.join(' '), /ground truth changed since the run/);
    // A second --rescore with the same truth changes nothing and archives nothing new.
    assert.deepEqual((await scoreRun(copy, { snapshotsRoot, scenariosRoot, rescore: true })).rescored, []);
    assert.equal((await readdir(path.join(copy, ids.correct!, SCORE_HISTORY_DIR))).length, 1);
  });
});

describe('scoreEvaluation edge cases', () => {
  test('a missing or invalid snapshot makes the run invalid setup', async () => {
    const r = scoreEvaluation({ ...(await inputFor('correct')), snapshot: { ok: false, error: 'hash mismatch: tests/ui/login.spec.ts' } });
    assert.equal(r.category, 'invalid_setup');
  });

  test('result.json that disagrees with the transcript is refused', async () => {
    const input = await inputFor('correct');
    const result = structuredClone((input.result as { value: any }).value);
    result.investigations[0].analysis.classification = 'Application defect';
    const r = scoreEvaluation({ ...input, result: { state: 'ok', value: result } });
    assert.ok(r.setup.problems.includes("result.json does not match the transcript's structured output"));
  });

  test('a session option outside the allowed evaluation changes is invalid setup', async () => {
    const input = await inputFor('correct');
    const outcome = structuredClone((input.outcome as { value: RunOutcome }).value);
    outcome.configDifferences!.options.push({ path: 'allowedTools', baseline: ['Read'], evaluation: ['Read', 'Write'] });
    const r = scoreEvaluation({ ...input, outcome: { ok: true, value: outcome } });
    assert.match(r.setup.problems.join(' '), /allowedTools differs from the baseline/);
  });

  test('an unreadable outcome.json still yields a valid ScoreRecord', async () => {
    const r = scoreEvaluation({ ...(await inputFor('correct')), outcome: { ok: false, error: 'outcome.json is missing' } });
    assert.equal(r.category, 'invalid_setup');
    ScoreRecord.parse(r);
  });

  test('every record lists all checks in order', () => {
    for (const r of records.values()) assert.deepEqual(r.checks.map((c) => c.id), [...CHECK_IDS]);
  });
});

// ---------------------------------------------------------------------------

function successWith(inv: ModelInvestigation) {
  return success(report('investigated', [inv], 'Investigated one failed test.'));
}

function bashCall(id: string, command: string): SDKMessage[] {
  return [
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } } as unknown as SDKMessage,
    { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: [{ type: 'text', text: 'source' }] }] } } as unknown as SDKMessage,
  ];
}

/** The saved files of one mixed-run evaluation, read back as a ScoreInput. */
/** The correct run with the real StructuredOutput retry events (see isolation.test.ts) before its result. */
async function withStructuredOutputRetry(): Promise<ScoreInput> {
  const input = await inputFor('correct');
  const events = (await readFile(new URL('./fixtures/structured-output-retry.jsonl', import.meta.url), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((m) => m.type !== 'system');
  const transcript = transcriptOf(input) as any[];
  transcript[0].tools = [...transcript[0].tools, 'StructuredOutput'];
  transcript.splice(transcript.length - 1, 0, ...events);
  return { ...input, transcript: { state: 'ok', value: transcript } };
}

/** The correct run plus one Bash call before the final result; `denied` also records it in permission_denials. */
async function withBashCall(command: (root: string) => string, call: { result: string; isError: boolean; denied: boolean }): Promise<ScoreInput> {
  const input = await inputFor('correct');
  const root = (input.outcome as { value: RunOutcome }).value.workspace!.root;
  const bashInput = { command: command(root), description: 'x' };
  const transcript = transcriptOf(input) as any[];
  const final = { ...transcript.at(-1), permission_denials: call.denied ? [{ tool_name: 'Bash', tool_use_id: 'toolu_bash', tool_input: bashInput }] : [] };
  transcript.splice(-1, 1, toolUse('toolu_bash', 'Bash', bashInput), toolResult('toolu_bash', call.result, call.isError), final);
  return { ...input, transcript: { state: 'ok', value: transcript } };
}

async function inputFor(name: string): Promise<ScoreInput> {
  const dir = path.join(runDir, ids[name]!);
  const [outcome, result, transcript] = await Promise.all([OUTCOME_FILE, RESULT_FILE, TRANSCRIPT_FILE].map((f) => readFile(path.join(dir, f), 'utf8')));
  const truthText = await readFile(path.join(SCENARIOS_DIR, 'S02', 'truth.json'), 'utf8');
  return {
    evalId: ids[name]!,
    outcome: { ok: true, value: RunOutcome.parse(JSON.parse(outcome!)) },
    result: { state: 'ok', value: JSON.parse(result!) },
    resultSha256: sha256(result!),
    transcript: { state: 'ok', value: transcript!.trim() ? transcript!.trim().split('\n').map((l) => JSON.parse(l)) : [] },
    transcriptSha256: sha256(transcript!),
    truth: { ok: true, value: structuredClone(truthS02), sha256: sha256(truthText) },
    snapshot: await snapshotInfo('S02', snapshotsRoot),
    markers,
  };
}

const transcriptOf = (input: ScoreInput) => structuredClone((input.transcript as { value: SDKMessage[] }).value);

/** An edited truth, as if the run had captured that truth's hash before the session. */
function withTruth(input: ScoreInput, edit: (t: GroundTruth) => void): ScoreInput {
  const truth = structuredClone((input.truth as { value: GroundTruth }).value);
  edit(truth);
  const outcome = structuredClone((input.outcome as { value: RunOutcome }).value);
  outcome.preflight.truthSha256 = 'e'.repeat(64);
  return { ...input, outcome: { ok: true, value: outcome }, truth: { ok: true, value: truth, sha256: 'e'.repeat(64) } };
}

/** Applies the same edit to the analysis in result.json and in the transcript's structured output, keeping them consistent. */
function mutateAnalysis(input: ScoreInput, edit: (a: ModelInvestigation) => void, index = 0): ScoreInput {
  const result = structuredClone((input.result as { value: any }).value);
  const transcript = transcriptOf(input);
  edit(result.investigations[index].analysis);
  edit((transcript.at(-1) as any).structured_output.investigations[index]);
  return { ...input, result: { state: 'ok', value: result }, transcript: { state: 'ok', value: transcript } };
}

/** The correct run plus a second observed failing test ("signs out") with the given classification. */
async function secondTestInput(classification: ModelInvestigation['classification']): Promise<ScoreInput> {
  const input = withTruth(await inputFor('correct'), (t) => t.expected.tests.push({ title: 'signs out', file: 'tests/ui/login.spec.ts' }));
  const transcript = transcriptOf(input);
  const result = structuredClone((input.result as { value: any }).value);
  const detailsMsg = transcript.find((m: any) => m.type === 'user' && m.message.content[0]?.tool_use_id === 'details-1') as any;
  const first = JSON.parse(detailsMsg.message.content[0].content[0].text);
  const testId = first.testId.replace(/^[^@]+/, 'cccccccccccccccccccc-dddddddddddddddddddd');
  const second = { ...first, testId, title: 'signs out', titlePath: ['signs out'] };
  const messages = [
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'details-2', name: 'mcp__test-detective__get_failure_details', input: { testId } }] } },
    { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'details-2', is_error: false, content: [{ type: 'text', text: JSON.stringify(second) }] }] } },
  ] as unknown as SDKMessage[];
  transcript.splice(transcript.length - 1, 0, ...messages);
  const analysis: ModelInvestigation = { ...result.investigations[0].analysis, testId, classification };
  (transcript.at(-1) as any).structured_output.investigations.push(analysis);
  result.investigations.push({ facts: { ...result.investigations[0].facts, testId, title: 'signs out' }, analysis });
  return { ...input, result: { state: 'ok', value: result }, transcript: { state: 'ok', value: transcript } };
}

/** A copy of the scenarios with S02's truth.json edited (description only). */
async function changedTruthRoot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'td-truth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(SCENARIOS_DIR, root, { recursive: true });
  const file = path.join(root, 'S02', 'truth.json');
  const truth = JSON.parse(await readFile(file, 'utf8'));
  truth.description += ' (edited)';
  await writeFile(file, JSON.stringify(truth, null, 2));
  return root;
}
