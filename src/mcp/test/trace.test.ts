import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { loadReport, ReportError } from '../report.ts';
import { DEFAULT_TRACE_LIMITS, getTraceSummary, TraceCache, TraceSummaryOutput } from '../trace-summary.ts';
import type { TraceLimits, TraceRuntime } from '../trace-summary.ts';
import { OUTPUT_LIMITS, RETAINED_RECORDS } from '../trace.ts';
import { makeRepo, put, snapshotTree } from './helpers.ts';
import { failingExpect, failingExpectCall, fetchTrace, gotoCall, navigate, profileDoc, s04, s05 } from './scenarios.ts';
import {
  call,
  consoleMessage,
  contextOptions,
  ORIGIN,
  pageError,
  pageEvent,
  pageTrace,
  resource,
  RESULT_DIR,
  SPEC_ID,
  T0,
  testTrace,
  traceReport,
  traceZip,
} from './traces.ts';
import type { AttemptSpec, Step } from './traces.ts';
import { writeZip } from './zipwriter.ts';

const TRACE = `${RESULT_DIR}/trace.zip`;
type Out = TraceSummaryOutput;

async function setup(t: TestContext, attempts: AttemptSpec[], files: Record<string, string | Buffer>) {
  const root = await makeRepo(t, { raw: traceReport(attempts), files });
  const loaded = await loadReport(root);
  return { root, loaded, testId: `${SPEC_ID}@${loaded.fingerprint}` };
}

/** Validates against the published schema (no extra keys) and the output bound. */
function checked(out: Out): Out {
  assert.deepEqual(TraceSummaryOutput.parse(out), out, 'output matches TraceSummaryOutput exactly');
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= OUTPUT_LIMITS.maxOutputBytes + 2048, 'output stays bounded');
  return out;
}

async function summarize(t: TestContext, zip: Buffer, runtime: TraceRuntime = {}): Promise<Out> {
  const { loaded, testId } = await setup(t, [{ status: 'failed', trace: TRACE }], { [TRACE]: zip });
  return checked(await getTraceSummary(loaded, testId, 0, runtime));
}

const limits = (archive: Partial<TraceLimits['archive']>, maxFileBytes = DEFAULT_TRACE_LIMITS.maxFileBytes): TraceLimits => ({
  maxFileBytes,
  archive: { ...DEFAULT_TRACE_LIMITS.archive, ...archive },
});

const req = (out: Out, p: string) => out.network!.requests.find((r) => r.path === p)!;
const codes = (out: Out) => out.trace.reasons.map((r) => r.code);

// ---------------------------------------------------------------------------

