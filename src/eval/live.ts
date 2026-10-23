import { appendFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseCliArgs } from '../agent/args.ts';
import type { CliArgs } from '../agent/args.ts';
import type { InvestigationResult } from '../agent/result.ts';
import { runInvestigation } from '../agent/run.ts';
import type { QueryFn } from '../agent/run.ts';
import { SERVER_VERSION } from '../mcp/server.ts';
import { defaultRepoState } from './generate.ts';
import { describeDifferences, evalQuery, leakMarkers, sessionOptions } from './isolation.ts';
import type { IsolationContext } from './isolation.ts';
import { EvalId, listEvaluations, loadRunManifest, OUTCOME_FILE, RESULT_FILE, reportRun, RUN_FILE, RunManifest, RunOutcome, scoreRun, serialize, TRANSCRIPT_FILE } from './runs.ts';
import { ScenarioId, SCENARIOS_DIR, scenarioDir, TRUTH_FILE } from './scenarios.ts';
import type { ScoreRecord } from './score.ts';
import { loadSnapshot, MANIFEST_FILE, sha256, SNAPSHOTS_DIR } from './snapshots.ts';
import { loadGroundTruth } from './truth.ts';
import { checkIntegrity, CONFIG_FILES, createWorkspace, removeWorkspace, WorkspaceRemovalError } from './workspace.ts';
import type { RemovalOptions, Workspace } from './workspace.ts';

// Live evaluation adapter: ONE scenario per invocation, one session, no retries.
//
//   preflight (truth hash, verified snapshot, Skill/settings hashes, session options)
//   -> fresh workspace (workspace.ts) -> runInvestigation (unchanged) via evalQuery (isolation.ts),
//      every SDK message appended to transcript.jsonl as it arrives
//   -> workspace integrity + repo state check -> workspace removed (always)
//   -> outcome.json / result.json saved -> offline score + report (runs.ts)
//
// With the real SDK this makes model requests on the user's account. Tests inject `query`.

export const RUNS_DIR = fileURLToPath(new URL('../../evals/runs/', import.meta.url));
/** Evaluation-specific ceiling, below the CLI's own --max-budget-usd limit (100). */
export const EVAL_MAX_BUDGET_USD = 2;

export const LIVE_USAGE = `Usage: npm run eval -- live --scenario <id> --max-budget-usd <n> [options]

Runs ONE live investigation of one scenario's snapshot with the Claude Agent SDK, saves it as a
run, then scores and reports it offline. This makes real model requests on your account.
No retries; there is no --all.

  --scenario <id>         Exactly one scenario ID, e.g. S02 (required)
  --max-budget-usd <n>    Required. The session stops when the SDK's estimated cost exceeds n.
                          At most ${EVAL_MAX_BUDGET_USD}.
  --max-turns <n>         Maximum agent turns, 1-100 (default 30)
  --timeout <seconds>     Wall-clock limit, 10-3600 (default 300)
  --model <id>            Model ID or alias (default: your account's default)
  --auth <mode>           subscription (default) or api, with the same checks as npm run investigate
  --run <dir>             Add this attempt to an existing live run directory (default: a new run
                          under evals/runs/)`;

export class LiveRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveRefusal';
  }
}

export type LiveRequest = { scenarioId: string; args: CliArgs; runDir: string | null };

