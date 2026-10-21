import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { FailureDetailsOutput, ListFailuresOutput } from '../mcp/report.ts';
import type { CliArgs } from './args.ts';
import { authFacts, checkSessionAuth, EXPECTED_API_KEY_SOURCE, preflightAuth } from './auth.ts';
import type { AuthFacts } from './auth.ts';
import { buildPrompt, buildQueryOptions, MCP_DETAILS, MCP_LIST, MCP_SERVER, SKILL_NAME, SKILL_TOOL } from './config.ts';
import { InvestigationResult, parseModelReport } from './result.ts';
import type { ModelReport, RunStatus, TestFacts, ToolCall } from './result.ts';

// Runs one investigation session and turns the SDK message stream into an InvestigationResult.
// The only seam for tests is `query`: they pass a fake that yields scripted SDK messages.

/** The parts of the SDK's Query that this module uses. The real `query` satisfies it. */
export type QueryHandle = AsyncIterable<SDKMessage> & Pick<Query, 'initializationResult' | 'close'>;
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;

export type RunDeps = {
  repoRoot: string;
  query?: QueryFn;
  env?: Record<string, string | undefined>;
  /** Aborted by the caller on Ctrl+C. */
  signal?: AbortSignal;
  now?: () => number;
};

class Aborted extends Error {}

export async function runInvestigation(args: CliArgs, deps: RunDeps): Promise<InvestigationResult> {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const obs = new Observations(args, deps.repoRoot, now);

  const preflight = preflightAuth(env, args.auth);
  if (!preflight.ok) return obs.finish('auth_refused', [preflight.reason]);
  if (deps.signal?.aborted) return obs.finish('interrupted', ['Interrupted before the session started.']);

  const controller = new AbortController();
  let abortReason: 'timeout' | 'interrupted' | null = null;
  const abort = (reason: 'timeout' | 'interrupted') => {
    if (abortReason) return;
    abortReason = reason;
    controller.abort();
  };
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Aborted()), { once: true });
  });
  aborted.catch(() => {});
  const timer = setTimeout(() => abort('timeout'), args.timeoutMs);
  const onSignal = () => abort('interrupted');
  deps.signal?.addEventListener('abort', onSignal, { once: true });

  // The prompt is held back until the session's account has been checked, so a wrong
  // credential never reaches a model request.
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => (openGate = resolve));
  const prompt = buildPrompt(args.filter);
  async function* input(): AsyncGenerator<SDKUserMessage> {
    await gate;
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };
  }

  const query = deps.query ?? (sdkQuery as QueryFn);
  let handle: QueryHandle | undefined;
  let thrown: unknown;
  let early: { status: RunStatus; issues: string[] } | undefined;
  try {
    handle = query({ prompt: input(), options: buildQueryOptions(args, deps.repoRoot, controller, env) });
    const init = await Promise.race([handle.initializationResult(), aborted]);
    obs.auth = authFacts(init.account);
    obs.claudeCodeVersion = init.claude_code_version ?? null;
    const auth = checkSessionAuth(obs.auth, args.auth);
    if (!auth.ok) {
      early = { status: 'auth_refused', issues: [auth.reason] };
    } else {
      openGate();
      const iterator = handle[Symbol.asyncIterator]();
      while (!early) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) break;
        early = obs.handle(next.value) ?? undefined;
        if (next.value.type === 'result') break;
      }
    }
  } catch (error) {
    thrown = error;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onSignal);
    // close() ends the CLI subprocess and its MCP children, not just this loop.
    handle?.close();
  }

  if (early) return obs.finish(early.status, early.issues);
  if (abortReason === 'timeout') return obs.finish('timeout', [`Timed out after ${args.timeoutMs / 1000}s; the session was closed.`]);
  if (abortReason === 'interrupted') return obs.finish('interrupted', ['Interrupted; the session was closed.']);
  if (obs.result) return obs.evaluate();
  const detail = thrown instanceof Error ? thrown.message : thrown === undefined ? 'the stream ended without a result' : String(thrown);
  return obs.finish('session_error', [`SDK session failed: ${detail}`]);
}