describe('get_trace_summary: stored-scenario shapes', () => {
  test('S04 genuine HTTP 500: response with no route marker, failed expect in the browser context', async (t) => {
    const out = await summarize(t, s04());
    assert.equal(out.trace.status, 'ok');
    assert.equal(out.trace.path, TRACE);
    assert.deepEqual(out.trace.format, { traceVersion: 10, playwrightVersion: '1.64.1' });
    assert.deepEqual(out.trace.reasons, []);
    assert.equal(out.coverage?.complete, true);
    assert.equal(out.timeline?.base, 'test_start');
    const browser = out.contexts!.find((c) => c.kind === 'browser')!;
    assert.deepEqual(out.failure, { source: 'action', action: 'Frame.expect', context: browser.ref, atMs: 10365 });
    assert.equal(browser.hasFailedAction, true);
    assert.deepEqual(
      out.contexts!.map((c) => c.kind),
      ['browser', 'api'],
    );
    const api = req(out, '/api/profile');
    assert.equal(api.status, 500);
    assert.equal(api.statusText, 'Internal Server Error');
    assert.equal(api.result, 'response');
    assert.equal(api.marker, 'none');
    assert.equal(api.fulfillment, null);
    assert.equal(api.beforeFailure, true);
    assert.equal(api.startedMs, 200);
    assert.deepEqual(out.routes?.calls, { fulfill: 0, continue: 0, abort: 0, fallback: 0 });
    assert.deepEqual(out.backendFetches, { total: 0, returned: 0, items: [] });
    assert.deepEqual(out.console, { counts: { error: 1, warning: 0, other: 0 } });
  });

  test('S05 synthetic fulfillment: marker, call, pattern and step locations, never the body', async (t) => {
    const out = await summarize(t, s05());
    assert.equal(out.trace.status, 'ok');
    const api = req(out, '/api/profile');
    assert.equal(api.status, 500);
    assert.equal(api.marker, 'fulfilled');
    assert.equal(api.fulfillment, 'f1');
    const browser = out.contexts!.find((c) => c.kind === 'browser')!;
    assert.deepEqual(out.routes, {
      interceptionPatterns: [{ scope: 'page', kind: 'glob', pattern: '**/api/profile' }],
      calls: { fulfill: 1, continue: 0, abort: 0, fallback: 0 },
      fulfillments: [{ ref: 'f1', context: browser.ref, atMs: 205, status: 500, bodyProvided: true, fetch: { link: 'none' }, request: { correlation: 'unique', ref: api.ref } }],
      steps: [
        { call: 'route', location: { file: 'tests/ui/profile.spec.ts', line: 4 } },
        { call: 'fulfill', location: { file: 'tests/ui/profile.spec.ts', line: 5 } },
      ],
    });
    assert.doesNotMatch(JSON.stringify(out), /CANARY/);
  });

  test('S07 flaky: retry 0 has the trace, passing retry 1 has none, retry 2 does not exist', async (t) => {
    const { loaded, testId } = await setup(t, [{ status: 'failed', trace: TRACE }, { status: 'passed' }], { [TRACE]: s04() });
    const first = checked(await getTraceSummary(loaded, testId, 0));
    assert.equal(first.attemptStatus, 'failed');
    assert.equal(first.trace.status, 'ok');
    assert.equal(req(first, '/api/profile').status, 500);

    const second = checked(await getTraceSummary(loaded, testId, 1));
    assert.equal(second.attemptStatus, 'passed');
    assert.deepEqual(second.trace, { status: 'missing', path: null, sizeBytes: null, format: null, reasons: [{ code: 'no_trace_attachment', entry: null, count: null }] });
    for (const key of ['coverage', 'failure', 'network', 'routes', 'console', 'pageErrors'] as const) assert.equal(second[key], null);

    await assert.rejects(getTraceSummary(loaded, testId, 2), (e: unknown) => e instanceof ReportError && e.code === 'ATTEMPT_NOT_FOUND');
  });

  test('retry selection follows each attempt’s own attachment (fail, fail, pass)', async (t) => {
    const second = `${RESULT_DIR}-retry1/trace.zip`;
    const { loaded, testId } = await setup(t, [{ status: 'failed', trace: TRACE }, { status: 'failed', trace: second }, { status: 'passed' }], {
      [TRACE]: s04(),
      [second]: s05(),
    });
    assert.equal(req(await getTraceSummary(loaded, testId, 0), '/api/profile').marker, 'none');
    const r1 = await getTraceSummary(loaded, testId, 1);
    assert.equal(r1.trace.path, second);
    assert.equal(req(r1, '/api/profile').marker, 'fulfilled');
    assert.equal((await getTraceSummary(loaded, testId, 2)).trace.status, 'missing');
  });

  test('on-first-retry: a failed attempt without a trace is missing, not an error', async (t) => {
    const second = `${RESULT_DIR}-retry1/trace.zip`;
    const { loaded, testId } = await setup(t, [{ status: 'failed' }, { status: 'failed', trace: second }, { status: 'passed' }], { [second]: s04() });
    const r0 = checked(await getTraceSummary(loaded, testId, 0));
    assert.equal(r0.attemptStatus, 'failed');
    assert.equal(r0.trace.status, 'missing');
    assert.equal((await getTraceSummary(loaded, testId, 1)).trace.status, 'ok');
  });

  test('S08 trace off: missing', async (t) => {
    const { loaded, testId } = await setup(t, [{ status: 'timedOut' }], {});
    const out = checked(await getTraceSummary(loaded, testId, 0));
    assert.equal(out.trace.status, 'missing');
    assert.equal(out.attemptStatus, 'timedOut');
    assert.deepEqual(codes(out), ['no_trace_attachment']);
  });

  test('S03 pending request: no_response, and a runner-only assertion error', async (t) => {
    const out = await summarize(
      t,
      pageTrace(
        [navigate, { title: 'Expect "toBe"', method: 'expect', start: T0 + 230, end: T0 + 236, line: 8, error: true }],
        [...gotoCall],
        [profileDoc, resource({ url: `${ORIGIN}/api/profile`, status: -1, statusText: '', time: -1, start: T0 + 182 })],
      ),
    );
    const api = req(out, '/api/profile');
    assert.equal(api.result, 'no_response');
    assert.equal(api.status, null);
    assert.equal(api.failureText, null);
    assert.deepEqual(out.failure, { source: 'test_error', action: null, context: null, atMs: 236 });
  });

  test('S06 connection refused: failed document request and a failed goto', async (t) => {
    const out = await summarize(
      t,
      pageTrace([{ ...navigate, error: true }], [...call('Frame', 'goto', T0 + 165, T0 + 178, { error: true })], [
        resource({ url: `${ORIGIN}/profile`, type: 'document', status: -1, statusText: '', start: T0 + 170, failure: 'net::ERR_CONNECTION_REFUSED' }),
      ]),
    );
    const doc = req(out, '/profile');
    assert.equal(doc.result, 'failed');
    assert.equal(doc.failureText, 'net::ERR_CONNECTION_REFUSED');
    assert.equal(doc.marker, 'none');
    assert.equal(out.failure?.source, 'action');
    assert.equal(out.failure?.action, 'Frame.goto');
  });
});

