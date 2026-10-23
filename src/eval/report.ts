import * as z from 'zod';
import { CLASSIFICATIONS } from '../agent/result.ts';
import type { RunManifest } from './runs.ts';
import { ACCEPTANCE_STATUSES, acceptanceOf, CATEGORIES, CHECK_IDS, CHECK_STATUSES, CLASSIFICATION_VERDICTS, ELIGIBLE_CATEGORIES, TRACE_ACQUISITIONS, TRACE_CALL_STATUSES } from './score.ts';
import type { Category, CheckId, CheckStatus, ClassificationVerdict, ScoreRecord } from './score.ts';
import { CONFIDENCE_LEVELS } from './truth.ts';

// Offline aggregation of ScoreRecords into summary.json and summary.md. Pure: no I/O, no clock.
//
// Two separate diagnostic metrics, never merged into one number:
// - classification agreement: per eligible investigation (one per expected test), with the
//   verdict categories kept apart and pending reviews counted;
// - fully accepted diagnosis rate: per eligible run, every check passed and every review resolved.
//
// Human review never edits score.json. A review is applied on top of the automatic verdict, and
// the summary reports both: `automatic` (score files only) and `reviewed` (with reviews applied).

/**
 * Checks a reviewer may decide; the others are exact comparisons that review cannot change.
 * `classification` only for a reviewable alternative: a reviewer decides whether that alternative
 * is defensible. An exact, incorrect or abstained verdict is never changed by review.
 */
export const REVIEWABLE_CHECKS = ['coverage', 'classification', 'root_cause', 'evidence_validity', 'evidence_sufficiency', 'citations', 'trace_consistency', 'recommendation'] as const satisfies readonly CheckId[];

const Review = z.strictObject({
  evalId: z.string().regex(/^S\d{2}-\d{2}$/),
  reviewer: z.string().min(1),
  reviewedAt: z.iso.date(),
  scoreSha256: z.string().regex(/^[0-9a-f]{64}$/).describe('sha256 of the score.json the reviewer looked at; a re-scored file makes the review stale'),
  checks: z
    .partialRecord(z.enum(REVIEWABLE_CHECKS), z.strictObject({ status: z.enum(['pass', 'partial', 'fail']), note: z.string().min(1) }))
    .default({}),
  audit: z
    .strictObject({ verdict: z.enum(['clean', 'violation']), note: z.string().min(1) })
    .optional()
    .describe('Resolves suspicious audit findings. A confirmed violation cannot be cleared.'),
  note: z.string(),
});
export type Review = z.infer<typeof Review>;

export const ReviewFile = z
  .strictObject({ formatVersion: z.literal(1), reviews: z.array(Review) })
  .refine((f) => new Set(f.reviews.map((r) => r.evalId)).size === f.reviews.length, 'one review per evalId');
export type ReviewFile = z.infer<typeof ReviewFile>;

// ---------------------------------------------------------------------------
// Summary schema

const counts = <T extends readonly string[]>(keys: T) => z.strictObject(Object.fromEntries(keys.map((k) => [k, z.number().int()])) as Record<T[number], z.ZodNumber>);
const Fraction = z.strictObject({ count: z.number().int(), of: z.number().int() });
const Stat = z.strictObject({ total: z.number(), max: z.number().nullable(), reported: z.number().int().describe('Evaluations that reported this value') });

const Metrics = z.strictObject({
  attempted: z.number().int(),
  categories: counts(CATEGORIES),
  eligible: z.number().int().describe('Runs eligible for diagnostic metrics: scored + needs_review'),
  pendingReview: z.number().int().describe('Eligible runs with unresolved reviews (needs_review)'),
  excluded: z.strictObject({ ...counts(CATEGORIES.filter((c) => !ELIGIBLE_CATEGORIES.includes(c))).shape, total: z.number().int() }),
  classification: z.strictObject({
    investigations: z.number().int().describe('Eligible investigations: one per expected test in an eligible run'),
    verdicts: counts(CLASSIFICATION_VERDICTS),
    exact: Fraction,
    pendingReview: z.number().int().describe('Eligible investigations whose run still has unresolved reviews'),
    highConfidenceIncorrect: z.number().int(),
  }),
  acceptance: z.strictObject({
    accepted: Fraction.describe('Fully accepted diagnoses among eligible runs'),
    statuses: counts(ACCEPTANCE_STATUSES.filter((s) => s !== 'not_eligible')),
  }),
  confusion: z.record(z.string(), z.record(z.string(), z.number().int())).describe('expected -> predicted -> count, eligible investigations'),
  calibration: z.record(z.string(), counts(CLASSIFICATION_VERDICTS)).describe('confidence level -> classification verdict'),
  checks: z.record(z.string(), counts(CHECK_STATUSES)).describe('per check, eligible runs'),
  evidence: z.strictObject({
    claims: z.strictObject({
      verified: z.number().int(),
      unresolved: z.number().int(),
      unsupported: z.number().int(),
      confirmedFalse: z.number().int(),
      falseUnavailable: z.number().int(),
      accessDenied: z.number().int().describe('"Not available" claims about a file the permission system denied (scorer v7)'),
    }),
    requiredVerified: Fraction,
    requiredAccessDenied: z.number().int().describe('Required evidence never obtained because every read was denied (scorer v7)'),
    citations: z.strictObject({ verified: z.number().int(), unresolved: z.number().int(), unsupported: z.number().int(), confirmedFalse: z.number().int(), accessDenied: z.number().int() }),
    traceClaims: z
      .strictObject({ consistent: z.number().int(), contradictions: z.number().int(), retryMismatches: z.number().int(), withoutTraceEvidence: z.number().int(), unresolved: z.number().int() })
      .describe('trace_consistency items: structured trace claims compared with get_trace_summary results (scorer v8)'),
  }),
  rootCause: z.strictObject({
    passed: Fraction,
    criteriaMatched: Fraction,
    forbiddenHits: z.number().int().describe('Suspicious claims sent to review'),
    definitiveClaims: z.number().int().describe('Unhedged forbidden claims that failed the check (severity "fail")'),
  }),
  recommendation: z.strictObject({ passed: Fraction, acceptableMatched: Fraction, forbiddenHits: z.number().int() }),
});
export type Metrics = z.infer<typeof Metrics>;

