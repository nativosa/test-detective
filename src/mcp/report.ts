import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import * as z from 'zod';
import { checkFile, isNotFound, toRepoRelative } from './paths.ts';

// Pure Playwright-report logic: no MCP imports. Every function here is read-only.

export const REPORT_PATH = 'artifacts/results.json';
const MAX_REPORT_BYTES = 50 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_LINES = 15;
const MAX_STACK_CHARS = 2000;
const MAX_SNIPPET_CHARS = 1500;
const MAX_EXTRA_ERRORS = 4;
const MAX_EXTRA_ERROR_CHARS = 500;
const MAX_GLOBAL_ERRORS = 5;

// ---------------------------------------------------------------------------
// Errors

export type ReportErrorCode =
  | 'REPORT_NOT_FOUND'
  | 'REPORT_UNREADABLE'
  | 'REPORT_TOO_LARGE'
  | 'REPORT_MALFORMED_JSON'
  | 'REPORT_INVALID_SHAPE'
  | 'REPORT_OUTSIDE_REPO'
  | 'INVALID_TEST_ID'
  | 'REPORT_CHANGED'
  | 'TEST_NOT_FOUND'
  | 'TEST_NOT_FAILED';

export class ReportError extends Error {
  readonly code: ReportErrorCode;
  readonly hint: string;
  constructor(code: ReportErrorCode, message: string, hint: string) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
    this.hint = hint;
  }
}

const RERUN_HINT = 'Run `npm test` to generate a fresh report, then call list_test_failures.';
const RELIST_HINT = 'Call list_test_failures and use one of the testId values it returns.';

// ---------------------------------------------------------------------------
// Input shape: only the fields we read. Unknown fields pass through untouched.

const LocationShape = z.object({ file: z.string(), line: z.number(), column: z.number() }).loose();

const ErrorShape = z
  .object({
    message: z.string().optional(),
    stack: z.string().optional(),
    snippet: z.string().optional(),
    value: z.string().optional(),
    location: LocationShape.optional(),
  })
  .loose();

const AttachmentShape = z
  .object({ name: z.string(), contentType: z.string(), path: z.string().optional(), body: z.string().optional() })
  .loose();

const ResultShape = z
  .object({
    retry: z.number(),
    status: z.string().optional(),
    startTime: z.string().optional(),
    duration: z.number().optional(),
    error: ErrorShape.optional(),
    errors: z.array(ErrorShape).optional(),
    errorLocation: LocationShape.optional(),
    attachments: z.array(AttachmentShape).optional(),
    stdout: z.array(z.unknown()).optional(),
    stderr: z.array(z.unknown()).optional(),
  })
  .loose();

const TestShape = z
  .object({
    projectId: z.string(),
    projectName: z.string(),
    expectedStatus: z.string(),
    status: z.enum(['expected', 'unexpected', 'flaky', 'skipped']),
    timeout: z.number().optional(),
    results: z.array(ResultShape),
  })
  .loose();

const SpecShape = z
  .object({
    // Playwright ids are `<sha1(file)[:20]>-<sha1([project=..]file+titles[+repeat])[:20]>`.
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    title: z.string(),
    file: z.string(),
    line: z.number(),
    column: z.number(),
    tags: z.array(z.string()).optional(),
    tests: z.array(TestShape),
  })
  .loose();

type Suite = { title: string; specs: z.infer<typeof SpecShape>[]; suites?: Suite[] | undefined };

const SuiteShape: z.ZodType<Suite> = z
  .object({
    title: z.string(),
    specs: z.array(SpecShape),
    get suites() {
      return z.array(SuiteShape).optional();
    },
  })
  .loose();

const ReportShape = z
  .object({
    config: z
      .object({
        configFile: z.string().optional(),
        rootDir: z.string().optional(),
        version: z.string().optional(),
        projects: z.array(z.object({ id: z.string(), retries: z.number().optional() }).loose()).optional(),
      })
      .loose(),
    suites: z.array(SuiteShape),
    errors: z.array(ErrorShape).optional(),
    stats: z
      .object({
        startTime: z.string(),
        duration: z.number(),
        expected: z.number(),
        unexpected: z.number(),
        flaky: z.number(),
        skipped: z.number(),
      })
      .loose(),
  })
  .loose();

type Report = z.infer<typeof ReportShape>;
type Spec = z.infer<typeof SpecShape>;
type Test = z.infer<typeof TestShape>;
type Result = z.infer<typeof ResultShape>;
type ReportErrorShape = z.infer<typeof ErrorShape>;

