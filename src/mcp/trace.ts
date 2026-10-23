import * as z from 'zod';
import type { EntryReport, EntrySink, ScanResult } from './zip.ts';

// Pure interpretation of Playwright trace event entries (format 10, verified with Playwright 1.64.1
// and Chromium in the Stage 3.2 spike). Records are reduced to allowlisted facts as they stream in;
// raw headers, cookies, bodies, URLs beyond a sanitized path, message texts, stacks and parameter
// values never leave this module. Nothing here classifies a failure.

export const SUPPORTED_TRACE_VERSIONS = [10];

export const OUTPUT_LIMITS = {
  maxRequests: 50,
  maxBackendFetches: 20,
  maxFulfillments: 20,
  maxPatterns: 10,
  maxRouteSteps: 20,
  maxPageErrors: 20,
  maxContexts: 16,
  maxPathChars: 200,
  maxOutputBytes: 64 * 1024,
};

const TEST_TRACE = 'test.trace';
const PAGE_ERROR_NAMES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'DOMException', 'other'] as const;
type PageErrorName = (typeof PAGE_ERROR_NAMES)[number];
const CONTEXT_ENTRY = /^(\d{1,3})-trace\.(trace|network)$/;

/** Whitelisted entries in reading order: runner steps, then context events, then network records. */
export function selectTraceEntries(names: string[]): string[] {
  const rank = (name: string): [number, number] | null => {
    if (name === TEST_TRACE) return [0, 0];
    const match = CONTEXT_ENTRY.exec(name);
    if (!match) return null;
    return [match[2] === 'trace' ? 1 : 2, Number(match[1])];
  };
  return names
    .map((name) => ({ name, key: rank(name) }))
    .filter((e): e is { name: string; key: [number, number] } => e.key !== null)
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
    .map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Output schema

const Ms = z.number().describe('Milliseconds relative to timeline.base');

const ReasonCode = z.enum([
  // missing
  'no_trace_attachment',
  'multiple_trace_attachments',
  'attachment_inline',
  'attachment_outside_repo',
  'attachment_invalid_path',
  'file_not_found',
  'not_a_regular_file',
  'file_unreadable',
  // unsupported
  'file_too_large',
  'not_zip',
  'archive_invalid',
  'too_many_entries',
  'invalid_entry_name',
  'duplicate_entry_name',
  'no_trace_metadata',
  'unsupported_trace_version',
  'mixed_trace_versions',
  // partial
  'test_trace_absent',
  'entry_over_size_limit',
  'entry_skipped_read_limit',
  'entry_encrypted',
  'entry_compression_method',
  'entry_local_header_mismatch',
  'entry_size_mismatch',
  'entry_crc_mismatch',
  'entry_inflate_error',
  'time_budget',
  'byte_budget',
  'line_budget',
  'cancelled',
  'oversized_lines',
  'malformed_lines',
  'records_over_limit',
  'output_trimmed',
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

const Reason = z.object({
  code: ReasonCode,
  entry: z.string().nullable().describe('Whitelisted trace entry name the reason applies to, if any'),
  count: z.number().nullable(),
});
export type Reason = z.infer<typeof Reason>;

const ContextRef = z.string().describe('Context reference ("c1"…) assigned by this tool, stable within one result');

const Coverage = z.object({
  complete: z.boolean().describe('Every whitelisted entry was read in full and CRC-verified'),
  countsAreLowerBounds: z.boolean().describe('True when evidence may be missing: counts and lists cover only what was read'),
  readUntilMs: Ms.nullable().describe('Latest event time read from an entry that was cut short; null when no entry was cut'),
  entries: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['complete', 'partial', 'skipped', 'corrupt', 'unsupported']),
      problem: z.string().nullable(),
      lines: z.number(),
      skippedLines: z.number(),
      crcVerified: z.boolean(),
    }),
  ),
  unreadEntries: z.number().describe('Archive entries that are never read (screenshots, resources, sources, stacks…)'),
  bytesInflated: z.number(),
});

const Failure = z.object({
  source: z
    .enum(['action', 'test_error', 'none', 'unknown'])
    .describe("'action': a browser/API action failed during the failing test step; 'test_error': only the runner recorded an error (e.g. a non-Playwright assertion)"),
  action: z.string().nullable().describe('Failed Playwright protocol call, e.g. "Frame.expect"'),
  context: ContextRef.nullable(),
  atMs: Ms.nullable(),
});

const Context = z.object({
  ref: ContextRef,
  kind: z.enum(['browser', 'api', 'unknown']).describe('From the context metadata: a browser name means a browser context, an empty one an API request context'),
  browser: z.enum(['chromium', 'firefox', 'webkit']).nullable(),
  pages: z.number(),
  requests: z.number(),
  hasFailedAction: z.boolean(),
});

const SafePath = {
  scheme: z.enum(['http', 'https', 'ws', 'wss', 'data', 'blob', 'about', 'other']),
  path: z.string().nullable().describe('URL path only (no origin, userinfo, query or fragment); secret-looking segments replaced by ":redacted"'),
  queryOmitted: z.boolean(),
  redactedSegments: z.number(),
};

const Redirect = z.discriminatedUnion('status', [
  z.object({ status: z.literal('matched'), to: z.string() }),
  z.object({ status: z.literal('unmatched') }),
  z.object({ status: z.literal('undetermined') }).describe('No target found, but not every network record was read or retained'),
  z.object({ status: z.literal('ambiguous'), candidates: z.number() }),
]);

const Request = z.object({
  ref: z.string(),
  context: ContextRef,
  method: z.string(),
  resourceType: z.string().nullable(),
  ...SafePath,
  result: z.enum(['response', 'failed', 'no_response']).describe("'no_response': no status and no failure recorded (still pending when the trace ended)"),
  status: z.number().nullable(),
  statusText: z.string().nullable().describe('Only the standard reason phrase for the status; null otherwise'),
  failureText: z.string().nullable().describe('Network error code such as "net::ERR_CONNECTION_REFUSED"; "unrecognized" if it does not match a known code shape'),
  marker: z
    .enum(['fulfilled', 'continued', 'aborted', 'none', 'unknown'])
    .describe("Route marker on the browser record. 'fulfilled' does NOT mean the test created the response (route.fetch() responses are fulfilled too); 'none' does NOT prove a live backend response"),
  fulfillment: z.string().nullable().describe('routes.fulfillments ref when exactly one route.fulfill call correlates with this request'),
  redirect: Redirect.nullable(),
  startedMs: Ms.nullable(),
  beforeFailure: z.boolean().nullable(),
});

