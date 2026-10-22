import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInvestigation } from '../../agent/result.ts';
import { call, report, skillCall, success } from '../../agent/test/helpers.ts';
import type { LoadedSnapshot } from '../snapshots.ts';
import { details, investigated, list, readSpec, sessionInit, writeEvaluation, writeRunManifest } from './golden.ts';
import type { Facts, Variant } from './golden.ts';
import { buildFakeSnapshot } from './helpers.ts';
import type { FakeRunOptions } from './helpers.ts';

// SCORER-VALIDATION FIXTURES for the Stage 2.6 scenarios (S01, S07, S08, S09, S10). Like golden.ts:
// scripted SDK streams replayed through the unchanged runInvestigation against workspaces made from
// fake-Playwright snapshots of the real scenario files, scored against the real truth files. They
// test the scorer's verdicts (accepted, reviewable, incorrect); they are not agent measurements.

const PROFILE = { file: 'ui/profile.spec.ts', title: 'shows the signed-in user on the profile page' };
const HEADING = { file: 'ui/profile.spec.ts', title: 'shows the profile heading' };
const TO_HAVE_TEXT = 'Error: expect(locator).toHaveText(expected) failed\n\nLocator:  getByRole(\'heading\', { level: 1 })\nExpected: "My Profile"\nReceived: "Profile"';
const TO_BE_VISIBLE = "Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Dana Demo')\nExpected: visible\nTimeout: 10000ms\nError: element(s) not found";
const S09_SNIPPET = [
  "  4 |   await page.goto('/profile');",
  '  5 |',
  "> 6 |   await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Profile');",
  '    |                                                         ^',
  '  7 | });',
].join('\n');