// ---------------------------------------------------------------------------
// Output shapes, shared with the MCP layer as tool output schemas.

const RepoLocation = z.object({
  file: z.string().nullable().describe('Repo-relative POSIX path, or null if it could not be mapped into the repo'),
  line: z.number(),
  column: z.number(),
});

const Outcome = z.enum(['unexpected', 'flaky']).describe(
  "Playwright's test outcome. 'unexpected': the final attempt did not match expectedStatus and no attempt passed. 'flaky': at least one attempt failed and a later one passed.",
);

const RunInfo = z.object({
  reportPath: z.string(),
  reportFingerprint: z.string().describe('First 12 hex chars of SHA-256 of the report file; changes whenever the report is regenerated'),
  reportModifiedAt: z.string(),
  startTime: z.string(),
  durationMs: z.number(),
  playwrightVersion: z.string().nullable(),
});

const FailureSummary = z.object({
  testId: z.string(),
  title: z.string(),
  titlePath: z.array(z.string()).describe('describe() titles followed by the test title'),
  file: z.string(),
  line: z.number(),
  column: z.number(),
  project: z.string(),
  outcome: Outcome,
  expectedStatus: z.string(),
  finalStatus: z.string().nullable().describe('Status of the last attempt'),
  attempts: z.object({ count: z.number(), statuses: z.array(z.string().nullable()) }),
});

export const ListFailuresOutput = z.object({
  run: RunInfo,
  stats: z.object({ expected: z.number(), unexpected: z.number(), flaky: z.number(), skipped: z.number() }),
  globalErrors: z.object({
    count: z.number(),
    items: z.array(z.object({ message: z.string(), location: RepoLocation.nullable() })),
  }).describe('Errors outside any test (config/load/global setup). Present even when no test failed.'),
  failureCount: z.number(),
  failures: z.array(FailureSummary),
  message: z.string(),
});
export type ListFailuresOutput = z.infer<typeof ListFailuresOutput>;

const ErrorDetail = z.object({
  message: z.string(),
  expected: z.string().nullable().describe("Verbatim 'Expected…:' line from the message, if present"),
  actual: z.string().nullable().describe("Verbatim 'Received…:' line from the message, if present"),
  location: RepoLocation.nullable(),
  snippet: z.string().nullable(),
  stack: z.string().nullable(),
  truncated: z.boolean(),
});

const Attachment = z.object({
  name: z.string(),
  contentType: z.string(),
  location: z.enum(['repo', 'inline', 'outside-repo', 'invalid']),
  path: z.string().nullable().describe('Repo-relative POSIX path (location "repo" only)'),
  exists: z.boolean().nullable().describe('null when the file was not checked (inline, outside the repo, invalid)'),
  sizeBytes: z.number().nullable(),
  issue: z.string().nullable(),
});

const Attempt = z.object({
  retry: z.number(),
  status: z.string().nullable(),
  startTime: z.string().nullable(),
  durationMs: z.number().nullable(),
  error: ErrorDetail.nullable(),
  additionalErrors: z.array(z.object({ message: z.string(), location: RepoLocation.nullable() })),
  attachments: z.array(Attachment),
  omitted: z.object({ stdoutEntries: z.number(), stderrEntries: z.number(), additionalErrors: z.number() }),
});

export const FailureDetailsOutput = z.object({
  testId: z.string(),
  reportFingerprint: z.string(),
  title: z.string(),
  titlePath: z.array(z.string()),
  file: z.string(),
  line: z.number(),
  column: z.number(),
  project: z.string(),
  tags: z.array(z.string()),
  outcome: Outcome,
  expectedStatus: z.string(),
  finalStatus: z.string().nullable(),
  configuredRetries: z.number().nullable(),
  timeoutMs: z.number().nullable(),
  attempts: z.array(Attempt),
});
export type FailureDetailsOutput = z.infer<typeof FailureDetailsOutput>;

// ---------------------------------------------------------------------------
// Loading

export type LoadedReport = {
  repoRoot: string;
  report: Report;
  fingerprint: string;
  modifiedAt: string;
  /** Directory of the config file on the machine that produced the report. */
  reportRoot: string | undefined;
};