describe('get_trace_summary: route handling', () => {
  test('route.abort: aborted marker and call count', async (t) => {
    const out = await summarize(
      t,
      pageTrace(
        [navigate, failingExpect],
        [...gotoCall, ...call('Route', 'abort', T0 + 205, T0 + 206), ...failingExpectCall],
        [profileDoc, resource({ url: `${ORIGIN}/api/profile`, status: -1, statusText: '', start: T0 + 200, failure: 'net::ERR_FAILED', aborted: true })],
      ),
    );
    const api = req(out, '/api/profile');
    assert.equal(api.marker, 'aborted');
    assert.equal(api.result, 'failed');
    assert.equal(api.failureText, 'net::ERR_FAILED');
    assert.deepEqual(out.routes?.calls, { fulfill: 0, continue: 0, abort: 1, fallback: 0 });
  });

  test('route.continue with a real 500: continued, never fulfilled; fallback counted separately', async (t) => {
    const out = await summarize(
      t,
      pageTrace(
        [navigate, failingExpect],
        [...gotoCall, ...call('Route', 'continue', T0 + 205, T0 + 206, { params: { isFallback: false } }), ...call('Route', 'continue', T0 + 207, T0 + 208, { params: { isFallback: true } }), ...failingExpectCall],
        [profileDoc, resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 200, continued: true })],
      ),
    );
    const api = req(out, '/api/profile');
    assert.equal(api.marker, 'continued');
    assert.equal(api.status, 500);
    assert.equal(api.fulfillment, null);
    assert.deepEqual(out.routes?.calls, { fulfill: 0, continue: 1, abort: 0, fallback: 1 });
    assert.deepEqual(out.routes?.fulfillments, []);
  });

  test('route.fetch passed through unchanged: linked by identifier, status unchanged, backend fetch recorded', async (t) => {
    const out = await summarize(t, fetchTrace(500, { status: 500, headers: [], isBase64: false }, 500));
    const api = req(out, '/api/profile');
    assert.equal(api.marker, 'fulfilled', '_wasFulfilled is set even though the response came from the backend');
    const [fulfillment] = out.routes!.fulfillments;
    assert.deepEqual(fulfillment!.fetch, { link: 'linked', fetchedStatus: 500, statusChanged: false, backendFetch: 'b1' });
    assert.equal(fulfillment!.bodyProvided, false);
    assert.deepEqual(fulfillment!.request, { correlation: 'unique', ref: api.ref });
    const apiContext = out.contexts!.find((c) => c.kind === 'api')!;
    assert.deepEqual(out.backendFetches?.items, [
      { ref: 'b1', context: apiContext.ref, method: 'GET', scheme: 'http', path: '/api/profile', queryOmitted: false, redactedSegments: 0, result: 'response', status: 500, statusText: 'Internal Server Error', failureText: null, startedMs: 202, beforeFailure: true, linkedFulfillments: ['f1'] },
    ]);
    assert.doesNotMatch(JSON.stringify(out), /CANARY/);
  });

  test('route.fetch with a modified status: the link proves the change', async (t) => {
    const out = await summarize(t, fetchTrace(200, { status: 500, headers: [], isBase64: false }, 500));
    assert.equal(req(out, '/api/profile').status, 500);
    assert.deepEqual(out.routes!.fulfillments[0]!.fetch, { link: 'linked', fetchedStatus: 200, statusChanged: true, backendFetch: 'b1' });
    assert.equal(out.backendFetches!.items[0]!.status, 200);
  });

  test('route.fetch with a replaced body: no identifier link, so no link is claimed', async (t) => {
    const out = await summarize(t, fetchTrace(200, { status: 200, headers: [], body: '{"name":"CANARY_MODIFIED"}', isBase64: false }, 200));
    const [fulfillment] = out.routes!.fulfillments;
    assert.deepEqual(fulfillment!.fetch, { link: 'none' });
    assert.equal(fulfillment!.bodyProvided, true);
    assert.deepEqual(out.backendFetches!.items[0]!.linkedFulfillments, [], 'the backend fetch stays unlinked');
    assert.doesNotMatch(JSON.stringify(out), /CANARY/);
  });

  test('fetch identifier without a matching fetch call is unresolved, not linked', async (t) => {
    const out = await summarize(t, fetchTrace(500, { status: 500, headers: [], isBase64: false }, 500, { uid: 'uid-unknown' }));
    assert.deepEqual(out.routes!.fulfillments[0]!.fetch, { link: 'unresolved' });
  });

  test('two concurrent fulfilled requests: correlation stays ambiguous', async (t) => {
    const out = await summarize(
      t,
      pageTrace(
        [navigate, failingExpect],
        [...gotoCall, ...call('Route', 'fulfill', T0 + 210, T0 + 211, { params: { status: 500, body: 'a' } }), ...call('Route', 'fulfill', T0 + 212, T0 + 213, { params: { status: 200, body: 'b' } }), ...failingExpectCall],
        [profileDoc, resource({ url: `${ORIGIN}/api/a`, status: 500, start: T0 + 200, time: 20, fulfilled: true }), resource({ url: `${ORIGIN}/api/b`, status: 200, start: T0 + 201, time: 20, fulfilled: true })],
      ),
    );
    for (const f of out.routes!.fulfillments) assert.deepEqual(f.request, { correlation: 'ambiguous', candidates: 2 });
    assert.equal(req(out, '/api/a').fulfillment, null);
    assert.equal(req(out, '/api/b').fulfillment, null);
  });

  test('context.route: context-scoped pattern, same request evidence', async (t) => {
    const out = await summarize(
      t,
      pageTrace(
        [navigate, failingExpect],
        [...call('BrowserContext', 'setNetworkInterceptionPatterns', T0 + 142, T0 + 149, { params: { patterns: [{ glob: '**/api/profile' }, { regexSource: 'CANARY_REGEX', regexFlags: '' }] } }), ...gotoCall, ...call('Route', 'fulfill', T0 + 205, T0 + 206, { params: { status: 500, body: 'x' } }), ...failingExpectCall],
        [profileDoc, resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 200, time: 10, fulfilled: true })],
      ),
    );
    assert.deepEqual(out.routes?.interceptionPatterns, [
      { scope: 'context', kind: 'glob', pattern: '**/api/profile' },
      { scope: 'context', kind: 'regex', pattern: null },
    ]);
    assert.equal(req(out, '/api/profile').fulfillment, 'f1');
  });
});