// ---------------------------------------------------------------------------

type Recorded = ToolCall & { id: string; rawInput: unknown };

class Observations {
  auth: AuthFacts = { apiKeySource: null, apiProvider: null, subscriptionType: null, tokenSource: null };
  claudeCodeVersion: string | null = null;
  result: SDKResultMessage | undefined;
  private model: string | null = null;
  private mcpServerStatus: string | null = null;
  private skillDiscovered = false;
  private sawInit = false;
  private readonly calls: Recorded[] = [];
  private list: ListFailuresOutput | undefined;
  private listErrorCode: string | undefined;
  private readonly details = new Map<string, FailureDetailsOutput>();
  private readonly notes: string[] = [];
  private readonly args: CliArgs;
  private readonly repoRoot: string;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(args: CliArgs, repoRoot: string, now: () => number) {
    this.args = args;
    this.repoRoot = repoRoot;
    this.now = now;
    this.startedAt = now();
  }

  /** Returns a terminal status when the message means the run must stop now. */
  handle(message: SDKMessage): { status: RunStatus; issues: string[] } | null {
    if (message.type === 'system' && message.subtype === 'init' && !this.sawInit) {
      this.sawInit = true;
      this.model = message.model;
      this.skillDiscovered = message.skills.some((s) => s === SKILL_NAME || s.endsWith(`:${SKILL_NAME}`));
      const server = message.mcp_servers.find((s) => s.name === MCP_SERVER);
      this.mcpServerStatus = server?.status ?? 'absent';
      const expected = EXPECTED_API_KEY_SOURCE[this.args.auth];
      if (message.apiKeySource !== expected || (this.auth.apiKeySource !== null && message.apiKeySource !== this.auth.apiKeySource)) {
        return {
          status: 'auth_refused',
          issues: [
            `The session reported apiKeySource=${message.apiKeySource}, but ${this.args.auth} mode requires ${expected}. ` +
              'The session was aborted; the prompt may already have been submitted.',
          ],
        };
      }
      this.auth.apiKeySource = message.apiKeySource;
      if (this.mcpServerStatus === 'failed' || this.mcpServerStatus === 'absent' || this.mcpServerStatus === 'disabled' || this.mcpServerStatus === 'needs-auth') {
        return { status: 'mcp_unavailable', issues: [`MCP server ${MCP_SERVER} is ${this.mcpServerStatus} at session start.`] };
      }
      if (this.mcpServerStatus === 'connected' && !(message.tools.includes(MCP_LIST) && message.tools.includes(MCP_DETAILS))) {
        return { status: 'mcp_unavailable', issues: [`MCP server ${MCP_SERVER} is connected but its tools are missing from the session.`] };
      }
      if (!this.skillDiscovered) {
        return { status: 'session_error', issues: [`The SDK did not discover the ${SKILL_NAME} skill (check settingSources and .claude/skills).`] };
      }
      // Discovery alone is not enough: without the Skill tool the model can only read SKILL.md as a file.
      if (!message.tools.includes(SKILL_TOOL)) {
        return {
          status: 'session_error',
          issues: [`The ${SKILL_TOOL} tool is missing from the session, so the ${SKILL_NAME} skill cannot be invoked (check the tools option).`],
        };
      }
      return null;
    }
    if (!this.sawInit && (message.type === 'assistant' || message.type === 'user' || message.type === 'result')) {
      return {
        status: 'auth_refused',
        issues: ['The session produced output before reporting its authentication source. The session was aborted; the prompt may already have been submitted.'],
      };
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' || block.type === 'mcp_tool_use') this.recordCall(block.id, block.name, block.input);
      }
      return null;
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') this.recordResult(block.tool_use_id, block.is_error === true, block.content);
      }
      return null;
    }
    if (message.type === 'result') this.result = message;
    return null;
  }

  private recordCall(id: string, name: string, input: unknown) {
    this.calls.push({ id, name, input: summarize(input, this.repoRoot), outcome: 'pending', rawInput: input });
  }

  private recordResult(id: string, isError: boolean, content: unknown) {
    const call = this.calls.find((c) => c.id === id);
    if (!call) return;
    call.outcome = isError ? 'error' : 'ok';
    if (call.name !== MCP_LIST && call.name !== MCP_DETAILS) return;
    const json = parseJson(textOf(content));
    if (isError) {
      const code = (json as { error?: { code?: unknown } } | undefined)?.error?.code;
      if (call.name === MCP_LIST && typeof code === 'string') this.listErrorCode = code;
      return;
    }
    if (call.name === MCP_LIST) {
      const parsed = ListFailuresOutput.safeParse(json);
      if (parsed.success) this.list = parsed.data;
      else this.notes.push('Could not parse a list_test_failures result; observed facts are unavailable.');
    } else {
      const parsed = FailureDetailsOutput.safeParse(json);
      if (parsed.success) this.details.set(parsed.data.testId, parsed.data);
      else this.notes.push('Could not parse a get_failure_details result.');
    }
  }

  /** Judges a finished session: model output validity plus consistency with what we observed. */
  evaluate(): InvestigationResult {
    const result = this.result!;
    if (result.subtype === 'error_max_structured_output_retries') {
      return this.finish('invalid_output', ['The model did not produce valid structured output.', ...result.errors]);
    }
    if (result.subtype !== 'success') return this.finish('session_error', [`Session ended with ${result.subtype}.`, ...result.errors]);
    if (result.is_error) return this.finish('session_error', [`Session ended with an API error: ${truncate(result.result, 300)}`]);
    if (result.structured_output === undefined) return this.finish('invalid_output', ['The session returned no structured output.']);
    const parsed = parseModelReport(result.structured_output);
    if (!parsed.ok) return this.finish('invalid_output', [`Structured output failed validation: ${parsed.error}`]);

    const report = parsed.report;
    const issues = this.consistencyIssues(report);
    const status: RunStatus =
      issues.length > 0
        ? 'unverified'
        : report.status === 'mcp_unavailable'
          ? 'mcp_unavailable'
          : report.status === 'report_error'
            ? 'report_error'
            : 'completed';
    return this.finish(status, issues, report);
  }

  private consistencyIssues(report: ModelReport): string[] {
    const issues = [...this.notes];
    if (!this.skillInvoked()) {
      issues.push(`No successful ${SKILL_NAME} Skill invocation was observed.`);
      if (this.skillReadAsFile()) issues.push(`The model read ${SKILL_FILE} as a file instead of invoking the skill with the ${SKILL_TOOL} tool.`);
    }
    const listCalls = this.calls.filter((c) => c.name === MCP_LIST);

    if (report.status === 'mcp_unavailable') {
      if (this.list) issues.push('The model reported the MCP server unavailable, but a list_test_failures result was observed.');
      return issues;
    }
    if (listCalls.length === 0) {
      issues.push('No list_test_failures call was observed.');
      return issues;
    }
    if (report.status === 'report_error') {
      if (!this.listErrorCode) issues.push('The model reported a report error, but no list_test_failures error result was observed.');
      return issues;
    }
    if (!this.list) {
      issues.push('No successful list_test_failures result was observed.');
      return issues;
    }

    const expected = this.list.failures.filter((f) => matchesFilter(f, this.args.filter));
    if (report.status === 'no_failures' && this.list.failureCount > 0) {
      issues.push(`The model reported no failures, but list_test_failures returned ${this.list.failureCount}.`);
    }
    if (report.status === 'no_match' && expected.length > 0) {
      issues.push(`The model reported no match, but ${expected.length} listed failure(s) match the filter.`);
    }
    if (report.status !== 'investigated') {
      if (report.investigations.length > 0) issues.push(`Status ${report.status} should not carry investigations.`);
      return issues;
    }

    const investigated = new Set<string>();
    for (const inv of report.investigations) {
      const facts = this.factsFor(inv.testId);
      if (!facts) issues.push(`testId ${inv.testId} has no observed successful get_failure_details result.`);
      else investigated.add(facts.file + '\u0000' + facts.title + '\u0000' + facts.project);
    }
    for (const f of expected) {
      if (!investigated.has(f.file + '\u0000' + f.title + '\u0000' + f.project)) {
        issues.push(`Listed failure "${f.title}" (${f.file}) matches the filter but was not investigated.`);
      }
    }
    return issues;
  }

  private skillInvoked(): boolean {
    return this.calls.some((c) => c.name === SKILL_TOOL && skillName(c.rawInput) === SKILL_NAME && c.outcome === 'ok');
  }

  /** Any tool call whose input names the skill's SKILL.md (Read, Grep, a Bash command...). */
  private skillReadAsFile(): boolean {
    return this.calls.some((c) => c.name !== SKILL_TOOL && JSON.stringify(c.rawInput ?? null).replace(/\\\\/g, '/').toLowerCase().includes(SKILL_FILE.toLowerCase()));
  }

  private factsFor(testId: string): TestFacts | null {
    const d = this.details.get(testId);
    if (!d) return null;
    return {
      testId: d.testId,
      title: d.title,
      file: d.file,
      line: d.line,
      project: d.project,
      outcome: d.outcome,
      attempts: d.attempts.map((a) => ({ retry: a.retry, status: a.status })),
    };
  }

  finish(runStatus: RunStatus, issues: string[], report?: ModelReport): InvestigationResult {
    const r = this.result;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    if (r) {
      const models = Object.values(r.modelUsage ?? {});
      if (models.length > 0) {
        inputTokens = models.reduce((n, m) => n + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0);
        outputTokens = models.reduce((n, m) => n + m.outputTokens, 0);
      }
    }
    return InvestigationResult.parse({
      runStatus,
      issues,
      observed: {
        auth: { mode: this.args.auth, ...this.auth },
        model: this.model,
        claudeCodeVersion: this.claudeCodeVersion,
        mcpServerStatus: this.mcpServerStatus,
        skillDiscovered: this.skillDiscovered,
        skillReadAsFile: this.skillReadAsFile(),
        skillInvoked: this.skillInvoked(),
        toolCalls: this.calls.map(({ name, input, outcome }) => ({ name, input, outcome })),
        permissionDenials: (r?.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: summarize(d.tool_input, this.repoRoot) })),
        report: this.list
          ? {
              reportFingerprint: this.list.run.reportFingerprint,
              startTime: this.list.run.startTime,
              stats: this.list.stats,
              failureCount: this.list.failureCount,
            }
          : null,
      },
      reportStatus: report?.status ?? null,
      message: report?.message ?? null,
      investigations: (report?.investigations ?? []).map((analysis) => ({ facts: this.factsFor(analysis.testId), analysis })),
      usage: {
        numTurns: r?.num_turns ?? null,
        durationMs: Math.max(0, this.now() - this.startedAt),
        inputTokens,
        outputTokens,
        estimatedUsageCostUsd: r?.total_cost_usd ?? null,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers

const SKILL_FILE = `.claude/skills/${SKILL_NAME}/SKILL.md`;

/** Same matching rule as the Skill: case-insensitive substring of title, any titlePath entry, or file. */
export function matchesFilter(f: { title: string; titlePath: string[]; file: string }, filter: string | null): boolean {
  if (filter === null) return true;
  const needle = filter.toLowerCase();
  return [f.title, f.file, ...f.titlePath].some((s) => s.toLowerCase().includes(needle));
}

function skillName(input: unknown): string | null {
  const skill = (input as { skill?: unknown } | null)?.skill;
  if (typeof skill !== 'string') return null;
  return skill.replace(/^\//, '').split(':').pop() ?? null;
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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A short, single-line summary of a tool input, with the repo root removed from paths. */
function summarize(input: unknown, repoRoot: string): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = [i.file_path, i.command, i.testId, i.skill, i.pattern, i.path].find((v) => typeof v === 'string');
  let s = typeof pick === 'string' ? pick : JSON.stringify(input ?? {});
  for (const root of [repoRoot, repoRoot.replaceAll('\\', '/')]) s = s.replaceAll(root, '.');
  return truncate(s.replace(/\s+/g, ' '), 160);
}
