import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod';
import { MCP_DETAILS, MCP_LIST, MCP_TRACE, SKILL_NAME, SKILL_TOOL } from '../agent/config.ts';
import { CLASSIFICATIONS, InvestigationResult, ModelReport, RUN_STATUSES } from '../agent/result.ts';
import type { ModelInvestigation, RunStatus } from '../agent/result.ts';
import { FailureDetailsOutput, ListFailuresOutput } from '../mcp/report.ts';
import { TraceSummaryOutput } from '../mcp/trace-summary.ts';
import { auditTranscript, resolveFrom } from './isolation.ts';
import type { Finding } from './isolation.ts';
import type { RunOutcome } from './runs.ts';
import { CONFIDENCE_LEVELS } from './truth.ts';
import type { GroundTruth, TraceObservation } from './truth.ts';
import { CONFIG_FILES, isInside } from './workspace.ts';
import type { LeakMarkers } from './workspace.ts';

// Deterministic, offline scoring of one saved evaluation against its ground truth. Pure: no I/O,
// no clock, no model. Inputs are the saved files (already read), the truth file and verified
// snapshot facts; the output is a ScoreRecord.
//
// What is trusted:
// - Test facts and tool usage come from the raw transcript (MCP results, tool calls and their
//   outcomes), never from the model's own claims. result.json must agree with the transcript.
// - Evidence provenance is graded, not assumed: verified (a successful tool call read it),
//   unresolved (only a partial channel, such as a Bash command naming the file, or a transcript too
//   incomplete to show that no read happened), unsupported (a complete transcript shows no read;
//   an MCP error snippet alone does not count as reading the file), or demonstrably false
//   (nonexistent, outside the workspace, every access failed, or claimed unavailable while present).
// - Root-cause and recommendation patterns are heuristics: a full match passes, anything else goes
//   to manual review. They never prove a diagnosis right or wrong.
// - A label can be right while the investigation is not acceptable: classification verdicts and
//   acceptance (every check passed, reviews resolved) are reported separately.
// - A reviewable alternative (a classification the truth file lets a person judge) is never
//   accepted or rejected automatically; only a human review of the classification check decides it.
// - A forbidden claim with severity "fail" fails when stated plainly; in a hedged or negated
//   sentence it goes to review, because a regex cannot tell "the server was down" from doubt.

// 4: StructuredOutput calls of an outputFormat session are expected audit entries, not suspicious
//    unexpected tools; workspace cleanup is recorded (infrastructure only).
// 5: a Bash command's own literal `NAME=value` assignments resolve `$NAME` (isolation.ts
//    shellAssignments); a conditional one (after `&&`) is dismissed only when the call never ran.
// 6: truth tests[].reportedOutcome is checked against the observed MCP outcome; unavailableEvidence must be
//    reported as not available; reviewable alternatives; forbidden claims with severity "fail";
//    forbidden claims also searched in the confidence justification; per-test outcome and the
//    scenario's failure type recorded.
// 7: verificationSteps are searched for forbidden recommendations, and for verification-only criteria
//    (every pattern describes re-running the test) in root_cause and recommendation; nothing else.
//    A file whose every read attempt the permission system denied is "access_denied": an honest
//    "not available" claim passes, a citation goes to review, and required evidence still fails.
// 8: get_trace_summary results are evidence. Each is validated against TraceSummaryOutput and tied to
//    its testId, retry and report; status ok or partial counts as obtained, missing, unsupported,
//    denied, failed or invalid never does. A required trace met through MCP needs its truth
//    `observations` in a returned summary (or, without them, a fully read one); a partial summary
//    without them goes to review. The trace_consistency check compares structured trace claims (retry,
//    status, request path and HTTP status, route marker, fetch link, status change, completeness,
//    absence) with the returned summaries: fail only for a clear contradiction, review when unclear.
//    Per-test trace acquisition (MCP, Bash, not obtained), the model ID and the MCP server version are
//    recorded. A session that never calls the tool scores exactly as under 7, plus that record.
export const SCORER_VERSION = 8;

export const CATEGORIES = [
  'scored',
  'needs_review',
  'unverified',
  'invalid_output',
  'timeout',
  'session_error',
  'confirmed_violation',
  'invalid_setup',
] as const;
export type Category = (typeof CATEGORIES)[number];
/** Runs eligible for diagnostic metrics. Everything else is excluded and counted separately. */
export const ELIGIBLE_CATEGORIES: readonly Category[] = ['scored', 'needs_review'];

