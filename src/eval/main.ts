import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runControl } from './control.ts';
import { generateSnapshot } from './generate.ts';
import type { GenerateOutcome } from './generate.ts';
import { LIVE_USAGE, parseLiveArgs, runLiveEvaluation } from './live.ts';
import { reportCombined, reportRun, scoreRun } from './runs.ts';
import type { ScoreRecord } from './score.ts';

// Evaluation CLI (`npm run eval -- <command>`). Wiring only. Output goes to stdout; errors to stderr.
// Only `live` makes model requests (one scenario, one session, explicit budget). generate, control,
// score and report never do; score and report read saved files only (see runs.ts).

const USAGE = `Usage:
  npm run eval -- generate --scenario <id> [--keep-stage]
  npm run eval -- control --scenario <id> [--keep-stage]
  npm run eval -- score --run <dir> [--snapshots <dir>] [--scenarios <dir>] [--rescore]
  npm run eval -- report --run <dir>
  npm run eval -- report --run <dir> --run <dir> [...] --out <dir>
  npm run eval -- live --scenario <id> --max-budget-usd <n> [...]   REAL MODEL REQUESTS; run "live --help"

generate   Run one scenario's spec with Playwright against the local fixture app and store the
           verified result as evals/snapshots/<id>/. No model requests. Never overwrites a snapshot.
  --scenario <id>     Scenario ID, e.g. S02
  --keep-stage        Keep the .work/<random>/ staging directory for debugging

control    Run the scenario's corrected spec (control/<spec>) against the same fixture behavior and
           Playwright settings; it must pass. No model requests. Stores nothing.
  --scenario <id>     Scenario ID with a control spec, e.g. S03
  --keep-stage        Keep the .work/<random>/ staging directory for debugging

score      Score every saved evaluation in a run directory against its truth.json and writes
           <evalId>/score.json. Offline: never starts a session, calls a model or runs Playwright.
  --run <dir>         Saved run directory (format: evals/README.md, "Saved runs")
  --snapshots <dir>   Snapshot root (default evals/snapshots)
  --scenarios <dir>   Scenario root with truth files (default evals/scenarios)
  --rescore           Replace stored scores that would change (e.g. truth.json changed). Without it,
                      score refuses and writes nothing. Old scores go to <evalId>/score-history/.

report     Aggregate the score files (and review.json, if present) into summary.json and summary.md.
  --run <dir>         Saved run directory, already scored. Repeat it to combine several runs.
  --out <dir>         Required with several runs: a separate directory for the combined summary
                      (its name is the summary's ID). The source runs are only read.`;

const repoRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');

