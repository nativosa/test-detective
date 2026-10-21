import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCliArgs } from '../args.ts';

function run(argv: string[]) {
  const parsed = parseCliArgs(argv);
  assert.equal(parsed.kind, 'run', JSON.stringify(parsed));
  return (parsed as Extract<typeof parsed, { kind: 'run' }>).args;
}

function error(argv: string[]): string {
  const parsed = parseCliArgs(argv);
  assert.equal(parsed.kind, 'error', JSON.stringify(parsed));
  return (parsed as Extract<typeof parsed, { kind: 'error' }>).message;
}

describe('parseCliArgs', () => {
  test('defaults: all failures, subscription auth, bounded', () => {
    assert.deepEqual(run([]), {
      filter: null,
      model: null,
      maxTurns: 30,
      timeoutMs: 300_000,
      maxBudgetUsd: null,
      auth: 'subscription',
      json: false,
    });
  });

  test('--test filter is trimmed; other options parse', () => {
    const a = run(['--test', '  checkboxes ', '--model', 'claude-opus-5-5', '--max-turns', '15', '--timeout', '180', '--max-budget-usd', '0.5', '--auth', 'api', '--json']);
    assert.deepEqual(a, { filter: 'checkboxes', model: 'claude-opus-5-5', maxTurns: 15, timeoutMs: 180_000, maxBudgetUsd: 0.5, auth: 'api', json: true });
  });

  test('--test=value form works', () => {
    assert.equal(run(['--test=login']).filter, 'login');
  });

  test('help', () => {
    assert.deepEqual(parseCliArgs(['--help']), { kind: 'help' });
    assert.deepEqual(parseCliArgs(['-h']), { kind: 'help' });
  });

  test('rejects unknown flags and positionals', () => {
    assert.match(error(['--bogus']), /bogus/);
    assert.match(error(['checkboxes']), /positional/i);
  });

  test('rejects empty, oversized or control-character filters', () => {
    assert.match(error(['--test', '   ']), /must not be empty/);
    assert.match(error(['--test', 'x'.repeat(201)]), /200 characters/);
    assert.match(error(['--test', 'a\nb']), /control characters/);
  });

  test('rejects a missing option value', () => {
    assert.match(error(['--test']), /argument missing|requires an argument|--test/);
  });

  test('rejects out-of-range or non-numeric bounds', () => {
    assert.match(error(['--max-turns', '0']), /1-100/);
    assert.match(error(['--max-turns', '101']), /1-100/);
    assert.match(error(['--max-turns', '2.5']), /integer/);
    assert.match(error(['--max-turns', 'many']), /number/);
    assert.match(error(['--timeout', '5']), /10-3600/);
    assert.match(error(['--max-budget-usd=-1']), /positive/);
  });

  test('rejects an unknown auth mode and malformed model IDs', () => {
    assert.match(error(['--auth', 'oauth']), /subscription" or "api/);
    assert.match(error(['--model', 'claude opus; rm -rf']), /model ID/);
  });
});
