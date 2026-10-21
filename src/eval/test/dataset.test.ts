import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadGenerationConfig } from '../generation.ts';
import { listScenarioIds, scenarioDir } from '../scenarios.ts';
import { loadGroundTruth } from '../truth.ts';

// Validates the committed dataset in evals/scenarios/: every scenario parses and is self-consistent.

const PILOTS = ['S02', 'S04', 'S05'];
const ids = await listScenarioIds();

describe('scenario dataset', () => {
  test('contains the pilot scenarios', () => {
    for (const id of PILOTS) assert.ok(ids.includes(id), `missing scenario ${id}`);
  });

  test('scenario IDs are unique', () => {
    assert.equal(new Set(ids).size, ids.length);
  });

  for (const id of ids) {
    describe(id, () => {
      test('generation config parses and its spec exists', async () => {
        await loadGenerationConfig(id);
      });

      test('ground truth parses', async () => {
        await loadGroundTruth(id);
      });

      test('ground truth expects the generated spec', async () => {
        const [generation, truth] = await Promise.all([loadGenerationConfig(id), loadGroundTruth(id)]);
        for (const t of truth.expected.tests) assert.equal(t.file, generation.spec, `${t.title} names a different file`);
        if (truth.expected.reportStatus === 'investigated') assert.notEqual(generation.expectObservation.outcome, 'expected');
      });

      test('expected test titles appear in the spec', async () => {
        const [generation, truth] = await Promise.all([loadGenerationConfig(id), loadGroundTruth(id)]);
        const source = await readFile(path.join(scenarioDir(id), ...generation.spec.split('/')), 'utf8');
        for (const t of truth.expected.tests) assert.ok(source.includes(`test('${t.title}'`), `title "${t.title}" not found in ${generation.spec}`);
      });
    });
  }
});

describe('canaries', () => {
  test('every scenario has a unique canary', async () => {
    const canaries = await Promise.all(ids.map(async (id) => (await loadGroundTruth(id)).canary));
    assert.equal(new Set(canaries).size, canaries.length);
  });

  test('each canary appears exactly once in its truth file', async () => {
    for (const id of ids) {
      const { canary } = await loadGroundTruth(id);
      const text = await readFile(path.join(scenarioDir(id), 'truth.json'), 'utf8');
      assert.equal(text.split(canary).length - 1, 1, `${id}: canary should appear once`);
    }
  });
});