describe('get_trace_summary: contexts, redirects, errors', () => {
  test('several browser and API contexts are identified by metadata, not by file index', async (t) => {
    const zip = traceZip(testTrace([navigate, { title: 'Navigate', start: T0 + 400, end: T0 + 450, line: 6 }, { ...failingExpect, start: T0 + 460 }]), [
      // Index 0 is a browser context here and index 1 an API context: kinds must follow browserName.
      { index: 0, browser: 'chromium', start: T0 + 90, events: [pageEvent('page@1', T0 + 150), ...gotoCall], network: [profileDoc] },
      { index: 1, browser: '', start: T0 + 100 },
      { index: 2, browser: '', start: T0 + 390 },
      { index: 3, browser: 'chromium', start: T0 + 380, events: [pageEvent('page@2', T0 + 395), ...call('Frame', 'expect', T0 + 465, T0 + 10365, { error: true })], network: [resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 420, page: 'page@2', frame: 'frame@2' })] },
    ]);
    const out = await summarize(t, zip);
    assert.deepEqual(
      out.contexts!.map((c) => [c.ref, c.kind, c.pages, c.requests, c.hasFailedAction]),
      [
        ['c1', 'browser', 1, 1, false],
        ['c2', 'api', 0, 0, false],
        ['c3', 'browser', 1, 1, true],
        ['c4', 'api', 0, 0, false],
      ],
    );
    assert.equal(out.failure?.context, 'c3');
    assert.equal(req(out, '/api/profile').context, 'c3');
  });

  test('request fixture only: backend fetch in an API context, runner-only failure', async (t) => {
    const zip = traceZip(testTrace([{ title: 'GET', start: T0 + 10, end: T0 + 20, line: 3 }, { title: 'Expect "toBe"', method: 'expect', start: T0 + 22, end: T0 + 24, line: 4, error: true }]), [
      {
        index: 0,
        browser: '',
        start: T0 + 5,
        events: call('APIRequestContext', 'fetch', T0 + 11, T0 + 19, { params: { url: `${ORIGIN}/api/profile?key=CANARY_REQ_QUERY`, method: 'GET', headers: [{ name: 'authorization', value: 'Bearer CANARY_REQ_HDR' }] }, result: { response: { status: 500, fetchUid: 'u9' } } }),
        network: [resource({ url: `${ORIGIN}/api/profile?key=CANARY_REQ_QUERY`, status: 500, start: T0 + 12, page: null, type: null, apiRef: 'request-context@9', serverIP: true })],
      },
    ]);
    const out = await summarize(t, zip);
    assert.equal(out.network?.total, 0);
    assert.equal(out.backendFetches?.items[0]?.status, 500);
    assert.equal(out.backendFetches?.items[0]?.queryOmitted, true);
    assert.deepEqual(out.failure, { source: 'test_error', action: null, context: null, atMs: 24 });
    assert.doesNotMatch(JSON.stringify(out), /CANARY/);
  });

  test('redirects: matched, relative target, unmatched and ambiguous stay explicit', async (t) => {
    const out = await summarize(
      t,
      pageTrace([navigate, failingExpect], [...gotoCall, ...failingExpectCall], [
        resource({ url: `${ORIGIN}/`, type: 'document', status: 302, start: T0 + 170, redirectURL: `${ORIGIN}/login` }),
        resource({ url: `${ORIGIN}/login`, type: 'document', status: 200, start: T0 + 175 }),
        resource({ url: `${ORIGIN}/rel`, type: 'document', status: 303, start: T0 + 180, redirectURL: '/login2' }),
        resource({ url: `${ORIGIN}/login2`, type: 'document', status: 200, start: T0 + 181 }),
        resource({ url: `${ORIGIN}/old`, type: 'document', status: 302, start: T0 + 185, redirectURL: `${ORIGIN}/gone` }),
        resource({ url: `${ORIGIN}/twice`, type: 'document', status: 302, start: T0 + 190, redirectURL: `${ORIGIN}/dup` }),
        resource({ url: `${ORIGIN}/dup`, type: 'document', status: 200, start: T0 + 191 }),
        resource({ url: `${ORIGIN}/dup`, type: 'document', status: 200, start: T0 + 192 }),
      ]),
    );
    assert.deepEqual(req(out, '/').redirect, { status: 'matched', to: req(out, '/login').ref });
    assert.deepEqual(req(out, '/rel').redirect, { status: 'matched', to: req(out, '/login2').ref });
    assert.deepEqual(req(out, '/old').redirect, { status: 'unmatched' });
    assert.deepEqual(req(out, '/twice').redirect, { status: 'ambiguous', candidates: 2 });
    assert.equal(req(out, '/login').redirect, null);
  });

  test('page errors: counts, standard names only, timing; console counted by level only', async (t) => {
    const out = await summarize(
      t,
      pageTrace(
        [navigate, failingExpect],
        [
          ...gotoCall,
          consoleMessage('error', 'CANARY_CONSOLE_ERROR Bearer abc.def.ghi', T0 + 200),
          consoleMessage('warning', 'CANARY_CONSOLE_WARN', T0 + 201),
          consoleMessage('log', 'CANARY_CONSOLE_LOG', T0 + 202),
          consoleMessage('info', 'CANARY_CONSOLE_INFO', T0 + 203),
          pageError('Error', 'CANARY_PAGE_ERROR', T0 + 210),
          pageError('TypeError', 'async CANARY', T0 + 220),
          pageError('CanarySecretError', 'CANARY custom', T0 + 20000),
          ...failingExpectCall,
        ],
        [profileDoc],
      ),
    );
    assert.deepEqual(out.console, { counts: { error: 1, warning: 1, other: 2 } });
    assert.equal(out.pageErrors?.count, 3);
    assert.deepEqual(
      out.pageErrors?.items.map((e) => [e.name, e.atMs, e.beforeFailure]),
      [
        ['Error', 210, true],
        ['TypeError', 220, true],
        ['other', 20000, false],
      ],
    );
    assert.doesNotMatch(JSON.stringify(out), /CANARY|Canary|Bearer/);
  });
});