const BackendFetch = z.object({
  ref: z.string(),
  context: ContextRef,
  method: z.string(),
  ...SafePath,
  result: z.enum(['response', 'failed', 'no_response']),
  status: z.number().nullable(),
  statusText: z.string().nullable(),
  failureText: z.string().nullable(),
  startedMs: Ms.nullable(),
  beforeFailure: z.boolean().nullable(),
  linkedFulfillments: z.array(z.string()).describe('routes.fulfillments refs that served this exact fetched response (identifier link)'),
});

const Fulfillment = z.object({
  ref: z.string(),
  context: ContextRef,
  atMs: Ms.nullable(),
  status: z.number().nullable().describe('Status the test fulfilled into the browser'),
  bodyProvided: z.boolean().describe('The call supplied its own body (content never returned)'),
  fetch: z
    .discriminatedUnion('link', [
      z.object({ link: z.literal('linked'), fetchedStatus: z.number().nullable(), statusChanged: z.boolean().nullable(), backendFetch: z.string().nullable() }),
      z.object({ link: z.literal('unresolved') }),
      z.object({ link: z.literal('none') }),
    ])
    .describe("'linked': the fulfill reused a route.fetch() response, proven by matching fetch identifiers. 'none': no identifier link; the response may still come from a fetch whose body was replaced. 'unresolved': an identifier exists but its fetch was not found in what was read"),
  request: z
    .discriminatedUnion('correlation', [
      z.object({ correlation: z.literal('unique'), ref: z.string() }),
      z.object({ correlation: z.literal('ambiguous'), candidates: z.number() }),
      z.object({ correlation: z.literal('none') }),
      z.object({ correlation: z.literal('undetermined') }).describe('No candidate found, but not every network record was read or retained'),
    ])
    .describe('Which browser request this call served, by time window; route.fulfill events carry no request identifier'),
});

const Pattern = z.object({
  scope: z.enum(['page', 'context']),
  kind: z.enum(['glob', 'regex', 'other']),
  pattern: z.string().nullable().describe('Sanitized glob path; null for regexes and globs that cannot be represented safely'),
});

const RouteStep = z.object({
  call: z.enum(['route', 'fulfill', 'continue', 'abort']),
  location: z.object({ file: z.string().nullable().describe('Repo-relative path, null outside the repo'), line: z.number() }).nullable(),
});

export const TraceAnalysis = z.object({
  format: z.object({ traceVersion: z.number().nullable(), playwrightVersion: z.string().nullable() }).nullable(),
  reasons: z.array(Reason),
  coverage: Coverage.nullable(),
  timeline: z.object({ base: z.enum(['test_start', 'first_context', 'none']) }).nullable(),
  failure: Failure.nullable(),
  contexts: z.array(Context).nullable(),
  network: z
    .object({
      total: z.number(),
      returned: z.number(),
      omitted: z.object({
        benign: z.number().describe('Successful static assets without route markers'),
        overLimit: z.number(),
        notRetained: z.number().describe('Records beyond the in-memory record limit; counted only'),
      }),
      requests: z.array(Request),
    })
    .nullable(),
  backendFetches: z
    .object({ total: z.number(), returned: z.number(), items: z.array(BackendFetch) })
    .nullable()
    .describe('Requests made by API request contexts (route.fetch() or the request fixture); they reached a backend, unlike browser records'),
  routes: z
    .object({
      interceptionPatterns: z.array(Pattern),
      calls: z.object({ fulfill: z.number(), continue: z.number(), abort: z.number(), fallback: z.number() }),
      fulfillments: z.array(Fulfillment),
      steps: z.array(RouteStep),
    })
    .nullable(),
  console: z.object({ counts: z.object({ error: z.number(), warning: z.number(), other: z.number() }) }).nullable(),
  pageErrors: z
    .object({
      count: z.number(),
      items: z.array(z.object({ name: z.enum(PAGE_ERROR_NAMES).describe('Standard JavaScript error name, or "other"; messages and stacks are never returned'), context: ContextRef, atMs: Ms.nullable(), beforeFailure: z.boolean().nullable() })),
      truncated: z.boolean(),
    })
    .nullable(),
});
export type TraceAnalysis = z.infer<typeof TraceAnalysis>;

// ---------------------------------------------------------------------------
// Collected facts (internal; raw URLs stay here and are only used for matching)

type CtxOptions = { version: number | null; browserName: string | null; playwrightVersion: string | null; monotonicTime: number | null };
type Markers = { fulfilled: boolean; continued: boolean; aborted: boolean };
type NetRecord = {
  key: string;
  method: string;
  url: string;
  resourceType: string | null;
  status: number | null;
  statusText: string | null;
  failureText: string | null;
  markers: Markers;
  start: number | null;
  duration: number | null;
  frame: string | null;
  api: boolean;
  redirectURL: string | null;
  tier: 'important' | 'relevant' | 'benign';
};
type ApiCall = { key: string; start: number | null; end: number | null; url: string; method: string; fetchUid: string | null; status: number | null };
type RouteCall = { key: string; kind: 'fulfill' | 'continue' | 'abort' | 'fallback'; start: number | null; status: number | null; fetchUid: string | null; bodyProvided: boolean };
type FailedAction = { key: string; action: string | null; end: number | null };
type Step = { start: number | null; end: number | null };

type Facts = {
  options: Map<string, CtxOptions>;
  testOptions: CtxOptions | null;
  pages: Map<string, Set<string>>;
  records: NetRecord[];
  retained: Record<NetRecord['tier'], number>;
  notRetained: number;
  apiCalls: ApiCall[];
  routeCalls: RouteCall[];
  patterns: z.infer<typeof Pattern>[];
  failedActions: FailedAction[];
  failingStep: Step | null;
  testErrorRecorded: boolean;
  routeSteps: z.infer<typeof RouteStep>[];
  console: { error: number; warning: number; other: number };
  pageErrors: { key: string; name: PageErrorName; time: number | null }[];
  malformed: Map<string, number>;
  latestTime: Map<string, number>;
};