/** Validates `eval live` arguments. Limits and auth modes come from the production CLI parser. */
export function parseLiveArgs(argv: string[]): { kind: 'run'; request: LiveRequest } | { kind: 'help' } | { kind: 'error'; message: string } {
  if (argv.some((a) => a === '--all' || a.startsWith('--all='))) return { kind: 'error', message: 'there is no --all: live evaluation runs exactly one scenario per invocation' };
  let values: Record<string, string | string[] | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        scenario: { type: 'string', multiple: true },
        'max-budget-usd': { type: 'string' },
        'max-turns': { type: 'string' },
        timeout: { type: 'string' },
        model: { type: 'string' },
        auth: { type: 'string' },
        run: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  if (values.help) return { kind: 'help' };
  if (positionals.length > 0) return { kind: 'error', message: `unexpected argument(s): ${positionals.join(' ')} (one --scenario only)` };
  const scenarios = (values.scenario as string[] | undefined) ?? [];
  if (scenarios.length !== 1) return { kind: 'error', message: `exactly one --scenario is required, got ${scenarios.length}` };
  const scenarioId = scenarios[0]!;
  if (!ScenarioId.safeParse(scenarioId).success) return { kind: 'error', message: `--scenario must be one scenario ID like S02, got ${JSON.stringify(scenarioId)}` };
  if (values['max-budget-usd'] === undefined) return { kind: 'error', message: '--max-budget-usd is required for a live evaluation' };

  const cli: string[] = ['--max-budget-usd', values['max-budget-usd'] as string];
  for (const [flag, key] of [['--max-turns', 'max-turns'], ['--timeout', 'timeout'], ['--model', 'model'], ['--auth', 'auth']] as const) {
    if (values[key] !== undefined) cli.push(flag, values[key] as string);
  }
  const parsed = parseCliArgs(cli);
  if (parsed.kind === 'error') return { kind: 'error', message: parsed.message };
  if (parsed.kind === 'help') return { kind: 'help' };
  try {
    assertLimits(parsed.args);
  } catch (error) {
    return { kind: 'error', message: (error as Error).message };
  }
  return { kind: 'run', request: { scenarioId, args: parsed.args, runDir: (values.run as string | undefined) ?? null } };
}

/** Refuses a session without an explicit budget within the evaluation ceiling, or with a test filter. */
export function assertLimits(args: CliArgs): void {
  if (args.maxBudgetUsd === null) throw new LiveRefusal('--max-budget-usd is required for a live evaluation');
  if (args.maxBudgetUsd > EVAL_MAX_BUDGET_USD) throw new LiveRefusal(`--max-budget-usd ${args.maxBudgetUsd} exceeds the evaluation limit of ${EVAL_MAX_BUDGET_USD}`);
  if (args.filter !== null) throw new LiveRefusal('a live evaluation investigates the whole snapshot; --test is not allowed');
}

// ---------------------------------------------------------------------------

export type LiveDeps = {
  repoRoot: string;
  scenariosRoot?: string;
  snapshotsRoot?: string;
  runsRoot?: string;
  /** Where workspaces are created. Default os.tmpdir(). */
  workParent?: string;
  /**
   * The SDK query. Default: the real SDK. Tests inject fake streams. Called at most once.
   * A run made with an injected query is labelled scorer_validation, never live.
   */
  query?: QueryFn;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  now?: () => Date;
  /** Repo state fingerprint before/after the session (default: root artifacts, test-results, git status). */
  repoState?: () => Promise<string>;
  sdkVersion?: string | null;
  /** Workspace removal deadline and fs seams (tests). Default: removeWorkspace's own. */
  removal?: RemovalOptions;
};

export type LiveResult = {
  runDir: string;
  evalId: string;
  outcome: RunOutcome;
  result: InvestigationResult | null;
  transcriptMessages: number;
  score: ScoreRecord | null;
  summaryMarkdown: string | null;
  scoreError: string | null;
};