export const CHECK_IDS = [
  'structured_output',
  'report_status',
  'coverage',
  'classification',
  'root_cause',
  'evidence_validity',
  'evidence_sufficiency',
  'citations',
  'trace_consistency',
  'confidence',
  'source_mismatch',
  'recommendation',
  'process',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export const CHECK_STATUSES = ['pass', 'partial', 'fail', 'review', 'not_applicable'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
/** Separate categories; no partial credit. */
export const CLASSIFICATION_VERDICTS = ['exact', 'acceptable_alternative', 'reviewable_alternative', 'incorrect', 'abstained', 'missing'] as const;
export type ClassificationVerdict = (typeof CLASSIFICATION_VERDICTS)[number];
export const ACCEPTANCE_STATUSES = ['accepted', 'pending_review', 'not_accepted', 'not_eligible'] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

/**
 * Item tags with a fixed meaning, used by the reporter. Evidence provenance:
 * - verified: a successful tool call (or MCP result) shows the agent read it
 * - unresolved: only a partial channel (MCP snippet, Bash naming the file, no ref); needs review
 * - unsupported: the file exists but no channel in the transcript shows it was read
 * - confirmed_false: demonstrably false (nonexistent file, outside the workspace, every access
 *   failed, an MCP result never obtained)
 * - false_unavailable: claimed not available although the snapshot has it (and nothing denied access)
 * - access_denied: the file exists, but every attempt to read it was denied by the permission system
 *   (result `permission_denials` plus an error tool_result); never counts as inspected
 * Trace claims (trace_consistency): consistent (agrees with a returned trace summary), contradiction
 * (a returned summary shows otherwise), retry_mismatch (cites an attempt whose trace was not obtained).
 */
export const EVIDENCE_TAGS = ['verified', 'unresolved', 'unsupported', 'confirmed_false', 'false_unavailable', 'access_denied', 'unavailable', 'skipped', 'unreported', 'not_inspected', 'unacknowledged', 'consistent', 'contradiction', 'retry_mismatch'] as const;

/** Option paths the evaluation may change relative to `npm run investigate` (see isolation.ts). */
export const ALLOWED_OPTION_DIFFERENCES = ['cwd', 'mcpServers.test-detective.env', 'settings.permissions.deny'];

/** `tag` is a stable machine-readable kind for aggregation; details are for people. */
const Item = z.strictObject({ id: z.string(), status: z.enum(CHECK_STATUSES), detail: z.string(), tag: z.string().optional() });
export type Item = z.infer<typeof Item>;
const Check = z.strictObject({ id: z.enum(CHECK_IDS), status: z.enum(CHECK_STATUSES), detail: z.string(), items: z.array(Item) });
export type Check = z.infer<typeof Check>;
const AuditFinding = z.strictObject({ kind: z.string(), tool: z.string().nullable(), toolUseId: z.string().nullable(), detail: z.string() });

const TestVerdict = z.strictObject({
  title: z.string(),
  file: z.string(),
  testId: z.string().nullable(),
  predicted: z.enum(CLASSIFICATIONS).nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS).nullable(),
  verdict: z.enum(CLASSIFICATION_VERDICTS),
  highConfidenceIncorrect: z.boolean(),
  outcome: z.enum(['unexpected', 'flaky']).nullable().default(null).describe('The outcome the MCP tools reported for the test; null if not observed (or scored before version 6)'),
});
export type TestVerdict = z.infer<typeof TestVerdict>;

export const TRACE_CALL_STATUSES = ['ok', 'partial', 'missing', 'unsupported', 'error', 'denied', 'invalid', 'pending'] as const;
export const TRACE_ACQUISITIONS = ['mcp', 'bash', 'mcp_and_bash', 'not_obtained', 'no_trace'] as const;

const TraceAcquisition = z.strictObject({
  title: z.string(),
  testId: z.string().nullable(),
  acquisition: z
    .enum(TRACE_ACQUISITIONS)
    .describe("mcp: a get_trace_summary result with status ok or partial; bash: a trace file read through a tool call (Bash fallback); no_trace: the report kept no trace and none was obtained"),
  summaries: z.array(z.strictObject({ retry: z.number().nullable(), status: z.enum(TRACE_CALL_STATUSES), reasons: z.array(z.string()) })),
  limitations: z.array(z.string()).describe('Coverage limits of what was obtained (partial reads, omitted records)'),
});

export const ScoreRecord = z.strictObject({
  formatVersion: z.literal(1),
  scorerVersion: z.number().int(),
  evalId: z.string(),
  scenarioId: z.string(),
  failureType: z.string().nullable().default(null).describe("The truth file's failureType; null if unavailable (or scored before version 6)"),
  attempt: z.number().int().nullable(),
  category: z.enum(CATEGORIES),
  reasons: z.array(z.string()).describe('Why the category is what it is'),
  runStatus: z.enum(RUN_STATUSES).nullable(),
  harnessStatus: z.string().nullable(),
  inputs: z.strictObject({
    truthSha256: z.string().nullable().describe('The truth.json bytes this score was computed from'),
    snapshotFingerprint: z.string().nullable(),
    resultSha256: z.string().nullable(),
    transcriptSha256: z.string().nullable(),
    transcriptMessages: z.number().int().nullable(),
    model: z.string().nullable().default(null).describe('Model ID the session reported (result.json); null before version 8'),
    mcpServerVersion: z.string().nullable().default(null).describe('test-detective MCP server version captured before the session; null if not recorded'),
  }),
  setup: z.strictObject({ ok: z.boolean(), problems: z.array(z.string()) }),
  transcript: z
    .strictObject({ complete: z.boolean().nullable(), problems: z.array(z.string()) })
    .describe('Complete = init and result messages present and every tool call has a result; only then can a missing read be called unsupported'),
  audit: z.strictObject({
    verdict: z.enum(['violation', 'suspicious', 'clean', 'not_audited']),
    violations: z.array(AuditFinding).describe('Confirmed: canary seen, protected path accessed successfully, workspace changed'),
    suspicious: z.array(AuditFinding).describe('Unresolved: attempts, paths outside the workspace, expansions, unexpected tools'),
    expected: z.array(AuditFinding).describe('Recognized SDK-internal tool calls (StructuredOutput of an outputFormat session), with their outcome; informational'),
    dismissed: z
      .array(AuditFinding)
      .default([])
      .describe('Findings that cannot have caused access: a conditional-expansion in a call the permission system denied before it ran; informational (absent before scorer version 5)'),
  }),
  cleanup: z
    .strictObject({
      status: z.enum(['removed', 'removed_after_retry', 'failed', 'no_workspace', 'unknown']),
      attempts: z.number().int().nullable().describe('null for runs saved before attempts were recorded'),
      elapsedMs: z.number().nullable(),
      transient: z.array(z.string()).describe('Errors of removal attempts that were retried'),
      error: z.string().nullable(),
    })
    .describe('Workspace removal after the session. Infrastructure only: never changes the category or acceptance'),
  classification: z.strictObject({
    expected: z.enum(CLASSIFICATIONS).nullable(),
    tests: z.array(TestVerdict).describe('One verdict per expected test, never collapsed; empty when the run is not eligible'),
  }),
  acceptance: z.strictObject({
    status: z.enum(ACCEPTANCE_STATUSES),
    blockers: z.array(z.string()).describe('Why the investigation is not fully accepted'),
    pending: z.array(z.string()).describe('Reviews that must be resolved first'),
  }),
  checks: z.array(Check),
  traceEvidence: z
    .strictObject({ tests: z.array(TraceAcquisition) })
    .nullable()
    .default(null)
    .describe("How each expected test's trace evidence was obtained; null when not scored diagnostically or scored before version 8"),
  review: z.strictObject({ needed: z.boolean(), reasons: z.array(z.string()) }),
  metrics: z.strictObject({
    wallClockMs: z.number().nullable(),
    durationMs: z.number().nullable(),
    numTurns: z.number().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    estimatedUsageCostUsd: z.number().nullable(),
    toolCalls: z.number().nullable(),
    permissionDenials: z.number().nullable(),
  }),
});
export type ScoreRecord = z.infer<typeof ScoreRecord>;

export type Raw<T> = { state: 'ok'; value: T } | { state: 'missing' } | { state: 'unreadable'; error: string };
export type TruthInput = { ok: true; value: GroundTruth; sha256: string } | { ok: false; error: string };
export type SnapshotInfo = { ok: true; fingerprint: string; manifestSha256: string; files: string[] } | { ok: false; error: string };

export type ScoreInput = {
  evalId: string;
  outcome: { ok: true; value: RunOutcome } | { ok: false; error: string };
  result: Raw<unknown>;
  resultSha256: string | null;
  transcript: Raw<SDKMessage[]>;
  transcriptSha256: string | null;
  truth: TruthInput;
  snapshot: SnapshotInfo;
  markers: LeakMarkers;
};

// ---------------------------------------------------------------------------

export function scoreEvaluation(input: ScoreInput): ScoreRecord {
  const scenarioId = input.evalId.slice(0, 3);
  const problems: string[] = [];
  const reasons: string[] = [];
  const outcome = input.outcome.ok ? input.outcome.value : null;
  if (!input.outcome.ok) problems.push(input.outcome.error);

  const truth = input.truth.ok ? input.truth.value : null;
  if (!input.truth.ok) problems.push(`ground truth unavailable: ${input.truth.error}`);
  else if (truth && truth.id !== scenarioId) problems.push(`ground truth is for ${truth.id}, not ${scenarioId}`);
  if (outcome && outcome.scenarioId !== scenarioId) problems.push(`outcome.json is for ${outcome.scenarioId}, not ${scenarioId}`);

  if (outcome?.harness.status === 'setup_failed') problems.push(`setup failed before the session: ${outcome.harness.detail ?? 'no detail'}`);
  if (outcome?.harness.status === 'harness_error') problems.push(`harness error: ${outcome.harness.detail ?? 'no detail'}`);
  const finished = outcome?.harness.status === 'session_finished';

  const snapshot = input.snapshot.ok ? input.snapshot : null;
  if (!input.snapshot.ok) problems.push(`snapshot unavailable or failed verification: ${input.snapshot.error}`);
  if (snapshot && outcome?.snapshot) {
    if (outcome.snapshot.manifestSha256 !== snapshot.manifestSha256) problems.push('the snapshot manifest changed since the run (manifest sha256 differs)');
    if (outcome.snapshot.reportFingerprint !== snapshot.fingerprint) {
      problems.push(`the run used report ${outcome.snapshot.reportFingerprint}, the stored snapshot is ${snapshot.fingerprint}`);
    }
  }
  if (truth && outcome && input.truth.ok) {
    const captured = outcome.preflight.truthSha256;
    if (captured === null) {
      if (finished) problems.push('the ground truth hash was not captured before the session');
    } else if (captured !== input.truth.sha256) {
      problems.push(`ground truth changed since the run (captured ${captured.slice(0, 12)}, current ${input.truth.sha256.slice(0, 12)}); score it against the truth it ran with`);
    }
  }
  if (outcome?.workspace && !outcome.workspace.auditBefore.ok) problems.push(`workspace audit failed before the session: ${outcome.workspace.auditBefore.problems.join('; ')}`);
  for (const d of outcome?.configDifferences?.options ?? []) {
    if (!ALLOWED_OPTION_DIFFERENCES.includes(d.path)) problems.push(`session option ${d.path} differs from the baseline beyond the allowed evaluation changes`);
  }

  const transcript = input.transcript.state === 'ok' ? input.transcript.value : null;
  if (finished && input.transcript.state !== 'ok') problems.push(`${input.transcript.state === 'missing' ? 'transcript.jsonl is missing' : `transcript.jsonl: ${input.transcript.error}`}`);
  let result: InvestigationResult | null = null;
  if (input.result.state === 'ok') {
    const parsed = InvestigationResult.safeParse(input.result.value);
    if (parsed.success) result = parsed.data;
    else problems.push(`result.json is not a valid InvestigationResult: ${z.prettifyError(parsed.error)}`);
  } else if (finished) {
    problems.push(input.result.state === 'missing' ? 'result.json is missing' : `result.json: ${input.result.error}`);
  }

  const calls = transcript ? toolCallsOf(transcript) : [];
  const observed = observedFacts(calls);
  const finalReport = transcript ? finalStructuredOutput(transcript) : null;
  const completeness = transcript ? transcriptCompleteness(transcript, calls) : { complete: null, problems: [] };

  // The session must have read the snapshot's report, and result.json must match the transcript.
  if (snapshot) {
    for (const fp of observed.fingerprints) if (fp !== snapshot.fingerprint) problems.push(`the session read report ${fp}, but the snapshot is ${snapshot.fingerprint}`);
    const resultFp = result?.observed.report?.reportFingerprint;
    if (resultFp && resultFp !== snapshot.fingerprint) problems.push(`result.json observed report ${resultFp}, but the snapshot is ${snapshot.fingerprint}`);
  }
  if (result && transcript) problems.push(...resultTranscriptMismatches(result, finalReport, observed));

  // Audit: confirmed violations vs suspicious findings.
  const audit = auditOf(outcome, transcript, calls, input.markers);

  const runStatus = result?.runStatus ?? null;
  const ctx: Context | null =
    truth && result && outcome?.workspace
      ? { truth, result, calls, observed, root: outcome.workspace.root, files: fileIndex(snapshot?.files ?? []), completeness }
      : null;

  let category: Category;
  if (audit.verdict === 'violation') {
    category = 'confirmed_violation';
    reasons.push(...audit.violations.map((v) => `${v.kind}: ${v.detail}`));
  } else if (problems.length > 0) {
    category = 'invalid_setup';
    reasons.push(...problems);
  } else {
    category = categoryFor(runStatus, truth!, reasons);
  }

  const diagnostic = category === 'scored' || category === 'unverified';
  const checks = buildChecks(ctx, diagnostic ? null : `not scored: ${category}`, runStatus, result, finalReport);

  if (category === 'scored') {
    const process = checks.find((c) => c.id === 'process')!;
    if (process.status === 'fail') {
      category = 'unverified';
      reasons.push(`the transcript does not show the required tool usage: ${process.detail}`);
    }
  }
  const reviewReasons = [
    ...checks.filter((c) => c.status === 'review').map((c) => `${c.id}: ${c.detail}`),
    ...audit.suspicious.map((s) => `audit ${s.kind}${s.tool ? ` (${s.tool})` : ''}: ${s.detail}`),
  ];
  if (category === 'scored' && reviewReasons.length > 0) {
    category = 'needs_review';
    reasons.push('automatic checks could not decide everything; see review.reasons');
  }
  if (category === 'scored') reasons.push('all automatic checks decided');

  const tests = diagnostic && ctx ? testVerdicts(ctx) : [];
  const statuses = Object.fromEntries(checks.map((c) => [c.id, c.status])) as Record<CheckId, CheckStatus>;
  return ScoreRecord.parse({
    formatVersion: 1,
    scorerVersion: SCORER_VERSION,
    evalId: input.evalId,
    scenarioId,
    failureType: truth?.failureType ?? null,
    attempt: outcome?.attempt ?? null,
    category,
    reasons,
    runStatus,
    harnessStatus: outcome?.harness.status ?? null,
    inputs: {
      truthSha256: input.truth.ok ? input.truth.sha256 : null,
      snapshotFingerprint: snapshot?.fingerprint ?? null,
      resultSha256: input.resultSha256,
      transcriptSha256: input.transcriptSha256,
      transcriptMessages: transcript?.length ?? null,
      model: result?.observed.model ?? null,
      mcpServerVersion: outcome?.preflight.mcpServerVersion ?? null,
    },
    setup: { ok: problems.length === 0, problems },
    transcript: completeness,
    audit,
    cleanup: cleanupOf(outcome),
    classification: { expected: truth?.expected.classification ?? null, tests },
    acceptance: acceptanceOf(category, statuses, tests, audit.verdict === 'suspicious'),
    checks,
    traceEvidence: diagnostic && ctx ? { tests: traceAcquisition(ctx) } : null,
    review: { needed: reviewReasons.length > 0 && (category === 'needs_review' || category === 'unverified'), reasons: reviewReasons },
    metrics: {
      wallClockMs: outcome ? Math.max(0, Date.parse(outcome.finishedAt) - Date.parse(outcome.startedAt)) : null,
      durationMs: result?.usage.durationMs ?? null,
      numTurns: result?.usage.numTurns ?? null,
      inputTokens: result?.usage.inputTokens ?? null,
      outputTokens: result?.usage.outputTokens ?? null,
      estimatedUsageCostUsd: result?.usage.estimatedUsageCostUsd ?? null,
      toolCalls: transcript ? calls.length : null,
      permissionDenials: result?.observed.permissionDenials.length ?? null,
    },
  });
}

/**
 * Fully accepted diagnosis: an eligible run whose every test has the exact classification and
 * whose every check passed (or does not apply), with no review left open. The reporter calls this
 * again with human-reviewed statuses, so review outcomes feed acceptance without editing scores.
 * A reviewable alternative stays pending until a reviewer passes the classification check; any
 * other decision blocks it.
 */
export function acceptanceOf(category: Category, checks: Record<CheckId, CheckStatus>, tests: TestVerdict[], auditOpen: boolean): ScoreRecord['acceptance'] {
  if (!ELIGIBLE_CATEGORIES.includes(category)) return { status: 'not_eligible', blockers: [`run is ${category}`], pending: [] };
  const blockers: string[] = [];
  const pending: string[] = [];
  for (const t of tests) {
    if (t.verdict === 'exact') continue;
    if (t.verdict === 'reviewable_alternative' && checks.classification === 'pass') continue;
    if (t.verdict === 'reviewable_alternative' && checks.classification === 'review') {
      if (!pending.includes('classification')) pending.push('classification');
      continue;
    }
    blockers.push(`classification of "${t.title}": ${t.verdict}${t.verdict === 'reviewable_alternative' ? ` (reviewed: ${checks.classification})` : ''}`);
  }
  for (const id of CHECK_IDS) {
    if (id === 'classification') continue;
    const s = checks[id];
    if (s === 'fail' || s === 'partial') blockers.push(`${id}: ${s}`);
    else if (s === 'review') pending.push(id);
  }
  if (auditOpen) pending.push('audit');
  return { status: blockers.length > 0 ? 'not_accepted' : pending.length > 0 ? 'pending_review' : 'accepted', blockers, pending };
}

function categoryFor(runStatus: RunStatus | null, truth: GroundTruth, reasons: string[]): Category {
  switch (runStatus) {
    case 'completed':
      return 'scored';
    case 'mcp_unavailable':
    case 'report_error':
      if (truth.expected.reportStatus === runStatus) return 'scored';
      reasons.push(`execution/setup failure: the session ended with ${runStatus}, which this scenario does not expect (the MCP server or snapshot report did not work)`);
      return 'invalid_setup';
    case 'unverified':
      reasons.push('runInvestigation marked the result unverified (see result.json issues)');
      return 'unverified';
    case 'invalid_output':
      reasons.push('the model did not produce a valid structured report');
      return 'invalid_output';
    case 'timeout':
      reasons.push('the session timed out');
      return 'timeout';
    case 'auth_refused':
    case 'session_error':
    case 'interrupted':
      reasons.push(`the session ended with ${runStatus}`);
      return 'session_error';
    default:
      reasons.push('no result was recorded');
      return 'invalid_setup';
  }
}

// ---------------------------------------------------------------------------
// Transcript facts

/**
 * `denied`: the call never ran. Requires both the result message's `permission_denials` (the SDK's
 * authoritative record) and an error tool_result; a failed command is an error without a denial.
 */
type Call = { id: string; name: string; input: Record<string, unknown>; outcome: 'ok' | 'error' | 'pending'; resultText: string; denied: boolean };

export function toolCallsOf(messages: SDKMessage[]): Call[] {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  const denials = new Set<string>();
  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use' && block.type !== 'mcp_tool_use') continue;
        const call: Call = { id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown>, outcome: 'pending', resultText: '', denied: false };
        calls.push(call);
        byId.set(block.id, call);
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue;
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        call.outcome = block.is_error === true ? 'error' : 'ok';
        call.resultText = textOf(block.content);
      }
    } else if (message.type === 'result') {
      for (const d of message.permission_denials ?? []) denials.add(d.tool_use_id);
    }
  }
  for (const call of calls) call.denied = call.outcome === 'error' && denials.has(call.id);
  return calls;
}

