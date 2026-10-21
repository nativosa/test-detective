import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { aggregate, applyReview, renderSummary, ReviewFile, Summary } from '../report.ts';
import type { Review } from '../report.ts';
import { loadRunManifest, REVIEW_FILE, reportCombined, reportRun, SCORE_FILE, SCORE_HISTORY_DIR, scoreRun, serialize, SUMMARY_JSON, SUMMARY_MD } from '../runs.ts';
import { SCENARIOS_DIR } from '../scenarios.ts';
import { SCORER_VERSION, ScoreRecord } from '../score.ts';
import { sha256 } from '../snapshots.ts';
import { GOLDEN_RUN_ID, writeMixedRun, writeRunManifest } from './golden.ts';

// Aggregation, human review, truth-version protection and the score/report CLI, on the
// SCORER-VALIDATION golden run (see golden.ts). These numbers test the reporter; they are not
// measurements of agent performance.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);
const base = await mkdtemp(path.join(tmpdir(), 'td-report-'));
after(() => rm(base, { recursive: true, force: true }));
const { runDir, snapshotsRoot, ids } = await writeMixedRun(base);
await scoreRun(runDir, { snapshotsRoot });
const { summary, markdown } = await reportRun(runDir);

async function scoreFile(dir: string, evalId: string): Promise<{ record: ScoreRecord; sha: string }> {
  const text = await readFile(path.join(dir, evalId, SCORE_FILE), 'utf8');
  return { record: ScoreRecord.parse(JSON.parse(text)), sha: sha256(text) };
}

function review(evalId: string, sha: string, extra: Partial<Review> = {}): Review {
  return { evalId, reviewer: 'reviewer-1', reviewedAt: '2026-10-21', scoreSha256: sha, checks: {}, note: '', ...extra };
}

async function copyRun(name: string): Promise<string> {
  const dir = path.join(base, name);
  await cp(runDir, dir, { recursive: true });
  return dir;
}

/** A copy of the scenarios whose S02 truth.json has an edited description. */
async function editedTruth(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'td-truth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(SCENARIOS_DIR, root, { recursive: true });
  const file = path.join(root, 'S02', 'truth.json');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"description": "', '"description": "Edited. '));
  return root;
}

