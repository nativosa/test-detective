import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { describe, test } from 'node:test';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { buildQueryOptions } from '../config.ts';
import { runInvestigation } from '../run.ts';
import type { QueryFn } from '../run.ts';
import { args, REPO_ROOT } from './helpers.ts';

// Real SDK, fake Claude Code: spawnClaudeCodeProcess starts a Node process that reads stdin and
// never answers. No network, no model. Proves that a timeout or Ctrl+C ends the child process,
// not just the promise we were waiting on. Observed with SDK 0.3.302: close() ends the child's
// stdin (a real Claude Code exits on EOF), then sends SIGKILL after a grace period of about 7s.
// This fake ignores EOF, so it exercises the SIGKILL path.

const HANG = 'process.stdin.resume(); setInterval(() => {}, 1 << 30);';

function hangingQuery(): { query: QueryFn; child: () => ChildProcess | undefined } {
  let child: ChildProcess | undefined;
  const query: QueryFn = (params) =>
    sdkQuery({
      ...params,
      options: {
        ...params.options,
        spawnClaudeCodeProcess: () => {
          child = spawn(process.execPath, ['-e', HANG], { stdio: ['pipe', 'pipe', 'ignore'] });
          return child as unknown as SpawnedProcess;
        },
      },
    });
  return { query, child: () => child };
}

function exited(child: ChildProcess, withinMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), withinMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** The value of `--name=value` or `--name value` in a Claude Code argv. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  return argv[i] === name ? argv[i + 1] : argv[i]!.slice(name.length + 1);
}

describe('real SDK: options become the intended Claude Code flags', () => {
  // The first live run had the skill discovered but no Skill tool: `tools` is --tools, and
  // `skills` only adds an allow rule. This pins the SDK's translation, not just our options.
  test('the Skill tool is available and only investigate-failure is authorized', async (t) => {
    let child: ChildProcess | undefined;
    t.after(() => child?.kill('SIGKILL'));
    const spawned = new Promise<string[]>((resolve) => {
      const options = buildQueryOptions(args(), REPO_ROOT, new AbortController(), {});
      const q = sdkQuery({
        prompt: (async function* () {})(),
        options: {
          ...options,
          spawnClaudeCodeProcess: (spawnOptions) => {
            resolve(spawnOptions.args);
            child = spawn(process.execPath, ['-e', HANG], { stdio: ['pipe', 'pipe', 'ignore'] });
            return child as unknown as SpawnedProcess;
          },
        },
      });
      t.after(() => q.close());
    });
    const argv = await spawned;
    assert.deepEqual(flag(argv, '--tools')?.split(','), ['Read', 'Grep', 'Glob', 'Bash', 'Skill']);
    const allowed = flag(argv, '--allowedTools')?.split(',') ?? [];
    // investigate-failure is the only skill the Skill tool may run: no bare Skill, no other Skill(...) rule.
    assert.deepEqual(allowed.filter((t) => t.startsWith('Skill')), ['Skill(investigate-failure)'], allowed.join(','));
    assert.ok(!(flag(argv, '--disallowedTools') ?? '').split(',').includes('Skill'));
  });
});

describe('real SDK with an unresponsive Claude Code process', () => {
  test('timeout closes the session and terminates the child process', async (t) => {
    const fake = hangingQuery();
    t.after(() => fake.child()?.kill('SIGKILL'));
    const result = await runInvestigation(args({ timeoutMs: 1500 }), { repoRoot: REPO_ROOT, query: fake.query, env: {} });
    assert.equal(result.runStatus, 'timeout');
    const child = fake.child();
    assert.ok(child, 'the SDK spawned the (fake) Claude Code process');
    assert.equal(await exited(child, 15_000), true, 'child process is gone after the timeout');
  });

  test('Ctrl+C (abort signal) terminates the child process', async (t) => {
    const fake = hangingQuery();
    t.after(() => fake.child()?.kill('SIGKILL'));
    const interrupt = new AbortController();
    setTimeout(() => interrupt.abort(), 500);
    const result = await runInvestigation(args(), { repoRoot: REPO_ROOT, query: fake.query, env: {}, signal: interrupt.signal });
    assert.equal(result.runStatus, 'interrupted');
    assert.equal(await exited(fake.child()!, 15_000), true);
  });
});