/**
 * One get_trace_summary call, tied to the testId and retry it asked for. `output` is set only for a
 * result that validates against TraceSummaryOutput and answers exactly that testId and retry;
 * anything else is `invalid`. Only ok and partial results are evidence.
 */
type TraceCall = { id: string; testId: string | null; retry: number | null; status: (typeof TRACE_CALL_STATUSES)[number]; reasons: string[]; output: TraceSummaryOutput | null };

type Observed = {
  skillInvoked: boolean;
  skillReadAsFile: boolean;
  listOk: boolean;
  list: ListFailuresOutput | null;
  details: Map<string, FailureDetailsOutput>;
  traces: TraceCall[];
  fingerprints: Set<string>;
};

function traceCallOf(c: Call): TraceCall {
  const testId = typeof c.input.testId === 'string' ? c.input.testId : null;
  const retry = typeof c.input.retry === 'number' ? c.input.retry : null;
  const base = { id: c.id, testId, retry, reasons: [] as string[], output: null };
  if (c.outcome === 'pending') return { ...base, status: 'pending' };
  if (c.denied) return { ...base, status: 'denied' };
  const json = parseJson(c.resultText);
  if (c.outcome === 'error') {
    const code = (json as { error?: { code?: unknown } } | undefined)?.error?.code;
    return { ...base, status: 'error', reasons: typeof code === 'string' ? [code] : [] };
  }
  const parsed = TraceSummaryOutput.safeParse(json);
  if (!parsed.success) return { ...base, status: 'invalid', reasons: ['output fails TraceSummaryOutput'] };
  if (parsed.data.testId !== testId || parsed.data.retry !== retry) return { ...base, status: 'invalid', reasons: ['output answers a different testId or retry'] };
  return { ...base, status: parsed.data.trace.status, reasons: parsed.data.trace.reasons.map((r) => r.code), output: parsed.data };
}

function observedFacts(calls: Call[]): Observed {
  const details = new Map<string, FailureDetailsOutput>();
  const fingerprints = new Set<string>();
  const traces = calls.filter((c) => c.name === MCP_TRACE).map(traceCallOf);
  for (const t of traces) if (t.output) fingerprints.add(t.output.reportFingerprint);
  let list: ListFailuresOutput | null = null;
  for (const c of calls.filter((c) => c.outcome === 'ok')) {
    if (c.name === MCP_LIST) {
      const parsed = ListFailuresOutput.safeParse(parseJson(c.resultText));
      if (parsed.success) {
        list = parsed.data;
        fingerprints.add(parsed.data.run.reportFingerprint);
      }
    } else if (c.name === MCP_DETAILS) {
      const parsed = FailureDetailsOutput.safeParse(parseJson(c.resultText));
      if (parsed.success && parsed.data.testId === c.input.testId) {
        details.set(parsed.data.testId, parsed.data);
        fingerprints.add(parsed.data.reportFingerprint);
      }
    }
  }
  const skillFile = CONFIG_FILES[0].toLowerCase();
  return {
    skillInvoked: calls.some((c) => c.name === SKILL_TOOL && c.outcome === 'ok' && skillName(c.input.skill) === SKILL_NAME),
    skillReadAsFile: calls.some((c) => c.name !== SKILL_TOOL && JSON.stringify(c.input).replace(/\\\\/g, '/').toLowerCase().includes(skillFile)),
    listOk: list !== null,
    list,
    details,
    traces,
    fingerprints,
  };
}

function finalStructuredOutput(messages: SDKMessage[]): { status: 'none' } | { status: 'invalid'; error: string } | { status: 'ok'; report: ModelReport } {
  const result = [...messages].reverse().find((m) => m.type === 'result');
  if (!result || result.subtype !== 'success' || result.structured_output === undefined) return { status: 'none' };
  const parsed = ModelReport.safeParse(result.structured_output);
  return parsed.success ? { status: 'ok', report: parsed.data } : { status: 'invalid', error: z.prettifyError(parsed.error) };
}

/** Whether the transcript can establish that something did NOT happen. */
function transcriptCompleteness(messages: SDKMessage[], calls: Call[]): { complete: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!messages.some((m) => m.type === 'system' && m.subtype === 'init')) problems.push('no init message');
  if (!messages.some((m) => m.type === 'result')) problems.push('no final result message');
  const pending = calls.filter((c) => c.outcome === 'pending').length;
  if (pending > 0) problems.push(`${pending} tool call(s) without a recorded result`);
  return { complete: problems.length === 0, problems };
}