describe('scorer-validation labelling', () => {
  test('fixture runs are marked as scorer validation, never agent performance', async () => {
    assert.equal((await loadRunManifest(runDir)).source, 'scorer_validation');
    assert.equal(summary.runId, GOLDEN_RUN_ID);
    assert.equal(summary.purpose, 'scorer_validation');
    assert.match(summary.notice ?? '', /NOT measurements of agent performance/);
    assert.match(markdown.split('\n').slice(0, 3).join('\n'), /Scorer-validation fixtures.*NOT measurements of agent performance/);
  });

  test('a live run has no such notice', () => {
    const live = aggregate({ formatVersion: 1, runId: 'live-1', createdAt: '2026-10-21T00:00:00.000Z', source: 'live', description: '' }, [], null);
    assert.equal(live.purpose, 'agent_performance');
    assert.equal(live.notice, null);
  });

  test('a live summary always states its sample and that it does not establish reliability', async () => {
    const one = await scoreFile(runDir, ids.correct!);
    const live = aggregate({ formatVersion: 1, runId: 'live-1', createdAt: '2026-10-21T00:00:00.000Z', source: 'live', description: '' }, [{ record: one.record, sha256: one.sha }], null);
    assert.match(live.reliabilityWarning ?? '', /^1 scenario\(s\), attempts per scenario: S02 1\. Each scenario was run once.*insufficient to establish statistical reliability/);
    assert.match(renderSummary(live), /> \*\*Not a reliability estimate\.\*\* 1 scenario/);
    assert.equal(summary.reliabilityWarning, null, 'scorer-validation fixtures carry their own notice instead');
  });

  test('run.json rejects the old "synthetic" source label', async () => {
    const dir = path.join(base, 'old-label');
    await writeRunManifest(dir, 'old');
    const file = path.join(dir, 'run.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('scorer_validation', 'synthetic'));
    await assert.rejects(loadRunManifest(dir), /source/);
  });
});

describe('aggregation', () => {
  test('attempted, eligible, pending-review and excluded counts are all visible', () => {
    const a = summary.automatic;
    assert.equal(a.attempted, 23);
    assert.deepEqual(a.categories, { scored: 5, needs_review: 5, unverified: 2, invalid_output: 1, timeout: 1, session_error: 2, confirmed_violation: 3, invalid_setup: 4 });
    assert.equal(a.eligible, 10);
    assert.equal(a.pendingReview, 5);
    assert.deepEqual(a.excluded, { unverified: 2, invalid_output: 1, timeout: 1, session_error: 2, confirmed_violation: 3, invalid_setup: 4, total: 13 });
    assert.equal(a.eligible + a.excluded.total, a.attempted);
    assert.match(markdown, /\*\*23 evaluation\(s\) attempted\.\*\* 10 eligible for diagnostic metrics \(5 with pending reviews\); 13 excluded/);
  });

  test('classification agreement counts eligible investigations, with verdict categories and pending reviews kept apart', () => {
    const c = summary.automatic.classification;
    assert.equal(c.investigations, 10);
    assert.deepEqual(c.verdicts, { exact: 8, acceptable_alternative: 0, incorrect: 1, abstained: 1, missing: 0 });
    assert.deepEqual(c.exact, { count: 8, of: 10 });
    assert.equal(c.pendingReview, 5);
    assert.ok(!('credit' in c));
    assert.match(markdown, /\*\*Classification agreement:\*\* exact 8\/10 eligible investigations \(acceptable alternative 0, incorrect 1, abstained 1, missing 0; 5 still pending review\)/);
  });

  test('fully accepted diagnosis rate is a separate metric', () => {
    assert.deepEqual(summary.automatic.acceptance, { accepted: { count: 1, of: 10 }, statuses: { accepted: 1, pending_review: 3, not_accepted: 6 } });
    assert.match(markdown, /\*\*Fully accepted diagnoses:\*\* 1\/10 eligible runs \(pending review 3, not accepted 6\)/);
  });

  test('high-confidence incorrect diagnoses are listed explicitly', () => {
    assert.equal(summary.automatic.classification.highConfidenceIncorrect, 1);
    assert.deepEqual(summary.highConfidenceIncorrect, [{ evalId: ids.wrongClassification, test: 'signs in with valid credentials', predicted: 'Application defect', expected: 'Test-code defect' }]);
    assert.match(markdown, /HIGH-CONFIDENCE INCORRECT/);
  });

  test('evidence provenance is aggregated by kind', () => {
    const { claims, citations } = summary.automatic.evidence;
    assert.equal(claims.unsupported, 4, 'three in unsupportedEvidence + the MCP-snippet-only source claim');
    assert.equal(claims.confirmedFalse, 2, 'failed read + nonexistent video');
    assert.equal(claims.falseUnavailable, 1);
    assert.equal(claims.unresolved, 0);
    assert.equal(citations.unsupported, 3);
    assert.equal(citations.confirmedFalse, 1);
    assert.equal(citations.unresolved, 0);
  });

  test('ground truth versions are recorded and consistent', () => {
    assert.equal(summary.truthVersions.length, 1);
    assert.equal(summary.truthVersions[0]!.consistent, true);
    assert.match(summary.truthVersions[0]!.truthSha256[0]!, /^[0-9a-f]{64}$/);
    for (const e of summary.evaluations) assert.equal(e.truthSha256, summary.truthVersions[0]!.truthSha256[0]);
  });

  test('scores computed against different truth versions are flagged', async () => {
    const a = await scoreFile(runDir, ids.correct!);
    const b = await scoreFile(runDir, ids.wrongRootCause!);
    const other = { ...b.record, inputs: { ...b.record.inputs, truthSha256: 'f'.repeat(64) } };
    const mixed = aggregate(await loadRunManifest(runDir), [{ record: a.record, sha256: a.sha }, { record: other, sha256: b.sha }], null);
    assert.equal(mixed.truthVersions[0]!.consistent, false);
  });

  test('reliability keeps one row per scenario test', () => {
    assert.deepEqual(
      summary.reliability.map((r) => [r.scenarioId, r.test, r.attempts, r.eligible, r.agreement]),
      [['S02', 'signs in with valid credentials', 23, 10, { count: 8, of: 10 }]],
    );
  });

  test('usage totals cover all attempted runs and label cost as an estimate', () => {
    assert.equal(summary.usage.wallClockMs.reported, 23);
    assert.match(summary.usage.note, /estimate.*not a charge/);
  });

  test('summary.json validates, summary.md matches, and reporting is deterministic', async () => {
    Summary.parse(JSON.parse(await readFile(path.join(runDir, SUMMARY_JSON), 'utf8')));
    assert.equal(await readFile(path.join(runDir, SUMMARY_MD), 'utf8'), `${markdown}\n`);
    const before = await readFile(path.join(runDir, SUMMARY_JSON), 'utf8');
    await reportRun(runDir);
    assert.equal(await readFile(path.join(runDir, SUMMARY_JSON), 'utf8'), before);
  });
});

describe('human review', () => {
  test('reviews resolve pending runs without touching score.json; automatic and reviewed results are both kept', async () => {
    const dir = await copyRun('reviewed');
    const rootCause = await scoreFile(dir, ids.wrongRootCause!);
    const snippet = await scoreFile(dir, ids.mcpSnippetOnly!);
    const reviews: ReviewFile = {
      formatVersion: 1,
      reviews: [
        review(ids.wrongRootCause!, rootCause.sha, { checks: { root_cause: { status: 'fail', note: 'Blames the password.' }, recommendation: { status: 'fail', note: 'Does not fix the locator.' } } }),
        review(ids.mcpSnippetOnly!, snippet.sha, {
          checks: {
            evidence_validity: { status: 'pass', note: 'The snippet shows the Sign in locator line.' },
            evidence_sufficiency: { status: 'pass', note: 'Same.' },
            citations: { status: 'pass', note: 'Same.' },
          },
        }),
      ],
    };
    await writeFile(path.join(dir, REVIEW_FILE), serialize(reviews));
    const { summary: s, markdown: md } = await reportRun(dir);

    assert.equal((await scoreFile(dir, ids.wrongRootCause!)).sha, rootCause.sha, 'score.json unchanged');
    const rc = s.evaluations.find((e) => e.evalId === ids.wrongRootCause)!;
    assert.deepEqual([rc.automaticCategory, rc.reviewedCategory], ['needs_review', 'scored']);
    assert.deepEqual([rc.acceptance.automatic, rc.acceptance.reviewed], ['pending_review', 'not_accepted']);
    const sn = s.evaluations.find((e) => e.evalId === ids.mcpSnippetOnly)!;
    assert.deepEqual([sn.acceptance.automatic, sn.acceptance.reviewed], ['not_accepted', 'accepted'], 'a reviewer may overturn an automatic evidence failure');

    assert.deepEqual(s.automatic.acceptance.accepted, { count: 1, of: 10 }, 'automatic metrics unchanged');
    assert.deepEqual(s.reviewed!.acceptance.accepted, { count: 2, of: 10 });
    assert.equal(s.reviewed!.pendingReview, 4);
    assert.equal(s.reviewed!.classification.pendingReview, 4);
    assert.match(md, /Needs manual review → Scored/);
    assert.match(md, /not_accepted → accepted/);
  });

  test('a stale review is not applied', async () => {
    const { record } = await scoreFile(runDir, ids.wrongRootCause!);
    const result = applyReview(record, 'a'.repeat(64), review(record.evalId, 'b'.repeat(64), { checks: { root_cause: { status: 'pass', note: 'x' } } }));
    assert.equal(result.status, 'stale');
    assert.equal(result.acceptance.status, 'pending_review');
  });

  test('a review cannot clear a confirmed violation, but can confirm or resolve a suspicious one', async () => {
    const leak = await scoreFile(runDir, ids.leak!);
    assert.equal(applyReview(leak.record, leak.sha, review(leak.record.evalId, leak.sha, { audit: { verdict: 'clean', note: 'x' } })).category, 'confirmed_violation');
    const sus = await scoreFile(runDir, ids.suspiciousPaths!);
    assert.equal(applyReview(sus.record, sus.sha, review(sus.record.evalId, sus.sha, { audit: { verdict: 'violation', note: 'x' } })).category, 'confirmed_violation');
    const resolved = applyReview(sus.record, sus.sha, review(sus.record.evalId, sus.sha, { audit: { verdict: 'clean', note: 'harmless' } }));
    assert.equal(resolved.category, 'scored');
    assert.equal(resolved.acceptance.status, 'accepted');
  });

  test('check overrides on runs that are not eligible are rejected', async () => {
    const { record, sha } = await scoreFile(runDir, ids.missingSkill!);
    const result = applyReview(record, sha, review(record.evalId, sha, { checks: { root_cause: { status: 'pass', note: 'x' } } }));
    assert.equal(result.status, 'partly_rejected');
    assert.equal(result.acceptance.status, 'not_eligible');
  });

  test('the review schema rejects non-reviewable checks and duplicate reviews', () => {
    const ok = review('S02-01', 'a'.repeat(64));
    assert.equal(ReviewFile.safeParse({ formatVersion: 1, reviews: [{ ...ok, checks: { classification: { status: 'pass', note: 'x' } } }] }).success, false);
    assert.equal(ReviewFile.safeParse({ formatVersion: 1, reviews: [ok, ok] }).success, false);
    assert.equal(ReviewFile.safeParse({ formatVersion: 1, reviews: [ok] }).success, true);
  });

  test('rescoring after a truth change keeps the original score and the review, which becomes stale', async (t) => {
    const dir = await copyRun('rescored');
    const before = await scoreFile(dir, ids.wrongRootCause!);
    const reviewText = serialize({ formatVersion: 1, reviews: [review(ids.wrongRootCause!, before.sha, { checks: { root_cause: { status: 'fail', note: 'x' } } })] });
    await writeFile(path.join(dir, REVIEW_FILE), reviewText);
    await scoreRun(dir, { snapshotsRoot, scenariosRoot: await editedTruth(t), rescore: true });
    const { summary: s } = await reportRun(dir);
    assert.equal(await readFile(path.join(dir, REVIEW_FILE), 'utf8'), reviewText, 'review.json untouched');
    assert.equal(s.evaluations.find((e) => e.evalId === ids.wrongRootCause)!.review.status, 'stale');
    assert.equal(s.reviews.stale, 1);
    const [archived] = await readdir(path.join(dir, ids.wrongRootCause!, SCORE_HISTORY_DIR));
    assert.equal(sha256(await readFile(path.join(dir, ids.wrongRootCause!, SCORE_HISTORY_DIR, archived!), 'utf8')), before.sha, 'the reviewed score is preserved');
  });
});

describe('combined report over several runs', () => {
  const evalIds = Object.values(ids).sort();
  const half = Math.ceil(evalIds.length / 2);

  /** A copy of the golden run under a new runId, keeping only `keep` evaluations. */
  async function partRun(name: string, keep: string[]): Promise<string> {
    const dir = await copyRun(name);
    await writeRunManifest(dir, name);
    for (const id of evalIds.filter((e) => !keep.includes(e))) await rm(path.join(dir, id), { recursive: true });
    await rm(path.join(dir, SUMMARY_JSON));
    await rm(path.join(dir, SUMMARY_MD));
    return dir;
  }
  let a = '';
  let b = '';
  before(async () => {
    [a, b] = [await partRun('part-a', evalIds.slice(0, half)), await partRun('part-b', evalIds.slice(half))];
  });
  const filesOf = async (dir: string) => {
    const out: Record<string, string> = {};
    for (const f of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (f.isFile()) out[path.relative(dir, path.join(f.parentPath, f.name))] = sha256(await readFile(path.join(f.parentPath, f.name)));
    }
    return out;
  };

  test('aggregates every evaluation, records its run, and only writes the two summary files to --out', async () => {
    const before = [await filesOf(a), await filesOf(b)];
    const out = path.join(base, 'combined-pilot');
    const { summary: s, markdown: md } = await reportCombined([a, b], out);
    assert.deepEqual([await filesOf(a), await filesOf(b)], before, 'source runs are only read');
    assert.deepEqual((await readdir(out)).sort(), [SUMMARY_JSON, SUMMARY_MD]);
    assert.equal(s.runId, 'combined-pilot');
    assert.deepEqual(s.runs, [
      { runId: 'part-a', evaluations: evalIds.slice(0, half) },
      { runId: 'part-b', evaluations: evalIds.slice(half) },
    ]);
    assert.deepEqual(s.automatic, summary.automatic, 'the same evaluations give the same metrics as one run');
    assert.deepEqual(s.usage, summary.usage);
    assert.deepEqual(new Set(s.evaluations.map((e) => e.runId)), new Set(['part-a', 'part-b']));
    assert.deepEqual(s.scorerVersions, [SCORER_VERSION]);
    assert.match(md, /^Combined from 2 runs: part-a \(.*\); part-b \(.*\)\. Each run's own files are unchanged\.$/m);
    assert.match(md, /^\| Evaluation \| Run \| Scorer \| Truth sha256 \| Snapshot \| Duration \(s\) \|/m);
    const again = await reportCombined([a, b], out);
    assert.equal(again.markdown, md, 'deterministic, and a previous combined summary may be replaced');
  });

  test('refuses what would mislabel or double-count evaluations', async (t) => {
    const out = (name: string) => path.join(base, name);
    await assert.rejects(reportCombined([a], out('c1')), /at least two runs/);
    await assert.rejects(reportCombined([a, a], out('c2')), /listed twice/);
    const dup = await partRun('part-dup', evalIds.slice(0, 1));
    await assert.rejects(reportCombined([a, dup], out('c3')), /occurs in both part-a and part-dup/);
    await assert.rejects(reportCombined([a, b], path.join(a, 'combined')), /overlaps the source run/);
    await assert.rejects(reportCombined([a, b], base), /overlaps the source run/);
    const busy = out('c4');
    await mkdir(busy);
    await writeFile(path.join(busy, 'notes.txt'), 'x');
    await assert.rejects(reportCombined([a, b], busy), /already contains notes\.txt/);

    const live = await partRun('part-live', evalIds.slice(half));
    await writeFile(path.join(live, 'run.json'), (await readFile(path.join(live, 'run.json'), 'utf8')).replace('scorer_validation', 'live'));
    await assert.rejects(reportCombined([a, live], out('c5')), /different sources \(scorer_validation, live\)/);

    const foreign = await partRun('part-review', evalIds.slice(half));
    const target = await scoreFile(a, evalIds[0]!);
    await writeFile(path.join(foreign, REVIEW_FILE), serialize({ formatVersion: 1, reviews: [review(evalIds[0]!, target.sha)] }));
    await assert.rejects(reportCombined([a, foreign], out('c6')), new RegExp(`part-review/review\\.json reviews ${evalIds[0]}, which is not an evaluation of that run`));
    t.diagnostic('no output directory was created by a refused report');
    for (const name of ['c1', 'c2', 'c3', 'c5', 'c6']) assert.equal(await stat(out(name)).then(() => true, () => false), false, name);
  });

  test('CLI: --out is required with several runs and refused with one', async () => {
    const cli = (...argv: string[]) => run(process.execPath, [path.join(REPO_ROOT, 'src', 'eval', 'main.ts'), ...argv], { cwd: REPO_ROOT });
    await assert.rejects(cli('report', '--run', a, '--run', b), (e: { code: number }) => e.code === 2);
    await assert.rejects(cli('report', '--run', a, '--out', path.join(base, 'x')), (e: { code: number }) => e.code === 2);
    await assert.rejects(cli('score', '--run', a, '--run', b), (e: { code: number }) => e.code === 2);
    const ok = await cli('report', '--run', a, '--run', b, '--out', path.join(base, 'cli-combined'));
    assert.match(ok.stdout, /# Evaluation summary: cli-combined/);
  });
});

describe('CLI', () => {
  const cli = (...argv: string[]) => run(process.execPath, [path.join(REPO_ROOT, 'src', 'eval', 'main.ts'), ...argv], { cwd: REPO_ROOT });

  test('score then report on a saved run', async () => {
    const scored = await cli('score', '--run', runDir, '--snapshots', snapshotsRoot);
    assert.match(scored.stdout, /# eval score: 23 evaluation\(s\)/);
    assert.match(scored.stdout, new RegExp(`\\| ${ids.correct} \\| scored \\| Test-code defect \\(exact\\) \\| accepted \\| – \\|`));
    assert.match(scored.stdout, /Application defect \(incorrect, high-confidence incorrect\)/);
    const reported = await cli('report', '--run', runDir);
    assert.match(reported.stdout, new RegExp(`# Evaluation summary: ${GOLDEN_RUN_ID}`));
  });

  test('score refuses silent rescoring after a truth change; --rescore replaces and archives', async (t) => {
    const dir = await copyRun('cli-rescore');
    const scenariosRoot = await editedTruth(t);
    await assert.rejects(
      cli('score', '--run', dir, '--snapshots', snapshotsRoot, '--scenarios', scenariosRoot),
      (e: { code: number; stderr: string }) => e.code === 1 && /stored score\(s\) would change/.test(e.stderr) && /truth\.json changed/.test(e.stderr) && /--rescore/.test(e.stderr),
    );
    const ok = await cli('score', '--run', dir, '--snapshots', snapshotsRoot, '--scenarios', scenariosRoot, '--rescore');
    assert.match(ok.stdout, /Rescored \d+ evaluation\(s\); previous scores archived/);
  });

  test('refuses a directory that is not a saved run', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'td-report-'));
    after(() => rm(empty, { recursive: true, force: true }));
    await assert.rejects(cli('score', '--run', empty), (e: { code: number; stderr: string }) => e.code === 1 && /has no run\.json/.test(e.stderr));
  });

  test('report refuses unscored evaluations', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'td-report-'));
    after(() => rm(dir, { recursive: true, force: true }));
    await writeRunManifest(dir, 'unscored');
    await mkdir(path.join(dir, 'S02-01'));
    await assert.rejects(cli('report', '--run', dir), (e: { code: number; stderr: string }) => e.code === 1 && /has no score\.json; run "npm run eval -- score/.test(e.stderr));
    assert.equal(await stat(path.join(dir, SUMMARY_JSON)).then(() => true, () => false), false);
  });

  test('usage errors exit 2', async () => {
    await assert.rejects(cli('score'), (e: { code: number }) => e.code === 2);
    await assert.rejects(cli('report', '--run', runDir, '--rescore'), (e: { code: number }) => e.code === 2);
    await assert.rejects(cli('live'), (e: { code: number }) => e.code === 2);
  });
});
