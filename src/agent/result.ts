import * as z from 'zod';

// Result types for the investigation CLI. Two kinds of data are kept apart on purpose:
// - ModelReport: what the model returns as structured output (analysis only, cited by testId).
// - Observed: facts this process saw itself in the SDK stream (auth, tool calls, MCP results).
// Deterministic test facts (title, file, outcome, attempts) come from Observed, never the model.

export const CLASSIFICATIONS = ['Test-code defect', 'Application defect', 'Environment issue', 'Inconclusive'] as const;
export const REPORT_STATUSES = ['investigated', 'no_failures', 'no_match', 'mcp_unavailable', 'report_error'] as const;

const Evidence = z.strictObject({
  kind: z.enum(['mcp', 'source', 'error_context', 'screenshot', 'trace']),
  status: z.enum(['inspected', 'not_available', 'skipped']),
  ref: z.string().nullable().describe('Repo-relative path or MCP tool name; null if none'),
  note: z.string().describe('What was examined, or why it was not available or skipped'),
});

const ModelInvestigation = z.strictObject({
  testId: z.string().min(1).describe('Exactly the testId passed to get_failure_details'),
  classification: z.enum(CLASSIFICATIONS),
  failureSummary: z.string().min(1),
  sourceMismatch: z.boolean().describe('True if the test source differs from the artifacts or changed after the run'),
  evidence: z.array(Evidence).min(1),
  analysis: z.array(z.strictObject({ point: z.string().min(1), evidenceRefs: z.array(z.string()) })).min(1),
  confidence: z.strictObject({ level: z.enum(['High', 'Medium', 'Low']), justification: z.string().min(1) }),
  proposedFix: z.string().describe('Not applied'),
  verificationSteps: z.array(z.string()).min(1),
});
export type ModelInvestigation = z.infer<typeof ModelInvestigation>;

export const ModelReport = z.strictObject({
  status: z.enum(REPORT_STATUSES),
  message: z.string().describe('One or two sentences: the overall outcome, or the error code and hint'),
  investigations: z.array(ModelInvestigation),
});
export type ModelReport = z.infer<typeof ModelReport>;

/** JSON Schema for the SDK's outputFormat option (the SDK expects draft-07). */
export function modelReportJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ModelReport, { target: 'draft-7' }) as Record<string, unknown>;
}

export function parseModelReport(value: unknown): { ok: true; report: ModelReport } | { ok: false; error: string } {
  const parsed = ModelReport.safeParse(value);
  if (parsed.success) return { ok: true, report: parsed.data };
  return { ok: false, error: z.prettifyError(parsed.error) };
}

// ---------------------------------------------------------------------------
// Observed facts and the final result

const TestFacts = z.strictObject({
  testId: z.string(),
  title: z.string(),
  file: z.string(),
  line: z.number(),
  project: z.string(),
  outcome: z.enum(['unexpected', 'flaky']),
  attempts: z.array(z.strictObject({ retry: z.number(), status: z.string().nullable() })),
});
export type TestFacts = z.infer<typeof TestFacts>;

const ToolCall = z.strictObject({
  name: z.string(),
  input: z.string().describe('Short, truncated summary of the tool input'),
  outcome: z.enum(['ok', 'error', 'pending']),
});
export type ToolCall = z.infer<typeof ToolCall>;

/**
 * One get_trace_summary result seen in the stream (Stage 3.3). `status` is the tool's trace.status,
 * or 'error' for an error result. Only the status and reason codes are kept, never trace facts.
 */
const TraceSummaryFact = z.strictObject({
  testId: z.string(),
  retry: z.number().nullable(),
  status: z.enum(['ok', 'partial', 'missing', 'unsupported', 'error']),
  reportFingerprint: z.string().nullable(),
  reasons: z.array(z.string()).describe('trace.reasons codes, or the error code'),
});
export type TraceSummaryFact = z.infer<typeof TraceSummaryFact>;