function emptyFacts(): Facts {
  return {
    options: new Map(),
    testOptions: null,
    pages: new Map(),
    records: [],
    retained: { important: 0, relevant: 0, benign: 0 },
    notRetained: 0,
    apiCalls: [],
    routeCalls: [],
    patterns: [],
    failedActions: [],
    failingStep: null,
    testErrorRecorded: false,
    routeSteps: [],
    console: { error: 0, warning: 0, other: 0 },
    pageErrors: [],
    malformed: new Map(),
    latestTime: new Map(),
  };
}

export type CollectorContext = {
  /** Maps a source path recorded in the trace (absolute, from the test machine) to a repo-relative path, or null. */
  mapFile: (raw: string) => string | null;
};

export type Collector = { open(name: string): EntrySink; finish(scan: ScanResult): TraceAnalysis };

/**
 * Streams entry lines into reduced facts. Each entry collects into its own Facts and is merged only
 * when the archive layer commits it, so a corrupt entry contributes nothing.
 */
export function createCollector(context: CollectorContext): Collector {
  const facts = emptyFacts();
  return {
    open(name) {
      const local = emptyFacts();
      const key = CONTEXT_ENTRY.exec(name)?.[1] ?? 'test';
      const kind: EntryKind = name === TEST_TRACE ? 'test' : name.endsWith('.network') ? 'network' : 'context';
      const pending = new Map<string, Pending>();
      return {
        line(text) {
          let record: unknown;
          try {
            record = JSON.parse(text);
          } catch {
            bump(local.malformed, name);
            return;
          }
          if (!isObject(record)) {
            bump(local.malformed, name);
            return;
          }
          const ok = readRecord(kind, key, record, local, pending, context);
          if (!ok) bump(local.malformed, name);
          const time = recordTime(record);
          if (time !== null) local.latestTime.set(name, Math.max(local.latestTime.get(name) ?? -Infinity, time));
        },
        done(outcome) {
          if (outcome === 'commit') merge(facts, local);
        },
      };
    },
    finish(scan) {
      return analyze(facts, scan);
    },
  };
}

// ---------------------------------------------------------------------------
// Record readers

type EntryKind = 'test' | 'context' | 'network';
type Pending = { action: string | null; start: number | null; fetch: { url: string; method: string } | null; title: string | null };

const ROUTE_STEP_TITLES: Record<string, z.infer<typeof RouteStep>['call']> = {
  'Route requests': 'route',
  'Fulfill request': 'fulfill',
  'Continue request': 'continue',
  'Abort request': 'abort',
};
const FAILING_STEP_METHODS = new Set(['expect', 'pw:api', 'test.step']);
const ACTION_NAME = /^[A-Z][A-Za-z]{1,40}\.[a-z][A-Za-z]{1,60}$/;

function readRecord(kind: EntryKind, key: string, record: Record<string, unknown>, facts: Facts, pending: Map<string, Pending>, context: CollectorContext): boolean {
  const type = record.type;
  if (type === 'context-options') {
    const options = readOptions(record);
    if (kind === 'test') facts.testOptions = options;
    else facts.options.set(key, options);
    return true;
  }
  if (kind === 'network') {
    if (type !== 'resource-snapshot') return true;
    return readNetwork(key, record, facts);
  }
  if (type === 'before') {
    const callId = str(record.callId);
    if (!callId) return false;
    if (kind === 'test') {
      readTestStep(record, facts, pending, callId, context);
      return true;
    }
    readContextCall(key, record, facts, pending, callId);
    return true;
  }
  if (type === 'after') {
    const callId = str(record.callId);
    const before = callId ? pending.get(callId) : undefined;
    if (!before) return true;
    pending.delete(callId!);
    const end = num(record.endTime);
    const failed = record.error !== undefined && record.error !== null;
    if (kind === 'test') {
      if (failed && (!facts.failingStep || (end ?? -Infinity) >= (facts.failingStep.end ?? -Infinity))) facts.failingStep = { start: before.start, end };
      return true;
    }
    if (failed) facts.failedActions.push({ key, action: before.action, end });
    if (before.fetch) {
      const response = isObject(record.result) && isObject(record.result.response) ? record.result.response : null;
      facts.apiCalls.push({
        key,
        start: before.start,
        end,
        url: before.fetch.url,
        method: before.fetch.method,
        fetchUid: response ? str(response.fetchUid) : null,
        status: response ? int(response.status) : null,
      });
    }
    return true;
  }
  if (kind === 'test') {
    if (type === 'error') facts.testErrorRecorded = true;
    return true;
  }
  if (type === 'console') {
    const level = record.messageType;
    if (level === 'error') facts.console.error += 1;
    else if (level === 'warning') facts.console.warning += 1;
    else facts.console.other += 1;
    return true;
  }
  if (type === 'event') {
    if (record.class === 'BrowserContext' && record.method === 'page') {
      const pageId = isObject(record.params) ? str(record.params.pageId) : null;
      if (pageId) addPage(facts, key, pageId);
    }
    if (record.class === 'BrowserContext' && record.method === 'pageError') {
      const error = isObject(record.params) && isObject(record.params.error) && isObject(record.params.error.error) ? record.params.error.error : null;
      const name = error ? str(error.name) : null;
      const known = PAGE_ERROR_NAMES.find((n) => n === name && n !== 'other');
      facts.pageErrors.push({ key, name: known ?? 'other', time: num(record.time) });
      const pageId = str(record.pageId);
      if (pageId) addPage(facts, key, pageId);
    }
    return true;
  }
  return true;
}

function readOptions(record: Record<string, unknown>): CtxOptions {
  const version = int(record.version);
  const pw = str(record.playwrightVersion);
  return {
    version,
    browserName: typeof record.browserName === 'string' ? record.browserName : null,
    playwrightVersion: pw && /^\d{1,3}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.]{1,40})?$/.test(pw) ? pw : null,
    monotonicTime: num(record.monotonicTime),
  };
}