/** Reads `<repoRoot>/artifacts/results.json`. The path is fixed; clients cannot choose it. */
export async function loadReport(repoRoot: string): Promise<LoadedReport> {
  const file = path.join(repoRoot, ...REPORT_PATH.split('/'));
  let size: number;
  let modifiedAt: string;
  try {
    const [real, realRoot] = await Promise.all([realpath(file), realpath(repoRoot)]);
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ReportError('REPORT_OUTSIDE_REPO', `${REPORT_PATH} resolves outside the repository.`, 'Replace the symlink with a real report file.');
    }
    const info = await stat(real);
    size = info.size;
    modifiedAt = info.mtime.toISOString();
  } catch (error) {
    if (error instanceof ReportError) throw error;
    if (isNotFound(error)) throw new ReportError('REPORT_NOT_FOUND', `No Playwright report at ${REPORT_PATH}.`, RERUN_HINT);
    throw new ReportError('REPORT_UNREADABLE', `Could not access ${REPORT_PATH}.`, 'Check file permissions.');
  }
  if (size > MAX_REPORT_BYTES) {
    throw new ReportError('REPORT_TOO_LARGE', `${REPORT_PATH} is ${size} bytes (limit ${MAX_REPORT_BYTES}).`, 'Run a smaller subset of tests.');
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (isNotFound(error)) throw new ReportError('REPORT_NOT_FOUND', `No Playwright report at ${REPORT_PATH}.`, RERUN_HINT);
    throw new ReportError('REPORT_UNREADABLE', `Could not read ${REPORT_PATH}.`, 'Check file permissions.');
  }

  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReportError('REPORT_MALFORMED_JSON', `${REPORT_PATH} is not valid JSON: ${detail}`, `${RERUN_HINT} If the run was interrupted, the file may be partially written.`);
  }

  const parsed = ReportShape.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'unknown';
    throw new ReportError('REPORT_INVALID_SHAPE', `${REPORT_PATH} is not a Playwright JSON report (${where}).`, 'Make sure the JSON reporter in playwright.config.ts writes this file.');
  }

  const configFile = parsed.data.config.configFile;
  return {
    repoRoot,
    report: parsed.data,
    fingerprint: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
    modifiedAt,
    reportRoot: configFile ? dirnameAnyFlavor(configFile) : undefined,
  };
}

function dirnameAnyFlavor(p: string): string {
  return /^[A-Za-z]:[\\/]/.test(p) ? path.win32.dirname(p) : path.posix.dirname(p);
}

// ---------------------------------------------------------------------------
// Walking

type TestEntry = { key: string; spec: Spec; test: Test; titlePath: string[] };

/**
 * Flattens recursively nested suites into one entry per (spec, project, repeat).
 *
 * In Playwright 1.64 each project and each --repeat-each run gets its own spec with its own id,
 * so `spec.id` alone is unique. Older/newer reporters may merge several projects into one spec
 * (`spec.tests.length > 1`); those get a `.<index>` suffix, and any remaining collision gets a
 * further counter, so keys are always unique within one report.
 */
export function collectTests(report: Report): TestEntry[] {
  const entries: TestEntry[] = [];
  const seen = new Map<string, number>();
  const walk = (suite: Suite, describes: string[], isFile: boolean) => {
    const titles = isFile ? describes : [...describes, suite.title];
    for (const spec of suite.specs) {
      spec.tests.forEach((test, index) => {
        let key = spec.tests.length > 1 ? `${spec.id}.${index}` : spec.id;
        const count = seen.get(key) ?? 0;
        seen.set(key, count + 1);
        if (count > 0) key = `${key}.${count}`;
        entries.push({ key, spec, test, titlePath: [...titles, spec.title] });
      });
    }
    for (const child of suite.suites ?? []) walk(child, titles, false);
  };
  for (const fileSuite of report.suites) walk(fileSuite, [], true);
  return entries;
}

function isFailure(test: Test): test is Test & { status: 'unexpected' | 'flaky' } {
  return test.status === 'unexpected' || test.status === 'flaky';
}

// ---------------------------------------------------------------------------
// Test identifiers: `<key>@<reportFingerprint>`

const TEST_ID = /^([A-Za-z0-9_-]{1,100}(?:\.\d{1,4}){0,2})@([0-9a-f]{12})$/;

export function makeTestId(key: string, fingerprint: string): string {
  return `${key}@${fingerprint}`;
}

// ---------------------------------------------------------------------------
// list_test_failures

