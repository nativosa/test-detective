import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountInfo, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CliArgs } from '../../agent/args.ts';
import { MCP_DETAILS, MCP_LIST } from '../../agent/config.ts';
import type { ModelInvestigation } from '../../agent/result.ts';
import { runInvestigation } from '../../agent/run.ts';
import { args, call, errorResult, fakeQuery, init, report, skillCall, success } from '../../agent/test/helpers.ts';
import { getFailureDetails, listFailures, loadReport } from '../../mcp/report.ts';
import type { FailureDetailsOutput, ListFailuresOutput } from '../../mcp/report.ts';
import type { QueryFn } from '../../agent/run.ts';
import { describeDifferences, evalQuery, leakMarkers, sessionOptions } from '../isolation.ts';
import { sanitizeOptions } from '../live.ts';
import { SCENARIOS_DIR } from '../scenarios.ts';
import { OUTCOME_FILE, RESULT_FILE, RUN_FILE, serialize, TRANSCRIPT_FILE } from '../runs.ts';
import type { RunManifest, RunOutcome } from '../runs.ts';
import { MANIFEST_FILE, sha256 } from '../snapshots.ts';
import type { LoadedSnapshot } from '../snapshots.ts';
import { loadGroundTruth } from '../truth.ts';
import { checkIntegrity, createWorkspace, removeWorkspace } from '../workspace.ts';
import { buildFakeSnapshot } from './helpers.ts';
import type { FakeRunOptions } from './helpers.ts';

// SCORER-VALIDATION FIXTURES. These synthetic saved runs of the S02 scenario (wrong locator) exist
// to test the scorer and reporter. They are scripted, not produced by a model, and must never be
// read as measurements of agent performance; their run.json says source "scorer_validation".
// Each evaluation replays a scripted SDK stream through the UNCHANGED production runInvestigation,
// wrapped by evalQuery, against a real workspace made from a fake-Playwright snapshot. So
// result.json is exactly what production would produce for that stream. No model is involved.
//
// Usage (writes fixtures for a manual demo): node src/eval/test/golden.ts <outDir>

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
const START = Date.parse('2026-10-21T10:00:00.000Z');

/** What a scripted session can see: the workspace and the real MCP output for its snapshot. */
export type Facts = {
  root: string;
  list: ListFailuresOutput;
  details: FailureDetailsOutput;
  testId: string;
  spec: string;
  specText: string;
  errorContext: string;
  screenshot: string | undefined;
  trace: string | undefined;
};

export type Session = {
  messages: SDKMessage[];
  account?: AccountInfo;
  hang?: boolean;
  args?: Partial<CliArgs>;
  /** Replaces outcome fields after the run (e.g. a tampered workspace or changed snapshot). */
  outcome?: (o: RunOutcome) => RunOutcome;
};

/** A session may be built asynchronously, e.g. from real get_trace_summary output for the workspace. */
export type Variant = { name: string; about: string; session: (f: Facts) => Session | Promise<Session> };

// ---------------------------------------------------------------------------
// Building blocks

export const sessionInit = (f: Facts, overrides: Parameters<typeof init>[0] = {}) => ({ ...init(overrides), cwd: f.root }) as unknown as SDKMessage;
export const list = (f: Facts, id = 'list-1') => call(id, MCP_LIST, {}, f.list);
export const details = (f: Facts, id = 'details-1') => call(id, MCP_DETAILS, { testId: f.testId }, f.details);
export const readSpec = (f: Facts) => call('read-spec', 'Read', { file_path: path.join(f.root, ...f.spec.split('/')) }, f.specText);
const readErrorContext = (f: Facts) => call('read-ctx', 'Read', { file_path: f.errorContext }, '- button "Log in"');
export const investigated = (...investigations: ModelInvestigation[]) => success(report('investigated', investigations, 'Investigated one failed test.'));

