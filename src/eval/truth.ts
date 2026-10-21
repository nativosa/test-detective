import * as z from 'zod';
import { CLASSIFICATIONS, ModelReport, REPORT_STATUSES } from '../agent/result.ts';
import { loadScenarioFile, RegexSource, ScenarioId, SCENARIOS_DIR, TRUTH_FILE } from './scenarios.ts';

// Evaluation ground truth: what a correct investigation of a scenario concludes.
// Read by dataset tests and (later) the scorer. The generator never reads it, and it is never
// copied into an investigation workspace. Each file carries a unique canary string, so a
// transcript that contains it shows the file leaked to the agent.
//
// Root-cause and recommendation patterns are heuristics, not a judge: a match is a signal, and
// an uncertain or missing match goes to manual review rather than counting as a failure.

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
  'insufficient_evidence',
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
});

const uniqueIds = (items: { id: string }[]) => new Set(items.map((i) => i.id)).size === items.length;

export const GroundTruth = z
  .strictObject({
    id: ScenarioId,
    canary: z.string().regex(/^TDCANARY-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    description: z.string().min(1).describe('The known root cause, in plain words'),
    failureType: z.enum(FAILURE_TYPES),
    expected: z.strictObject({
      reportStatus: z.enum(REPORT_STATUSES),
      tests: z.array(z.strictObject({ title: z.string().min(1), file: z.string().min(1) })).describe('Failed tests that must be investigated'),
      classification: z.enum(CLASSIFICATIONS).nullable().describe('null only when nothing should be investigated'),
      acceptableAlternatives: z
        .array(z.strictObject({ classification: z.enum(CLASSIFICATIONS), maxConfidence: z.enum(CONFIDENCE_LEVELS), note: z.string().min(1) }))
        .describe('Other classifications that earn partial credit, only at or below maxConfidence'),
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
  });
export type GroundTruth = z.infer<typeof GroundTruth>;

export async function loadGroundTruth(id: string, root: string = SCENARIOS_DIR): Promise<GroundTruth> {
  return loadScenarioFile(GroundTruth, id, TRUTH_FILE, root);
}
