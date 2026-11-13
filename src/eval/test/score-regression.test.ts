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
import { POLARITY_LIMITS } from '../polarity.ts';
import { reportRun, scoreRun } from '../runs.ts';
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
// classification verdict and the acceptance outcome it must get under scorer RECORDED_UNDER.
//
// Cases marked `limitation` are CHARACTERIZATION tests: they pin today's behavior, which differs
// from the behavior we would want (stated in `desired`). They are not endorsements: a change that
// fixes one must update the case and the README table, not be blocked by it. Cases marked `fixedIn`
// were limitations under an earlier scorer; `fixedIn.before` keeps the behavior pinned then.

const RECORDED_UNDER = 12;

type Classification = ModelInvestigation['classification'];
type Level = ModelInvestigation['confidence']['level'];
type Ref = 'spec' | 'ctx' | 'details' | 'trace';
type Point = [text: string, ref: Ref];
/** 'negated': only a forbidden_negated audit item (status pass) was recorded, not a finding. */
type Flags = Record<string, 'review' | 'fail' | 'negated'>;
type Category = 'A' | 'B' | 'C' | 'D' | 'E';

type Expect = {
  verdict: ClassificationVerdict;
  /** A wrong classification at High confidence (fails the confidence check). */
  highConfidenceIncorrect?: true;
  /** Root-cause criteria that go to review (no pattern matched); every other criterion must pass. */
  missing?: string[];
  /** Exactly these forbidden claims are flagged (ids without "forbidden:"). Default none. */
  claims?: Flags;
  /** Exactly these corrective acceptable fixes match; [] means the acceptable item goes to review. */
  fixes: string[];
  /** Exactly these supporting fixes (v10) match too: labelled "(supporting)" next to a corrective one, a review alone. Default none. */
  supporting?: string[];
  /** Exactly these acceptable fixes matched the regex but are not counted (v11), with their endorsement verdict. Default none. */
  notCounted?: Record<string, 'rejected' | 'conflict' | 'unresolved'>;
  /** Exactly these forbidden recommendations are flagged. Default none. */
  bad?: Flags;
  /** The checks that get the one forbidden-analysis review item (a field over a polarity limit). Default none. */
  incomplete?: ('root_cause' | 'recommendation')[];
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
  /** Replaces the default verification step (a plain re-run). */
  steps?: string[];
  expect: Expect;
  /** Current behavior differs from what we want: the case pins the current behavior. */
  limitation?: { desired: string };
  /** A former limitation, fixed in scorer `version`; `before` is the behavior pinned until then. */
  fixedIn?: { version: number; before: string };
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
      about: '"Do not increase the timeout." is negated, not flagged (S11 patterns have no negation guard)',
      fix: 'Do not increase the timeout; hover over the photo first.',
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { 'more-time': 'negated' }, acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'more-time review; pending_review (recommendation)' },
    },
    {
      id: 'S11-E4',
      category: 'E',
      about: '"not a race condition" is negated, not flagged',
      summary: 'This is not a race condition: the link exists but is hidden until the photo is hovered.',
      expect: { verdict: 'exact', claims: { timing: 'negated' }, fixes: ['hover-first'], acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'timing review; pending_review (root_cause)' },
    },
    {
      id: 'S11-E5',
      category: 'E',
      about: 'negated force and dispatchEvent: the negation carries over "or" and past "force: true"',
      fix: 'Do not use force: true or dispatchEvent; hover over the photo first.',
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { force: 'negated', dispatch: 'negated' }, acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'force and dispatch review; pending_review (recommendation)' },
    },
    {
      id: 'S11-E6',
      category: 'E',
      about: 'code punctuation inside a negated clause: "{ force: true }" and "dispatchEvent(\'click\')" stay negated',
      fix: "Never pass { force: true } or call dispatchEvent('click'); hover over the photo first.",
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { force: 'negated', dispatch: 'negated' }, acceptance: 'accepted' },
    },
    {
      id: 'S11-E7',
      category: 'E',
      about: 'a positive recommendation after "and" is flagged although the field also has a negated one',
      fix: 'Do not increase the timeout; hover over the photo first and pass { force: true } to the click.',
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { 'more-time': 'negated', force: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S11-E8',
      category: 'E',
      about: 'CROSS-FIELD: a forbidden fix split across two verification steps is flagged although the fix field holds only a negated match',
      fix: 'Hover over the photo first; do not change the CSS.',
      steps: ['Hover over the photo and confirm the link is visible; if it is not, remove', 'the display: none rule from the page and compare.'],
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { 'change-app': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S11-E9',
      category: 'E',
      about: 'CROSS-FIELD: a negated match that the joined text only extends past the field end stays negated',
      fix: 'Hover over the photo first; do not change the CSS.',
      steps: ['Check the link display after hovering.'],
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { 'change-app': 'negated' }, acceptance: 'accepted' },
    },
    {
      id: 'S11-E10',
      category: 'E',
      about: 'LINE BREAK: a negated force line followed by a list item stays negated, accepted',
      fix: 'Hover over the photo first.\n\nDo not use force: true.\n- Instead, hover over the element.',
      expect: { verdict: 'exact', fixes: ['hover-first'], bad: { force: 'negated' }, acceptance: 'accepted' },
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
      id: 'S13-B12',
      category: 'B',
      about: 'reviewable Environment issue with a supporting-only fix: the classification review and the recommendation review stay separate',
      classification: 'Environment issue',
      summary: S13_SUMMARY + CAUTION,
      fix: 'Add waitForResponse and assert the response status before waiting for the download.',
      expect: { verdict: 'reviewable_alternative', fixes: [], supporting: ['check-status'], acceptance: 'pending_review', pending: ['classification', 'recommendation'] },
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
      expect: { verdict: 'exact', fixes: ['fix-server'], supporting: ['check-status'], acceptance: 'accepted' },
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
      about: 'the optional diagnostic alone is not the fix: supporting only, review',
      fix: 'Add waitForResponse and expect response.ok() before waiting for the download.',
      expect: { verdict: 'exact', fixes: [], supporting: ['check-status'], acceptance: 'pending_review', pending: ['recommendation'] },
      fixedIn: { version: 10, before: 'check-status matched alone and was accepted; the truth had no required-vs-optional distinction' },
    },
    {
      id: 'S13-C6',
      category: 'C',
      about: 'corrective only: investigate the 503 and restore the CSV attachment',
      fix: 'Investigate why the report endpoint answers HTTP 503 and restore the successful CSV attachment response.',
      expect: { verdict: 'exact', fixes: ['fix-server'], acceptance: 'accepted' },
    },
    {
      id: 'S13-C7',
      category: 'C',
      about: 'supporting only: waitForResponse and a status assertion',
      fix: 'Add waitForResponse and assert the response status.',
      expect: { verdict: 'exact', fixes: [], supporting: ['check-status'], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-C8',
      category: 'C',
      about: 'corrective plus supporting: both recorded, accepted',
      fix: 'Restore the report endpoint so it serves the CSV again, and add a fail-fast assertion on the response status.',
      expect: { verdict: 'exact', fixes: ['fix-server'], supporting: ['check-status'], acceptance: 'accepted' },
    },
    {
      id: 'S13-C9',
      category: 'C',
      about: 'no recommendation at all: review',
      fix: '',
      expect: { verdict: 'exact', fixes: [], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-C10',
      category: 'C',
      about: 'supporting advice only in verificationSteps is not matched there (not verification-only), so it never satisfies the check',
      fix: 'No code change is proposed yet.',
      steps: ['Add waitForResponse and assert the response status, then re-run npx playwright test tests/ui/reports.spec.ts.'],
      expect: { verdict: 'exact', fixes: [], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-C11',
      category: 'C',
      about: 'a corrective fix only in verificationSteps is not met there (v7), so supporting advice in proposedFix stays a review',
      fix: 'Add waitForResponse and assert the response status before waiting for the download.',
      steps: ['Check the server logs for /reports/monthly.csv.', 'npx playwright test tests/ui/reports.spec.ts'],
      expect: { verdict: 'exact', fixes: [], supporting: ['check-status'], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-C12',
      category: 'C',
      about: '"Do not fix the server; add waitForResponse.": fix-server is rejected (negated), so only the supporting check-status counts: review',
      fix: 'Do not fix the server; add waitForResponse.',
      expect: { verdict: 'exact', fixes: [], supporting: ['check-status'], notCounted: { 'fix-server': 'rejected' }, acceptance: 'pending_review', pending: ['recommendation'] },
      fixedIn: { version: 11, before: 'accepted: fix-server matched inside the negated "Do not fix the server" (acceptable fixes had no polarity), so check-status was listed as supporting next to it' },
    },
    // C (v11). Acceptable-fix polarity
    {
      id: 'S13-C13',
      category: 'C',
      about: 'v11: positive corrective plus negated supporting: accepted, check-status not counted',
      fix: 'Restore the CSV attachment on the server; do not add waitForResponse.',
      expect: { verdict: 'exact', fixes: ['fix-server'], notCounted: { 'check-status': 'rejected' }, acceptance: 'accepted' },
    },
    {
      id: 'S13-C14',
      category: 'C',
      about: 'v11: negated corrective alone: rejected, review',
      fix: 'Do not investigate the backend.',
      expect: { verdict: 'exact', fixes: [], notCounted: { 'fix-server': 'rejected' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-C15',
      category: 'C',
      about: 'v11: a direct retraction of the same fix is a conflict, review',
      fix: "Fix the server. Actually, don't fix the server.",
      expect: { verdict: 'exact', fixes: [], notCounted: { 'fix-server': 'conflict' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-C16',
      category: 'C',
      about: 'v11: a conflicting criterion does not block another, independently endorsed corrective one',
      fix: "Fix the server. Actually, don't fix the server. The test is correct.",
      expect: { verdict: 'exact', fixes: ['keep-test'], notCounted: { 'fix-server': 'conflict' }, acceptance: 'accepted' },
    },
    {
      id: 'S13-C17',
      category: 'C',
      about: 'v11: a rejected and an endorsed phrase of one criterion are unresolved (alternative or retraction cannot be told apart)',
      fix: 'Do not fix the server; fix the backend.',
      expect: { verdict: 'exact', fixes: [], notCounted: { 'fix-server': 'unresolved' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-C18',
      category: 'C',
      about: 'v11: direct first-person advice counts',
      fix: 'I recommend that you restore the report endpoint.',
      expect: { verdict: 'exact', fixes: ['fix-server'], acceptance: 'accepted' },
    },
    {
      id: 'S13-C19',
      category: 'C',
      about: 'v11: advice reported from someone else alone is unresolved, review',
      fix: 'Another engineer suggested to fix the server.',
      expect: { verdict: 'exact', fixes: [], notCounted: { 'fix-server': 'unresolved' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-C20',
      category: 'C',
      about: 'v11: earlier advice called wrong is rejected, review',
      fix: 'The previous suggestion to fix the server was wrong.',
      expect: { verdict: 'exact', fixes: [], notCounted: { 'fix-server': 'rejected' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-C21',
      category: 'C',
      about: 'v11: a conditional corrective recommendation counts',
      fix: 'Fix the server if the 503 is reproducible.',
      expect: { verdict: 'exact', fixes: ['fix-server'], acceptance: 'accepted' },
    },
    {
      id: 'S13-C22',
      category: 'C',
      about: 'v11: list items are separate instructions, so a negated item does not reach the next one',
      fix: "- Don't increase the timeout\n- Restore the report endpoint",
      expect: { verdict: 'exact', fixes: ['fix-server'], acceptance: 'accepted' },
    },
    {
      id: 'S13-C23',
      category: 'C',
      about: 'v11: a fix followed by a fenced code block',
      fix: "Restore the CSV attachment in the report handler:\n```\nres.setHeader('Content-Disposition', 'attachment; filename=monthly.csv');\n```",
      expect: { verdict: 'exact', fixes: ['fix-server'], acceptance: 'accepted' },
    },
    {
      id: 'S13-C24',
      category: 'C',
      about: 'v11: a fix wrapped inside its match ("Investigate the⏎backend") crosses a line break of unknown role: unresolved',
      fix: 'Investigate the\nbackend.',
      expect: { verdict: 'exact', fixes: [], notCounted: { 'fix-server': 'unresolved' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'a line wrapped inside one instruction is read as one instruction: fix-server endorsed, accepted' },
    },
    {
      id: 'S13-C25',
      category: 'C',
      about: 'v11: a fix on the line after a negated one is ambiguous (the line may continue the negation): unresolved',
      fix: "Don't add a sleep\nRestore the report endpoint.",
      expect: { verdict: 'exact', fixes: [], notCounted: { 'fix-server': 'unresolved' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'separate lines read as separate instructions when they are: fix-server endorsed, accepted' },
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
    {
      id: 'S13-D10',
      category: 'D',
      about: 'supporting plus forbidden: a status assertion and a longer timeout',
      fix: 'Assert the response status with waitForResponse, and increase the timeout to 60 seconds.',
      expect: { verdict: 'exact', fixes: [], supporting: ['check-status'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-D11',
      category: 'D',
      about: 'corrective plus forbidden: restoring the endpoint does not hide retries as the solution',
      fix: 'Restore the report endpoint, and add retries: 2 to the config as the solution.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { retries: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
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
      about: '"neither ... nor" negates both alternatives',
      summary: `${S13_SUMMARY} It is neither a slow server nor a race condition.`,
      expect: { verdict: 'exact', claims: { timing: 'negated' }, fixes: ['fix-server', 'keep-test'], acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'timing review; pending_review (root_cause)' },
    },
    {
      id: 'S13-E7',
      category: 'E',
      about: 'a negation more than four words before the match: "do not mock the endpoint or add a sleep"',
      fix: 'Do not mock the endpoint or add a sleep; fix the report service.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { sleep: 'negated' }, acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'sleep review; pending_review (recommendation)' },
    },
    {
      id: 'S13-E8',
      category: 'E',
      about: 'a negation after the match: "a longer timeout is not the answer"',
      fix: 'A longer timeout is not the answer; fix the report endpoint.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'negated' }, acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'more-time review; pending_review (recommendation)' },
    },
    {
      id: 'S13-E9',
      category: 'E',
      about: 'a negation after the match: "acceptDownloads is not the issue"',
      fix: 'Fix the report endpoint; acceptDownloads is not the issue.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'download-permissions': 'negated' }, acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'download-permissions review; pending_review (recommendation)' },
    },
    {
      id: 'S13-E10',
      category: 'E',
      about: 'a negation scoped to an earlier clause no longer hides a real timeout recommendation',
      fix: 'Fix the report endpoint. Do not change anything else and increase the timeout.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      fixedIn: { version: 9, before: 'FALSE NEGATIVE: the S13 lookbehind saw "not" in the earlier clause, nothing was flagged, accepted' },
    },
    {
      id: 'S13-E11',
      category: 'E',
      about: 'FALSE NEGATIVE: "Do not forget to increase the timeout." is suppressed by the S13 truth lookbehind',
      fix: 'Fix the report endpoint. Do not forget to increase the timeout.',
      expect: { verdict: 'exact', fixes: ['fix-server'], acceptance: 'accepted' },
      limitation: { desired: 'more-time is flagged ("do not forget to" recommends it); needs a truth guard change, the regex never matches' },
    },
    {
      id: 'S13-E12',
      category: 'E',
      about: 'reported advice is ambiguous, so it stays reviewable although a later clause rejects it',
      fix: 'Fix the report endpoint. Another report suggested to increase the timeout, but that would hide the defect.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    // E. Line breaks in forbidden items (scorer v12, R3d)
    {
      id: 'S13-E13',
      category: 'E',
      about: 'LINE BREAK: the "Don\'t" of one bullet no longer negates the forbidden retries in the next bullet',
      fix: "Restore the report endpoint.\n- Don't mock it\n- add retries: 2",
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { retries: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      fixedIn: { version: 12, before: 'accepted: line breaks collapsed, so "add retries" was negated by the "Don\'t" of the previous bullet' },
    },
    {
      id: 'S13-E14',
      category: 'E',
      about: 'LINE BREAK: a timeout increase in its own bullet after a negated one is flagged',
      fix: "Restore the report endpoint.\n- Don't mock it\n- increase the timeout to 60 seconds",
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      fixedIn: { version: 12, before: 'accepted: "increase the timeout" was negated by the "Don\'t" of the previous bullet' },
    },
    {
      id: 'S13-E15',
      category: 'E',
      about: 'LINE BREAK: a plain line break that changes the reading makes the match ambiguous, so reviewable',
      fix: "Restore the report endpoint.\n\nDon't add retries\n- increase the timeout.",
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      fixedIn: { version: 12, before: 'accepted: "increase the timeout" was negated by the "Don\'t" of the previous line' },
    },
    {
      id: 'S13-E16',
      category: 'E',
      about: 'LINE BREAK: a forbidden match that the truth lookbehind hid behind a negator on an earlier paragraph is found from the break',
      fix: "Restore the report endpoint. Don't touch the spec\n\nincrease the timeout.",
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      fixedIn: { version: 12, before: 'FALSE NEGATIVE: the S13 lookbehind saw "n\'t" across the blank line, nothing was flagged, accepted' },
    },
    {
      id: 'S13-E17',
      category: 'E',
      about: 'LINE BREAK: a negation wrapped after "Do not" is found from the break and stays reviewable, never positive',
      fix: 'Restore the report endpoint.\n\nDo not\nincrease the timeout.',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'the wrapped "Do not⏎increase the timeout" is read as one negated instruction: no finding, accepted' },
    },
    {
      id: 'S13-E18',
      category: 'E',
      about: 'LINE BREAK: code after a negated line that introduces it is ambiguous, so reviewable',
      fix: "Restore the report endpoint.\n\nDo not mock it like this:\n```ts\npage.route('**/api', route => route.fulfill({\n  status: 503,\n  body: 'error'\n}))\n```",
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'mock-it': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'the code block is read as the negated example it introduces: mock-it negated, accepted' },
    },
    {
      id: 'S13-E19',
      category: 'E',
      about: 'FALSE NEGATIVE: an inline " - " separator is no line break, so "Don\'t" still negates the retries after it',
      fix: "Restore the report endpoint. Don't mock it - add retries: 2",
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { retries: 'negated' }, acceptance: 'accepted' },
      limitation: { desired: 'retries flagged ("add retries: 2" is its own instruction after the dash); pending review' },
    },
    {
      id: 'S13-E20',
      category: 'E',
      about: 'LINE BREAK: attributed forbidden advice in its own bullet stays ambiguous, so reviewable',
      fix: 'Restore the report endpoint.\n- Another report suggested "add retries: 2"\n- I would not follow it',
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { retries: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-E21',
      category: 'E',
      about: 'CROSS-FIELD: a match only across proposedFix and a verification step still goes to review',
      fix: 'Restore the report endpoint and increase the',
      steps: ['timeout to 60 seconds.\nRun the test again.'],
      expect: { verdict: 'exact', fixes: ['fix-server'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-E22',
      category: 'E',
      about: 'TRUNCATED LINES: a step that only its line breaks push over the clause limit gets the one review finding',
      // 450 clauses without the line breaks (v11 completes); the 100 list items make it 550.
      steps: [`Run the test again${', then wait'.repeat(POLARITY_LIMITS.maxClauses - 50)}.${'\n- wait'.repeat(100)}`],
      expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], incomplete: ['recommendation'], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S13-E23',
      category: 'E',
      about: 'TRUNCATED both readings: still one review finding, as in v11',
      steps: [`Run the test again${', then wait'.repeat(POLARITY_LIMITS.maxClauses + 5)}.${'\n- then wait'.repeat(10)}`],
      expect: { verdict: 'exact', fixes: ['fix-server', 'keep-test'], incomplete: ['recommendation'], acceptance: 'pending_review', pending: ['recommendation'] },
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
    // C (v11). Acceptable-fix polarity
    {
      id: 'S14-C8',
      category: 'C',
      about: 'v11: a rejected use-locator and an endorsed reacquire are separate criteria: accepted',
      fix: 'Do not use a Locator; instead reacquire the element.',
      expect: { verdict: 'exact', fixes: ['reacquire'], notCounted: { 'use-locator': 'rejected' }, acceptance: 'accepted' },
    },
    {
      id: 'S14-C9',
      category: 'C',
      about: 'v11: a retracted use-locator (conflict) does not block the endorsed reacquire',
      fix: "Use a locator. Actually, don't use a locator; re-query the checkbox after the reset.",
      expect: { verdict: 'exact', fixes: ['reacquire'], notCounted: { 'use-locator': 'conflict' }, acceptance: 'accepted' },
    },
    {
      id: 'S14-C10',
      category: 'C',
      about: 'v11: a negated reacquire alone is rejected, review',
      fix: "Don't re-query the checkbox; use the old handle.",
      expect: { verdict: 'exact', fixes: [], notCounted: { reacquire: 'rejected' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-C11',
      category: 'C',
      about: 'v11: a fix followed by multi-line code',
      fix: "Replace the handle with a locator:\n```ts\nconst checkbox = page.getByRole('checkbox', { name: 'Email notifications' });\nawait checkbox.check();\n```",
      expect: { verdict: 'exact', fixes: ['use-locator'], acceptance: 'accepted' },
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
      about: '"Do not increase the timeout." is negated, not flagged (S14 fix patterns have no negation guard)',
      fix: 'Do not increase the timeout; use a locator instead.',
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { 'more-time': 'negated' }, acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'more-time review; pending_review (recommendation)' },
    },
    {
      id: 'S14-E4',
      category: 'E',
      about: 'a negation two words before the match: "no race or timing problem"',
      summary: 'There was no race or timing problem: the reset replaced the checkbox, and the old handle is detached.',
      expect: { verdict: 'exact', claims: { timing: 'negated' }, fixes: ['use-locator'], acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'timing review; pending_review (root_cause)' },
    },
    {
      id: 'S14-E5',
      category: 'E',
      about: 'a negation after the match: "a race condition is not the cause"',
      summary: 'A race condition is not the cause: the reset replaced the checkbox and the old handle is detached.',
      expect: { verdict: 'exact', claims: { timing: 'negated' }, fixes: ['use-locator'], acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'timing review; pending_review (root_cause)' },
    },
    {
      id: 'S14-E6',
      category: 'E',
      about: '"No sleep is needed" is negated, not flagged',
      fix: 'No sleep is needed; re-query the checkbox after the reset.',
      expect: { verdict: 'exact', fixes: ['reacquire'], bad: { sleep: 'negated' }, acceptance: 'accepted' },
      fixedIn: { version: 9, before: 'sleep review; pending_review (recommendation)' },
    },
    {
      id: 'S14-E7',
      category: 'E',
      about: 'different polarity in one field: the negated sleep is not flagged, the timeout after ", but" is',
      fix: 'Do not add a sleep, but increase the timeout; use a locator instead.',
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { sleep: 'negated', 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-E8',
      category: 'E',
      about: 'two matches of one claim: a negated one does not hide a positive one',
      summary: 'A race condition is not the cause: the reset replaced the checkbox and the old handle is detached. It is also a timing problem in the reset.',
      expect: { verdict: 'exact', claims: { timing: 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S14-E9',
      category: 'E',
      about: 'a hedge is ambiguous, not a denial: "can\'t rule out a race condition" stays reviewable',
      summary: "We can't rule out a race condition, but the reset replaced the checkbox and the old handle is detached.",
      expect: { verdict: 'exact', claims: { timing: 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    {
      id: 'S14-E10',
      category: 'E',
      about: 'code expressions inside a negated clause: waitForTimeout(500) and setTimeout(() => {}, 500)',
      fix: 'Do not add page.waitForTimeout(500) or call setTimeout(() => {}, 500); use a locator instead.',
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { sleep: 'negated' }, acceptance: 'accepted' },
    },
    {
      id: 'S14-E11',
      category: 'E',
      about: 'a positive code expression after "then" is flagged',
      fix: 'Use a locator, then add page.waitForTimeout(500) before the click.',
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { sleep: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-E12',
      category: 'E',
      about: 'TRUNCATED CANDIDATES: more matches than the limit go to review although every one seen is negated',
      fix: `Use a locator instead. ${'Do not add a sleep. '.repeat(POLARITY_LIMITS.maxMatches + 5)}`,
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { sleep: 'negated' }, incomplete: ['recommendation'], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-E13',
      category: 'E',
      about: 'TRUNCATED CLAUSES: a field with more clauses than the limit gets one review finding although its match is negated (v11: use-locator\'s own analysis is truncated too, so it is unresolved, not counted)',
      fix: `Do not add a sleep; ${'use a locator, '.repeat(POLARITY_LIMITS.maxClauses + 5)}done.`,
      expect: { verdict: 'exact', fixes: [], notCounted: { 'use-locator': 'unresolved' }, bad: { sleep: 'negated' }, incomplete: ['recommendation'], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-E14',
      category: 'E',
      about: 'TRUNCATED CLAUSES, no forbidden match: still one review finding, not one per forbidden pattern (v11: use-locator unresolved, as in E13)',
      fix: `${'use a locator, '.repeat(POLARITY_LIMITS.maxClauses + 5)}done.`,
      expect: { verdict: 'exact', fixes: [], notCounted: { 'use-locator': 'unresolved' }, incomplete: ['recommendation'], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-E15',
      category: 'E',
      about: 'TRUNCATED CLAUSES with a positive match: the match keeps its own finding next to the incomplete one (v11: use-locator unresolved, as in E13)',
      fix: `Increase the timeout; ${'use a locator, '.repeat(POLARITY_LIMITS.maxClauses + 5)}done.`,
      expect: { verdict: 'exact', fixes: [], notCounted: { 'use-locator': 'unresolved' }, bad: { 'more-time': 'review' }, incomplete: ['recommendation'], acceptance: 'pending_review', pending: ['recommendation'] },
    },
    {
      id: 'S14-E16',
      category: 'E',
      about: 'TRUNCATED CLAUSES in the summary: root_cause gets the one review finding, the recommendation is unaffected',
      summary: `A race condition is not the cause: the reset replaced the checkbox and the old handle is detached${', in short'.repeat(POLARITY_LIMITS.maxClauses + 5)}.`,
      expect: { verdict: 'exact', claims: { timing: 'negated' }, fixes: ['use-locator'], incomplete: ['root_cause'], acceptance: 'pending_review', pending: ['root_cause'] },
    },
    // E. Line breaks in forbidden items (scorer v12, R3d)
    {
      id: 'S14-E17',
      category: 'E',
      about: 'LINE BREAK: retries in their own bullet after a negated force bullet are flagged; the force bullet stays negated',
      fix: "Use a locator.\n- Don't use force: true\n- add retries: 2",
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { force: 'negated', retries: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      fixedIn: { version: 12, before: 'accepted: "add retries" was negated by the "Don\'t" of the previous bullet' },
    },
    {
      id: 'S14-E18',
      category: 'E',
      about: 'LINE BREAK: bullets that are each negated stay negated, accepted',
      fix: "Use a locator.\n- Don't use force: true\n- Don't add retries\n- Never add waitForTimeout",
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { force: 'negated', retries: 'negated', sleep: 'negated' }, acceptance: 'accepted' },
    },
    {
      id: 'S14-E19',
      category: 'E',
      about: 'LINE BREAK: a line ending in "or" makes the next line\'s match ambiguous, so reviewable',
      fix: 'Use a locator.\nNever use force: true or\nwaitForTimeout.',
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { force: 'negated', sleep: 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
      limitation: { desired: 'the negation distributes over the wrapped "or": sleep negated, accepted' },
    },
    {
      id: 'S14-E20',
      category: 'E',
      about: 'LINE BREAK: a timing claim in its own bullet after a negated one is flagged in root_cause',
      summary: 'The reset replaced the checkbox and the old handle is detached.\n- It is not flaky\n- a race condition in the reset',
      expect: { verdict: 'exact', claims: { timing: 'review' }, fixes: ['use-locator'], acceptance: 'pending_review', pending: ['root_cause'] },
      fixedIn: { version: 12, before: 'accepted: "race condition" was negated by the "not" of the previous bullet' },
    },
    {
      id: 'S14-E21',
      category: 'E',
      about: 'LINE BREAK guard: reported advice before a blank line keeps its review, although the line alone reads negated',
      fix: 'Use a locator. Another engineer suggested several things\n\nDo not increase the timeout.',
      expect: { verdict: 'exact', fixes: ['use-locator'], bad: { 'more-time': 'review' }, acceptance: 'pending_review', pending: ['recommendation'] },
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
    verificationSteps: c.steps ?? [`npx playwright test ${f.spec}`],
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
const flags = (r: ScoreRecord, id: CheckId): Record<string, string> =>
  Object.fromEntries(
    checkOf(r, id)
      .items.filter((i) => i.id.startsWith('forbidden:'))
      // An audit item with any status other than pass shows up as `negated/<status>` and fails the case.
      .map((i) => [i.id.slice('forbidden:'.length), i.tag !== 'forbidden_negated' ? i.status : i.status === 'pass' ? 'negated' : `negated/${i.status}`]),
  );
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
  known(c.expect.fixes, truth.recommendations.acceptable.filter((a) => a.role !== 'supporting'), 'corrective acceptable fix');
  known(c.expect.supporting ?? [], truth.recommendations.acceptable.filter((a) => a.role === 'supporting'), 'supporting acceptable fix');
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

  test('the fixed and remaining limitations are the reviewed ones', () => {
    const all = SCENARIOS.flatMap((s) => s.cases);
    assert.deepEqual(all.filter((c) => c.fixedIn).map((c) => c.id), [
      'S11-E3', 'S11-E4', 'S11-E5', 'S13-C5', 'S13-C12', 'S13-E6', 'S13-E7', 'S13-E8', 'S13-E9', 'S13-E10', 'S13-E13', 'S13-E14', 'S13-E15', 'S13-E16', 'S14-E3', 'S14-E4', 'S14-E5', 'S14-E6', 'S14-E17',
      'S14-E20',
    ]);
    assert.deepEqual(all.filter((c) => c.limitation).map((c) => c.id), ['S11-C5', 'S11-D8', 'S13-A7', 'S13-C24', 'S13-C25', 'S13-D9', 'S13-E11', 'S13-E17', 'S13-E18', 'S13-E19', 'S14-C7', 'S14-D8', 'S14-E19']);
    assert.ok(all.every((c) => !(c.fixedIn && c.limitation)));
  });

  test('negated-match audit items pass, never decide a check, and stay bounded', () => {
    let audit = 0;
    for (const s of SCENARIOS) {
      for (const c of s.cases) {
        for (const id of ['root_cause', 'recommendation'] as const) {
          const chk = checkOf(recordOf(c), id);
          for (const i of chk.items.filter((x) => x.id.startsWith('forbidden:'))) {
            assert.ok(i.detail.length <= 1200, `${c.id} ${i.id}: detail of ${i.detail.length} characters`);
            if (i.tag !== 'forbidden_negated') continue;
            audit++;
            assert.equal(i.status, 'pass', `${c.id} ${i.id}`);
            assert.match(i.detail, /^negated (claim|recommendation) .*\(negated: (negator_before|negated_predicate_after)\)/, `${c.id} ${i.id}`);
          }
          // The check's status is the worst of its other items: an audit item never raises or lowers it.
          const others = chk.items.filter((x) => x.tag !== 'forbidden_negated').map((x) => x.status);
          const expected = (['fail', 'review', 'partial', 'pass'] as const).find((st) => others.includes(st)) ?? 'not_applicable';
          assert.equal(chk.status, expected, `${c.id} ${id}`);
        }
      }
    }
    assert.ok(audit >= 12, `only ${audit} audit items`);
  });

  test('a truncated analysis is one bounded, identifiable review item per check', () => {
    const caseOf = (id: string) => SCENARIOS.flatMap((s) => s.cases).find((x) => x.id === id)!;
    const detail = (caseId: string, check: CheckId, itemId: string) => checkOf(recordOf(caseOf(caseId)), check).items.find((i) => i.id === itemId)!.detail;
    const S14_RECS = 'sleep, more-time, retries, force, set-via-script and 1 more';
    assert.equal(detail('S14-E12', 'recommendation', 'forbidden-analysis'), 'forbidden recommendation analysis incomplete in proposedFix (max_matches), joined fields (max_matches): a missing or negated match there is not trusted (sleep)');
    assert.equal(detail('S14-E13', 'recommendation', 'forbidden-analysis'), `forbidden recommendation analysis incomplete in proposedFix (max_clauses): a missing or negated match there is not trusted (${S14_RECS})`);
    assert.equal(detail('S14-E14', 'recommendation', 'forbidden-analysis'), detail('S14-E13', 'recommendation', 'forbidden-analysis'));
    assert.match(detail('S14-E16', 'root_cause', 'forbidden-analysis'), /^forbidden claim analysis incomplete in failureSummary \(max_clauses\)/);
    // The observed match keeps its own item, which points to the incomplete one.
    assert.match(detail('S14-E13', 'recommendation', 'forbidden:sleep'), /^negated recommendation .* \(analysis incomplete, see forbidden-analysis\)$/);
    assert.match(detail('S14-E15', 'recommendation', 'forbidden:more-time'), /^suspicious recommendation .*"Increase the timeout".* \(analysis incomplete, see forbidden-analysis\)$/);
    // Not counted as a suspicious recommendation (forbiddenHits counts tag "forbidden" only).
    assert.ok(checkOf(recordOf(caseOf('S14-E14')), 'recommendation').items.every((i) => i.tag !== 'forbidden'));
    // v11: the 505 "use a locator" matches also truncate use-locator's own analysis, so its positive matches
    // don't endorse it (v10: acceptable passed, "matched use-locator"). Acceptance, pending checks and
    // blockers are the same as under v10, which already sent these cases to review through forbidden-analysis.
    for (const id of ['S14-E13', 'S14-E14', 'S14-E15']) {
      const r = recordOf(caseOf(id));
      const acceptable = checkOf(r, 'recommendation').items.find((i) => i.id === 'acceptable')!;
      assert.equal(acceptable.status, 'review', id);
      assert.match(acceptable.detail, /^no acceptable fix endorsed; not counted: use-locator \(unresolved: "use a locator" positive: no_negation, .*, 47 more, analysis incomplete\)$/, id);
      assert.deepEqual([r.acceptance.status, r.acceptance.pending, r.acceptance.blockers], ['pending_review', ['recommendation'], []], id);
    }
  });

  test('line breaks (v12): the flagged match is judged in its own line, and a truncated reading is one finding', () => {
    const caseOf = (id: string) => SCENARIOS.flatMap((s) => s.cases).find((x) => x.id === id)!;
    const detail = (caseId: string, check: CheckId, itemId: string) => checkOf(recordOf(caseOf(caseId)), check).items.find((i) => i.id === itemId)!.detail;
    assert.equal(detail('S13-E13', 'recommendation', 'forbidden:retries'), 'suspicious recommendation (Hides the failure with retries): "add retries" in "- add retries: 2" (positive: no_negation)');
    assert.equal(detail('S13-E13', 'recommendation', 'acceptable'), 'matched fix-server');
    assert.match(detail('S13-E15', 'recommendation', 'forbidden:more-time'), /^suspicious recommendation \(Raises timeouts\): "increase the timeout" in "Don't add retries - increase the timeout\." \(ambiguous: line_break_scope\)$/);
    // Both readings negate force, so the v11 match (and its clause excerpt) is kept unchanged.
    assert.equal(detail('S14-E17', 'recommendation', 'forbidden:force'), 'negated recommendation (Bypasses actionability checks), not counted: "force: true" in "- Don\'t use force: true - add retries: 2" (negated: negator_before)');
    assert.equal(detail('S14-E20', 'root_cause', 'forbidden:timing'), 'suspicious claim (Blames timing, a race or a reset that had not finished): "race condition" in "- a race condition in the reset" (positive: no_negation)');
    // The guard case keeps v11's reading: the reported advice makes it ambiguous.
    assert.match(detail('S14-E21', 'recommendation', 'forbidden:more-time'), /\(ambiguous: quoted_or_reported\)$/);
    // Only the lined reading of the step reaches the clause limit; both readings reach it in E23, still one entry.
    assert.match(detail('S13-E22', 'recommendation', 'forbidden-analysis'), /^forbidden recommendation analysis incomplete in verificationSteps\[0\] \(max_clauses\): /);
    assert.match(detail('S13-E23', 'recommendation', 'forbidden-analysis'), /^forbidden recommendation analysis incomplete in verificationSteps\[0\] \(max_clauses\): /);
  });

  test('the cross-field cases really match only across the joined fields, as v8 searched them', async () => {
    const truth = truths.get('S11')!;
    const pattern = new RegExp(truth.recommendations.forbidden.find((f) => f.id === 'change-app')!.pattern, 'gi');
    const fieldsOf = (id: string) => {
      const c = S11.cases.find((x) => x.id === id)!;
      return [c.fix!, ...c.steps!];
    };
    // S11-E8: no single field contains the match that starts at "remove"; the joined text does.
    const e8 = fieldsOf('S11-E8');
    assert.deepEqual(e8.slice(1).map((t) => [...t.matchAll(pattern)].length), [0, 0]);
    assert.deepEqual([...e8.join(' ').matchAll(pattern)].map((m) => m[0]), ['change the CSS', 'remove the display']);
    // S11-E9: the joined match starts where the fix field's own (negated) match starts and runs on into the step.
    const e9 = fieldsOf('S11-E9');
    assert.deepEqual([...e9[0]!.matchAll(pattern)].map((m) => m[0]), ['change the CSS']);
    assert.deepEqual([...e9.join(' ').matchAll(pattern)].map((m) => [m[0], m.index]), [['change the CSS. Check the link display', e9[0]!.indexOf('change')]]);
  });

  test('the report counts review findings only, never negated-match audit items', async () => {
    const { summary } = await reportRun(runDir);
    const eligible = [...records.values()].filter((r) => r.category === 'scored' || r.category === 'needs_review');
    assert.equal(eligible.length, records.size);
    const count = (id: CheckId, tag: string) => eligible.flatMap((r) => checkOf(r, id).items).filter((i) => i.tag === tag).length;
    assert.equal(summary.automatic.rootCause.forbiddenHits, count('root_cause', 'forbidden'));
    assert.equal(summary.automatic.recommendation.forbiddenHits, count('recommendation', 'forbidden'));
    assert.ok(count('root_cause', 'forbidden_negated') > 0 && count('recommendation', 'forbidden_negated') > 0);
    // Acceptance totals follow the records, which the per-case tests pin.
    assert.equal(summary.automatic.acceptance.accepted.count, eligible.filter((r) => r.acceptance.status === 'accepted').length);
    assert.deepEqual(summary.scorerVersions, [SCORER_VERSION]);
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
      const label =
        `${c.id} [${c.category}] ${c.about}` +
        (c.limitation ? ` — KNOWN LIMITATION (current behavior pinned; desired: ${c.limitation.desired})` : '') +
        (c.fixedIn ? ` — FIXED IN v${c.fixedIn.version} (before: ${c.fixedIn.before})` : '');
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
        const supporting = c.expect.supporting ?? [];
        // v11: matched but not counted fixes follow "; not counted: " as "<id> (<verdict>: ...)"; they are never in the matched list.
        const [counted, discounted = ''] = acceptable.detail.split('; not counted: ');
        const notCounted = Object.fromEntries([...discounted.matchAll(/(?:^|; )([\w-]+) \((rejected|conflict|unresolved):/g)].map((x) => [x[1]!, x[2]!]));
        assert.deepEqual(notCounted, c.expect.notCounted ?? {}, `not counted (${acceptable.detail}): ${why}`);
        const supportingOnly = /^only a supporting recommendation matched \((.*)\); no corrective fix (?:matched|endorsed)/.exec(counted!);
        if (c.expect.fixes.length > 0) {
          assert.equal(acceptable.status, 'pass', `acceptable: ${why}`);
          const listed = [...c.expect.fixes, ...supporting.map((id) => `${id} (supporting)`)];
          assert.deepEqual(counted!.replace(/^matched /, '').split(', ').sort(), listed.sort(), `acceptable: ${why}`);
        } else {
          assert.equal(acceptable.status, 'review', `acceptable: ${why}`);
          assert.deepEqual(supportingOnly?.[1]!.split(', ').sort() ?? [], [...supporting].sort(), `acceptable (${acceptable.detail}): ${why}`);
        }
        assert.deepEqual(flags(r, 'recommendation'), c.expect.bad ?? {}, `forbidden recommendations: ${why}`);
        // A truncated analysis: exactly one review item per affected check, none elsewhere.
        for (const id of ['root_cause', 'recommendation'] as const) {
          const incomplete = checkOf(r, id).items.filter((i) => i.tag === 'forbidden_incomplete');
          assert.deepEqual(
            incomplete.map((i) => `${i.id}=${i.status}`),
            (c.expect.incomplete ?? []).includes(id) ? ['forbidden-analysis=review'] : [],
            `${id} incomplete: ${why}`,
          );
        }

        // Overall acceptance: status, and exactly which checks are pending or blocking.
        assert.equal(r.acceptance.status, c.expect.acceptance, why);
        assert.deepEqual([...r.acceptance.pending].sort(), [...(c.expect.pending ?? [])].sort(), `pending: ${why}`);
        assert.deepEqual(blockerIds(r), [...(c.expect.blockers ?? [])].sort(), `blockers: ${why}`);
        assert.equal(r.category, (c.expect.pending ?? []).length > 0 ? 'needs_review' : 'scored', why);
      });
    }
  });
}
