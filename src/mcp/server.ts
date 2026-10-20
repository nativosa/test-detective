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

// MCP protocol layer: registers tools and translates parser results/errors into tool results.
// All Playwright knowledge lives in report.ts.

export const SERVER_NAME = 'test-detective';
export const SERVER_VERSION = '0.1.0';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer({ repoRoot }: { repoRoot: string }): McpServer {
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
      inputSchema: z.object({
        testId: z
          .string()
          .min(1)
          .max(200)
          .describe('A testId returned by list_test_failures for the current report'),
      }),
      outputSchema: FailureDetailsOutput,
      annotations: readOnly,
    },
    async ({ testId }) => run(async () => getFailureDetails(await loadReport(repoRoot), testId)),
  );

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