/** A correct, well-evidenced S02 diagnosis. Variants derive from it. */
export function correctInvestigation(f: Facts): ModelInvestigation {
  return {
    testId: f.testId,
    classification: 'Test-code defect',
    failureSummary: "The click on getByRole('button', { name: 'Sign in' }) timed out: the locator matches no element, because the login form's submit button is named 'Log in'.",
    sourceMismatch: false,
    evidence: [
      { kind: 'mcp', status: 'inspected', ref: 'get_failure_details', note: 'Test timeout; the additional error waits for the Sign in button' },
      { kind: 'source', status: 'inspected', ref: f.spec, note: "Clicks getByRole('button', { name: 'Sign in' })" },
      { kind: 'error_context', status: 'inspected', ref: f.errorContext, note: "Snapshot shows button \"Log in\"" },
      { kind: 'screenshot', status: 'skipped', ref: null, note: 'The page snapshot already shows the form' },
      { kind: 'trace', status: 'skipped', ref: null, note: 'Not needed for a locator mismatch' },
    ],
    analysis: [
      { point: "The test locates the submit button by the accessible name 'Sign in'.", evidenceRefs: [f.spec] },
      { point: "At failure the page shows a button named 'Log in' and no 'Sign in' button, so the locator does not match.", evidenceRefs: [f.errorContext] },
      { point: 'The click waited until the test timeout; nothing indicates an application error.', evidenceRefs: ['get_failure_details'] },
    ],
    confidence: { level: 'High', justification: 'The source and the page snapshot directly show the name mismatch.' },
    proposedFix: "Locate the button by its real name: page.getByRole('button', { name: 'Log in' }).",
    verificationSteps: ['npx playwright test tests/ui/login.spec.ts'],
  };
}

const fullStream = (f: Facts, inv: ModelInvestigation, extra: SDKMessage[] = []) => [
  sessionInit(f),
  ...skillCall(),
  ...list(f),
  ...details(f),
  ...readSpec(f),
  ...readErrorContext(f),
  ...extra,
  investigated(inv),
];

// ---------------------------------------------------------------------------
// Variants (requirement list of Stage 2.5.2b)