export function listFailures(loaded: LoadedReport): ListFailuresOutput {
  const { report } = loaded;
  const failures = collectTests(report)
    .filter((e) => isFailure(e.test))
    .map((e) => summarize(loaded, e));
  const globalErrors = report.errors ?? [];
  const message =
    failures.length > 0
      ? `${failures.length} failed or flaky test(s). Pass a testId to get_failure_details.`
      : globalErrors.length > 0
        ? 'No failed or flaky tests, but the run reported global errors (see globalErrors).'
        : 'No failed or flaky tests in this report.';
  return {
    run: {
      reportPath: REPORT_PATH,
      reportFingerprint: loaded.fingerprint,
      reportModifiedAt: loaded.modifiedAt,
      startTime: report.stats.startTime,
      durationMs: Math.round(report.stats.duration),
      playwrightVersion: report.config.version ?? null,
    },
    stats: {
      expected: report.stats.expected,
      unexpected: report.stats.unexpected,
      flaky: report.stats.flaky,
      skipped: report.stats.skipped,
    },
    globalErrors: {
      count: globalErrors.length,
      items: globalErrors.slice(0, MAX_GLOBAL_ERRORS).map((e) => ({
        message: truncate(clean(e.message ?? e.value ?? '(no message)'), MAX_EXTRA_ERROR_CHARS).text,
        location: mapLocation(loaded, e.location),
      })),
    },
    failureCount: failures.length,
    failures,
    message,
  };
}

function summarize(loaded: LoadedReport, { key, spec, test, titlePath }: TestEntry): z.infer<typeof FailureSummary> {
  const statuses = test.results.map((r) => r.status ?? null);
  return {
    testId: makeTestId(key, loaded.fingerprint),
    title: spec.title,
    titlePath,
    file: specFile(loaded, spec),
    line: spec.line,
    column: spec.column,
    project: test.projectName || test.projectId,
    outcome: test.status as 'unexpected' | 'flaky',
    expectedStatus: test.expectedStatus,
    finalStatus: statuses.at(-1) ?? null,
    attempts: { count: test.results.length, statuses },
  };
}

// ---------------------------------------------------------------------------
// get_failure_details

export async function getFailureDetails(loaded: LoadedReport, testId: string): Promise<FailureDetailsOutput> {
  const match = TEST_ID.exec(testId);
  if (!match) {
    throw new ReportError('INVALID_TEST_ID', 'testId is not in the format returned by list_test_failures.', RELIST_HINT);
  }
  const [, key, fingerprint] = match;
  if (fingerprint !== loaded.fingerprint) {
    throw new ReportError(
      'REPORT_CHANGED',
      `testId belongs to report ${fingerprint}, but ${REPORT_PATH} is now ${loaded.fingerprint} (it was regenerated).`,
      RELIST_HINT,
    );
  }
  const entry = collectTests(loaded.report).find((e) => e.key === key);
  if (!entry) throw new ReportError('TEST_NOT_FOUND', `No test with id ${testId} in this report.`, RELIST_HINT);
  if (!isFailure(entry.test)) {
    throw new ReportError('TEST_NOT_FAILED', `Test "${entry.spec.title}" did not fail (outcome: ${entry.test.status}).`, RELIST_HINT);
  }

  const { spec, test } = entry;
  const summary = summarize(loaded, entry);
  const project = loaded.report.config.projects?.find((p) => p.id === test.projectId);
  return {
    testId: summary.testId,
    reportFingerprint: loaded.fingerprint,
    title: summary.title,
    titlePath: summary.titlePath,
    file: summary.file,
    line: summary.line,
    column: summary.column,
    project: summary.project,
    tags: spec.tags ?? [],
    outcome: summary.outcome,
    expectedStatus: summary.expectedStatus,
    finalStatus: summary.finalStatus,
    configuredRetries: project?.retries ?? null,
    timeoutMs: test.timeout ?? null,
    attempts: await Promise.all(test.results.map((r) => describeAttempt(loaded, r))),
  };
}

async function describeAttempt(loaded: LoadedReport, result: Result): Promise<z.infer<typeof Attempt>> {
  const errors = result.errors ?? [];
  const primary = result.error ?? errors[0];
  // `errors[0]` repeats `error`; the rest are e.g. soft assertions or the locator behind a timeout.
  const extra = errors.slice(1);
  return {
    retry: result.retry,
    status: result.status ?? null,
    startTime: result.startTime ?? null,
    durationMs: result.duration ?? null,
    error: primary ? describeError(loaded, primary, result.errorLocation) : null,
    additionalErrors: extra.slice(0, MAX_EXTRA_ERRORS).map((e) => ({
      message: truncate(clean(e.message ?? e.value ?? ''), MAX_EXTRA_ERROR_CHARS).text,
      location: mapLocation(loaded, e.location),
    })),
    attachments: await Promise.all((result.attachments ?? []).map((a) => describeAttachment(loaded, a))),
    omitted: {
      stdoutEntries: result.stdout?.length ?? 0,
      stderrEntries: result.stderr?.length ?? 0,
      additionalErrors: Math.max(0, extra.length - MAX_EXTRA_ERRORS),
    },
  };
}