function readTestStep(record: Record<string, unknown>, facts: Facts, pending: Map<string, Pending>, callId: string, context: CollectorContext): void {
  const method = str(record.method);
  if (record.class !== 'Test' || !method || !FAILING_STEP_METHODS.has(method)) return;
  const title = str(record.title);
  pending.set(callId, { action: null, start: num(record.startTime), fetch: null, title: null });
  const call = method === 'pw:api' && title ? ROUTE_STEP_TITLES[title] : undefined;
  if (!call) return;
  const frame = Array.isArray(record.stack) && isObject(record.stack[0]) ? record.stack[0] : null;
  const line = frame ? int(frame.line) : null;
  const rawFile = frame ? str(frame.file) : null;
  const location = line !== null && line > 0 ? { file: rawFile ? safeSourceFile(context.mapFile(rawFile)) : null, line } : null;
  if (!facts.routeSteps.some((s) => s.call === call && s.location?.file === location?.file && s.location?.line === location?.line)) {
    facts.routeSteps.push({ call, location });
  }
}

function readContextCall(key: string, record: Record<string, unknown>, facts: Facts, pending: Map<string, Pending>, callId: string): void {
  const cls = str(record.class);
  const method = str(record.method);
  const name = cls && method ? `${cls}.${method}` : '';
  const action = ACTION_NAME.test(name) ? name : null;
  const start = num(record.startTime);
  const params = isObject(record.params) ? record.params : {};
  let fetch: Pending['fetch'] = null;

  if (name === 'Page.setNetworkInterceptionPatterns' || name === 'BrowserContext.setNetworkInterceptionPatterns') {
    const scope = cls === 'Page' ? 'page' : 'context';
    for (const p of Array.isArray(params.patterns) ? params.patterns : []) facts.patterns.push({ scope, ...sanitizePattern(p) });
  } else if (name === 'Route.fulfill') {
    facts.routeCalls.push({ key, kind: 'fulfill', start, status: int(params.status), fetchUid: str(params.fetchResponseUid), bodyProvided: 'body' in params });
  } else if (name === 'Route.continue') {
    facts.routeCalls.push({ key, kind: params.isFallback === true ? 'fallback' : 'continue', start, status: null, fetchUid: null, bodyProvided: false });
  } else if (name === 'Route.abort') {
    facts.routeCalls.push({ key, kind: 'abort', start, status: null, fetchUid: null, bodyProvided: false });
  } else if (name === 'APIRequestContext.fetch') {
    const url = str(params.url);
    if (url) fetch = { url, method: methodName(params.method) };
  }
  const pageId = str(record.pageId);
  if (pageId) addPage(facts, key, pageId);
  pending.set(callId, { action, start, fetch, title: null });
}

function readNetwork(key: string, record: Record<string, unknown>, facts: Facts): boolean {
  const snapshot = isObject(record.snapshot) ? record.snapshot : null;
  const request = snapshot && isObject(snapshot.request) ? snapshot.request : null;
  const response = snapshot && isObject(snapshot.response) ? snapshot.response : null;
  const url = request ? str(request.url) : null;
  if (!snapshot || !request || !response || !url) return false;
  const status = int(response.status);
  const failure = str(response._failureText);
  const redirect = str(response.redirectURL);
  const pageref = str(snapshot.pageref);
  if (pageref) addPage(facts, key, pageref);
  const net: NetRecord = {
    key,
    tier: 'benign',
    method: methodName(request.method),
    url,
    resourceType: resourceType(snapshot._resourceType),
    status: status !== null && status >= 100 && status <= 999 ? status : null,
    statusText: status !== null && typeof response.statusText === 'string' && STATUS_CODES[status] === response.statusText ? response.statusText : null,
    failureText: failure ? failureCode(failure) : null,
    markers: { fulfilled: snapshot._wasFulfilled === true, continued: snapshot._wasContinued === true, aborted: snapshot._wasAborted === true },
    start: num(snapshot._monotonicTime),
    duration: num(snapshot.time),
    frame: str(snapshot._frameref),
    // API request context records carry _apiRequestRef and no page (spike: route.fetch, request fixture).
    api: typeof snapshot._apiRequestRef === 'string' && !pageref,
    redirectURL: redirect || null,
  };
  net.tier = tierOf(net);
  retain(facts, net);
  return true;
}

/**
 * Retention priority when a trace has more records than can be kept: failures, errors, pending,
 * route-marked, redirecting and API records first, then documents/fetch/xhr, then static assets.
 * So a late failing request is kept even after thousands of successful ones.
 */
export const RETAINED_RECORDS: Record<NetRecord['tier'], number> = { important: 3000, relevant: 1500, benign: 500 };

function tierOf(r: NetRecord): NetRecord['tier'] {
  const marked = r.markers.fulfilled || r.markers.continued || r.markers.aborted;
  if (r.failureText !== null || r.status === null || r.status >= 400 || marked || r.redirectURL !== null || r.api) return 'important';
  return r.resourceType === null || r.resourceType === 'document' || r.resourceType === 'fetch' || r.resourceType === 'xhr' ? 'relevant' : 'benign';
}

function retain(facts: Facts, record: NetRecord): void {
  if (facts.retained[record.tier] >= RETAINED_RECORDS[record.tier]) {
    facts.notRetained += 1;
    return;
  }
  facts.retained[record.tier] += 1;
  facts.records.push(record);
}

// ---------------------------------------------------------------------------
// Analysis