export const PURPOSES = {
  live: 'agent_performance',
  scorer_validation: 'scorer_validation',
} as const;

const Usage = z.strictObject({
  wallClockMs: z.number().nullable(),
  durationMs: z.number().nullable(),
  numTurns: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  estimatedUsageCostUsd: z.number().nullable(),
  toolCalls: z.number().nullable(),
});

export const Summary = z.strictObject({
  formatVersion: z.literal(1),
  runId: z.string().describe('The run, or the combined report name for several runs'),
  source: z.string(),
  purpose: z.enum(['agent_performance', 'scorer_validation']),
  notice: z.string().nullable(),
  reliabilityWarning: z.string().nullable().describe('Agent-performance summaries: how many attempts back each scenario, and that this does not establish reliability'),
  runs: z.array(z.strictObject({ runId: z.string(), evaluations: z.array(z.string()) })).describe('Source runs; more than one for a combined report'),
  scorerVersions: z.array(z.number().int()).describe('Distinct scorer versions of the aggregated scores; more than one is flagged'),
  automatic: Metrics,
  reviewed: Metrics.nullable().describe('With human reviews applied; null when no review was applied'),
  highConfidenceIncorrect: z.array(z.strictObject({ evalId: z.string(), test: z.string(), predicted: z.string(), expected: z.string() })),
  byFailureType: z
    .array(
      z.strictObject({
        failureType: z.string(),
        evaluations: z.number().int(),
        eligible: z.number().int(),
        investigations: z.number().int(),
        exact: z.number().int(),
        reviewableAlternative: z.number().int(),
        accepted: z.number().int(),
      }),
    )
    .describe('Automatic results grouped by the scenario failure type ("unknown" for scores before version 6); counts only'),
  truthVersions: z.array(z.strictObject({ scenarioId: z.string(), truthSha256: z.array(z.string()), consistent: z.boolean() })),
  traceEvidence: z
    .strictObject({
      tests: z.number().int().describe('Expected tests with a recorded trace acquisition (scores from version 8)'),
      acquisition: counts(TRACE_ACQUISITIONS).describe('mcp: get_trace_summary ok/partial; bash: the trace file read by a tool call; not_obtained: kept but never obtained; no_trace: none kept'),
      notRecorded: z.number().int().describe('Evaluations without a trace record (scored before version 8, or not scored diagnostically)'),
      toolStatuses: counts(TRACE_CALL_STATUSES).describe('get_trace_summary calls by result'),
      limitations: z.array(z.strictObject({ evalId: z.string(), test: z.string(), limitation: z.string() })),
    })
    .describe('How trace evidence was obtained, over all evaluations; descriptive, not an acceptance criterion'),
  skillVersions: z
    .array(z.strictObject({ skillSha256: z.string().nullable(), evaluations: z.array(z.string()) }))
    .describe('Investigator Skill (outcome.json preflight.skillSha256) per evaluation; null = not recorded. More than one is flagged'),
  usage: z.strictObject({
    note: z.string(),
    wallClockMs: Stat,
    durationMs: Stat,
    numTurns: Stat,
    inputTokens: Stat,
    outputTokens: Stat,
    estimatedUsageCostUsd: Stat,
    toolCalls: Stat,
  }),
  reliability: z.array(
    z.strictObject({
      scenarioId: z.string(),
      test: z.string(),
      attempts: z.number().int(),
      eligible: z.number().int(),
      predicted: z.array(z.string().nullable()),
      agreement: Fraction.nullable().describe('Most common predicted classification among eligible attempts'),
    }),
  ),
  evaluations: z.array(
    z.strictObject({
      evalId: z.string(),
      runId: z.string(),
      scenarioId: z.string(),
      failureType: z.string().nullable(),
      scorerVersion: z.number().int(),
      truthSha256: z.string().nullable(),
      skillSha256: z.string().nullable().describe('The Skill the session ran with (outcome.json preflight); null = not recorded'),
      model: z.string().nullable().describe('Model ID the session reported; null = not recorded (scores before version 8)'),
      mcpServerVersion: z.string().nullable().describe('test-detective MCP server version; null = not recorded'),
      snapshotFingerprint: z.string().nullable(),
      usage: Usage.describe("This evaluation's metrics from score.json"),
      auditCounts: z.strictObject({ violations: z.number().int(), suspicious: z.number().int(), dismissed: z.number().int() }),
      automaticCategory: z.enum(CATEGORIES),
      reviewedCategory: z.enum(CATEGORIES),
      expected: z.string().nullable(),
      tests: z.array(
        z.strictObject({
          title: z.string(),
          outcome: z.string().nullable().describe('Observed MCP outcome (unexpected, flaky)'),
          predicted: z.string().nullable(),
          confidence: z.string().nullable(),
          verdict: z.string(),
          highConfidenceIncorrect: z.boolean(),
        }),
      ),
      acceptance: z.strictObject({ automatic: z.enum(ACCEPTANCE_STATUSES), reviewed: z.enum(ACCEPTANCE_STATUSES), blockers: z.array(z.string()), pending: z.array(z.string()) }),
      checks: z.record(z.string(), z.strictObject({ automatic: z.enum(CHECK_STATUSES), reviewed: z.enum(CHECK_STATUSES) })),
      review: z.strictObject({
        status: z.enum(['none', 'applied', 'stale', 'partly_rejected']),
        reviewer: z.string().nullable(),
        reviewedAt: z.string().nullable(),
        notes: z.array(z.string()),
      }),
      reasons: z.array(z.string()),
      reviewReasons: z.array(z.string()),
      auditVerdict: z.string(),
      auditExpected: z.array(z.string()).describe('Recognized SDK-internal tool calls (informational)'),
      auditDismissed: z.array(z.string()).describe('Audit findings that cannot have caused access, with the reason (informational)'),
      cleanup: z.strictObject({ status: z.string(), attempts: z.number().int().nullable(), retried: z.number().int(), error: z.string().nullable() }),
      traceAcquisition: z.array(z.strictObject({ test: z.string(), acquisition: z.enum(TRACE_ACQUISITIONS), summaries: z.array(z.string()) })).nullable(),
    }),
  ),
  infrastructure: z
    .strictObject({ cleanup: z.record(z.string(), z.number().int()).describe('workspace cleanup status -> evaluations') })
    .describe('Harness problems that do not affect scoring, e.g. a workspace left behind'),
  reviews: z.strictObject({ applied: z.number().int(), stale: z.number().int(), unknown: z.array(z.string()) }),
});
export type Summary = z.infer<typeof Summary>;