describe('get_trace_summary: data minimization', () => {
  test('no canary from headers, cookies, URLs, bodies, messages, parameters or host paths reaches the output', async (t) => {
    const secretUrl = `http://user:CANARY_PASS@canary-host.internal:4100/api/users/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.c2lnbmF0dXJlLWNhbmFyeQ/reset/0123456789abcdef0123456789abcdef/u/dana%40example.test?token=CANARY_QUERY#CANARY_FRAG`;
    const zip = traceZip(
      testTrace([
        { title: 'Set extra HTTP headers', start: T0 + 100, end: T0 + 101, line: 3, params: { headers: [{ name: 'authorization', value: 'CANARY_STEP_HDR' }] } },
        { title: 'Navigate', start: T0 + 160, end: T0 + 300, line: 4, params: { url: '/x?token=CANARY_STEP_PARAM' } },
        { title: 'CANARY_STEP_TITLE', method: 'test.step', start: T0 + 301, end: T0 + 302, line: 5 },
        { title: 'Fulfill request', start: T0 + 204, end: T0 + 207, line: 9, file: 'C:\\Users\\canary-user\\elsewhere\\helper.ts', params: { body: 'CANARY_STEP_BODY' } },
        failingExpect,
      ]),
      [
        { index: 0, browser: '', start: T0 + 100, events: call('APIRequestContext', 'fetch', T0 + 201, T0 + 210, { params: { url: secretUrl, method: 'GET', headers: [{ name: 'cookie', value: 'CANARY_API_COOKIE' }], postData: 'CANARY_API_POST' }, result: { response: { status: 200, fetchUid: 'u1', headers: [{ name: 'x', value: 'CANARY_API_RESULT' }] } } }) },
        {
          index: 1,
          browser: 'chromium',
          start: T0 + 90,
          options: { extraHTTPHeaders: { authorization: 'CANARY_CTX_HDR' }, httpCredentials: { username: 'u', password: 'CANARY_CREDS' }, baseURL: 'http://canary-host.internal' },
          events: [
            pageEvent('page@1', T0 + 150),
            ...call('BrowserContext', 'setExtraHTTPHeaders', T0 + 100, T0 + 101, { params: { headers: [{ name: 'authorization', value: 'CANARY_SET_HDR' }] } }),
            ...call('BrowserContext', 'addCookies', T0 + 102, T0 + 103, { params: { cookies: [{ name: 'sid', value: 'CANARY_ADD_COOKIE' }] } }),
            ...call('Page', 'setNetworkInterceptionPatterns', T0 + 142, T0 + 149, { params: { patterns: [{ glob: 'http://canary-host.internal/api/CANARY_TOKEN_abcdef1234567890ABCDEF' }, { glob: '**/api?token=CANARY_GLOB_QUERY' }] } }),
            ...gotoCall,
            ...call('Route', 'fulfill', T0 + 205, T0 + 206, { params: { status: 500, headers: [{ name: 'set-cookie', value: 'CANARY_FULFILL_COOKIE' }], body: 'CANARY_FULFILL_BODY' } }),
            consoleMessage('error', 'CANARY_CONSOLE token=CANARY_CONSOLE_TOKEN', T0 + 220),
            pageError('Error', 'CANARY_PAGE_ERROR_MESSAGE', T0 + 230),
            ...failingExpectCall,
          ],
          network: [
            resource({
              url: secretUrl,
              method: 'POST',
              status: 500,
              statusText: 'CANARY_STATUS_TEXT',
              start: T0 + 200,
              time: 10,
              fulfilled: true,
              requestHeaders: [{ name: 'Authorization', value: 'Bearer CANARY_AUTH_HEADER' }],
              cookies: [{ name: 'sid', value: 'CANARY_COOKIE' }],
              postData: 'CANARY_POST_DATA',
              bodyFile: 'resources/5fbaa7ef47f0a8d723ac6d8028bb6f0a26455e3c.json',
            }),
            resource({ url: `${ORIGIN}/api/fail`, method: 'CANARYMETHOD', type: 'CANARY_TYPE', status: -1, start: T0 + 240, failure: 'CANARY_FAILURE_TEXT' }),
          ],
        },
      ],
    );
    const out = await summarize(t, zip);
    const wire = JSON.stringify(out);
    for (const leak of [/CANARY/i, /canary-user/, /canary-host/, /Bearer/, /C:\\\\/, /Users/, /example\.test/, /4100/, /127\.0\.0\.1/]) {
      assert.doesNotMatch(wire, leak);
    }
    const secret = out.network!.requests.find((r) => r.method === 'POST')!;
    assert.equal(secret.queryOmitted, true);
    assert.equal(secret.redactedSegments, 3);
    assert.equal(secret.path, '/api/users/:redacted/reset/:redacted/u/:redacted');
    assert.equal(secret.statusText, null);
    const odd = out.network!.requests.find((r) => r.path === '/api/fail')!;
    assert.deepEqual([odd.method, odd.resourceType, odd.failureText], ['OTHER', 'unrecognized', 'unrecognized']);
    assert.deepEqual(out.routes?.interceptionPatterns, [
      { scope: 'page', kind: 'glob', pattern: null },
      { scope: 'page', kind: 'glob', pattern: null },
    ]);
    assert.deepEqual(out.routes?.steps, [{ call: 'fulfill', location: { file: null, line: 9 } }]);
  });
});

describe('get_trace_summary: path confinement', () => {
  const attempt = (a: Partial<AttemptSpec>): AttemptSpec[] => [{ status: 'failed', ...a }];

  test('attachment paths outside the repo, UNC, inline, directories and missing files are never opened', async (t) => {
    const cases: [AttemptSpec[], Record<string, string | Buffer>, string, string | null][] = [
      [attempt({ trace: '..\\outside\\trace.zip' }), {}, 'attachment_outside_repo', null],
      [attempt({ trace: 'D:\\elsewhere\\trace.zip' }), {}, 'attachment_outside_repo', null],
      [attempt({ trace: '\\\\server\\share\\trace.zip' }), {}, 'attachment_invalid_path', null],
      [attempt({ inline: true }), {}, 'attachment_inline', null],
      [attempt({ trace: TRACE }), {}, 'file_not_found', TRACE],
      [attempt({ trace: TRACE }), { [`${TRACE}/inner.txt`]: 'x' }, 'not_a_regular_file', TRACE],
    ];
    for (const [attempts, files, code, tracePath] of cases) {
      const { loaded, testId } = await setup(t, attempts, files);
      const out = checked(await getTraceSummary(loaded, testId, 0));
      assert.equal(out.trace.status, 'missing', code);
      assert.deepEqual(codes(out), [code]);
      assert.equal(out.trace.path, tracePath);
    }
  });

  test('a symlink to a trace outside the repo is refused', async (t) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'td-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await put(outside, 'trace.zip', s04());
    const { root, loaded, testId } = await setup(t, [{ status: 'failed', trace: TRACE }], { [`${RESULT_DIR}/.keep`]: '' });
    try {
      await symlink(path.join(outside, 'trace.zip'), path.join(root, ...TRACE.split('/')), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks not permitted on this machine');
      throw error;
    }
    const out = await getTraceSummary(loaded, testId, 0);
    assert.equal(out.trace.status, 'missing');
    assert.deepEqual(codes(out), ['attachment_outside_repo']);
  });

  test('a junctioned results directory pointing outside the repo is refused', async (t) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'td-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await put(outside, 'trace.zip', s04());
    const { root, loaded, testId } = await setup(t, [{ status: 'failed', trace: TRACE }], { 'test-results/.keep': '' });
    try {
      await symlink(outside, path.join(root, ...RESULT_DIR.split('/')), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks not permitted on this machine');
      throw error;
    }
    const out = await getTraceSummary(loaded, testId, 0);
    assert.deepEqual(codes(out), ['attachment_outside_repo']);
  });

  test('several trace attachments: the first is read and the result is partial', async (t) => {
    const other = `${RESULT_DIR}/second/trace.zip`;
    const { loaded, testId } = await setup(t, [{ status: 'failed', traces: [TRACE, other] }], { [TRACE]: s04(), [other]: s05() });
    const out = checked(await getTraceSummary(loaded, testId, 0));
    assert.equal(out.trace.status, 'partial');
    assert.equal(out.trace.path, TRACE);
    assert.deepEqual(out.trace.reasons, [{ code: 'multiple_trace_attachments', entry: null, count: 2 }]);
  });

  test('invalid ids and retries are the documented errors; nothing is written', async (t) => {
    const { root, loaded, testId } = await setup(t, [{ status: 'failed', trace: TRACE }], { [TRACE]: s04() });
    const before = await snapshotTree(root);
    const code = async (id: string, retry: number) => {
      try {
        await getTraceSummary(loaded, id, retry);
        return 'ok';
      } catch (error) {
        return error instanceof ReportError ? error.code : 'other';
      }
    };
    assert.equal(await code('C:\\Windows\\win.ini', 0), 'INVALID_TEST_ID');
    assert.equal(await code(`${SPEC_ID}@000000000000`, 0), 'REPORT_CHANGED');
    assert.equal(await code(testId, 5), 'ATTEMPT_NOT_FOUND');
    assert.equal(await code(testId, 0), 'ok');
    assert.deepEqual(await snapshotTree(root), before);
  });
});