function analyze(facts: Facts, scan: ScanResult): TraceAnalysis {
  const reasons: Reason[] = [];
  const reason = (code: ReasonCode, entry: string | null = null, count: number | null = null) => reasons.push({ code, entry, count });

  // Format: every context-options record must agree on a supported version.
  const allOptions = [...(facts.testOptions ? [facts.testOptions] : []), ...facts.options.values()];
  const versions = new Set(allOptions.map((o) => o.version));
  const format = allOptions.length
    ? { traceVersion: versions.size === 1 ? [...versions][0]! : null, playwrightVersion: allOptions.find((o) => o.playwrightVersion)?.playwrightVersion ?? null }
    : null;
  const contextStarts = [...facts.options.values()].map((o) => o.monotonicTime).filter((t): t is number => t !== null);
  const base = facts.testOptions?.monotonicTime ?? (contextStarts.length ? Math.min(...contextStarts) : null);
  const rel = (t: number | null): number | null => (t === null || base === null ? null : Math.round((t - base) * 10) / 10);
  const coverage = describeCoverage(scan, facts, rel, reason);
  if (!format) {
    // Nothing identifying was read. After a budget stop that is unread evidence, not a format problem.
    if (scan.stoppedBy === null) reason('no_trace_metadata');
    return unsupported(format, reasons, coverage);
  }
  if (versions.size > 1) {
    reason('mixed_trace_versions');
    return unsupported(format, reasons, coverage);
  }
  if (format.traceVersion === null || !SUPPORTED_TRACE_VERSIONS.includes(format.traceVersion)) {
    reason('unsupported_trace_version');
    return unsupported(format, reasons, coverage);
  }
  if (!facts.testOptions && !scan.entries.some((e) => e.name === TEST_TRACE)) reason('test_trace_absent');
  if (facts.notRetained > 0) reason('records_over_limit', null, facts.notRetained);

  const timeline = { base: facts.testOptions?.monotonicTime != null ? 'test_start' : base !== null ? 'first_context' : 'none' } as const;

  // Contexts, identified by their metadata; refs follow creation time.
  // Every key an output item can reference gets a ref, even a context whose metadata line was lost.
  const keys = [
    ...new Set([
      ...facts.options.keys(),
      ...facts.records.map((r) => r.key),
      ...facts.routeCalls.map((r) => r.key),
      ...facts.pageErrors.map((e) => e.key),
      ...facts.failedActions.map((a) => a.key),
    ]),
  ];
  keys.sort((a, b) => (facts.options.get(a)?.monotonicTime ?? Infinity) - (facts.options.get(b)?.monotonicTime ?? Infinity) || Number(a) - Number(b));
  const ctxRef = new Map(keys.map((k, i) => [k, `c${i + 1}`]));
  const kindOf = (key: string): 'browser' | 'api' | 'unknown' => {
    const browser = facts.options.get(key)?.browserName;
    if (browser === '') return 'api';
    if (browser === 'chromium' || browser === 'firefox' || browser === 'webkit') return 'browser';
    return 'unknown';
  };

  // Failure: the last failing runner step, and a browser/API action that failed within it.
  const step = facts.failingStep;
  const inStep = (a: FailedAction) => step !== null && a.end !== null && (step.start === null || a.end >= step.start - 1) && (step.end === null || a.end <= step.end + 1);
  const testTraceRead = scan.entries.some((e) => e.name === TEST_TRACE && (e.status === 'complete' || e.status === 'partial'));
  let failureAction: FailedAction | null = null;
  let failure: z.infer<typeof Failure>;
  // 'test_error' implies no browser/API action failed, so it needs every context event entry read in
  // full, with no dropped line (a dropped line may be the failed action).
  const readInFull = (name: string) => {
    const e = coverage.entries.find((c) => c.name === name);
    return e !== undefined && e.status === 'complete' && e.skippedLines === 0;
  };
  const contextEventsRead = scan.entries.filter((e) => /-trace\.trace$/.test(e.name)).every((e) => readInFull(e.name));
  if (step) {
    failureAction = [...facts.failedActions].filter(inStep).sort((a, b) => (b.end ?? 0) - (a.end ?? 0))[0] ?? null;
    failure = failureAction
      ? { source: 'action', action: failureAction.action, context: ctxRef.get(failureAction.key) ?? null, atMs: rel(failureAction.end) }
      : { source: contextEventsRead ? 'test_error' : 'unknown', action: null, context: null, atMs: rel(step.end) };
  } else if (facts.testErrorRecorded) {
    failure = { source: contextEventsRead ? 'test_error' : 'unknown', action: null, context: null, atMs: null };
  } else if (testTraceRead && coverage.complete) {
    failure = { source: 'none', action: null, context: null, atMs: null };
  } else {
    failure = { source: 'unknown', action: null, context: null, atMs: null };
  }
  const failureTime = failure.atMs;
  const before = (t: number | null) => (t === null || failureTime === null ? null : rel(t)! <= failureTime);

  // Network records: browser requests vs API-context (backend) fetches.
  const browserRecords = facts.records.filter((r) => !r.api && kindOf(r.key) !== 'api');
  const apiRecords = facts.records.filter((r) => r.api || kindOf(r.key) === 'api');
  const reqRef = new Map(browserRecords.map((r, i) => [r, `n${i + 1}`]));
  const apiRef = new Map(apiRecords.map((r, i) => [r, `b${i + 1}`]));
  const markerOf = (r: NetRecord): z.infer<typeof Request>['marker'] => {
    const set = [r.markers.fulfilled && 'fulfilled', r.markers.continued && 'continued', r.markers.aborted && 'aborted'].filter(Boolean);
    if (set.length > 1 || kindOf(r.key) === 'unknown') return 'unknown';
    return (set[0] as 'fulfilled' | 'continued' | 'aborted' | undefined) ?? 'none';
  };

  // A context's network evidence is incomplete when its network entry wasn't read in full or records weren't retained.
  const networkIncomplete = (key: string) => facts.notRetained > 0 || !readInFull(`${key}-trace.network`);

  // Fulfillments: request correlation by time window (no identifier exists), fetch link by identifier.
  const fulfills = facts.routeCalls.filter((c) => c.kind === 'fulfill');
  const fulRef = new Map(fulfills.map((c, i) => [c, `f${i + 1}`]));
  const candidatesFor = (call: RouteCall) =>
    browserRecords.filter(
      (r) =>
        r.key === call.key &&
        markerOf(r) === 'fulfilled' &&
        r.start !== null &&
        call.start !== null &&
        call.start >= r.start - 1 &&
        (r.duration === null || r.duration < 0 || call.start <= r.start + r.duration + 1),
    );
  const fulfillCandidates = new Map(fulfills.map((c) => [c, candidatesFor(c)]));
  const requestFulfillment = new Map<NetRecord, RouteCall>();
  const claims = new Map<NetRecord, number>();
  for (const list of fulfillCandidates.values()) for (const r of list) claims.set(r, (claims.get(r) ?? 0) + 1);
  for (const [call, list] of fulfillCandidates) if (list.length === 1 && claims.get(list[0]!) === 1) requestFulfillment.set(list[0]!, call);

  const apiCallRecord = (call: ApiCall): NetRecord | null => {
    const matches = apiRecords.filter(
      (r) => r.key === call.key && r.url === call.url && r.method === call.method && r.start !== null && call.start !== null && r.start >= call.start - 1 && (call.end === null || r.start <= call.end + 1),
    );
    return matches.length === 1 ? matches[0]! : null;
  };
  const linked = new Map<NetRecord, string[]>();
  const fulfillments: z.infer<typeof Fulfillment>[] = fulfills.map((call) => {
    const ref = fulRef.get(call)!;
    let fetch: z.infer<typeof Fulfillment>['fetch'] = { link: 'none' };
    if (call.fetchUid) {
      const calls = facts.apiCalls.filter((a) => a.fetchUid === call.fetchUid);
      if (calls.length === 1) {
        const api = calls[0]!;
        const record = apiCallRecord(api);
        if (record) linked.set(record, [...(linked.get(record) ?? []), ref]);
        fetch = {
          link: 'linked',
          fetchedStatus: api.status,
          statusChanged: api.status !== null && call.status !== null ? api.status !== call.status : null,
          backendFetch: record ? apiRef.get(record)! : null,
        };
      } else {
        fetch = { link: 'unresolved' };
      }
    }
    const list = fulfillCandidates.get(call)!;
    const unique = list.length === 1 && requestFulfillment.get(list[0]!) === call;
    const request: z.infer<typeof Fulfillment>['request'] = unique
      ? { correlation: 'unique', ref: reqRef.get(list[0]!)! }
      : list.length > 1 || (list.length === 1 && !unique)
        ? { correlation: 'ambiguous', candidates: list.length }
        : networkIncomplete(call.key)
          ? { correlation: 'undetermined' }
          : { correlation: 'none' };
    return { ref, context: ctxRef.get(call.key)!, atMs: rel(call.start), status: call.status, bodyProvided: call.bodyProvided, fetch, request };
  });

  // Redirects: a 3xx with a target, matched by exact URL against later records in the same context/frame.
  const redirectOf = (r: NetRecord): z.infer<typeof Redirect> | null => {
    if (!r.redirectURL || r.status === null || r.status < 300 || r.status > 399) return null;
    let target: string;
    try {
      target = new URL(r.redirectURL, r.url).href;
    } catch {
      return { status: 'unmatched' };
    }
    const matches = browserRecords.filter(
      (o) => o !== r && o.key === r.key && (r.frame === null || o.frame === r.frame) && o.url === target && o.start !== null && r.start !== null && o.start >= r.start,
    );
    if (matches.length === 1) return { status: 'matched', to: reqRef.get(matches[0]!)! };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches.length };
    return networkIncomplete(r.key) ? { status: 'undetermined' } : { status: 'unmatched' };
  };

  const toRequest = (r: NetRecord): z.infer<typeof Request> => {
    const fulfilledBy = requestFulfillment.get(r);
    return {
      ref: reqRef.get(r)!,
      context: ctxRef.get(r.key)!,
      method: r.method,
      resourceType: r.resourceType,
      ...sanitizeUrl(r.url),
      result: resultOf(r),
      status: r.status,
      statusText: r.statusText,
      failureText: r.failureText,
      marker: markerOf(r),
      fulfillment: fulfilledBy ? fulRef.get(fulfilledBy)! : null,
      redirect: redirectOf(r),
      startedMs: rel(r.start),
      beforeFailure: before(r.start),
    };
  };

  // Selection: everything that can matter first, then documents/fetch/xhr; successful static assets are counted.
  const redirectTargets = new Set<NetRecord>();
  for (const r of browserRecords) {
    const target = redirectOf(r);
    if (target?.status === 'matched') redirectTargets.add(browserRecords[Number(target.to.slice(1)) - 1]!);
  }
  const important = (r: NetRecord) =>
    resultOf(r) !== 'response' || (r.status ?? 0) >= 400 || markerOf(r) !== 'none' || redirectOf(r) !== null || redirectTargets.has(r);
  const interesting = (r: NetRecord) => r.resourceType === 'document' || r.resourceType === 'fetch' || r.resourceType === 'xhr' || r.resourceType === null;
  const tier1 = browserRecords.filter(important);
  const tier2 = browserRecords.filter((r) => !important(r) && interesting(r));
  const benign = browserRecords.length - tier1.length - tier2.length;
  // Over the cap, keep the records nearest the failure (or the latest, without a failure time).
  const anchor = failure.atMs ?? Infinity;
  const distance = (r: NetRecord) => {
    const t = rel(r.start);
    return t === null ? Infinity : anchor === Infinity ? -t : Math.abs(anchor - t);
  };
  const nearest = (list: NetRecord[]) => [...list].sort((a, b) => distance(a) - distance(b));
  const chosen = [...nearest(tier1), ...nearest(tier2)].slice(0, OUTPUT_LIMITS.maxRequests);
  chosen.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  const network = {
    total: browserRecords.length,
    returned: chosen.length,
    omitted: { benign, overLimit: tier1.length + tier2.length - chosen.length, notRetained: facts.notRetained },
    requests: chosen.map(toRequest),
  };

  const backendItems = apiRecords.slice(0, OUTPUT_LIMITS.maxBackendFetches).map((r) => ({
    ref: apiRef.get(r)!,
    context: ctxRef.get(r.key)!,
    method: r.method,
    ...sanitizeUrl(r.url),
    result: resultOf(r),
    status: r.status,
    statusText: r.statusText,
    failureText: r.failureText,
    startedMs: rel(r.start),
    beforeFailure: before(r.start),
    linkedFulfillments: linked.get(r) ?? [],
  }));

  const contexts = keys.slice(0, OUTPUT_LIMITS.maxContexts).map((key): z.infer<typeof Context> => {
    const name = facts.options.get(key)?.browserName;
    return {
      ref: ctxRef.get(key)!,
      kind: kindOf(key),
      browser: name === 'chromium' || name === 'firefox' || name === 'webkit' ? name : null,
      pages: facts.pages.get(key)?.size ?? 0,
      requests: facts.records.filter((r) => r.key === key).length,
      hasFailedAction: failureAction?.key === key,
    };
  });

  const count = (kind: RouteCall['kind']) => facts.routeCalls.filter((c) => c.kind === kind).length;
  const analysis: TraceAnalysis = {
    format,
    reasons,
    coverage,
    timeline,
    failure,
    contexts,
    network,
    backendFetches: { total: apiRecords.length, returned: backendItems.length, items: backendItems },
    routes: {
      interceptionPatterns: facts.patterns.slice(0, OUTPUT_LIMITS.maxPatterns),
      calls: { fulfill: count('fulfill'), continue: count('continue'), abort: count('abort'), fallback: count('fallback') },
      fulfillments: fulfillments.slice(0, OUTPUT_LIMITS.maxFulfillments),
      steps: facts.routeSteps.slice(0, OUTPUT_LIMITS.maxRouteSteps),
    },
    console: { counts: { ...facts.console } },
    pageErrors: {
      count: facts.pageErrors.length,
      items: facts.pageErrors.slice(0, OUTPUT_LIMITS.maxPageErrors).map((e) => ({ name: e.name, context: ctxRef.get(e.key)!, atMs: rel(e.time), beforeFailure: before(e.time) })),
      truncated: facts.pageErrors.length > OUTPUT_LIMITS.maxPageErrors,
    },
  };
  return bound(analysis);
}

