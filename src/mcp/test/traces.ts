import { writeZip } from './zipwriter.ts';
import type { ZipEntry } from './zipwriter.ts';

// Synthetic Playwright traces (format 10). Record shapes follow what Playwright 1.64.1 wrote for the
// stored S03–S07 snapshots and the Stage 3.2 spike cases; values are local and contain no secrets
// except deliberate canaries. Times are monotonic milliseconds; the test starts at T0.

export const T0 = 1000;
export const ROOT = 'C:\\ci\\repo';
export const SPEC = `${ROOT}\\tests\\ui\\profile.spec.ts`;
export const ORIGIN = 'http://127.0.0.1:4100';

type Rec = Record<string, unknown>;
const jsonl = (records: Rec[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

export function contextOptions(browserName: string, monotonicTime: number, extra: Rec = {}): Rec {
  const options = browserName ? { viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 test', ...extra } : {};
  return { version: 10, type: 'context-options', origin: 'library', browserName, playwrightVersion: '1.64.1', options, platform: 'win32', wallTime: 1792602205695, monotonicTime, sdkLanguage: 'javascript', title: 'ui\\profile.spec.ts:3 › shows the profile' };
}

let callCounter = 0;
/** A protocol call in a context trace: before + after (with error/result when given). */
export function call(cls: string, method: string, start: number, end: number, extra: { params?: Rec; error?: boolean; result?: Rec; title?: string; pageId?: string } = {}): Rec[] {
  const callId = `call@${++callCounter}`;
  const before: Rec = { type: 'before', callId, startTime: start, class: cls, method, params: extra.params ?? {} };
  if (extra.title) before.title = extra.title;
  if (extra.pageId) before.pageId = extra.pageId;
  const after: Rec = { type: 'after', callId, endTime: end };
  if (extra.error) after.error = { message: 'Expect failed', stack: 'ExpectError: Expect failed\n    at C:\\Users\\canary-user\\node_modules\\playwright-core\\lib\\coreBundle.js:1:1' };
  if (extra.result) after.result = extra.result;
  return [before, after];
}

export const pageEvent = (pageId: string, time: number): Rec => ({ type: 'event', time, class: 'BrowserContext', method: 'page', params: { pageId } });

export const consoleMessage = (messageType: string, text: string, time: number, pageId = 'page@1'): Rec => ({
  type: 'console',
  messageType,
  text,
  args: [],
  location: { url: `${ORIGIN}/app.js?token=CANARY_CONSOLE_URL`, lineNumber: 1, columnNumber: 1 },
  time,
  pageId,
});

export const pageError = (name: string, message: string, time: number, pageId = 'page@1'): Rec => ({
  type: 'event',
  time,
  class: 'BrowserContext',
  method: 'pageError',
  params: { error: { error: { message, stack: `${name}: ${message}\n    at C:\\Users\\canary-user\\app.js:1:1`, name } }, location: { url: '', line: 0, column: 1 } },
  pageId,
});

export type ResourceOptions = {
  url: string;
  method?: string;
  type?: string | null;
  status?: number;
  statusText?: string;
  start: number;
  time?: number;
  page?: string | null;
  frame?: string;
  failure?: string;
  fulfilled?: boolean;
  continued?: boolean;
  aborted?: boolean;
  apiRef?: string;
  redirectURL?: string;
  serverIP?: boolean;
  requestHeaders?: { name: string; value: string }[];
  cookies?: { name: string; value: string }[];
  postData?: string;
  bodyFile?: string;
};

export function resource(o: ResourceOptions): Rec {
  const status = o.status ?? 200;
  const snapshot: Rec = {
    startedDateTime: '2026-10-22T05:50:29.092Z',
    time: o.time ?? 5,
    request: {
      method: o.method ?? 'GET',
      url: o.url,
      httpVersion: 'HTTP/1.1',
      cookies: o.cookies ?? [],
      headers: o.requestHeaders ?? [{ name: 'Accept', value: '*/*' }],
      queryString: [...new URL(o.url).searchParams].map(([name, value]) => ({ name, value })),
      headersSize: -1,
      bodySize: 0,
      ...(o.postData ? { postData: { mimeType: 'text/plain', text: o.postData } } : {}),
    },
    response: {
      status,
      statusText: o.statusText ?? (status === 200 ? 'OK' : status === 500 ? 'Internal Server Error' : status === 302 ? 'Found' : ''),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [{ name: 'set-cookie', value: 'sid=CANARY_SET_COOKIE' }],
      content: { size: o.bodyFile ? 48 : -1, mimeType: 'application/json', ...(o.bodyFile ? { _file: o.bodyFile } : {}) },
      headersSize: -1,
      bodySize: -1,
      redirectURL: o.redirectURL ?? '',
      _transferSize: -1,
      ...(o.failure ? { _failureText: o.failure } : {}),
    },
    cache: {},
    timings: { send: 0, wait: 1, receive: 1 },
    _monotonicTime: o.start,
  };
  if (o.page !== null) snapshot.pageref = o.page ?? 'page@1';
  if (o.page !== null) snapshot._frameref = o.frame ?? 'frame@1';
  if (o.type !== null) snapshot._resourceType = o.type ?? 'fetch';
  if (o.serverIP) {
    snapshot.serverIPAddress = '127.0.0.1';
    snapshot._serverPort = 4100;
  }
  if (o.fulfilled) snapshot._wasFulfilled = true;
  if (o.continued) snapshot._wasContinued = true;
  if (o.aborted) snapshot._wasAborted = true;
  if (o.apiRef) snapshot._apiRequestRef = o.apiRef;
  return { type: 'resource-snapshot', snapshot };
}

export type Step = { title: string; method?: 'pw:api' | 'expect' | 'test.step'; start: number; end: number; line?: number; file?: string; error?: boolean; params?: Rec };

/** The runner's test.trace: context options, fixture noise, the given steps, and the error record. */
export function testTrace(steps: Step[], options: { start?: number; errorRecord?: boolean } = {}): string {
  const records: Rec[] = [{ version: 10, type: 'context-options', origin: 'testRunner', browserName: '', playwrightVersion: '1.64.1', options: {}, platform: 'win32', wallTime: 1792602205592, monotonicTime: options.start ?? T0, sdkLanguage: 'javascript', testTimeout: 15000, annotations: [] }];
  records.push({ type: 'before', callId: 't@hook', startTime: T0 + 1, class: 'Test', method: 'hook', title: 'Before Hooks', params: {}, stack: [] });
  records.push({ type: 'after', callId: 't@hook', endTime: T0 + 5, annotations: [] });
  for (const [i, step] of steps.entries()) {
    const stack = step.line ? [{ file: step.file ?? SPEC, line: step.line, column: 5 }] : [];
    records.push({ type: 'before', callId: `t@${i}`, startTime: step.start, class: 'Test', method: step.method ?? 'pw:api', title: step.title, params: step.params ?? {}, stack });
    const after: Rec = { type: 'after', callId: `t@${i}`, endTime: step.end, annotations: [] };
    if (step.error) after.error = { name: '', message: 'Error: expect failed', stack: `Error: expect failed\n    at ${SPEC}:${step.line ?? 1}:5` };
    records.push(after);
  }
  if (options.errorRecord ?? steps.some((s) => s.error)) {
    records.push({ type: 'error', message: 'Error: expect failed', stack: [{ file: SPEC, line: 7, column: 5 }] });
  }
  return jsonl(records);
}

export type ContextSpec = { index: number; browser: string; start: number; events?: Rec[]; network?: Rec[]; options?: Rec };

/** Whitelisted entries plus the non-whitelisted ones a real trace has (each with a canary that must never be read). */
export function traceZip(test: string | null, contexts: ContextSpec[], extra: ZipEntry[] = []): Buffer {
  const entries: ZipEntry[] = [
    { name: 'src/c77395205f88bea29df5431270d33df6c268b907.ts', data: "await page.goto('/profile?token=CANARY_SOURCE');" },
    { name: 'attachments/f202165602ec60e107c908f25c3806cf9fe76b86', data: '# Page snapshot CANARY_ATTACHMENT' },
    { name: 'resources/5fbaa7ef47f0a8d723ac6d8028bb6f0a26455e3c.json', data: '{"secret":"CANARY_RESOURCE_BODY"}' },
    { name: 'screencast/page@1-1792602205780.jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x43, 0x41, 0x4e]) },
  ];
  if (test !== null) entries.push({ name: 'test.trace', data: test });
  for (const c of contexts) {
    entries.push({ name: `${c.index}-trace.trace`, data: jsonl([contextOptions(c.browser, c.start, c.options), ...(c.events ?? [])]) });
    entries.push({ name: `${c.index}-trace.network`, data: c.network?.length ? jsonl(c.network) : '' });
    entries.push({ name: `${c.index}-trace.stacks`, data: '{"files":["C:\\\\Users\\\\canary-user\\\\CANARY_STACKS.ts"]}' });
  }
  return writeZip([...entries, ...extra]);
}

/** One browser context (index 1) plus the empty API context (index 0), like a plain page test. */
export function pageTrace(steps: Step[], events: Rec[], network: Rec[], options: { extra?: ZipEntry[]; contextOptions?: Rec } = {}): Buffer {
  return traceZip(
    testTrace(steps),
    [
      { index: 0, browser: '', start: T0 + 100 },
      { index: 1, browser: 'chromium', start: T0 + 90, events: [pageEvent('page@1', T0 + 150), ...events], network, ...(options.contextOptions ? { options: options.contextOptions } : {}) },
    ],
    options.extra,
  );
}

// ---------------------------------------------------------------------------
// Reports

export const SPEC_ID = 'aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb';
export const RESULT_DIR = 'test-results/ui-profile-shows-the-profile-chromium';

export type AttemptSpec = { status: 'failed' | 'passed' | 'timedOut'; trace?: string | null; traces?: string[]; inline?: boolean };

/** A Playwright JSON report with one test and the given attempts; trace values are repo-relative paths. */
export function traceReport(attempts: AttemptSpec[]): string {
  const toAbsolute = (rel: string) => (/^[A-Za-z]:|^\\\\|^\//.test(rel) || rel.startsWith('..') ? rel : `${ROOT}\\${rel.split('/').join('\\')}`);
  const results = attempts.map((a, retry) => {
    const paths = a.traces ?? (a.trace ? [a.trace] : []);
    const attachments: Rec[] = paths.map((p) => ({ name: 'trace', contentType: 'application/zip', path: toAbsolute(p) }));
    if (a.inline) attachments.push({ name: 'trace', contentType: 'application/zip', body: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==' });
    return { workerIndex: 0, parallelIndex: 0, status: a.status, duration: 100, errors: [], stdout: [], stderr: [], retry, startTime: '2026-10-22T05:50:29.000Z', annotations: [], attachments };
  });
  const passed = attempts.at(-1)?.status === 'passed';
  return JSON.stringify({
    config: { configFile: `${ROOT}\\playwright.config.ts`, rootDir: `${ROOT}\\tests`, version: '1.64.1', projects: [{ id: 'chromium', name: 'chromium', retries: attempts.length - 1 }] },
    suites: [
      {
        title: 'ui\\profile.spec.ts',
        file: 'ui/profile.spec.ts',
        line: 0,
        column: 0,
        specs: [
          {
            title: 'shows the profile',
            ok: passed,
            tags: [],
            id: SPEC_ID,
            file: 'ui/profile.spec.ts',
            line: 3,
            column: 5,
            tests: [{ timeout: 15000, annotations: [], expectedStatus: 'passed', projectId: 'chromium', projectName: 'chromium', status: passed ? 'flaky' : 'unexpected', results }],
          },
        ],
      },
    ],
    errors: [],
    stats: { startTime: '2026-10-22T05:50:28.000Z', duration: 2000, expected: 0, skipped: 0, unexpected: passed ? 0 : 1, flaky: passed ? 1 : 0 },
  });
}