// ---------------------------------------------------------------------------
// Reviews

type Reviewed = {
  category: Category;
  checks: Record<CheckId, CheckStatus>;
  acceptance: ScoreRecord['acceptance'];
  status: 'none' | 'applied' | 'stale' | 'partly_rejected';
  notes: string[];
};

/** The human-reviewed view of one score. The ScoreRecord itself is never modified. */
export function applyReview(record: ScoreRecord, scoreSha256: string, review: Review | undefined): Reviewed {
  const checks = Object.fromEntries(record.checks.map((c) => [c.id, c.status])) as Record<CheckId, CheckStatus>;
  if (!review) return { category: record.category, checks, acceptance: record.acceptance, status: 'none', notes: [] };
  if (review.scoreSha256 !== scoreSha256) {
    return { category: record.category, checks, acceptance: record.acceptance, status: 'stale', notes: ['score.json changed after this review; review not applied'] };
  }
  const notes: string[] = [];
  let rejected = false;
  const eligible = ELIGIBLE_CATEGORIES.includes(record.category);
  const reviewableVerdict = record.classification.tests.some((t) => t.verdict === 'reviewable_alternative');
  for (const [id, decision] of Object.entries(review.checks) as [CheckId, { status: CheckStatus; note: string }][]) {
    if (!eligible) {
      rejected = true;
      notes.push(`${id}: not applied, a ${record.category} evaluation is not scored`);
      continue;
    }
    if (id === 'classification' && !reviewableVerdict) {
      rejected = true;
      notes.push('classification: not applied, review decides only a reviewable alternative');
      continue;
    }
    checks[id] = decision.status;
    notes.push(`${id}: ${record.checks.find((c) => c.id === id)?.status} -> ${decision.status} (${decision.note})`);
  }
  let category = record.category;
  if (review.audit) {
    if (record.audit.verdict === 'violation' && review.audit.verdict === 'clean') {
      rejected = true;
      notes.push('audit: a confirmed violation cannot be cleared by review');
    } else if (review.audit.verdict === 'violation') {
      category = 'confirmed_violation';
      notes.push(`audit: marked as a violation (${review.audit.note})`);
    } else {
      notes.push(`audit: suspicious findings reviewed as clean (${review.audit.note})`);
    }
  }
  const auditOpen = record.audit.verdict === 'suspicious' && review.audit?.verdict !== 'clean';
  if (category === 'needs_review' && !auditOpen && !Object.values(checks).includes('review')) category = 'scored';
  if (review.note) notes.push(review.note);
  return {
    category,
    checks,
    acceptance: acceptanceOf(category, checks, record.classification.tests, auditOpen && category !== 'confirmed_violation'),
    status: rejected ? 'partly_rejected' : 'applied',
    notes,
  };
}

// ---------------------------------------------------------------------------
// Aggregation

/** `runId`: the run the score file belongs to; defaults to the manifest's (a single run). */
/** `skillSha256`: outcome.json preflight.skillSha256 (null or absent = not recorded). */
export type Scored = { record: ScoreRecord; sha256: string; runId?: string; skillSha256?: string | null };
type View = { record: ScoreRecord; category: Category; checks: Record<CheckId, CheckStatus>; acceptance: ScoreRecord['acceptance'] };