export const RUN_STATUSES = [
  'completed',
  'unverified',
  'invalid_output',
  'auth_refused',
  'mcp_unavailable',
  'report_error',
  'session_error',
  'timeout',
  'interrupted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const EXIT_CODES: Record<RunStatus, number> = {
  completed: 0,
  auth_refused: 3,
  mcp_unavailable: 4,
  report_error: 4,
  session_error: 5,
  timeout: 6,
  interrupted: 6,
  unverified: 7,
  invalid_output: 7,
};
export const EXIT_INVALID_ARGS = 2;

export const InvestigationResult = z.strictObject({
  runStatus: z.enum(RUN_STATUSES),
  issues: z.array(z.string()).describe('Why the run is not "completed", or consistency problems found'),
  observed: z.strictObject({
    auth: z.strictObject({
      mode: z.enum(['subscription', 'api']),
      apiKeySource: z.string().nullable(),
      apiProvider: z.string().nullable(),
      subscriptionType: z.string().nullable(),
      tokenSource: z.string().nullable(),
    }),
    model: z.string().nullable(),
    claudeCodeVersion: z.string().nullable(),
    mcpServerStatus: z.string().nullable(),
    /** Listed in the init message's `skills`: the CLI found it. Says nothing about the model using it. */
    skillDiscovered: z.boolean(),
    /** SKILL.md was opened as a file (Read, Grep, Bash...). That is not an invocation. */
    skillReadAsFile: z.boolean(),
    /** A successful Skill tool call for the skill was observed. */
    skillInvoked: z.boolean(),
    toolCalls: z.array(ToolCall),
    permissionDenials: z.array(z.strictObject({ tool: z.string(), input: z.string() })),
    /** Optional so results saved before Stage 3.3 still parse. */
    traceSummaries: z.array(TraceSummaryFact).optional(),
    report: z
      .strictObject({
        reportFingerprint: z.string(),
        startTime: z.string(),
        stats: z.strictObject({ expected: z.number(), unexpected: z.number(), flaky: z.number(), skipped: z.number() }),
        failureCount: z.number(),
      })
      .nullable(),
  }),
  reportStatus: z.enum(REPORT_STATUSES).nullable(),
  message: z.string().nullable(),
  investigations: z.array(z.strictObject({ facts: TestFacts.nullable(), analysis: ModelInvestigation })),
  usage: z.strictObject({
    numTurns: z.number().nullable(),
    durationMs: z.number(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    estimatedUsageCostUsd: z.number().nullable(),
  }),
});
export type InvestigationResult = z.infer<typeof InvestigationResult>;

// ---------------------------------------------------------------------------
// Markdown rendering

const ICON = { inspected: '✅', not_available: '⚠️', skipped: '⏭️' } as const;

export function renderMarkdown(result: InvestigationResult): string {
  const out: string[] = [];
  const { observed } = result;
  out.push(`# test-detective investigation: ${result.runStatus}`, '');
  if (result.issues.length > 0) out.push('**Issues:**', ...result.issues.map((i) => `- ${i}`), '');
  if (result.message) out.push(`**Model summary:** ${result.message}`, '');
  if (observed.report) {
    const { stats } = observed.report;
    out.push(
      `**Report** \`${observed.report.reportFingerprint}\` from ${observed.report.startTime}: ` +
        `${stats.unexpected} unexpected, ${stats.flaky} flaky, ${stats.expected} passed, ${stats.skipped} skipped (observed from MCP).`,
      '',
    );
  }

  if (result.investigations.length > 1) {
    out.push('| Test | Outcome | Classification | Confidence |', '|---|---|---|---|');
    for (const { facts, analysis } of result.investigations) {
      out.push(`| ${facts?.title ?? analysis.testId} | ${facts?.outcome ?? '?'} | ${analysis.classification} | ${analysis.confidence.level} |`);
    }
    out.push('');
  }

  for (const { facts, analysis } of result.investigations) {
    out.push(`## ${facts?.title ?? `Unverified testId ${analysis.testId}`}`, '');
    out.push('### Observed (from MCP results, not model output)');
    if (facts) {
      const attempts = facts.attempts.map((a) => `retry ${a.retry}: ${a.status ?? 'unknown'}`).join(', ');
      out.push(
        `- **Source:** \`${facts.file}:${facts.line}\` · **Project:** ${facts.project} · **Outcome:** ${facts.outcome}`,
        `- **Attempts:** ${attempts || 'none recorded'}`,
        `- **testId:** \`${facts.testId}\``,
      );
      const traces = (observed.traceSummaries ?? []).filter((t) => t.testId === facts.testId);
      if (traces.length > 0) {
        out.push(`- **Trace summaries:** ${traces.map((t) => `retry ${t.retry ?? '?'}: ${t.status}${t.reasons.length ? ` (${t.reasons.join(', ')})` : ''}`).join('; ')}`);
      }
    } else {
      out.push('- ⚠️ No MCP result for this testId was observed. The analysis below is unverified.');
    }
    out.push('', '### Analysis (model-generated)');
    out.push(`**Failure summary:** ${analysis.failureSummary}`, '');
    out.push('**Evidence inspected:**');
    for (const e of analysis.evidence) {
      out.push(`- ${ICON[e.status]} ${e.kind}${e.ref ? ` — \`${e.ref}\`` : ''}: ${e.note}`);
    }
    if (analysis.sourceMismatch) out.push('', '⚠️ **Source/artifact mismatch:** the diagnosis may not match the code that ran.');
    out.push('', `**Classification:** ${analysis.classification}`);
    for (const a of analysis.analysis) {
      out.push(`- ${a.point}${a.evidenceRefs.length ? ` (${a.evidenceRefs.join(', ')})` : ''}`);
    }
    out.push('', `**Confidence:** ${analysis.confidence.level}: ${analysis.confidence.justification}`, '');
    out.push('**Proposed fix (not applied):**', analysis.proposedFix || '(none)', '');
    out.push('**Verification steps:**', ...analysis.verificationSteps.map((s, i) => `${i + 1}. ${s}`), '');
  }

  out.push('---', '### Run facts (observed by the CLI)');
  const { auth } = observed;
  out.push(
    `- **Auth:** mode ${auth.mode}, apiKeySource ${auth.apiKeySource ?? 'unknown'}, provider ${auth.apiProvider ?? 'unknown'}, ` +
      `subscription ${auth.subscriptionType ?? 'unknown'}`,
    `- **Model:** ${observed.model ?? 'unknown'} · **Claude Code:** ${observed.claudeCodeVersion ?? 'unknown'} · **MCP server:** ${observed.mcpServerStatus ?? 'unknown'}`,
    `- **Skill:** discovered ${observed.skillDiscovered ? 'yes' : 'no'}, invoked ${observed.skillInvoked ? 'yes' : 'no'}` +
      (observed.skillReadAsFile ? ', SKILL.md read as a file' : ''),
  );
  out.push(`- **Tool calls (${observed.toolCalls.length}):**`);
  for (const c of observed.toolCalls) out.push(`  - ${c.name} ${c.input} → ${c.outcome}`);
  if (observed.permissionDenials.length > 0) {
    out.push(`- **Permission denials:**`, ...observed.permissionDenials.map((d) => `  - ${d.tool} ${d.input}`));
  }
  const { usage } = result;
  const cost = usage.estimatedUsageCostUsd === null ? 'unknown' : `$${usage.estimatedUsageCostUsd.toFixed(4)}`;
  out.push(
    `- **Usage:** ${usage.numTurns ?? '?'} turns, ${usage.inputTokens ?? '?'} input / ${usage.outputTokens ?? '?'} output tokens, ` +
      `${(usage.durationMs / 1000).toFixed(1)}s`,
    `- **Estimated usage cost:** ${cost} (SDK estimate at list prices; not necessarily a charge, e.g. on a subscription plan)`,
  );
  return out.join('\n');
}
