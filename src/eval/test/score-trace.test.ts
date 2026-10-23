import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { MCP_DETAILS, MCP_LIST, MCP_TRACE } from '../../agent/config.ts';
import type { ModelInvestigation } from '../../agent/result.ts';
import { call, report, skillCall, success } from '../../agent/test/helpers.ts';
import { loadReport } from '../../mcp/report.ts';
import { DEFAULT_TRACE_LIMITS, getTraceSummary } from '../../mcp/trace-summary.ts';
import type { TraceLimits } from '../../mcp/trace-summary.ts';
import { failingExpect, failingExpectCall, fetchTrace, gotoCall, navigate, profileDoc, s04, s05 } from '../../mcp/test/scenarios.ts';
import { call as traceRecord, ORIGIN, pageTrace, resource, T0 } from '../../mcp/test/traces.ts';
import { aggregate, renderSummary } from '../report.ts';
import { loadRunManifest, scoreRun } from '../runs.ts';
import { SCENARIOS_DIR } from '../scenarios.ts';
import { SCORER_VERSION } from '../score.ts';
import type { CheckId, ScoreRecord } from '../score.ts';
import { details, list, readSpec, sessionInit, writeEvaluation, writeRunManifest } from './golden.ts';
import type { Facts, Variant } from './golden.ts';
import { buildFakeSnapshot } from './helpers.ts';
import type { FakeRunOptions } from './helpers.ts';

// Scorer v8 on SCORER-VALIDATION fixtures: scripted sessions that call get_trace_summary, replayed
// through the unchanged runInvestigation against fake-Playwright snapshots whose trace.zip is a real
// synthetic Playwright trace. Every get_trace_summary result in a transcript is the real tool output
// for that workspace (src/mcp, default limits unless stated). Scored against the real truth files,
// except where a test adds required trace observations to a temporary copy. Not agent data.

const PROFILE = { file: 'ui/profile.spec.ts', title: 'shows the signed-in user on the profile page' };
const TO_BE_VISIBLE = "Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Dana Demo')\nExpected: visible\nTimeout: 10000ms\nError: element(s) not found";
const ALERT = '\n- alert: Something went wrong while loading your profile.';
const TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Skill', MCP_LIST, MCP_DETAILS, MCP_TRACE];

// ---------------------------------------------------------------------------
// Session building blocks

type Evidence = ModelInvestigation['evidence'][number];
type Point = ModelInvestigation['analysis'][number];
type Opts = { limits?: Partial<TraceLimits['archive']> };

async function summary(f: Facts, retry: number, opts: Opts = {}) {
  const limits = opts.limits ? { ...DEFAULT_TRACE_LIMITS, archive: { ...DEFAULT_TRACE_LIMITS.archive, ...opts.limits } } : undefined;
  return getTraceSummary(await loadReport(f.root), f.testId, retry, limits ? { limits } : {});
}
const traceCall = async (f: Facts, retry: number, opts: Opts = {}, id = `trace-${retry}`) => call(id, MCP_TRACE, { testId: f.testId, retry }, await summary(f, retry, opts));
const deniedTrace = (f: Facts, id = 'trace-0') => call(id, MCP_TRACE, { testId: f.testId, retry: 0 }, 'Permission to use mcp__test-detective__get_trace_summary has been denied.', true);
const readContext = (f: Facts) => call('read-ctx', 'Read', { file_path: f.errorContext }, `error-context bytes${ALERT}`);
const bashTrace = (f: Facts) => call('bash-trace', 'Bash', { command: `unzip -p ${f.trace} '*.network' | grep -E '"status":\\s*[45][0-9]{2}|"failure"' | head -n 20` }, '"status":500');

function stream(f: Facts, inv: ModelInvestigation, extra: SDKMessage[], denials: string[] = []): SDKMessage[] {
  const permission_denials = denials.map((id) => ({ tool_name: MCP_TRACE, tool_use_id: id, tool_input: { testId: f.testId, retry: 0 } }));
  return [sessionInit(f, { tools: TOOLS }), ...skillCall(), ...list(f), ...details(f), ...readSpec(f), ...readContext(f), ...extra, success(report('investigated', [inv], 'Investigated one failed test.'), { permission_denials })];
}

