import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, USAGE } from './args.ts';
import { EXIT_CODES, EXIT_INVALID_ARGS, renderMarkdown } from './result.ts';
import { runInvestigation } from './run.ts';

// CLI entry point (`npm run investigate`). Wiring only: argv -> run -> print -> exit code.
// The report goes to stdout; diagnostics go to stderr.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');

const parsed = parseCliArgs(process.argv.slice(2));
if (parsed.kind === 'help') {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.kind === 'error') {
  console.error(`test-detective: ${parsed.message}\n\n${USAGE}`);
  process.exit(EXIT_INVALID_ARGS);
}

// Ctrl+C aborts the session (which closes the Claude Code subprocess); a second Ctrl+C exits at once.
const interrupt = new AbortController();
process.on('SIGINT', () => {
  if (interrupt.signal.aborted) process.exit(130);
  console.error('test-detective: interrupting, closing the session...');
  interrupt.abort();
});

// Detection, not prevention: compare the working tree before and after the session.
const gitStatus = (): string | null => {
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return null;
  }
};

const before = gitStatus();
const result = await runInvestigation(parsed.args, { repoRoot, signal: interrupt.signal });
const after = gitStatus();

console.log(parsed.args.json ? JSON.stringify(result, null, 2) : renderMarkdown(result));
if (before === null || after === null) console.error('test-detective: git status unavailable; working-tree check skipped.');
else if (before !== after) console.error('test-detective: WARNING: the git working tree changed during the session:\n' + after);
else console.error('test-detective: working tree unchanged (git status).');
process.exitCode = EXIT_CODES[result.runStatus];
