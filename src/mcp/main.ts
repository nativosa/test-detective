import { serveStdio } from '@modelcontextprotocol/server/stdio';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.ts';

// stdio entry point. stdout carries MCP protocol messages only, so all logging goes to stderr.

// The repo root comes from this file's location, not the shell's cwd. The override exists for
// tests and is set by whoever launches the process, never by an MCP client.
const repoRoot = path.resolve(
  process.env.TEST_DETECTIVE_REPO_ROOT || fileURLToPath(new URL('../../', import.meta.url)),
);

// get_trace_summary is opt-in until Stage 3.3; launchers that don't pass the flag never see it.
const enableTraceSummary = process.argv.slice(2).includes('--enable-trace-summary');

const handle = serveStdio(() => createServer({ repoRoot, enableTraceSummary }), {
  onerror: (error) => console.error(`[${SERVER_NAME}] transport error:`, error),
});
console.error(`[${SERVER_NAME}] v${SERVER_VERSION} listening on stdio (repo root: ${repoRoot}${enableTraceSummary ? ', get_trace_summary enabled' : ''})`);

const shutdown = (signal: string) => {
  console.error(`[${SERVER_NAME}] ${signal} received, shutting down`);
  void handle.close().then(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
