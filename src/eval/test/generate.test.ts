import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { checkObservation, generateSnapshot, playwrightEnv, stageConfigSource } from '../generate.ts';
import type { GenerateDeps, PlaywrightRun } from '../generate.ts';
import { loadGenerationConfig } from '../generation.ts';
import { scenarioDir } from '../scenarios.ts';
import { loadSnapshot, sha256 } from '../snapshots.ts';
import { copyScenario, fakePlaywright, tempDir } from './helpers.ts';
import type { FakeRunOptions } from './helpers.ts';

// generateSnapshot with a fake Playwright: no browser, no network beyond the local fixture app.
// Scenario roots are copies of real scenarios without truth.json, so generation can't depend on it.

async function setup(t: TestContext, options: FakeRunOptions = {}, edit?: (config: Record<string, any>) => void) {
  const base = await tempDir(t);
  const scenariosRoot = path.join(base, 'scenarios');
  await copyScenario(scenariosRoot, 'S02', 'S02', edit);
  const runs: PlaywrightRun[] = [];
  const deps: GenerateDeps = {
    repoRoot: base,
    scenariosRoot,
    snapshotsRoot: path.join(base, 'snapshots'),
    workRoot: path.join(base, '.work'),
    runPlaywright: fakePlaywright(options, runs),
    repoState: async () => 'unchanged',
    now: () => new Date('2026-10-21T12:00:00.000Z'),
  };
  return { base, deps, runs };
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const failedChecks = (checks: { name: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.name);

describe('generateSnapshot', () => {
  test('stores a verified snapshot and removes the stage', async (t) => {
    const { deps, runs } = await setup(t);
    const outcome = await generateSnapshot('S02', deps);
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
    assert.equal(await exists(outcome.stageDir), false, 'stage removed');

    const { manifest, filesDir } = await loadSnapshot('S02', deps.snapshotsRoot);
    assert.equal(manifest.scenarioId, 'S02');
    assert.equal(manifest.generatedAt, '2026-10-21T12:00:00.000Z');
    assert.equal(manifest.playwrightVersion, '1.64.1');
    assert.equal(manifest.reportFingerprint, outcome.facts.list.run.reportFingerprint);
    assert.equal(manifest.stageRoot, runs[0]!.stageDir);
    assert.equal(manifest.generationConfigSha256, sha256(await readFile(path.join(deps.scenariosRoot!, 'S02', 'generation.json'))));
    assert.ok(manifest.observation.checks.every((c) => c.ok));
    assert.deepEqual(
      manifest.files.map((f) => f.path),
      [
        'artifacts/results.json',
        'playwright.config.ts',
        'test-results/ui-login-signs-in-chromium/error-context.md',
        'test-results/ui-login-signs-in-chromium/test-failed-1.png',
        'test-results/ui-login-signs-in-chromium/trace.zip',
        'tests/ui/login.spec.ts',
      ],
    );
    const source = await stat(path.join(deps.scenariosRoot!, 'S02', 'tests', 'ui', 'login.spec.ts'));
    const stored = await stat(path.join(filesDir, 'tests', 'ui', 'login.spec.ts'));
    assert.ok(Math.abs(stored.mtimeMs - source.mtimeMs) <= 2, 'spec mtime preserved from the scenario source');
  });

  test('copies only the declared spec into the stage, never truth.json or other files', async (t) => {
    let staged: string[] = [];
    const { deps } = await setup(t, { during: async (run) => void (staged = await readdir(run.stageDir, { recursive: true })) });
    const outcome = await generateSnapshot('S02', deps);
    assert.ok(outcome.ok);
    assert.deepEqual(staged.map((p) => p.split(path.sep).join('/')).sort(), ['playwright.config.ts', 'tests', 'tests/ui', 'tests/ui/login.spec.ts']);
  });

  test('runs Playwright against the fixture app, which is closed afterwards', async (t) => {
    let baseUrl = '';
    const { deps, runs } = await setup(t, {
      during: async (run) => {
        baseUrl = run.env.BASE_URL!;
        assert.equal((await fetch(`${baseUrl}/login`)).status, 200);
      },
    });
    assert.ok((await generateSnapshot('S02', deps)).ok);
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(runs[0]!.configFile, path.join(runs[0]!.stageDir, 'playwright.config.ts'));
    await assert.rejects(fetch(`${baseUrl}/login`));
  });

  test('rejects a run whose outcome does not match (test passed)', async (t) => {
    const { deps } = await setup(t, { attempts: ['passed'] });
    const outcome = await generateSnapshot('S02', deps);
    assert.equal(outcome.ok, false);
    assert.ok(failedChecks(outcome.checks).includes('outcome'));
    assert.ok(failedChecks(outcome.checks).includes('playwright-exit'));
    assert.equal(await exists(path.join(deps.snapshotsRoot!, 'S02')), false, 'no snapshot');
    assert.equal(await exists(outcome.stageDir!), false, 'stage removed after failure');
  });

  test('rejects an error message that does not match errorPattern', async (t) => {
    const { deps } = await setup(t, { message: 'Error: something else entirely' });
    const outcome = await generateSnapshot('S02', deps);
    assert.equal(outcome.ok, false);
    assert.deepEqual(failedChecks(outcome.checks), ['error-pattern']);
  });

  test('rejects missing attachment files', async (t) => {
    const { deps } = await setup(t, { missingFiles: ['trace'] });
    const outcome = await generateSnapshot('S02', deps);
    assert.equal(outcome.ok, false);
    assert.deepEqual(failedChecks(outcome.checks), ['attachments-retry-0', 'attachment-paths-retry-0']);
    assert.match(outcome.reason, /missing trace/);
  });

  test('rejects attachments that are not listed at all', async (t) => {
    const { deps } = await setup(t, { attachments: ['screenshot'] });
    const outcome = await generateSnapshot('S02', deps);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /missing trace, error-context/);
  });

  test('rejects attachments written outside the stage', async (t) => {
    const outsideDir = await tempDir(t, 'td-outside-');
    const { deps } = await setup(t, { outsideDir });
    const outcome = await generateSnapshot('S02', deps);
    assert.equal(outcome.ok, false);
    assert.ok(failedChecks(outcome.checks).includes('attachment-paths-retry-0'));
    assert.match(outcome.reason, /outside-repo/);
  });

  test('checks the attempt count against the configured retries', async (t) => {
    const { deps } = await setup(t, { attempts: ['failed', 'failed'], retries: 0 });
    const outcome = await generateSnapshot('S02', deps);
    assert.equal(outcome.ok, false);
    assert.ok(failedChecks(outcome.checks).includes('attempts'));
  });

  test('refuses to overwrite an existing snapshot', async (t) => {
    const { deps, runs } = await setup(t);
    assert.ok((await generateSnapshot('S02', deps)).ok);
    const manifestFile = path.join(deps.snapshotsRoot!, 'S02', 'manifest.json');
    const before = await readFile(manifestFile, 'utf8');
    const second = await generateSnapshot('S02', deps);
    assert.equal(second.ok, false);
    assert.match(second.reason, /already exists/);
    assert.equal(runs.length, 1, 'Playwright not run the second time');
    assert.equal(await readFile(manifestFile, 'utf8'), before);
  });

  test('discards the snapshot when repository state changes during generation', async (t) => {
    const { deps } = await setup(t);
    let calls = 0;
    deps.repoState = async () => `state-${calls++}`;
    const outcome = await generateSnapshot('S02', deps);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /Repository state changed/);
    assert.equal(await exists(path.join(deps.snapshotsRoot!, 'S02')), false);
  });

  test('cleans up when Playwright fails to start or times out', async (t) => {
    for (const options of [{ throws: new Error('spawn failed') }, { timedOut: true }]) {
      const { deps } = await setup(t, options);
      const outcome = await generateSnapshot('S02', deps);
      assert.equal(outcome.ok, false);
      assert.match(outcome.reason, /spawn failed|did not finish/);
      assert.equal(await exists(outcome.stageDir!), false);
      assert.deepEqual(await readdir(deps.workRoot!), [], 'no stage directories left');
    }
  });

  test('keeps the stage only when asked', async (t) => {
    const { deps } = await setup(t);
    deps.keepStage = true;
    const outcome = await generateSnapshot('S02', deps);
    assert.ok(outcome.ok && outcome.stageKept);
    assert.equal(await exists(path.join(outcome.stageDir, 'artifacts', 'results.json')), true);
  });

  test('similar scenarios get separate stages, snapshots and reports', async (t) => {
    const base = await tempDir(t);
    const scenariosRoot = path.join(base, 'scenarios');
    await copyScenario(scenariosRoot, 'S02', 'S91');
    await copyScenario(scenariosRoot, 'S02', 'S92');
    const runs: PlaywrightRun[] = [];
    const deps: GenerateDeps = {
      repoRoot: base,
      scenariosRoot,
      snapshotsRoot: path.join(base, 'snapshots'),
      workRoot: path.join(base, '.work'),
      runPlaywright: fakePlaywright({}, runs),
      repoState: async () => 'unchanged',
    };
    const a = await generateSnapshot('S91', deps);
    const b = await generateSnapshot('S92', deps);
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.stageDir, b.stageDir);
    assert.notEqual(a.snapshot.dir, b.snapshot.dir);
    assert.notEqual(a.snapshot.manifest.reportFingerprint, b.snapshot.manifest.reportFingerprint);
    assert.notEqual(a.snapshot.manifest.stageRoot, b.snapshot.manifest.stageRoot);
  });
});