/** `manifest` names the summary; for a combined report it is synthesized by runs.ts reportCombined. */
export function aggregate(manifest: RunManifest, scores: Scored[], reviews: ReviewFile | null): Summary {
  const byId = new Map((reviews?.reviews ?? []).map((r) => [r.evalId, r]));
  const views = scores.map(({ record, sha256 }) => ({ record, reviewed: applyReview(record, sha256, byId.get(record.evalId)) }));
  const known = new Set(scores.map((s) => s.record.evalId));
  const applied = views.filter((v) => v.reviewed.status === 'applied' || v.reviewed.status === 'partly_rejected').length;
  const automaticViews: View[] = views.map(({ record }) => ({
    record,
    category: record.category,
    checks: Object.fromEntries(record.checks.map((c) => [c.id, c.status])) as Record<CheckId, CheckStatus>,
    acceptance: record.acceptance,
  }));
  const reviewedViews: View[] = views.map(({ record, reviewed }) => ({ record, category: reviewed.category, checks: reviewed.checks, acceptance: reviewed.acceptance }));
  const purpose = PURPOSES[manifest.source];
  const runOf = (s: Scored) => s.runId ?? manifest.runId;
  const runIds = [...new Set(scores.map(runOf))];

  return Summary.parse({
    formatVersion: 1,
    runId: manifest.runId,
    source: manifest.source,
    purpose,
    notice:
      purpose === 'scorer_validation'
        ? 'Scorer-validation fixtures: synthetic sessions scripted to exercise the scorer. These numbers test the scorer and are NOT measurements of agent performance.'
        : null,
    reliabilityWarning: purpose === 'agent_performance' ? reliabilityWarning(scores.map((s) => s.record)) : null,
    runs: runIds.map((runId) => ({ runId, evaluations: scores.filter((s) => runOf(s) === runId).map((s) => s.record.evalId) })),
    scorerVersions: [...new Set(scores.map((s) => s.record.scorerVersion))].sort((x, y) => x - y),
    automatic: metrics(automaticViews),
    reviewed: applied > 0 ? metrics(reviewedViews) : null,
    highConfidenceIncorrect: reviewedViews
      .filter((v) => ELIGIBLE_CATEGORIES.includes(v.category))
      .flatMap((v) => v.record.classification.tests.filter((t) => t.highConfidenceIncorrect).map((t) => ({ evalId: v.record.evalId, test: t.title, predicted: t.predicted!, expected: v.record.classification.expected! }))),
    byFailureType: byFailureType(automaticViews),
    truthVersions: truthVersions(scores.map((s) => s.record)),
    traceEvidence: traceEvidence(scores.map((s) => s.record)),
    skillVersions: skillVersions(scores),
    usage: usage(scores.map((s) => s.record)),
    reliability: reliability(reviewedViews),
    evaluations: views.map(({ record, reviewed }, i) => ({
      evalId: record.evalId,
      runId: runOf(scores[i]!),
      scenarioId: record.scenarioId,
      failureType: record.failureType,
      scorerVersion: record.scorerVersion,
      truthSha256: record.inputs.truthSha256,
      skillSha256: scores[i]!.skillSha256 ?? null,
      model: record.inputs.model,
      mcpServerVersion: record.inputs.mcpServerVersion,
      snapshotFingerprint: record.inputs.snapshotFingerprint,
      usage: {
        wallClockMs: record.metrics.wallClockMs,
        durationMs: record.metrics.durationMs,
        numTurns: record.metrics.numTurns,
        inputTokens: record.metrics.inputTokens,
        outputTokens: record.metrics.outputTokens,
        estimatedUsageCostUsd: record.metrics.estimatedUsageCostUsd,
        toolCalls: record.metrics.toolCalls,
      },
      auditCounts: { violations: record.audit.violations.length, suspicious: record.audit.suspicious.length, dismissed: record.audit.dismissed.length },
      automaticCategory: record.category,
      reviewedCategory: reviewed.category,
      expected: record.classification.expected,
      tests: record.classification.tests.map((t) => ({ title: t.title, outcome: t.outcome, predicted: t.predicted, confidence: t.confidence, verdict: t.verdict, highConfidenceIncorrect: t.highConfidenceIncorrect })),
      acceptance: { automatic: record.acceptance.status, reviewed: reviewed.acceptance.status, blockers: reviewed.acceptance.blockers, pending: reviewed.acceptance.pending },
      checks: Object.fromEntries(record.checks.map((c) => [c.id, { automatic: c.status, reviewed: reviewed.checks[c.id] }])),
      review: { status: reviewed.status, reviewer: byId.get(record.evalId)?.reviewer ?? null, reviewedAt: byId.get(record.evalId)?.reviewedAt ?? null, notes: reviewed.notes },
      reasons: record.reasons,
      reviewReasons: record.review.reasons,
      auditVerdict: record.audit.verdict,
      auditExpected: record.audit.expected.map((e) => `${e.tool} ${e.toolUseId}: ${e.detail}`),
      auditDismissed: record.audit.dismissed.map((e) => `${e.kind} ${e.tool} ${e.toolUseId}: ${e.detail}`),
      cleanup: { status: record.cleanup.status, attempts: record.cleanup.attempts, retried: record.cleanup.transient.length, error: record.cleanup.error },
      traceAcquisition:
        record.traceEvidence?.tests.map((t) => ({ test: t.title, acquisition: t.acquisition, summaries: t.summaries.map((x) => `retry ${x.retry ?? '?'}: ${x.status}${x.reasons.length ? ` (${x.reasons.join(', ')})` : ''}`) })) ?? null,
    })),
    infrastructure: {
      cleanup: Object.fromEntries(
        [...new Set(scores.map((s) => s.record.cleanup.status))].sort().map((status) => [status, scores.filter((s) => s.record.cleanup.status === status).length]),
      ),
    },
    reviews: {
      applied,
      stale: views.filter((v) => v.reviewed.status === 'stale').length,
      unknown: [...byId.keys()].filter((id) => !known.has(id)),
    },
  });
}