function describeError(
  loaded: LoadedReport,
  error: ReportErrorShape,
  fallbackLocation: z.infer<typeof LocationShape> | undefined,
): z.infer<typeof ErrorDetail> {
  const rawMessage = clean(error.message ?? error.value ?? '(no message)');
  const message = truncate(rawMessage, MAX_MESSAGE_CHARS);
  const snippet = error.snippet ? truncate(clean(error.snippet), MAX_SNIPPET_CHARS) : null;
  const stack = error.stack ? truncateStack(clean(error.stack), rawMessage) : null;
  return {
    message: message.text,
    expected: extractLine(rawMessage, 'Expected'),
    actual: extractLine(rawMessage, 'Received'),
    location: mapLocation(loaded, error.location ?? fallbackLocation),
    snippet: snippet?.text ?? null,
    stack: stack?.text ?? null,
    truncated: message.truncated || !!snippet?.truncated || !!stack?.truncated,
  };
}

async function describeAttachment(
  loaded: LoadedReport,
  attachment: z.infer<typeof AttachmentShape>,
): Promise<z.infer<typeof Attachment>> {
  const base = { name: attachment.name, contentType: attachment.contentType };
  if (attachment.path === undefined) {
    // Inline attachment: report its size, never its (base64) body.
    const body = attachment.body ?? '';
    return { ...base, location: 'inline', path: null, exists: null, sizeBytes: Buffer.byteLength(body, 'base64'), issue: null };
  }
  const resolved = toRepoRelative(attachment.path, loaded.reportRoot);
  if (resolved.kind === 'invalid') {
    return { ...base, location: 'invalid', path: null, exists: null, sizeBytes: null, issue: resolved.reason };
  }
  if (resolved.kind === 'outside-repo') {
    return { ...base, location: 'outside-repo', path: null, exists: null, sizeBytes: null, issue: 'path is outside the repository; not checked' };
  }
  const check = await checkFile(loaded.repoRoot, resolved.relative);
  if (check.exists === true) return { ...base, location: 'repo', path: resolved.relative, exists: true, sizeBytes: check.sizeBytes, issue: null };
  if (check.exists === false) return { ...base, location: 'repo', path: resolved.relative, exists: false, sizeBytes: null, issue: 'file not found' };
  return { ...base, location: 'repo', path: resolved.relative, exists: null, sizeBytes: null, issue: check.issue };
}

// ---------------------------------------------------------------------------
// Helpers

function specFile(loaded: LoadedReport, spec: Spec): string {
  // spec.file is relative to config.rootDir (the testDir); express it relative to the repo.
  const rootDir = loaded.report.config.rootDir;
  const testDir = rootDir ? toRepoRelative(rootDir, loaded.reportRoot) : undefined;
  const file = spec.file.split(/[\\/]+/).join('/');
  if (testDir?.kind !== 'repo') return file;
  return testDir.relative ? `${testDir.relative}/${file}` : file;
}

function mapLocation(loaded: LoadedReport, location: z.infer<typeof LocationShape> | undefined) {
  if (!location) return null;
  const resolved = toRepoRelative(location.file, loaded.reportRoot);
  return { file: resolved.kind === 'repo' ? resolved.relative : null, line: location.line, column: location.column };
}

function clean(text: string): string {
  return stripVTControlCharacters(text);
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}… [truncated ${text.length - max} chars]`, truncated: true };
}

function truncateStack(stack: string, message: string): { text: string; truncated: boolean } {
  // Playwright stacks start by repeating the message; keep only the frames.
  const frames = (stack.startsWith(message) ? stack.slice(message.length) : stack).replace(/^\s*\n/, '');
  const lines = frames.split('\n');
  const kept = lines.slice(0, MAX_STACK_LINES).join('\n');
  const byChars = truncate(kept, MAX_STACK_CHARS);
  return { text: byChars.text, truncated: byChars.truncated || lines.length > MAX_STACK_LINES };
}

function extractLine(message: string, label: 'Expected' | 'Received'): string | null {
  // Matches e.g. "Expected: 2", "Received string: \"foo\"", "Expected pattern: /x/".
  const match = new RegExp(`^\\s*${label}(?: [a-z ]+)?: (.*)$`, 'm').exec(message);
  return match?.[1] ? truncate(match[1].trim(), 300).text : null;
}
