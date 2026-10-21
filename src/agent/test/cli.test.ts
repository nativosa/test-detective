import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The CLI entry point's offline paths, run as real processes. None of these reach the SDK.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));

function cli(argv: string[], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)));
  return spawnSync(process.execPath, [MAIN, ...argv], { cwd: REPO, encoding: 'utf8', timeout: 20_000, env: { ...clean, ...env } });
}

describe('main.ts', () => {
  test('--help prints usage and exits 0', () => {
    const r = cli(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: npm run investigate/);
  });

  test('invalid input exits 2 with the reason on stderr', () => {
    const r = cli(['--max-turns', 'lots']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--max-turns must be a number/);
    assert.equal(r.stdout, '');
  });

  test('an API key in subscription mode exits 3 before starting the SDK, without printing the key', () => {
    const r = cli([], { ANTHROPIC_API_KEY: 'sk-ant-NEVER-PRINT-ME' });
    assert.equal(r.status, 3);
    assert.match(r.stdout, /auth_refused/);
    assert.match(r.stdout, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(r.stdout + r.stderr, /NEVER-PRINT-ME/);
  });

  test('--json prints a machine-readable result', () => {
    const r = cli(['--json'], { ANTHROPIC_API_KEY: 'x' });
    assert.equal(JSON.parse(r.stdout).runStatus, 'auth_refused');
  });
});

describe('module side effects', () => {
  test('importing the library modules starts nothing and prints nothing', () => {
    const code = `for (const m of ['args', 'auth', 'config', 'result', 'run']) await import('./src/agent/' + m + '.ts');`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: REPO, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });
});
