import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { startApp } from '../../evals/app/server.ts';
import { getFailureDetails, listFailures, loadReport } from '../mcp/report.ts';
import type { FailureDetailsOutput, ListFailuresOutput } from '../mcp/report.ts';
import { loadGenerationConfig } from './generation.ts';
import type { GenerationConfig } from './generation.ts';
import { GENERATION_FILE, scenarioDir, SCENARIOS_DIR } from './scenarios.ts';
import { sha256, SNAPSHOTS_DIR, writeSnapshot } from './snapshots.ts';
import type { Check, LoadedSnapshot } from './snapshots.ts';

// Snapshot generation: runs one scenario's spec with Playwright in a fresh staging directory,
// checks the run shows the intended failure, and stores it as a write-once snapshot.
// Uses generation.json only; it never reads ground truth. No model requests.
//
// Stage layout (also the snapshot payload layout):
//   .work/<random>/playwright.config.ts   generated, neutral; baseURL comes from BASE_URL
//   .work/<random>/tests/ui/<name>.spec.ts
//   .work/<random>/artifacts/results.json
//   .work/<random>/test-results/...
// The stage lives inside the repo only so `@playwright/test` resolves from node_modules.

export type PlaywrightRun = { stageDir: string; configFile: string; env: Record<string, string | undefined>; timeoutMs: number };
export type PlaywrightResult = { exitCode: number | null; output: string; timedOut: boolean };
export type RunPlaywright = (run: PlaywrightRun) => Promise<PlaywrightResult>;

export type GenerateDeps = {
  repoRoot: string;
  scenariosRoot?: string;
  snapshotsRoot?: string;
  /** Parent of stage directories. Default `<repoRoot>/.work`. */
  workRoot?: string;
  /** The only test seam: tests pass a fake that writes a synthetic report into the stage. */
  runPlaywright?: RunPlaywright;
  /** Fingerprint of repo state that generation must not change. */
  repoState?: () => Promise<string>;
  keepStage?: boolean;
  now?: () => Date;
};

export type FailureFacts = { list: ListFailuresOutput; details: FailureDetailsOutput[] };

export type GenerateOutcome =
  | { ok: true; snapshot: LoadedSnapshot; checks: Check[]; facts: FailureFacts; stageDir: string; stageKept: boolean }
  | { ok: false; reason: string; checks: Check[]; facts: FailureFacts | null; output: string; stageDir: string | null; stageKept: boolean };

const PLAYWRIGHT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 200_000;

export async function generateSnapshot(id: string, deps: GenerateDeps): Promise<GenerateOutcome> {
  const scenariosRoot = deps.scenariosRoot ?? SCENARIOS_DIR;
  const snapshotsRoot = deps.snapshotsRoot ?? SNAPSHOTS_DIR;
  const workRoot = deps.workRoot ?? path.join(deps.repoRoot, '.work');
  const runPlaywright = deps.runPlaywright ?? ((run) => spawnPlaywright(deps.repoRoot, run));
  const repoState = deps.repoState ?? (() => defaultRepoState(deps.repoRoot));
  const now = deps.now ?? (() => new Date());
  const stageKept = deps.keepStage === true;

  const config = await loadGenerationConfig(id, scenariosRoot);
  const generationConfigSha256 = sha256(await readFile(path.join(scenarioDir(id, scenariosRoot), GENERATION_FILE)));
  if (await exists(path.join(snapshotsRoot, id))) {
    return {
      ok: false,
      reason: `A snapshot for ${id} already exists in ${snapshotsRoot}. Snapshots are never overwritten; delete it to regenerate.`,
      checks: [],
      facts: null,
      output: '',
      stageDir: null,
      stageKept: false,
    };
  }

  const before = await repoState();
  await mkdir(workRoot, { recursive: true });
  const stageDir = path.join(workRoot, randomBytes(6).toString('hex'));
  await mkdir(stageDir);

  let stage: StageResult = { ok: false, reason: 'generation did not run', checks: [], facts: null, output: '' };
  try {
    stage = await generateInStage(config, scenariosRoot, stageDir, runPlaywright);
    if ((await repoState()) !== before) {
      stage = { ...stage, ok: false, reason: 'Repository state changed during generation (root artifacts, test-results or git status); snapshot discarded.' };
    }
    if (stage.ok && stage.facts) {
      const snapshot = await writeSnapshot(
        stageDir,
        {
          scenarioId: id,
          generatedAt: now().toISOString(),
          reportFingerprint: stage.facts.list.run.reportFingerprint,
          playwrightVersion: stage.facts.list.run.playwrightVersion ?? 'unknown',
          nodeVersion: process.version,
          platform: process.platform,
          generationConfigSha256,
          stageRoot: stageDir,
          observation: { ok: true, checks: stage.checks },
        },
        snapshotsRoot,
      );
      return { ok: true, snapshot, checks: stage.checks, facts: stage.facts, stageDir, stageKept };
    }
  } catch (error) {
    stage = { ...stage, ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!stageKept) await rm(stageDir, { recursive: true, force: true });
  }
  return { ok: false, reason: stage.reason ?? 'unknown failure', checks: stage.checks, facts: stage.facts, output: stage.output, stageDir, stageKept };
}

