import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { CONTROL_DIR, controlSpecPath, runControl } from '../control.ts';
import type { ControlDeps } from '../control.ts';
import type { PlaywrightRun } from '../generate.ts';
import { loadGenerationConfig } from '../generation.ts';
import { listScenarioIds, scenarioDir } from '../scenarios.ts';
import { copyScenario, fakePlaywright, tempDir } from './helpers.ts';
import type { FakeRunOptions } from './helpers.ts';

// Control runs with a fake Playwright: no browser, no model. Real control specs are checked
// against the real fixture with `npm run eval -- control --scenario <id>`.

const SCENARIOS_WITH_CONTROLS = ['S01', 'S03', 'S09'];

async function setup(t: TestContext, id: string, options: FakeRunOptions = {}, edit?: (config: Record<string, any>) => void) {
  const base = await tempDir(t);
  const scenariosRoot = path.join(base, 'scenarios');
  await copyScenario(scenariosRoot, id, id, edit);
  const runs: PlaywrightRun[] = [];
  const deps: ControlDeps = {
    repoRoot: base,
    scenariosRoot,
    workRoot: path.join(base, '.work'),
    runPlaywright: fakePlaywright(options, runs),
    repoState: async () => 'unchanged',
  };
  return { base, deps, runs, scenariosRoot };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe('runControl', () => {
  test('runs the control spec (not the failing spec) with the scenario settings and passes', async (t) => {
    let staged = '';
    let stagedFiles: string[] = [];
    let config = '';
    const { deps, runs, scenariosRoot } = await setup(t, 'S03', {
      attempts: ['passed'],
      during: async (run) => {
        staged = await readFile(path.join(run.stageDir, 'tests', 'ui', 'profile.spec.ts'), 'utf8');
        stagedFiles = (await readdir(run.stageDir, { recursive: true })).map((p) => p.split(path.sep).join('/')).sort();
        config = await readFile(run.configFile, 'utf8');
        const started = Date.now();
        assert.equal((await fetch(`${run.env.BASE_URL}/api/profile`)).status, 200);
        assert.ok(Date.now() - started >= 1000, 'the scenario fixture delay applies to the control too');
      },
    });
    const outcome = await runControl('S03', deps);
    assert.ok(outcome.ok, outcome.reason ?? '');
    assert.equal(staged, await readFile(controlSpecPath('S03', 'tests/ui/profile.spec.ts', scenariosRoot), 'utf8'));
    assert.doesNotMatch(staged, /isVisible\(\)/);
    assert.deepEqual(stagedFiles, ['playwright.config.ts', 'tests', 'tests/ui', 'tests/ui/profile.spec.ts']);
    assert.match(config, /retries: 0,/);
    assert.equal(await exists(runs[0]!.stageDir), false, 'stage removed');
  });

  test('fails when the control does not pass', async (t) => {
    const { deps } = await setup(t, 'S01', { attempts: ['failed'] });
    const outcome = await runControl('S01', deps);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? '', /playwright-exit .*passed \(0 passed, 1 failed/);
  });

  test('a control that only passes on retry is not a pass', async (t) => {
    const { deps } = await setup(t, 'S01', { attempts: ['failed', 'passed'], retries: 1 }, (c) => (c.playwright.retries = 1));
    const outcome = await runControl('S01', deps);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? '', /1 flaky/);
  });

  test('fails when repository state changes during the run', async (t) => {
    const { deps } = await setup(t, 'S01', { attempts: ['passed'] });
    let calls = 0;
    deps.repoState = async () => `state-${calls++}`;
    const outcome = await runControl('S01', deps);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? '', /repo-state/);
  });

  test('refuses a scenario without a control spec, before running anything', async (t) => {
    const { deps, runs, scenariosRoot } = await setup(t, 'S01', { attempts: ['passed'] });
    await rm(path.join(scenariosRoot, 'S01', CONTROL_DIR), { recursive: true });
    await assert.rejects(runControl('S01', deps), /has no control spec/);
    assert.equal(runs.length, 0);
  });

  test('never writes a snapshot', async (t) => {
    const { base, deps } = await setup(t, 'S09', { attempts: ['passed'] });
    assert.ok((await runControl('S09', deps)).ok);
    assert.deepEqual((await readdir(base)).sort(), ['.work', 'scenarios']);
    assert.deepEqual(await readdir(path.join(base, '.work')), []);
  });
});

describe('control specs in the dataset', () => {
  test(`${SCENARIOS_WITH_CONTROLS.join(', ')} have a control for their spec`, async () => {
    for (const id of SCENARIOS_WITH_CONTROLS) {
      const config = await loadGenerationConfig(id);
      assert.ok(await exists(controlSpecPath(id, config.spec)), `${id} has no control spec`);
    }
  });

  test('a control keeps the test title and differs from the failing spec', async () => {
    for (const id of await listScenarioIds()) {
      const config = await loadGenerationConfig(id);
      const file = controlSpecPath(id, config.spec);
      if (!(await exists(file))) continue;
      const [control, spec] = await Promise.all([readFile(file, 'utf8'), readFile(path.join(scenarioDir(id), ...config.spec.split('/')), 'utf8')]);
      assert.notEqual(control, spec, `${id}: control is identical to the failing spec`);
      const title = (s: string) => /test\('([^']+)'/.exec(s)?.[1];
      assert.equal(title(control), title(spec), `${id}: control changes the test title`);
    }
  });
});