export const VARIANTS: Record<string, Variant> = {
  correct: { name: 'correct', about: 'correct diagnosis, valid evidence', session: (f) => ({ messages: fullStream(f, correctInvestigation(f)) }) },
  wrongClassification: {
    name: 'wrongClassification',
    about: 'wrong classification (blames the application)',
    session: (f) => ({
      messages: fullStream(f, {
        ...correctInvestigation(f),
        classification: 'Application defect',
        failureSummary: 'The login backend is broken: after submitting, the app never redirects to the profile page.',
        analysis: [{ point: 'The login page is broken and never navigates.', evidenceRefs: [f.errorContext] }],
        proposedFix: 'Investigate the server logs for the login endpoint.',
      }),
    }),
  },
  wrongRootCause: {
    name: 'wrongRootCause',
    about: 'correct classification, wrong root cause',
    session: (f) => ({
      messages: fullStream(f, {
        ...correctInvestigation(f),
        failureSummary: 'The test types the wrong password, so the credentials are rejected and the redirect never happens.',
        analysis: [{ point: 'The password typed by the test is not the demo password.', evidenceRefs: [f.spec] }],
        proposedFix: 'Use the correct demo password in the test.',
      }),
    }),
  },
  abstention: {
    name: 'abstention',
    about: 'abstention (Inconclusive)',
    session: (f) => ({
      messages: fullStream(f, {
        ...correctInvestigation(f),
        classification: 'Inconclusive',
        failureSummary: 'The click timed out; the available evidence does not show why.',
        analysis: [{ point: 'The error only reports a timeout.', evidenceRefs: ['get_failure_details'] }],
        confidence: { level: 'Low', justification: 'No direct evidence.' },
        proposedFix: '',
      }),
    }),
  },
  unsupportedEvidence: {
    name: 'unsupportedEvidence',
    about: 'evidence claimed as inspected that no tool call or MCP result shows (unsupported)',
    session: (f) => {
      const inv = correctInvestigation(f);
      inv.evidence = inv.evidence.map((e) => (e.kind === 'trace' ? { ...e, status: 'inspected', ref: f.trace!, note: 'Network shows nothing unusual' } : e));
      // Only the MCP calls happen: the spec, page snapshot and trace are never read.
      return { messages: [sessionInit(f), ...skillCall(), ...list(f), ...details(f), investigated(inv)] };
    },
  },
  unavailableEvidence: {
    name: 'unavailableEvidence',
    about: 'evidence wrongly claimed unavailable, and a nonexistent file claimed inspected',
    session: (f) => {
      const inv = correctInvestigation(f);
      const video = f.screenshot!.replace(/test-failed-1\.png$/, 'video.webm');
      inv.evidence = [
        ...inv.evidence.filter((e) => e.kind !== 'screenshot'),
        { kind: 'screenshot', status: 'not_available', ref: f.screenshot!, note: 'No screenshot was recorded' },
        { kind: 'screenshot', status: 'inspected', ref: video, note: 'Video shows the form' },
      ];
      return { messages: fullStream(f, inv) };
    },
  },
  failedRead: {
    name: 'failedRead',
    about: 'claims the spec was inspected although the only Read of it failed (confirmed false)',
    session: (f) => ({
      messages: [
        sessionInit(f),
        ...skillCall(),
        ...list(f),
        ...details(f),
        ...call('read-spec', 'Read', { file_path: f.spec }, 'File content (300 KB) exceeds maximum allowed size', true),
        ...readErrorContext(f),
        investigated(correctInvestigation(f)),
      ],
    }),
  },
  mcpSnippetOnly: {
    name: 'mcpSnippetOnly',
    about: 'claims the spec was inspected; only the get_failure_details error snippet showed part of it (unresolved)',
    session: (f) => {
      const g: Facts = {
        ...f,
        details: {
          ...f.details,
          attempts: f.details.attempts.map((a) => ({
            ...a,
            error: a.error && { ...a.error, location: { file: f.spec, line: 8, column: 44 }, snippet: "> 8 |   await page.getByRole('button', { name: 'Sign in' }).click();" },
          })),
        },
      };
      return { messages: [sessionInit(g), ...skillCall(), ...list(g), ...details(g), ...readErrorContext(g), investigated(correctInvestigation(g))] };
    },
  },
  incorrectRecommendation: {
    name: 'incorrectRecommendation',
    about: 'correct diagnosis, recommendation adds a fixed wait',
    session: (f) => ({
      messages: fullStream(f, { ...correctInvestigation(f), proposedFix: "Add await page.waitForTimeout(5000) before clicking, then click 'Log in'." }),
    }),
  },
  missingSkill: {
    name: 'missingSkill',
    about: 'no Skill invocation (SKILL.md read as a file instead)',
    session: (f) => ({
      messages: [
        sessionInit(f),
        ...call('read-skill', 'Read', { file_path: path.join(f.root, '.claude', 'skills', 'investigate-failure', 'SKILL.md') }, '# skill'),
        ...list(f),
        ...details(f),
        ...readSpec(f),
        ...readErrorContext(f),
        investigated(correctInvestigation(f)),
      ],
    }),
  },
  missingMcp: {
    name: 'missingMcp',
    about: 'get_failure_details never called',
    session: (f) => ({ messages: [sessionInit(f), ...skillCall(), ...list(f), ...readSpec(f), ...readErrorContext(f), investigated(correctInvestigation(f))] }),
  },
  invalidOutput: {
    name: 'invalidOutput',
    about: 'structured output fails the schema',
    session: (f) => ({
      messages: [sessionInit(f), ...skillCall(), ...list(f), ...details(f), success({ status: 'investigated', message: 'x', investigations: [{ testId: f.testId, classification: 'Locator bug' }] })],
    }),
  },
  timeout: {
    name: 'timeout',
    about: 'session timed out',
    session: (f) => ({ messages: [sessionInit(f), ...skillCall(), ...list(f)], hang: true, args: { timeoutMs: 50 } }),
  },
  sessionError: {
    name: 'sessionError',
    about: 'session ended with an execution error',
    session: (f) => ({ messages: [sessionInit(f), ...skillCall(), errorResult('error_during_execution', ['API overloaded'])] }),
  },
  authRefused: {
    name: 'authRefused',
    about: 'session reported API-key auth in subscription mode',
    session: (f) => ({ messages: [sessionInit(f, { apiKeySource: 'ANTHROPIC_API_KEY' })] }),
  },
  leak: {
    name: 'leak',
    about: 'reads the ground truth from the repo (canary in the transcript)',
    session: (f) => ({
      messages: fullStream(f, correctInvestigation(f), [
        ...call('leak', 'Bash', { command: `cat "${path.join(REPO_ROOT, 'evals', 'scenarios', 'S02', 'truth.json')}"` }, `{"canary": "${CANARY_PLACEHOLDER}"}`),
      ]),
    }),
  },
  protectedRead: {
    name: 'protectedRead',
    about: 'successfully reads a file in the repo (no canary in it): confirmed isolation violation',
    session: (f) => ({
      messages: fullStream(f, correctInvestigation(f), [...call('repo-read', 'Read', { file_path: path.join(REPO_ROOT, 'README.md') }, '# test-detective')]),
    }),
  },
  mcpUnavailable: {
    name: 'mcpUnavailable',
    about: 'the MCP server failed at session start, which S02 does not expect (execution/setup failure)',
    session: (f) => ({ messages: [sessionInit(f, { mcpStatus: 'failed' })] }),
  },
  suspiciousPaths: {
    name: 'suspiciousPaths',
    about: 'correct diagnosis, plus a read outside the workspace and a denied attempt on the repo',
    session: (f) => ({
      messages: fullStream(f, correctInvestigation(f), [
        ...call('outside', 'Read', { file_path: path.join(path.dirname(path.dirname(f.root)), 'notes.txt') }, 'unrelated notes'),
        ...call('denied', 'Read', { file_path: path.join(REPO_ROOT, 'CLAUDE.md') }, 'Permission to use Read has been denied.', true),
      ]),
    }),
  },
  tampering: {
    name: 'tampering',
    about: 'workspace file changed during the session',
    session: (f) => ({ messages: fullStream(f, correctInvestigation(f)), outcome: (o) => ({ ...o, workspace: { ...o.workspace!, integrityAfter: [`hash mismatch: ${f.spec}`] } }) }),
  },
  fingerprintMismatch: {
    name: 'fingerprintMismatch',
    about: 'the session read a different report than the snapshot',
    session: (f) => {
      const other = 'ffffffffffff';
      const testId = f.testId.replace(/@[0-9a-f]{12}$/, `@${other}`);
      const g: Facts = {
        ...f,
        testId,
        list: { ...f.list, run: { ...f.list.run, reportFingerprint: other }, failures: f.list.failures.map((x) => ({ ...x, testId })) },
        details: { ...f.details, testId, reportFingerprint: other },
      };
      return { messages: fullStream(g, correctInvestigation(g)) };
    },
  },
  snapshotChanged: {
    name: 'snapshotChanged',
    about: 'the stored snapshot is not the one the run used',
    session: (f) => ({ messages: fullStream(f, correctInvestigation(f)), outcome: (o) => ({ ...o, snapshot: { ...o.snapshot!, manifestSha256: '0'.repeat(64) } }) }),
  },
};

