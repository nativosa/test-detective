import type { AccountInfo, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CliArgs } from '../args.ts';
import { MCP_DETAILS, MCP_LIST, MCP_SERVER, SKILL_NAME } from '../config.ts';
import type { ModelInvestigation } from '../result.ts';
import type { QueryFn } from '../run.ts';

// Scripted stand-ins for the SDK. Messages carry only the fields run.ts reads, cast to SDKMessage.

export const REPO_ROOT = process.platform === 'win32' ? 'C:\\repo\\test-detective' : '/repo/test-detective';
export const FINGERPRINT = 'abc123def456';
/** The shape SDK 0.3.302 actually returned for a Pro login: no apiKeySource, no tokenSource. */
export const SUBSCRIPTION_ACCOUNT: AccountInfo = {
  apiProvider: 'firstParty',
  subscriptionType: 'Claude Pro',
  email: 'someone@example.com',
  organization: 'Example Org',
};

export function args(overrides: Partial<CliArgs> = {}): CliArgs {
  return { filter: null, model: null, maxTurns: 30, timeoutMs: 60_000, maxBudgetUsd: null, auth: 'subscription', json: false, ...overrides };
}

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

export function init(overrides: { skills?: string[]; mcpStatus?: string | null; tools?: string[]; apiKeySource?: string; model?: string } = {}): SDKMessage {
  return msg({
    type: 'system',
    subtype: 'init',
    apiKeySource: overrides.apiKeySource ?? 'none',
    model: overrides.model ?? 'claude-opus-5-5',
    skills: overrides.skills ?? [SKILL_NAME],
    mcp_servers: overrides.mcpStatus === null ? [] : [{ name: MCP_SERVER, status: overrides.mcpStatus ?? 'connected' }],
    tools: overrides.tools ?? ['Read', 'Grep', 'Glob', 'Bash', 'Skill', MCP_LIST, MCP_DETAILS],
    slash_commands: [SKILL_NAME],
    permissionMode: 'dontAsk',
    cwd: REPO_ROOT,
    claude_code_version: '2.1.302',
    output_style: 'default',
    plugins: [],
    uuid: 'u',
    session_id: 's',
  });
}

export function toolUse(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return msg({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] }, uuid: 'u', session_id: 's' });
}

export function toolResult(id: string, content: unknown, isError = false): SDKMessage {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return msg({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] },
  });
}

/** Tool use + its result, as two stream messages. */
export function call(id: string, name: string, input: Record<string, unknown>, result: unknown, isError = false): SDKMessage[] {
  return [toolUse(id, name, input), toolResult(id, result, isError)];
}

export const skillCall = (filter?: string) => call('skill-1', 'Skill', filter ? { skill: SKILL_NAME, args: filter } : { skill: SKILL_NAME }, 'Launching skill');

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 500, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.05, contextWindow: 1, maxOutputTokens: 1 };

export function success(structured: unknown, extra: Record<string, unknown> = {}): SDKMessage {
  return msg({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    num_turns: 7,
    total_cost_usd: 0.0512,
    modelUsage: { 'claude-opus-5-5': USAGE },
    permission_denials: [],
    ...(structured === undefined ? {} : { structured_output: structured }),
    ...extra,
  });
}

export function errorResult(subtype: string, errors: string[] = ['boom']): SDKMessage {
  return msg({ type: 'result', subtype, is_error: true, num_turns: 3, total_cost_usd: 0.01, modelUsage: {}, permission_denials: [], errors });
}

// ---------------------------------------------------------------------------
// MCP tool payloads shaped like src/mcp/report.ts output

export type Failure = { testId: string; title: string; file: string; project?: string; outcome?: 'unexpected' | 'flaky' };

export const CHECKBOXES: Failure = { testId: 'spec1-aaaaaaaaaaaaaaaaaaaa@' + FINGERPRINT, title: 'toggles checkboxes', file: 'tests/ui/checkboxes.spec.ts' };
export const LOGIN: Failure = { testId: 'spec2-bbbbbbbbbbbbbbbbbbbb@' + FINGERPRINT, title: 'logs in with valid credentials', file: 'tests/ui/login.spec.ts' };

