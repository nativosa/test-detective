import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { getFailureDetails, listFailures, loadReport } from '../../mcp/report.ts';
import { DEFAULT_TRACE_LIMITS, getTraceSummary } from '../../mcp/trace-summary.ts';
import type { TraceLimits, TraceSummaryOutput } from '../../mcp/trace-summary.ts';
import { makeRepo } from '../../mcp/test/helpers.ts';
import { failingExpect, failingExpectCall, fetchTrace, gotoCall, navigate, profileDoc, s04, s05 } from '../../mcp/test/scenarios.ts';
import { call as traceCall, ORIGIN, pageTrace, resource, RESULT_DIR, T0, traceReport } from '../../mcp/test/traces.ts';
import type { AttemptSpec } from '../../mcp/test/traces.ts';
import { MCP_DETAILS, MCP_LIST, MCP_TRACE } from '../config.ts';
import { InvestigationResult, ModelReport, renderMarkdown } from '../result.ts';
import type { ModelInvestigation } from '../result.ts';
import { runInvestigation } from '../run.ts';
import { args, call, fakeQuery, init, investigatedStream, CHECKBOXES, REPO_ROOT, report, skillCall, success } from './helpers.ts';

// Stage 3.3: investigations that use get_trace_summary. The MCP payloads are real tool output,
// produced by src/mcp from synthetic traces (no snapshots, no model). The model's side is scripted;
// what is tested is how run.ts validates, records and checks it against what was observed.

const TRACE = `${RESULT_DIR}/trace.zip`;
const SPEC = 'tests/ui/profile.spec.ts';
const ALL_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Skill', MCP_LIST, MCP_DETAILS, MCP_TRACE];

type Scenario = {
  testId: string;
  messages: (id: string) => SDKMessage[];
  /** The tool's real result for one retry, also returned for assertions. */
  summary: (retry: number) => Promise<TraceSummaryOutput>;
};

/** A synthetic repo with one failing test; its MCP results come from the real server code. */
async function scenario(t: TestContext, attempts: AttemptSpec[], zip: Buffer | null, limits?: TraceLimits): Promise<Scenario> {
  const root = await makeRepo(t, { raw: traceReport(attempts), files: zip ? { [TRACE]: zip } : {} });
  const loaded = await loadReport(root);
  const list = listFailures(loaded);
  const testId = list.failures[0]!.testId;
  const details = await getFailureDetails(loaded, testId);
  return {
    testId,
    messages: () => [init({ tools: ALL_TOOLS }), ...skillCall(), ...call('list-1', MCP_LIST, {}, list), ...call('details-1', MCP_DETAILS, { testId }, details)],
    summary: (retry) => getTraceSummary(loaded, testId, retry, limits ? { limits } : {}),
  };
}

const traceCallMessages = (id: string, testId: string, retry: number, result: unknown, isError = false) => call(id, MCP_TRACE, { testId, retry }, result, isError);

function analysis(testId: string, overrides: Partial<ModelInvestigation> & { trace?: ModelInvestigation['evidence'][number] }): ModelInvestigation {
  const { trace, ...rest } = overrides;
  return {
    testId,
    classification: 'Inconclusive',
    failureSummary: 'The profile never rendered; the page showed an error alert.',
    sourceMismatch: false,
    evidence: [
      { kind: 'mcp', status: 'inspected', ref: 'get_failure_details', note: 'toBeVisible timed out on the profile name' },
      { kind: 'source', status: 'inspected', ref: SPEC, note: 'route handler and assertion read' },
      trace ?? { kind: 'trace', status: 'inspected', ref: 'get_trace_summary', note: 'retry 0: ok' },
    ],
    analysis: [{ point: 'Observed: see trace evidence.', evidenceRefs: ['get_trace_summary'] }],
    confidence: { level: 'Medium', justification: 'Scripted.' },
    proposedFix: 'n/a',
    verificationSteps: [`npx playwright test ${SPEC}`],
    ...rest,
  };
}

async function run(messages: SDKMessage[], investigations: ModelInvestigation[]) {
  const fake = fakeQuery({ messages: [...messages, success(report('investigated', investigations))] });
  const result = await runInvestigation(args(), { repoRoot: REPO_ROOT, query: fake.query, env: {} });
  assert.deepEqual(InvestigationResult.parse(result), result, 'result matches the published schema');
  return result;
}

