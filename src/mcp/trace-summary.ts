import { createHash } from 'node:crypto';
import { close, fstat, open, read } from 'node:fs';
import { promisify } from 'node:util';
import * as z from 'zod';
import { isNotFound, locateFile, toRepoRelative } from './paths.ts';
import { findFailedTest, makeTestId, ReportError } from './report.ts';
import type { LoadedReport } from './report.ts';
import { createCollector, OUTPUT_LIMITS, selectTraceEntries, TraceAnalysis } from './trace.ts';
import type { Reason, ReasonCode } from './trace.ts';
import { ArchiveError, scanArchive } from './zip.ts';
import type { ArchiveLimits } from './zip.ts';

// get_trace_summary: resolves one attempt's trace through the report (never a client path), opens
// it read-only, scans it with the bounded archive layer and returns the sanitized analysis.
// Kept apart from report.ts so the evaluation scorer, which imports report.ts for its schemas,
// never loads the archive or trace code.


export type TraceLimits = { maxFileBytes: number; archive: ArchiveLimits };

/** Initial ceilings from the Stage 3.2 spike (≈2 KB per network record, ≈0.5 s per 64 MB). */
export const DEFAULT_TRACE_LIMITS: TraceLimits = {
  maxFileBytes: 100 * 1024 * 1024,
  archive: {
    maxEntries: 5000,
    maxReadEntries: 64,
    maxEntryBytes: 64 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
    maxLineBytes: 1024 * 1024,
    maxLines: 250_000,
    maxMs: 2000,
  },
};

const STOP_REASONS = new Set<ReasonCode>(['time_budget', 'byte_budget', 'line_budget', 'cancelled']);

const TraceStatus = z
  .enum(['ok', 'partial', 'missing', 'unsupported'])
  .describe("'ok': every whitelisted entry read and verified. 'partial': some evidence was not read (see trace.reasons and coverage); absent items are then unknown, not absent. 'missing': no readable trace for this attempt. 'unsupported': the archive or trace format can't be interpreted safely");

const { format: _format, reasons: _reasons, ...analysisShape } = TraceAnalysis.shape;

export const TraceSummaryOutput = z.object({
  testId: z.string(),
  reportFingerprint: z.string(),
  retry: z.number(),
  attemptStatus: z.string().nullable().describe('Status of this attempt in the report'),
  trace: z.object({
    status: TraceStatus,
    path: z.string().nullable().describe('Repo-relative path of the trace that was read (provenance)'),
    sizeBytes: z.number().nullable(),
    format: TraceAnalysis.shape.format,
    reasons: TraceAnalysis.shape.reasons,
  }),
  ...analysisShape,
  limits: z.object({
    maxFileBytes: z.number(),
    maxEntries: z.number(),
    maxEntryBytes: z.number(),
    maxTotalBytes: z.number(),
    maxLines: z.number(),
    maxMs: z.number(),
    maxRequests: z.number(),
    maxOutputBytes: z.number(),
  }),
});
export type TraceSummaryOutput = z.infer<typeof TraceSummaryOutput>;

/** Bounded LRU of sanitized analyses, keyed by trace file identity and content version. Never raw trace data. */
export class TraceCache {
  readonly #max: number;
  readonly #entries = new Map<string, TraceAnalysis>();
  hits = 0;
  constructor(max = 16) {
    this.#max = max;
  }
  get(key: string): TraceAnalysis | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    this.hits += 1;
    return structuredClone(value);
  }
  set(key: string, value: TraceAnalysis): void {
    this.#entries.delete(key);
    this.#entries.set(key, structuredClone(value));
    while (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value!);
  }
  get size(): number {
    return this.#entries.size;
  }
}

export type TraceRuntime = { limits?: TraceLimits; cache?: TraceCache; signal?: AbortSignal };