export async function runLiveEvaluation(request: LiveRequest, deps: LiveDeps): Promise<LiveResult> {
  const { args } = request;
  assertLimits(args);
  const scenarioId = ScenarioId.parse(request.scenarioId);
  const scenariosRoot = deps.scenariosRoot ?? SCENARIOS_DIR;
  const snapshotsRoot = deps.snapshotsRoot ?? SNAPSHOTS_DIR;
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const repoState = deps.repoState ?? (() => defaultRepoState(deps.repoRoot));

  // Only the real SDK produces a live (agent-performance) run; anything injected is scorer validation.
  const source: RunManifest['source'] = deps.query === undefined ? 'live' : 'scorer_validation';
  const { runDir, attempt } = await prepareRun(request, source, deps.runsRoot ?? RUNS_DIR, now());
  const evalId = EvalId.parse(`${scenarioId}-${String(attempt).padStart(2, '0')}`);
  const evalDir = path.join(runDir, evalId);
  await mkdir(evalDir);

  const outcome: RunOutcome = {
    formatVersion: 1,
    evalId,
    scenarioId,
    attempt,
    startedAt: now().toISOString(),
    finishedAt: now().toISOString(),
    harness: { status: 'setup_failed', detail: 'setup did not complete' },
    args,
    preflight: { capturedAt: null, truthSha256: null, skillSha256: null, settingsSha256: null, sdkVersion: null, mcpServerVersion: null, nodeVersion: process.version, session: null },
    snapshot: null,
    workspace: null,
    repo: { unchanged: null },
    cleanup: { removed: true, error: null },
    configDifferences: null,
  };
  let workspace: Workspace | null = null;
  let result: InvestigationResult | null = null;
  let transcriptMessages = 0;
  let phase: 'setup' | 'session' | 'after' = 'setup';

  try {
    // Preflight: everything the score depends on is fixed before the session starts.
    const truthText = await readFile(path.join(scenarioDir(scenarioId, scenariosRoot), TRUTH_FILE), 'utf8');
    await loadGroundTruth(scenarioId, scenariosRoot);
    outcome.preflight.truthSha256 = sha256(truthText);
    outcome.preflight.capturedAt = now().toISOString();
    outcome.preflight.sdkVersion = deps.sdkVersion !== undefined ? deps.sdkVersion : await installedSdkVersion(deps.repoRoot);
    outcome.preflight.mcpServerVersion = SERVER_VERSION;
    const [skill, settings] = await Promise.all(CONFIG_FILES.map((rel) => readFile(path.join(deps.repoRoot, ...rel.split('/')))));
    outcome.preflight.skillSha256 = sha256(skill!);
    outcome.preflight.settingsSha256 = sha256(settings!);

    const snapshot = await loadSnapshot(scenarioId, snapshotsRoot);
    outcome.snapshot = { reportFingerprint: snapshot.manifest.reportFingerprint, manifestSha256: sha256(await readFile(path.join(snapshot.dir, MANIFEST_FILE))) };
    const markers = await leakMarkers(scenariosRoot);
    workspace = await createWorkspace(snapshot, { repoRoot: deps.repoRoot, parent: deps.workParent }, markers);
    outcome.workspace = { root: workspace.root, protectedRoots: workspace.protectedRoots, auditBefore: { ok: true, problems: [] }, integrityAfter: null };
    const context: IsolationContext = { repoRoot: deps.repoRoot, workspace };
    outcome.configDifferences = describeDifferences(args, context, env);
    outcome.preflight.session = sanitizeOptions(sessionOptions(args, context, env).evaluation);
    const before = await repoState();

    // The session: exactly one runInvestigation call, never retried. Every message is appended as
    // it arrives, so a crash or interruption still leaves the partial transcript.
    phase = 'session';
    const transcriptFile = path.join(evalDir, TRANSCRIPT_FILE);
    await writeFile(transcriptFile, '');
    const record = (message: SDKMessage) => {
      appendFileSync(transcriptFile, `${JSON.stringify(message)}\n`);
      transcriptMessages++;
    };
    try {
      result = await runInvestigation(args, { repoRoot: workspace.root, query: evalQuery(deps.query ?? (sdkQuery as QueryFn), context, record), env, signal: deps.signal });
      outcome.harness = { status: 'session_finished', detail: null };
    } catch (error) {
      outcome.harness = { status: 'harness_error', detail: `runInvestigation threw: ${message(error)}` };
    }

    phase = 'after';
    outcome.workspace.integrityAfter = await checkIntegrity(workspace);
    outcome.repo.unchanged = (await repoState()) === before;
  } catch (error) {
    outcome.harness =
      phase === 'setup'
        ? { status: 'setup_failed', detail: message(error) }
        : { status: 'harness_error', detail: `${outcome.harness.status === 'session_finished' ? 'after the session' : 'during the session'}: ${message(error)}` };
  } finally {
    if (workspace) {
      // close() does not wait for the CLI and its MCP server to exit; removeWorkspace allows them
      // a bounded grace period and records every retried attempt (see REMOVAL_DEADLINE_MS).
      try {
        outcome.cleanup = { removed: true, error: null, ...(await removeWorkspace(workspace, deps.removal)) };
      } catch (error) {
        outcome.cleanup = { removed: false, error: message(error), ...(error instanceof WorkspaceRemovalError ? error.removal : {}) };
      }
    }
    outcome.finishedAt = now().toISOString();
    await writeFile(path.join(evalDir, OUTCOME_FILE), serialize(RunOutcome.parse(outcome)));
    if (result) await writeFile(path.join(evalDir, RESULT_FILE), serialize(result));
  }

  // Offline scoring of the saved files. A scoring problem never loses the saved run.
  let score: ScoreRecord | null = null;
  let summaryMarkdown: string | null = null;
  let scoreError: string | null = null;
  try {
    const { records } = await scoreRun(runDir, { scenariosRoot, snapshotsRoot });
    score = records.find((r) => r.evalId === evalId) ?? null;
    summaryMarkdown = (await reportRun(runDir)).markdown;
  } catch (error) {
    scoreError = message(error);
  }
  return { runDir, evalId, outcome, result, transcriptMessages, score, summaryMarkdown, scoreError };
}

