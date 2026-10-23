import * as z from 'zod';
import { CLASSIFICATIONS, ModelReport, REPORT_STATUSES } from '../agent/result.ts';
import { loadScenarioFile, RegexSource, ScenarioId, SCENARIOS_DIR, TRUTH_FILE } from './scenarios.ts';

// Evaluation ground truth: what a correct investigation of a scenario concludes.
// Read by dataset tests and (later) the scorer. The generator never reads it, and it is never
// copied into an investigation workspace. Each file carries a unique canary string, so a
// transcript that contains it shows the file leaked to the agent.
//
// Root-cause and recommendation patterns are heuristics, not a judge: a match is a signal, and
// an uncertain or missing match goes to manual review rather than counting as a failure. The one
// exception is a forbidden claim marked `severity: "fail"`: an unhedged match fails (see score.ts).
//
// Fields added in Stage 2.6 (tests[].reportedOutcome, unavailableEvidence, reviewableAlternatives,
// severity) are optional; leaving them out keeps the Stage 2.5 meaning. So is Stage 3.4's
// requiredEvidence[].observations: without it, a trace obtained through get_trace_summary needs only
// to be read in full (status ok).

const Investigation = ModelReport.shape.investigations.element;
/** The CLI's own evidence kinds and confidence levels, so truth files can't drift from them. */
export const EVIDENCE_KINDS = Investigation.shape.evidence.element.shape.kind.options;
export const CONFIDENCE_LEVELS = Investigation.shape.confidence.shape.level.options;

export const FAILURE_TYPES = [
  'incorrect_assertion',
  'incorrect_locator',
  'timing',
  'application_failure',
  'mocked_failure',
  'environment',
  'intermittent_failure',
  'insufficient_evidence',
  'source_mismatch',
  'negative_control',
] as const;

const Criterion = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  anyOf: z.array(RegexSource).min(1).describe('The criterion is met if any pattern matches (case-insensitive)'),
});

const Forbidden = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  pattern: RegexSource.describe('A match flags the answer for manual review; negations ("not a server bug") also match'),
  severity: z
    .enum(['review', 'fail'])
    .optional()
    .describe('review (default): any match goes to manual review. fail: a match in a plain, unhedged sentence fails the check; a match in a hedged or negated sentence goes to review'),
});

const uniqueIds = (items: { id: string }[]) => new Set(items.map((i) => i.id)).size === items.length;

/** A fact a get_trace_summary result must contain for the trace requirement to be met through MCP. */
const TraceObservation = z.strictObject({
  source: z.enum(['browser', 'backend']).default('browser').describe('network.requests (browser) or backendFetches (API request contexts)'),
  path: RegexSource.describe('Matched against the sanitized request path'),
  status: z.number().int().min(100).max(599).optional(),
  marker: z.enum(['fulfilled', 'continued', 'aborted', 'none', 'unknown']).optional().describe('Browser requests only'),
});
export type TraceObservation = z.infer<typeof TraceObservation>;