if (process.argv[2] === 'live') await live(process.argv.slice(3));

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      scenario: { type: 'string' },
      'keep-stage': { type: 'boolean' },
      run: { type: 'string', multiple: true },
      out: { type: 'string' },
      snapshots: { type: 'string' },
      scenarios: { type: 'string' },
      rescore: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (error) {
  usageError(error instanceof Error ? error.message : String(error));
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const command = positionals.length === 1 ? positionals[0] : undefined;

if (command === 'generate') {
  if (!values.scenario) usageError('generate needs --scenario <id>');
  const outcome = await generateSnapshot(values.scenario, { repoRoot, keepStage: values['keep-stage'] === true });
  console.log(render(values.scenario, outcome));
  process.exitCode = outcome.ok ? 0 : 1;
} else if (command === 'control') {
  if (!values.scenario) usageError('control needs --scenario <id>');
  try {
    const outcome = await runControl(values.scenario, { repoRoot, keepStage: values['keep-stage'] === true });
    const lines = [`# eval control ${values.scenario}: ${outcome.ok ? 'passed' : 'FAILED'}`, '', ...outcome.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`)];
    if (!outcome.ok && outcome.output) lines.push('', '**Playwright output (tail):**', '```', outcome.output.slice(-4000), '```');
    lines.push('', outcome.stageKept ? `**Stage kept:** \`${outcome.stageDir}\`` : '**Stage removed.**');
    console.log(lines.join('\n'));
    process.exitCode = outcome.ok ? 0 : 1;
  } catch (error) {
    console.error(`eval control: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'score' || command === 'report') {
  const runs = values.run ?? [];
  if (runs.length === 0) usageError(`${command} needs --run <dir>`);
  if (command === 'report' && (values.snapshots || values.scenarios || values.rescore)) usageError('report reads score files only; --snapshots, --scenarios and --rescore belong to score');
  if (command === 'score' && (runs.length > 1 || values.out !== undefined)) usageError('score takes exactly one --run and no --out');
  if (command === 'report' && runs.length > 1 !== (values.out !== undefined)) usageError('report: --out is required with several --run directories and not allowed with one');
  const runDir = path.resolve(runs[0]!);
  try {
    if (command === 'score') {
      const { records, rescored } = await scoreRun(runDir, {
        snapshotsRoot: values.snapshots ? path.resolve(values.snapshots) : undefined,
        scenariosRoot: values.scenarios ? path.resolve(values.scenarios) : undefined,
        rescore: values.rescore === true,
      });
      console.log(renderScores(runDir, records));
      if (rescored.length > 0) console.log(`\nRescored ${rescored.length} evaluation(s); previous scores archived:\n${rescored.map((c) => `- ${c.evalId}: ${c.reasons.join('; ')}`).join('\n')}`);
    } else {
      console.log((runs.length > 1 ? await reportCombined(runs, values.out!) : await reportRun(runDir)).markdown);
    }
  } catch (error) {
    console.error(`eval ${command}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else {
  usageError('expected one command: generate, control, score or report');
}

function usageError(message: string): never {
  console.error(`eval: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function renderScores(runDir: string, records: ScoreRecord[]): string {
  const out = [`# eval score: ${records.length} evaluation(s) in ${runDir}`, '', '| Evaluation | Category | Classification per test | Acceptance | Checks not passing |', '|---|---|---|---|---|'];
  for (const r of records) {
    const tests = r.classification.tests.map((t) => `${t.predicted ?? 'none'} (${t.verdict}${t.highConfidenceIncorrect ? ', high-confidence incorrect' : ''})`).join('; ');
    const open = r.checks.filter((k) => k.status !== 'pass' && k.status !== 'not_applicable').map((k) => `${k.id}=${k.status}`);
    out.push(`| ${r.evalId} | ${r.category} | ${tests || '–'} | ${r.acceptance.status} | ${open.join(', ') || '–'} |`);
  }
  out.push('', `Wrote <evalId>/score.json. Next: npm run eval -- report --run ${runDir}`);
  return out.join('\n');
}

function render(id: string, outcome: GenerateOutcome): string {
  const out: string[] = [`# eval generate ${id}: ${outcome.ok ? 'snapshot stored' : 'FAILED'}`, ''];
  if (!outcome.ok) out.push(`**Reason:** ${outcome.reason}`, '');
  if (outcome.checks.length > 0) {
    out.push('**Observation checks:**', ...outcome.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`), '');
  }
  if (outcome.facts) {
    const { list, details } = outcome.facts;
    out.push(`**Report** \`${list.run.reportFingerprint}\` · Playwright ${list.run.playwrightVersion ?? '?'} · stats ${JSON.stringify(list.stats)}`, '');
    for (const d of details) {
      out.push(`## ${d.title} (${d.file}:${d.line}, ${d.outcome})`);
      for (const a of d.attempts) {
        out.push(`- retry ${a.retry}: ${a.status} in ${a.durationMs}ms`);
        if (a.error) out.push('  ```', ...a.error.message.split('\n').map((l) => `  ${l}`), '  ```');
        for (const e of a.additionalErrors) out.push(`  - additional error: ${e.message.split('\n')[0]}`);
        for (const att of a.attachments) out.push(`  - ${att.name}: ${att.path ?? att.location} (${att.exists ? `${att.sizeBytes} bytes` : (att.issue ?? 'missing')})`);
      }
      out.push('');
    }
  }
  if (outcome.ok) {
    const { manifest, dir } = outcome.snapshot;
    out.push(`**Snapshot:** \`${dir}\` (${manifest.files.length} files, generated ${manifest.generatedAt})`);
  } else if (outcome.output) {
    out.push('**Playwright output (tail):**', '```', outcome.output.slice(-4000), '```');
  }
  out.push(outcome.stageKept ? `**Stage kept:** \`${outcome.stageDir}\`` : '**Stage removed.**');
  return out.join('\n');
}

/** `eval live`: one scenario, one session. Exits before reaching the generic parser. */
async function live(argv: string[]): Promise<never> {
  const parsed = parseLiveArgs(argv);
  if (parsed.kind === 'help') {
    console.log(LIVE_USAGE);
    process.exit(0);
  }
  if (parsed.kind === 'error') {
    console.error(`eval live: ${parsed.message}\n\n${LIVE_USAGE}`);
    process.exit(2);
  }
  const { request } = parsed;
  const interrupt = new AbortController();
  process.on('SIGINT', () => {
    if (interrupt.signal.aborted) process.exit(130);
    console.error('eval live: interrupting, closing the session (the partial run is kept)...');
    interrupt.abort();
  });
  console.error(
    `eval live: ${request.scenarioId}, budget $${request.args.maxBudgetUsd} (SDK estimate), ${request.args.maxTurns} turns, ` +
      `${request.args.timeoutMs / 1000}s, auth ${request.args.auth}. One session, no retries.`,
  );
  try {
    const r = await runLiveEvaluation(request, { repoRoot, signal: interrupt.signal });
    const usage = r.result?.usage;
    const lines = [
      `# eval live ${r.evalId}: ${r.outcome.harness.status}${r.result ? ` / ${r.result.runStatus}` : ''}`,
      '',
      `- Run: \`${r.runDir}\``,
      r.outcome.harness.detail ? `- Harness: ${r.outcome.harness.detail}` : null,
      r.result?.issues.length ? `- Issues: ${r.result.issues.join('; ')}` : null,
      `- Transcript: ${r.transcriptMessages} message(s); workspace ${r.outcome.cleanup.removed ? 'removed' : `NOT removed (${r.outcome.cleanup.error})`}` +
        (r.outcome.cleanup.removed && r.outcome.cleanup.transient?.length ? ` after ${r.outcome.cleanup.transient.length} retried attempt(s) over ${r.outcome.cleanup.elapsedMs} ms` : ''),
      usage
        ? `- Usage: ${usage.numTurns ?? '?'} turns, ${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out tokens, ${(usage.durationMs / 1000).toFixed(1)}s, ` +
          `estimated $${usage.estimatedUsageCostUsd ?? '?'} (SDK estimate, not a charge), ${r.result!.observed.permissionDenials.length} permission denial(s)`
        : null,
      r.score ? `- Score: ${r.score.category}, acceptance ${r.score.acceptance.status}` : `- Score: not computed (${r.scoreError})`,
      '',
      r.summaryMarkdown ?? '',
    ];
    console.log(lines.filter((l) => l !== null).join('\n'));
    process.exit(r.outcome.harness.status === 'session_finished' && r.score ? 0 : 1);
  } catch (error) {
    console.error(`eval live: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