export function listPayload(failures: Failure[]) {
  return {
    run: { reportPath: 'artifacts/results.json', reportFingerprint: FINGERPRINT, reportModifiedAt: '2026-10-21T08:00:00.000Z', startTime: '2026-10-21T08:00:00.000Z', durationMs: 2000, playwrightVersion: '1.64.1' },
    stats: { expected: 4, unexpected: failures.length, flaky: 0, skipped: 0 },
    globalErrors: { count: 0, items: [] },
    failureCount: failures.length,
    failures: failures.map((f) => ({
      testId: f.testId,
      title: f.title,
      titlePath: [f.title],
      file: f.file,
      line: 3,
      column: 1,
      project: f.project ?? 'chromium',
      outcome: f.outcome ?? 'unexpected',
      expectedStatus: 'passed',
      finalStatus: 'failed',
      attempts: { count: 1, statuses: ['failed'] },
    })),
    message: failures.length ? `${failures.length} failed or flaky test(s).` : 'No failed or flaky tests in this report.',
  };
}

export function detailsPayload(f: Failure) {
  return {
    testId: f.testId,
    reportFingerprint: FINGERPRINT,
    title: f.title,
    titlePath: [f.title],
    file: f.file,
    line: 3,
    column: 1,
    project: f.project ?? 'chromium',
    tags: [],
    outcome: f.outcome ?? 'unexpected',
    expectedStatus: 'passed',
    finalStatus: 'failed',
    configuredRetries: 0,
    timeoutMs: 30000,
    attempts: [
      {
        retry: 0,
        status: 'failed',
        startTime: '2026-10-21T08:00:00.500Z',
        durationMs: 11000,
        error: { message: 'Expected: 3 Received: 2', expected: 'Expected: 3', actual: 'Received: 2', location: { file: f.file, line: 8, column: 28 }, snippet: null, stack: null, truncated: false },
        additionalErrors: [],
        attachments: [],
        omitted: { stdoutEntries: 0, stderrEntries: 0, additionalErrors: 0 },
      },
    ],
  };
}

export function investigation(testId: string): ModelInvestigation {
  return {
    testId,
    classification: 'Test-code defect',
    failureSummary: 'Expected 3 checkboxes, page has 2.',
    sourceMismatch: false,
    evidence: [
      { kind: 'mcp', status: 'inspected', ref: 'get_failure_details', note: 'Expected 3, received 2' },
      { kind: 'trace', status: 'skipped', ref: null, note: 'Not needed' },
    ],
    analysis: [{ point: 'The page renders exactly two checkboxes.', evidenceRefs: ['error-context.md'] }],
    confidence: { level: 'High', justification: 'Direct evidence.' },
    proposedFix: 'toHaveCount(2)',
    verificationSteps: ['npx playwright test tests/ui/checkboxes.spec.ts'],
  };
}

export function report(status: string, investigations: unknown[] = [], message = 'Summary.') {
  return { status, message, investigations };
}

/** Messages for a full, consistent investigation of the given failures. */
export function investigatedStream(failures: Failure[], investigatedIds = failures.map((f) => f.testId)): SDKMessage[] {
  return [
    init(),
    ...skillCall(),
    ...call('list-1', MCP_LIST, {}, listPayload(failures)),
    ...failures.flatMap((f, i) => call(`details-${i}`, MCP_DETAILS, { testId: f.testId }, detailsPayload(f))),
    ...call('read-1', 'Read', { file_path: `${REPO_ROOT}${process.platform === 'win32' ? '\\' : '/'}tests/ui/checkboxes.spec.ts` }, 'source'),
    success(report('investigated', investigatedIds.map(investigation))),
  ];
}

// ---------------------------------------------------------------------------
// Fake query

export type FakeScript = {
  account?: AccountInfo;
  messages?: SDKMessage[];
  /** Never resolve initializationResult(). */
  hangInit?: boolean;
  /** After the scripted messages, wait forever without yielding. */
  hang?: boolean;
  /** After the scripted messages, throw this. */
  throwError?: Error;
};

export type FakeState = { calls: number; options: Parameters<QueryFn>[0]['options'] | undefined; prompts: SDKUserMessage[]; closed: number };

export function fakeQuery(script: FakeScript): { query: QueryFn; state: FakeState } {
  const state: FakeState = { calls: 0, options: undefined, prompts: [], closed: 0 };
  const query: QueryFn = ({ prompt, options }) => {
    state.calls++;
    state.options = options;
    return {
      async initializationResult() {
        if (script.hangInit) await new Promise(() => {});
        return { account: script.account ?? SUBSCRIPTION_ACCOUNT, claude_code_version: '2.1.302' } as never;
      },
      close() {
        state.closed++;
      },
      async *[Symbol.asyncIterator]() {
        // Like the real CLI, nothing happens until the first prompt message arrives.
        for await (const m of prompt) {
          state.prompts.push(m);
          break;
        }
        for (const m of script.messages ?? []) yield m;
        if (script.hang) await new Promise(() => {});
        if (script.throwError) throw script.throwError;
      },
    };
  };
  return { query, state };
}
