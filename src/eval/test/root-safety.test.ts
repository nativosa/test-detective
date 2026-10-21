import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { defaultRepoState, generateSnapshot, playwrightArgs } from '../generate.ts';
import type { RunPlaywright } from '../generate.ts';
import { copyScenario, fakePlaywright, tempDir } from './helpers.ts';

// Regression tests for the first real S02 run, where Playwright's default outputDir pointed at the
// repo-root test-results/. Generation must never write the root artifacts/, test-results/ or
// playwright-report/, and the guard must discard a snapshot if anything there changes.

/** A throwaway git repo shaped like this one: ignored root artifacts plus a committed file. */
async function fakeRepo(t: TestContext): Promise<string> {
  const root = await tempDir(t, 'td-repo-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  await writeFile(path.join(root, '.gitignore'), 'artifacts/\ntest-results/\nplaywright-report/\n');
  await writeFile(path.join(root, 'tracked.ts'), 'export {};\n');
  git('add', '.');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  await mkdir(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'artifacts', 'results.json'), '{"real":"report"}');
  await mkdir(path.join(root, 'test-results'));
  await writeFile(path.join(root, 'test-results', '.last-run.json'), '{"status":"passed","failedTests":[]}');
  return root;
}

describe('root artifact safety', () => {
  test('Playwright is always told to write test-results inside the stage', () => {
    const args = playwrightArgs('cli.js', { stageDir: path.join('S', 'stage'), configFile: path.join('S', 'stage', 'playwright.config.ts') });
    const output = args[args.indexOf('--output') + 1];
    assert.equal(output, path.join('S', 'stage', 'test-results'));
    assert.deepEqual(args.slice(0, 4), ['cli.js', 'test', '--config', path.join('S', 'stage', 'playwright.config.ts')]);
  });

  test('defaultRepoState notices changes to the root report, test-results, playwright-report and git status', async (t) => {
    const root = await fakeRepo(t);
    const base = await defaultRepoState(root);
    assert.equal(await defaultRepoState(root), base, 'stable when nothing changes');

    const changes: [string, () => Promise<void>][] = [
      ['root report rewritten', () => writeFile(path.join(root, 'artifacts', 'results.json'), '{"listing":"only"}')],
      ['test-results file added', () => mkdir(path.join(root, 'test-results', 'ui-x')).then(() => writeFile(path.join(root, 'test-results', 'ui-x', 'trace.zip'), 'z'))],
      ['.last-run.json rewritten', () => writeFile(path.join(root, 'test-results', '.last-run.json'), '{"status":"failed","failedTests":["x"]}')],
      ['playwright-report created', () => mkdir(path.join(root, 'playwright-report')).then(() => writeFile(path.join(root, 'playwright-report', 'index.html'), 'x'))],
      ['tracked file edited', () => writeFile(path.join(root, 'tracked.ts'), 'export const x = 1;\n')],
      ['untracked file added', () => writeFile(path.join(root, 'stray.txt'), 'x')],
    ];
    let previous = base;
    for (const [name, change] of changes) {
      await change();
      const next = await defaultRepoState(root);
      assert.notEqual(next, previous, `${name} is detected`);
      previous = next;
    }
  });

  test('a run that writes into the root test-results/ is discarded by the real guard', async (t) => {
    const repoRoot = await fakeRepo(t);
    const elsewhere = await tempDir(t);
    const scenariosRoot = path.join(elsewhere, 'scenarios');
    await copyScenario(scenariosRoot, 'S02');
    const inner = fakePlaywright();
    // Reproduces the original bug: artifacts land in <repo>/test-results instead of the stage.
    const leaky: RunPlaywright = async (run) => {
      const result = await inner(run);
      await mkdir(path.join(repoRoot, 'test-results', 'ui-login-signs-in-chromium'), { recursive: true });
      await writeFile(path.join(repoRoot, 'test-results', 'ui-login-signs-in-chromium', 'trace.zip'), 'leaked');
      return result;
    };
    const snapshotsRoot = path.join(elsewhere, 'snapshots');
    const outcome = await generateSnapshot('S02', { repoRoot, scenariosRoot, snapshotsRoot, workRoot: path.join(elsewhere, '.work'), runPlaywright: leaky });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /Repository state changed/);
    assert.equal(await stat(path.join(snapshotsRoot, 'S02')).then(() => true, () => false), false, 'no snapshot stored');
  });

  test('a clean run leaves the root report and test-results byte-identical', async (t) => {
    const repoRoot = await fakeRepo(t);
    const elsewhere = await tempDir(t);
    const scenariosRoot = path.join(elsewhere, 'scenarios');
    await copyScenario(scenariosRoot, 'S02');
    const report = await readFile(path.join(repoRoot, 'artifacts', 'results.json'));
    const lastRun = await readFile(path.join(repoRoot, 'test-results', '.last-run.json'));
    const outcome = await generateSnapshot('S02', {
      repoRoot,
      scenariosRoot,
      snapshotsRoot: path.join(elsewhere, 'snapshots'),
      workRoot: path.join(elsewhere, '.work'),
      runPlaywright: fakePlaywright(),
    });
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
    assert.deepEqual(await readFile(path.join(repoRoot, 'artifacts', 'results.json')), report);
    assert.deepEqual(await readFile(path.join(repoRoot, 'test-results', '.last-run.json')), lastRun);
  });
});