describe('checkObservation', () => {
  const facts = (outcome: 'unexpected' | 'flaky', statuses: string[]) =>
    ({
      list: {
        globalErrors: { count: 0, items: [] },
        stats: { expected: 0, unexpected: outcome === 'unexpected' ? 1 : 0, flaky: outcome === 'flaky' ? 1 : 0, skipped: 0 },
        failureCount: 1,
        failures: [{ testId: 't@000000000000', outcome }],
      },
      details: [
        {
          testId: 't@000000000000',
          configuredRetries: 1,
          attempts: statuses.map((status, retry) => ({ retry, status, error: status === 'passed' ? null : { message: 'boom' }, additionalErrors: [], attachments: [] })),
        },
      ],
    }) as any;

  test('accepts a flaky run that passed on retry', async () => {
    const config = await loadGenerationConfig('S02');
    const flaky = { ...config, playwright: { ...config.playwright, retries: 1 }, expectObservation: { outcome: 'flaky' as const, errorPattern: 'boom', attachments: [] } };
    assert.deepEqual(failedChecks(checkObservation(flaky, facts('flaky', ['failed', 'passed']))), []);
  });

  test('rejects an unexpected run with fewer attempts than retries allow', async () => {
    const config = await loadGenerationConfig('S02');
    const retried = { ...config, playwright: { ...config.playwright, retries: 1 }, expectObservation: { ...config.expectObservation, errorPattern: 'boom', attachments: [] } };
    assert.ok(failedChecks(checkObservation(retried, facts('unexpected', ['failed']))).includes('attempts'));
  });
});