const CANARY_PLACEHOLDER = '__S02_CANARY__';

// ---------------------------------------------------------------------------
// Writing saved runs

export async function writeRunManifest(runDir: string, runId: string): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const manifest: RunManifest = { formatVersion: 1, runId, createdAt: new Date(START).toISOString(), source: 'scorer_validation', description: 'Scorer-validation fixtures: scripted SDK streams, no model. Not a measurement of agent performance.' };
  await writeFile(path.join(runDir, RUN_FILE), serialize(manifest));
}

/**
 * Runs one variant through runInvestigation + evalQuery in a fresh workspace and saves
 * outcome.json, result.json and transcript.jsonl under `<runDir>/<evalId>/`.
 */
/** What a scripted session sees in a workspace: its real MCP output and attachment paths. */
export async function factsFor(root: string): Promise<Facts> {
  const loaded = await loadReport(root);
  const listed = listFailures(loaded);
  const failure = listed.failures[0];
  // A report without failures (S10): only the root and the list exist; nothing else may be used.
  if (!failure) return { root, list: listed, details: undefined as never, testId: '', spec: '', specText: '', errorContext: '', screenshot: undefined, trace: undefined };
  const detail = await getFailureDetails(loaded, failure.testId);
  const attachment = (name: string) => detail.attempts[0]?.attachments.find((a) => a.name === name && a.exists)?.path ?? undefined;
  return {
    root,
    list: listed,
    details: detail,
    testId: failure.testId,
    spec: failure.file,
    specText: await readFile(path.join(root, ...failure.file.split('/')), 'utf8'),
    errorContext: attachment('error-context') ?? 'test-results/missing/error-context.md',
    screenshot: attachment('screenshot'),
    trace: attachment('trace'),
  };
}