describe('get_trace_summary: format support', () => {
  test('unverified trace versions and mixed versions are unsupported, with no evidence returned', async (t) => {
    const rebuilt = writeZip([
      { name: 'test.trace', data: testTrace([]).replace('"version":10', '"version":8') },
      { name: '1-trace.trace', data: JSON.stringify({ version: 8, type: 'context-options', browserName: 'chromium', playwrightVersion: '1.40.0', monotonicTime: T0 }) },
    ]);
    const out = await summarize(t, rebuilt);
    assert.equal(out.trace.status, 'unsupported');
    assert.deepEqual(codes(out), ['unsupported_trace_version']);
    assert.deepEqual(out.trace.format, { traceVersion: 8, playwrightVersion: '1.64.1' });
    assert.equal(out.network, null);

    const mixed = writeZip([
      { name: 'test.trace', data: testTrace([]) },
      { name: '1-trace.trace', data: JSON.stringify({ version: 11, type: 'context-options', browserName: 'chromium', monotonicTime: T0 }) },
    ]);
    assert.deepEqual(codes(await summarize(t, mixed)), ['mixed_trace_versions']);

    const none = writeZip([{ name: 'resources/x.json', data: '{}' }]);
    assert.deepEqual(codes(await summarize(t, none)), ['no_trace_metadata']);
  });

  test('a newer format and a missing version are unsupported, never read as version 10', async (t) => {
    const newer = writeZip([
      { name: 'test.trace', data: testTrace([]).replace('"version":10', '"version":11') },
      { name: '1-trace.trace', data: JSON.stringify({ version: 11, type: 'context-options', browserName: 'chromium', monotonicTime: T0 }) },
    ]);
    const out = await summarize(t, newer);
    assert.equal(out.trace.status, 'unsupported');
    assert.deepEqual(codes(out), ['unsupported_trace_version']);
    assert.equal(out.trace.format?.traceVersion, 11);
    assert.equal(out.network, null);

    const unversioned = writeZip([
      { name: 'test.trace', data: testTrace([]).replace('"version":10,', '') },
      { name: '1-trace.trace', data: JSON.stringify({ type: 'context-options', browserName: 'chromium', monotonicTime: T0 }) },
    ]);
    const missing = await summarize(t, unversioned);
    assert.equal(missing.trace.status, 'unsupported');
    assert.deepEqual(codes(missing), ['unsupported_trace_version']);
    assert.equal(missing.trace.format?.traceVersion, null);
    assert.equal(missing.network, null);
  });
});

