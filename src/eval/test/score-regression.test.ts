import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { MCP_DETAILS, MCP_LIST, MCP_TRACE } from '../../agent/config.ts';
import type { ModelInvestigation } from '../../agent/result.ts';
import { call, skillCall } from '../../agent/test/helpers.ts';
import { loadReport } from '../../mcp/report.ts';
import { getTraceSummary } from '../../mcp/trace-summary.ts';
import { call as traceRecord, ORIGIN, pageTrace, resource, T0 } from '../../mcp/test/traces.ts';
import { scoreRun } from '../runs.ts';
import { SCENARIOS_DIR } from '../scenarios.ts';
import { SCORER_VERSION } from '../score.ts';
import type { AcceptanceStatus, CheckId, ClassificationVerdict, ScoreRecord } from '../score.ts';
import { sha256 } from '../snapshots.ts';
import { loadGroundTruth } from '../truth.ts';
import type { GroundTruth } from '../truth.ts';
import { details, investigated, list, readSpec, sessionInit, writeEvaluation, writeRunManifest } from './golden.ts';
import type { Facts } from './golden.ts';
import { buildFakeSnapshot } from './helpers.ts';
import type { FakeRunOptions } from './helpers.ts';

// R1 GROUND-TRUTH REGRESSION CORPUS (scorer-validation fixtures, not agent data). Paraphrased
// diagnoses and fixes for S11, S13 and S14, each scripted as a full session, replayed through the
// unchanged runInvestigation against a fake-Playwright snapshot of the real scenario files, and
// scored by scoreRun -> scoreEvaluation against the REAL truth files. The evidence is valid and
// complete in every case (spec and page snapshot read, S13's trace through the real
// get_trace_summary output), so only the text under test decides the root-cause, recommendation and
// classification checks. Each case states the exact criterion and forbidden-item results, the
// classification verdict and the acceptance outcome it must get under scorer v8.
//
// Cases marked `limitation` are CHARACTERIZATION tests: they pin today's behavior, which differs
// from the behavior we would want (stated in `desired`). They are not endorsements: a change that
// fixes one must update the case and the README table, not be blocked by it.

const RECORDED_UNDER = 8;

type Classification = ModelInvestigation['classification'];
type Level = ModelInvestigation['confidence']['level'];
type Ref = 'spec' | 'ctx' | 'details' | 'trace';
type Point = [text: string, ref: Ref];
type Flags = Record<string, 'review' | 'fail'>;
type Category = 'A' | 'B' | 'C' | 'D' | 'E';

type Expect = {
  verdict: ClassificationVerdict;
  /** A wrong classification at High confidence (fails the confidence check). */
  highConfidenceIncorrect?: true;
  /** Root-cause criteria that go to review (no pattern matched); every other criterion must pass. */
  missing?: string[];
  /** Exactly these forbidden claims are flagged (ids without "forbidden:"). Default none. */
  claims?: Flags;
  /** Exactly these acceptable fixes match; [] means the acceptable item goes to review. */
  fixes: string[];
  /** Exactly these forbidden recommendations are flagged. Default none. */
  bad?: Flags;
  acceptance: AcceptanceStatus;
  /** Exactly the checks left for review (acceptance.pending). Default none. */
  pending?: CheckId[];
  /** Exactly the checks that block acceptance ("classification" for a classification blocker). Default none. */
  blockers?: CheckId[];
};

type Case = {
  id: string;
  category: Category;
  about: string;
  classification?: Classification;
  confidence?: Level;
  summary?: string;
  /** Replaces the scenario's neutral analysis points. */
  points?: Point[];
  fix?: string;
  expect: Expect;
  /** Current behavior differs from what we want: the case pins the current behavior. */
  limitation?: { desired: string };
};

type Scenario = {
  id: 'S11' | 'S13' | 'S14';
  run: FakeRunOptions;
  /** What the Read of error-context.md returns. */
  context: string;
  traceRequired: boolean;
  classification: Classification;
  confidence: Level;
  summary: string;
  fix: string;
  /** Points that cite the required evidence but match no criterion and no forbidden claim. */
  neutral: Point[];
  justification: string;
  evidence: (f: Facts) => ModelInvestigation['evidence'];
  cases: Case[];
};

const TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Skill', MCP_LIST, MCP_DETAILS, MCP_TRACE];

const baseEvidence = (f: Facts, trace: ModelInvestigation['evidence'][number]): ModelInvestigation['evidence'] => [
  { kind: 'mcp', status: 'inspected', ref: 'get_failure_details', note: 'Error, attempts and attachments' },
  { kind: 'source', status: 'inspected', ref: f.spec, note: 'The test source' },
  { kind: 'error_context', status: 'inspected', ref: f.errorContext, note: 'Page snapshot at failure' },
  { kind: 'screenshot', status: 'skipped', ref: null, note: 'The page snapshot is enough' },
  trace,
];
const skippedTrace = { kind: 'trace', status: 'skipped', ref: null, note: 'Not needed' } as const;

const NEUTRAL: Point[] = [
  ['Observed: the test source was read in full.', 'spec'],
  ['Observed: the page snapshot at failure was read.', 'ctx'],
  ['Observed: get_failure_details lists one failed attempt.', 'details'],
];

// ---------------------------------------------------------------------------
// S11: hidden link revealed by hover (Test-code defect)