export async function getTraceSummary(loaded: LoadedReport, testId: string, retry: number, runtime: TraceRuntime = {}): Promise<TraceSummaryOutput> {
  const limits = runtime.limits ?? DEFAULT_TRACE_LIMITS;
  const entry = findFailedTest(loaded, testId);
  const attempts = entry.test.results.filter((r) => r.retry === retry);
  if (attempts.length !== 1) {
    const known = entry.test.results.map((r) => r.retry).join(', ');
    throw new ReportError('ATTEMPT_NOT_FOUND', `Test has no attempt with retry ${retry} (attempts: ${known || 'none'}).`, 'Use a retry index from get_failure_details attempts[].retry.');
  }
  const attempt = attempts[0]!;
  const base = {
    testId: makeTestId(entry.key, loaded.fingerprint),
    reportFingerprint: loaded.fingerprint,
    retry,
    attemptStatus: attempt.status ?? null,
  };
  const limitsOut = {
    maxFileBytes: limits.maxFileBytes,
    maxEntries: limits.archive.maxEntries,
    maxEntryBytes: limits.archive.maxEntryBytes,
    maxTotalBytes: limits.archive.maxTotalBytes,
    maxLines: limits.archive.maxLines,
    maxMs: limits.archive.maxMs,
    maxRequests: OUTPUT_LIMITS.maxRequests,
    maxOutputBytes: OUTPUT_LIMITS.maxOutputBytes,
  };
  const empty = { coverage: null, timeline: null, failure: null, contexts: null, network: null, backendFetches: null, routes: null, console: null, pageErrors: null };
  const notRead = (status: 'missing' | 'unsupported', code: ReasonCode, path: string | null = null, sizeBytes: number | null = null): TraceSummaryOutput => ({
    ...base,
    trace: { status, path, sizeBytes, format: null, reasons: [{ code, entry: null, count: null }] },
    ...empty,
    limits: limitsOut,
  });

  // The trace comes only from this attempt's report attachment; clients never supply a path.
  const traces = (attempt.attachments ?? []).filter((a) => a.name === 'trace');
  if (traces.length === 0) return notRead('missing', 'no_trace_attachment');
  const extra: Reason[] = traces.length > 1 ? [{ code: 'multiple_trace_attachments', entry: null, count: traces.length }] : [];
  const attachment = traces[0]!;
  if (attachment.path === undefined) return notRead('missing', 'attachment_inline');
  const resolved = toRepoRelative(attachment.path, loaded.reportRoot);
  if (resolved.kind === 'invalid') return notRead('missing', 'attachment_invalid_path');
  if (resolved.kind === 'outside-repo') return notRead('missing', 'attachment_outside_repo');
  const located = await locateFile(loaded.repoRoot, resolved.relative);
  if (located.kind === 'missing') return notRead('missing', 'file_not_found', resolved.relative);
  if (located.kind === 'issue') {
    const code: ReasonCode = located.issue === 'not-a-file' ? 'not_a_regular_file' : located.issue === 'unreadable' ? 'file_unreadable' : 'attachment_outside_repo';
    return notRead('missing', code, located.issue === 'not-a-file' || located.issue === 'unreadable' ? resolved.relative : null);
  }
  if (located.sizeBytes > limits.maxFileBytes) return notRead('unsupported', 'file_too_large', resolved.relative, located.sizeBytes);

  const mapFile = (raw: string): string | null => {
    if (!/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith('/')) return null;
    const mapped = toRepoRelative(raw, loaded.reportRoot);
    return mapped.kind === 'repo' ? mapped.relative : null;
  };

  let fd: number;
  try {
    fd = await promisify(open)(located.real, 'r');
  } catch (error) {
    return notRead('missing', isNotFound(error) ? 'file_not_found' : 'file_unreadable', resolved.relative);
  }
  let owned = true; // until scanArchive takes the descriptor over
  try {
    const info = await promisify(fstat)(fd);
    if (!info.isFile()) return notRead('missing', 'not_a_regular_file', resolved.relative);
    if (info.size > limits.maxFileBytes) return notRead('unsupported', 'file_too_large', resolved.relative, info.size);

    // Content version: the archive tail holds the central directory, i.e. every entry's CRC-32 and size.
    const tail = Buffer.alloc(Math.min(info.size, 64 * 1024));
    await promisify(read)(fd, tail, 0, tail.length, info.size - tail.length);
    const key = [located.real, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, createHash('sha256').update(tail).digest('hex'), loaded.reportRoot ?? '', JSON.stringify(limits)].join('|');

    let analysis = runtime.cache?.get(key);
    if (!analysis) {
      const collector = createCollector({ mapFile });
      try {
        owned = false;
        const scan = await scanArchive(fd, { limits: limits.archive, signal: runtime.signal, select: selectTraceEntries, open: (name) => collector.open(name) });
        analysis = collector.finish(scan);
        // Results cut short by time or cancellation depend on machine load; don't keep them.
        if (scan.stoppedBy !== 'time_budget' && scan.stoppedBy !== 'cancelled') runtime.cache?.set(key, analysis);
      } catch (error) {
        if (!(error instanceof ArchiveError)) throw error;
        return notRead('unsupported', error.code, resolved.relative, info.size);
      }
    }
    const { format, reasons, ...rest } = analysis;
    const allReasons = [...extra, ...reasons];
    // No evidence sections: unsupported, unless a budget or cancellation stopped the scan before anything identifying was read.
    const stopped = allReasons.some((r) => STOP_REASONS.has(r.code));
    const status = rest.network === null ? (stopped ? 'partial' : 'unsupported') : rest.coverage?.complete && allReasons.length === 0 ? 'ok' : 'partial';
    return { ...base, trace: { status, path: resolved.relative, sizeBytes: info.size, format, reasons: allReasons }, ...rest, limits: limitsOut };
  } finally {
    if (owned) close(fd, () => undefined);
  }
}