export const GroundTruth = z
  .strictObject({
    id: ScenarioId,
    canary: z.string().regex(/^TDCANARY-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    description: z.string().min(1).describe('The known root cause, in plain words'),
    failureType: z.enum(FAILURE_TYPES),
    expected: z.strictObject({
      reportStatus: z.enum(REPORT_STATUSES),
      tests: z
        .array(
          z.strictObject({
            title: z.string().min(1),
            file: z.string().min(1),
            reportedOutcome: z.enum(['unexpected', 'flaky']).optional().describe('The outcome the MCP tools must report for it. Default unexpected'),
          }),
        )
        .describe('Failed tests that must be investigated'),
      classification: z.enum(CLASSIFICATIONS).nullable().describe('null only when nothing should be investigated'),
      acceptableAlternatives: z
        .array(z.strictObject({ classification: z.enum(CLASSIFICATIONS), maxConfidence: z.enum(CONFIDENCE_LEVELS), note: z.string().min(1) }))
        .describe('Other classifications that earn partial credit, only at or below maxConfidence'),
      reviewableAlternatives: z
        .array(
          z.strictObject({
            classification: z.enum(CLASSIFICATIONS),
            note: z.string().min(1),
            requires: Criterion.describe("The investigation's reasoning must match this (e.g. explicit caution about missing evidence); otherwise the classification is incorrect"),
          }),
        )
        .optional()
        .describe('Other classifications that a person must judge: never accepted automatically, never rejected for their confidence alone'),
      unavailableEvidence: z
        .array(z.enum(EVIDENCE_KINDS))
        .optional()
        .describe('Evidence kinds the run did not keep; the investigation must report each as not available'),
      sourceMismatch: z.boolean(),
      confidence: z.array(z.enum(CONFIDENCE_LEVELS)).min(1).describe('Confidence levels that fit the evidence'),
    }),
    rootCause: z.strictObject({
      summary: z.string().min(1),
      criteria: z.array(Criterion).refine(uniqueIds, 'criterion ids must be unique'),
      forbiddenClaims: z.array(Forbidden).refine(uniqueIds, 'forbidden claim ids must be unique'),
    }),
    requiredEvidence: z.array(
      z.strictObject({
        kind: z.enum(EVIDENCE_KINDS),
        refPattern: RegexSource.describe('Matched against the evidence ref (repo-relative path or MCP tool name)'),
        why: z.string().min(1),
        provisional: z.boolean().describe('True until confirmed against generated artifacts (e.g. trace contents)'),
        observations: z
          .array(TraceObservation)
          .min(1)
          .optional()
          .describe('Trace requirements only: facts a get_trace_summary result must contain for the requirement to be met through MCP (Stage 3.4)'),
      }),
    ),
    recommendations: z.strictObject({
      acceptable: z.array(Criterion).refine(uniqueIds, 'recommendation ids must be unique'),
      forbidden: z.array(Forbidden).refine(uniqueIds, 'forbidden recommendation ids must be unique'),
    }),
  })
  .superRefine((truth, ctx) => {
    const { expected } = truth;
    const investigates = expected.reportStatus === 'investigated';
    if (investigates && (expected.classification === null || expected.tests.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['expected'], message: 'an investigated scenario needs a classification and at least one test' });
    }
    if (!investigates && (expected.classification !== null || expected.tests.length > 0)) {
      ctx.addIssue({ code: 'custom', path: ['expected'], message: `status ${expected.reportStatus} carries no classification or tests` });
    }
    if (expected.acceptableAlternatives.some((a) => a.classification === expected.classification)) {
      ctx.addIssue({ code: 'custom', path: ['expected', 'acceptableAlternatives'], message: 'an alternative must differ from the expected classification' });
    }
    const reviewable = (expected.reviewableAlternatives ?? []).map((a) => a.classification);
    const listed = [expected.classification, ...expected.acceptableAlternatives.map((a) => a.classification)];
    if (reviewable.some((c) => listed.includes(c)) || new Set(reviewable).size !== reviewable.length) {
      ctx.addIssue({ code: 'custom', path: ['expected', 'reviewableAlternatives'], message: 'a reviewable alternative must differ from the expected classification, the acceptable alternatives and each other' });
    }
    const unavailable = expected.unavailableEvidence ?? [];
    if (truth.requiredEvidence.some((r) => unavailable.includes(r.kind))) {
      ctx.addIssue({ code: 'custom', path: ['expected', 'unavailableEvidence'], message: 'evidence cannot be both required and unavailable' });
    }
    for (const [i, r] of truth.requiredEvidence.entries()) {
      if (r.observations && r.kind !== 'trace') ctx.addIssue({ code: 'custom', path: ['requiredEvidence', i, 'observations'], message: 'observations apply to trace evidence only' });
      if (r.observations?.some((o) => o.source === 'backend' && o.marker !== undefined)) {
        ctx.addIssue({ code: 'custom', path: ['requiredEvidence', i, 'observations'], message: 'backend fetches carry no route marker' });
      }
    }
    if (!investigates && unavailable.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['expected', 'unavailableEvidence'], message: `status ${expected.reportStatus} has no evidence to be unavailable` });
    }
  });
export type GroundTruth = z.infer<typeof GroundTruth>;

export async function loadGroundTruth(id: string, root: string = SCENARIOS_DIR): Promise<GroundTruth> {
  return loadScenarioFile(GroundTruth, id, TRUTH_FILE, root);
}