type StageResult = { ok: boolean; reason?: string; checks: Check[]; facts: FailureFacts | null; output: string };

async function generateInStage(config: GenerationConfig, scenariosRoot: string, stageDir: string, runPlaywright: RunPlaywright): Promise<StageResult> {
  // Only the declared spec is copied; nothing else from the scenario directory enters the stage.
  const specSource = path.join(scenarioDir(config.id, scenariosRoot), ...config.spec.split('/'));
  await cp(specSource, path.join(stageDir, ...config.spec.split('/')), { preserveTimestamps: true, errorOnExist: true, force: false });
  const configFile = path.join(stageDir, 'playwright.config.ts');
  await writeFile(configFile, stageConfigSource(config), { flag: 'wx' });

  const app = await startApp(config.app);
  let result: PlaywrightResult;
  try {
    result = await runPlaywright({ stageDir, configFile, env: playwrightEnv(process.env, app.url), timeoutMs: PLAYWRIGHT_TIMEOUT_MS });
  } finally {
    await app.close();
  }
  const { output } = result;
  if (result.timedOut) return { ok: false, reason: `Playwright did not finish within ${PLAYWRIGHT_TIMEOUT_MS / 1000}s.`, checks: [], facts: null, output };

  let facts: FailureFacts;
  let reportRoot: string | undefined;
  try {
    const loaded = await loadReport(stageDir);
    reportRoot = loaded.reportRoot;
    const list = listFailures(loaded);
    const details = await Promise.all(list.failures.map((f) => getFailureDetails(loaded, f.testId)));
    facts = { list, details };
  } catch (error) {
    return { ok: false, reason: `Could not read the stage report: ${error instanceof Error ? error.message : String(error)}`, checks: [], facts: null, output };
  }

  const checks = [
    check('report-root', samePath(reportRoot, stageDir), `report root ${reportRoot ?? 'unknown'}`),
    check('playwright-exit', result.exitCode === (config.expectObservation.outcome === 'unexpected' ? 1 : 0), `exit code ${result.exitCode}`),
    ...checkObservation(config, facts),
  ];
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    return { ok: false, reason: `Observation did not match generation.json: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}`, checks, facts, output };
  }
  return { ok: true, checks, facts, output };
}

// ---------------------------------------------------------------------------
// Observation checks (pure)

const check = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail });

/** Checks a stage report (as the MCP layer reads it) against the scenario's expected observation. */
export function checkObservation(config: GenerationConfig, { list, details }: FailureFacts): Check[] {
  const expect = config.expectObservation;
  const checks: Check[] = [check('global-errors', list.globalErrors.count === 0, `${list.globalErrors.count} global error(s)`)];
  const totalTests = list.stats.expected + list.stats.unexpected + list.stats.flaky + list.stats.skipped;

  if (expect.outcome === 'expected') {
    checks.push(check('outcome', list.failureCount === 0 && list.stats.expected > 0, `${list.failureCount} failure(s), ${list.stats.expected} passed`));
    return checks;
  }
  const failure = list.failures[0];
  checks.push(
    check(
      'outcome',
      list.failureCount === 1 && totalTests === 1 && failure?.outcome === expect.outcome,
      `${list.failureCount} failure(s) of ${totalTests} test(s); outcome ${failure?.outcome ?? 'none'}, expected ${expect.outcome}`,
    ),
  );
  const detail = details.find((d) => d.testId === failure?.testId);
  if (!failure || !detail) return [...checks, check('details', false, 'no failure details')];

  const statuses = detail.attempts.map((a) => a.status ?? 'unknown');
  const maxAttempts = config.playwright.retries + 1;
  const attemptsOk =
    expect.outcome === 'unexpected'
      ? statuses.length === maxAttempts && !statuses.includes('passed')
      : statuses.length >= 2 && statuses.length <= maxAttempts && statuses.at(-1) === 'passed';
  checks.push(check('attempts', attemptsOk, `attempts [${statuses.join(', ')}], retries ${config.playwright.retries}`));
  checks.push(check('configured-retries', detail.configuredRetries === config.playwright.retries, `report retries ${detail.configuredRetries}`));

  const failedAttempts = detail.attempts.filter((a) => a.status !== 'passed');
  if (expect.errorPattern !== null) {
    const pattern = new RegExp(expect.errorPattern, 'i');
    const unmatched = failedAttempts.filter((a) => !pattern.test([a.error?.message ?? '', ...a.additionalErrors.map((e) => e.message)].join('\n')));
    checks.push(check('error-pattern', unmatched.length === 0, `/${expect.errorPattern}/i in ${failedAttempts.length - unmatched.length}/${failedAttempts.length} failed attempt(s)`));
  }

  for (const attempt of failedAttempts) {
    const present = attempt.attachments.filter((a) => a.location === 'repo' && a.exists === true).map((a) => a.name);
    const missing = expect.attachments.filter((name) => !present.includes(name));
    checks.push(check(`attachments-retry-${attempt.retry}`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}; present ${present.join(', ') || 'none'}` : `present ${present.join(', ')}`));
    const unresolved = attempt.attachments.filter((a) => a.location !== 'inline' && !(a.location === 'repo' && a.exists === true && a.path?.startsWith('test-results/')));
    checks.push(
      check(
        `attachment-paths-retry-${attempt.retry}`,
        unresolved.length === 0,
        unresolved.length ? unresolved.map((a) => `${a.name}: ${a.location} ${a.issue ?? ''}`.trim()).join('; ') : 'all file attachments resolve under test-results/',
      ),
    );
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Stage config and Playwright process

export function stageConfigSource(config: GenerationConfig): string {
  return `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  retries: ${config.playwright.retries},
  timeout: ${config.playwright.testTimeoutMs},
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
}

/** Inherited env minus variables that would redirect Playwright's reporters or output. */
export function playwrightEnv(env: Record<string, string | undefined>, baseUrl: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^(PLAYWRIGHT_(JSON|HTML|BLOB|JUNIT|LIST)_|PW_TEST_)/.test(name)) continue;
    out[name] = value;
  }
  return { ...out, BASE_URL: baseUrl };
}

/**
 * CLI arguments for one stage run. --output pins the output dir to the stage as well as the config:
 * Playwright's default resolves next to the nearest package.json (the repo root) and is emptied at
 * the start of every run.
 */
export function playwrightArgs(cli: string, run: Pick<PlaywrightRun, 'stageDir' | 'configFile'>): string[] {
  return [cli, 'test', '--config', run.configFile, '--output', path.join(run.stageDir, 'test-results'), '--workers=1'];
}

function spawnPlaywright(repoRoot: string, run: PlaywrightRun): Promise<PlaywrightResult> {
  const cli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, playwrightArgs(cli, run), {
      cwd: run.stageDir,
      env: run.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, run.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut });
    });
  });
}

/**
 * What generation must leave untouched: the root report, root test-results/ and
 * playwright-report/ (paths, sizes, mtimes), and `git status` (tracked and untracked files).
 */
export async function defaultRepoState(repoRoot: string): Promise<string> {
  const parts: string[] = [];
  const report = await readFile(path.join(repoRoot, 'artifacts', 'results.json')).catch(() => null);
  parts.push(`artifacts/results.json:${report ? sha256(report) : 'absent'}`);
  for (const dir of ['test-results', 'playwright-report']) parts.push(`${dir}:${(await listing(path.join(repoRoot, dir))).join(',')}`);
  const { stdout } = await promisify(execFile)('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' });
  parts.push(`git:${stdout}`);
  return parts.join('\n');
}

async function listing(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true }).catch(() => null);
  if (!entries) return ['absent'];
  const out: string[] = [];
  for (const entry of entries.sort()) {
    const info = await stat(path.join(dir, entry));
    out.push(`${entry}|${info.size}|${info.mtimeMs}`);
  }
  return out;
}

function samePath(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (p: string) => path.resolve(p).toLowerCase();
  return process.platform === 'win32' ? norm(a) === norm(b) : path.resolve(a) === path.resolve(b);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}
