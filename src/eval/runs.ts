import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod';
import { leakMarkers } from './isolation.ts';
import { aggregate, renderSummary, ReviewFile, Summary } from './report.ts';
import type { Scored } from './report.ts';
import { readJson, ScenarioId, SCENARIOS_DIR, scenarioDir, TRUTH_FILE } from './scenarios.ts';
import { ScoreRecord, scoreEvaluation } from './score.ts';
import type { Raw, SnapshotInfo, TruthInput } from './score.ts';
import { loadSnapshot, MANIFEST_FILE, sha256, SNAPSHOTS_DIR } from './snapshots.ts';
import { GroundTruth } from './truth.ts';

// The saved-run format, and the file I/O around the pure scorer (score.ts) and reporter (report.ts).
// Nothing here starts a session, calls a model or runs Playwright: scoring reads saved files only.
//
//   evals/runs/<runId>/
//     run.json                RunManifest   (written by the harness)
//     review.json             ReviewFile    (optional, written by a human reviewer)
//     summary.json, summary.md              (written by `eval report`)
//   <outDir>/summary.json, summary.md       (`eval report --run a --run b --out <outDir>`: several runs)
//     <evalId>/               one evaluated session; evalId = <scenarioId>-<NN>, e.g. S02-01
//       outcome.json          RunOutcome    (written by the harness; required)
//       result.json           InvestigationResult from runInvestigation (when the session finished)
//       transcript.jsonl      every SDK message, one JSON object per line (when a session started)
//       score.json            ScoreRecord   (written by `eval score`; never silently replaced)
//       score-history/        earlier score.json files, archived by `eval score --rescore`

export const RUN_FILE = 'run.json';
export const REVIEW_FILE = 'review.json';
export const SUMMARY_JSON = 'summary.json';
export const SUMMARY_MD = 'summary.md';
export const OUTCOME_FILE = 'outcome.json';
export const RESULT_FILE = 'result.json';
export const TRANSCRIPT_FILE = 'transcript.jsonl';
export const SCORE_FILE = 'score.json';
export const SCORE_HISTORY_DIR = 'score-history';

export const EvalId = z.string().regex(/^S\d{2}-\d{2}$/, 'evaluation IDs look like S02-01');

export const RunManifest = z.strictObject({
  formatVersion: z.literal(1),
  runId: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  createdAt: z.iso.datetime(),
  source: z
    .enum(['live', 'scorer_validation'])
    .describe('scorer_validation: synthetic fixtures scripted to test the scorer; never a measurement of agent performance'),
  description: z.string(),
});
export type RunManifest = z.infer<typeof RunManifest>;

export const HARNESS_STATUSES = [
  /** runInvestigation returned; result.json holds its InvestigationResult, whatever its runStatus. */
  'session_finished',
  /** Snapshot loading, workspace creation or its audit failed; no session was started. */
  'setup_failed',
  /** The evaluation harness itself failed around the session. */
  'harness_error',
] as const;

/** An absent value (e.g. no env on the baseline MCP server) is dropped by JSON, hence optional. */
const OptionDifference = z.strictObject({ path: z.string(), baseline: z.unknown().optional(), evaluation: z.unknown().optional() });

