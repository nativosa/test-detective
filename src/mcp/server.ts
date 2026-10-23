import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
  FailureDetailsOutput,
  getFailureDetails,
  listFailures,
  ListFailuresOutput,
  loadReport,
  REPORT_PATH,
  ReportError,
} from './report.ts';
import { getTraceSummary, TraceCache, TraceSummaryOutput } from './trace-summary.ts';
import type { TraceLimits } from './trace-summary.ts';

// MCP protocol layer: registers tools and translates parser results/errors into tool results.
// All Playwright knowledge lives in report.ts.

export const SERVER_NAME = 'test-detective';
export const SERVER_VERSION = '0.2.0';
export const TRACE_TOOL = 'get_trace_summary';

export type ServerOptions = {
  repoRoot: string;
  /**
   * Registers get_trace_summary. Off by default until Stage 3.3 allows it in investigation
   * sessions: main.ts enables it only with --enable-trace-summary, which the Agent SDK CLI does not pass.
   */
  enableTraceSummary?: boolean;
  traceLimits?: TraceLimits;
  traceCache?: TraceCache;
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const testIdInput = z.string().min(1).max(200).describe('A testId returned by list_test_failures for the current report');

export function createServer({ repoRoot, enableTraceSummary = false, traceLimits, traceCache }: ServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'list_test_failures',
    {
      title: 'List Playwright test failures',
      description:
        `Summarizes the latest Playwright run from ${REPORT_PATH}: run info, stats, global errors, and every failed ` +
        'or flaky test with a testId, title, file, project, outcome and per-attempt statuses. Call this first; ' +
        'pass a testId to get_failure_details. Read-only; does not run tests.',
      outputSchema: ListFailuresOutput,
      annotations: readOnly,
    },
    async () => run(async () => listFailures(await loadReport(repoRoot))),
  );

  server.registerTool(
    'get_failure_details',
    {
      title: 'Get Playwright failure details',
      description:
        'Returns one failed or flaky test: location, outcome, retries, and for each attempt its status, error ' +
        'message, expected/received values, code snippet, trimmed stack, and attachment metadata (screenshot, ' +
        'trace, error-context paths and whether they exist). Does not read attachment contents or diagnose causes.',
      inputSchema: z.object({ testId: testIdInput }),
      outputSchema: FailureDetailsOutput,
      annotations: readOnly,
    },
    async ({ testId }) => run(async () => getFailureDetails(await loadReport(repoRoot), testId)),
  );

  if (enableTraceSummary) {
    const cache = traceCache ?? new TraceCache();
    // One trace at a time bounds memory; each call is bounded in time by its own budget.
    let queue: Promise<unknown> = Promise.resolve();
    const serialized = <T>(task: () => Promise<T>): Promise<T> => {
      const next = queue.then(task, task);
      queue = next.catch(() => undefined);
      return next;
    };
    server.registerTool(
      TRACE_TOOL,
      {
        title: 'Summarize a Playwright trace',
        description:
          "Reads the trace.zip of one attempt (as recorded in the report) and returns bounded, sanitized facts: browser " +
          'requests (method, path without origin/query, status, route marker), backend fetches made by API request ' +
          'contexts, route.fulfill/continue/abort calls with identifier-based fetch links, redirects, the failing ' +
          'action and its time, console counts, page-error names, and parse coverage. Observations only: it never ' +
          "classifies a failure. marker 'fulfilled' does not mean the test created the response (route.fetch() " +
          "responses are fulfilled too); marker 'none' or a missing server address does not prove a live backend. " +
          "When trace.status is 'partial', anything not listed is unknown, not absent. Never returns headers, cookies, " +
          'bodies, query strings, message texts or stacks. Read-only.',
        // Strict: any other argument (a path, say) is a validation error, not silently ignored.
        inputSchema: z
          .object({
            testId: testIdInput,
            retry: z.number().int().min(0).max(99).describe('Attempt index (attempts[].retry from get_failure_details)'),
          })
          .strict(),
        outputSchema: TraceSummaryOutput,
        annotations: readOnly,
      },
      async ({ testId, retry }, ctx) =>
        run(() =>
          serialized(async () =>
            getTraceSummary(await loadReport(repoRoot), testId, retry, { cache, signal: ctx.mcpReq.signal, ...(traceLimits ? { limits: traceLimits } : {}) }),
          ),
        ),
    );
  }

  return server;
}

async function run(produce: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const result = await produce();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (error) {
    const payload =
      error instanceof ReportError
        ? { code: error.code, message: error.message, hint: error.hint }
        : { code: 'INTERNAL_ERROR', message: 'Unexpected server error.', hint: 'See the server log (stderr).' };
    if (!(error instanceof ReportError)) console.error('[test-detective] tool failed:', error);
    // No structuredContent on errors: clients may validate it against outputSchema even when
    // isError is set (MCP Inspector does), and an error object can't match the success schema.
    return { content: [{ type: 'text', text: JSON.stringify({ error: payload }, null, 2) }], isError: true };
  }
}
