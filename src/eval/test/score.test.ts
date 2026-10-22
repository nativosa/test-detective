import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInvestigation } from '../../agent/result.ts';
import { report, success, toolResult, toolUse } from '../../agent/test/helpers.ts';
import { leakMarkers } from '../isolation.ts';
import { OUTCOME_FILE, RESULT_FILE, RunOutcome, SCORE_FILE, SCORE_HISTORY_DIR, ScoreConflictError, scoreRun, snapshotInfo, TRANSCRIPT_FILE } from '../runs.ts';
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
    for (const c of r.checks) assert.equal(c.status, 'pass', `${c.id}: ${c.detail}`);
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
        session: (f) => {
          const inv = correctInvestigation(f);
          inv.evidence = inv.evidence.map((e) => (e.kind === 'trace' ? { ...e, status: 'not_available', note: 'No trace attachment' } : e));
          // The correct stream with its final report swapped.
          return { messages: [...VARIANTS.correct!.session(f).messages.slice(0, -1), successWith(inv)] };
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
