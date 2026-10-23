import { close } from 'node:fs';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

// Bounded, read-only ZIP scanning on top of yauzl. Nothing is extracted to disk. Only entries the
// caller selects are inflated, as a stream, and handed over line by line; everything else is only
// listed. The checks here close the gaps the Stage 3.2 spike found in yauzl 3.4.0 (duplicate and
// NUL names, local/central name mismatch, no data CRC check, no entry-count or declared-size cap).

export type ArchiveLimits = {
  /** Central-directory entries; checked before any entry is read. */
  maxEntries: number;
  /** Selected entries that are inflated at all; the rest are reported as skipped. */
  maxReadEntries: number;
  /** Uncompressed bytes read from one entry (counted on the stream); larger entries are cut here and reported partial. */
  maxEntryBytes: number;
  /** Uncompressed bytes across all read entries. */
  maxTotalBytes: number;
  /** Longer lines are dropped and counted, never buffered whole. */
  maxLineBytes: number;
  /** Non-empty lines across all read entries. */
  maxLines: number;
  /** Wall-clock budget for the whole scan. */
  maxMs: number;
};

export type ArchiveErrorCode = 'not_zip' | 'archive_invalid' | 'too_many_entries' | 'invalid_entry_name' | 'duplicate_entry_name';

/** The archive as a whole can't be trusted; no entry is read. */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  constructor(code: ArchiveErrorCode, message: string) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

export type EntryStatus = 'complete' | 'partial' | 'skipped' | 'corrupt' | 'unsupported';
export type StopReason = 'time_budget' | 'byte_budget' | 'line_budget' | 'cancelled';
export type EntryProblem =
  | StopReason
  | 'read_entry_limit'
  | 'declared_size'
  | 'encrypted'
  | 'compression_method'
  | 'local_header_mismatch'
  | 'size_mismatch'
  | 'crc_mismatch'
  | 'inflate_error';

export type EntryReport = {
  name: string;
  status: EntryStatus;
  problem: EntryProblem | null;
  lines: number;
  oversizedLines: number;
  bytes: number;
  /** True only when the whole entry was inflated and its CRC-32 matched. */
  crcVerified: boolean;
};

/**
 * Receives one entry's lines. `done('commit')` keeps what the sink collected (complete or cut short
 * by a budget); `done('discard')` drops it (corrupt data must not become evidence).
 */
export type EntrySink = { line(text: string): void; done(outcome: 'commit' | 'discard'): void };

export type ScanResult = {
  entryCount: number;
  /** Entries present but not selected (screenshots, resources, sources…), counted, never read. */
  unreadEntries: number;
  entries: EntryReport[];
  stoppedBy: StopReason | null;
  bytesInflated: number;
  linesRead: number;
};

export type ScanOptions = {
  limits: ArchiveLimits;
  /** Request cancellation (client gone). The time budget is enforced separately. */
  signal?: AbortSignal | undefined;
  /** Picks the entries to read, in reading order, from the validated entry names. */
  select: (names: string[]) => string[];
  open: (name: string) => EntrySink;
};

const MAX_NAME_LENGTH = 512;
const UNSAFE_NAME = /[\u0000-\u001f\u007f]/;

/**
 * Scans an open archive and takes ownership of `fd`. yauzl's fd slicer closes it once the zip file is
 * closed and its last pending read has finished; if the archive can't be opened it is closed here.
 * Throws ArchiveError for archive-level problems.
 */
export async function scanArchive(fd: number, options: ScanOptions): Promise<ScanResult> {
  const { limits } = options;
  const timeout = AbortSignal.timeout(limits.maxMs);
  const stop = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const stopReason = (): StopReason => (timeout.aborted ? 'time_budget' : 'cancelled');

  let zip: ZipFile;
  try {
    // strictFileNames rejects `\`, absolute names and `..` segments.
    zip = await yauzl.fromFdPromise(fd, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true, decodeStrings: true });
  } catch (error) {
    close(fd, () => undefined);
    throw toArchiveError(error);
  }
  // Failures surface through the promises below; this keeps a late reader error after close() from going uncaught.
  zip.on('error', () => undefined);
  try {
    if (zip.entryCount > limits.maxEntries) {
      throw new ArchiveError('too_many_entries', `${zip.entryCount} entries (limit ${limits.maxEntries})`);
    }
    const entries = new Map<string, Entry>();
    try {
      for await (const entry of zip.eachEntry()) {
        if (stop.aborted) break;
        const name = entry.fileName;
        if (name.length === 0 || name.length > MAX_NAME_LENGTH || UNSAFE_NAME.test(name)) {
          throw new ArchiveError('invalid_entry_name', 'entry name is empty, too long or has control characters');
        }
        if (entries.has(name)) throw new ArchiveError('duplicate_entry_name', 'two entries share a name');
        entries.set(name, entry);
      }
    } catch (error) {
      throw toArchiveError(error);
    }

    const result: ScanResult = { entryCount: zip.entryCount, unreadEntries: 0, entries: [], stoppedBy: null, bytesInflated: 0, linesRead: 0 };
    if (stop.aborted) {
      result.stoppedBy = stopReason();
      result.unreadEntries = entries.size;
      return result;
    }
    const selected = options.select([...entries.keys()]).filter((name) => entries.has(name));
    result.unreadEntries = entries.size - selected.length;

    for (const [index, name] of selected.entries()) {
      const entry = entries.get(name)!;
      const skipped = (status: EntryStatus, problem: EntryProblem): void => {
        result.entries.push({ name, status, problem, lines: 0, oversizedLines: 0, bytes: 0, crcVerified: false });
      };
      if (result.stoppedBy) skipped('skipped', result.stoppedBy);
      else if (index >= limits.maxReadEntries) skipped('skipped', 'read_entry_limit');
      else if (entry.isEncrypted()) skipped('unsupported', 'encrypted');
      else if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) skipped('unsupported', 'compression_method');
      else {
        // A declared size over maxEntryBytes is not skipped: the entry is read up to the limit (counted
        // on the actual inflated stream) and reported partial, so a large trace still yields evidence.
        const report = await readEntry(zip, entry, options, result, stop, stopReason);
        result.entries.push(report);
      }
    }
    return result;
  } finally {
    zip.close();
  }
}