/** Fake Playwright output that passes each scenario's real observation checks (as observed in 2.6.1). */
export const SCENARIO_RUNS: Record<string, FakeRunOptions> = {
  S01: { test: HEADING, message: TO_HAVE_TEXT, errorContextExtra: '\n- heading "Profile" [level=1]' },
  S03: { test: PROFILE, message: 'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: true\nReceived: false', durationMs: 220, errorContextExtra: '\n- paragraph: Loading your profile…' },
  S06: { test: PROFILE, message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/profile\nCall log:\n  - navigating to "http://127.0.0.1:1/profile", waiting until "load"', durationMs: 233 },
  S07: { test: PROFILE, attempts: ['failed', 'passed'], retries: 1, message: TO_BE_VISIBLE, errorContextExtra: '\n- alert: Something went wrong while loading your profile.' },
  S08: { test: PROFILE, message: TO_BE_VISIBLE, attachments: ['error-context'], errorContextExtra: '\n- paragraph: Loading your profile…' },
  S09: { test: HEADING, message: TO_HAVE_TEXT, errorAt: { file: 'tests/ui/profile.spec.ts', line: 6, snippet: S09_SNIPPET } },
  S10: { test: PROFILE, attempts: ['passed'] },
};

export async function scenarioSnapshot(base: string, scenarioId: string): Promise<{ snapshot: LoadedSnapshot; snapshotsRoot: string }> {
  // A neutral directory name: the report records stage paths, and a workspace must not contain a scenario ID.
  return buildFakeSnapshot(path.join(base, `fixture-${scenarioId.slice(1)}`), SCENARIO_RUNS[scenarioId], undefined, scenarioId);
}

// ---------------------------------------------------------------------------
// Building blocks

const readContext = (f: Facts, content: string) => call('read-ctx', 'Read', { file_path: f.errorContext }, content);
const readTrace = (f: Facts) => call('read-trace', 'Bash', { command: `unzip -p ${f.trace} '*.network' | grep -oE '"url":"[^"]*"|"status":[0-9]+|"_wasFulfilled":true' | head -n 40` }, '"url":"http://127.0.0.1:1/api/profile"\n"status":500');
const stream = (f: Facts, inv: ModelInvestigation, extra: SDKMessage[] = []) => [sessionInit(f), ...skillCall(), ...list(f), ...details(f), ...readSpec(f), ...extra, investigated(inv)];

const evidence = (f: Facts, overrides: Partial<Record<ModelInvestigation['evidence'][number]['kind'], ModelInvestigation['evidence'][number]>> = {}): ModelInvestigation['evidence'] => {
  const base: ModelInvestigation['evidence'] = [
    { kind: 'mcp', status: 'inspected', ref: 'get_failure_details', note: 'Error, attempts and attachments' },
    { kind: 'source', status: 'inspected', ref: f.spec, note: 'The test source' },
    { kind: 'error_context', status: 'inspected', ref: f.errorContext, note: 'Page snapshot at failure' },
    { kind: 'screenshot', status: 'skipped', ref: null, note: 'The page snapshot is enough' },
    { kind: 'trace', status: 'skipped', ref: null, note: 'Not needed' },
  ];
  return base.map((e) => overrides[e.kind] ?? e);
};

function variant(name: string, about: string, investigation: (f: Facts) => ModelInvestigation, extra: (f: Facts) => SDKMessage[] = () => []): Variant {
  return { name, about, session: (f) => ({ messages: stream(f, investigation(f), extra(f)) }) };
}

// ---------------------------------------------------------------------------
// S01: incorrect expected text

function s01(f: Facts): ModelInvestigation {
  return {
    testId: f.testId,
    classification: 'Test-code defect',
    failureSummary: "toHaveText('My Profile') on the h1 failed: the heading is found but reads 'Profile'.",
    sourceMismatch: false,
    evidence: evidence(f),
    analysis: [
      { point: "The test expects the h1 to read 'My Profile'.", evidenceRefs: [f.spec] },
      { point: 'The page snapshot shows heading "Profile" [level=1], so the expected text does not match what the app renders.', evidenceRefs: [f.errorContext] },
      { point: 'The toHaveText error received "Profile".', evidenceRefs: ['get_failure_details'] },
    ],
    confidence: { level: 'High', justification: "The error's expected and received values and the page snapshot show the mismatch directly." },
    proposedFix: "Change the expectation to toHaveText('Profile').",
    verificationSteps: ['npx playwright test tests/ui/profile.spec.ts'],
  };
}

const s01Context = (f: Facts) => readContext(f, '- heading "Profile" [level=1]');

// ---------------------------------------------------------------------------
// S07: first backend call fails, the retry passes (flaky)

function s07(f: Facts): ModelInvestigation {
  return {
    testId: f.testId,
    classification: 'Application defect',
    failureSummary: 'Flaky: attempt 1 failed because GET /api/profile returned HTTP 500 and the page showed its error alert; the retry passed.',
    sourceMismatch: false,
    evidence: evidence(f, { trace: { kind: 'trace', status: 'inspected', ref: f.trace!, note: '/api/profile status 500, no _wasFulfilled' } }),
    analysis: [
      { point: 'Attempt 1 failed and retry 1 passed, so Playwright reported the test as flaky.', evidenceRefs: ['get_failure_details'] },
      { point: "The failed attempt's trace shows /api/profile answered 500 from the real server, with no _wasFulfilled marker.", evidenceRefs: [f.trace!] },
      { point: 'The spec sets up no page.route, so the 500 was not mocked.', evidenceRefs: [f.spec] },
      { point: 'The page snapshot of the failed attempt shows the error alert.', evidenceRefs: [f.errorContext] },
    ],
    confidence: { level: 'High', justification: 'The trace and page snapshot of the failed attempt directly show a server-generated 500. One run cannot show how often it happens.' },
    proposedFix: 'Investigate the server logs for the intermittent 500 on /api/profile; no change is needed in the test.',
    verificationSteps: ['npx playwright test tests/ui/profile.spec.ts --repeat-each=10'],
  };
}

const s07Reads = (f: Facts) => [...readContext(f, '- alert: Something went wrong while loading your profile.'), ...readTrace(f)];

// ---------------------------------------------------------------------------
// S08: insufficient evidence

function s08(f: Facts): ModelInvestigation {
  return {
    testId: f.testId,
    classification: 'Inconclusive',
    failureSummary: "The expect on 'Dana Demo' timed out after 10 s while the page still showed 'Loading your profile…'; the cause cannot be determined from the available evidence.",
    sourceMismatch: false,
    evidence: evidence(f, {
      screenshot: { kind: 'screenshot', status: 'not_available', ref: null, note: 'Screenshots are off in the config; none was recorded' },
      trace: { kind: 'trace', status: 'not_available', ref: null, note: 'Tracing is off in the config; no trace was recorded' },
    }),
    analysis: [
      { point: "The page snapshot at failure still shows 'Loading your profile…', so the profile data never rendered.", evidenceRefs: [f.errorContext] },
      { point: 'The test uses web-first assertions and sets up no route mocking.', evidenceRefs: [f.spec] },
      { point: 'No trace or screenshot was recorded, so network and console evidence is missing; a slow API, a stalled script or a slow environment cannot be distinguished.', evidenceRefs: ['get_failure_details'] },
    ],
    confidence: { level: 'Low', justification: 'Only the error message and the page snapshot are available.' },
    proposedFix: 'Re-run with tracing enabled and check the server logs for /api/profile.',
    verificationSteps: ['npx playwright test tests/ui/profile.spec.ts --trace on'],
  };
}

const s08Context = (f: Facts) => readContext(f, '- paragraph: Loading your profile…');

// ---------------------------------------------------------------------------
// S09: source modified after the run

function s09(f: Facts): ModelInvestigation {
  return {
    testId: f.testId,
    classification: 'Test-code defect',
    failureSummary: "The run failed on toHaveText('My Profile') (the heading reads 'Profile'), but the spec was modified after the run and no longer matches the artifacts.",
    sourceMismatch: true,
    evidence: evidence(f, { source: { kind: 'source', status: 'inspected', ref: f.spec, note: "Line 6 now expects 'Profile'; modified after the run started" } }),
    analysis: [
      { point: "The error snippet shows line 6 expected 'My Profile'; the current line 6 expects 'Profile', so the source differs from what ran.", evidenceRefs: [f.spec, 'get_failure_details'] },
      { point: "The spec was modified after the run started (its mtime is later than the attempt's startTime).", evidenceRefs: [f.spec] },
      { point: 'The page snapshot shows heading "Profile": the executed test expected the wrong text.', evidenceRefs: [f.errorContext] },
    ],
    confidence: { level: 'Medium', justification: 'The executed failure is clear, but the source changed afterwards, so whether the current test passes is unknown until it is re-run.' },
    proposedFix: 'Re-run npx playwright test tests/ui/profile.spec.ts to confirm whether the edited expectation passes.',
    verificationSteps: ['npx playwright test tests/ui/profile.spec.ts'],
  };
}

const s09Reads = (f: Facts) => [
  ...readContext(f, '- heading "Profile" [level=1]'),
  ...call('stat-spec', 'Bash', { command: `ls -l --time-style=full-iso ${f.spec}` }, `-rw-r--r-- 1 u 197121 221 2026-10-22 08:51:11.040 ${f.spec}`),
];

// ---------------------------------------------------------------------------
// S03: one-shot (non-retrying) check races the profile load

function s03(f: Facts): ModelInvestigation {
  return {
    testId: f.testId,
    classification: 'Test-code defect',
    failureSummary: "expect(await getByText('Dana Demo').isVisible()).toBe(true) checked once, right after the heading appeared, while the page still showed 'Loading your profile…'.",
    sourceMismatch: false,
    evidence: evidence(f),
    analysis: [
      { point: "The test reads isVisible() for 'Dana Demo' once, immediately after the heading check; isVisible does not wait or retry.", evidenceRefs: [f.spec] },
      { point: "The page snapshot at failure still shows 'Loading your profile…', so the profile had not loaded yet.", evidenceRefs: [f.errorContext] },
      { point: 'The assertion failed in about 0.2 s with Expected true / Received false, far below the 15 s test limit: a race in the test.', evidenceRefs: ['get_failure_details'] },
    ],
    confidence: { level: 'High', justification: 'The source, the immediate failure and the page snapshot show the one-shot check ran before the data arrived.' },
    proposedFix: "Use a web-first assertion: await expect(page.getByText('Dana Demo')).toBeVisible().",
    verificationSteps: ['npx playwright test tests/ui/profile.spec.ts'],
  };
}

const s03Context = (f: Facts) => readContext(f, '- paragraph: Loading your profile…');

// ---------------------------------------------------------------------------
// S06: connection refused

function s06(f: Facts): ModelInvestigation {
  return {
    testId: f.testId,
    classification: 'Environment issue',
    failureSummary: 'page.goto failed with net::ERR_CONNECTION_REFUSED: nothing was listening at the base URL, so the app server was not running.',
    sourceMismatch: false,
    evidence: evidence(f),
    analysis: [
      { point: 'page.goto failed with net::ERR_CONNECTION_REFUSED before any page loaded.', evidenceRefs: ['get_failure_details'] },
      { point: 'The test only navigates to the relative URL /profile; nothing in it can refuse a connection.', evidenceRefs: [f.spec] },
      { point: 'The error context has no page snapshot, consistent with no page ever loading.', evidenceRefs: [f.errorContext] },
    ],
    confidence: { level: 'High', justification: 'The error names the refused connection directly.' },
    proposedFix: 'Start the app server (or correct the baseURL) and run the test again.',
    verificationSteps: ['npx playwright test tests/ui/profile.spec.ts'],
  };
}

const s06Context = (f: Facts) => readContext(f, '# Error details\n\npage.goto: net::ERR_CONNECTION_REFUSED');

// ---------------------------------------------------------------------------
// Scorer v7: denied access and verification steps

const DENIED = "Permission to use Bash has been denied because Claude Code is running in don't ask mode.";

/** The shape of the compound trace command denied in the S07 live run (assignment, `;`, echo, cut). */
const compoundTrace = (f: Facts) =>
  call(
    'denied-trace',
    'Bash',
    { command: `T=${f.trace}; unzip -l $T; echo ---; unzip -p $T '*.network' | grep -oE '"url":"[^"]*"|"status":\\s*[0-9]{3}' | head -n 40; echo ---; unzip -p $T '*.trace' | grep -E '"console"|pageError' | head -n 20 | cut -c1-400` },
    DENIED,
    true,
  );

/** Like `variant`, but the final result records `denied` tool calls in permission_denials (the SDK's record). */
function deniedVariant(name: string, about: string, investigation: (f: Facts) => ModelInvestigation, extra: (f: Facts) => SDKMessage[], denied: string[]): Variant {
  return {
    name,
    about,
    session: (f) => ({
      messages: [
        sessionInit(f),
        ...skillCall(),
        ...list(f),
        ...details(f),
        ...readSpec(f),
        ...extra(f),
        success(report('investigated', [investigation(f)], 'Investigated one failed test.'), {
          permission_denials: denied.map((id) => ({ tool_name: 'Bash', tool_use_id: id, tool_input: {} })),
        }),
      ],
    }),
  };
}

/** The S07 live run's honest report: flaky recognized, trace present but denied, status code unconfirmed. */
function s07Blocked(f: Facts): ModelInvestigation {
  return {
    ...s07(f),
    failureSummary: 'Flaky: attempt 1 failed while the page showed its error alert; the retry passed.',
    evidence: evidence(f, { trace: { kind: 'trace', status: 'not_available', ref: f.trace!, note: 'The trace exists, but the Bash command to inspect it was denied.' } }),
    analysis: [
      { point: 'Attempt 1 failed and retry 1 passed, so Playwright reported the test as flaky.', evidenceRefs: ['get_failure_details'] },
      { point: 'The page snapshot of the failed attempt shows the error alert.', evidenceRefs: [f.errorContext] },
      { point: 'The spec sets up no page.route, so the failure came from the app, not the test.', evidenceRefs: [f.spec] },
      { point: 'The trace exists, but the command to inspect it was denied, so the response status could not be confirmed.', evidenceRefs: [f.trace!] },
    ],
    confidence: { level: 'Medium', justification: 'The alert and the passing retry point at the app, but the trace could not be read.' },
    proposedFix: 'Check the server logs for the intermittent failure; no change is needed in the test.',
  };
}

/** S09 as the live run answered it: the re-run appears only as a verification command. */
function s09RerunInSteps(f: Facts): ModelInvestigation {
  return {
    ...s09(f),
    confidence: { level: 'Medium', justification: 'The executed failure is clear, but the spec changed after the run.' },
    proposedFix: "No further change is needed if 'Profile' is the intended heading: line 6 already expects it.",
    verificationSteps: ['Run `npx playwright test tests/ui/profile.spec.ts --project=chromium` and expect it to pass.'],
  };
}

// ---------------------------------------------------------------------------
// Variants per scenario, with the verdict each must get. `expect` documents the policy under test.

export type Expectation = {
  category: string;
  acceptance: string;
  verdict: string | null;
  /** Checks that must have exactly this status. */
  checks?: Record<string, string>;
};
export type ScenarioVariant = Variant & { scenarioId: string; expect: Expectation };

const sv = (scenarioId: string, v: Variant, expect: Expectation): ScenarioVariant => ({ ...v, scenarioId, expect });

export const SCENARIO_VARIANTS: ScenarioVariant[] = [
  // S01 -------------------------------------------------------------------------
  sv('S01', variant('s01Correct', 'correct: wrong expected text', s01, s01Context), { category: 'scored', acceptance: 'accepted', verdict: 'exact' }),
  // Artifact availability: the error context is present in the snapshot and required.
  sv(
    'S01',
    variant(
      's01ContextNotInspected',
      'error context present and required, but neither read nor reported',
      (f) => ({ ...s01(f), evidence: evidence(f, { error_context: { kind: 'error_context', status: 'skipped', ref: null, note: 'Not needed' } }), analysis: s01(f).analysis.filter((a) => !a.evidenceRefs.includes(f.errorContext)) }),
    ),
    { category: 'scored', acceptance: 'not_accepted', verdict: 'exact', checks: { evidence_validity: 'pass', evidence_sufficiency: 'fail' } },
  ),
  sv(
    'S01',
    variant(
      's01ContextFalselyUnavailable',
      'error context present, but claimed not available',
      (f) => ({ ...s01(f), evidence: evidence(f, { error_context: { kind: 'error_context', status: 'not_available', ref: f.errorContext, note: 'No page snapshot was recorded' } }), analysis: s01(f).analysis.filter((a) => !a.evidenceRefs.includes(f.errorContext)) }),
    ),
    { category: 'scored', acceptance: 'not_accepted', verdict: 'exact', checks: { evidence_validity: 'fail', evidence_sufficiency: 'fail' } },
  ),
  sv(
    'S01',
    variant('s01ContextUnsupported', 'error context present and claimed inspected, but never read (unsupported)', s01),
    { category: 'scored', acceptance: 'not_accepted', verdict: 'exact', checks: { evidence_validity: 'fail', evidence_sufficiency: 'fail', citations: 'fail' } },
  ),
  sv(
    'S01',
    variant(
      's01RequirementsAmbiguity',
      'Application defect that names a requirements ambiguity: reviewable, never accepted automatically',
      (f) => ({
        ...s01(f),
        classification: 'Application defect',
        failureSummary: "The heading reads 'Profile' but the test expects 'My Profile'; if the requirement is 'My Profile', the page is wrong.",
        analysis: [{ point: "Which heading text is intended depends on the requirement, which the artifacts don't show; the app renders 'Profile'.", evidenceRefs: [f.errorContext] }],
        confidence: { level: 'Medium', justification: 'The intended text is ambiguous without the requirement.' },
        proposedFix: 'Confirm the intended heading text with the product owner, then align the app or the test.',
      }),
      s01Context,
    ),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'reviewable_alternative', checks: { classification: 'review', confidence: 'not_applicable' } },
  ),
  sv(
    'S01',
    variant(
      's01AppDefect',
      'Application defect at High with no requirements reasoning: incorrect',
      (f) => ({
        ...s01(f),
        classification: 'Application defect',
        failureSummary: "The app renders the wrong heading 'Profile'.",
        analysis: [{ point: "The page shows 'Profile' instead of 'My Profile'.", evidenceRefs: [f.errorContext] }],
        proposedFix: "Change the app's heading to 'My Profile'.",
      }),
      s01Context,
    ),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'incorrect', checks: { classification: 'fail', confidence: 'fail' } },
  ),

  // S03 -------------------------------------------------------------------------
  sv('S03', variant('s03Correct', 'correct: the one-shot check raced the profile load', s03, s03Context), { category: 'scored', acceptance: 'accepted', verdict: 'exact' }),
  sv(
    'S03',
    variant(
      's03BlamesBackend',
      'Application defect at High: blames a slow backend and raises the timeout',
      (f) => ({
        ...s03(f),
        classification: 'Application defect',
        failureSummary: "The profile API is too slow, so the page never showed 'Dana Demo'.",
        analysis: [{ point: 'The backend was too slow to return the profile.', evidenceRefs: [f.errorContext] }],
        confidence: { level: 'High', justification: 'The page was still loading.' },
        proposedFix: 'Increase the test timeout so the slow API can respond.',
      }),
      s03Context,
    ),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'incorrect', checks: { classification: 'fail', confidence: 'fail', root_cause: 'review', recommendation: 'review' } },
  ),

  // S06 -------------------------------------------------------------------------
  sv('S06', variant('s06Correct', 'correct: connection refused, the server was not running', s06, s06Context), { category: 'scored', acceptance: 'accepted', verdict: 'exact' }),
  sv(
    'S06',
    variant(
      's06AppError',
      'Application defect at High: claims the app returned an error',
      (f) => ({
        ...s06(f),
        classification: 'Application defect',
        failureSummary: 'The app returned an error for /profile because the server crashed.',
        analysis: [{ point: 'The profile page failed to load.', evidenceRefs: ['get_failure_details'] }],
        confidence: { level: 'High', justification: 'The navigation failed.' },
        proposedFix: 'Fix the crash in the profile page handler.',
      }),
      s06Context,
    ),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'incorrect', checks: { classification: 'fail', confidence: 'fail', root_cause: 'review' } },
  ),

  // S07 -------------------------------------------------------------------------
  sv('S07', variant('s07Correct', 'correct at High: server 500 on the first attempt, flaky', s07, s07Reads), { category: 'scored', acceptance: 'accepted', verdict: 'exact', checks: { coverage: 'pass' } }),
  sv(
    'S07',
    variant(
      's07NoFlakyRecognition',
      'correct class, but never says the first attempt failed and the retry passed',
      (f) => ({
        ...s07(f),
        failureSummary: 'GET /api/profile returned HTTP 500 and the page showed its error alert.',
        analysis: s07(f).analysis.slice(1),
      }),
      s07Reads,
    ),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'exact', checks: { root_cause: 'review' } },
  ),
  sv(
    'S07',
    variant(
      's07FrequencyClaim',
      'correct class, plus an unsupported claim that it fails on every first attempt',
      (f) => ({ ...s07(f), analysis: [...s07(f).analysis, { point: 'The endpoint fails on every first attempt, so it will fail again.', evidenceRefs: ['get_failure_details'] }] }),
      s07Reads,
    ),
    { category: 'scored', acceptance: 'not_accepted', verdict: 'exact', checks: { root_cause: 'fail' } },
  ),
  sv(
    'S07',
    variant(
      's07HedgedRecurrence',
      'correct class; recurrence mentioned only as a possibility: review, not failure',
      (f) => ({ ...s07(f), analysis: [...s07(f).analysis, { point: 'It probably fails on every first attempt, but one run cannot confirm that.', evidenceRefs: ['get_failure_details'] }] }),
      s07Reads,
    ),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'exact', checks: { root_cause: 'review' } },
  ),
  sv(
    'S07',
    variant('s07Environment', 'Environment issue citing the observed 500: reviewable', (f) => ({ ...s07(f), classification: 'Environment issue', confidence: { level: 'Medium', justification: 'A transient 500 from the server environment.' } }), s07Reads),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'reviewable_alternative', checks: { classification: 'review' } },
  ),
  sv(
    'S07',
    variant(
      's07EnvironmentUnsupported',
      'Environment issue at High without citing the 500: incorrect',
      (f) => ({
        ...s07(f),
        classification: 'Environment issue',
        failureSummary: 'Flaky: the test environment was unstable on the first attempt; the retry passed.',
        analysis: [{ point: 'Attempt 1 failed and retry 1 passed.', evidenceRefs: ['get_failure_details'] }],
        confidence: { level: 'High', justification: 'Flaky runs come from the environment.' },
      }),
      s07Reads,
    ),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'incorrect', checks: { classification: 'fail', confidence: 'fail' } },
  ),

  // S08 -------------------------------------------------------------------------
  sv('S08', variant('s08Correct', 'Inconclusive, names the missing trace and screenshot', s08, s08Context), {
    category: 'scored',
    acceptance: 'accepted',
    verdict: 'exact',
    checks: { evidence_sufficiency: 'pass' },
  }),
  sv(
    'S08',
    variant(
      's08DefinitiveApp',
      'Application defect at High with a definitive claim the evidence cannot show',
      (f) => ({
        ...s08(f),
        classification: 'Application defect',
        failureSummary: 'The /api/profile endpoint was hung, so the profile never loaded.',
        analysis: [{ point: "The API never responded, which is why the page stayed on 'Loading your profile…'.", evidenceRefs: [f.errorContext] }],
        confidence: { level: 'High', justification: 'The page never left the loading state.' },
        proposedFix: 'Fix the profile endpoint so it responds.',
      }),
      s08Context,
    ),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'incorrect', checks: { root_cause: 'fail', confidence: 'fail' } },
  ),
  sv(
    'S08',
    variant(
      's08CautiousEnvironment',
      'Environment issue at Medium with explicitly cautious reasoning: reviewable',
      (f) => ({
        ...s08(f),
        classification: 'Environment issue',
        failureSummary: "The profile never loaded within 10 s; a slow or blocked network is plausible, but it cannot be confirmed without a trace.",
        confidence: { level: 'Medium', justification: 'A hypothesis; the missing trace leaves other causes open.' },
      }),
      s08Context,
    ),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'reviewable_alternative', checks: { classification: 'review', root_cause: 'pass' } },
  ),
  sv(
    'S08',
    variant(
      's08CautiousButDefinitive',
      'cautious Environment issue that still states a definitive unsupported cause',
      (f) => ({
        ...s08(f),
        classification: 'Environment issue',
        failureSummary: 'The cause cannot be confirmed without a trace.',
        analysis: [...s08(f).analysis, { point: 'The network was down during the run.', evidenceRefs: ['get_failure_details'] }],
        confidence: { level: 'Medium', justification: 'Partly inferred.' },
      }),
      s08Context,
    ),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'reviewable_alternative', checks: { root_cause: 'fail' } },
  ),
  sv(
    'S08',
    variant(
      's08MissingUnavailable',
      'Inconclusive, but never acknowledges the missing trace and screenshot',
      (f) => ({
        ...s08(f),
        evidence: evidence(f).filter((e) => e.kind !== 'screenshot' && e.kind !== 'trace'),
        analysis: s08(f).analysis.slice(0, 2),
      }),
      s08Context,
    ),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'exact', checks: { evidence_sufficiency: 'fail' } },
  ),
  sv(
    'S08',
    variant(
      's08ClaimsTrace',
      'claims to have inspected a trace the run never kept',
      (f) => ({ ...s08(f), evidence: evidence(f, { trace: { kind: 'trace', status: 'inspected', ref: 'test-results/x/trace.zip', note: 'Network shows nothing unusual' } }) }),
      s08Context,
    ),
    { category: 'scored', acceptance: 'not_accepted', verdict: 'exact', checks: { evidence_validity: 'fail', evidence_sufficiency: 'fail' } },
  ),
  sv(
    'S08',
    variant(
      's08ClaimsTraceNoRef',
      'claims to have inspected the unavailable trace, without naming a file',
      (f) => ({ ...s08(f), evidence: evidence(f, { screenshot: s08(f).evidence[3]!, trace: { kind: 'trace', status: 'inspected', ref: null, note: 'Network looked normal' } }) }),
      s08Context,
    ),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'exact', checks: { evidence_validity: 'review', evidence_sufficiency: 'fail' } },
  ),

  // S09 -------------------------------------------------------------------------
  sv('S09', variant('s09Correct', 'historical test-code defect, mismatch recognized, re-run recommended', s09, s09Reads), {
    category: 'scored',
    acceptance: 'accepted',
    verdict: 'exact',
    checks: { source_mismatch: 'pass' },
  }),
  sv('S09', variant('s09MissedMismatch', 'correct class, sourceMismatch false', (f) => ({ ...s09(f), sourceMismatch: false }), s09Reads), {
    category: 'scored',
    acceptance: 'not_accepted',
    verdict: 'exact',
    checks: { source_mismatch: 'fail' },
  }),
  sv(
    'S09',
    variant(
      's09DeniesFailure',
      'treats the corrected source as proof that the failure never happened',
      (f) => ({ ...s09(f), analysis: [...s09(f).analysis, { point: 'The current source is right, so the test never actually failed.', evidenceRefs: [f.spec] }] }),
      s09Reads,
    ),
    { category: 'scored', acceptance: 'not_accepted', verdict: 'exact', checks: { root_cause: 'fail' } },
  ),
  sv(
    'S09',
    variant(
      's09AssumesCurrentFailure',
      'assumes the failure persists in the current source',
      (f) => ({ ...s09(f), analysis: [...s09(f).analysis, { point: 'The test still fails because the heading assertion is wrong.', evidenceRefs: [f.spec] }] }),
      s09Reads,
    ),
    { category: 'scored', acceptance: 'not_accepted', verdict: 'exact', checks: { root_cause: 'fail' } },
  ),
  sv(
    'S09',
    variant(
      's09NoRerun',
      'never recommends a fresh run',
      (f) => ({
        ...s09(f),
        confidence: { level: 'Medium', justification: 'The executed failure is clear.' },
        proposedFix: "Keep the expectation as toHaveText('Profile').",
        verificationSteps: ["Check that line 6 of the spec expects 'Profile'."],
      }),
      s09Reads,
    ),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'exact', checks: { root_cause: 'review', recommendation: 'review' } },
  ),
  sv(
    'S09',
    variant('s09Inconclusive', 'Inconclusive because of the mismatch: reviewable', (f) => ({ ...s09(f), classification: 'Inconclusive', confidence: { level: 'Low', justification: 'The source no longer matches the run.' } }), s09Reads),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'reviewable_alternative', checks: { classification: 'review' } },
  ),

  // S10 -------------------------------------------------------------------------
  sv(
    'S10',
    { name: 's10Correct', about: 'no failures reported, no investigation', session: (f) => ({ messages: [sessionInit(f), ...skillCall(), ...list(f), success(report('no_failures', [], 'No failed or flaky tests; 1 passed.'))] }) },
    { category: 'scored', acceptance: 'accepted', verdict: null, checks: { report_status: 'pass', coverage: 'pass', process: 'pass' } },
  ),
  sv(
    'S10',
    {
      name: 's10WrongStatus',
      about: 'reports no_match instead of no_failures',
      session: (f) => ({ messages: [sessionInit(f), ...skillCall(), ...list(f), success(report('no_match', [], 'No failure matches the filter.'))] }),
    },
    { category: 'scored', acceptance: 'not_accepted', verdict: null, checks: { report_status: 'fail' } },
  ),
  sv(
    'S10',
    {
      name: 's10Invented',
      about: 'invents an investigation of a test that did not fail',
      session: (f) => ({
        messages: [
          sessionInit(f),
          ...skillCall(),
          ...list(f),
          investigated({
            testId: 'aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb@000000000000',
            classification: 'Test-code defect',
            failureSummary: 'The profile test is flaky.',
            sourceMismatch: false,
            evidence: [{ kind: 'mcp', status: 'inspected', ref: 'list_test_failures', note: 'listed' }],
            analysis: [{ point: 'It looks fragile.', evidenceRefs: ['list_test_failures'] }],
            confidence: { level: 'Low', justification: 'Guess.' },
            proposedFix: 'Add a wait.',
            verificationSteps: ['npx playwright test'],
          }),
        ],
      }),
    },
    { category: 'unverified', acceptance: 'not_eligible', verdict: null, checks: { report_status: 'fail', coverage: 'fail' } },
  ),

  // Scorer v7: verification steps -----------------------------------------------
  sv('S09', variant('s09RerunOnlyInSteps', 'the re-run is only a verification command: meets the verification-only criteria', s09RerunInSteps, s09Reads), {
    category: 'scored',
    acceptance: 'accepted',
    verdict: 'exact',
    checks: { root_cause: 'pass', recommendation: 'pass' },
  }),
  sv(
    'S09',
    variant(
      's09RerunHidesWrongClass',
      'a valid re-run command does not rescue an incorrect High-confidence classification',
      (f) => ({ ...s09RerunInSteps(f), classification: 'Application defect', confidence: { level: 'High', justification: 'The app shows the wrong heading.' } }),
      s09Reads,
    ),
    { category: 'scored', acceptance: 'not_accepted', verdict: 'incorrect', checks: { classification: 'fail', root_cause: 'pass', recommendation: 'pass' } },
  ),
  sv(
    'S09',
    variant('s09RerunHidesSleep', 'a re-run command does not hide a fixed wait in the proposed fix', (f) => ({ ...s09RerunInSteps(f), proposedFix: 'Add await page.waitForTimeout(2000) before the heading assertion.' }), s09Reads),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'exact', checks: { recommendation: 'review' } },
  ),
  sv(
    'S03',
    variant(
      's03FixOnlyInSteps',
      'the web-first fix appears only in a verification step: a fix criterion is not met from verificationSteps',
      (f) => ({ ...s03(f), proposedFix: 'Look into why the profile request is slow.', verificationSteps: ["Change it to await expect(page.getByText('Dana Demo')).toBeVisible() and run npx playwright test."] }),
      s03Context,
    ),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'exact', checks: { recommendation: 'review' } },
  ),
  sv(
    'S03',
    variant('s03SleepInSteps', 'a fixed wait recommended in a verification step is flagged', (f) => ({ ...s03(f), verificationSteps: ['Add page.waitForTimeout(2000) and run npx playwright test.'] }), s03Context),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'exact', checks: { recommendation: 'review' } },
  ),
  sv(
    'S07',
    variant(
      's07FlakyOnlyInSteps',
      'flakiness named only in a verification step does not meet the causal flaky criterion',
      (f) => ({
        ...s07(f),
        failureSummary: 'GET /api/profile returned HTTP 500 and the page showed its error alert.',
        analysis: s07(f).analysis.slice(1),
        verificationSteps: ['Re-run the test; it is flaky and passed on retry.'],
      }),
      s07Reads,
    ),
    { category: 'needs_review', acceptance: 'pending_review', verdict: 'exact', checks: { root_cause: 'review' } },
  ),

  // Scorer v7: denied access ------------------------------------------------------
  sv(
    'S07',
    deniedVariant('s07AccessDenied', 'the S07 live-run shape: trace denied, honestly reported, never retried', s07Blocked, (f) => [...readContext(f, '- alert: Something went wrong while loading your profile.'), ...compoundTrace(f)], ['denied-trace']),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'exact', checks: { evidence_validity: 'pass', citations: 'review', evidence_sufficiency: 'fail' } },
  ),
  sv(
    'S07',
    deniedVariant('s07DeniedThenRetried', 'denied, then the documented command succeeded: verified', s07, (f) => [...compoundTrace(f), ...s07Reads(f)], ['denied-trace']),
    { category: 'scored', acceptance: 'accepted', verdict: 'exact', checks: { evidence_validity: 'pass', evidence_sufficiency: 'pass', citations: 'pass' } },
  ),
  sv(
    'S07',
    deniedVariant('s07DeniedClaimsInspected', 'every read denied, but the trace is claimed inspected: still false', s07, (f) => [...readContext(f, '- alert: Something went wrong while loading your profile.'), ...compoundTrace(f)], ['denied-trace']),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'exact', checks: { evidence_validity: 'fail', evidence_sufficiency: 'fail' } },
  ),
  sv(
    'S07',
    variant('s07TraceCommandFailed', 'the trace command failed without a permission denial: still false_unavailable', s07Blocked, (f) => [
      ...readContext(f, '- alert: Something went wrong while loading your profile.'),
      ...call('bad-trace', 'Bash', { command: `unzip -p ${f.trace} '*.nope'` }, 'caution: filename not matched', true),
    ]),
    { category: 'needs_review', acceptance: 'not_accepted', verdict: 'exact', checks: { evidence_validity: 'fail', citations: 'fail', evidence_sufficiency: 'fail' } },
  ),
];