function resultTranscriptMismatches(result: InvestigationResult, final: ReturnType<typeof finalStructuredOutput> | null, observed: Observed): string[] {
  const out: string[] = [];
  if (result.reportStatus !== null) {
    if (final?.status !== 'ok') out.push('result.json carries a model report, but the transcript has no valid structured output');
    else if (final.report.status !== result.reportStatus || JSON.stringify(final.report.investigations) !== JSON.stringify(result.investigations.map((i) => i.analysis))) {
      out.push("result.json does not match the transcript's structured output");
    }
  }
  if (result.observed.skillInvoked && !observed.skillInvoked) out.push('result.json reports a Skill invocation the transcript does not show');
  for (const { facts } of result.investigations) {
    if (facts && !observed.details.has(facts.testId)) out.push(`result.json has facts for ${facts.testId} that the transcript does not show`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit

function auditOf(outcome: RunOutcome | null, transcript: SDKMessage[] | null, calls: Call[], markers: LeakMarkers): ScoreRecord['audit'] {
  const violations: Finding[] = [];
  const suspicious: Finding[] = [];
  const integrity = outcome?.workspace?.integrityAfter;
  if (integrity && integrity.length > 0) {
    violations.push({ kind: 'tampering', tool: null, toolUseId: null, detail: `workspace changed during the session: ${integrity.join('; ')}` });
  }
  if (outcome?.repo.unchanged === false) {
    violations.push({ kind: 'repo-changed', tool: null, toolUseId: null, detail: 'the repository (root artifacts, test-results, playwright-report or git status) changed during the session' });
  }
  if (outcome?.harness.status === 'session_finished' && integrity === null) {
    suspicious.push({ kind: 'integrity-unchecked', tool: null, toolUseId: null, detail: 'workspace integrity was not checked after the session' });
  }
  if (!transcript || !outcome?.workspace) {
    return { verdict: violations.length > 0 ? 'violation' : 'not_audited', violations, suspicious, expected: [], dismissed: [] };
  }
  const outputFormat = typeof outcome.preflight.session?.outputFormatSha256 === 'string';
  const audit = auditTranscript(transcript, { workspace: outcome.workspace, outputFormat }, markers);
  const outcomeOf = new Map(calls.map((c) => [c.id, c.outcome]));
  // A rejected StructuredOutput attempt is the SDK's validation at work, not an audit concern. It is
  // kept visible here; whether the final output is valid is the structured_output check's job.
  const expected = audit.expected.map((e) => {
    const result = e.toolUseId === null ? undefined : outcomeOf.get(e.toolUseId);
    return { ...e, detail: `${e.detail}; ${result === 'ok' ? 'accepted' : result === 'error' ? 'rejected with an error result (validation), retried by the model' : 'no result recorded'}` };
  });
  for (const leak of audit.leaks) {
    // A canary in the transcript means the content reached the session. A protected path counts
    // as confirmed only if the tool call succeeded; a denied or failed attempt stays suspicious,
    // as does a tool input that merely names an eval-only file or field.
    const succeeded = leak.toolUseId !== null && outcomeOf.get(leak.toolUseId) === 'ok';
    if (leak.kind === 'canary' || (leak.kind === 'protected-path' && succeeded)) violations.push(leak);
    else suspicious.push({ ...leak, detail: `${leak.detail}${leak.kind === 'protected-path' ? ' (attempt did not succeed)' : ''}` });
  }
  // A conditional expansion is only uncertain about the inherited fallback value, and that matters
  // only if the command ran. Its literal value was audited like any other path. Every other warning
  // stays suspicious even for a denied call: an unresolved target says nothing about intent.
  const denied = new Set(calls.filter((c) => c.denied).map((c) => c.id));
  const dismissed: Finding[] = [];
  for (const w of audit.warnings) {
    if (w.kind === 'conditional-expansion' && w.toolUseId !== null && denied.has(w.toolUseId)) {
      dismissed.push({ ...w, detail: `${w.detail}; the call was denied by the permission system and never ran` });
    } else {
      suspicious.push(w);
    }
  }
  return { verdict: violations.length > 0 ? 'violation' : suspicious.length > 0 ? 'suspicious' : 'clean', violations, suspicious, expected, dismissed };
}

/**
 * Workspace cleanup, copied from outcome.json. A leftover workspace does not change what the
 * session saw, so it never affects the category; the report lists it as an infrastructure problem.
 */
function cleanupOf(outcome: RunOutcome | null): ScoreRecord['cleanup'] {
  if (!outcome) return { status: 'unknown', attempts: null, elapsedMs: null, transient: [], error: null };
  const c = outcome.cleanup;
  const transient = c.transient ?? [];
  const status = outcome.workspace === null ? 'no_workspace' : !c.removed ? 'failed' : transient.length > 0 ? 'removed_after_retry' : 'removed';
  return { status, attempts: c.attempts ?? null, elapsedMs: c.elapsedMs ?? null, transient, error: c.error };
}

// ---------------------------------------------------------------------------
// Checks

type Context = {
  truth: GroundTruth;
  result: InvestigationResult;
  calls: Call[];
  observed: Observed;
  root: string;
  files: FileIndex;
  completeness: { complete: boolean | null; problems: string[] };
};

type Matched = { test: GroundTruth['expected']['tests'][number]; testId: string | null; analysis: ModelInvestigation | null };

const check = (id: CheckId, status: CheckStatus, detail: string, items: Item[] = []): Check => ({ id, status, detail, items });
const ORDER: CheckStatus[] = ['fail', 'review', 'partial', 'pass', 'not_applicable'];
function worst(statuses: CheckStatus[]): CheckStatus {
  for (const s of ORDER) if (statuses.includes(s)) return s;
  return 'not_applicable';
}
function fromItems(id: CheckId, items: Item[], pass: string): Check {
  const status = worst(items.map((i) => i.status));
  const bad = items.filter((i) => i.status === status && status !== 'pass');
  return check(id, status, status === 'pass' || status === 'not_applicable' ? pass : bad.map((i) => `${i.id}: ${i.detail}`).join('; '), items);
}

function buildChecks(
  ctx: Context | null,
  skip: string | null,
  runStatus: RunStatus | null,
  result: InvestigationResult | null,
  final: ReturnType<typeof finalStructuredOutput> | null,
): Check[] {
  const structured = structuredOutputCheck(runStatus, result, final);
  if (skip !== null || !ctx) {
    return CHECK_IDS.map((id) => (id === 'structured_output' ? structured : check(id, 'not_applicable', skip ?? 'not scored')));
  }
  const matched = matchInvestigations(ctx);
  return [
    structured,
    reportStatusCheck(ctx),
    coverageCheck(ctx, matched),
    classificationCheck(ctx, matched),
    rootCauseCheck(ctx, matched),
    evidenceValidityCheck(ctx),
    evidenceSufficiencyCheck(ctx, matched),
    citationsCheck(ctx, matched),
    traceConsistencyCheck(ctx, matched),
    confidenceCheck(ctx, matched),
    sourceMismatchCheck(ctx, matched),
    recommendationCheck(ctx, matched),
    processCheck(ctx),
  ];
}

function structuredOutputCheck(runStatus: RunStatus | null, result: InvestigationResult | null, final: ReturnType<typeof finalStructuredOutput> | null): Check {
  if (!result) return runStatus === null && final === null ? check('structured_output', 'not_applicable', 'no session') : check('structured_output', 'fail', 'no valid result.json');
  if (runStatus === 'invalid_output') return check('structured_output', 'fail', result.issues[0] ?? 'invalid structured output');
  if (result.reportStatus === null) return check('structured_output', 'not_applicable', `no model report (${runStatus})`);
  if (final?.status === 'invalid') return check('structured_output', 'fail', `the transcript's structured output fails the schema: ${final.error}`);
  return check('structured_output', 'pass', 'the report re-validates against the ModelReport schema');
}

function reportStatusCheck({ truth, result }: Context): Check {
  const expected = truth.expected.reportStatus;
  // runInvestigation stops before any model report when the MCP server fails at session start;
  // its runStatus then carries the status.
  const actual = result.reportStatus ?? (result.runStatus === 'mcp_unavailable' || result.runStatus === 'report_error' ? result.runStatus : null);
  return actual === expected ? check('report_status', 'pass', `status ${expected}`) : check('report_status', 'fail', `expected ${expected}, got ${actual ?? 'none'}`);
}

/** Pairs each expected test with the investigation whose OBSERVED facts (transcript MCP results) match it. */
function matchInvestigations({ truth, result, observed }: Context): Matched[] {
  return truth.expected.tests.map((test) => {
    const hit = result.investigations.find((i) => {
      const facts = observed.details.get(i.analysis.testId);
      return facts && facts.title === test.title && facts.file === test.file;
    });
    return { test, testId: hit?.analysis.testId ?? null, analysis: hit?.analysis ?? null };
  });
}

function coverageCheck({ truth, result, observed }: Context, matched: Matched[]): Check {
  const items: Item[] = matched.map((m): Item => {
    if (!m.analysis) return { id: m.test.title, status: 'fail', detail: `${m.test.file} was not investigated with an observed get_failure_details result` };
    const investigated = `investigated as ${m.testId} (observed get_failure_details result)`;
    // The truth file names the outcome only when it matters (flaky); the default must still hold.
    const expected = m.test.reportedOutcome ?? 'unexpected';
    const actual = observed.details.get(m.testId!)?.outcome;
    if (actual !== expected) {
      return { id: m.test.title, status: 'fail', detail: `${investigated}, but the MCP tools reported outcome ${actual ?? 'unknown'}; the scenario expects ${expected}`, tag: 'outcome_mismatch' };
    }
    return { id: m.test.title, status: 'pass', detail: m.test.reportedOutcome ? `${investigated}; outcome ${actual}` : investigated };
  });
  const used = new Set(matched.map((m) => m.testId));
  for (const { analysis } of result.investigations) {
    if (used.has(analysis.testId)) continue;
    const facts = observed.details.get(analysis.testId);
    items.push(
      facts
        ? { id: facts.title, status: 'review', detail: `investigated a test the scenario does not list (${facts.file})` }
        : { id: analysis.testId, status: 'fail', detail: 'investigation cites a testId with no observed get_failure_details result' },
    );
  }
  if (items.length === 0) return check('coverage', 'pass', truth.expected.tests.length === 0 ? 'nothing to investigate, nothing investigated' : 'covered');
  return fromItems('coverage', items, `all ${matched.length} expected test(s) investigated`);
}

type Graded = { predicted: ModelInvestigation['classification'] | null; confidence: ModelInvestigation['confidence']['level'] | null; verdict: ClassificationVerdict; detail: string };

function grade(truth: GroundTruth, analysis: ModelInvestigation | null): Graded {
  const expected = truth.expected.classification;
  if (!analysis) return { predicted: null, confidence: null, verdict: 'missing', detail: 'no investigation for this test' };
  const { classification: predicted, confidence } = analysis;
  const level = confidence.level;
  if (predicted === expected) return { predicted, confidence: level, verdict: 'exact', detail: predicted };
  const alt = truth.expected.acceptableAlternatives.find((a) => a.classification === predicted);
  if (alt) {
    return rank(level) <= rank(alt.maxConfidence)
      ? { predicted, confidence: level, verdict: 'acceptable_alternative', detail: `${predicted} is an acceptable alternative at ${level} confidence` }
      : { predicted, confidence: level, verdict: 'incorrect', detail: `${predicted} is acceptable only up to ${alt.maxConfidence} confidence, got ${level}` };
  }
  const reviewable = truth.expected.reviewableAlternatives?.find((a) => a.classification === predicted);
  if (reviewable) {
    const hit = firstMatch(reviewable.requires.anyOf, searchable(reasoningOf(analysis)));
    return hit
      ? { predicted, confidence: level, verdict: 'reviewable_alternative', detail: `${predicted} at ${level} confidence, with reasoning that matches /${hit}/ (${reviewable.requires.description}); a person must judge it` }
      : { predicted, confidence: level, verdict: 'incorrect', detail: `${predicted} without the required reasoning (${reviewable.requires.description}); expected ${expected}` };
  }
  if (predicted === 'Inconclusive') return { predicted, confidence: level, verdict: 'abstained', detail: `abstained (expected ${expected})` };
  return { predicted, confidence: level, verdict: 'incorrect', detail: `expected ${expected}, got ${predicted}` };
}

function testVerdicts(ctx: Context): TestVerdict[] {
  if (ctx.truth.expected.classification === null) return [];
  return matchInvestigations(ctx).map((m) => {
    const g = grade(ctx.truth, m.analysis);
    return {
      title: m.test.title,
      file: m.test.file,
      testId: m.testId,
      predicted: g.predicted,
      confidence: g.confidence,
      verdict: g.verdict,
      highConfidenceIncorrect: g.verdict === 'incorrect' && g.confidence === 'High',
      outcome: (m.testId && ctx.observed.details.get(m.testId)?.outcome) || null,
    };
  });
}

function classificationCheck({ truth }: Context, matched: Matched[]): Check {
  if (truth.expected.classification === null) return check('classification', 'not_applicable', 'nothing to classify');
  const items: Item[] = matched.map((m) => {
    const g = grade(truth, m.analysis);
    const status: CheckStatus = g.verdict === 'exact' ? 'pass' : g.verdict === 'acceptable_alternative' ? 'partial' : g.verdict === 'reviewable_alternative' ? 'review' : 'fail';
    return { id: m.test.title, status, detail: `${g.verdict}: ${g.detail}`, tag: g.verdict };
  });
  return fromItems('classification', items, `exact: ${truth.expected.classification}`);
}

function rootCauseCheck({ truth }: Context, matched: Matched[]): Check {
  const { criteria, forbiddenClaims } = truth.rootCause;
  if (criteria.length === 0 && forbiddenClaims.length === 0) return check('root_cause', 'not_applicable', 'no root-cause criteria');
  const items: Item[] = [];
  for (const m of matched) {
    if (!m.analysis) {
      items.push({ id: m.test.title, status: 'fail', detail: 'no investigation' });
      continue;
    }
    const parts = reasoningOf(m.analysis);
    const text = searchable(parts);
    const steps = searchable(m.analysis.verificationSteps);
    for (const c of criteria) {
      const hit = firstMatch(c.anyOf, text);
      const stepHit = !hit && verificationOnly(c.anyOf) ? firstMatch(c.anyOf, steps) : null;
      items.push(
        hit
          ? { id: c.id, status: 'pass', detail: `matched /${hit}/`, tag: 'criterion' }
          : stepHit
            ? { id: c.id, status: 'pass', detail: `matched /${stepHit}/ in verificationSteps (verification-only criterion)`, tag: 'criterion' }
            : { id: c.id, status: 'review', detail: `no pattern matched (${c.description})`, tag: 'criterion' },
      );
    }
    for (const f of forbiddenClaims) {
      const item = forbiddenItem(f, parts, 'claim');
      if (item) items.push(item);
    }
  }
  return fromItems('root_cause', items, `all ${criteria.length} criteria matched, no forbidden claims (heuristic)`);
}

function recommendationCheck({ truth }: Context, matched: Matched[]): Check {
  const { acceptable, forbidden } = truth.recommendations;
  if (acceptable.length === 0 && forbidden.length === 0) return check('recommendation', 'not_applicable', 'no recommendation criteria');
  const items: Item[] = [];
  for (const m of matched) {
    if (!m.analysis) {
      items.push({ id: m.test.title, status: 'fail', detail: 'no investigation' });
      continue;
    }
    const text = searchable([m.analysis.proposedFix]);
    const steps = searchable(m.analysis.verificationSteps);
    const hits = acceptable.filter((a) => firstMatch(a.anyOf, text));
    const stepHits = acceptable.filter((a) => !hits.includes(a) && verificationOnly(a.anyOf) && firstMatch(a.anyOf, steps));
    if (acceptable.length > 0) {
      const matched = [...hits.map((h) => h.id), ...stepHits.map((h) => `${h.id} (in verificationSteps)`)];
      items.push(
        matched.length > 0
          ? { id: 'acceptable', status: 'pass', detail: `matched ${matched.join(', ')}`, tag: 'acceptable' }
          : { id: 'acceptable', status: 'review', detail: text.trim() === '' ? 'no proposed fix' : 'no acceptable fix pattern matched', tag: 'acceptable' },
      );
    }
    // A forbidden action is flagged wherever it is recommended, including the verification steps.
    for (const f of forbidden) {
      const item = forbiddenItem(f, [m.analysis.proposedFix, ...m.analysis.verificationSteps], 'recommendation');
      if (item) items.push(item);
    }
  }
  return fromItems('recommendation', items, 'an acceptable fix, no forbidden recommendation (heuristic)');
}

function confidenceCheck({ truth }: Context, matched: Matched[]): Check {
  if (truth.expected.classification === null) return check('confidence', 'not_applicable', 'nothing to classify');
  const items: Item[] = matched.map((m) => {
    const g = grade(truth, m.analysis);
    if (g.verdict === 'exact') {
      return truth.expected.confidence.includes(g.confidence!)
        ? { id: m.test.title, status: 'pass', detail: `${g.confidence} is within ${truth.expected.confidence.join('/')}` }
        : { id: m.test.title, status: 'review', detail: `exact classification, but ${g.confidence} is outside ${truth.expected.confidence.join('/')}`, tag: 'confidence_outside_range' };
    }
    if (g.verdict === 'acceptable_alternative') return { id: m.test.title, status: 'pass', detail: `${g.confidence} is within the alternative's limit` };
    if (g.verdict === 'reviewable_alternative') return { id: m.test.title, status: 'not_applicable', detail: `reviewable alternative at ${g.confidence}; its confidence is judged in the classification review` };
    if (g.verdict === 'incorrect' && g.confidence === 'High') {
      return { id: m.test.title, status: 'fail', detail: `high-confidence incorrect diagnosis (${g.predicted} at High)`, tag: 'high_confidence_incorrect' };
    }
    return { id: m.test.title, status: 'not_applicable', detail: `classification ${g.verdict}${g.confidence ? ` at ${g.confidence}` : ''}; recorded for calibration` };
  });
  return fromItems('confidence', items, 'confidence fits the evidence');
}

function sourceMismatchCheck({ truth }: Context, matched: Matched[]): Check {
  if (truth.expected.tests.length === 0) return check('source_mismatch', 'not_applicable', 'nothing to investigate');
  const expected = truth.expected.sourceMismatch;
  const items: Item[] = matched.map((m) =>
    !m.analysis
      ? { id: m.test.title, status: 'fail', detail: 'no investigation' }
      : m.analysis.sourceMismatch === expected
        ? { id: m.test.title, status: 'pass', detail: `sourceMismatch ${expected}` }
        : { id: m.test.title, status: 'fail', detail: `expected sourceMismatch ${expected}, got ${m.analysis.sourceMismatch}` },
  );
  return fromItems('source_mismatch', items, `sourceMismatch ${expected}`);
}

function processCheck({ truth, result, observed, calls }: Context): Check {
  const items: Item[] = [];
  // When the CLI stops the session at start (MCP server not connected), the model never ran.
  const stoppedAtStart = result.reportStatus === null && result.runStatus === 'mcp_unavailable';
  items.push(
    stoppedAtStart
      ? { id: 'skill', status: 'not_applicable', detail: 'session stopped at start (MCP unavailable); no model turn' }
      : observed.skillInvoked
        ? { id: 'skill', status: 'pass', detail: `successful ${SKILL_TOOL} call for ${SKILL_NAME}` }
        : { id: 'skill', status: 'fail', detail: `no successful ${SKILL_TOOL} call for ${SKILL_NAME}${observed.skillReadAsFile ? ' (SKILL.md was read as a file instead)' : ''}` },
  );
  if (truth.expected.reportStatus !== 'mcp_unavailable') {
    const attempted = calls.some((c) => c.name === MCP_LIST);
    const ok = truth.expected.reportStatus === 'report_error' ? attempted : observed.listOk;
    items.push(ok ? { id: 'list_test_failures', status: 'pass', detail: 'observed' } : { id: 'list_test_failures', status: 'fail', detail: 'no successful call observed' });
  }
  for (const { analysis } of result.investigations) {
    items.push(
      observed.details.has(analysis.testId)
        ? { id: `get_failure_details:${analysis.testId}`, status: 'pass', detail: 'observed' }
        : { id: `get_failure_details:${analysis.testId}`, status: 'fail', detail: 'no successful call with this testId' },
    );
  }
  for (const test of truth.expected.tests) {
    const listed = observed.list?.failures.find((f) => f.title === test.title && f.file === test.file);
    if (listed && !observed.details.has(listed.testId)) items.push({ id: `get_failure_details:${test.title}`, status: 'fail', detail: 'listed failure never detailed' });
  }
  const denials = result.observed.permissionDenials.length;
  items.push({ id: 'permission_denials', status: 'pass', detail: `${denials} (informational)` });
  return fromItems('process', items, `Skill invoked, MCP calls observed, ${denials} permission denial(s)`);
}

// ---------------------------------------------------------------------------
// Evidence provenance

const MCP_TOOL_NAMES: Record<string, string> = {
  get_failure_details: MCP_DETAILS,
  [MCP_DETAILS]: MCP_DETAILS,
  list_test_failures: MCP_LIST,
  [MCP_LIST]: MCP_LIST,
  get_trace_summary: MCP_TRACE,
  [MCP_TRACE]: MCP_TRACE,
};
/** get_trace_summary refs may carry the attempt ("get_trace_summary (retry 0)"); other tool refs must match exactly, as before. */
const TRACE_REF = /^(mcp__test-detective__)?get_trace_summary/;

/** The MCP tool a ref names, if any. */
function toolOf(ref: string | null): string | undefined {
  if (!ref) return undefined;
  return MCP_TOOL_NAMES[ref.trim()] ?? (TRACE_REF.test(ref.trim()) ? MCP_TRACE : undefined);
}
const KIND_FILES: Partial<Record<ModelInvestigation['evidence'][number]['kind'], RegExp>> = {
  trace: /^test-results\/.+\.zip$/,
  screenshot: /^test-results\/.+\.png$/,
  error_context: /^test-results\/.+error-context\.md$/,
};
/** A citation that looks like a path (rather than free text) and can therefore be demonstrably wrong. */
const PATH_LIKE = /[\\/]|\.(ts|js|md|png|zip|json|txt|webm|jpe?g)$/i;

/**
 * How the transcript shows the agent getting at a file's contents:
 * - verified: a successful Read of it, Grep on it (or on its directory with the file in the output),
 *   or a Bash command naming its full path;
 * - partial: a Bash command naming only its base name, or an incomplete transcript that cannot
 *   show the absence of a read;
 * - denied: every attempt to read it was denied by the permission system (it never ran);
 * - failed: the only attempts to read it failed (missing, errored, or some denied and others failed);
 * - none: a complete transcript shows nothing touching it.
 */
type Provenance = { level: 'verified' | 'partial' | 'denied' | 'failed' | 'none'; via: string };
type FileIndex = { paths: string[]; lookup: Map<string, string> };

function fileIndex(snapshotFiles: string[]): FileIndex {
  const paths = [...snapshotFiles, ...CONFIG_FILES];
  return { paths, lookup: new Map(paths.map((p) => [key(p), p])) };
}

const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** A path as the agent wrote it (absolute, relative, Git-Bash), as a workspace-relative POSIX path, or null if outside. */
function workspaceRelative(p: string, root: string): string | null {
  const abs = resolveFrom(root, p.trim());
  if (!isInside(path.resolve(root), abs)) return null;
  return path.relative(path.resolve(root), abs).split(path.sep).join('/');
}

/** A ref the model wrote, resolved to a snapshot file: exact path, or a unique path suffix (e.g. "error-context.md"). */
function resolveRef(ref: string, ctx: Context): { file: string | null; outside: boolean } {
  const cleaned = ref.trim().replace(/:\d+(?::\d+)?$/, '');
  const rel = workspaceRelative(cleaned, ctx.root);
  if (rel === null) return { file: null, outside: true };
  const exact = ctx.files.lookup.get(key(rel));
  if (exact) return { file: exact, outside: false };
  const suffix = ctx.files.paths.filter((p) => key(p).endsWith(`/${key(rel)}`));
  return { file: suffix.length === 1 ? suffix[0]! : null, outside: false };
}

function provenance(file: string, ctx: Context): Provenance {
  const target = key(file);
  const base = key(path.posix.basename(file));
  const rootPosix = key(path.resolve(ctx.root).split(path.sep).join('/'));
  let partial: string | null = null;
  const failed: Call[] = [];
  for (const c of ctx.calls) {
    let touches = false;
    let weak = false;
    if (c.name === 'Read' && typeof c.input.file_path === 'string') {
      const rel = workspaceRelative(c.input.file_path, ctx.root);
      touches = rel !== null && key(rel) === target;
    } else if (c.name === 'Grep') {
      const rel = typeof c.input.path === 'string' ? workspaceRelative(c.input.path, ctx.root) : '';
      touches = rel !== null && (key(rel) === target || ((rel === '' || target.startsWith(`${key(rel)}/`)) && key(c.resultText.replaceAll('\\', '/')).includes(target)));
    } else if (c.name === 'Bash' && typeof c.input.command === 'string') {
      const command = key(c.input.command.replaceAll('\\', '/')).replaceAll(`${rootPosix}/`, '');
      touches = command.includes(target);
      weak = !touches && command.includes(base);
    }
    if (touches && c.outcome === 'ok') return { level: 'verified', via: `${c.name} ${c.id}` };
    if (touches) failed.push(c);
    if (weak && c.outcome === 'ok') partial ??= `a Bash command names ${path.posix.basename(file)} but not its full path`;
  }
  // An error snippet in a get_failure_details result is deliberately not a channel: it shows a few
  // lines around the error, not that the agent inspected the file.
  if (partial) return { level: 'partial', via: partial };
  if (failed.length > 0 && failed.every((c) => c.denied)) {
    return { level: 'denied', via: `every attempt to read it was denied by the permission system (${failed.map((c) => `${c.name} ${c.id}`).join(', ')})` };
  }
  if (failed.length > 0) return { level: 'failed', via: 'every attempt to read it failed' };
  if (!ctx.completeness.complete) {
    return { level: 'partial', via: `the transcript is incomplete (${ctx.completeness.problems.join('; ')}), so the absence of a read is not established` };
  }
  return { level: 'none', via: 'no successful tool call in the complete transcript read it' };
}

function mcpObtained(tool: string, testId: string | null, ctx: Context): boolean {
  if (tool === MCP_TRACE) return tracesFor(testId, ctx).some(usable);
  return tool === MCP_DETAILS ? (testId !== null ? ctx.observed.details.has(testId) : ctx.observed.details.size > 0) : ctx.observed.listOk;
}

/**
 * An evidence or citation item for a file, from its provenance. A claim of inspection of a file the
 * agent was denied is false; a citation of it may only report the denial, so a person checks it.
 */
function fileItem(id: string, file: string, ctx: Context, claim: 'claimed inspected' | 'cites'): Item {
  const p = provenance(file, ctx);
  switch (p.level) {
    case 'verified':
      return { id, status: 'pass', detail: `${claim} ${file}: verified (${p.via})`, tag: 'verified' };
    case 'partial':
      return { id, status: 'review', detail: `${claim} ${file}: provenance unresolved (${p.via})`, tag: 'unresolved' };
    case 'denied':
      return claim === 'cites'
        ? { id, status: 'review', detail: `cites ${file}, but ${p.via}; check that the citing point only reports the failed access, not its contents`, tag: 'access_denied' }
        : { id, status: 'fail', detail: `${claim} ${file}, but ${p.via}`, tag: 'confirmed_false' };
    case 'failed':
      return { id, status: 'fail', detail: `${claim} ${file}, but ${p.via}`, tag: 'confirmed_false' };
    case 'none':
      return { id, status: 'fail', detail: `${claim} ${file}, but ${p.via} (unsupported)`, tag: 'unsupported' };
  }
}

function evidenceValidityCheck(ctx: Context): Check {
  const items: Item[] = [];
  for (const { analysis } of ctx.result.investigations) {
    for (const e of analysis.evidence) {
      const id = `${e.kind}:${e.ref ?? '(no ref)'}`;
      const tool = e.ref ? toolOf(e.ref) : e.kind === 'mcp' ? MCP_DETAILS : undefined;
      if (e.status === 'skipped') {
        items.push({ id, status: 'pass', detail: 'skipped (no claim to verify)', tag: 'skipped' });
      } else if (tool === MCP_TRACE) {
        items.push(traceClaimItem(id, e.status, analysis.testId, ctx));
      } else if (e.status === 'not_available') {
        const resolved = e.ref && !tool ? resolveRef(e.ref, ctx).file : null;
        const pattern = KIND_FILES[e.kind];
        const p = resolved ? provenance(resolved, ctx) : null;
        if (resolved && p?.level === 'denied') {
          items.push({ id, status: 'pass', detail: `claimed not available: ${resolved} is in the snapshot, but ${p.via}`, tag: 'access_denied' });
        } else if (resolved) items.push({ id, status: 'fail', detail: `claimed not available, but ${resolved} is in the snapshot`, tag: 'false_unavailable' });
        else if (!e.ref && pattern && ctx.files.paths.some((p) => pattern.test(p))) {
          items.push({ id, status: 'review', detail: `claimed not available, but the snapshot has a ${e.kind} file (attribution to this test unresolved)`, tag: 'unresolved' });
        } else items.push({ id, status: 'pass', detail: 'not available, and not in the snapshot', tag: 'unavailable' });
      } else if (tool) {
        items.push(
          mcpObtained(tool, analysis.testId, ctx)
            ? { id, status: 'pass', detail: 'MCP result obtained', tag: 'verified' }
            : { id, status: 'fail', detail: 'claimed inspected, but no successful MCP call returned it', tag: 'confirmed_false' },
        );
      } else if (!e.ref) {
        items.push({ id, status: 'review', detail: 'claimed inspected without a ref; provenance cannot be resolved', tag: 'unresolved' });
      } else {
        const { file, outside } = resolveRef(e.ref, ctx);
        if (outside) items.push({ id, status: 'fail', detail: 'ref is outside the workspace', tag: 'confirmed_false' });
        else if (!file) items.push({ id, status: 'fail', detail: 'claimed inspected, but no such file is in the snapshot', tag: 'confirmed_false' });
        else items.push(fileItem(id, file, ctx, 'claimed inspected'));
      }
    }
  }
  return fromItems('evidence_validity', items, 'every evidence claim is verified by the transcript and the snapshot');
}

function evidenceSufficiencyCheck(ctx: Context, matched: Matched[]): Check {
  const required = ctx.truth.requiredEvidence;
  const unavailable = ctx.truth.expected.unavailableEvidence ?? [];
  if (required.length === 0 && unavailable.length === 0) return check('evidence_sufficiency', 'not_applicable', 'no required evidence');
  const items: Item[] = [];
  for (const m of matched) {
    for (const kind of unavailable) items.push(unavailableItem(kind, m.analysis));
    for (const r of required) {
      const id = `${r.kind}:${r.refPattern}`;
      const pattern = new RegExp(r.refPattern, 'i');
      let item: Item;
      if (!m.analysis || !m.testId) {
        item = { id, status: 'fail', detail: 'no investigation', tag: 'not_inspected' };
      } else if (r.kind === 'mcp') {
        const tool = Object.entries(MCP_TOOL_NAMES).find(([name]) => pattern.test(name))?.[1];
        const claimed = m.analysis.evidence.some((e) => e.kind === 'mcp' && e.status === 'inspected' && e.ref && pattern.test(e.ref));
        const obtained = tool ? mcpObtained(tool, m.testId, ctx) : false;
        item = sufficiency(id, claimed, { level: obtained ? 'verified' : 'none', via: obtained ? 'MCP result obtained' : 'no MCP result' }, true);
      } else {
        const candidates = ctx.files.paths.filter((p) => pattern.test(p));
        const claimed = m.analysis.evidence.some((e) => {
          if (e.kind !== r.kind || e.status !== 'inspected' || !e.ref) return false;
          // A trace obtained through get_trace_summary is claimed by naming the tool.
          if (r.kind === 'trace' && toolOf(e.ref) === MCP_TRACE) return true;
          const file = resolveRef(e.ref, ctx).file;
          return file !== null && pattern.test(file);
        });
        const levels = candidates.map((f) => provenance(f, ctx));
        if (r.kind === 'trace') levels.push(traceProvenance(pattern, r.observations, m.testId, ctx));
        const best = (['verified', 'partial', 'denied', 'failed', 'none'] as const).map((l) => levels.find((p) => p.level === l)).find(Boolean) ?? { level: 'none', via: 'no file' };
        item = sufficiency(id, claimed, best, candidates.length > 0);
      }
      if (r.provisional && item.status === 'fail') item = { ...item, status: 'review', detail: `${item.detail} (requirement is provisional)` };
      items.push(item);
    }
  }
  const acknowledged = unavailable.length > 0 ? `; ${unavailable.join(', ')} reported as not available` : '';
  return fromItems('evidence_sufficiency', items, `all ${required.length} required evidence item(s) verified and reported${acknowledged}`);
}

const KIND_WORDS: Record<ModelInvestigation['evidence'][number]['kind'], string> = { mcp: 'mcp', source: 'source', error_context: 'error[- ]context', screenshot: 'screenshot', trace: 'trace' };

/**
 * Evidence the run did not keep (truth `unavailableEvidence`): the investigation must say so in its
 * evidence list. Claiming to have inspected it is already a confirmed-false evidence claim
 * (evidence_validity); here it also fails, because the absence went unrecognized.
 */
function unavailableItem(kind: ModelInvestigation['evidence'][number]['kind'], analysis: ModelInvestigation | null): Item {
  const id = `unavailable:${kind}`;
  if (!analysis) return { id, status: 'fail', detail: 'no investigation', tag: 'not_inspected' };
  const entries = analysis.evidence.filter((e) => e.kind === kind);
  if (entries.some((e) => e.status === 'inspected')) return { id, status: 'fail', detail: `claims to have inspected a ${kind} the run did not keep`, tag: 'confirmed_false' };
  if (entries.some((e) => e.status === 'not_available')) return { id, status: 'pass', detail: `${kind} reported as not available`, tag: 'unavailable' };
  if (entries.length > 0) return { id, status: 'review', detail: `${kind} marked skipped rather than not available`, tag: 'unresolved' };
  const word = KIND_WORDS[kind];
  const mentioned = new RegExp(`\\b(no|without|missing)\\s+(an?\\s+)?${word}|${word}s?\\s+(is\\s+|was\\s+|were\\s+)?(not available|unavailable|missing|off|disabled|not (recorded|captured|kept))`, 'i');
  return mentioned.test(searchable(reasoningOf(analysis)))
    ? { id, status: 'review', detail: `not in the evidence list, but the reasoning says no ${kind} is available`, tag: 'unresolved' }
    : { id, status: 'fail', detail: `does not acknowledge that no ${kind} is available`, tag: 'unacknowledged' };
}

function sufficiency(id: string, claimed: boolean, p: Provenance, available: boolean): Item {
  if (!available) return { id, status: 'review', detail: 'required by the truth file, but the snapshot has no such file', tag: 'unresolved' };
  if (p.level === 'verified') {
    return claimed ? { id, status: 'pass', detail: 'verified and reported', tag: 'verified' } : { id, status: 'review', detail: 'inspected (transcript) but not reported as evidence', tag: 'unreported' };
  }
  if (p.level === 'partial') return { id, status: 'review', detail: `provenance unresolved: ${p.via}`, tag: 'unresolved' };
  // Denied access is honest, but the required contents were still never obtained.
  if (p.level === 'denied' && !claimed) return { id, status: 'fail', detail: `not inspected: ${p.via}`, tag: 'access_denied' };
  if (!claimed) return { id, status: 'fail', detail: 'not inspected', tag: 'not_inspected' };
  return p.level === 'failed' || p.level === 'denied'
    ? { id, status: 'fail', detail: `reported as inspected, but ${p.via}`, tag: 'confirmed_false' }
    : { id, status: 'fail', detail: 'reported as inspected, but no channel in the transcript shows it (unsupported)', tag: 'unsupported' };
}

function citationsCheck(ctx: Context, matched: Matched[]): Check {
  const items: Item[] = [];
  for (const m of matched) {
    if (!m.analysis) continue;
    const refs = m.analysis.analysis.flatMap((a) => a.evidenceRefs);
    if (refs.length === 0) items.push({ id: m.test.title, status: 'review', detail: 'no analysis point cites evidence', tag: 'unresolved' });
    for (const ref of new Set(refs)) {
      const tool = toolOf(ref);
      if (tool) {
        items.push(
          mcpObtained(tool, m.testId, ctx)
            ? { id: ref, status: 'pass', detail: 'MCP result obtained', tag: 'verified' }
            : {
                id: ref,
                status: 'fail',
                detail: tool === MCP_TRACE ? `cites get_trace_summary, but no trace evidence was obtained for this test (${callStatuses(tracesFor(m.testId, ctx))})` : 'cites an MCP result that was never obtained',
                tag: 'confirmed_false',
              },
        );
        continue;
      }
      const { file, outside } = resolveRef(ref, ctx);
      if (file) items.push(fileItem(ref, file, ctx, 'cites'));
      else if (PATH_LIKE.test(ref.trim()) && outside) items.push({ id: ref, status: 'fail', detail: 'cites a path outside the workspace', tag: 'confirmed_false' });
      else if (PATH_LIKE.test(ref.trim())) items.push({ id: ref, status: 'fail', detail: 'cites a file that is not in the snapshot', tag: 'confirmed_false' });
      else items.push({ id: ref, status: 'review', detail: 'does not resolve to a snapshot file or MCP tool', tag: 'unresolved' });
    }
  }
  if (items.length === 0) return check('citations', 'not_applicable', 'no analysis to check');
  return fromItems('citations', items, 'every citation resolves to evidence the agent verifiably obtained');
}

// ---------------------------------------------------------------------------
// Trace evidence through get_trace_summary (version 8)

type TraceSummary = TraceSummaryOutput;
const usable = (t: TraceCall): t is TraceCall & { output: TraceSummary } => (t.status === 'ok' || t.status === 'partial') && t.output !== null;

function tracesFor(testId: string | null, ctx: Context): TraceCall[] {
  return testId === null ? [] : ctx.observed.traces.filter((t) => t.testId === testId);
}

function callStatuses(list: TraceCall[]): string {
  return list.map((t) => `retry ${t.retry ?? '?'}: ${t.status}${t.reasons.length ? ` (${t.reasons.join(', ')})` : ''}`).join('; ') || 'no call';
}

/** An evidence row that names get_trace_summary. Only ok and partial results count as inspected. */
function traceClaimItem(id: string, status: 'inspected' | 'not_available', testId: string | null, ctx: Context): Item {
  const list = tracesFor(testId, ctx);
  const got = list.filter(usable);
  if (status === 'inspected') {
    if (got.length > 0) return { id, status: 'pass', detail: `get_trace_summary returned trace evidence (${callStatuses(got)})`, tag: 'verified' };
    return list.length > 0
      ? { id, status: 'fail', detail: `claimed inspected, but get_trace_summary returned no trace evidence (${callStatuses(list)})`, tag: 'confirmed_false' }
      : { id, status: 'fail', detail: 'claimed inspected, but get_trace_summary was never called for this test', tag: 'confirmed_false' };
  }
  if (got.length > 0) {
    return { id, status: 'review', detail: `reported not available, but get_trace_summary returned trace evidence (${callStatuses(got)}); check which attempt it means`, tag: 'unresolved' };
  }
  if (list.length > 0) {
    return { id, status: 'pass', detail: `not available: get_trace_summary returned ${callStatuses(list)}`, tag: list.every((t) => t.status === 'denied') ? 'access_denied' : 'unavailable' };
  }
  return ctx.files.paths.some((p) => KIND_FILES.trace!.test(p))
    ? { id, status: 'review', detail: 'names get_trace_summary as not available, but it was never called and the snapshot has a trace', tag: 'unresolved' }
    : { id, status: 'pass', detail: 'not available, and not in the snapshot', tag: 'unavailable' };
}

/**
 * A required trace met through get_trace_summary. With truth observations, a returned summary must
 * contain each of them; without, a fully read summary (status ok) is enough. What is missing from a
 * partial read may be in the unread part, so it goes to review (level partial), never to fail.
 */
function traceProvenance(pattern: RegExp, observations: TraceObservation[] | undefined, testId: string | null, ctx: Context): Provenance {
  const list = tracesFor(testId, ctx);
  const got = list.filter(usable).filter((t) => pattern.test(t.output.trace.path ?? ''));
  if (got.length === 0) {
    if (list.length === 0) return { level: 'none', via: 'no get_trace_summary call for this test' };
    if (list.every((t) => t.status === 'denied')) return { level: 'denied', via: `every get_trace_summary call was denied (${callStatuses(list)})` };
    return { level: 'failed', via: `get_trace_summary returned no trace evidence (${callStatuses(list)})` };
  }
  if (observations) {
    const missing = observations.filter((o) => !got.some((t) => hasObservation(o, t.output)));
    if (missing.length === 0) return { level: 'verified', via: `get_trace_summary returned the required observations (${callStatuses(got)})` };
    const partly = got.some((t) => t.status === 'partial') ? '; the trace was only partly read, so they may be in the unread part' : '';
    return { level: 'partial', via: `get_trace_summary (${callStatuses(got)}) did not return ${missing.map(describeObservation).join(', ')}${partly}` };
  }
  const full = got.find((t) => t.status === 'ok');
  return full
    ? { level: 'verified', via: `get_trace_summary returned the whole trace (retry ${full.retry})` }
    : { level: 'partial', via: `get_trace_summary returned only partial traces (${callStatuses(got)}); the required evidence may be in the unread part` };
}

function hasObservation(o: TraceObservation, out: TraceSummary): boolean {
  const re = new RegExp(o.path, 'i');
  if (o.source === 'backend') return (out.backendFetches?.items ?? []).some((b) => b.path !== null && re.test(b.path) && (o.status === undefined || b.status === o.status));
  return (out.network?.requests ?? []).some((r) => r.path !== null && re.test(r.path) && (o.status === undefined || r.status === o.status) && (o.marker === undefined || r.marker === o.marker));
}

function describeObservation(o: TraceObservation): string {
  return `${o.source === 'backend' ? 'a backend fetch' : 'a request'} matching /${o.path}/${o.status !== undefined ? ` with status ${o.status}` : ''}${o.marker ? ` and marker ${o.marker}` : ''}`;
}

/** Trace attachments the report lists for a test (every attempt), as snapshot paths. */
function traceFilesOf(testId: string | null, ctx: Context): string[] {
  const details = testId ? ctx.observed.details.get(testId) : undefined;
  if (!details) return [];
  const paths = details.attempts.flatMap((a) => a.attachments.filter((x) => x.name === 'trace' && x.location === 'repo' && x.exists === true && x.path).map((x) => x.path!));
  return [...new Set(paths.map((p) => ctx.files.lookup.get(key(p))).filter((p): p is string => p !== undefined))];
}

/** Per expected test: whether its trace was obtained through MCP, through a tool call on the file (Bash fallback), or not at all. */
function traceAcquisition(ctx: Context): z.infer<typeof TraceAcquisition>[] {
  return matchInvestigations(ctx).map((m) => {
    const testId = m.testId ?? ctx.observed.list?.failures.find((f) => f.title === m.test.title && f.file === m.test.file)?.testId ?? null;
    const list = tracesFor(testId, ctx);
    const files = traceFilesOf(testId, ctx);
    const viaMcp = list.some(usable);
    const viaFile = files.some((f) => provenance(f, ctx).level === 'verified');
    const limitations: string[] = [];
    for (const t of list) {
      if (!usable(t)) limitations.push(`retry ${t.retry ?? '?'}: ${t.status}${t.reasons.length ? ` (${t.reasons.join(', ')})` : ''}; no trace evidence`);
      else if (t.status === 'partial') limitations.push(`retry ${t.retry}: partial (${t.reasons.join(', ') || 'no reason given'}); events not listed are unknown`);
      else {
        const omitted = (t.output.network?.omitted.overLimit ?? 0) + (t.output.network?.omitted.notRetained ?? 0);
        if (omitted > 0) limitations.push(`retry ${t.retry}: ${omitted} request record(s) not listed`);
      }
    }
    const acquisition = viaMcp && viaFile ? 'mcp_and_bash' : viaMcp ? 'mcp' : viaFile ? 'bash' : files.length > 0 ? 'not_obtained' : 'no_trace';
    return { title: m.test.title, testId, acquisition, summaries: list.map((t) => ({ retry: t.retry, status: t.status, reasons: t.reasons })), limitations };
  });
}

// Claim extraction. Deliberately narrow: only sentences that cite get_trace_summary, and only these
// shapes. Anything else is not checked (a limitation, not a pass).
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s/"'`)]+(\/[^\s"'`),;]*)?/gi;
const PATH_IN_TEXT = /(?<![\w.:/-])(\/[A-Za-z0-9._~%:-]+(?:\/[A-Za-z0-9._~%:-]+)*)\/?/g;
const STATUS_IN_TEXT = /(?<![\w:./#-])([1-5]\d{2})(?![\w%/-]|\.\d)(?!\s*(?:ms|s\b|sec|seconds|px|bytes|kb|mb|requests?|records?|lines?|entries))/gi;
const FILE_EXT = /\.(ts|js|zip|md|png|jpe?g|webm|trace|network)$/i;
const RETRY_STATUS = /\bretry\s*#?\s*(\d+)\b[^.;]{0,24}?\b(ok|partial|missing|unsupported)\b/gi;
const MARKER_CLAIM = /\bmarker\b["'`]?\s*[:=]?\s*["'`]?(fulfilled|continued|aborted|none|unknown)\b|_wasFulfilled["'`]?\s*[:=]?\s*true|\b(no|without an?) (route )?marker\b/i;
const LINK_CLAIM = /\b(?:fetch\.)?link\b["'`]?\s*[:=]\s*["'`]?(linked|none|unresolved)\b|\b(linked) (?:to|by) (?:a |the )?(?:backend |route\.fetch\(\) )?fetch\b|\b(no fetch link|not linked)\b/i;
const STATUS_CHANGED_CLAIM = /statusChanged["'`]?\s*[:=]\s*(true|false)/i;
const UNCHANGED_CLAIM = /\bunchanged\b|\bpass(?:ed|es)? (?:it |the response |the error )?(?:through|on) (?:as[- ]is|unmodified)|\bnot (?:changed|modified|altered)\b/i;
const CHANGED_CLAIM = /\b(?:status|response)\b[^.;]{0,30}\b(?:was |were )?(?:changed|modified|rewritten|overridden|altered)\b|\b(?:changed|modified|rewrote|overrode|altered)\b[^.;]{0,20}\b(?:status|response)\b/i;
const FETCHED_STATUS_CLAIM = /fetchedStatus["'`]?\s*[:=]\s*(\d{3})|\bbackend (?:returned|responded with|sent) (?:an? )?(?:HTTP )?(\d{3})\b/i;
const TEST_CREATED_CLAIM = /\btest[- ](?:created|generated|fabricated|made|built)\b|\b(?:created|fabricated|built|generated|invented) by the test\b|\bthe test (?:itself )?(?:created|fabricated|built|generated|invented) (?:the|a|an|its own)\b|\b(?:mocked|stubbed|faked) (?:the |a |an )?(?:500|response|error|status)\b/i;
const NO_BACKEND_CLAIM = /\bno (?:backend|server) (?:fetch|request|call)|\bnever reached the (?:backend|server)\b|\b(?:did not|didn't) reach the (?:backend|server)\b/i;
const ABSENCE_CLAIM = /\bno (page ?errors?|failed requests?|network (?:errors?|failures?)|console errors?)\b/i;
const COMPLETE_CLAIM = /\b(?:complete|full|entire|whole) trace\b|\bfully read\b|coverage\.complete["'`]?\s*[:=]\s*true/i;
const NEGATION_BEFORE = /\b(not|never|no|without|cannot|can't|doesn't|does not|isn't|is not)\b[^.;]{0,30}$/i;

function samePath(claimed: string, observed: string | null): boolean {
  if (observed === null) return false;
  const a = claimed.replace(/\/+$/, '').split('/');
  const b = observed.replace(/\/+$/, '').split('/');
  return a.length === b.length && a.every((s, i) => s === b[i] || b[i] === ':redacted');
}

/**
 * Compares structured trace claims with the get_trace_summary results the session obtained for the
 * test. A claim is checked only in an evidence note or analysis point that cites get_trace_summary.
 * Pass: a returned summary shows it. Fail: a returned summary clearly shows otherwise, or no trace
 * evidence was obtained at all. Review: the summary can't decide (partial, omitted, no link).
 */
function traceConsistencyCheck(ctx: Context, matched: Matched[]): Check {
  const items: Item[] = [];
  const add = (item: Item) => {
    if (!items.some((i) => i.id === item.id)) items.push(item);
  };
  for (const m of matched) {
    if (!m.analysis) continue;
    const units = [
      ...m.analysis.evidence.filter((e) => e.kind === 'trace' && e.status === 'inspected' && toolOf(e.ref) === MCP_TRACE).map((e) => `${e.ref}: ${e.note}`),
      ...m.analysis.analysis.filter((a) => a.evidenceRefs.some((r) => toolOf(r) === MCP_TRACE)).map((a) => a.point),
    ];
    const all = tracesFor(m.testId, ctx);
    const obtained = all.filter(usable);
    for (const unit of units) {
      const text = searchable([unit]).replace(URL_IN_TEXT, (_, p: string | undefined) => ` ${(p ?? '/').split(/[?#]/)[0]}`);
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        const id = (kind: string, what: string) => `${m.test.title}: ${kind} ${what}`;
        // Retry attribution. A retry stated with its trace status ("retry 1: missing") is judged by
        // that status below; a retry cited for its contents must have returned trace evidence.
        const stated = new Map([...sentence.matchAll(RETRY_STATUS)].map((x) => [Number(x[1]), x[2]!.toLowerCase()]));
        const mentioned = [...new Set([...sentence.matchAll(/\bretry\s*#?\s*(\d+)\b/gi)].map((x) => Number(x[1])))];
        const retries = mentioned.filter((r) => stated.get(r) !== 'missing' && stated.get(r) !== 'unsupported');
        for (const retry of retries.filter((r) => !stated.has(r))) {
          const calls = all.filter((t) => t.retry === retry);
          if (calls.some(usable)) add({ id: id('retry', String(retry)), status: 'pass', detail: `retry ${retry}: get_trace_summary returned trace evidence`, tag: 'consistent' });
          else if (calls.length > 0) add({ id: id('retry', String(retry)), status: 'fail', detail: `cites retry ${retry}, but get_trace_summary returned ${callStatuses(calls)}`, tag: 'retry_mismatch' });
          else add({ id: id('retry', String(retry)), status: 'fail', detail: `cites retry ${retry}, but get_trace_summary was called only for ${callStatuses(all)}`, tag: 'retry_mismatch' });
        }
        for (const x of sentence.matchAll(RETRY_STATUS)) {
          const retry = Number(x[1]);
          const claimed = x[2]!.toLowerCase();
          const call = all.find((t) => t.retry === retry && t.status !== 'pending');
          if (!call) {
            add({ id: id('retry', String(retry)), status: 'fail', detail: `reports retry ${retry} as ${claimed}, but get_trace_summary was called only for ${callStatuses(all)}`, tag: 'retry_mismatch' });
            continue;
          }
          add(
            call.status === claimed
              ? { id: id('trace status', `retry ${retry}`), status: 'pass', detail: `retry ${retry} reported as ${claimed}, as returned`, tag: 'consistent' }
              : { id: id('trace status', `retry ${retry}`), status: 'fail', detail: `retry ${retry} reported as ${claimed}, but get_trace_summary returned ${call.status}`, tag: 'contradiction' },
          );
        }

        const chosen = retries.length > 0 ? obtained.filter((t) => retries.includes(t.retry ?? -1)) : obtained;
        const paths = [...new Set([...sentence.matchAll(PATH_IN_TEXT)].map((x) => x[1]!.replace(/[.,:]+$/, '')).filter((p) => !FILE_EXT.test(p)))];
        const statuses = [...new Set([...sentence.matchAll(STATUS_IN_TEXT)].map((x) => Number(x[1])))];
        const marker = MARKER_CLAIM.exec(sentence);
        const link = LINK_CLAIM.exec(sentence);
        const changed = STATUS_CHANGED_CLAIM.exec(sentence)?.[1]?.toLowerCase() === 'true' ? true : STATUS_CHANGED_CLAIM.test(sentence) || UNCHANGED_CLAIM.test(sentence) ? false : CHANGED_CLAIM.test(sentence) ? true : null;
        const fetched = FETCHED_STATUS_CLAIM.exec(sentence);
        const created = TEST_CREATED_CLAIM.exec(sentence);
        const createdNegated = created ? NEGATION_BEFORE.test(sentence.slice(0, created.index)) : false;
        const noBackend = NO_BACKEND_CLAIM.test(sentence);
        const absence = ABSENCE_CLAIM.exec(sentence);
        const complete = COMPLETE_CLAIM.exec(sentence);
        const networkClaim = (paths.length > 0 && statuses.length > 0) || marker || link || changed !== null || fetched || (created && !createdNegated) || noBackend;
        if (!networkClaim && !absence && !complete) continue;

        if (chosen.length === 0) {
          // Nothing to compare with: the claim rests on trace evidence the session never obtained.
          if (networkClaim) add({ id: id('claim', sentence.slice(0, 60)), status: 'fail', detail: `trace claim without obtained trace evidence (${callStatuses(retries.length ? all.filter((t) => retries.includes(t.retry ?? -1)) : all)}): "${quoteOf(sentence)}"`, tag: 'unsupported' });
          continue;
        }
        const requests = chosen.flatMap((t) => t.output.network?.requests ?? []);
        const backend = chosen.flatMap((t) => t.output.backendFetches?.items ?? []);
        const fulfillments = chosen.flatMap((t) => t.output.routes?.fulfillments ?? []);
        const linked = fulfillments.filter((f) => f.fetch.link === 'linked');
        const complete_ = (t: (typeof chosen)[number]) =>
          t.status === 'ok' && (t.output.network?.omitted.overLimit ?? 0) === 0 && (t.output.network?.omitted.notRetained ?? 0) === 0 && t.output.backendFetches?.total === t.output.backendFetches?.returned;
        const allComplete = chosen.every(complete_);
        const anyPartial = chosen.some((t) => t.status === 'partial' || t.output.coverage?.countsAreLowerBounds === true);
        const where = callStatuses(chosen);

        // Request path and HTTP status.
        if (paths.length === 1 && statuses.length === 1) {
          const [p, s] = [paths[0]!, statuses[0]!];
          const records = [...requests, ...backend].filter((r) => samePath(p, r.path));
          if (records.some((r) => r.status === s)) add({ id: id('status', `${p} ${s}`), status: 'pass', detail: `${p} with status ${s} is in the summary (${where})`, tag: 'consistent' });
          else if (records.length > 0) {
            add({ id: id('status', `${p} ${s}`), status: 'fail', detail: `claims ${p} returned ${s}; the summary shows ${records.map((r) => r.status ?? r.result).join(', ')} (${where})`, tag: 'contradiction' });
          } else {
            const benignOmitted = s < 400 && chosen.some((t) => (t.output.network?.omitted.benign ?? 0) > 0);
            add(
              allComplete && !benignOmitted
                ? { id: id('status', `${p} ${s}`), status: 'fail', detail: `claims ${p} returned ${s}, but no such request is in the complete summary (${where})`, tag: 'contradiction' }
                : { id: id('status', `${p} ${s}`), status: 'review', detail: `claims ${p} returned ${s}; not listed, but the summary is partial or omits records (${where})`, tag: 'unresolved' },
            );
          }
        } else if (paths.length > 0 && statuses.length > 0) {
          for (const p of paths) {
            const records = [...requests, ...backend].filter((r) => samePath(p, r.path));
            if (records.length > 0 && !records.some((r) => r.status !== null && statuses.includes(r.status))) {
              add({ id: id('status', p), status: 'review', detail: `names ${p} with statuses ${statuses.join(', ')}; the summary shows ${records.map((r) => r.status ?? r.result).join(', ')} (several values, pairing unclear)`, tag: 'unresolved' });
            }
          }
        }

        // Route marker.
        if (marker) {
          const claimed = (marker[1]?.toLowerCase() ?? (marker[2] ? 'none' : 'fulfilled')) as Request['marker'];
          const scope = paths.length === 1 ? requests.filter((r) => samePath(paths[0]!, r.path)) : paths.length === 0 ? requests : [];
          if (scope.some((r) => r.marker === claimed)) add({ id: id('marker', `${paths[0] ?? 'any'} ${claimed}`), status: 'pass', detail: `marker ${claimed} is in the summary (${where})`, tag: 'consistent' });
          else if (paths.length === 1 && scope.length > 0) {
            add({ id: id('marker', `${paths[0]} ${claimed}`), status: 'fail', detail: `claims marker ${claimed} for ${paths[0]}; the summary shows ${scope.map((r) => r.marker).join(', ')}`, tag: 'contradiction' });
          } else if (scope.length > 0 && allComplete) {
            add({ id: id('marker', `any ${claimed}`), status: 'fail', detail: `claims marker ${claimed}, but no request in the complete summary has it`, tag: 'contradiction' });
          } else if (paths.length <= 1) {
            add({ id: id('marker', `${paths[0] ?? 'any'} ${claimed}`), status: 'review', detail: `claims marker ${claimed}; the summary can't confirm it (request not listed, or the summary is partial)`, tag: 'unresolved' });
          }
        }

        // Fetch link.
        if (link) {
          const claimed = (link[1] ?? link[2] ?? (link[3] ? 'none' : 'linked'))!.toLowerCase();
          if (fulfillments.some((f) => f.fetch.link === claimed)) add({ id: id('link', claimed), status: 'pass', detail: `a fulfillment with fetch link ${claimed} is in the summary`, tag: 'consistent' });
          else if (fulfillments.length > 0 || allComplete) {
            add({ id: id('link', claimed), status: 'fail', detail: `claims fetch link ${claimed}; the summary shows ${fulfillments.map((f) => f.fetch.link).join(', ') || 'no route.fulfill call'}`, tag: 'contradiction' });
          } else add({ id: id('link', claimed), status: 'review', detail: `claims fetch link ${claimed}; no fulfillment is listed in the partial summary`, tag: 'unresolved' });
        }

        // Status modification: only an identifier link proves or disproves it.
        if (changed !== null) {
          const label = changed ? 'changed' : 'unchanged';
          if (linked.length === 0) {
            add(
              fulfillments.length === 0 && allComplete && !requests.some((r) => r.marker === 'fulfilled')
                ? { id: id('status change', label), status: 'fail', detail: `claims the status was ${label} by a route handler, but the complete summary has no route.fulfill call`, tag: 'contradiction' }
                : { id: id('status change', label), status: 'review', detail: `claims the status was ${label}; no fulfillment is linked to a fetch, so the trace can't show it`, tag: 'unresolved' },
            );
          } else if (linked.some((f) => f.fetch.link === 'linked' && f.fetch.statusChanged === changed)) {
            add({ id: id('status change', label), status: 'pass', detail: `a linked fulfillment has statusChanged ${changed}`, tag: 'consistent' });
          } else if (linked.every((f) => f.fetch.link === 'linked' && f.fetch.statusChanged === !changed)) {
            add({ id: id('status change', label), status: 'fail', detail: `claims the status was ${label}; every linked fulfillment has statusChanged ${!changed}`, tag: 'contradiction' });
          } else add({ id: id('status change', label), status: 'review', detail: `claims the status was ${label}; the linked fulfillments don't record it`, tag: 'unresolved' });
        }

        // Status the backend returned.
        if (fetched) {
          const s = Number(fetched[1] ?? fetched[2]);
          const seen = [...linked.map((f) => (f.fetch.link === 'linked' ? f.fetch.fetchedStatus : null)), ...backend.map((b) => b.status)].filter((x): x is number => x !== null);
          if (seen.includes(s)) add({ id: id('fetched status', String(s)), status: 'pass', detail: `a backend fetch returned ${s}`, tag: 'consistent' });
          else if (seen.length > 0 && allComplete) add({ id: id('fetched status', String(s)), status: 'fail', detail: `claims the backend returned ${s}; the summary shows ${seen.join(', ')}`, tag: 'contradiction' });
          else add({ id: id('fetched status', String(s)), status: 'review', detail: `claims the backend returned ${s}; the summary can't confirm it`, tag: 'unresolved' });
        }

        // "Test-created": a fulfilled marker alone is not proof; a pass-through link disproves it.
        if (created && !createdNegated) {
          const unlinkedOwnBody = fulfillments.some((f) => f.fetch.link === 'none' && f.bodyProvided);
          if (linked.some((f) => f.fetch.link === 'linked' && f.fetch.statusChanged === true)) {
            add({ id: id('origin', 'test-created'), status: 'pass', detail: 'a linked fulfillment shows the test changed the status', tag: 'consistent' });
          } else if (unlinkedOwnBody) {
            add({ id: id('origin', 'test-created'), status: 'pass', detail: 'consistent with an unlinked fulfillment that supplied its own body (the trace does not prove who made the body)', tag: 'consistent' });
          } else if (linked.length > 0 && linked.length === fulfillments.length && linked.every((f) => f.fetch.link === 'linked' && f.fetch.statusChanged === false)) {
            add({ id: id('origin', 'test-created'), status: 'fail', detail: 'claims a test-created response, but every fulfillment reused a backend fetch with its status unchanged', tag: 'contradiction' });
          } else if (fulfillments.length === 0 && allComplete && !requests.some((r) => r.marker === 'fulfilled')) {
            add({ id: id('origin', 'test-created'), status: 'fail', detail: 'claims a test-created response, but the complete summary has no route.fulfill call and no fulfilled request', tag: 'contradiction' });
          } else add({ id: id('origin', 'test-created'), status: 'review', detail: 'claims a test-created response; the trace summary alone can neither show nor rule it out', tag: 'unresolved' });
        }

        // "No backend fetch": an unlinked fulfillment does not prove it; backendFetches can disprove it.
        if (noBackend) {
          const total = chosen.reduce((n, t) => n + (t.output.backendFetches?.total ?? 0), 0);
          if (total > 0) add({ id: id('backend', 'none claimed'), status: 'fail', detail: `claims no backend fetch, but the summary records ${total} API-context fetch(es)`, tag: 'contradiction' });
          else if (allComplete) add({ id: id('backend', 'none claimed'), status: 'pass', detail: 'no backend fetch in the complete summary', tag: 'consistent' });
          else add({ id: id('backend', 'none claimed'), status: 'review', detail: 'claims no backend fetch; the summary is partial, so its absence is not shown', tag: 'unresolved' });
        }

        // Absence claims: a partial read cannot show that something did not happen.
        if (absence) {
          const what = absence[1]!.toLowerCase();
          const present = /page ?error/.test(what)
            ? chosen.some((t) => (t.output.pageErrors?.count ?? 0) > 0)
            : /console/.test(what)
              ? chosen.some((t) => (t.output.console?.counts.error ?? 0) > 0)
              : /failed/.test(what)
                ? requests.some((r) => r.result === 'failed')
                : requests.some((r) => r.result === 'failed' || (r.status ?? 0) >= 400);
          if (present) add({ id: id('absence', what), status: 'fail', detail: `claims ${absence[0]}, but the summary records some`, tag: 'contradiction' });
          else if (anyPartial) add({ id: id('absence', what), status: 'review', detail: `claims ${absence[0]}; the summary is partial, so their absence is not shown`, tag: 'unresolved' });
          else add({ id: id('absence', what), status: 'pass', detail: `none in the complete summary`, tag: 'consistent' });
        }

        // Completeness.
        if (complete) {
          add(
            chosen.some((t) => t.status === 'partial')
              ? { id: id('completeness', 'complete'), status: 'fail', detail: `describes the trace as complete, but get_trace_summary returned partial (${where})`, tag: 'contradiction' }
              : { id: id('completeness', 'complete'), status: 'pass', detail: 'the summary is complete', tag: 'consistent' },
          );
        }
      }
    }
  }
  if (items.length === 0) return check('trace_consistency', 'not_applicable', 'no structured trace claims cite get_trace_summary');
  return fromItems('trace_consistency', items, 'every structured trace claim agrees with the get_trace_summary results');
}

type Request = NonNullable<TraceSummary['network']>['requests'][number];

function quoteOf(t: string): string {
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

// ---------------------------------------------------------------------------
// Helpers

/** Higher is more confident. CONFIDENCE_LEVELS is listed High first, so it can't be used as the order. */
const rank = (level: string) => ['Low', 'Medium', 'High'].indexOf(level);

/** Text for pattern matching: ANSI escapes removed, whitespace collapsed. Patterns are case-insensitive. */
function searchable(parts: string[]): string {
  // eslint-disable-next-line no-control-regex
  return parts.join('\n').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ');
}

function firstMatch(patterns: string[], text: string): string | null {
  return patterns.find((p) => new RegExp(p, 'i').test(text)) ?? null;
}

/** The investigation's reasoning: summary, analysis points and the confidence justification. */
function reasoningOf(analysis: ModelInvestigation): string[] {
  return [analysis.failureSummary, ...analysis.analysis.map((a) => a.point), analysis.confidence.justification];
}

/** Phrases that only describe running the test again. */
const VERIFICATION_PHRASES = ['rerun', 're-run', 'run it again', 'run the test again', 'npx playwright test'];

/**
 * A criterion about re-running the test rather than about the cause: every one of its patterns
 * matches a pure re-run phrase. Only such criteria may be met from verificationSteps, so a
 * verification command can never stand in for a causal claim or a fix.
 */
function verificationOnly(anyOf: string[]): boolean {
  return anyOf.length > 0 && anyOf.every((p) => VERIFICATION_PHRASES.some((phrase) => new RegExp(p, 'i').test(phrase)));
}

/** Words that make a sentence tentative. Matched outside the forbidden pattern's own match. */
const HEDGE = /\b(may|might|could|possibly|perhaps|probably|likely|unlikely|unclear|uncertain|whether|unknown|cannot|unable|if|suggests?|hypothes\w*|insufficient|without|either)\b|can't|not (certain|sure|clear|known|confirmed|determined|established|enough)|no (evidence|way)/i;
/** A negation before the match ("there is no sign that the server was down"). */
const NEGATED = /\b(no|not|never|nothing|neither|nor|none)\b|n't\b/i;

type Forbidden = GroundTruth['rootCause']['forbiddenClaims'][number];

/**
 * A forbidden claim or recommendation. Severity "review" (the default) keeps the Stage 2.5 rule: any
 * match in the whole text goes to review. Severity "fail" is judged per sentence: a plain statement
 * fails; a match only in hedged or negated sentences goes to review.
 */
function forbiddenItem(f: Forbidden, parts: string[], kind: 'claim' | 'recommendation'): Item | null {
  if ((f.severity ?? 'review') === 'review') {
    if (!firstMatch([f.pattern], searchable(parts))) return null;
    return { id: `forbidden:${f.id}`, status: 'review', detail: `suspicious ${kind} (${f.description}); may be a negation`, tag: 'forbidden' };
  }
  const pattern = new RegExp(f.pattern, 'i');
  const sentences = parts.flatMap((p) => searchable([p]).split(/(?<=[.!?;:])\s+/)).filter((sentence) => pattern.test(sentence));
  if (sentences.length === 0) return null;
  const plain = sentences.find((sentence) => {
    const m = pattern.exec(sentence)!;
    const before = sentence.slice(0, m.index);
    return !NEGATED.test(before) && !HEDGE.test(`${before} ${sentence.slice(m.index + m[0].length)}`);
  });
  const quote = (t: string) => `"${t.length > 160 ? `${t.slice(0, 157)}...` : t}"`;
  return plain
    ? { id: `forbidden:${f.id}`, status: 'fail', detail: `unsupported definitive ${kind} (${f.description}): ${quote(plain)}`, tag: 'forbidden_definitive' }
    : { id: `forbidden:${f.id}`, status: 'review', detail: `${kind} matches "${f.description}" only in a hedged or negated sentence: ${quote(sentences[0]!)}`, tag: 'forbidden' };
}

function skillName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(/^\//, '').split(':').pop() ?? null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('');
  }
  return '';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