function metrics(views: View[]): Metrics {
  const categories = zero(CATEGORIES);
  for (const v of views) categories[v.category]++;
  const eligible = views.filter((v) => ELIGIBLE_CATEGORIES.includes(v.category));
  const n = eligible.length;
  const excludedKeys = CATEGORIES.filter((c) => !ELIGIBLE_CATEGORIES.includes(c));
  const excluded = { ...Object.fromEntries(excludedKeys.map((c) => [c, categories[c]])), total: views.length - n } as Metrics['excluded'];

  const verdicts = zero(CLASSIFICATION_VERDICTS);
  const confusion: Record<string, Record<string, number>> = {};
  const calibration: Record<string, Record<ClassificationVerdict, number>> = Object.fromEntries(CONFIDENCE_LEVELS.map((l) => [l, zero(CLASSIFICATION_VERDICTS)]));
  let investigations = 0;
  let pendingInvestigations = 0;
  let highConfidenceIncorrect = 0;
  for (const v of eligible) {
    const expected = v.record.classification.expected;
    for (const t of v.record.classification.tests) {
      investigations++;
      if (v.category === 'needs_review') pendingInvestigations++;
      verdicts[t.verdict]++;
      if (t.highConfidenceIncorrect) highConfidenceIncorrect++;
      const row = (confusion[expected!] ??= Object.fromEntries([...CLASSIFICATIONS, 'none'].map((c) => [c, 0])));
      row[t.predicted ?? 'none']!++;
      if (t.confidence) calibration[t.confidence]![t.verdict]++;
    }
  }

  const acceptance = zero(ACCEPTANCE_STATUSES.filter((s) => s !== 'not_eligible'));
  for (const v of eligible) if (v.acceptance.status !== 'not_eligible') acceptance[v.acceptance.status]++;

  const checks: Record<string, Record<CheckStatus, number>> = Object.fromEntries(CHECK_IDS.map((id) => [id, zero(CHECK_STATUSES)]));
  // A score from before a check existed (trace_consistency before version 8) counts it as not applicable.
  for (const v of eligible) for (const id of CHECK_IDS) checks[id]![v.checks[id] ?? 'not_applicable']++;

  const items = (id: CheckId) => eligible.flatMap((v) => v.record.checks.find((c) => c.id === id)?.items ?? []);
  const tagCount = (id: CheckId, tag: string) => items(id).filter((i) => i.tag === tag).length;
  // Required evidence only; acknowledgements of unavailable evidence are not requirements met.
  const sufficiency = items('evidence_sufficiency').filter((i) => i.detail !== 'no investigation' && !i.id.startsWith('unavailable:'));
  const criteria = items('root_cause').filter((i) => i.tag === 'criterion');
  const acceptable = items('recommendation').filter((i) => i.tag === 'acceptable');
  const passed = (id: CheckId) => ({ count: eligible.filter((v) => v.checks[id] === 'pass').length, of: n });

  return Metrics.parse({
    attempted: views.length,
    categories,
    eligible: n,
    pendingReview: categories.needs_review,
    excluded,
    classification: { investigations, verdicts, exact: { count: verdicts.exact, of: investigations }, pendingReview: pendingInvestigations, highConfidenceIncorrect },
    acceptance: { accepted: { count: acceptance.accepted, of: n }, statuses: acceptance },
    confusion,
    calibration,
    checks,
    evidence: {
      claims: {
        verified: tagCount('evidence_validity', 'verified'),
        unresolved: tagCount('evidence_validity', 'unresolved'),
        unsupported: tagCount('evidence_validity', 'unsupported'),
        confirmedFalse: tagCount('evidence_validity', 'confirmed_false'),
        falseUnavailable: tagCount('evidence_validity', 'false_unavailable'),
        accessDenied: tagCount('evidence_validity', 'access_denied'),
      },
      requiredVerified: { count: sufficiency.filter((i) => i.status === 'pass').length, of: sufficiency.length },
      requiredAccessDenied: sufficiency.filter((i) => i.tag === 'access_denied').length,
      citations: {
        verified: tagCount('citations', 'verified'),
        unresolved: tagCount('citations', 'unresolved'),
        unsupported: tagCount('citations', 'unsupported'),
        confirmedFalse: tagCount('citations', 'confirmed_false'),
        accessDenied: tagCount('citations', 'access_denied'),
      },
      traceClaims: {
        consistent: tagCount('trace_consistency', 'consistent'),
        contradictions: tagCount('trace_consistency', 'contradiction'),
        retryMismatches: tagCount('trace_consistency', 'retry_mismatch'),
        withoutTraceEvidence: tagCount('trace_consistency', 'unsupported'),
        unresolved: tagCount('trace_consistency', 'unresolved'),
      },
    },
    rootCause: {
      passed: passed('root_cause'),
      criteriaMatched: { count: criteria.filter((i) => i.status === 'pass').length, of: criteria.length },
      forbiddenHits: tagCount('root_cause', 'forbidden'),
      definitiveClaims: tagCount('root_cause', 'forbidden_definitive'),
    },
    recommendation: {
      passed: passed('recommendation'),
      acceptableMatched: { count: acceptable.filter((i) => i.status === 'pass').length, of: acceptable.length },
      forbiddenHits: tagCount('recommendation', 'forbidden'),
    },
  });
}

function traceEvidence(records: ScoreRecord[]): Summary['traceEvidence'] {
  const acquisition = zero(TRACE_ACQUISITIONS);
  const toolStatuses = zero(TRACE_CALL_STATUSES);
  const limitations: Summary['traceEvidence']['limitations'] = [];
  let tests = 0;
  for (const r of records) {
    for (const t of r.traceEvidence?.tests ?? []) {
      tests++;
      acquisition[t.acquisition]++;
      for (const x of t.summaries) toolStatuses[x.status]++;
      for (const limitation of t.limitations) limitations.push({ evalId: r.evalId, test: t.title, limitation });
    }
  }
  return { tests, acquisition, notRecorded: records.filter((r) => r.traceEvidence === null).length, toolStatuses, limitations };
}

function usage(records: ScoreRecord[]): Summary['usage'] {
  const stat = (pick: (m: ScoreRecord['metrics']) => number | null) => {
    const values = records.map((r) => pick(r.metrics)).filter((v): v is number => v !== null);
    return { total: round(values.reduce((a, b) => a + b, 0)), max: values.length ? round(Math.max(...values)) : null, reported: values.length };
  };
  return {
    note: 'Over all attempted evaluations that reported a value. estimatedUsageCostUsd is the SDK estimate at list prices, not a charge (e.g. on a subscription plan).',
    wallClockMs: stat((m) => m.wallClockMs),
    durationMs: stat((m) => m.durationMs),
    numTurns: stat((m) => m.numTurns),
    inputTokens: stat((m) => m.inputTokens),
    outputTokens: stat((m) => m.outputTokens),
    estimatedUsageCostUsd: stat((m) => m.estimatedUsageCostUsd),
    toolCalls: stat((m) => m.toolCalls),
  };
}

function byFailureType(views: View[]): Summary['byFailureType'] {
  const types = [...new Set(views.map((v) => v.record.failureType ?? 'unknown'))].sort();
  return types.map((failureType) => {
    const mine = views.filter((v) => (v.record.failureType ?? 'unknown') === failureType);
    const eligible = mine.filter((v) => ELIGIBLE_CATEGORIES.includes(v.category));
    const tests = eligible.flatMap((v) => v.record.classification.tests);
    return {
      failureType,
      evaluations: mine.length,
      eligible: eligible.length,
      investigations: tests.length,
      exact: tests.filter((t) => t.verdict === 'exact').length,
      reviewableAlternative: tests.filter((t) => t.verdict === 'reviewable_alternative').length,
      accepted: eligible.filter((v) => v.acceptance.status === 'accepted').length,
    };
  });
}

/** Per scenario and test: predicted classifications across eligible attempts. Multi-test scenarios keep one row per test. */
function reliability(views: View[]): Summary['reliability'] {
  const titles = new Map<string, Set<string>>();
  for (const v of views) for (const t of v.record.classification.tests) (titles.get(v.record.scenarioId) ?? titles.set(v.record.scenarioId, new Set()).get(v.record.scenarioId)!).add(t.title);
  const rows: Summary['reliability'] = [];
  for (const scenarioId of [...new Set(views.map((v) => v.record.scenarioId))].sort()) {
    const mine = views.filter((v) => v.record.scenarioId === scenarioId);
    for (const test of [...(titles.get(scenarioId) ?? ['(no eligible investigation)'])].sort()) {
      const predicted = mine.filter((v) => ELIGIBLE_CATEGORIES.includes(v.category)).map((v) => v.record.classification.tests.find((t) => t.title === test)?.predicted ?? null);
      const tally = new Map<string | null, number>();
      for (const p of predicted) tally.set(p, (tally.get(p) ?? 0) + 1);
      const top = Math.max(0, ...tally.values());
      rows.push({ scenarioId, test, attempts: mine.length, eligible: predicted.length, predicted, agreement: predicted.length > 0 ? { count: top, of: predicted.length } : null });
    }
  }
  return rows;
}