const mcpTrace = (note: string): Evidence => ({ kind: 'trace', status: 'inspected', ref: 'get_trace_summary', note });

function investigation(f: Facts, o: { classification: ModelInvestigation['classification']; summary: string; trace: Evidence; points: Point[]; fix: string; confidence?: 'High' | 'Medium' | 'Low' }): ModelInvestigation {
  return {
    testId: f.testId,
    classification: o.classification,
    failureSummary: o.summary,
    sourceMismatch: false,
    evidence: [
      { kind: 'mcp', status: 'inspected', ref: 'get_failure_details', note: 'toBeVisible on Dana Demo timed out' },
      { kind: 'source', status: 'inspected', ref: f.spec, note: 'The test source' },
      { kind: 'error_context', status: 'inspected', ref: f.errorContext, note: 'The page shows the error alert' },
      { kind: 'screenshot', status: 'skipped', ref: null, note: 'The page snapshot is enough' },
      o.trace,
    ],
    analysis: o.points,
    confidence: { level: o.confidence ?? 'High', justification: 'Direct evidence from the trace summary, the spec and the page snapshot.' },
    proposedFix: o.fix,
    verificationSteps: ['npx playwright test tests/ui/profile.spec.ts'],
  };
}

/** An application-side 500 (S04 truth), told from the trace summary. */
function appDefect(f: Facts, trace: Evidence, tracePoint: string): ModelInvestigation {
  return investigation(f, {
    classification: 'Application defect',
    summary: "GET /api/profile returned HTTP 500, so the page showed 'Something went wrong' instead of the profile.",
    trace,
    points: [
      // An honest "not available" report cites what it did obtain, not the unavailable trace.
      { point: tracePoint, evidenceRefs: [trace.status === 'inspected' ? (trace.ref ?? 'get_trace_summary') : 'get_failure_details'] },
      { point: 'Observed: the page snapshot shows the error alert.', evidenceRefs: [f.errorContext] },
      { point: 'Inference: the spec sets up no route handler, so the server error comes from the application.', evidenceRefs: [f.spec] },
    ],
    fix: 'Investigate the backend handler for /api/profile and check the server logs; no change is needed in the test.',
  });
}

const S04_TRACE_POINT = 'Observed (get_trace_summary retry 0: ok): /api/profile returned 500 with marker none, and there is no route.fulfill call.';

/** A test-made 500 (S05 truth). */
function testDefect(f: Facts, trace: Evidence, tracePoint: string, confidence: 'High' | 'Medium' = 'High'): ModelInvestigation {
  return investigation(f, {
    classification: 'Test-code defect',
    summary: 'The spec answers /api/profile with a 500 through page.route and route.fulfill, then expects the profile to render.',
    trace,
    points: [
      { point: 'Observed: the spec registers page.route for /api/profile and calls route.fulfill with status 500.', evidenceRefs: [f.spec] },
      { point: tracePoint, evidenceRefs: ['get_trace_summary'] },
      { point: 'Inference: the test mocks a server error and then expects success, so it contradicts itself.', evidenceRefs: [f.spec] },
    ],
    fix: 'Remove the route.fulfill mock, or fulfill with status: 200 and a valid body.',
    confidence,
  });
}

// ---------------------------------------------------------------------------
// Fixture groups: one snapshot (and scenario truth) per group

type Expect = { category: ScoreRecord['category']; acceptance: ScoreRecord['acceptance']['status']; checks?: Partial<Record<CheckId, string>>; acquisition?: string };
type Case = { variant: Variant; expect: Expect };
type Group = { name: string; scenarioId: string; run: FakeRunOptions; truth?: (t: Record<string, any>) => void; cases: Case[] };

const v = (name: string, about: string, session: Variant['session'], expect: Expect): Case => ({ variant: { name, about, session }, expect });
const one = (opts: FakeRunOptions): FakeRunOptions => ({ test: PROFILE, message: TO_BE_VISIBLE, errorContextExtra: ALERT, ...opts });

/** S04's trace with a malformed record in the context entry: partial, but every network record read. */
const s04Malformed = () =>
  pageTrace(
    [navigate, failingExpect],
    [...gotoCall, { type: 'before' }, ...failingExpectCall],
    [profileDoc, resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 200, time: 1, serverIP: true })],
  );