/** The variant's messages with the canary placeholder filled in for `scenarioId`. */
export async function sessionMessages(session: Session, scenarioId: string): Promise<SDKMessage[]> {
  const { canary } = await loadGroundTruth(scenarioId);
  return JSON.parse(JSON.stringify(session.messages).replaceAll(CANARY_PLACEHOLDER, canary)) as SDKMessage[];
}

/**
 * A fake SDK query that scripts a variant against whatever workspace the adapter created (it reads
 * the workspace from options.cwd). `calls` counts invocations, so tests can prove there is no retry.
 * `during` runs while the session streams (e.g. to tamper with the workspace).
 */
export function variantQuery(variant: Variant, scenarioId: string, calls = { n: 0 }, during?: (cwd: string) => Promise<void>): QueryFn {
  return ({ prompt, options }) => {
    calls.n++;
    const ready = (async () => {
      const session = await variant.session(await factsFor(options.cwd!));
      return fakeQuery({ messages: await sessionMessages(session, scenarioId), hang: session.hang, account: session.account }).query({ prompt, options });
    })();
    let handle: Awaited<typeof ready> | undefined;
    return {
      initializationResult: async () => (handle ??= await ready).initializationResult(),
      close: () => handle?.close(),
      async *[Symbol.asyncIterator]() {
        handle ??= await ready;
        let first = true;
        for await (const m of handle) {
          yield m;
          if (first && during) await during(options.cwd!);
          first = false;
        }
      },
    };
  };
}

/**
 * Runs one variant through runInvestigation + evalQuery in a fresh workspace and saves
 * outcome.json, result.json and transcript.jsonl under `<runDir>/<evalId>/`.
 */
/** `scenariosRoot`: where the truth the run is captured against lives (a test may use an edited copy). */
export async function writeEvaluation(runDir: string, evalId: string, snapshot: LoadedSnapshot, variant: Variant, workParent: string, scenariosRoot = SCENARIOS_DIR): Promise<void> {
  const markers = await leakMarkers();
  await mkdir(workParent, { recursive: true });
  const workspace = await createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent: workParent }, markers);
  try {
    const session = await variant.session(await factsFor(workspace.root));
    const messages = await sessionMessages(session, snapshot.manifest.scenarioId);
    const cliArgs = args(session.args ?? {});
    const context = { repoRoot: REPO_ROOT, workspace };
    const recorded: SDKMessage[] = [];
    const { query } = fakeQuery({ messages, hang: session.hang, account: session.account });
    let clock = START;
    const result = await runInvestigation(cliArgs, {
      repoRoot: workspace.root,
      query: evalQuery(query, context, (m) => recorded.push(m)),
      env: {},
      now: () => (clock += 20_000),
    });
    let outcome: RunOutcome = {
      formatVersion: 1,
      evalId,
      scenarioId: snapshot.manifest.scenarioId,
      attempt: Number(evalId.slice(4)),
      startedAt: new Date(START).toISOString(),
      finishedAt: new Date(START + 45_000).toISOString(),
      harness: { status: 'session_finished', detail: null },
      args: cliArgs,
      snapshot: { reportFingerprint: snapshot.manifest.reportFingerprint, manifestSha256: sha256(await readFile(path.join(snapshot.dir, MANIFEST_FILE))) },
      preflight: {
        capturedAt: new Date(START).toISOString(),
        truthSha256: sha256(await readFile(path.join(scenariosRoot, snapshot.manifest.scenarioId, 'truth.json'))),
        skillSha256: workspace.configFiles[0]!.sha256,
        settingsSha256: workspace.configFiles[1]!.sha256,
        sdkVersion: '0.3.302',
        nodeVersion: 'v24.0.0',
        session: sanitizeOptions(sessionOptions(cliArgs, context, {}).evaluation),
      },
      workspace: { root: workspace.root, protectedRoots: workspace.protectedRoots, auditBefore: { ok: true, problems: [] }, integrityAfter: await checkIntegrity(workspace) },
      repo: { unchanged: true },
      cleanup: { removed: true, error: null },
      configDifferences: describeDifferences(cliArgs, context, {}),
    };
    if (session.outcome) outcome = session.outcome(outcome);
    const dir = path.join(runDir, evalId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, OUTCOME_FILE), serialize(outcome));
    await writeFile(path.join(dir, RESULT_FILE), serialize(result));
    await writeFile(path.join(dir, TRANSCRIPT_FILE), recorded.map((m) => JSON.stringify(m)).join('\n') + (recorded.length ? '\n' : ''));
  } finally {
    await removeWorkspace(workspace);
  }
}