/** States the sample behind the numbers. The report computes counts only, never intervals or rates. */
function reliabilityWarning(records: ScoreRecord[]): string {
  const attempts = new Map<string, number>();
  for (const r of records) attempts.set(r.scenarioId, (attempts.get(r.scenarioId) ?? 0) + 1);
  const per = [...attempts].sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => `${id} ${n}`).join(', ');
  const single = [...attempts.values()].every((n) => n === 1);
  return (
    `${attempts.size} scenario(s), attempts per scenario: ${per || 'none'}. ` +
    (single ? 'Each scenario was run once, so a result shows what happened in that one session, not how often the agent gets it right. ' : '') +
    'This sample is insufficient to establish statistical reliability: no rates, confidence intervals or run-to-run variance can be inferred from it.'
  );
}

function skillVersions(scores: Scored[]): Summary['skillVersions'] {
  const hashes = [...new Set(scores.map((s) => s.skillSha256 ?? null))].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  return hashes.map((skillSha256) => ({ skillSha256, evaluations: scores.filter((s) => (s.skillSha256 ?? null) === skillSha256).map((s) => s.record.evalId) }));
}

function truthVersions(records: ScoreRecord[]): Summary['truthVersions'] {
  const ids = [...new Set(records.map((r) => r.scenarioId))].sort();
  return ids.map((scenarioId) => {
    const hashes = [...new Set(records.filter((r) => r.scenarioId === scenarioId && r.inputs.truthSha256).map((r) => r.inputs.truthSha256!))].sort();
    return { scenarioId, truthSha256: hashes, consistent: hashes.length <= 1 };
  });
}

// ---------------------------------------------------------------------------
// Markdown

const LABEL: Record<Category, string> = {
  scored: 'Scored',
  needs_review: 'Needs manual review',
  unverified: 'Unverified',
  invalid_output: 'Invalid structured output',
  timeout: 'Timeout',
  session_error: 'Session or authentication error',
  confirmed_violation: 'Confirmed leakage or tampering',
  invalid_setup: 'Invalid snapshot or setup (execution/setup failure)',
};
const SYMBOL: Record<CheckStatus, string> = { pass: 'pass', partial: 'partial', fail: '**FAIL**', review: 'review', not_applicable: '–' };