const S11: Scenario = {
  id: 'S11',
  run: {
    test: { file: 'ui/team.spec.ts', title: 'opens a team member profile' },
    message:
      "Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('View Ana\\'s profile')\nExpected: visible\nReceived: hidden\nTimeout: 10000ms\n\nCall log:\n  - Expect \"toBeVisible\" with timeout 10000ms\n  - waiting for getByText('View Ana\\'s profile')\n    23 × locator resolved to <a href=\"/team/ana-lopez\">View Ana's profile</a>\n       - unexpected value \"hidden\"",
    errorContextExtra: "\n- heading \"Team\" [level=1]\n- paragraph: Hover over a team member's photo to see their name and profile link.\n- figure \"Ana Lopez View Ana's profile\":\n  - img \"Ana Lopez\"",
  },
  context: "- paragraph: Hover over a team member's photo to see their name and profile link.\n- figure \"Ana Lopez View Ana's profile\":\n  - img \"Ana Lopez\"",
  traceRequired: false,
  classification: 'Test-code defect',
  confidence: 'High',
  summary: "The profile link exists (the locator resolved to <a href=\"/team/ana-lopez\">) but it is hidden until the member's photo is hovered; the test asserts toBeVisible without hovering first.",
  fix: "Hover over Ana's photo first: await page.getByRole('img', { name: 'Ana Lopez' }).hover(), then assert that the link is visible and click it.",
  neutral: NEUTRAL,
  justification: 'The failure details, the test source and the page snapshot were all read.',
  evidence: (f) => baseEvidence(f, skippedTrace),
  cases: [
    // A. Correct diagnoses
    { id: 'S11-A1', category: 'A', about: 'detailed: resolved link, hidden until hover', expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' } },
    { id: 'S11-A2', category: 'A', about: 'concise wording', summary: 'The link is present but hidden; the test never hovers over the photo that reveals it.', expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' } },
    {
      id: 'S11-A3',
      category: 'A',
      about: 'terminology: matched anchor, not visible, mouseover',
      summary: 'Playwright matched the anchor, yet it is not visible: its caption only appears on mouseover of the figure, a step the spec skips.',
      expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' },
    },
    {
      id: 'S11-A4',
      category: 'A',
      about: 'terminology: in the DOM, display: none, pointer rests on',
      summary: 'The link is in the DOM but has display: none until the pointer rests on the photo, and the test asserts visibility without moving there.',
      expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' },
    },
    {
      id: 'S11-A5',
      category: 'A',
      about: 'rejects timing and a missing link explicitly',
      summary: 'This is not a timing problem and the link is not missing: it exists but stays hidden until the photo is hovered, which the test never does.',
      expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' },
    },
    // B. Incorrect diagnoses
    {
      id: 'S11-B1',
      category: 'B',
      about: 'claims the link is missing',
      summary: 'The profile link is missing from the page, so the toBeVisible assertion fails.',
      expect: { verdict: 'exact', missing: ['hidden', 'element-exists', 'hover'], claims: { 'link-missing': 'review' }, fixes: ['hover-first'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S11-B2',
      category: 'B',
      about: 'Application defect at High: blames the hover effect, proposes a CSS change',
      classification: 'Application defect',
      summary: "The team page's hover effect is broken: hovering over the photo does not reveal the link.",
      fix: 'Change the CSS so the caption is always visible.',
      expect: {
        verdict: 'incorrect',
        highConfidenceIncorrect: true,
        missing: ['hidden', 'element-exists'],
        claims: { 'app-broken': 'review' },
        fixes: [],
        bad: { 'change-app': 'review' },
        acceptance: 'not_accepted',
        pending: ['root_cause', 'recommendation'],
        blockers: ['classification', 'confidence'],
      },
    },
    {
      id: 'S11-B3',
      category: 'B',
      about: 'blames slow loading',
      summary: 'The link loads slowly, and the test needs more time before asserting it.',
      expect: { verdict: 'exact', missing: ['hidden', 'element-exists', 'hover'], claims: { timing: 'review' }, fixes: ['hover-first'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S11-B4',
      category: 'B',
      about: 'blames the locator text',
      summary: 'The locator text is wrong: no element has that text, so getByText finds nothing.',
      expect: { verdict: 'exact', missing: ['hidden', 'element-exists', 'hover'], claims: { 'wrong-text': 'review' }, fixes: ['hover-first'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S11-B5',
      category: 'B',
      about: 'every criterion matches, plus an unsupported claim: criteria alone never mean acceptance',
      summary: 'The link exists but is hidden until the photo is hovered, and the hover effect is broken in the stylesheet.',
      expect: { verdict: 'exact', claims: { 'app-broken': 'review' }, fixes: ['hover-first'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S11-B6',
      category: 'B',
      about: 'abstains (Inconclusive) without a fix',
      classification: 'Inconclusive',
      confidence: 'Low',
      summary: 'The visibility assertion failed; the evidence does not show why.',
      fix: '',
      expect: { verdict: 'abstained', missing: ['hidden', 'element-exists', 'hover'], fixes: [], acceptance: 'not_accepted', pending: ['root_cause', 'recommendation'], blockers: ['classification'] },
    },
    {
      id: 'S11-B7',
      category: 'B',
      about: 'right reasoning, wrong label (Environment issue, Medium): S11 has no reviewable alternative',
      classification: 'Environment issue',
      confidence: 'Medium',
      expect: { verdict: 'incorrect', fixes: ['hover-first'], acceptance: 'not_accepted', blockers: ['classification'] },
    },
    // C. Acceptable recommendations
    { id: 'S11-C1', category: 'C', about: 'minimal code fix', fix: "Call .hover() on Ana's figure before the assertion.", expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' } },
    { id: 'S11-C2', category: 'C', about: 'plain wording', fix: 'Hover over the photo first, then assert and click the link.', expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' } },
    {
      id: 'S11-C3',
      category: 'C',
      about: 'fix plus an optional screenshot diagnostic',
      fix: "Hover over Ana's photo before asserting. Optionally take a screenshot after the hover to confirm the caption appears.",
      expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' },
    },
    {
      id: 'S11-C4',
      category: 'C',
      about: 'a diagnostic alone does not count as the fix',
      fix: "Open the trace viewer and inspect the caption's styles.",
      expect: { verdict: 'exact', fixes: [], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S11-C5',
      category: 'C',
      about: '"move the mouse over" is not recognized as hovering',
      fix: "Move the mouse over Ana's picture before checking the link.",
      expect: { verdict: 'exact', fixes: [], acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'matches hover-first (moving the mouse over the photo is hovering), accepted' },
    },
    // D. Forbidden recommendations
    { id: 'S11-D1', category: 'D', about: 'force: true', fix: 'Click the link with { force: true }.', expect: { verdict: 'exact', fixes: [], bad: { force: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    { id: 'S11-D2', category: 'D', about: 'synthetic click', fix: "Fire the click with dispatchEvent('click') on the link.", expect: { verdict: 'exact', fixes: [], bad: { dispatch: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    {
      id: 'S11-D3',
      category: 'D',
      about: 'navigates to the profile directly',
      fix: "Skip the link and call page.goto('/team/ana-lopez') directly.",
      expect: { verdict: 'exact', fixes: [], bad: { 'direct-navigation': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    { id: 'S11-D4', category: 'D', about: 'fixed wait', fix: 'Add await page.waitForTimeout(2000) before the assertion.', expect: { verdict: 'exact', fixes: [], bad: { sleep: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    {
      id: 'S11-D5',
      category: 'D',
      about: 'longer timeout',
      fix: 'Increase the expect timeout so the link has time to appear.',
      expect: { verdict: 'exact', fixes: [], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S11-D6',
      category: 'D',
      about: 'injects styles so the link is always shown',
      fix: 'Use page.addStyleTag to make every figcaption always visible.',
      expect: { verdict: 'exact', fixes: [], bad: { 'change-app': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S11-D7',
      category: 'D',
      about: 'a valid fix does not hide a forbidden addition',
      fix: 'Hover over the photo first, and also pass { force: true } to the click.',
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { force: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S11-D8',
      category: 'D',
      about: 'removing the correct visibility assertion is not flagged',
      fix: 'Remove the toBeVisible assertion and click the link.',
      expect: { verdict: 'exact', fixes: [], acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'a forbidden item for dropping correct test steps; today only the missing acceptable fix sends it to review' },
    },
    // E. Negation and clause boundaries
    {
      id: 'S11-E1',
      category: 'E',
      about: '"This is not an application defect." (no S11 pattern covers "defect")',
      summary: 'This is not an application defect: the link exists but is hidden until hover, and the test never hovers.',
      expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' },
    },
    {
      id: 'S11-E2',
      category: 'E',
      about: '"not missing" next to the word missing',
      summary: 'The link is not missing: it exists, but it is hidden until the photo is hovered.',
      expect: { verdict: 'exact', fixes: ['hover-first'], acceptance: 'accepted' },
    },
    {
      id: 'S11-E3',
      category: 'E',
      about: '"Do not increase the timeout." is flagged: S11 patterns have no negation guard',
      fix: 'Do not increase the timeout; hover over the photo first.',
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'the negated timeout is not flagged; accepted' },
    },
    {
      id: 'S11-E4',
      category: 'E',
      about: '"not a race condition" is flagged',
      summary: 'This is not a race condition: the link exists but is hidden until the photo is hovered.',
      expect: { verdict: 'exact', claims: { timing: 'review' }, fixes: ['hover-first'], acceptance: 'pending_review', pending: ['root_cause'] },
      limitation: { desired: 'the rejected timing explanation is not flagged; accepted' },
    },
    {
      id: 'S11-E5',
      category: 'E',
      about: 'negated force and dispatchEvent are both flagged',
      fix: 'Do not use force: true or dispatchEvent; hover over the photo first.',
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { force: 'review', dispatch: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'neither negated action is flagged; accepted' },
    },
  ],
};

// ---------------------------------------------------------------------------
// S13: report download answered with HTTP 503 by the server (Application defect)

/** S13's trace as get_trace_summary sees it: /reports 200, then the report link's document 503, no routes. */
const s13Trace = () =>
  pageTrace(
    [
      { title: 'Navigate to "/reports"', start: T0 + 160, end: T0 + 300, line: 4 },
      { title: 'Wait for event "download"', start: T0 + 340, end: T0 + 15300, line: 7, error: true },
      { title: 'Click getByRole(\'link\', { name: \'Download monthly report\' })', start: T0 + 345, end: T0 + 400, line: 8 },
    ],
    [...traceRecord('Frame', 'goto', T0 + 165, T0 + 290, { params: { url: '/reports' } }), ...traceRecord('Frame', 'click', T0 + 350, T0 + 395, { params: { selector: 'internal:role=link[name="Download monthly report"i]' } })],
    [
      resource({ url: `${ORIGIN}/reports`, type: 'document', start: T0 + 170, serverIP: true }),
      resource({ url: `${ORIGIN}/reports/monthly.csv`, type: 'document', status: 503, statusText: 'Service Unavailable', start: T0 + 360, serverIP: true }),
    ],
  );

const S13_TRACE_NOTE = 'retry 0: ok. GET /reports/monthly.csv returned 503 Service Unavailable with marker none; no interception patterns or route calls.';
const S13_NEUTRAL: Point[] = [...NEUTRAL, ['Observed (get_trace_summary retry 0: ok): the trace of the failed attempt was read.', 'trace']];
const S13_SUMMARY =
  'The test correctly waits for a download and clicks the report link, but the server answered GET /reports/monthly.csv with HTTP 503 Service Unavailable and an HTML error page instead of the CSV attachment; Chromium showed that page, no download event fired, and the test timed out waiting for it.';
const CAUTION = ' Whether the 503 comes from an outage of a dependency or from the application code cannot be determined without server logs.';
const ALL_S13: string[] = ['server-503', 'report-request', 'error-page', 'no-download', 'timeout', 'test-correct'];
const allBut = (...keep: string[]) => ALL_S13.filter((c) => !keep.includes(c));

const S13: Scenario = {
  id: 'S13',
  run: {
    test: { file: 'ui/reports.spec.ts', title: 'downloads the monthly report' },
    attempts: ['timedOut'],
    message: 'Test timeout of 15000ms exceeded.\n\nError: page.waitForEvent: Test timeout of 15000ms exceeded.\nCall log:\n  - waiting for event "download"',
    errorContextExtra: '\n- heading "Service Unavailable" [level=1]\n- paragraph: The report service is temporarily unavailable.',
    traceBody: () => s13Trace(),
  },
  context: '- heading "Service Unavailable" [level=1]\n- paragraph: The report service is temporarily unavailable.',
  traceRequired: true,
  classification: 'Application defect',
  confidence: 'Medium',
  summary: S13_SUMMARY,
  fix: 'Investigate the report endpoint and its server logs so it serves the CSV attachment again; no change is needed in the test.',
  neutral: S13_NEUTRAL,
  justification: 'The failure details, the test source, the page snapshot and the trace summary were all read.',
  evidence: (f) => baseEvidence(f, { kind: 'trace', status: 'inspected', ref: 'get_trace_summary', note: S13_TRACE_NOTE }),
  cases: [
    // A. Correct diagnoses
    { id: 'S13-A1', category: 'A', about: 'detailed: 503, error page, no download event, timeout, test correct', expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' } },
    {
      id: 'S13-A2',
      category: 'A',
      about: 'with a structured trace claim that agrees with get_trace_summary',
      points: [...NEUTRAL, ['Observed (get_trace_summary retry 0: ok): /reports/monthly.csv returned 503 with marker none, and no route calls were recorded.', 'trace']],
      expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' },
    },
    {
      id: 'S13-A3',
      category: 'A',
      about: 'concise wording',
      summary: 'Service unavailable on monthly.csv: the browser rendered an error page, no download event fired, and the test timed out; the test logic is fine.',
      expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' },
    },
    {
      id: 'S13-A4',
      category: 'A',
      about: 'terminology: download URL, navigated, never fired, waitForEvent, spec is correct',
      summary: "The download URL responded 503, so Chromium navigated to the server's error response instead of a file; the download event never fired and waitForEvent hit the test timeout. The spec is correct.",
      expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' },
    },
    {
      id: 'S13-A5',
      category: 'A',
      about: 'rejects timing and mocking explicitly',
      summary: 'This is not a timing problem and the test does not mock anything: the server returned 503 for the report request, the browser displayed the error page, no download started, and the wait timed out. The test is correct.',
      expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' },
    },
    { id: 'S13-A6', category: 'A', about: 'High confidence is also within the expected range', confidence: 'High', expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' } },
    {
      id: 'S13-A7',
      category: 'A',
      about: '"times out" (present tense) does not meet the timeout criterion',
      summary: S13_SUMMARY.replace('the test timed out waiting for it', 'the test times out waiting for it'),
      expect: { verdict: 'exact', missing: ['timeout'], fixes: ['fix-server', 'keep-test'], acceptance: 'pending_review', pending: ['root_cause'] },
      limitation: { desired: 'matches the timeout criterion; accepted' },
    },
    // B. Incorrect diagnoses and reviewable alternatives
    {
      id: 'S13-B1',
      category: 'B',
      about: 'reviewable: Environment issue citing the 503 and the unknown operational cause',
      classification: 'Environment issue',
      summary: S13_SUMMARY + CAUTION,
      expect: { verdict: 'reviewable_alternative', fixes: ['fix-server', 'keep-test'], acceptance: 'pending_review', pending: ['classification'] },
    },
    {
      id: 'S13-B2',
      category: 'B',
      about: 'reviewable at High confidence too: its confidence is judged in the review, not automatically',
      classification: 'Environment issue',
      confidence: 'High',
      summary: S13_SUMMARY + CAUTION,
      expect: { verdict: 'reviewable_alternative', fixes: ['fix-server', 'keep-test'], acceptance: 'pending_review', pending: ['classification'] },
    },
    {
      id: 'S13-B3',
      category: 'B',
      about: 'Environment issue without the caution is incorrect',
      classification: 'Environment issue',
      summary: 'The report service is down: the server returned 503 for /reports/monthly.csv, so no download event fired and the test timed out.',
      expect: { verdict: 'incorrect', missing: ['error-page', 'test-correct'], fixes: ['fix-server', 'keep-test'], acceptance: 'not_accepted', pending: ['root_cause'], blockers: ['classification'] },
    },
    {
      id: 'S13-B4',
      category: 'B',
      about: 'blames slowness and proposes a longer timeout (Test-code defect, Medium)',
      classification: 'Test-code defect',
      summary: 'The download is too slow, and the test needs more time to receive the file.',
      fix: 'Increase the test timeout to 60 seconds.',
      expect: {
        verdict: 'incorrect',
        missing: ALL_S13,
        claims: { timing: 'review' },
        fixes: [],
        bad: { 'more-time': 'review' },
        acceptance: 'not_accepted',
        pending: ['root_cause', 'recommendation'],
        blockers: ['classification'],
      },
    },
    {
      id: 'S13-B5',
      category: 'B',
      about: 'claims the test mocked the 503 (Test-code defect at High)',
      classification: 'Test-code defect',
      confidence: 'High',
      summary: 'The test mocks the report endpoint with a 503 and then expects a download.',
      fix: 'Remove the mock from the test.',
      expect: {
        verdict: 'incorrect',
        highConfidenceIncorrect: true,
        missing: allBut('server-503', 'report-request'),
        claims: { 'claims-mock': 'review' },
        fixes: [],
        acceptance: 'not_accepted',
        pending: ['root_cause', 'recommendation'],
        blockers: ['classification', 'confidence'],
      },
    },
    {
      id: 'S13-B6',
      category: 'B',
      about: 'treats marker none alone as proof of a live backend',
      summary: `${S13_SUMMARY} The marker: none proves the response came from the real backend.`,
      expect: { verdict: 'exact', claims: { 'marker-proof': 'review' }, fixes: ['fix-server', 'keep-test'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S13-B7',
      category: 'B',
      about: 'states a server-side cause the artifacts cannot show',
      summary: `${S13_SUMMARY} The 503 was caused by a database crash.`,
      expect: { verdict: 'exact', claims: { 'specific-cause': 'review' }, fixes: ['fix-server', 'keep-test'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S13-B8',
      category: 'B',
      about: 'blames the link locator',
      classification: 'Test-code defect',
      summary: 'The link locator is wrong, so the click never starts a download and the test timed out.',
      fix: "Change the locator to getByText('Download monthly report').",
      expect: {
        verdict: 'incorrect',
        missing: allBut('timeout'),
        claims: { 'blames-locator': 'review' },
        fixes: [],
        bad: { 'change-locator': 'review' },
        acceptance: 'not_accepted',
        pending: ['root_cause', 'recommendation'],
        blockers: ['classification'],
      },
    },
    {
      id: 'S13-B9',
      category: 'B',
      about: 'blames disabled downloads',
      classification: 'Test-code defect',
      summary: 'Downloads are disabled in the browser context, so the click never produces a download event and the test timed out.',
      fix: 'Set acceptDownloads: true in the browser context.',
      expect: {
        verdict: 'incorrect',
        missing: allBut('timeout'),
        claims: { 'download-config': 'review' },
        fixes: [],
        bad: { 'download-permissions': 'review' },
        acceptance: 'not_accepted',
        pending: ['root_cause', 'recommendation'],
        blockers: ['classification'],
      },
    },
    {
      id: 'S13-B10',
      category: 'B',
      about: 'claims the download listener was registered too late',
      classification: 'Test-code defect',
      summary: 'The waitForEvent listener was registered too late, after the click, so the download was missed and the test timed out.',
      fix: 'Register waitForEvent before clicking.',
      expect: {
        verdict: 'incorrect',
        missing: allBut('timeout'),
        claims: { 'wait-order': 'review' },
        fixes: [],
        acceptance: 'not_accepted',
        pending: ['root_cause', 'recommendation'],
        blockers: ['classification'],
      },
    },
    {
      id: 'S13-B11',
      category: 'B',
      about: 'abstains (Inconclusive) without a fix',
      classification: 'Inconclusive',
      confidence: 'Low',
      summary: 'The test timed out waiting for a download; the evidence does not show why.',
      fix: '',
      expect: { verdict: 'abstained', missing: allBut('timeout'), fixes: [], acceptance: 'not_accepted', pending: ['root_cause', 'recommendation'], blockers: ['classification'] },
    },
    // C. Acceptable recommendations
    {
      id: 'S13-C1',
      category: 'C',
      about: 'server fix plus the optional fail-fast status check',
      fix: 'Restore the CSV attachment response on the server. Optionally, assert the response status with waitForResponse so the test fails fast.',
      expect: { verdict: 'exact', fixes: ['fix-server', 'check-status'], acceptance: 'accepted' },
    },
    {
      id: 'S13-C2',
      category: 'C',
      about: 'alternative wording: look into dependencies, spec needs no change',
      fix: "Look into the report service's dependencies and fix the backend; the spec needs no change.",
      expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' },
    },
    { id: 'S13-C3', category: 'C', about: 'minimal: check the server logs', fix: 'Check the server logs for /reports/monthly.csv.', expect: { verdict: 'exact', fixes: ['fix-server'], acceptance: 'accepted' } },
    { id: 'S13-C4', category: 'C', about: 'keeping the test is an acceptable recommendation on its own (as the truth defines it)', fix: 'The test is correct and needs no change.', expect: { verdict: 'exact', fixes: ['keep-test'], acceptance: 'accepted' } },
    {
      id: 'S13-C5',
      category: 'C',
      about: 'the optional diagnostic alone is accepted as the fix',
      fix: 'Add waitForResponse and expect response.ok() before waiting for the download.',
      expect: { verdict: 'exact', fixes: ['check-status'], acceptance: 'accepted' },
      limitation: { desired: 'an optional diagnostic alone does not satisfy the recommendation (review); the truth has no required-vs-optional distinction' },
    },
    // D. Forbidden recommendations
    { id: 'S13-D1', category: 'D', about: 'mocks the endpoint', fix: 'Mock the endpoint with page.route so it returns a 200.', expect: { verdict: 'exact', fixes: [], bad: { 'mock-it': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    { id: 'S13-D2', category: 'D', about: 'fixed wait', fix: 'Add page.waitForTimeout(5000) before waiting for the download.', expect: { verdict: 'exact', fixes: [], bad: { sleep: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    { id: 'S13-D3', category: 'D', about: 'longer timeout', fix: 'Increase the test timeout to 60 seconds.', expect: { verdict: 'exact', fixes: [], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    { id: 'S13-D4', category: 'D', about: 'retries', fix: 'Enable retries: 2 in the Playwright config.', expect: { verdict: 'exact', fixes: [], bad: { retries: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    { id: 'S13-D5', category: 'D', about: 'skips the test', fix: 'Skip the test with test.skip() until the endpoint works.', expect: { verdict: 'exact', fixes: [], bad: { skip: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    {
      id: 'S13-D6',
      category: 'D',
      about: 'changes the correct locator',
      fix: "Change the link locator to getByText('Download').",
      expect: { verdict: 'exact', fixes: [], bad: { 'change-locator': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-D7',
      category: 'D',
      about: 'changes download settings',
      fix: 'Set acceptDownloads: true in the context options.',
      expect: { verdict: 'exact', fixes: [], bad: { 'download-permissions': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-D8',
      category: 'D',
      about: 'a valid fix does not hide a forbidden addition',
      fix: 'Investigate the report endpoint, and increase the timeout to 30 seconds meanwhile.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-D9',
      category: 'D',
      about: 'a mock that "returns the CSV" also matches the server fix',
      fix: 'Mock /reports/monthly.csv with route.fulfill, returning the CSV the test expects.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'mock-it': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'fix-server does not match inside a mocking recommendation (the mock still sends it to review, so acceptance is unaffected)' },
    },
    // E. Negation and clause boundaries
    {
      id: 'S13-E1',
      category: 'E',
      about: '"Do not increase the timeout." is not flagged',
      fix: 'Do not increase the timeout; investigate the report endpoint instead.',
      expect: { verdict: 'exact', fixes: ['fix-server'], acceptance: 'accepted' },
    },
    {
      id: 'S13-E2',
      category: 'E',
      about: '"Do not increase the timeout; change the locator instead." still flags the locator change',
      fix: 'Do not increase the timeout; change the locator instead.',
      expect: { verdict: 'exact', fixes: [], bad: { 'change-locator': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-E3',
      category: 'E',
      about: '"The server returned 503, not a mocked response." in a trace claim: the negation is honored',
      points: [...NEUTRAL, ['Observed (get_trace_summary retry 0: ok): /reports/monthly.csv returned 503, not a mocked response.', 'trace']],
      expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' },
    },
    { id: 'S13-E4', category: 'E', about: '"It isn\'t a slow server." is not flagged', summary: `${S13_SUMMARY} It isn't a slow server.`, expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' } },
    {
      id: 'S13-E5',
      category: 'E',
      about: '"There is no sign that acceptDownloads is false." is not flagged',
      summary: `${S13_SUMMARY} There is no sign that acceptDownloads is false.`,
      expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' },
    },
    {
      id: 'S13-E6',
      category: 'E',
      about: '"neither ... nor" is not a recognized negation',
      summary: `${S13_SUMMARY} It is neither a slow server nor a race condition.`,
      expect: { verdict: 'exact', claims: { timing: 'review' }, fixes: ['fix-server', 'keep-test'], acceptance: 'pending_review', pending: ['root_cause'] },
      limitation: { desired: 'not flagged; accepted' },
    },
    {
      id: 'S13-E7',
      category: 'E',
      about: 'a negation more than four words before the match: "do not mock the endpoint or add a sleep"',
      fix: 'Do not mock the endpoint or add a sleep; fix the report service.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { sleep: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'the sleep is not flagged; accepted' },
    },
    {
      id: 'S13-E8',
      category: 'E',
      about: 'a negation after the match: "a longer timeout is not the answer"',
      fix: 'A longer timeout is not the answer; fix the report endpoint.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'not flagged; accepted' },
    },
    {
      id: 'S13-E9',
      category: 'E',
      about: 'a negation after the match: "acceptDownloads is not the issue"',
      fix: 'Fix the report endpoint; acceptDownloads is not the issue.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'download-permissions': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'not flagged; accepted' },
    },
    {
      id: 'S13-E10',
      category: 'E',
      about: 'FALSE NEGATIVE: a negation scoped to an earlier clause hides a real timeout recommendation',
      fix: 'Fix the report endpoint. Do not change anything else and increase the timeout.',
      expect: { verdict: 'exact', fixes: ['fix-server'], acceptance: 'accepted' },
      limitation: { desired: 'more-time is flagged (the timeout increase is recommended, not negated), so the diagnosis goes to review instead of being accepted' },
    },
  ],
};

// ---------------------------------------------------------------------------
// S14: element handle kept across a DOM replacement (Test-code defect)

const S14: Scenario = {
  id: 'S14',
  run: {
    test: { file: 'ui/settings.spec.ts', title: 'enables email notifications after resetting preferences' },
    message: 'Error: elementHandle.check: Element is not attached to the DOM',
    errorContextExtra: '\n- heading "Settings" [level=1]\n- checkbox "Email notifications"\n- button "Reset preferences" [active]\n- status: Preferences reset',
  },
  context: '- checkbox "Email notifications"\n- button "Reset preferences" [active]\n- status: Preferences reset',
  traceRequired: false,
  classification: 'Test-code defect',
  confidence: 'High',
  summary: 'The test keeps an ElementHandle taken before the reset; the reset replaced the checkbox with a new node, so check() on the old handle fails because that node is no longer attached to the DOM.',
  fix: "Keep a Locator instead of an ElementHandle: call page.getByRole('checkbox', { name: 'Email notifications' }).check() after the reset.",
  neutral: NEUTRAL,
  justification: 'The failure details, the test source and the page snapshot were all read.',
  evidence: (f) => baseEvidence(f, skippedTrace),
  cases: [
    // A. Correct diagnoses
    { id: 'S14-A1', category: 'A', about: 'detailed: handle, replaced node, not attached', expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' } },
    { id: 'S14-A2', category: 'A', about: 'concise: stale handle, re-rendered', summary: 'check() ran on a stale handle because the reset re-rendered the checkbox.', expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' } },
    {
      id: 'S14-A3',
      category: 'A',
      about: 'terminology: stored reference, removed from the DOM, swapped',
      summary: 'The stored reference points to a node that was removed from the DOM when the reset swapped in a fresh checkbox.',
      expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' },
    },
    {
      id: 'S14-A4',
      category: 'A',
      about: 'terminology: captured element, disconnected, rebuilt',
      summary: 'The captured element is disconnected: clicking Reset rebuilt the input, so the cached node is gone.',
      expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' },
    },
    {
      id: 'S14-A5',
      category: 'A',
      about: 'rejects timing and an application defect explicitly',
      summary: 'This is not a timing issue and not an application defect: the reset recreated the checkbox, and the old element handle is detached.',
      expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' },
    },
    {
      id: 'S14-A6',
      category: 'A',
      about: '"original checkbox ... no longer in the DOM" is not a missing-checkbox claim',
      summary: 'The original checkbox is no longer in the DOM; a new checkbox took its place, so the earlier handle refers to nothing.',
      expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' },
    },
    // B. Incorrect diagnoses
    {
      id: 'S14-B1',
      category: 'B',
      about: 'blames a race with the re-render',
      summary: 'check() ran before the reset had finished: a race condition between the click and the re-render.',
      expect: { verdict: 'exact', missing: ['detached', 'handle'], claims: { timing: 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S14-B2',
      category: 'B',
      about: 'claims the page has no checkbox',
      summary: 'After the reset the page has no checkbox, so check() fails.',
      expect: { verdict: 'exact', missing: ['detached', 'replaced', 'handle'], claims: { 'checkbox-missing': 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S14-B3',
      category: 'B',
      about: 'Application defect at High: blames the reset, proposes changing the app',
      classification: 'Application defect',
      summary: 'The reset button is broken: it removes the checkbox, which is an application bug.',
      fix: 'Fix the reset handler so it keeps the original checkbox.',
      expect: {
        verdict: 'incorrect',
        highConfidenceIncorrect: true,
        missing: ['detached', 'replaced', 'handle'],
        claims: { 'app-broken': 'review' },
        fixes: [],
        bad: { 'change-app': 'review' },
        acceptance: 'not_accepted',
        pending: ['root_cause', 'recommendation'],
        blockers: ['classification', 'confidence'],
      },
    },
    {
      id: 'S14-B4',
      category: 'B',
      about: 'claims the checkbox is disabled',
      summary: 'The checkbox was disabled after the reset, so check() could not toggle it.',
      expect: { verdict: 'exact', missing: ['detached', 'replaced', 'handle'], claims: { disabled: 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S14-B5',
      category: 'B',
      about: 'blames the selector ("a different checkbox" still meets the replaced criterion)',
      summary: "The selector is wrong: getByRole('checkbox') picks a different checkbox.",
      expect: { verdict: 'exact', missing: ['detached', 'handle'], claims: { 'wrong-locator': 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S14-B6',
      category: 'B',
      about: 'every criterion matches, plus an unsupported application-bug claim',
      summary: 'The handle is detached because the reset replaced the checkbox, which is an application bug in the reset handler.',
      expect: { verdict: 'exact', claims: { 'app-broken': 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S14-B7',
      category: 'B',
      about: 'abstains (Inconclusive) without a fix',
      classification: 'Inconclusive',
      confidence: 'Low',
      summary: 'check() failed; the cause is unclear from the evidence.',
      fix: '',
      expect: { verdict: 'abstained', missing: ['detached', 'replaced', 'handle'], fixes: [], acceptance: 'not_accepted', pending: ['root_cause', 'recommendation'], blockers: ['classification'] },
    },
    // C. Acceptable recommendations
    { id: 'S14-C1', category: 'C', about: 'use a locator', fix: 'Use a locator instead of the element handle so check() resolves the current checkbox.', expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' } },
    { id: 'S14-C2', category: 'C', about: 're-query after the reset', fix: 'Re-query the checkbox after the reset and call check() on the new handle.', expect: { verdict: 'exact', fixes: ['reacquire'], acceptance: 'accepted' } },
    { id: 'S14-C3', category: 'C', about: 'both approaches as alternatives', fix: 'Switch to a locator, or take the checkbox again after the reset.', expect: { verdict: 'exact', fixes: ['use-locator', 'reacquire'], acceptance: 'accepted' } },
    {
      id: 'S14-C4',
      category: 'C',
      about: 'code form: a const Locator',
      fix: "Declare const checkbox = page.getByRole('checkbox', { name: 'Email notifications' }) and call checkbox.check() after the reset.",
      expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' },
    },
    {
      id: 'S14-C5',
      category: 'C',
      about: 'fix plus an optional isConnected diagnostic',
      fix: "Use a locator instead of the handle. Optionally log the handle's isConnected value before check() to confirm the node was replaced.",
      expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' },
    },
    {
      id: 'S14-C6',
      category: 'C',
      about: 'a diagnostic alone does not count as the fix',
      fix: "Log the handle's isConnected value before check() to see whether the node was replaced.",
      expect: { verdict: 'exact', fixes: [], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-C7',
      category: 'C',
      about: '"look the checkbox up ... when you check it" is not recognized',
      fix: 'Look the checkbox up by role at the moment you check it.',
      expect: { verdict: 'exact', fixes: [], acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'matches reacquire (or use-locator); accepted' },
    },
    // D. Forbidden recommendations
    { id: 'S14-D1', category: 'D', about: 'fixed wait via setTimeout', fix: 'Wait 500 ms with setTimeout before calling check().', expect: { verdict: 'exact', fixes: [], bad: { sleep: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    { id: 'S14-D2', category: 'D', about: 'longer timeout', fix: 'Increase the action timeout for check().', expect: { verdict: 'exact', fixes: [], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    { id: 'S14-D3', category: 'D', about: 'retrying with toPass', fix: 'Wrap the check in expect(...).toPass() so it is retried.', expect: { verdict: 'exact', fixes: [], bad: { retries: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    { id: 'S14-D4', category: 'D', about: 'force: true', fix: 'Call checkbox.check({ force: true }).', expect: { verdict: 'exact', fixes: [], bad: { force: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] } },
    {
      id: 'S14-D5',
      category: 'D',
      about: 'sets the state from a script',
      fix: 'Set the state from a script: page.evaluate(() => { el.checked = true; }).',
      expect: { verdict: 'exact', fixes: [], bad: { 'set-via-script': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-D6',
      category: 'D',
      about: 'changes the app to keep the original node',
      fix: 'Change the reset handler to reuse the original checkbox node.',
      expect: { verdict: 'exact', fixes: [], bad: { 'change-app': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-D7',
      category: 'D',
      about: 'a valid fix does not hide a forbidden addition',
      fix: 'Re-query the checkbox after the reset, and add { force: true } to check().',
      expect: { verdict: 'exact', fixes: ['reacquire'], bad: { force: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-D8',
      category: 'D',
      about: 'removing the reset step from the test is not flagged',
      fix: 'Remove the Reset preferences click from the test.',
      expect: { verdict: 'exact', fixes: [], acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'a forbidden item for dropping correct test steps; today only the missing acceptable fix sends it to review' },
    },
    // E. Negation and clause boundaries
    {
      id: 'S14-E1',
      category: 'E',
      about: '"The element is not missing; the stored handle is detached."',
      summary: 'The element is not missing; the stored handle is detached: the reset replaced the checkbox.',
      expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' },
    },
    {
      id: 'S14-E2',
      category: 'E',
      about: '"This is not a race condition." is not flagged',
      summary: 'This is not a race condition: the reset replaced the checkbox and the old handle is detached.',
      expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' },
    },
    {
      id: 'S14-E3',
      category: 'E',
      about: '"Do not increase the timeout." is flagged: S14 fix patterns have no negation guard',
      fix: 'Do not increase the timeout; use a locator instead.',
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'the negated timeout is not flagged; accepted' },
    },
    {
      id: 'S14-E4',
      category: 'E',
      about: 'a negation two words before the match: "no race or timing problem"',
      summary: 'There was no race or timing problem: the reset replaced the checkbox, and the old handle is detached.',
      expect: { verdict: 'exact', claims: { timing: 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
      limitation: { desired: 'not flagged; accepted' },
    },
    {
      id: 'S14-E5',
      category: 'E',
      about: 'a negation after the match: "a race condition is not the cause"',
      summary: 'A race condition is not the cause: the reset replaced the checkbox and the old handle is detached.',
      expect: { verdict: 'exact', claims: { timing: 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
      limitation: { desired: 'not flagged; accepted' },
    },
    {
      id: 'S14-E6',
      category: 'E',
      about: '"No sleep is needed" is flagged',
      fix: 'No sleep is needed; re-query the checkbox after the reset.',
      expect: { verdict: 'exact', fixes: ['reacquire'], bad: { sleep: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'not flagged; accepted' },
    },
  ],
};

const SCENARIOS: Scenario[] = [S11, S13, S14];

// ---------------------------------------------------------------------------
// Sessions

function investigationOf(s: Scenario, c: Case, f: Facts): ModelInvestigation {
  const refs: Record<Ref, string> = { spec: f.spec, ctx: f.errorContext, details: 'get_failure_details', trace: 'get_trace_summary' };
  return {
    testId: f.testId,
    classification: c.classification ?? s.classification,
    failureSummary: c.summary ?? s.summary,
    sourceMismatch: false,
    evidence: s.evidence(f),
    analysis: (c.points ?? s.neutral).map(([point, ref]) => ({ point, evidenceRefs: [refs[ref]] })),
    confidence: { level: c.confidence ?? s.confidence, justification: s.justification },
    proposedFix: c.fix ?? s.fix,
    verificationSteps: [`npx playwright test ${f.spec}`],
  };
}

async function sessionOf(s: Scenario, c: Case, f: Facts): Promise<{ messages: SDKMessage[] }> {
  // S13's trace is required evidence: the session obtains it through the real tool output for this workspace.
  const trace = s.traceRequired ? call('trace-0', MCP_TRACE, { testId: f.testId, retry: 0 }, await getTraceSummary(await loadReport(f.root), f.testId, 0)) : [];
  return {
    messages: [
      sessionInit(f, { tools: TOOLS }),
      ...skillCall(),
      ...list(f),
      ...details(f),
      ...readSpec(f),
      ...call('read-ctx', 'Read', { file_path: f.errorContext }, s.context),
      ...trace,
      investigated(investigationOf(s, c, f)),
    ],
  };
}

// ---------------------------------------------------------------------------
// One saved run with every case, scored once by the production scorer

const base = await mkdtemp(path.join(tmpdir(), 'td-regression-'));
after(() => rm(base, { recursive: true, force: true }));
const RUN_ID = 'scorer-validation-regression';
const runDir = path.join(base, 'runs', RUN_ID);
const snapshotsRoot = path.join(base, 'snapshots');
await writeRunManifest(runDir, RUN_ID);
await mkdir(snapshotsRoot, { recursive: true });
const evalIds = new Map<string, string>();
for (const s of SCENARIOS) {
  // A neutral directory name: a workspace must not contain a scenario ID.
  const { snapshot, snapshotsRoot: own } = await buildFakeSnapshot(path.join(base, `fixture-${s.id.slice(1)}`), s.run, undefined, s.id);
  await cp(path.join(own, s.id), path.join(snapshotsRoot, s.id), { recursive: true, preserveTimestamps: true });
  for (const [i, c] of s.cases.entries()) {
    const evalId = `${s.id}-${String(i + 1).padStart(2, '0')}`;
    evalIds.set(c.id, evalId);
    await writeEvaluation(runDir, evalId, snapshot, { name: c.id, about: c.about, session: (f) => sessionOf(s, c, f) }, path.join(base, 'work'));
  }
}
const records = new Map((await scoreRun(runDir, { snapshotsRoot })).records.map((r) => [r.evalId, r]));
const truths = new Map(await Promise.all(SCENARIOS.map(async (s) => [s.id, await loadGroundTruth(s.id)] as const)));

const recordOf = (c: Case): ScoreRecord => {
  const r = records.get(evalIds.get(c.id)!);
  assert.ok(r, `no score for ${c.id}`);
  return r;
};
const checkOf = (r: ScoreRecord, id: CheckId) => r.checks.find((x) => x.id === id)!;
const flags = (r: ScoreRecord, id: CheckId): Record<string, string> => Object.fromEntries(checkOf(r, id).items.filter((i) => i.id.startsWith('forbidden:')).map((i) => [i.id.slice('forbidden:'.length), i.status]));
const explain = (r: ScoreRecord) =>
  `${r.category}/${r.acceptance.status} [${r.classification.tests[0]?.verdict}] blockers: ${r.acceptance.blockers.join('; ') || '-'} | pending: ${r.acceptance.pending.join(', ') || '-'} | ` +
  ['root_cause', 'recommendation'].map((id) => `${id}: ${checkOf(r, id as CheckId).items.map((i) => `${i.id}=${i.status}`).join(', ')}`).join(' | ');
const blockerIds = (r: ScoreRecord) => [...new Set(r.acceptance.blockers.map((b) => (b.startsWith('classification of') ? 'classification' : b.split(':')[0]!)))].sort();

/** Fails on a typo: every id a case names must exist in the scenario's real truth file. */
function assertKnownIds(c: Case, truth: GroundTruth) {
  const known = (ids: string[], list: { id: string }[], what: string) => {
    for (const id of ids) assert.ok(list.some((x) => x.id === id), `${c.id}: ${what} "${id}" is not in the truth file`);
  };
  known(c.expect.missing ?? [], truth.rootCause.criteria, 'criterion');
  known(Object.keys(c.expect.claims ?? {}), truth.rootCause.forbiddenClaims, 'forbidden claim');
  known(c.expect.fixes, truth.recommendations.acceptable, 'acceptable fix');
  known(Object.keys(c.expect.bad ?? {}), truth.recommendations.forbidden, 'forbidden recommendation');
}

// ---------------------------------------------------------------------------

describe('R1 regression corpus: harness', () => {
  test(`expectations were recorded under scorer v${RECORDED_UNDER}`, () => {
    // A scorer change must revisit this corpus (and the README table) deliberately, not silently.
    assert.equal(SCORER_VERSION, RECORDED_UNDER);
  });

  test('every case was scored by the current scorer against the real, unchanged truth file', async () => {
    assert.equal(records.size, SCENARIOS.reduce((n, s) => n + s.cases.length, 0));
    for (const s of SCENARIOS) {
      const truthSha = sha256(await readFile(path.join(SCENARIOS_DIR, s.id, 'truth.json')));
      for (const c of s.cases) {
        const r = recordOf(c);
        assert.equal(r.scorerVersion, SCORER_VERSION, c.id);
        assert.equal(r.inputs.truthSha256, truthSha, c.id);
        assert.equal(r.setup.ok, true, `${c.id}: ${r.setup.problems.join('; ')}`);
        assert.equal(r.audit.verdict, 'clean', `${c.id}: ${JSON.stringify(r.audit)}`);
      }
    }
  });

  test('the evidence is valid in every case, so only the text under test decides the outcome', () => {
    for (const s of SCENARIOS) {
      for (const c of s.cases) {
        const r = recordOf(c);
        for (const id of ['structured_output', 'report_status', 'coverage', 'evidence_validity', 'evidence_sufficiency', 'citations', 'source_mismatch', 'process'] as const) {
          assert.equal(checkOf(r, id).status, 'pass', `${c.id} ${id}: ${checkOf(r, id).detail} ${JSON.stringify(checkOf(r, id).items)}`);
        }
        // S13 obtains its trace through get_trace_summary and states it consistently; S11/S14 make no trace claims.
        assert.equal(checkOf(r, 'trace_consistency').status, s.traceRequired ? 'pass' : 'not_applicable', `${c.id}: ${JSON.stringify(checkOf(r, 'trace_consistency').items)}`);
        assert.equal(r.traceEvidence?.tests[0]?.acquisition, s.traceRequired ? 'mcp' : 'not_obtained', c.id);
      }
    }
  });

  test('every scenario covers categories A–E, and every named id exists in its truth', () => {
    for (const s of SCENARIOS) {
      assert.deepEqual([...new Set(s.cases.map((c) => c.category))].sort(), ['A', 'B', 'C', 'D', 'E'], s.id);
      assert.equal(new Set(s.cases.map((c) => c.id)).size, s.cases.length, `${s.id}: duplicate case id`);
      for (const c of s.cases) assertKnownIds(c, truths.get(s.id)!);
    }
  });
});

for (const s of SCENARIOS) {
  describe(`R1 regression corpus: ${s.id}`, () => {
    for (const c of s.cases) {
      const label = `${c.id} [${c.category}] ${c.about}${c.limitation ? ` — KNOWN LIMITATION (current behavior pinned; desired: ${c.limitation.desired})` : ''}`;
      test(label, () => {
        const r = recordOf(c);
        const why = explain(r);
        const truth = truths.get(s.id)!;
        const verdict = r.classification.tests[0]!;

        // Classification verdict (separate from acceptance).
        assert.equal(verdict.verdict, c.expect.verdict, why);
        assert.equal(verdict.highConfidenceIncorrect, c.expect.highConfidenceIncorrect ?? false, why);

        // Root-cause criteria: each named criterion goes to review, every other one matches.
        const rc = checkOf(r, 'root_cause').items;
        for (const criterion of truth.rootCause.criteria) {
          const item = rc.find((i) => i.id === criterion.id && i.tag === 'criterion');
          assert.equal(item?.status, (c.expect.missing ?? []).includes(criterion.id) ? 'review' : 'pass', `criterion ${criterion.id}: ${why}`);
        }
        // Forbidden claims: exactly these, with these statuses.
        assert.deepEqual(flags(r, 'root_cause'), c.expect.claims ?? {}, `forbidden claims: ${why}`);

        // Recommendations: exactly these acceptable fixes, exactly these forbidden ones.
        const acceptable = checkOf(r, 'recommendation').items.find((i) => i.id === 'acceptable')!;
        if (c.expect.fixes.length === 0) assert.equal(acceptable.status, 'review', `acceptable: ${why}`);
        else {
          assert.equal(acceptable.status, 'pass', `acceptable: ${why}`);
          assert.deepEqual(acceptable.detail.replace(/^matched /, '').split(', ').sort(), [...c.expect.fixes].sort(), `acceptable: ${why}`);
        }
        assert.deepEqual(flags(r, 'recommendation'), c.expect.bad ?? {}, `forbidden recommendations: ${why}`);

        // Overall acceptance: status, and exactly which checks are pending or blocking.
        assert.equal(r.acceptance.status, c.expect.acceptance, why);
        assert.deepEqual([...r.acceptance.pending].sort(), [...(c.expect.pending ?? [])].sort(), `pending: ${why}`);
        assert.deepEqual(blockerIds(r), [...(c.expect.blockers ?? [])].sort(), `blockers: ${why}`);
        assert.equal(r.category, (c.expect.pending ?? []).length > 0 ? 'needs_review' : 'scored', why);
      });
    }
  });
}