export const RunOutcome = z
  .strictObject({
    formatVersion: z.literal(1),
    evalId: EvalId,
    scenarioId: ScenarioId,
    attempt: z.number().int().min(1).max(99),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    harness: z.strictObject({ status: z.enum(HARNESS_STATUSES), detail: z.string().nullable() }),
    args: z.record(z.string(), z.unknown()).describe('The CliArgs the session ran with (informational)'),
    snapshot: z
      .strictObject({
        reportFingerprint: z.string().regex(/^[0-9a-f]{12}$/),
        manifestSha256: z.string().regex(/^[0-9a-f]{64}$/).describe('sha256 of the snapshot manifest.json bytes the workspace was made from'),
      })
      .nullable(),
    workspace: z
      .strictObject({
        root: z.string().min(1).describe('The session cwd (deleted after the run; kept for the path audit)'),
        protectedRoots: z.array(z.string().min(1)),
        auditBefore: z.strictObject({ ok: z.boolean(), problems: z.array(z.string()) }),
        integrityAfter: z.array(z.string()).nullable().describe('checkIntegrity problems after the session; [] = unchanged, null = not checked'),
      })
      .nullable(),
    preflight: z
      .strictObject({
        capturedAt: z.iso.datetime().nullable(),
        truthSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().describe('truth.json captured before the session; scoring requires the same truth'),
        skillSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
        settingsSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
        sdkVersion: z.string().nullable(),
        mcpServerVersion: z.string().nullable().optional().describe('test-detective MCP server version (src/mcp/server.ts); absent in runs saved before Stage 3.4'),
        nodeVersion: z.string(),
        session: z.record(z.string(), z.unknown()).nullable().describe('Sanitized evaluation session options (no env values)'),
      })
      .describe('Captured before the session started'),
    repo: z
      .strictObject({ unchanged: z.boolean().nullable().describe('Repo state (root artifacts, test-results, git status) equal before and after; null = not checked') })
      .describe('Detection only: the agent must not modify the project'),
    cleanup: z
      .strictObject({
        removed: z.boolean(),
        error: z.string().nullable(),
        // Absent in runs saved before bounded cleanup (removeWorkspace's Removal).
        attempts: z.number().int().min(0).optional(),
        elapsedMs: z.number().min(0).optional(),
        transient: z.array(z.string()).optional().describe('Errors of attempts that were retried (EBUSY/EPERM/ENOTEMPTY) before success or the deadline'),
      })
      .describe('Whether the temporary workspace was removed'),
    configDifferences: z
      .strictObject({
        baseline: z.string(),
        options: z.array(OptionDifference),
        environment: z.array(z.strictObject({ id: z.string(), baseline: z.string(), evaluation: z.string() })),
      })
      .nullable()
      .describe('describeDifferences() output for this session'),
  })
  .superRefine((o, ctx) => {
    if (o.evalId !== `${o.scenarioId}-${String(o.attempt).padStart(2, '0')}`) {
      ctx.addIssue({ code: 'custom', path: ['evalId'], message: `evalId must be ${o.scenarioId}-${String(o.attempt).padStart(2, '0')}` });
    }
    if (o.harness.status === 'session_finished' && (!o.snapshot || !o.workspace || !o.configDifferences)) {
      ctx.addIssue({ code: 'custom', path: ['harness'], message: 'a finished session records its snapshot, workspace and configDifferences' });
    }
  });
export type RunOutcome = z.infer<typeof RunOutcome>;

// ---------------------------------------------------------------------------
// Loading

/** Evaluation directories in a run, sorted. Anything not named like an evalId is ignored. */
export async function listEvaluations(runDir: string): Promise<string[]> {
  const entries = await readdir(runDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && EvalId.safeParse(e.name).success).map((e) => e.name).sort();
}

