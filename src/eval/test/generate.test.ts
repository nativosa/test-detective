import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { checkObservation, generateSnapshot, playwrightEnv, stageConfigSource } from '../generate.ts';
import type { GenerateDeps, PlaywrightRun } from '../generate.ts';
import { GenerationConfig, loadGenerationConfig } from '../generation.ts';
import { listScenarioIds, scenarioDir } from '../scenarios.ts';
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

describe('Stage 2.6 generation options', () => {
  // The exact stage config the pilot snapshots were generated with (before trace/screenshot became options).
  const PILOT_CONFIG = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  retries: 0,
  timeout: 15000,
  reporter: [['list'], ['json', { outputFile: 'artifacts/results.json' }]],
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: process.env.BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
`;
  // sha256 of the pilot generation files, as recorded in their snapshot manifests.
  const PILOT_GENERATION_SHA256: Record<string, string> = {
    S02: 'dd64c58e95a102e9af1bdbdc1844be2e9ff3597ec2705d5dae97a9b14468a8e5',
    S04: '6586079cdc13bca516ca52e8e81b14c99a5b3b744f8d5373bed1bf10b1286d7f',
    S05: 'a219d0ef9bfa3c70b283dcbe11079ea9307b8c0bb74052748168f7b648001468',
  };

  test('the pilot scenarios produce byte-identical stage configs and keep their generation hashes', async () => {
    for (const [id, hash] of Object.entries(PILOT_GENERATION_SHA256)) {
      assert.equal(stageConfigSource(await loadGenerationConfig(id)), PILOT_CONFIG, `${id} stage config changed`);
      assert.equal(sha256(await readFile(path.join(scenarioDir(id), 'generation.json'))), hash, `${id} generation.json changed`);
    }
  });

  test('trace and screenshot can be turned off', async () => {
    const source = stageConfigSource(await loadGenerationConfig('S08'));
    assert.match(source, /trace: 'off',/);
    assert.match(source, /screenshot: 'off',/);
  });

  test('no stage config contains anything scenario-revealing', async () => {
    for (const id of await listScenarioIds()) {
      const source = stageConfigSource(await loadGenerationConfig(id));
      assert.doesNotMatch(source, /profileApi|profileDelay|fail-first|hang|down|error|S\d{2}|TDCANARY|mock|control|post-run/i, `${id} config leaks scenario details`);
    }
  });

  test('scenario directories hold only generation.json, truth.json, the spec, and optional post-run/ and control/ specs', async () => {
    for (const id of await listScenarioIds()) {
      const config = await loadGenerationConfig(id);
      const entries = (await readdir(scenarioDir(id), { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
      const files = entries.map((e) => path.relative(scenarioDir(id), path.join(e.parentPath, e.name)).split(path.sep).join('/'));
      const allowed = new Set(['generation.json', 'truth.json', config.spec, `control/${config.spec}`, ...(config.postRun ? [`post-run/${config.spec}`] : [])]);
      for (const f of files) assert.ok(allowed.has(f), `${id}: unexpected file ${f}`);
    }
  });

  test('a down server gives a base URL where connections are refused', async (t) => {
    let baseUrl = '';
    const { deps } = await setup(t, { during: async (run) => void (baseUrl = run.env.BASE_URL!) }, (c) => (c.app.server = 'down'));
    await generateSnapshot('S02', deps);
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    await assert.rejects(fetch(`${baseUrl}/login`));
  });

  test('the fixture delay applies to the app the run uses', async (t) => {
    let elapsed = 0;
    const probe = async (run: PlaywrightRun) => {
      const started = Date.now();
      assert.equal((await fetch(`${run.env.BASE_URL}/api/profile`)).status, 200);
      elapsed = Date.now() - started;
    };
    const { deps } = await setup(t, { during: probe }, (c) => (c.app.profileDelayMs = 300));
    await generateSnapshot('S02', deps);
    assert.ok(elapsed >= 250, `delay applied (${elapsed} ms)`);
  });
});

describe('post-run source edits (S09 shape)', () => {
  const SNIPPET = [
    "  4 |   await page.goto('/profile');",
    '  5 |',
    "> 6 |   await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Profile');",
    '    |                                                         ^',
    '  7 | });',
  ].join('\n');

  async function setupS09(t: TestContext, options: FakeRunOptions = {}) {
    const base = await tempDir(t);
    const scenariosRoot = path.join(base, 'scenarios');
    await copyScenario(scenariosRoot, 'S09', 'S09');
    const fake = { message: 'Error: expect(locator).toHaveText(expected) failed', errorAt: { file: 'tests/ui/profile.spec.ts', line: 6, snippet: SNIPPET }, ...options };
    const deps: GenerateDeps = {
      repoRoot: base,
      scenariosRoot,
      snapshotsRoot: path.join(base, 'snapshots'),
      workRoot: path.join(base, '.work'),
      runPlaywright: fakePlaywright(fake),
      repoState: async () => 'unchanged',
    };
    return { deps, scenariosRoot };
  }

  test('stores the edited spec, newer than the run, and stages neither post-run/ nor control/', async (t) => {
    let staged: string[] = [];
    const { deps, scenariosRoot } = await setupS09(t, { during: async (run) => void (staged = await readdir(run.stageDir, { recursive: true })) });
    const outcome = await generateSnapshot('S09', deps);
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
    assert.deepEqual(staged.map((p) => p.split(path.sep).join('/')).sort(), ['playwright.config.ts', 'tests', 'tests/ui', 'tests/ui/profile.spec.ts']);
    const timing = outcome.checks.find((c) => c.name === 'source-timing');
    assert.ok(timing?.ok, timing?.detail);
    const stored = await readFile(path.join(outcome.snapshot.filesDir, 'tests', 'ui', 'profile.spec.ts'), 'utf8');
    assert.equal(stored, await readFile(path.join(scenariosRoot, 'S09', 'post-run', 'tests', 'ui', 'profile.spec.ts'), 'utf8'));
    assert.doesNotMatch(stored, /My Profile/);
    const files = outcome.snapshot.manifest.files.map((f) => f.path);
    assert.ok(!files.some((f) => /control|post-run/.test(f)), files.join(', '));
    const spec = outcome.snapshot.manifest.files.find((f) => f.path === 'tests/ui/profile.spec.ts')!;
    const run = outcome.facts.list.run;
    assert.ok(spec.mtimeMs > Date.parse(run.startTime) + run.durationMs, 'stored mtime is after the run end');
  });

  test('rejects the run when the failing line matches the edited source', async (t) => {
    const same = SNIPPET.replace('My Profile', 'Profile');
    const { deps } = await setupS09(t, { errorAt: { file: 'tests/ui/profile.spec.ts', line: 6, snippet: same } });
    const outcome = await generateSnapshot('S09', deps);
    assert.equal(outcome.ok, false);
    assert.deepEqual(failedChecks(outcome.checks), ['source-timing']);
  });

  test('a scenario without postRun requires a spec older than the run', async (t) => {
    const { deps } = await setup(t);
    const outcome = await generateSnapshot('S02', deps);
    assert.ok(outcome.ok);
    const timing = outcome.checks.find((c) => c.name === 'source-timing');
    assert.ok(timing?.ok);
    assert.match(timing.detail, /spec modified .* run started/);
  });
});

describe('Stage 2.6 observation checks', () => {
  test('absent attachments: rejects a listed trace and its file', async (t) => {
    const absent = (c: Record<string, any>) => {
      c.playwright.trace = 'off';
      c.expectObservation.attachments = ['screenshot', 'error-context'];
      c.expectObservation.absentAttachments = ['trace'];
    };
    const listed = await setup(t, {}, absent);
    const outcome = await generateSnapshot('S02', listed.deps);
    assert.equal(outcome.ok, false);
    assert.deepEqual(failedChecks(outcome.checks), ['absent-attachments']);
    assert.match(outcome.reason, /retry 0 lists trace; file test-results\/.+\/trace\.zip/);

    const clean = await setup(t, { attachments: ['screenshot', 'error-context'] }, absent);
    assert.ok((await generateSnapshot('S02', clean.deps)).ok);
  });

  test("errorContextPattern is matched against the failed attempt's error-context.md", async (t) => {
    const pattern = (c: Record<string, any>) => (c.expectObservation.errorContextPattern = 'Loading your profile');
    const missing = await setup(t, {}, pattern);
    assert.deepEqual(failedChecks((await generateSnapshot('S02', missing.deps)).checks), ['error-context-retry-0']);
    const found = await setup(t, { errorContextExtra: '\n- paragraph: Loading your profile…' }, pattern);
    assert.ok((await generateSnapshot('S02', found.deps)).ok);
  });

  test('maxFailedAttemptMs rejects a slow failure (a timeout instead of an immediate failure)', async (t) => {
    const max = (c: Record<string, any>) => (c.expectObservation.maxFailedAttemptMs = 5000);
    const slow = await setup(t, { durationMs: 10_200 }, max);
    assert.deepEqual(failedChecks((await generateSnapshot('S02', slow.deps)).checks), ['duration-retry-0']);
    const fast = await setup(t, { durationMs: 300 }, max);
    assert.ok((await generateSnapshot('S02', fast.deps)).ok);
  });

  test("a flaky scenario checks only the failed attempt's attachments and expects exit code 0", async (t) => {
    const flaky = (c: Record<string, any>) => {
      c.playwright.retries = 1;
      c.expectObservation.outcome = 'flaky';
      c.expectObservation.errorContextPattern = 'Something went wrong';
    };
    const { deps } = await setup(t, { attempts: ['failed', 'passed'], retries: 1, errorContextExtra: ' Something went wrong' }, flaky);
    const outcome = await generateSnapshot('S02', deps);
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
    assert.deepEqual(outcome.checks.map((c) => c.name).filter((n) => /retry-1/.test(n)), [], 'the passing retry has no attachment checks');
  });

  test('a no-failure scenario (S10 shape) needs exit code 0 and no failures', async (t) => {
    const { deps } = await setup(t, { attempts: ['passed'] }, (c) => (c.expectObservation = { outcome: 'expected', errorPattern: null, attachments: [] }));
    const outcome = await generateSnapshot('S02', deps);
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
    assert.deepEqual(outcome.facts.details, []);
  });
});

describe('generation schema (Stage 2.6 fields)', () => {
  const parse = async (edit: (c: Record<string, any>) => void) => {
    const raw = JSON.parse(await readFile(path.join(scenarioDir('S02'), 'generation.json'), 'utf8'));
    edit(raw);
    return GenerationConfig.safeParse(raw).success;
  };

  test('postRun and sourceTiming "after-run" go together', async () => {
    assert.equal(await parse((c) => (c.postRun = { replaceSpec: true })), false);
    assert.equal(await parse((c) => (c.expectObservation.sourceTiming = 'after-run')), false);
    const both = (c: Record<string, any>) => {
      c.postRun = { replaceSpec: true };
      c.expectObservation.sourceTiming = 'after-run';
    };
    assert.equal(await parse(both), true);
  });

  test('an attachment cannot be both required and absent, or required while turned off', async () => {
    assert.equal(await parse((c) => (c.expectObservation.absentAttachments = ['trace'])), false);
    assert.equal(await parse((c) => (c.playwright.trace = 'off')), false);
  });

  test('rejects unknown app modes and out-of-range delays', async () => {
    assert.equal(await parse((c) => (c.app.profileApi = 'flaky')), false);
    assert.equal(await parse((c) => (c.app.profileDelayMs = 60_000)), false);
    assert.equal(await parse((c) => (c.app.server = 'maybe')), false);
  });
});