describe('stage configuration', () => {
  test('pins every output into the stage and uses the scenario settings', async () => {
    const config = await loadGenerationConfig('S02');
    const source = stageConfigSource(config);
    assert.match(source, /testDir: '\.\/tests'/);
    assert.match(source, /outputDir: '\.\/test-results'/);
    assert.match(source, /outputFile: 'artifacts\/results\.json'/);
    assert.match(source, new RegExp(`retries: ${config.playwright.retries},`));
    assert.match(source, new RegExp(`timeout: ${config.playwright.testTimeoutMs},`));
    assert.match(source, /baseURL: process\.env\.BASE_URL/);
    assert.doesNotMatch(source, /html/, 'no HTML report in the snapshot');
  });

  test('the stage config contains nothing scenario-revealing', async () => {
    for (const id of ['S02', 'S04', 'S05']) {
      const config = await loadGenerationConfig(id);
      const source = stageConfigSource(config);
      assert.doesNotMatch(source, /profileApi|error|S\d{2}|TDCANARY|mock/i, `${id} config leaks scenario details`);
    }
  });

  test('strips variables that would redirect reporters, and sets BASE_URL', () => {
    const env = playwrightEnv({ PATH: 'p', PLAYWRIGHT_JSON_OUTPUT_NAME: 'x', PLAYWRIGHT_HTML_OPEN: 'always', PW_TEST_HTML_REPORT_OPEN: 'x', PLAYWRIGHT_BROWSERS_PATH: 'b' }, 'http://127.0.0.1:1');
    assert.deepEqual(env, { PATH: 'p', PLAYWRIGHT_BROWSERS_PATH: 'b', BASE_URL: 'http://127.0.0.1:1' });
  });

  test('the real scenario directories hold only generation.json, truth.json and the spec', async () => {
    for (const id of ['S02', 'S04', 'S05']) {
      const config = await loadGenerationConfig(id);
      const entries = (await readdir(scenarioDir(id), { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
      const files = entries.map((e) => path.relative(scenarioDir(id), path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();
      assert.deepEqual(files, ['generation.json', config.spec, 'truth.json'].sort());
    }
  });
});
