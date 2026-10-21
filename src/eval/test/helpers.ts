import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { generateSnapshot } from '../generate.ts';
import type { PlaywrightRun, PlaywrightResult, RunPlaywright } from '../generate.ts';
import { GENERATION_FILE, scenarioDir } from '../scenarios.ts';
import type { LoadedSnapshot } from '../snapshots.ts';

// Offline stand-ins for generation: temp roots and a fake Playwright that writes a synthetic
// JSON report (same shape Playwright 1.64 writes) plus attachment files into the stage.

export async function tempDir(t: TestContext, prefix = 'td-eval-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Copies a real scenario's generation.json and spec (never truth.json) under a temp root as `asId`. */
export async function copyScenario(root: string, fromId: string, asId = fromId, edit?: (config: Record<string, any>) => void): Promise<void> {
  const target = path.join(root, asId);
  await cp(scenarioDir(fromId), target, { recursive: true, preserveTimestamps: true, filter: (src) => path.basename(src) !== 'truth.json' });
  const file = path.join(target, GENERATION_FILE);
  const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
  config.id = asId;
  edit?.(config);
  await writeFile(file, JSON.stringify(config, null, 2));
}

/** A real, verified snapshot of a copied S02 scenario, generated with the fake Playwright. */
export async function fakeSnapshot(t: TestContext, options: FakeRunOptions = {}): Promise<{ snapshot: LoadedSnapshot; base: string; snapshotsRoot: string }> {
  return buildFakeSnapshot(await tempDir(t), options);
}

/** fakeSnapshot under a caller-owned directory (no test context; the caller cleans up). */
export async function buildFakeSnapshot(
  base: string,
  options: FakeRunOptions = {},
  editGeneration?: (config: Record<string, any>) => void,
): Promise<{ snapshot: LoadedSnapshot; base: string; snapshotsRoot: string }> {
  const scenariosRoot = path.join(base, 'scenarios');
  await copyScenario(scenariosRoot, 'S02', 'S02', editGeneration);
  const snapshotsRoot = path.join(base, 'snapshots');
  const outcome = await generateSnapshot('S02', {
    repoRoot: base,
    scenariosRoot,
    snapshotsRoot,
    workRoot: path.join(base, '.work'),
    runPlaywright: fakePlaywright(options),
    repoState: async () => 'unchanged',
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return { snapshot: outcome.snapshot, base, snapshotsRoot };
}

export type FakeRunOptions = {
  /** Status of each attempt; the last decides the test status. Default one failed attempt. */
  attempts?: ('failed' | 'timedOut' | 'passed')[];
  message?: string;
  /** Attachments listed in the report. Default all three. */
  attachments?: ('trace' | 'screenshot' | 'error-context')[];
  /** Attachments listed but whose files are not written. */
  missingFiles?: string[];
  /** Write attachments outside the stage (absolute paths elsewhere). */
  outsideDir?: string;
  retries?: number;
  exitCode?: number;
  timedOut?: boolean;
  throws?: Error;
  /** Extra text appended to error-context.md, e.g. to plant a leak marker. */
  errorContextExtra?: string;
  /** Called during the run, e.g. to probe BASE_URL while the app is up. */
  during?: (run: PlaywrightRun) => Promise<void>;
};

const FILES = { trace: 'trace.zip', screenshot: 'test-failed-1.png', 'error-context': 'error-context.md' } as const;
const LOCATOR_ERROR = { message: "Error: locator.click: Test timeout of 15000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Sign in' })" };
const TYPES = { trace: 'application/zip', screenshot: 'image/png', 'error-context': 'text/markdown' } as const;

export function fakePlaywright(options: FakeRunOptions = {}, runs: PlaywrightRun[] = []): RunPlaywright {
  return async (run: PlaywrightRun): Promise<PlaywrightResult> => {
    runs.push(run);
    await options.during?.(run);
    if (options.throws) throw options.throws;
    const statuses = options.attempts ?? ['failed'];
    const names = options.attachments ?? ['screenshot', 'error-context', 'trace'];
    const resultsDir = path.join(options.outsideDir ?? run.stageDir, 'test-results', 'ui-login-signs-in-chromium');
    await mkdir(resultsDir, { recursive: true });
    const primary = { message: options.message ?? 'Test timeout of 15000ms exceeded.' };
    const results = [];
    for (const [retry, status] of statuses.entries()) {
      const attachments = [];
      if (status !== 'passed') {
        for (const name of names) {
          const file = path.join(resultsDir, retry === 0 ? FILES[name] : `retry${retry}-${FILES[name]}`);
          const body = name === 'error-context' ? `error-context bytes${options.errorContextExtra ?? ''}` : `${name} bytes`;
          if (!options.missingFiles?.includes(name)) await writeFile(file, body);
          attachments.push({ name, contentType: TYPES[name], path: file });
        }
      }
      results.push({
        retry,
        status,
        startTime: new Date(Date.now() + retry).toISOString(),
        duration: 100,
        // Like the real S02 report: `error` is the timeout, errors[0] repeats it, errors[1] is the locator.
        errors: status === 'passed' ? [] : [primary, ...(options.message ? [] : [LOCATOR_ERROR])],
        ...(status === 'passed' ? {} : { error: primary }),
        attachments,
        stdout: [],
        stderr: [],
      });
    }
    const last = statuses.at(-1);
    const testStatus = last === 'passed' ? (statuses.length > 1 ? 'flaky' : 'expected') : 'unexpected';
    const report = {
      config: {
        configFile: run.configFile,
        rootDir: path.join(run.stageDir, 'tests'),
        version: '1.64.1',
        projects: [{ id: 'chromium', name: 'chromium', retries: options.retries ?? 0 }],
      },
      suites: [
        {
          title: 'ui\\login.spec.ts',
          file: 'ui/login.spec.ts',
          specs: [
            {
              title: 'signs in with valid credentials',
              id: 'aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb',
              file: 'ui/login.spec.ts',
              line: 3,
              column: 1,
              tags: [],
              tests: [{ projectId: 'chromium', projectName: 'chromium', expectedStatus: 'passed', status: testStatus, timeout: 15000, results }],
            },
          ],
        },
      ],
      errors: [],
      stats: {
        startTime: new Date().toISOString(),
        duration: 100,
        expected: testStatus === 'expected' ? 1 : 0,
        unexpected: testStatus === 'unexpected' ? 1 : 0,
        flaky: testStatus === 'flaky' ? 1 : 0,
        skipped: 0,
      },
    };
    await mkdir(path.join(run.stageDir, 'artifacts'), { recursive: true });
    await writeFile(path.join(run.stageDir, 'artifacts', 'results.json'), JSON.stringify(report, null, 2));
    return { exitCode: options.exitCode ?? (testStatus === 'unexpected' ? 1 : 0), output: 'fake playwright output', timedOut: options.timedOut ?? false };
  };
}