const browserRequest = (s: TraceSummaryOutput, p: string) => s.network!.requests.find((r) => r.path === p)!;

describe('trace evidence in scripted investigations: the S04/S05 distinction', () => {
  test('S04: a 500 with marker none and no route call is observed and recorded; the run completes', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], s04());
    const summary = await sc.summary(0);
    // The observation the report relies on is in the tool output.
    assert.equal(summary.trace.status, 'ok');
    assert.equal(browserRequest(summary, '/api/profile').marker, 'none');
    assert.equal(browserRequest(summary, '/api/profile').status, 500);
    assert.deepEqual(summary.routes!.calls, { fulfill: 0, continue: 0, abort: 0, fallback: 0 });

    const result = await run([...sc.messages('s04'), ...traceCallMessages('trace-1', sc.testId, 0, summary)], [
      analysis(sc.testId, { classification: 'Application defect', analysis: [{ point: 'Observed: /api/profile returned 500 with route marker none and no route calls.', evidenceRefs: ['get_trace_summary'] }] }),
    ]);
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
    assert.deepEqual(result.observed.traceSummaries, [{ testId: sc.testId, retry: 0, status: 'ok', reportFingerprint: summary.reportFingerprint, reasons: [] }]);
    assert.ok(result.observed.toolCalls.some((c) => c.name === MCP_TRACE && c.outcome === 'ok'));
    assert.match(renderMarkdown(result), /\*\*Trace summaries:\*\* retry 0: ok/);
  });

  test('S05: fulfilled with the test\'s own body and no fetch link; the same status as S04, different provenance', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], s05());
    const summary = await sc.summary(0);
    const request = browserRequest(summary, '/api/profile');
    assert.equal(request.status, 500);
    assert.equal(request.marker, 'fulfilled');
    const [fulfillment] = summary.routes!.fulfillments;
    assert.deepEqual([fulfillment!.fetch, fulfillment!.bodyProvided, fulfillment!.request], [{ link: 'none' }, true, { correlation: 'unique', ref: request.ref }]);

    const result = await run([...sc.messages('s05'), ...traceCallMessages('trace-1', sc.testId, 0, summary)], [analysis(sc.testId, { classification: 'Test-code defect' })]);
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
  });

  test('route.fetch() + route.fulfill({ response }) passing a genuine backend 500: linked, status unchanged, backend fetch recorded', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], fetchTrace(500, { status: 500, headers: [], isBase64: false }, 500));
    const summary = await sc.summary(0);
    assert.equal(browserRequest(summary, '/api/profile').marker, 'fulfilled', 'fulfilled even though the backend produced the 500');
    const [fulfillment] = summary.routes!.fulfillments;
    assert.deepEqual(fulfillment!.fetch, { link: 'linked', fetchedStatus: 500, statusChanged: false, backendFetch: 'b1' });
    assert.equal(summary.backendFetches!.items[0]!.status, 500);

    const result = await run([...sc.messages('fetch'), ...traceCallMessages('trace-1', sc.testId, 0, summary)], [analysis(sc.testId, { classification: 'Application defect' })]);
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
  });

  test('a test-modified fulfillment: the identifier link proves the status change', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], fetchTrace(200, { status: 500, headers: [], isBase64: false }, 500));
    const summary = await sc.summary(0);
    assert.deepEqual(summary.routes!.fulfillments[0]!.fetch, { link: 'linked', fetchedStatus: 200, statusChanged: true, backendFetch: 'b1' });

    const result = await run([...sc.messages('modified'), ...traceCallMessages('trace-1', sc.testId, 0, summary)], [analysis(sc.testId, { classification: 'Test-code defect' })]);
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
  });

  test('ambiguous correlation: two overlapping fulfilled requests, neither fulfill call tied to one', async (t) => {
    const zip = pageTrace(
      [navigate, failingExpect],
      [...gotoCall, ...traceCall('Route', 'fulfill', T0 + 205, T0 + 206, { params: { status: 500, body: 'a' } }), ...traceCall('Route', 'fulfill', T0 + 207, T0 + 208, { params: { status: 200, body: 'b' } }), ...failingExpectCall],
      [profileDoc, resource({ url: `${ORIGIN}/api/a`, status: 500, start: T0 + 200, time: 20, fulfilled: true }), resource({ url: `${ORIGIN}/api/b`, status: 200, start: T0 + 201, time: 20, fulfilled: true })],
    );
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], zip);
    const summary = await sc.summary(0);
    assert.deepEqual(summary.routes!.fulfillments.map((f) => f.request), [{ correlation: 'ambiguous', candidates: 2 }, { correlation: 'ambiguous', candidates: 2 }]);
    assert.ok(summary.network!.requests.every((r) => r.fulfillment === null), 'no request is attributed to a fulfill call');

    const result = await run([...sc.messages('ambiguous'), ...traceCallMessages('trace-1', sc.testId, 0, summary)], [analysis(sc.testId, { classification: 'Inconclusive' })]);
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
  });
});