describe('get_trace_summary: budgets, partial results and caching', () => {
  test('a line budget cuts the scan: partial, coverage shows what was not read', async (t) => {
    const out = await summarize(t, s04(), { limits: limits({ maxLines: 12 }) });
    assert.equal(out.trace.status, 'partial');
    assert.ok(codes(out).includes('line_budget'));
    assert.equal(out.coverage?.complete, false);
    assert.equal(out.coverage?.countsAreLowerBounds, true);
    const network = out.coverage!.entries.find((e) => e.name === '1-trace.network')!;
    assert.equal(network.status, 'skipped');
    assert.equal(network.problem, 'line_budget');
    assert.equal(out.network?.total, 0, 'unread network is reported as unread, with total counting only what was read');
    assert.equal(out.failure?.source, 'unknown', 'a cut test.trace never yields a definitive "none"');
  });

  test('cut inside the network entry: readUntilMs tells how far the evidence goes', async (t) => {
    const records = Array.from({ length: 40 }, (_, i) => resource({ url: `${ORIGIN}/api/item${i}`, status: 500, start: T0 + 200 + i }));
    const zip = pageTrace([navigate, failingExpect], [...gotoCall, ...failingExpectCall], records);
    const full = await summarize(t, zip);
    const lines = full.coverage!.entries.filter((e) => e.name !== '1-trace.network').reduce((n, e) => n + e.lines, 0);
    const out = await summarize(t, zip, { limits: limits({ maxLines: lines + 10 }) });
    const network = out.coverage!.entries.find((e) => e.name === '1-trace.network')!;
    assert.equal(network.status, 'partial');
    assert.equal(network.crcVerified, false);
    assert.equal(out.network?.total, 10);
    assert.equal(out.coverage?.readUntilMs, 209);
  });

  test('byte, declared-size, time and cancellation budgets each give partial results with their reason', async (t) => {
    const byBytes = await summarize(t, s04(), { limits: limits({ maxTotalBytes: 4000 }) });
    assert.ok(codes(byBytes).includes('byte_budget'));
    assert.equal(byBytes.trace.status, 'partial');

    const bySize = await summarize(t, s04(), { limits: limits({ maxEntryBytes: 1500 }) });
    assert.ok(codes(bySize).includes('entry_over_size_limit'));

    const cache = new TraceCache();
    const byTime = await summarize(t, s04(), { limits: limits({ maxMs: 0 }), cache });
    assert.equal(byTime.trace.status, 'partial');
    assert.ok(codes(byTime).includes('time_budget'));
    assert.equal(cache.size, 0, 'time-limited results are not cached');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await summarize(t, s04(), { signal: controller.signal });
    assert.ok(codes(cancelled).includes('cancelled'));

    const readLimit = await summarize(t, s04(), { limits: limits({ maxReadEntries: 2 }) });
    assert.ok(codes(readLimit).includes('entry_skipped_read_limit'));
  });

  test('oversized and malformed lines are skipped and counted', async (t) => {
    const zip = traceZip(testTrace([navigate, failingExpect]), [
      {
        index: 1,
        browser: 'chromium',
        start: T0 + 90,
        events: [...gotoCall, ...failingExpectCall, consoleMessage('error', 'x'.repeat(3000), T0 + 220)],
        network: [profileDoc, { not: 'a resource' }, { type: 'resource-snapshot', snapshot: { request: {} } }],
      },
    ], [{ name: '2-trace.network', data: 'not json\n[1,2,3]\n"str"\n' }]);
    const out = await summarize(t, zip, { limits: limits({ maxLineBytes: 2000 }) });
    assert.equal(out.trace.status, 'partial');
    assert.deepEqual(
      out.trace.reasons.filter((r) => r.code === 'oversized_lines' || r.code === 'malformed_lines'),
      [
        { code: 'oversized_lines', entry: '1-trace.trace', count: 1 },
        { code: 'malformed_lines', entry: '1-trace.network', count: 1 },
        { code: 'malformed_lines', entry: '2-trace.network', count: 3 },
      ],
    );
    assert.equal(out.console?.counts.error, 0, 'the oversized console line was not parsed');
  });

  test('records beyond retention are counted; a late failure survives thousands of earlier successes', async (t) => {
    const assets = Array.from({ length: RETAINED_RECORDS.benign + 25 }, (_, i) => resource({ url: `${ORIGIN}/a${i}.png`, type: 'image', start: T0 + 200 + i }));
    const late = resource({ url: `${ORIGIN}/api/late`, status: 500, start: T0 + 9000 });
    const out = await summarize(t, pageTrace([navigate, failingExpect], [...gotoCall, ...failingExpectCall], [...assets, late]));
    assert.equal(out.trace.status, 'partial');
    assert.deepEqual(out.trace.reasons.find((r) => r.code === 'records_over_limit'), { code: 'records_over_limit', entry: null, count: 25 });
    assert.equal(out.network?.omitted.notRetained, 25);
    assert.equal(req(out, '/api/late').status, 500);
  });

  test('a redirect without a target becomes undetermined when the network was not read in full', async (t) => {
    const zip = pageTrace([navigate, failingExpect], [...gotoCall, ...failingExpectCall], [
      resource({ url: `${ORIGIN}/old`, type: 'document', status: 302, start: T0 + 170, redirectURL: `${ORIGIN}/new` }),
      ...Array.from({ length: 20 }, (_, i) => resource({ url: `${ORIGIN}/x${i}`, start: T0 + 180 + i })),
      resource({ url: `${ORIGIN}/new`, type: 'document', start: T0 + 300 }),
    ]);
    assert.deepEqual(req(await summarize(t, zip), '/old').redirect?.status, 'matched');
    const full = await summarize(t, zip);
    const before = full.coverage!.entries.filter((e) => e.name !== '1-trace.network').reduce((n, e) => n + e.lines, 0);
    const cut = await summarize(t, zip, { limits: limits({ maxLines: before + 5 }) });
    assert.deepEqual(req(cut, '/old').redirect, { status: 'undetermined' });
  });

  test('bounded output: 300 failing requests and 100 page errors', async (t) => {
    const records = Array.from({ length: 300 }, (_, i) => resource({ url: `${ORIGIN}/api/${'segment'.repeat(30)}/${i}`, status: 500, start: T0 + 200 + i }));
    const errors = Array.from({ length: 100 }, (_, i) => pageError('TypeError', 'boom', T0 + 300 + i));
    const out = await summarize(t, pageTrace([navigate, failingExpect], [...gotoCall, ...errors, ...failingExpectCall], records));
    assert.equal(out.network?.total, 300);
    assert.equal(out.network?.returned, OUTPUT_LIMITS.maxRequests);
    assert.equal(out.network?.omitted.overLimit, 300 - OUTPUT_LIMITS.maxRequests);
    assert.equal(out.pageErrors?.count, 100);
    assert.equal(out.pageErrors?.items.length, OUTPUT_LIMITS.maxPageErrors);
    assert.equal(out.pageErrors?.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(out)) < OUTPUT_LIMITS.maxOutputBytes);
  });

  test('cache: identical file served from cache; same size and mtime with new content is re-read', async (t) => {
    const make = (status: number) =>
      writeZip([
        { name: 'test.trace', data: testTrace([navigate, failingExpect]), store: true },
        { name: '1-trace.trace', data: [JSON.stringify({ version: 10, type: 'context-options', browserName: 'chromium', playwrightVersion: '1.64.1', monotonicTime: T0 + 90 }), ...[...gotoCall, ...failingExpectCall].map((r) => JSON.stringify(r))].join('\n'), store: true },
        { name: '1-trace.network', data: JSON.stringify(resource({ url: `${ORIGIN}/api/profile`, status, statusText: 'x', start: T0 + 200 })), store: true },
      ]);
    const first = make(500);
    const second = make(503);
    assert.equal(first.length, second.length);
    const { root, loaded, testId } = await setup(t, [{ status: 'failed', trace: TRACE }], { [TRACE]: first });
    const cache = new TraceCache();
    const a = await getTraceSummary(loaded, testId, 0, { cache });
    const b = await getTraceSummary(loaded, testId, 0, { cache });
    assert.equal(cache.hits, 1);
    assert.deepEqual(a, b);

    const file = path.join(root, ...TRACE.split('/'));
    const { atime, mtime } = await stat(file);
    await put(root, TRACE, second);
    await utimes(file, atime, mtime);
    const c = await getTraceSummary(loaded, testId, 0, { cache });
    assert.equal(cache.hits, 1, 'changed content is a cache miss');
    assert.equal(req(c, '/api/profile').status, 503);

    // Cached results are copies: mutating one never changes the next.
    (c.network!.requests[0] as { status: number | null }).status = 1;
    assert.equal(req(await getTraceSummary(loaded, testId, 0, { cache }), '/api/profile').status, 503);
  });

  test('the event loop stays responsive while a large trace is parsed', async (t) => {
    const records = Array.from({ length: 12_000 }, (_, i) => resource({ url: `${ORIGIN}/api/item/${i}`, type: 'fetch', status: i % 97 ? 200 : 500, start: T0 + 200 + i, requestHeaders: Array.from({ length: 10 }, (_, h) => ({ name: `x-h${h}`, value: 'v'.repeat(80) })) }));
    const zip = pageTrace([navigate, failingExpect], [...gotoCall, ...failingExpectCall], records);
    let maxLag = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last);
      last = now;
    }, 5);
    const started = performance.now();
    const out = await summarize(t, zip);
    const elapsed = performance.now() - started;
    clearInterval(timer);
    const failures = Array.from({ length: 12_000 }, (_, i) => i).filter((i) => i % 97 === 0).length;
    assert.equal(out.network?.total, RETAINED_RECORDS.relevant + failures, 'every failure retained, successes up to their limit');
    assert.equal(out.network!.total + out.network!.omitted.notRetained, 12_000);
    assert.ok(out.network!.requests.every((r) => r.status === 500));
    assert.ok(out.network!.requests.some((r) => r.path === '/api/item/11931'), 'the failure nearest the end is returned');
    assert.ok(maxLag < 250, `max event-loop gap ${maxLag.toFixed(0)} ms`);
    t.diagnostic(`12k-record trace: ${(out.coverage!.bytesInflated / 1048576).toFixed(1)} MB inflated in ${elapsed.toFixed(0)} ms, max event-loop gap ${maxLag.toFixed(0)} ms`);
  });
});