function unsupported(format: TraceAnalysis['format'], reasons: Reason[], coverage: TraceAnalysis['coverage']): TraceAnalysis {
  return { format, reasons, coverage, timeline: null, failure: null, contexts: null, network: null, backendFetches: null, routes: null, console: null, pageErrors: null };
}

const ENTRY_REASON: Record<string, ReasonCode> = {
  declared_size: 'entry_over_size_limit',
  read_entry_limit: 'entry_skipped_read_limit',
  encrypted: 'entry_encrypted',
  compression_method: 'entry_compression_method',
  local_header_mismatch: 'entry_local_header_mismatch',
  size_mismatch: 'entry_size_mismatch',
  crc_mismatch: 'entry_crc_mismatch',
  inflate_error: 'entry_inflate_error',
  time_budget: 'time_budget',
  byte_budget: 'byte_budget',
  line_budget: 'line_budget',
  cancelled: 'cancelled',
};

function describeCoverage(scan: ScanResult, facts: Facts, rel: (t: number | null) => number | null, reason: (code: ReasonCode, entry?: string | null, count?: number | null) => void): z.infer<typeof Coverage> {
  const entries = scan.entries.map((e: EntryReport) => ({
    name: e.name,
    status: e.status,
    problem: e.problem,
    lines: e.lines,
    skippedLines: e.oversizedLines + (facts.malformed.get(e.name) ?? 0),
    crcVerified: e.crcVerified,
  }));
  // A stop while entries were still being listed leaves no entry to carry the reason.
  if (scan.stoppedBy && !scan.entries.some((e) => e.problem === scan.stoppedBy)) reason(ENTRY_REASON[scan.stoppedBy]!);
  for (const e of scan.entries) {
    if (e.problem) reason(ENTRY_REASON[e.problem] ?? 'archive_invalid', e.name);
    if (e.oversizedLines) reason('oversized_lines', e.name, e.oversizedLines);
    const malformed = facts.malformed.get(e.name);
    if (malformed) reason('malformed_lines', e.name, malformed);
  }
  const cut = scan.entries.filter((e) => e.status === 'partial');
  const times = cut.map((e) => facts.latestTime.get(e.name)).filter((t): t is number => t !== undefined);
  const complete =
    scan.stoppedBy === null &&
    scan.entries.some((e) => e.name === TEST_TRACE) &&
    scan.entries.every((e) => e.status === 'complete' && e.crcVerified) &&
    entries.every((e) => e.skippedLines === 0) &&
    facts.notRetained === 0;
  return {
    complete,
    countsAreLowerBounds: !complete,
    readUntilMs: cut.length === 0 || times.length === 0 ? null : rel(Math.min(...times)),
    entries,
    unreadEntries: scan.unreadEntries,
    bytesInflated: scan.bytesInflated,
  };
}