async function readEntry(
  zip: ZipFile,
  entry: Entry,
  options: ScanOptions,
  totals: ScanResult,
  stop: AbortSignal,
  stopReason: () => StopReason,
): Promise<EntryReport> {
  const { limits } = options;
  const report: EntryReport = { name: entry.fileName, status: 'complete', problem: null, lines: 0, oversizedLines: 0, bytes: 0, crcVerified: false };
  const sink = options.open(entry.fileName);

  try {
    const local = await zip.readLocalFileHeaderPromise(entry);
    if (!local.fileName.equals(entry.fileNameRaw)) {
      sink.done('discard');
      return { ...report, status: 'corrupt', problem: 'local_header_mismatch' };
    }
  } catch {
    sink.done('discard');
    return { ...report, status: 'corrupt', problem: 'local_header_mismatch' };
  }

  let crc = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let oversized = false;
  let cut: StopReason | 'declared_size' | null = null;

  const emit = (bytes: Buffer): void => {
    const text = bytes.toString('utf8').replace(/\r$/, '');
    if (text.trim() === '') return;
    report.lines += 1;
    totals.linesRead += 1;
    sink.line(text);
  };
  const consume = (chunk: Buffer): void => {
    let start = 0;
    for (let nl = chunk.indexOf(10, start); nl !== -1 && !cut; nl = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, nl);
      if (oversized || pendingBytes + piece.length > limits.maxLineBytes) report.oversizedLines += 1;
      else emit(pendingBytes ? Buffer.concat([...pending, piece]) : piece);
      pending = [];
      pendingBytes = 0;
      oversized = false;
      start = nl + 1;
      if (totals.linesRead >= limits.maxLines) cut = 'line_budget';
    }
    if (cut) return;
    const rest = chunk.subarray(start);
    if (oversized || rest.length === 0) return;
    if (pendingBytes + rest.length > limits.maxLineBytes) {
      oversized = true;
      pending = [];
      pendingBytes = 0;
    } else {
      pending.push(Buffer.from(rest));
      pendingBytes += rest.length;
    }
  };

  let stream: Readable;
  try {
    stream = await zip.openReadStreamPromise(entry);
  } catch {
    sink.done('discard');
    return { ...report, status: 'corrupt', problem: 'inflate_error' };
  }
  const onAbort = () => stream.destroy(new Error('aborted'));
  stop.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const data of stream) {
      const chunk = data as Buffer;
      if (stop.aborted) {
        cut = stopReason();
        break;
      }
      // Use the budget up to the byte, then stop: what fits is still evidence.
      const entryRoom = limits.maxEntryBytes - report.bytes;
      const totalRoom = limits.maxTotalBytes - totals.bytesInflated;
      const room = Math.max(0, Math.min(entryRoom, totalRoom));
      const over = chunk.length > room;
      const piece = over ? chunk.subarray(0, room) : chunk;
      report.bytes += piece.length;
      totals.bytesInflated += piece.length;
      crc = zlib.crc32(piece, crc);
      consume(piece);
      if (over && !cut) cut = totalRoom <= entryRoom ? 'byte_budget' : 'declared_size';
      if (cut) break;
    }
  } catch (error) {
    if (stop.aborted) cut = stopReason();
    else {
      sink.done('discard');
      const message = error instanceof Error ? error.message : '';
      const problem: EntryProblem = /bytes in the stream/.test(message) ? 'size_mismatch' : 'inflate_error';
      return { ...report, status: 'corrupt', problem, lines: 0 };
    }
  } finally {
    stop.removeEventListener('abort', onAbort);
  }

  if (cut) {
    // Cut short: what was read is kept, but it is unverified and possibly incomplete. Only the
    // per-entry limit leaves the remaining entries readable.
    stream.destroy();
    if (cut !== 'declared_size') totals.stoppedBy = cut;
    sink.done('commit');
    return { ...report, status: 'partial', problem: cut };
  }
  if (pending.length > 0 && !oversized) emit(Buffer.concat(pending));
  if (report.bytes !== entry.uncompressedSize) {
    sink.done('discard');
    return { ...report, status: 'corrupt', problem: 'size_mismatch', lines: 0 };
  }
  if (crc !== entry.crc32) {
    sink.done('discard');
    return { ...report, status: 'corrupt', problem: 'crc_mismatch', lines: 0 };
  }
  sink.done('commit');
  return { ...report, crcVerified: true };
}

function toArchiveError(error: unknown): ArchiveError {
  if (error instanceof ArchiveError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/end of central directory record signature not found/i.test(message)) return new ArchiveError('not_zip', 'not a ZIP archive');
  if (/invalid relative path|absolute path|invalid characters in fileName/i.test(message)) {
    return new ArchiveError('invalid_entry_name', 'entry name is absolute, uses `..` or contains a backslash');
  }
  return new ArchiveError('archive_invalid', 'the archive structure is invalid or unsupported');
}