describe('get_trace_summary: review regressions', () => {
  const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

  test('an item from a context whose metadata line was lost still gets a context ref (output stays schema-valid)', async (t) => {
    const zip = writeZip([
      { name: 'test.trace', data: testTrace([navigate, failingExpect]) },
      { name: '1-trace.trace', data: jsonl([contextOptions('chromium', T0 + 90), ...failingExpectCall]) },
      { name: '1-trace.network', data: '' },
      { name: '2-trace.trace', data: jsonl([pageError('TypeError', 'm', T0 + 200)]) },
      { name: '2-trace.network', data: '' },
    ]);
    const out = await summarize(t, zip);
    assert.equal(out.pageErrors!.items[0]!.context, 'c2');
    assert.deepEqual(out.contexts!.find((c) => c.ref === 'c2')?.kind, 'unknown');
  });

  test('lowercase letter-and-digit tokens in paths are redacted; slugs and UUIDs are kept', async (t) => {
    const zip = pageTrace([navigate, failingExpect], [...gotoCall, ...failingExpectCall], [
      resource({ url: `${ORIGIN}/reset/k3j4h5g6f7d8s9a0q1w2e3r4t5y6u7i8`, type: 'fetch', status: 404, start: T0 + 200 }),
      resource({ url: `${ORIGIN}/blog/release-notes-2024-edition/123e4567-e89b-12d3-a456-426614174000`, type: 'fetch', status: 404, start: T0 + 201 }),
    ]);
    const out = await summarize(t, zip);
    assert.deepEqual(out.network!.requests.filter((r) => r.status === 404).map((r) => r.path), ['/reset/:redacted', '/blog/release-notes-2024-edition/123e4567-e89b-12d3-a456-426614174000']);
  });

  test('globs that start with a host, or hide a token inside braces, are not returned', async (t) => {
    const patterns = [{ glob: 'api.canary-host.internal/**' }, { glob: '//canary-host/**' }, { glob: '**/api/{K3j4H5g6F7d8S9a0Q1w2E3r4T5y6,x}' }, { glob: '**/*.json' }];
    const zip = pageTrace([navigate, failingExpect], [...call('Page', 'setNetworkInterceptionPatterns', T0 + 142, T0 + 149, { params: { patterns } }), ...gotoCall, ...failingExpectCall], []);
    const out = await summarize(t, zip);
    assert.deepEqual(out.routes!.interceptionPatterns.map((p) => p.pattern), [null, null, null, '**/*.json']);
  });

  test('route-step source files are returned only as plain repo-relative file names', async (t) => {
    const inRepo = (...parts: string[]) => ['C:', 'ci', 'repo', ...parts].join('\\');
    const zip = pageTrace(
      [
        { title: 'Route requests', start: T0 + 140, end: T0 + 150, line: 4, file: inRepo('tests', 'ui', 'profile.spec.ts') },
        { title: 'Fulfill request', start: T0 + 204, end: T0 + 207, line: 9, file: inRepo('tests', 'k3j4h5g6f7d8s9a0q1w2e3r4t5y6u7i8', 'x.ts') },
        { title: 'Continue request', start: T0 + 208, end: T0 + 209, line: 10, file: inRepo('tests', 'free text here', 'x.ts') },
        failingExpect,
      ],
      [...failingExpectCall],
      [],
    );
    const out = await summarize(t, zip);
    assert.deepEqual(out.routes!.steps, [
      { call: 'route', location: { file: 'tests/ui/profile.spec.ts', line: 4 } },
      { call: 'fulfill', location: { file: null, line: 9 } },
      { call: 'continue', location: { file: null, line: 10 } },
    ]);
  });

  test('dropped lines leave the failure source and correlations unknown, not absent', async (t) => {
    const pad = { type: 'console', messageType: 'log', text: 'x'.repeat(4096) };
    const zip = writeZip([
      { name: 'test.trace', data: testTrace([], { errorRecord: true }) },
      { name: '1-trace.trace', data: jsonl([contextOptions('chromium', T0 + 90), pad, ...call('Route', 'fulfill', T0 + 205, T0 + 206, { params: { status: 500, body: 'x' } })]) },
      { name: '1-trace.network', data: jsonl([pad]) },
    ]);
    const out = await summarize(t, zip, { limits: limits({ maxLineBytes: 1024 }) });
    assert.equal(out.trace.status, 'partial');
    assert.equal(out.failure!.source, 'unknown', 'a dropped context line may be the failed action');
    assert.deepEqual(out.routes!.fulfillments[0]!.request, { correlation: 'undetermined' });
  });
});