export function renderSummary(summary: Summary): string {
  const out: string[] = [];
  const a = summary.automatic;
  const frac = (f: { count: number; of: number }) => `${f.count}/${f.of}`;
  out.push(`# Evaluation summary: ${summary.runId}`, '');
  if (summary.notice) out.push(`> **${summary.notice}**`, '');
  if (summary.reliabilityWarning) out.push(`> **Not a reliability estimate.** ${summary.reliabilityWarning}`, '');
  if (summary.runs.length > 1) out.push(`Combined from ${summary.runs.length} runs: ${summary.runs.map((r) => `${r.runId} (${r.evaluations.join(', ')})`).join('; ')}. Each run's own files are unchanged.`, '');
  out.push(`Scorer version: ${summary.scorerVersions.join(', ') || 'none'}.`, '');
  if (summary.scorerVersions.length > 1) out.push('> **Warning:** these scores come from different scorer versions; re-score with one version before comparing them.', '');
  out.push(
    `**${a.attempted} evaluation(s) attempted.** ${a.eligible} eligible for diagnostic metrics (${a.pendingReview} with pending reviews); ` +
      `${a.excluded.total} excluded: ${(Object.keys(a.excluded) as (keyof Metrics['excluded'])[]).filter((k) => k !== 'total' && a.excluded[k] > 0).map((k) => `${a.excluded[k]} ${LABEL[k as Category].toLowerCase()}`).join(', ') || 'none'}.`,
    '',
    'Counts, not percentages: the dataset is small. Root-cause and recommendation checks are regex heuristics; "review" means a person must decide.',
    '',
  );
  const inconsistent = summary.truthVersions.filter((t) => !t.consistent);
  if (inconsistent.length > 0) out.push(`> **Warning:** scores computed against different truth.json versions: ${inconsistent.map((t) => t.scenarioId).join(', ')}.`, '');
  if (summary.skillVersions.length > 1) {
    out.push(
      `> **The investigator Skill differs between evaluations:** ${summary.skillVersions.map((v) => `${v.skillSha256?.slice(0, 12) ?? 'not recorded'} (${v.evaluations.join(', ')})`).join('; ')}. Results from different Skill versions are not like-for-like.`,
      '',
    );
  }
  out.push('## Outcomes', '', '| Category | Automatic | Reviewed |', '|---|---|---|', ...CATEGORIES.map((c) => `| ${LABEL[c]} | ${a.categories[c]} | ${summary.reviewed ? summary.reviewed.categories[c] : '–'} |`), '');

  const block = (m: Metrics) => [
    `- **Classification agreement:** exact ${frac(m.classification.exact)} eligible investigations` +
      ` (acceptable alternative ${m.classification.verdicts.acceptable_alternative}, reviewable alternative ${m.classification.verdicts.reviewable_alternative}, incorrect ${m.classification.verdicts.incorrect}, abstained ${m.classification.verdicts.abstained}, missing ${m.classification.verdicts.missing}; ${m.classification.pendingReview} still pending review)`,
    `- **High-confidence incorrect:** ${m.classification.highConfidenceIncorrect}`,
    `- **Fully accepted diagnoses:** ${frac(m.acceptance.accepted)} eligible runs (pending review ${m.acceptance.statuses.pending_review}, not accepted ${m.acceptance.statuses.not_accepted})`,
    `- Root cause check passed ${frac(m.rootCause.passed)} (criteria matched ${frac(m.rootCause.criteriaMatched)}, suspicious claims ${m.rootCause.forbiddenHits}, unsupported definitive claims ${m.rootCause.definitiveClaims}); recommendation passed ${frac(m.recommendation.passed)} (suspicious ${m.recommendation.forbiddenHits})`,
    `- Evidence claims: verified ${m.evidence.claims.verified}, unresolved provenance ${m.evidence.claims.unresolved}, unsupported ${m.evidence.claims.unsupported}, confirmed false ${m.evidence.claims.confirmedFalse}, false "not available" ${m.evidence.claims.falseUnavailable}, access denied ${m.evidence.claims.accessDenied}; required evidence verified ${frac(m.evidence.requiredVerified)} (access denied ${m.evidence.requiredAccessDenied})`,
    `- Citations: verified ${m.evidence.citations.verified}, unresolved ${m.evidence.citations.unresolved}, unsupported ${m.evidence.citations.unsupported}, confirmed false ${m.evidence.citations.confirmedFalse}, access denied ${m.evidence.citations.accessDenied}`,
    `- Trace claims vs get_trace_summary: consistent ${m.evidence.traceClaims.consistent}, contradictions ${m.evidence.traceClaims.contradictions}, retry mismatches ${m.evidence.traceClaims.retryMismatches}, without trace evidence ${m.evidence.traceClaims.withoutTraceEvidence}, unresolved ${m.evidence.traceClaims.unresolved}`,
  ];
  out.push('## Diagnostic metrics (eligible runs only)', '', '**Automatic:**', ...block(a), '');
  if (summary.reviewed) out.push(`**After human review** (${summary.reviews.applied} review(s) applied):`, ...block(summary.reviewed), '');
  if (summary.highConfidenceIncorrect.length > 0) {
    out.push('**High-confidence incorrect diagnoses:**', ...summary.highConfidenceIncorrect.map((h) => `- ${h.evalId} "${h.test}": ${h.predicted} at High confidence (expected ${h.expected})`), '');
  }

  out.push(
    '## By failure type (automatic)',
    '',
    '| Failure type | Evaluations | Eligible | Investigations | Exact | Reviewable alternative | Fully accepted |',
    '|---|---|---|---|---|---|---|',
    ...summary.byFailureType.map((t) => `| ${t.failureType} | ${t.evaluations} | ${t.eligible} | ${t.investigations} | ${t.exact} | ${t.reviewableAlternative} | ${t.accepted} |`),
    '',
  );
  out.push('## Classification confusion matrix (automatic, eligible investigations)', '');
  const cols = [...CLASSIFICATIONS, 'none'];
  out.push(`| Expected \\ Predicted | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
  for (const [expected, row] of Object.entries(a.confusion)) out.push(`| ${expected} | ${cols.map((c) => row[c] ?? 0).join(' | ')} |`);
  if (Object.keys(a.confusion).length === 0) out.push(`| (no eligible investigations) | ${cols.map(() => '').join(' | ')} |`);
  out.push('', '**Confidence vs verdict:**', '', `| Confidence | ${CLASSIFICATION_VERDICTS.join(' | ')} |`, `|---|${CLASSIFICATION_VERDICTS.map(() => '---').join('|')}|`);
  for (const [level, row] of Object.entries(a.calibration)) out.push(`| ${level} | ${CLASSIFICATION_VERDICTS.map((v) => row[v]).join(' | ')} |`);

  out.push('', '## Checks (automatic, eligible runs)', '', `| Check | ${CHECK_STATUSES.join(' | ')} |`, `|---|${CHECK_STATUSES.map(() => '---').join('|')}|`);
  for (const id of CHECK_IDS) out.push(`| ${id} | ${CHECK_STATUSES.map((s) => a.checks[id]![s]).join(' | ')} |`);

  const te = summary.traceEvidence;
  out.push(
    '',
    '## Trace evidence acquisition (all evaluations, descriptive)',
    '',
    `Per expected test: obtained through MCP (get_trace_summary ok/partial) ${te.acquisition.mcp}, through Bash (trace file read) ${te.acquisition.bash}, both ${te.acquisition.mcp_and_bash}, not obtained ${te.acquisition.not_obtained}, no trace kept ${te.acquisition.no_trace}` +
      `${te.notRecorded > 0 ? `; ${te.notRecorded} evaluation(s) without a record (scored before version 8 or not scored diagnostically)` : ''}.`,
    '',
    `get_trace_summary results: ${TRACE_CALL_STATUSES.filter((st) => te.toolStatuses[st] > 0).map((st) => `${st} ${te.toolStatuses[st]}`).join(', ') || 'no calls'}.`,
  );
  if (te.limitations.length > 0) out.push('', '**Coverage limitations of the trace evidence:**', ...te.limitations.map((l) => `- ${l.evalId} "${l.test}": ${l.limitation}`));
  out.push(
    '',
    '## Evaluations',
    '',
    '| Evaluation | Failure type | Category (auto → reviewed) | Classification per test (observed outcome) | Acceptance (auto → reviewed) | Audit |',
    '|---|---|---|---|---|---|',
  );
  for (const e of summary.evaluations) {
    const cat = e.automaticCategory === e.reviewedCategory ? LABEL[e.automaticCategory] : `${LABEL[e.automaticCategory]} → ${LABEL[e.reviewedCategory]}`;
    const tests =
      e.tests.map((t) => `${t.predicted ?? 'none'} (${t.verdict}${t.highConfidenceIncorrect ? ', HIGH-CONFIDENCE INCORRECT' : ''}${t.outcome ? `; ${t.outcome}` : ''})`).join('; ') || '–';
    const acc = e.acceptance.automatic === e.acceptance.reviewed ? e.acceptance.automatic : `${e.acceptance.automatic} → ${e.acceptance.reviewed}`;
    out.push(`| ${e.evalId} | ${e.failureType ?? '–'} | ${cat} | ${tests} | ${acc} | ${e.auditVerdict} |`);
  }
  for (const e of summary.evaluations) {
    out.push('', `### ${e.evalId}: ${LABEL[e.reviewedCategory]}`, '');
    out.push(...e.reasons.map((r) => `- ${r}`));
    const checks = Object.entries(e.checks).filter(([, s]) => s.automatic !== 'not_applicable' || s.reviewed !== 'not_applicable');
    if (checks.length > 0) {
      out.push('', checks.map(([id, s]) => `${id}: ${SYMBOL[s.automatic]}${s.reviewed !== s.automatic ? ` → ${SYMBOL[s.reviewed]} (review)` : ''}`).join(' · '));
    }
    if (e.acceptance.blockers.length > 0) out.push('', `**Not accepted because:** ${e.acceptance.blockers.join('; ')}`);
    else if (e.acceptance.pending.length > 0) out.push('', `**Acceptance pending review of:** ${e.acceptance.pending.join(', ')}`);
    if (e.reviewReasons.length > 0) out.push('', '**For manual review:**', ...e.reviewReasons.map((r) => `- ${r}`));
    if (e.traceAcquisition && e.traceAcquisition.length > 0) {
      out.push('', `Trace evidence: ${e.traceAcquisition.map((t) => `"${t.test}" ${t.acquisition.replaceAll('_', ' ')}${t.summaries.length ? ` (get_trace_summary ${t.summaries.join('; ')})` : ''}`).join('; ')}`);
    }
    if (e.auditExpected.length > 0) out.push('', '**Recognized SDK tool calls (not audit findings):**', ...e.auditExpected.map((x) => `- ${x}`));
    if (e.auditDismissed.length > 0) out.push('', '**Dismissed audit findings (no access possible):**', ...e.auditDismissed.map((x) => `- ${x}`));
    if (e.cleanup.status === 'failed') out.push('', `**Infrastructure: workspace NOT removed** (${e.cleanup.error ?? 'no detail'}). Scoring is unaffected; remove it once no process uses it.`);
    else if (e.cleanup.status === 'removed_after_retry') out.push('', `Infrastructure: workspace removed after ${e.cleanup.retried} retried attempt(s) (busy while the session processes exited).`);
    if (e.review.status !== 'none') {
      out.push('', `**Human review (${e.review.status}${e.review.reviewer ? `, ${e.review.reviewer}` : ''}${e.review.reviewedAt ? `, ${e.review.reviewedAt}` : ''}):**`, ...e.review.notes.map((n) => `- ${n}`));
    }
  }

  const cleanup = Object.entries(summary.infrastructure.cleanup);
  out.push('', '## Infrastructure', '', `Workspace cleanup: ${cleanup.map(([status, n]) => `${status.replaceAll('_', ' ')} ${n}`).join(', ') || 'none recorded'}.`);
  const failed = summary.evaluations.filter((e) => e.cleanup.status === 'failed');
  if (failed.length > 0) out.push('', '**Workspaces left behind (not a scoring problem):**', ...failed.map((e) => `- ${e.evalId}: ${e.cleanup.error ?? 'no detail'}`));

  out.push('', '## Reliability by scenario and test', '', '| Scenario | Test | Attempts | Eligible | Predicted | Agreement |', '|---|---|---|---|---|---|');
  for (const s of summary.reliability) out.push(`| ${s.scenarioId} | ${s.test} | ${s.attempts} | ${s.eligible} | ${s.predicted.map((p) => p ?? 'none').join(', ') || '–'} | ${s.agreement ? frac(s.agreement) : '–'} |`);

  const v = (n: number | null, f: (x: number) => string = String) => (n === null ? '–' : f(n));
  out.push(
    '',
    '## Provenance and usage per evaluation',
    '',
    '| Evaluation | Run | Scorer | Truth sha256 | Skill sha256 | Model | MCP server | Snapshot | Duration (s) | Wall clock (s) | Turns | Tokens in / out | Tool calls | Est. cost (USD) | Audit (violations / suspicious / dismissed) | Cleanup |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const e of summary.evaluations) {
    const u = e.usage;
    const secs = (ms: number) => (ms / 1000).toFixed(1);
    out.push(
      `| ${e.evalId} | ${e.runId} | v${e.scorerVersion} | ${e.truthSha256?.slice(0, 12) ?? '–'} | ${e.skillSha256?.slice(0, 12) ?? 'not recorded'} | ${e.model ?? 'not recorded'} | ${e.mcpServerVersion ?? 'not recorded'} | ${e.snapshotFingerprint ?? '–'} | ${v(u.durationMs, secs)} | ${v(u.wallClockMs, secs)} | ${v(u.numTurns)} | ${v(u.inputTokens)} / ${v(u.outputTokens)} | ${v(u.toolCalls)} | ${v(u.estimatedUsageCostUsd, (c) => c.toFixed(4))} | ${e.auditVerdict} (${e.auditCounts.violations} / ${e.auditCounts.suspicious} / ${e.auditCounts.dismissed}) | ${e.cleanup.status.replaceAll('_', ' ')} |`,
    );
  }

  const u = summary.usage;
  const stat = (s: { total: number; max: number | null; reported: number }, unit = '') => (s.reported === 0 ? 'not reported' : `total ${s.total}${unit}, max ${s.max}${unit} (${s.reported} reported)`);
  out.push(
    '',
    '## Usage',
    '',
    `- Wall clock: ${stat(u.wallClockMs, ' ms')}`,
    `- Session duration: ${stat(u.durationMs, ' ms')}`,
    `- Turns: ${stat(u.numTurns)}`,
    `- Tokens: input ${stat(u.inputTokens)}; output ${stat(u.outputTokens)}`,
    `- Tool calls: ${stat(u.toolCalls)}`,
    `- Estimated usage cost: ${stat(u.estimatedUsageCostUsd, ' USD')}`,
    `- ${u.note}`,
    '',
    `**Ground truth:** ${summary.truthVersions.map((t) => `${t.scenarioId} ${t.truthSha256.map((h) => h.slice(0, 12)).join(', ') || 'unknown'}`).join('; ')} (full hashes in summary.json)`,
  );
  if (summary.reviews.stale > 0 || summary.reviews.unknown.length > 0) {
    out.push('', `**Reviews:** ${summary.reviews.stale} stale (score changed after review, not applied)${summary.reviews.unknown.length ? `; for unknown evaluations: ${summary.reviews.unknown.join(', ')}` : ''}.`);
  }
  return out.join('\n');
}

function zero<T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<T[number], number>;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