describe('trace evidence: partial, missing and retry-specific results', () => {
  test('partial: usable evidence, recorded with its reasons', async (t) => {
    const limits: TraceLimits = { ...DEFAULT_TRACE_LIMITS, archive: { ...DEFAULT_TRACE_LIMITS.archive, maxLines: 6 } };
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], s04(), limits);
    const summary = await sc.summary(0);
    assert.equal(summary.trace.status, 'partial');
    assert.equal(summary.coverage!.countsAreLowerBounds, true);

    const result = await run([...sc.messages('partial'), ...traceCallMessages('trace-1', sc.testId, 0, summary)], [
      analysis(sc.testId, { trace: { kind: 'trace', status: 'inspected', ref: 'get_trace_summary', note: 'retry 0: partial (line budget); unlisted events unknown' } }),
    ]);
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
    assert.deepEqual(result.observed.traceSummaries?.map((s) => [s.status, s.reasons.includes('line_budget')]), [['partial', true]]);
  });

  test('missing: reported as not available completes; citing it as inspected trace evidence is unverified', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: null }], null);
    const summary = await sc.summary(0);
    assert.deepEqual([summary.trace.status, summary.trace.reasons.map((r) => r.code)], ['missing', ['no_trace_attachment']]);
    const stream = [...sc.messages('missing'), ...traceCallMessages('trace-1', sc.testId, 0, summary)];

    const honest = await run(stream, [
      analysis(sc.testId, { trace: { kind: 'trace', status: 'not_available', ref: 'get_trace_summary', note: 'retry 0: missing (no_trace_attachment)' }, analysis: [{ point: 'Inference: from the source only.', evidenceRefs: [SPEC] }] }),
    ]);
    assert.equal(honest.runStatus, 'completed', honest.issues.join('\n'));

    const invented = await run(stream, [analysis(sc.testId, { trace: { kind: 'trace', status: 'inspected', ref: 'get_trace_summary', note: 'retry 0: /api/profile 500' } })]);
    assert.equal(invented.runStatus, 'unverified');
    assert.ok(invented.issues.some((i) => i.includes('cites get_trace_summary, but no get_trace_summary result with trace evidence')), invented.issues.join('\n'));
  });

  test('S07 shape: the failed attempt has a trace, the passing retry has none, a nonexistent retry is an error', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }, { status: 'passed', trace: null }], s04());
    const [failed, passed] = [await sc.summary(0), await sc.summary(1)];
    assert.equal(failed.trace.status, 'ok');
    assert.equal(passed.trace.status, 'missing');
    const notFound = { error: { code: 'ATTEMPT_NOT_FOUND', message: 'Test has no attempt with retry 2 (attempts: 0, 1).', hint: 'Use a retry index from get_failure_details attempts[].retry.' } };

    const result = await run(
      [
        ...sc.messages('s07'),
        ...traceCallMessages('trace-0', sc.testId, 0, failed),
        ...traceCallMessages('trace-1', sc.testId, 1, passed),
        ...traceCallMessages('trace-2', sc.testId, 2, notFound, true),
      ],
      [analysis(sc.testId, { trace: { kind: 'trace', status: 'inspected', ref: 'get_trace_summary', note: 'retry 0 (failed): ok; retry 1 (passed): missing' } })],
    );
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
    assert.equal(result.investigations[0]!.facts!.outcome, 'flaky');
    assert.deepEqual(
      result.observed.traceSummaries?.map((s) => [s.retry, s.status, s.reasons]),
      [
        [0, 'ok', []],
        [1, 'missing', ['no_trace_attachment']],
        [2, 'error', ['ATTEMPT_NOT_FOUND']],
      ],
    );
  });
});