export async function loadRunManifest(runDir: string): Promise<RunManifest> {
  const file = path.join(runDir, RUN_FILE);
  if (!(await exists(file))) throw new Error(`${runDir} has no ${RUN_FILE}; it is not a saved evaluation run.`);
  const parsed = RunManifest.safeParse(await readJson(file));
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

async function readRaw(file: string): Promise<Raw<string>> {
  try {
    return { state: 'ok', value: await readFile(file, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

function parseJsonRaw(raw: Raw<string>): Raw<unknown> {
  if (raw.state !== 'ok') return raw;
  try {
    return { state: 'ok', value: JSON.parse(raw.value) };
  } catch (error) {
    return { state: 'unreadable', error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseTranscript(raw: Raw<string>): Raw<SDKMessage[]> {
  if (raw.state !== 'ok') return raw;
  const messages: SDKMessage[] = [];
  for (const [i, line] of raw.value.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') {
        return { state: 'unreadable', error: `line ${i + 1} is not an SDK message` };
      }
      messages.push(value as SDKMessage);
    } catch {
      return { state: 'unreadable', error: `line ${i + 1} is not valid JSON` };
    }
  }
  return { state: 'ok', value: messages };
}

/** Snapshot facts the scorer needs, after full verification (hashes, mtimes, report fingerprint). */
export async function snapshotInfo(id: string, snapshotsRoot: string): Promise<SnapshotInfo> {
  try {
    const snapshot = await loadSnapshot(id, snapshotsRoot);
    return {
      ok: true,
      fingerprint: snapshot.manifest.reportFingerprint,
      manifestSha256: sha256(await readFile(path.join(snapshot.dir, MANIFEST_FILE))),
      files: snapshot.manifest.files.map((f) => f.path),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function truthInput(id: string, scenariosRoot: string): Promise<TruthInput> {
  try {
    const file = path.join(scenarioDir(id, scenariosRoot), TRUTH_FILE);
    const text = await readFile(file, 'utf8');
    const parsed = GroundTruth.safeParse(JSON.parse(text));
    if (!parsed.success) return { ok: false, error: `${file} is invalid:\n${z.prettifyError(parsed.error)}` };
    return { ok: true, value: parsed.data, sha256: sha256(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Commands

export type ScoreDeps = {
  scenariosRoot?: string;
  snapshotsRoot?: string;
  /** Replace scores that differ from a fresh scoring (e.g. truth.json changed); the old files are archived. */
  rescore?: boolean;
};

/** A stored score that a fresh scoring would change, and why. */
export type ScoreChange = { evalId: string; reasons: string[] };

export class ScoreConflictError extends Error {
  readonly changes: ScoreChange[];
  constructor(changes: ScoreChange[]) {
    super(
      `${changes.length} stored score(s) would change:\n${changes.map((c) => `  ${c.evalId}: ${c.reasons.join('; ')}`).join('\n')}\n` +
        'Nothing was written. Re-run with --rescore to replace them; the current score.json files are archived under <evalId>/score-history/ and reviews of them become stale.',
    );
    this.name = 'ScoreConflictError';
    this.changes = changes;
  }
}

/**
 * Scores every evaluation in a saved run and writes `<evalId>/score.json`. Deterministic: the same
 * saved files, truth and snapshots always produce byte-identical score files. A stored score is
 * never silently replaced: if fresh scoring differs (truth.json changed, scorer version changed,
 * saved inputs changed), nothing is written unless `rescore` is set, and then the old file is
 * archived first. Reviews refer to a score by hash, so they are preserved and become stale.
 */
export async function scoreRun(runDir: string, deps: ScoreDeps = {}): Promise<{ records: ScoreRecord[]; rescored: ScoreChange[] }> {
  const scenariosRoot = deps.scenariosRoot ?? SCENARIOS_DIR;
  const snapshotsRoot = deps.snapshotsRoot ?? SNAPSHOTS_DIR;
  await loadRunManifest(runDir);
  const evalIds = await listEvaluations(runDir);
  if (evalIds.length === 0) throw new Error(`${runDir} contains no evaluation directories (named like S02-01).`);
  const markers = await leakMarkers(scenariosRoot);
  const snapshots = new Map<string, Promise<SnapshotInfo>>();
  const truths = new Map<string, Promise<TruthInput>>();
  const fresh: { evalId: string; record: ScoreRecord; text: string; previous: string | null }[] = [];
  for (const evalId of evalIds) {
    const dir = path.join(runDir, evalId);
    const scenarioId = evalId.slice(0, 3);
    if (!snapshots.has(scenarioId)) snapshots.set(scenarioId, snapshotInfo(scenarioId, snapshotsRoot));
    if (!truths.has(scenarioId)) truths.set(scenarioId, truthInput(scenarioId, scenariosRoot));
    const [outcomeRaw, resultRaw, transcriptRaw, previousRaw] = await Promise.all([
      readRaw(path.join(dir, OUTCOME_FILE)),
      readRaw(path.join(dir, RESULT_FILE)),
      readRaw(path.join(dir, TRANSCRIPT_FILE)),
      readRaw(path.join(dir, SCORE_FILE)),
    ]);
    const outcomeJson = parseJsonRaw(outcomeRaw);
    const parsedOutcome = outcomeJson.state === 'ok' ? RunOutcome.safeParse(outcomeJson.value) : null;
    const record = scoreEvaluation({
      evalId,
      outcome:
        outcomeJson.state !== 'ok'
          ? { ok: false, error: outcomeJson.state === 'missing' ? `${OUTCOME_FILE} is missing` : `${OUTCOME_FILE}: ${outcomeJson.error}` }
          : parsedOutcome!.success
            ? { ok: true, value: parsedOutcome!.data }
            : { ok: false, error: `${OUTCOME_FILE} is invalid: ${z.prettifyError(parsedOutcome!.error)}` },
      result: parseJsonRaw(resultRaw),
      resultSha256: resultRaw.state === 'ok' ? sha256(resultRaw.value) : null,
      transcript: parseTranscript(transcriptRaw),
      transcriptSha256: transcriptRaw.state === 'ok' ? sha256(transcriptRaw.value) : null,
      truth: await truths.get(scenarioId)!,
      snapshot: await snapshots.get(scenarioId)!,
      markers,
    });
    fresh.push({ evalId, record, text: serialize(record), previous: previousRaw.state === 'ok' ? previousRaw.value : null });
  }

  const changes = fresh.filter((f) => f.previous !== null && f.previous !== f.text).map((f) => ({ evalId: f.evalId, reasons: changeReasons(f.previous!, f.record) }));
  if (changes.length > 0 && !deps.rescore) throw new ScoreConflictError(changes);
  for (const f of fresh) {
    const dir = path.join(runDir, f.evalId);
    if (f.previous !== null && f.previous !== f.text) await archiveScore(dir, f.previous);
    if (f.previous !== f.text) await writeFile(path.join(dir, SCORE_FILE), f.text);
  }
  return { records: fresh.map((f) => f.record), rescored: changes };
}

/** Why a stored score differs from a fresh one, most important first. */
function changeReasons(previousText: string, next: ScoreRecord): string[] {
  let previous: { scorerVersion?: unknown; inputs?: Record<string, unknown>; category?: unknown; audit?: { verdict?: unknown } };
  try {
    previous = JSON.parse(previousText) as typeof previous;
  } catch {
    return ['the stored score.json is not valid JSON'];
  }
  const reasons: string[] = [];
  const was = previous.inputs ?? {};
  if (was.truthSha256 !== next.inputs.truthSha256) {
    reasons.push(`truth.json changed (scored with ${String(was.truthSha256 ?? 'unknown').slice(0, 12)}, current ${String(next.inputs.truthSha256 ?? 'unavailable').slice(0, 12)})`);
  }
  if (previous.scorerVersion !== next.scorerVersion) reasons.push(`scorer version changed (${String(previous.scorerVersion)} -> ${next.scorerVersion})`);
  for (const k of ['snapshotFingerprint', 'resultSha256', 'transcriptSha256'] as const) {
    if (was[k] !== next.inputs[k]) reasons.push(`saved input ${k} changed`);
  }
  if (reasons.length === 0) reasons.push('the scoring output changed with the same inputs (scorer logic changed without a version bump?)');
  // What the change does to the verdict, so a --rescore decision is informed.
  if (previous.category !== next.category) reasons.push(`category ${String(previous.category)} -> ${next.category}`);
  if (previous.audit?.verdict !== next.audit.verdict) reasons.push(`audit ${String(previous.audit?.verdict)} -> ${next.audit.verdict}`);
  return reasons;
}

/** Keeps a replaced score: score-history/score.v<scorer>.truth-<sha12>.<content sha8>.json, never overwritten. */
async function archiveScore(dir: string, text: string): Promise<void> {
  let label = 'unknown';
  try {
    const old = JSON.parse(text) as { scorerVersion?: number; inputs?: { truthSha256?: string | null } };
    label = `v${old.scorerVersion ?? '?'}.truth-${(old.inputs?.truthSha256 ?? 'none').slice(0, 12)}`;
  } catch {
    // Keep unparsable files too.
  }
  const history = path.join(dir, SCORE_HISTORY_DIR);
  await mkdir(history, { recursive: true });
  const file = path.join(history, `score.${label}.${sha256(text).slice(0, 8)}.json`);
  if (!(await exists(file))) await writeFile(file, text, { flag: 'wx' });
}

/** Aggregates the score files (and review.json, if present) into summary.json and summary.md. */
export async function reportRun(runDir: string): Promise<{ summary: Summary; markdown: string }> {
  const { manifest, scores, reviews } = await loadScoredRun(runDir);
  return writeSummary(runDir, aggregate(manifest, scores, reviews));
}

/**
 * One summary over several scored runs, written to `outDir` (summary.json and summary.md only).
 * Reads score.json and review.json files and never writes into a source run. Refuses runs with
 * different `source` labels (a scorer-validation fixture must never be counted as agent
 * performance), evaluation IDs that occur in more than one run, and a review that names an
 * evaluation of another run. `outDir` must not be a run, inside one or contain one; its name is
 * the summary's runId.
 */
export async function reportCombined(runDirs: string[], outDir: string): Promise<{ summary: Summary; markdown: string }> {
  const dirs = runDirs.map((d) => path.resolve(d));
  const out = path.resolve(outDir);
  if (dirs.length < 2) throw new Error('a combined report needs at least two runs; use "report --run <dir>" for one');
  if (new Set(dirs.map(key)).size !== dirs.length) throw new Error('the same run directory is listed twice');
  for (const dir of dirs) {
    if (isWithin(key(dir), key(out)) || isWithin(key(out), key(dir))) throw new Error(`--out ${out} overlaps the source run ${dir}; choose a separate directory`);
  }
  const runId = path.basename(out);
  if (!RunManifest.shape.runId.safeParse(runId).success) throw new Error(`--out directory name ${JSON.stringify(runId)} is not a valid run ID (letters, digits, . _ -)`);
  if (await exists(out)) {
    const extra = (await readdir(out)).filter((f) => f !== SUMMARY_JSON && f !== SUMMARY_MD);
    if (extra.length > 0) throw new Error(`--out ${out} already contains ${extra.join(', ')}; it may only hold a previous combined summary`);
  }

  const runs = await Promise.all(dirs.map(loadScoredRun));
  const sources = [...new Set(runs.map((r) => r.manifest.source))];
  if (sources.length > 1) throw new Error(`runs have different sources (${sources.join(', ')}); scorer-validation fixtures and live runs are never combined`);
  const owner = new Map<string, string>();
  for (const { manifest, scores } of runs) {
    for (const { record } of scores) {
      const other = owner.get(record.evalId);
      if (other) throw new Error(`${record.evalId} occurs in both ${other} and ${manifest.runId}; evaluation IDs must be unique across combined runs`);
      owner.set(record.evalId, manifest.runId);
    }
  }
  const reviews: ReviewFile['reviews'] = [];
  for (const { manifest, reviews: file } of runs) {
    for (const r of file?.reviews ?? []) {
      if (owner.get(r.evalId) !== manifest.runId) throw new Error(`${manifest.runId}/${REVIEW_FILE} reviews ${r.evalId}, which is not an evaluation of that run`);
      reviews.push(r);
    }
  }
  const scores = runs.flatMap(({ manifest, scores }) => scores.map((s) => ({ ...s, runId: manifest.runId })));
  const manifest: RunManifest = {
    formatVersion: 1,
    runId,
    createdAt: runs.map((r) => r.manifest.createdAt).sort().at(-1)!,
    source: sources[0]!,
    description: `Combined report of ${runs.map((r) => r.manifest.runId).join(', ')}`,
  };
  const summary = aggregate(manifest, scores, reviews.length > 0 ? { formatVersion: 1, reviews } : null);
  await mkdir(out, { recursive: true });
  return writeSummary(out, summary);
}

async function writeSummary(dir: string, summary: Summary): Promise<{ summary: Summary; markdown: string }> {
  const markdown = renderSummary(summary);
  await writeFile(path.join(dir, SUMMARY_JSON), serialize(summary));
  await writeFile(path.join(dir, SUMMARY_MD), `${markdown}\n`);
  return { summary, markdown };
}

const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function loadScoredRun(runDir: string): Promise<{ manifest: RunManifest; scores: Scored[]; reviews: ReviewFile | null }> {
  const manifest = await loadRunManifest(runDir);
  const evalIds = await listEvaluations(runDir);
  if (evalIds.length === 0) throw new Error(`${runDir} contains no evaluation directories (named like S02-01).`);
  const scores: Scored[] = [];
  for (const evalId of evalIds) {
    const file = path.join(runDir, evalId, SCORE_FILE);
    if (!(await exists(file))) throw new Error(`${evalId} has no ${SCORE_FILE}; run "npm run eval -- score --run ${runDir}" first.`);
    const text = await readFile(file, 'utf8');
    const parsed = ScoreRecord.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
    if (parsed.data.evalId !== evalId) throw new Error(`${file} belongs to ${parsed.data.evalId}, not ${evalId}.`);
    scores.push({ record: parsed.data, sha256: sha256(text), skillSha256: await recordedSkill(path.join(runDir, evalId, OUTCOME_FILE)) });
  }
  let reviews: ReviewFile | null = null;
  const reviewFile = path.join(runDir, REVIEW_FILE);
  if (await exists(reviewFile)) {
    const parsed = ReviewFile.safeParse(await readJson(reviewFile));
    if (!parsed.success) throw new Error(`${reviewFile} is invalid:\n${z.prettifyError(parsed.error)}`);
    reviews = parsed.data;
  }
  return { manifest, scores, reviews };
}

/** The Skill hash the harness captured before the session, or null if outcome.json does not record one. */
async function recordedSkill(file: string): Promise<string | null> {
  const raw = parseJsonRaw(await readRaw(file));
  if (raw.state !== 'ok') return null;
  const parsed = RunOutcome.safeParse(raw.value);
  return parsed.success ? parsed.data.preflight.skillSha256 : null;
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}