/** Keeps the serialized analysis under maxOutputBytes by shortening the longest lists. */
function bound(analysis: TraceAnalysis): TraceAnalysis {
  const size = () => Buffer.byteLength(JSON.stringify(analysis));
  if (size() <= OUTPUT_LIMITS.maxOutputBytes) return analysis;
  analysis.reasons.push({ code: 'output_trimmed', entry: null, count: null });
  if (analysis.coverage) analysis.coverage.countsAreLowerBounds = true;
  const lists: (() => unknown[] | undefined)[] = [
    () => analysis.network?.requests,
    () => analysis.backendFetches?.items,
    () => analysis.routes?.fulfillments,
    () => analysis.pageErrors?.items,
    () => analysis.routes?.steps,
    () => analysis.routes?.interceptionPatterns,
    () => analysis.coverage?.entries,
  ];
  while (size() > OUTPUT_LIMITS.maxOutputBytes) {
    const longest = lists.map((get) => get()).filter((l): l is unknown[] => !!l && l.length > 0).sort((a, b) => b.length - a.length)[0];
    if (!longest) break;
    longest.length = Math.floor(longest.length / 2);
  }
  if (analysis.network) {
    analysis.network.omitted.overLimit += analysis.network.returned - analysis.network.requests.length;
    analysis.network.returned = analysis.network.requests.length;
  }
  if (analysis.backendFetches) analysis.backendFetches.returned = analysis.backendFetches.items.length;
  return analysis;
}

// ---------------------------------------------------------------------------
// Sanitizers

/** Standard reason phrases; a server's own statusText is returned only when it equals one of these. */
const STATUS_CODES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed',
  413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: "I'm a Teapot",
  421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early', 426: 'Upgrade Required',
  428: 'Precondition Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected', 510: 'Not Extended', 511: 'Network Authentication Required',
};

const SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'data', 'blob', 'about']);