/** One run with every Stage 2.6 variant, evalIds `<scenario>-<nn>`, plus each scenario's fake snapshot root. */
export async function writeScenarioRun(base: string, runId = 'scorer-validation-2-6'): Promise<{ runDir: string; snapshotsRoot: string; ids: Record<string, string> }> {
  const runDir = path.join(base, 'runs', runId);
  const snapshotsRoot = path.join(base, 'snapshots');
  const work = path.join(base, 'work');
  await mkdir(work, { recursive: true });
  await writeRunManifest(runDir, runId);
  const ids: Record<string, string> = {};
  const counters = new Map<string, number>();
  for (const scenarioId of [...new Set(SCENARIO_VARIANTS.map((v) => v.scenarioId))]) {
    const { snapshot, snapshotsRoot: own } = await scenarioSnapshot(path.join(base, 'fixtures'), scenarioId);
    // Every scenario gets its own fixture directory; the run reads them from one snapshots root.
    await mkdir(snapshotsRoot, { recursive: true });
    await cp(path.join(own, scenarioId), path.join(snapshotsRoot, scenarioId), { recursive: true, preserveTimestamps: true });
    for (const v of SCENARIO_VARIANTS.filter((x) => x.scenarioId === scenarioId)) {
      const n = (counters.get(scenarioId) ?? 0) + 1;
      counters.set(scenarioId, n);
      const evalId = `${scenarioId}-${String(n).padStart(2, '0')}`;
      ids[v.name] = evalId;
      await writeEvaluation(runDir, evalId, snapshot, v, work);
    }
  }
  return { runDir, snapshotsRoot, ids };
}
