import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { GenerationConfig } from '../generation.ts';
import { scenarioDir, TRUTH_FILE } from '../scenarios.ts';
import { GroundTruth } from '../truth.ts';

// Schema behavior on hand-made variants of a valid truth file and generation config.

const base = JSON.parse(await readFile(path.join(scenarioDir('S02'), TRUTH_FILE), 'utf8')) as Record<string, any>;
const variant = (edit: (t: Record<string, any>) => void) => {
  const copy = structuredClone(base);
  edit(copy);
  return copy;
};
const rejects = (value: unknown, pattern: RegExp) => {
  const parsed = GroundTruth.safeParse(value);
  assert.equal(parsed.success, false, 'expected the schema to reject the value');
  assert.match(JSON.stringify(parsed.error?.issues), pattern);
};

describe('GroundTruth', () => {
  test('accepts the S02 file', () => {
    assert.equal(GroundTruth.safeParse(base).success, true);
  });

  test('rejects unknown keys', () => {
    rejects(variant((t) => (t.notes = 'x')), /unrecognized_keys/);
  });

  test('rejects an invalid regular expression', () => {
    rejects(variant((t) => (t.rootCause.criteria[0].anyOf = ['('])), /valid regular expression/);
  });

  test('rejects duplicate criterion ids', () => {
    rejects(variant((t) => t.rootCause.criteria.push(structuredClone(t.rootCause.criteria[0]))), /unique/);
  });

  test('rejects a malformed canary', () => {
    rejects(variant((t) => (t.canary = 'TDCANARY-1234')), /canary/);
  });

  test('rejects an investigated scenario without a classification', () => {
    rejects(variant((t) => (t.expected.classification = null)), /needs a classification/);
  });

  test('rejects a negative control that carries tests', () => {
    rejects(variant((t) => (t.expected.reportStatus = 'no_failures')), /carries no classification/);
  });

  test('rejects an alternative equal to the expected classification', () => {
    rejects(
      variant((t) => (t.expected.acceptableAlternatives = [{ classification: 'Test-code defect', maxConfidence: 'Low', note: 'x' }])),
      /must differ/,
    );
  });

  test('evidence kinds and classifications follow the CLI schema', () => {
    rejects(variant((t) => (t.requiredEvidence[0].kind = 'video')), /kind/);
    rejects(variant((t) => (t.expected.classification = 'Flaky')), /classification/);
  });
});

describe('GenerationConfig', () => {
  const config = {
    id: 'S99',
    spec: 'tests/ui/x.spec.ts',
    app: { profileApi: 'ok' },
    playwright: { retries: 0, testTimeoutMs: 15_000 },
    expectObservation: { outcome: 'unexpected', errorPattern: 'x', attachments: ['trace'] },
  };

  test('accepts a minimal config', () => {
    assert.equal(GenerationConfig.safeParse(config).success, true);
  });

  test('rejects ground-truth fields', () => {
    assert.equal(GenerationConfig.safeParse({ ...config, classification: 'Test-code defect' }).success, false);
  });

  test('rejects spec paths outside tests/ui', () => {
    assert.equal(GenerationConfig.safeParse({ ...config, spec: '../tests/ui/x.spec.ts' }).success, false);
  });
});