/** Saves a setup failure: no session, no result, no transcript. */
export async function writeSetupFailure(runDir: string, evalId: string, detail: string): Promise<void> {
  const outcome: RunOutcome = {
    formatVersion: 1,
    evalId,
    scenarioId: evalId.slice(0, 3),
    attempt: Number(evalId.slice(4)),
    startedAt: new Date(START).toISOString(),
    finishedAt: new Date(START + 1_000).toISOString(),
    harness: { status: 'setup_failed', detail },
    args: args(),
    preflight: { capturedAt: null, truthSha256: null, skillSha256: null, settingsSha256: null, sdkVersion: '0.3.302', nodeVersion: 'v24.0.0', session: null },
    snapshot: null,
    workspace: null,
    repo: { unchanged: null },
    cleanup: { removed: true, error: null },
    configDifferences: null,
  };
  await mkdir(path.join(runDir, evalId), { recursive: true });
  await writeFile(path.join(runDir, evalId, OUTCOME_FILE), serialize(outcome));
}

/** A fake-Playwright S02 snapshot under `<base>/snapshots/S02`. */
export async function goldenSnapshot(base: string, options: FakeRunOptions = {}): Promise<{ snapshot: LoadedSnapshot; snapshotsRoot: string }> {
  // The generator checks the attachments it was told to expect, so a reduced set is expected explicitly.
  return buildFakeSnapshot(base, options, options.attachments ? (config) => (config.expectObservation.attachments = options.attachments) : undefined);
}

/** The mixed run used by the aggregation test and the demo: one evaluation per variant. */
export const GOLDEN_RUN_ID = 'scorer-validation-golden';

export const MIXED = [
  'correct',
  'wrongClassification',
  'wrongRootCause',
  'abstention',
  'unsupportedEvidence',
  'failedRead',
  'mcpSnippetOnly',
  'unavailableEvidence',
  'incorrectRecommendation',
  'missingSkill',
  'missingMcp',
  'invalidOutput',
  'timeout',
  'sessionError',
  'authRefused',
  'leak',
  'protectedRead',
  'mcpUnavailable',
  'suspiciousPaths',
  'tampering',
  'fingerprintMismatch',
  'snapshotChanged',
] as const;

export async function writeMixedRun(base: string): Promise<{ runDir: string; snapshotsRoot: string; ids: Record<string, string> }> {
  const { snapshot, snapshotsRoot } = await goldenSnapshot(path.join(base, 'fixture'));
  const runDir = path.join(base, 'runs', GOLDEN_RUN_ID);
  const work = path.join(base, 'work');
  await mkdir(work, { recursive: true });
  await writeRunManifest(runDir, GOLDEN_RUN_ID);
  const ids: Record<string, string> = {};
  for (const [i, name] of MIXED.entries()) {
    const evalId = `S02-${String(i + 1).padStart(2, '0')}`;
    ids[name] = evalId;
    await writeEvaluation(runDir, evalId, snapshot, VARIANTS[name]!, work);
  }
  ids.setupFailure = `S02-${String(MIXED.length + 1).padStart(2, '0')}`;
  await writeSetupFailure(runDir, ids.setupFailure, 'workspace audit failed: unexpected file');
  return { runDir, snapshotsRoot, ids };
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node src/eval/test/golden.ts <outDir>');
    process.exit(2);
  }
  const { runDir, snapshotsRoot, ids } = await writeMixedRun(path.resolve(out));
  console.log(JSON.stringify({ runDir, snapshotsRoot, ids }, null, 2));
}