describe('trace evidence: no invented or unsupported citations', () => {
  test('citing get_trace_summary without calling it is unverified', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], s04());
    const result = await run(sc.messages('none'), [analysis(sc.testId, {})]);
    assert.equal(result.runStatus, 'unverified');
    assert.deepEqual(result.observed.traceSummaries, []);
  });

  test('a summary that failed or was denied supports no citation; the fallback command path is unaffected', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], s04());
    const denied = await run([...sc.messages('denied'), ...traceCallMessages('trace-1', sc.testId, 0, 'Permission to use mcp__test-detective__get_trace_summary has been denied.', true)], [analysis(sc.testId, {})]);
    assert.equal(denied.runStatus, 'unverified');
    assert.deepEqual(denied.observed.traceSummaries?.map((s) => [s.status, s.reasons]), [['error', []]]);

    // Fallback after the denial: the trace is cited by path from a successful trace command, not as get_trace_summary.
    const fallback = await run(
      [
        ...sc.messages('fallback'),
        ...traceCallMessages('trace-1', sc.testId, 0, 'Permission to use mcp__test-detective__get_trace_summary has been denied.', true),
        ...call('bash-1', 'Bash', { command: `unzip -p ${TRACE} '*.network' | grep -E '"status":\\s*[45][0-9]{2}|"failure"' | head -n 20` }, '"status":500'),
      ],
      [analysis(sc.testId, { trace: { kind: 'trace', status: 'inspected', ref: TRACE, note: 'fallback command: HTTP 500 on /api/profile' }, analysis: [{ point: 'Observed: a 500 in the network entries.', evidenceRefs: [TRACE] }] })],
    );
    assert.equal(fallback.runStatus, 'completed', fallback.issues.join('\n'));
  });

  test('a summary of another test does not support this test\'s trace citation', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], s04());
    const summary = await sc.summary(0);
    const otherTest = { ...summary, testId: 'zzzzzzzzzzzzzzzzzzzz-yyyyyyyyyyyyyyyyyyyy@' + summary.reportFingerprint };
    const result = await run([...sc.messages('other'), ...traceCallMessages('trace-1', otherTest.testId, 0, otherTest)], [analysis(sc.testId, {})]);
    assert.equal(result.runStatus, 'unverified');
  });

  test('a summary from a different report, or one that fails the output schema, makes the run unverified', async (t) => {
    const sc = await scenario(t, [{ status: 'failed', trace: TRACE }], s04());
    const summary = await sc.summary(0);
    const stale = await run([...sc.messages('stale'), ...traceCallMessages('trace-1', sc.testId, 0, { ...summary, reportFingerprint: '000000000000' })], [analysis(sc.testId, {})]);
    assert.equal(stale.runStatus, 'unverified');
    assert.ok(stale.issues.some((i) => i.includes('belongs to report 000000000000')), stale.issues.join('\n'));

    const malformed = await run([...sc.messages('bad'), ...traceCallMessages('trace-1', sc.testId, 0, { ...summary, trace: { ...summary.trace, status: 'classified' } })], [analysis(sc.testId, {})]);
    assert.equal(malformed.runStatus, 'unverified');
    assert.ok(malformed.issues.includes('Could not parse a get_trace_summary result.'));
  });
});

describe('compatibility', () => {
  test('a session without the trace tool (or without trace evidence) still completes as before', async () => {
    const fake = fakeQuery({ messages: investigatedStream([CHECKBOXES]) });
    const result = await runInvestigation(args(), { repoRoot: REPO_ROOT, query: fake.query, env: {} });
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
    assert.deepEqual(result.observed.traceSummaries, []);
  });

  test('results saved before Stage 3.3 (no traceSummaries) still parse, and the model report schema is unchanged', async () => {
    const fake = fakeQuery({ messages: investigatedStream([CHECKBOXES]) });
    const result = await runInvestigation(args(), { repoRoot: REPO_ROOT, query: fake.query, env: {} });
    const { traceSummaries: _dropped, ...observed } = result.observed;
    assert.ok(InvestigationResult.safeParse({ ...result, observed }).success);
    assert.deepEqual(Object.keys(ModelReport.shape), ['status', 'message', 'investigations']);
    const evidenceKinds = ModelReport.shape.investigations.element.shape.evidence.element.shape.kind.options;
    assert.deepEqual(evidenceKinds, ['mcp', 'source', 'error_context', 'screenshot', 'trace']);
  });
});