/** S04's trace with a large record before /api/profile in the network entry; cut by maxEntryBytes. */
const s04Padded = () =>
  pageTrace(
    [navigate, failingExpect],
    [...gotoCall, ...failingExpectCall],
    [
      profileDoc,
      resource({ url: `${ORIGIN}/assets/app.js`, type: 'script', start: T0 + 180, requestHeaders: Array.from({ length: 40 }, (_, i) => ({ name: `x-pad-${i}`, value: 'p'.repeat(400) })) }),
      resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 200, time: 1, serverIP: true }),
    ],
  );
/** Two fulfilled requests overlapping two fulfill calls: neither call is tied to one request. */
const ambiguousTrace = () =>
  pageTrace(
    [navigate, failingExpect],
    [
      ...gotoCall,
      ...traceRecord('Route', 'fulfill', T0 + 205, T0 + 206, { params: { status: 500, body: 'a' } }),
      ...traceRecord('Route', 'fulfill', T0 + 207, T0 + 208, { params: { status: 200, body: 'b' } }),
      ...failingExpectCall,
    ],
    [profileDoc, resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 200, time: 20, fulfilled: true }), resource({ url: `${ORIGIN}/api/settings`, status: 200, start: T0 + 201, time: 20, fulfilled: true })],
  );

const GROUPS: Group[] = [
  {
    name: 'S04 (application 500, no route)',
    scenarioId: 'S04',
    run: one({ traceBody: () => s04() }),
    cases: [
      v('s04Mcp', 'trace obtained through MCP: verified 500 and request path', async (f) => ({ messages: stream(f, appDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500, marker none.'), S04_TRACE_POINT), await traceCall(f, 0)) }), {
        category: 'scored',
        acceptance: 'accepted',
        checks: { evidence_validity: 'pass', evidence_sufficiency: 'pass', citations: 'pass', trace_consistency: 'pass' },
        acquisition: 'mcp',
      }),
      v('s04MarkerContradiction', 'claims a fulfilled marker the summary does not show', async (f) => ({
        messages: stream(f, appDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500 with marker fulfilled.'), S04_TRACE_POINT), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'not_accepted', checks: { trace_consistency: 'fail', evidence_validity: 'pass' } }),
      v('s04StatusContradiction', 'claims a 503 for /api/profile; the summary shows 500', async (f) => ({
        messages: stream(f, appDefect(f, mcpTrace('retry 0: ok. /api/profile returned 503.'), S04_TRACE_POINT), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'not_accepted', checks: { trace_consistency: 'fail' } }),
      v('s04Fabricated', 'cites get_trace_summary without ever calling it', (f) => ({ messages: stream(f, appDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500, marker none.'), S04_TRACE_POINT), []) }), {
        category: 'unverified',
        acceptance: 'not_eligible',
        checks: { evidence_validity: 'fail', citations: 'fail', trace_consistency: 'fail', evidence_sufficiency: 'fail' },
        acquisition: 'not_obtained',
      }),
      v('s04Bash', 'tool denied, then the permitted Bash fallback read the trace', (f) => ({
        messages: stream(
          f,
          appDefect(f, { kind: 'trace', status: 'inspected', ref: f.trace!, note: 'get_trace_summary was denied; the fallback command shows /api/profile status 500 and no _wasFulfilled' }, 'Observed: the trace network entries show /api/profile with status 500 and no _wasFulfilled.'),
          [...deniedTrace(f), ...bashTrace(f)],
          ['trace-0'],
        ),
      }), { category: 'scored', acceptance: 'accepted', checks: { evidence_sufficiency: 'pass', trace_consistency: 'not_applicable' }, acquisition: 'bash' }),
      v('s04Denied', 'tool denied, no fallback: reported as not available', (f) => ({
        messages: stream(
          f,
          appDefect(f, { kind: 'trace', status: 'not_available', ref: 'get_trace_summary', note: 'retry 0: the call was denied' }, 'Inference: without the trace, the 500 is inferred from the page alert.'),
          deniedTrace(f),
          ['trace-0'],
        ),
      }), { category: 'scored', acceptance: 'not_accepted', checks: { evidence_validity: 'pass', evidence_sufficiency: 'fail' }, acquisition: 'not_obtained' }),
      v('s04Invalid', 'a tool result that fails the output schema is not evidence', async (f) => {
        const out = await summary(f, 0);
        return { messages: stream(f, appDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500, marker none.'), S04_TRACE_POINT), call('trace-0', MCP_TRACE, { testId: f.testId, retry: 0 }, { ...out, trace: { ...out.trace, status: 'classified' } })) };
      }, { category: 'unverified', acceptance: 'not_eligible', checks: { evidence_validity: 'fail' }, acquisition: 'not_obtained' }),
    ],
  },
  {
    name: 'S04 with required trace observations (temporary truth copy)',
    scenarioId: 'S04',
    run: one({ traceBody: () => s04Padded() }),
    truth: (t) => {
      const trace = t.requiredEvidence.find((r: { kind: string }) => r.kind === 'trace');
      trace.observations = [{ path: '^/api/profile$', status: 500, marker: 'none' }];
    },
    cases: [
      v('obsComplete', 'full read: the required observation is returned', async (f) => ({ messages: stream(f, appDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500, marker none.'), S04_TRACE_POINT), await traceCall(f, 0)) }), {
        category: 'scored',
        acceptance: 'accepted',
        checks: { evidence_sufficiency: 'pass', trace_consistency: 'pass' },
      }),
      v('obsPartialMissing', 'partial read without the decisive event: review, never fail or pass', async (f) => ({
        messages: stream(f, appDefect(f, mcpTrace('retry 0: partial (entry_over_size_limit); events after the cut are unknown.'), 'Inference (get_trace_summary retry 0: partial): the network records before the cut show no error.'), await traceCall(f, 0, { limits: { maxEntryBytes: 12_000 } })),
      }), { category: 'needs_review', acceptance: 'pending_review', checks: { evidence_sufficiency: 'review', evidence_validity: 'pass' } }),
      v('obsPartialClaimsAbsence', 'partial read: "no failed requests" cannot be shown', async (f) => ({
        messages: stream(f, appDefect(f, mcpTrace('retry 0: partial. No failed requests.'), 'Observed (get_trace_summary retry 0): no failed requests.'), await traceCall(f, 0, { limits: { maxEntryBytes: 12_000 } })),
      }), { category: 'needs_review', acceptance: 'pending_review', checks: { trace_consistency: 'review' } }),
    ],
  },
  {
    name: 'S04 partial trace with the decisive event present',
    scenarioId: 'S04',
    run: one({ traceBody: () => s04Malformed() }),
    truth: (t) => {
      const trace = t.requiredEvidence.find((r: { kind: string }) => r.kind === 'trace');
      trace.observations = [{ path: '^/api/profile$', status: 500, marker: 'none' }];
    },
    cases: [
      v('obsPartialPresent', 'partial read that still returned the decisive 500', async (f) => ({
        messages: stream(f, appDefect(f, mcpTrace('retry 0: partial (malformed_lines). /api/profile returned 500, marker none.'), 'Observed (get_trace_summary retry 0: partial): /api/profile returned 500 with marker none.'), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'accepted', checks: { evidence_sufficiency: 'pass', trace_consistency: 'pass' } }),
      v('obsPartialCalledComplete', 'describes a partial trace as complete', async (f) => ({
        messages: stream(f, appDefect(f, mcpTrace('retry 0: the complete trace shows /api/profile returned 500.'), S04_TRACE_POINT.replace('retry 0: ok', 'retry 0: partial')), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'not_accepted', checks: { trace_consistency: 'fail' } }),
    ],
  },
  {
    name: 'S05 (test-created 500)',
    scenarioId: 'S05',
    run: one({ traceBody: () => s05() }),
    cases: [
      v('s05Mcp', 'test-created fulfillment: fulfilled, no fetch link, own body', async (f) => ({
        messages: stream(
          f,
          testDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500 with marker fulfilled; the fulfillment has no fetch link and supplied its own body.'), 'Observed (get_trace_summary): /api/profile returned 500, marker fulfilled, fetch link none; the response was created by the test.'),
          await traceCall(f, 0),
        ),
      }), { category: 'scored', acceptance: 'accepted', checks: { trace_consistency: 'pass', evidence_sufficiency: 'pass' }, acquisition: 'mcp' }),
      v('s05NoBackend', '"no backend fetch" is consistent here (complete summary, none recorded)', async (f) => ({
        messages: stream(f, testDefect(f, mcpTrace('retry 0: ok. Marker fulfilled; no backend fetch was made.'), 'Observed (get_trace_summary): the request never reached the backend; /api/profile returned 500.'), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'accepted', checks: { trace_consistency: 'pass' } }),
    ],
  },
  {
    name: 'S04 truth, backend 500 fetched and passed through unchanged',
    scenarioId: 'S04',
    run: one({ traceBody: () => fetchTrace(500, { status: 500, headers: [], isBase64: false }, 500) }),
    cases: [
      v('passthroughCorrect', 'fulfilled, but linked to a backend fetch with the status unchanged', async (f) => ({
        messages: stream(
          f,
          appDefect(
            f,
            mcpTrace('retry 0: ok. /api/profile returned 500 with marker fulfilled; fetch link linked, fetchedStatus 500, statusChanged false.'),
            'Observed (get_trace_summary): the route handler fetched /api/profile with route.fetch() and passed the 500 on unchanged; the backend returned 500.',
          ),
          await traceCall(f, 0),
        ),
      }), { category: 'scored', acceptance: 'accepted', checks: { trace_consistency: 'pass' } }),
      v('passthroughCalledTestCreated', '"fulfilled" read as test-created: contradicted by the identifier link', async (f) => ({
        messages: stream(
          f,
          testDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500 with marker fulfilled.'), 'Observed (get_trace_summary): /api/profile is fulfilled, so the 500 is a test-created response.'),
          await traceCall(f, 0),
        ),
        // The wrong classification also leaves root-cause and recommendation patterns to review.
      }), { category: 'needs_review', acceptance: 'not_accepted', checks: { trace_consistency: 'fail', classification: 'fail' } }),
      v('passthroughNoBackendClaim', 'an unlinked-looking claim of "no backend fetch" is disproved by backendFetches', async (f) => ({
        messages: stream(f, appDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500.'), 'Observed (get_trace_summary): the response never reached the backend.'), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'not_accepted', checks: { trace_consistency: 'fail' } }),
    ],
  },
  {
    name: 'S05 truth, fetched 200 changed to 500 by the test',
    scenarioId: 'S05',
    run: one({ traceBody: () => fetchTrace(200, { status: 500, headers: [], isBase64: false }, 500) }),
    cases: [
      v('modifiedCorrect', 'linked fetch with statusChanged true', async (f) => ({
        messages: stream(f, testDefect(f, mcpTrace('retry 0: ok. Fetch link linked, fetchedStatus 200, statusChanged true.'), 'Observed (get_trace_summary): the backend returned 200 and the test changed the status to 500 (statusChanged: true).'), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'accepted', checks: { trace_consistency: 'pass' } }),
      v('modifiedCalledUnchanged', 'claims the status was passed through unchanged', async (f) => ({
        messages: stream(f, testDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500.'), 'Observed (get_trace_summary): the handler passed the backend response through unchanged.'), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'not_accepted', checks: { trace_consistency: 'fail' } }),
    ],
  },
  {
    name: 'S05 truth, ambiguous fetch-to-fulfill correlation',
    scenarioId: 'S05',
    run: one({ traceBody: () => ambiguousTrace() }),
    cases: [
      v('ambiguousStatusChange', 'claims a status change no identifier link can show: review', async (f) => ({
        messages: stream(f, testDefect(f, mcpTrace('retry 0: ok. /api/profile returned 500 with marker fulfilled.'), 'Inference (get_trace_summary): the handler modified the response status.', 'Medium'), await traceCall(f, 0)),
      }), { category: 'needs_review', acceptance: 'pending_review', checks: { trace_consistency: 'review' } }),
    ],
  },
  {
    name: 'S07 (flaky: the failed attempt has a trace, the passing retry none)',
    scenarioId: 'S07',
    run: one({ attempts: ['failed', 'passed'], retries: 1, traceBody: () => s04() }),
    cases: [
      v('s07RetryCorrect', 'retry 0 ok, retry 1 missing, attributed correctly', async (f) => ({
        messages: stream(f, s07(f, 'retry 0: ok; retry 1: missing. /api/profile returned 500, marker none.'), [...(await traceCall(f, 0)), ...(await traceCall(f, 1))]),
      }), { category: 'scored', acceptance: 'accepted', checks: { trace_consistency: 'pass', evidence_sufficiency: 'pass' }, acquisition: 'mcp' }),
      v('s07RetryWrong', 'attributes the 500 to retry 1, whose trace was never obtained', async (f) => ({
        messages: stream(f, s07(f, 'retry 1: ok. /api/profile returned 500.'), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'not_accepted', checks: { trace_consistency: 'fail' } }),
    ],
  },
  {
    name: 'S04 with an unreadable trace (not a ZIP)',
    scenarioId: 'S04',
    run: one({}),
    cases: [
      v('unsupportedHonest', 'unsupported reported as not available', async (f) => ({
        messages: stream(f, appDefect(f, { kind: 'trace', status: 'not_available', ref: 'get_trace_summary', note: 'retry 0: unsupported (not_zip)' }, 'Inference: the page alert indicates a server error.'), await traceCall(f, 0)),
      }), { category: 'scored', acceptance: 'not_accepted', checks: { evidence_validity: 'pass', evidence_sufficiency: 'fail', trace_consistency: 'not_applicable' }, acquisition: 'not_obtained' }),
      v('unsupportedInvented', 'network claims citing an unsupported trace', async (f) => ({
        messages: stream(f, appDefect(f, mcpTrace('retry 0: /api/profile returned 500, marker none.'), S04_TRACE_POINT), await traceCall(f, 0)),
      }), { category: 'unverified', acceptance: 'not_eligible', checks: { evidence_validity: 'fail', trace_consistency: 'fail' } }),
    ],
  },
];

function s07(f: Facts, note: string): ModelInvestigation {
  return investigation(f, {
    classification: 'Application defect',
    summary: 'Flaky: attempt 1 failed because GET /api/profile returned HTTP 500 and the page showed its error alert; the retry passed.',
    trace: mcpTrace(note),
    points: [
      { point: 'Observed: attempt 1 failed and retry 1 passed, so Playwright reported the test as flaky.', evidenceRefs: ['get_failure_details'] },
      { point: `Observed (get_trace_summary ${note.split('.')[0]}): /api/profile returned 500 with marker none.`, evidenceRefs: ['get_trace_summary'] },
      { point: 'Inference: the spec sets up no page.route, so the 500 came from the application.', evidenceRefs: [f.spec] },
    ],
    fix: 'Investigate the server logs for the intermittent 500 on /api/profile; no change is needed in the test.',
  });
}

// ---------------------------------------------------------------------------

const base = await mkdtemp(path.join(tmpdir(), 'td-score-trace-'));
after(() => rm(base, { recursive: true, force: true }));
const records = new Map<string, ScoreRecord>();
const runDirs: string[] = [];

for (const [g, group] of GROUPS.entries()) {
  const dir = path.join(base, `group-${g}`);
  const { snapshot, snapshotsRoot } = await buildFakeSnapshot(path.join(dir, `fixture-${group.scenarioId.slice(1)}`), group.run, undefined, group.scenarioId);
  let scenariosRoot = SCENARIOS_DIR;
  if (group.truth) {
    scenariosRoot = path.join(dir, 'scenarios');
    await mkdir(scenariosRoot, { recursive: true });
    await cp(path.join(SCENARIOS_DIR, group.scenarioId), path.join(scenariosRoot, group.scenarioId), { recursive: true });
    const file = path.join(scenariosRoot, group.scenarioId, 'truth.json');
    const truth = JSON.parse(await readFile(file, 'utf8'));
    group.truth(truth);
    await writeFile(file, JSON.stringify(truth, null, 2));
  }
  const runDir = path.join(dir, 'run');
  await writeRunManifest(runDir, `scorer-validation-trace-${g}`);
  for (const [i, c] of group.cases.entries()) await writeEvaluation(runDir, `${group.scenarioId}-${String(i + 1).padStart(2, '0')}`, snapshot, c.variant, path.join(dir, 'work'), scenariosRoot);
  const scored = await scoreRun(runDir, { snapshotsRoot, scenariosRoot });
  for (const [i, c] of group.cases.entries()) records.set(c.variant.name, scored.records.find((r) => r.evalId === `${group.scenarioId}-${String(i + 1).padStart(2, '0')}`)!);
  runDirs.push(runDir);
}

const statusOf = (r: ScoreRecord, id: CheckId) => r.checks.find((c) => c.id === id)!;
const summaryOf = (r: ScoreRecord) =>
  `${r.category}/${r.acceptance.status}: ${r.reasons.join('; ')} | ${r.checks
    .filter((c) => c.status !== 'pass' && c.status !== 'not_applicable')
    .map((c) => `${c.id}=${c.status} (${c.detail})`)
    .join(' · ')}`;

describe('scorer v8: trace evidence through get_trace_summary (scorer-validation fixtures)', () => {
  for (const group of GROUPS) {
    for (const c of group.cases) {
      test(`${group.name} / ${c.variant.name}: ${c.variant.about}`, () => {
        const r = records.get(c.variant.name)!;
        assert.equal(r.scorerVersion, SCORER_VERSION);
        assert.equal(r.setup.ok, true, r.setup.problems.join('; '));
        assert.notEqual(r.audit.verdict, 'violation');
        assert.ok(!r.audit.suspicious.some((s) => s.kind === 'unexpected-tool'), 'get_trace_summary is an expected tool');
        assert.equal(r.category, c.expect.category, summaryOf(r));
        assert.equal(r.acceptance.status, c.expect.acceptance, summaryOf(r));
        for (const [id, status] of Object.entries(c.expect.checks ?? {})) assert.equal(statusOf(r, id as CheckId).status, status, `${id}: ${statusOf(r, id as CheckId).detail}`);
        if (c.expect.acquisition) assert.equal(r.traceEvidence?.tests[0]?.acquisition, c.expect.acquisition, JSON.stringify(r.traceEvidence));
      });
    }
  }
});

describe('scorer v8: what the decisions rest on', () => {
  const items = (name: string, id: CheckId) => statusOf(records.get(name)!, id).items;

  test('a verified 500 and request path come from the returned summary, tied to testId and retry', () => {
    const r = records.get('s04Mcp')!;
    // Retry status, path + HTTP status, and route marker; each checked against retry 0's summary.
    assert.deepEqual(
      items('s04Mcp', 'trace_consistency').map((i) => i.detail),
      ['retry 0 reported as ok, as returned', '/api/profile with status 500 is in the summary (retry 0: ok)', 'marker none is in the summary (retry 0: ok)'],
    );
    assert.deepEqual(r.traceEvidence?.tests[0]?.summaries, [{ retry: 0, status: 'ok', reasons: [] }]);
    assert.ok(items('s04Mcp', 'evidence_sufficiency').some((i) => i.id.startsWith('trace:') && i.status === 'pass'));
  });

  test('fulfilled is not test-created: a pass-through link contradicts that claim, and the correct reading passes', () => {
    assert.ok(items('passthroughCalledTestCreated', 'trace_consistency').some((i) => i.tag === 'contradiction' && /reused a backend fetch with its status unchanged/.test(i.detail)));
    assert.equal(records.get('passthroughCalledTestCreated')!.classification.tests[0]!.verdict, 'incorrect');
    assert.ok(items('passthroughCorrect', 'trace_consistency').every((i) => i.status === 'pass'));
  });

  test('an unlinked fulfillment does not prove no backend fetch: backendFetches decide it', () => {
    assert.ok(items('passthroughNoBackendClaim', 'trace_consistency').some((i) => i.tag === 'contradiction' && /records 1 API-context fetch/.test(i.detail)));
    assert.ok(items('s05NoBackend', 'trace_consistency').some((i) => i.status === 'pass' && /no backend fetch in the complete summary/.test(i.detail)));
  });

  test('a status change is proven only by a link: contradicted when linked, review when not', () => {
    assert.ok(items('modifiedCalledUnchanged', 'trace_consistency').some((i) => i.tag === 'contradiction' && /statusChanged true/.test(i.detail)));
    assert.ok(items('ambiguousStatusChange', 'trace_consistency').some((i) => i.status === 'review' && /no fulfillment is linked/.test(i.detail)));
  });

  test('partial traces never prove absence; a partial read that returned the decisive event suffices', () => {
    assert.ok(items('obsPartialMissing', 'evidence_sufficiency').some((i) => i.status === 'review' && /did not return a request matching .*only partly read/.test(i.detail)));
    assert.ok(items('obsPartialClaimsAbsence', 'trace_consistency').some((i) => i.status === 'review' && /absence is not shown/.test(i.detail)));
    assert.ok(items('obsPartialPresent', 'evidence_sufficiency').some((i) => i.id.startsWith('trace:') && i.status === 'pass'));
    assert.deepEqual(records.get('obsPartialPresent')!.traceEvidence!.tests[0]!.summaries, [{ retry: 0, status: 'partial', reasons: ['malformed_lines'] }]);
    assert.match(records.get('obsPartialPresent')!.traceEvidence!.tests[0]!.limitations.join(' '), /partial \(malformed_lines\)/);
  });

  test('missing, unsupported, denied and invalid results are never inspected evidence', () => {
    assert.ok(items('unsupportedInvented', 'evidence_validity').some((i) => i.tag === 'confirmed_false' && /unsupported \(not_zip\)/.test(i.detail)));
    assert.ok(items('unsupportedInvented', 'trace_consistency').some((i) => i.tag === 'unsupported'));
    assert.ok(items('s04Denied', 'evidence_validity').some((i) => i.tag === 'access_denied'));
    assert.deepEqual(records.get('s04Denied')!.traceEvidence!.tests[0]!.summaries, [{ retry: 0, status: 'denied', reasons: [] }]);
    assert.deepEqual(records.get('s04Invalid')!.traceEvidence!.tests[0]!.summaries.map((s) => s.status), ['invalid']);
  });

  test('retry attribution: the cited attempt must be one whose trace was obtained', () => {
    assert.ok(items('s07RetryWrong', 'trace_consistency').some((i) => i.tag === 'retry_mismatch' && /reports retry 1 as ok, but get_trace_summary was called only for retry 0/.test(i.detail)));
    // The same 500 attributed to the attempt that was read is consistent.
    assert.ok(items('s07RetryWrong', 'trace_consistency').some((i) => i.status === 'pass' && /retry 0: ok\)$/.test(i.detail)));
    assert.deepEqual(records.get('s07RetryCorrect')!.traceEvidence!.tests[0]!.summaries.map((s) => [s.retry, s.status]), [
      [0, 'ok'],
      [1, 'missing'],
    ]);
  });

  test('the legitimate Bash fallback keeps file-based provenance', () => {
    assert.ok(items('s04Bash', 'evidence_sufficiency').some((i) => i.status === 'pass' && i.tag === 'verified'));
    assert.deepEqual(records.get('s04Bash')!.traceEvidence!.tests[0]!.summaries.map((s) => s.status), ['denied']);
  });

  test('the report counts acquisition, tool statuses and limitations, and keeps the two diagnostic metrics apart', async () => {
    const scores = [...records.values()].map((record) => ({ record, sha256: record.evalId }));
    const summary = aggregate(await loadRunManifest(runDirs[0]!), scores, null);
    assert.equal(summary.traceEvidence.tests, records.size);
    assert.ok(summary.traceEvidence.acquisition.mcp > 0 && summary.traceEvidence.acquisition.bash === 1);
    assert.ok(summary.traceEvidence.toolStatuses.denied === 2 && summary.traceEvidence.toolStatuses.invalid === 1 && summary.traceEvidence.toolStatuses.missing === 1);
    assert.ok(summary.automatic.evidence.traceClaims.contradictions > 0 && summary.automatic.evidence.traceClaims.retryMismatches === 1);
    assert.notDeepEqual(summary.automatic.classification.exact, summary.automatic.acceptance.accepted);
    const md = renderSummary(summary);
    assert.match(md, /## Trace evidence acquisition/);
    assert.match(md, /Trace claims vs get_trace_summary: consistent \d+, contradictions \d+/);
  });
});
