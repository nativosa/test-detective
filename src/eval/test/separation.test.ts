import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLASSIFICATIONS } from '../../agent/result.ts';
import { GenerationConfig, loadGenerationConfig } from '../generation.ts';
import { GENERATION_FILE, listScenarioIds, readJson, scenarioDir, TRUTH_FILE } from '../scenarios.ts';
import { GroundTruth, loadGroundTruth } from '../truth.ts';

// Generation data and evaluation ground truth stay apart: the generator can't read answers, and
// nothing a workspace could receive (generation config, spec) carries labels or canaries.

const EVAL_DIR = fileURLToPath(new URL('../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ids = await listScenarioIds();
const canaries = await Promise.all(ids.map(async (id) => (await loadGroundTruth(id)).canary));

/** Every object key in a JSON value, recursively. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]!);
}

async function specFiles(id: string): Promise<string[]> {
  const dir = scenarioDir(id);
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((e) => e.endsWith('.ts')).map((e) => path.join(dir, e));
}

describe('module separation', () => {
  for (const module of ['generation.ts', 'generate.ts', 'snapshots.ts']) {
    test(`${module} (generator side) never imports ground truth or the agent result types`, async () => {
      const imports = importsOf(await readFile(path.join(EVAL_DIR, module), 'utf8'));
      assert.ok(imports.length > 0, 'import parsing found nothing');
      for (const spec of imports) assert.doesNotMatch(spec, /truth|agent\//, `${module} imports ${spec}`);
    });
  }

  test('generator-side modules never reach truth.ts or isolation.ts, even transitively', async () => {
    const seen = new Set<string>();
    const visit = async (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const relative = importsOf(await readFile(file, 'utf8')).filter((s) => s.startsWith('.'));
      for (const spec of relative) await visit(path.resolve(path.dirname(file), spec));
    };
    for (const module of ['generation.ts', 'generate.ts', 'snapshots.ts']) await visit(path.join(EVAL_DIR, module));
    const reached = [...seen].map((f) => path.relative(EVAL_DIR, f).split(path.sep).join('/'));
    assert.ok(reached.includes('../mcp/report.ts'), `import graph walked (${reached.join(', ')})`);
    for (const forbidden of ['truth.ts', 'isolation.ts', 'workspace.ts', 'score.ts', 'report.ts', 'runs.ts', 'live.ts', '../agent/result.ts']) {
      assert.ok(!reached.includes(forbidden), `the generator reaches ${forbidden}`);
    }
  });

  test('scoring and reporting never reach the SDK runtime, a session, Playwright or a subprocess', async () => {
    // Type-only imports are erased at runtime, so they are skipped; everything else is followed.
    const seen = new Set<string>();
    const bare = new Set<string>();
    const visit = async (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(file, 'utf8');
      const specs = [...source.matchAll(/^\s*import\s(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]!);
      for (const spec of specs) {
        if (spec.startsWith('.')) await visit(path.resolve(path.dirname(file), spec));
        else bare.add(spec);
      }
    };
    for (const module of ['score.ts', 'report.ts', 'runs.ts']) await visit(path.join(EVAL_DIR, module));
    const reached = [...seen].map((f) => path.relative(EVAL_DIR, f).split(path.sep).join('/'));
    assert.ok(reached.includes('truth.ts') && reached.includes('isolation.ts'), `import graph walked (${reached.join(', ')})`);
    for (const forbidden of ['../agent/run.ts', '../agent/main.ts', '../agent/auth.ts', 'generate.ts', 'live.ts', 'main.ts', '../../evals/app/server.ts']) {
      assert.ok(!reached.includes(forbidden), `scoring reaches ${forbidden}`);
    }
    for (const forbidden of ['@anthropic-ai/claude-agent-sdk', 'node:child_process', '@playwright/test', 'node:http', 'node:net']) {
      assert.ok(!bare.has(forbidden), `scoring imports ${forbidden} at runtime`);
    }
  });

  test('live.ts is the only evaluation module that loads the Agent SDK at runtime', async () => {
    const modules = (await readdir(EVAL_DIR)).filter((f) => f.endsWith('.ts'));
    const loaders = [];
    for (const module of modules) {
      const source = await readFile(path.join(EVAL_DIR, module), 'utf8');
      if (/^\s*import\s(?!type\s)[^;]*?from\s+['"]@anthropic-ai\/claude-agent-sdk['"]/m.test(source)) loaders.push(module);
    }
    assert.deepEqual(loaders, ['live.ts']);
  });

  test('generator-side modules never name the truth file', async () => {
    for (const module of ['generation.ts', 'generate.ts', 'snapshots.ts']) {
      const source = await readFile(path.join(EVAL_DIR, module), 'utf8');
      assert.doesNotMatch(source, /TRUTH_FILE|truth\.json/, `${module} refers to ground truth`);
    }
  });

  test('scenarios.ts (shared by both loaders) imports neither loader', async () => {
    const imports = importsOf(await readFile(path.join(EVAL_DIR, 'scenarios.ts'), 'utf8'));
    for (const spec of imports) assert.doesNotMatch(spec, /truth|generation/, `scenarios.ts imports ${spec}`);
  });

  test('the generation loader works without a truth file present', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'td-eval-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const id of ids) {
      await cp(scenarioDir(id), path.join(root, id), { recursive: true, filter: (src) => path.basename(src) !== TRUTH_FILE });
      const config = await loadGenerationConfig(id, root);
      assert.equal(config.id, id);
    }
    await assert.rejects(loadGroundTruth(ids[0]!, root), /ENOENT/);
  });
});

describe('schema separation', () => {
  test('generation and truth schemas share no field except id', () => {
    const generationKeys = new Set(Object.keys(GenerationConfig.shape));
    const truthKeys = Object.keys(GroundTruth.shape);
    assert.deepEqual(truthKeys.filter((k) => generationKeys.has(k)), ['id']);
  });

  for (const id of ids) {
    test(`${id}: generation.json has no ground-truth keys, labels or canaries`, async () => {
      const [generation, truth] = await Promise.all([readJson(path.join(scenarioDir(id), GENERATION_FILE)), readJson(path.join(scenarioDir(id), TRUTH_FILE))]);
      const truthKeys = keysOf(truth);
      const shared = [...keysOf(generation)].filter((k) => truthKeys.has(k) && k !== 'id');
      assert.deepEqual(shared, [], `generation.json uses ground-truth keys: ${shared.join(', ')}`);
      const text = JSON.stringify(generation);
      for (const label of CLASSIFICATIONS) assert.ok(!text.includes(label), `generation.json mentions "${label}"`);
      assert.doesNotMatch(text, /TDCANARY/);
    });

    test(`${id}: test sources carry no canaries, labels, scenario IDs or comments`, async () => {
      const files = await specFiles(id);
      assert.ok(files.length > 0);
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        const name = path.relative(REPO_ROOT, file);
        assert.doesNotMatch(source, /TDCANARY/, `${name} contains a canary`);
        for (const canary of canaries) assert.ok(!source.includes(canary), `${name} contains a canary`);
        for (const label of CLASSIFICATIONS) assert.ok(!source.toLowerCase().includes(label.toLowerCase()), `${name} mentions "${label}"`);
        assert.doesNotMatch(source, /\bS\d{2}\b/, `${name} mentions a scenario ID`);
        assert.doesNotMatch(source, /(^|\s)\/\/|\/\*/m, `${name} has a comment; scenario specs must not explain themselves`);
      }
    });
  }
});

describe('regular suite isolation', () => {
  test('the main Playwright config never collects scenario specs', async () => {
    const { default: config } = await import('../../../playwright.config.ts');
    assert.ok(config.testDir, 'testDir is set');
    const testDir = path.resolve(REPO_ROOT, config.testDir);
    const scenarios = path.resolve(REPO_ROOT, 'evals');
    assert.ok(path.relative(testDir, scenarios).startsWith('..'), `testDir ${testDir} contains evals/`);
  });
});
