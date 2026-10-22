import { randomBytes } from 'node:crypto';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { listFailures, loadReport } from '../mcp/report.ts';
import { defaultRepoState, runStage, spawnPlaywright } from './generate.ts';
import type { PlaywrightResult, RunPlaywright } from './generate.ts';
import { loadGenerationConfig } from './generation.ts';
import { scenarioDir, SCENARIOS_DIR } from './scenarios.ts';
import type { Check } from './snapshots.ts';

// Control runs: a corrected version of a scenario's spec (evals/scenarios/<id>/control/<spec>), run
// against the same fixture behavior and Playwright settings as the scenario. A passing control shows
// the failure comes from what the correction changed (for example a missing wait), not from a broken
// fixture. A control spec is an answer, so it is evaluation-side data: generation never reads it,
// it never enters a stage that becomes a snapshot, and no snapshot or workspace ever contains it.
// No model requests; nothing is stored.

export const CONTROL_DIR = 'control';

export type ControlDeps = {
  repoRoot: string;
  scenariosRoot?: string;
  /** Parent of stage directories. Default `<repoRoot>/.work`. */
  workRoot?: string;
  runPlaywright?: RunPlaywright;
  repoState?: () => Promise<string>;
  keepStage?: boolean;
};

export type ControlOutcome = { ok: boolean; reason: string | null; checks: Check[]; output: string; stageDir: string; stageKept: boolean };

export function controlSpecPath(id: string, spec: string, root: string = SCENARIOS_DIR): string {
  return path.join(scenarioDir(id, root), CONTROL_DIR, ...spec.split('/'));
}

export async function runControl(id: string, deps: ControlDeps): Promise<ControlOutcome> {
  const scenariosRoot = deps.scenariosRoot ?? SCENARIOS_DIR;
  const workRoot = deps.workRoot ?? path.join(deps.repoRoot, '.work');
  const runPlaywright = deps.runPlaywright ?? ((run) => spawnPlaywright(deps.repoRoot, run));
  const repoState = deps.repoState ?? (() => defaultRepoState(deps.repoRoot));
  const stageKept = deps.keepStage === true;

  const config = await loadGenerationConfig(id, scenariosRoot);
  const source = controlSpecPath(id, config.spec, scenariosRoot);
  if (!(await stat(source).catch(() => null))?.isFile()) throw new Error(`Scenario ${id} has no control spec (${CONTROL_DIR}/${config.spec}).`);

  const before = await repoState();
  await mkdir(workRoot, { recursive: true });
  const stageDir = path.join(workRoot, randomBytes(6).toString('hex'));
  await mkdir(stageDir);
  let result: PlaywrightResult = { exitCode: null, output: '', timedOut: false };
  const checks: Check[] = [];
  try {
    await cp(source, path.join(stageDir, ...config.spec.split('/')), { errorOnExist: true, force: false });
    result = await runStage(config, stageDir, runPlaywright);
    checks.push({ name: 'playwright-exit', ok: !result.timedOut && result.exitCode === 0, detail: result.timedOut ? 'timed out' : `exit code ${result.exitCode}` });
    const list = await loadReport(stageDir).then(listFailures, (error: unknown) => {
      checks.push({ name: 'report', ok: false, detail: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (list) {
      const { expected, unexpected, flaky, skipped } = list.stats;
      checks.push({ name: 'passed', ok: expected > 0 && unexpected === 0 && flaky === 0 && skipped === 0, detail: `${expected} passed, ${unexpected} failed, ${flaky} flaky, ${skipped} skipped` });
      checks.push({ name: 'global-errors', ok: list.globalErrors.count === 0, detail: `${list.globalErrors.count} global error(s)` });
    }
    const after = await repoState();
    checks.push({ name: 'repo-state', ok: after === before, detail: after === before ? 'root artifacts, test-results and git status unchanged' : 'repository state changed' });
  } catch (error) {
    checks.push({ name: 'run', ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    if (!stageKept) await rm(stageDir, { recursive: true, force: true });
  }
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    reason: failed.length ? failed.map((c) => `${c.name} (${c.detail})`).join('; ') : null,
    checks,
    output: result.output,
    stageDir,
    stageKept,
  };
}