/** A new live run directory, or the next attempt number in an existing one. */
async function prepareRun(request: LiveRequest, source: RunManifest['source'], runsRoot: string, now: Date): Promise<{ runDir: string; attempt: number }> {
  if (request.runDir) {
    const runDir = path.resolve(request.runDir);
    const manifest = await loadRunManifest(runDir);
    if (manifest.source !== source) throw new LiveRefusal(`${runDir} is a ${manifest.source} run; this attempt is ${source} and cannot be mixed into it`);
    const attempts = (await listEvaluations(runDir)).filter((id) => id.startsWith(`${request.scenarioId}-`)).map((id) => Number(id.slice(4)));
    const attempt = Math.max(0, ...attempts) + 1;
    if (attempt > 99) throw new LiveRefusal(`${runDir} already has 99 attempts of ${request.scenarioId}`);
    return { runDir, attempt };
  }
  const runId = `${source === 'live' ? 'live' : 'validation'}-${request.scenarioId}-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const runDir = path.join(runsRoot, runId);
  if (await stat(runDir).then(() => true, () => false)) throw new LiveRefusal(`${runDir} already exists`);
  await mkdir(runDir, { recursive: true });
  const description =
    source === 'live'
      ? `Live evaluation of ${request.scenarioId}`
      : `Adapter run of ${request.scenarioId} with an injected (fake) SDK query: scorer validation, not agent performance`;
  const manifest: RunManifest = { formatVersion: 1, runId, createdAt: now.toISOString(), source, description };
  await writeFile(path.join(runDir, RUN_FILE), serialize(RunManifest.parse(manifest)), { flag: 'wx' });
  return { runDir, attempt: 1 };
}

/**
 * The evaluation session options as metadata: no env values (only the count), no abort controller,
 * and the long output schema and system prompt append replaced by their hashes.
 */
export function sanitizeOptions(options: Options): Record<string, unknown> {
  const { abortController: _abort, env, outputFormat, systemPrompt, ...rest } = options;
  const prompt = systemPrompt && typeof systemPrompt === 'object' && 'append' in systemPrompt ? systemPrompt : null;
  return JSON.parse(
    JSON.stringify({
      ...rest,
      envVariableCount: env ? Object.keys(env).length : 0,
      outputFormatSha256: outputFormat ? sha256(JSON.stringify(outputFormat)) : null,
      systemPrompt: prompt ? { type: prompt.type, preset: prompt.preset, appendSha256: sha256(prompt.append ?? '') } : systemPrompt,
    }),
  ) as Record<string, unknown>;
}

async function installedSdkVersion(repoRoot: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