/** Path only: never origin, userinfo, query or fragment. */
export function sanitizeUrl(raw: string): z.infer<z.ZodObject<typeof SafePath>> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { scheme: 'other', path: null, queryOmitted: false, redactedSegments: 0 };
  }
  const protocol = url.protocol.replace(/:$/, '');
  const scheme = (SCHEMES.has(protocol) ? protocol : 'other') as z.infer<typeof SafePath.scheme>;
  const queryOmitted = url.search.length > 0;
  if (!['http', 'https', 'ws', 'wss'].includes(scheme)) return { scheme, path: null, queryOmitted, redactedSegments: 0 };
  const { path, redacted } = sanitizePath(url.pathname);
  return { scheme, path, queryOmitted, redactedSegments: redacted };
}

function sanitizePath(pathname: string): { path: string; redacted: number } {
  let redacted = 0;
  const segments = pathname.split('/').map((segment) => {
    if (segment === '' || !looksSecret(segment)) return segment;
    redacted += 1;
    return ':redacted';
  });
  let path = segments.join('/');
  if (path.length > OUTPUT_LIMITS.maxPathChars) path = `${path.slice(0, OUTPUT_LIMITS.maxPathChars)}…`;
  return { path, redacted };
}

function looksSecret(segment: string): boolean {
  if (segment.length > 64) return true;
  if (/[^A-Za-z0-9._~%+-]/.test(segment)) return true;
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(segment)) return true; // JWT
  if (/^[0-9a-fA-F]{32,}$/.test(segment)) return true;
  if (segment.length >= 24 && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment) && !/^[a-z0-9-]+$/.test(segment)) return true;
  // A long letters-and-digits run, even lowercase (tokens, magic links); short slug words stay.
  if (segment.split(/[-_.~+]/).some((piece) => piece.length >= 16 && /[A-Za-z]/.test(piece) && /[0-9]/.test(piece))) return true;
  if (/%40|@/i.test(segment)) return true;
  return false;
}

function sanitizePattern(pattern: unknown): { kind: 'glob' | 'regex' | 'other'; pattern: string | null } {
  if (!isObject(pattern)) return { kind: 'other', pattern: null };
  if (typeof pattern.regexSource === 'string') return { kind: 'regex', pattern: null };
  const glob = str(pattern.glob);
  if (!glob) return { kind: 'other', pattern: null };
  // Drop scheme and host; keep the path part of the glob.
  const scheme = glob.indexOf('://');
  const rest = scheme === -1 ? glob : glob.slice(glob.indexOf('/', scheme + 3) === -1 ? glob.length : glob.indexOf('/', scheme + 3));
  if (rest.length === 0 || rest.length > 120 || /[?#]/.test(rest.replace(/\*\*?/g, '')) || !/^[A-Za-z0-9*/._~{},-]+$/.test(rest)) return { kind: 'glob', pattern: null };
  // A glob without a scheme can still start with a host ("api.internal/**", "//host/x").
  if (rest.startsWith('//') || rest.split('/')[0]!.includes('.')) return { kind: 'glob', pattern: null };
  // Check the literal parts between wildcards and braces too, not only whole segments.
  if (rest.split(/[/*{},]/).some((s) => s !== '' && looksSecret(s))) return { kind: 'glob', pattern: null };
  return { kind: 'glob', pattern: rest };
}

/** A repo-relative source path made of ordinary file-name characters; anything else is omitted. */
function safeSourceFile(file: string | null): string | null {
  if (!file || file.length > OUTPUT_LIMITS.maxPathChars) return null;
  const segments = file.split('/');
  return segments.every((s) => /^[A-Za-z0-9._+-]{1,64}$/.test(s) && s !== '..' && !looksSecret(s)) ? file : null;
}

const RESOURCE_TYPES = new Set([
  'document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'eventsource',
  'websocket', 'manifest', 'signedexchange', 'ping', 'cspviolationreport', 'preflight', 'prefetch', 'other',
]);

function resourceType(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && RESOURCE_TYPES.has(value) ? value : 'unrecognized';
}

function failureCode(text: string): string {
  return /^(net::ERR_[A-Z0-9_]{1,60}|NS_ERROR_[A-Z0-9_]{1,60})$/.test(text) ? text : 'unrecognized';
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);

function methodName(value: unknown): string {
  return typeof value === 'string' && METHODS.has(value.toUpperCase()) ? value.toUpperCase() : 'OTHER';
}

function resultOf(r: NetRecord): 'response' | 'failed' | 'no_response' {
  if (r.failureText !== null) return 'failed';
  return r.status === null ? 'no_response' : 'response';
}

// ---------------------------------------------------------------------------
// Small helpers

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function addPage(facts: Facts, key: string, pageId: string): void {
  const set = facts.pages.get(key) ?? new Set<string>();
  if (set.size < 100) set.add(pageId);
  facts.pages.set(key, set);
}
function recordTime(record: Record<string, unknown>): number | null {
  if (isObject(record.snapshot)) return num(record.snapshot._monotonicTime);
  return num(record.startTime) ?? num(record.endTime) ?? num(record.time);
}

function merge(into: Facts, from: Facts): void {
  for (const [k, v] of from.options) into.options.set(k, v);
  if (from.testOptions) into.testOptions = from.testOptions;
  for (const [k, set] of from.pages) for (const p of set) addPage(into, k, p);
  for (const r of from.records) {
    retain(into, r);
  }
  into.notRetained += from.notRetained;
  into.apiCalls.push(...from.apiCalls);
  into.routeCalls.push(...from.routeCalls);
  into.patterns.push(...from.patterns);
  into.failedActions.push(...from.failedActions);
  if (from.failingStep) into.failingStep = from.failingStep;
  into.testErrorRecorded ||= from.testErrorRecorded;
  into.routeSteps.push(...from.routeSteps);
  into.console.error += from.console.error;
  into.console.warning += from.console.warning;
  into.console.other += from.console.other;
  into.pageErrors.push(...from.pageErrors);
  for (const [k, v] of from.malformed) into.malformed.set(k, (into.malformed.get(k) ?? 0) + v);
  for (const [k, v] of from.latestTime) into.latestTime.set(k, v);
}
