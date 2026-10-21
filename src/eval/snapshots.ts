import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { loadReport } from '../mcp/report.ts';
import { ScenarioId } from './scenarios.ts';

// Snapshot storage and loading. A snapshot is one scenario's frozen Playwright run:
//
//   evals/snapshots/<id>/manifest.json   metadata, hashes, observation result (never shown to the agent)
//   evals/snapshots/<id>/files/...       repo-shaped payload: playwright.config.ts, tests/, artifacts/, test-results/
//
// Snapshots are write-once: written to a temp directory, then renamed into place, never overwritten.
// Loading re-verifies every hash, so a modified, added or missing file is refused.

export const SNAPSHOTS_DIR = fileURLToPath(new URL('../../evals/snapshots/', import.meta.url));
export const MANIFEST_FILE = 'manifest.json';
export const FILES_DIR = 'files';
/** Copies keep their mtime within this tolerance (filesystem timestamp precision varies). */
const MTIME_TOLERANCE_MS = 2;

/** A repo-relative POSIX path with no traversal, drive letters, backslashes or empty segments. */
const SafeRelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => {
    if (p.startsWith('/') || p.includes('\\') || /[\u0000-\u001f:]/.test(p)) return false;
    return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
  }, 'must be a relative POSIX path without traversal');

const Check = z.strictObject({ name: z.string(), ok: z.boolean(), detail: z.string() });
export type Check = z.infer<typeof Check>;

export const SnapshotManifest = z.strictObject({
  formatVersion: z.literal(1),
  scenarioId: ScenarioId,
  generatedAt: z.iso.datetime(),
  reportFingerprint: z.string().regex(/^[0-9a-f]{12}$/),
  playwrightVersion: z.string().min(1),
  nodeVersion: z.string().min(1),
  platform: z.string().min(1),
  generationConfigSha256: z.string().regex(/^[0-9a-f]{64}$/).describe('Hash of the generation.json this snapshot was made from'),
  stageRoot: z.string().describe('Absolute stage directory recorded in the report (paths are resolved relative to it)'),
  observation: z.strictObject({ ok: z.literal(true), checks: z.array(Check) }).describe('Only snapshots that passed are stored'),
  files: z
    .array(
      z.strictObject({
        path: SafeRelativePath,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        sizeBytes: z.number().int().nonnegative(),
        mtimeMs: z.number(),
      }),
    )
    .min(1),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifest>;
export type FileEntry = SnapshotManifest['files'][number];

export type LoadedSnapshot = { manifest: SnapshotManifest; dir: string; filesDir: string };

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Every regular file under `root`, as sorted POSIX relative paths with hash, size and mtime.
 * Symlinks and other special files are refused: a snapshot must be plain files only.
 */
export async function hashTree(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new SnapshotError(`${rel} is a symlink; snapshots contain regular files only.`);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        const parsed = SafeRelativePath.safeParse(rel);
        if (!parsed.success) throw new SnapshotError(`${rel} is not a safe relative path.`);
        out.push({ path: rel, sha256: sha256(await readFile(full)), sizeBytes: info.size, mtimeMs: info.mtimeMs });
      } else throw new SnapshotError(`${rel} is not a regular file.`);
    }
  };
  await walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Differences between the manifest's file list and what is on disk. Empty means identical. */
export function compareFiles(expected: FileEntry[], actual: FileEntry[], options: { checkMtime: boolean }): string[] {
  const problems: string[] = [];
  const onDisk = new Map(actual.map((f) => [f.path, f]));
  for (const f of expected) {
    const found = onDisk.get(f.path);
    onDisk.delete(f.path);
    if (!found) problems.push(`missing: ${f.path}`);
    else if (found.sha256 !== f.sha256 || found.sizeBytes !== f.sizeBytes) problems.push(`hash mismatch: ${f.path}`);
    else if (options.checkMtime && Math.abs(found.mtimeMs - f.mtimeMs) > MTIME_TOLERANCE_MS) problems.push(`mtime changed: ${f.path}`);
  }
  for (const extra of onDisk.keys()) problems.push(`unexpected file: ${extra}`);
  return problems;
}

/**
 * Stores a verified payload as `<snapshotsRoot>/<id>/`. Refuses to overwrite an existing snapshot.
 * The payload directory is copied (timestamps preserved), never moved, so the caller still owns it.
 */
export async function writeSnapshot(
  payloadDir: string,
  manifest: Omit<SnapshotManifest, 'files' | 'formatVersion'>,
  snapshotsRoot: string = SNAPSHOTS_DIR,
): Promise<LoadedSnapshot> {
  const target = path.join(snapshotsRoot, ScenarioId.parse(manifest.scenarioId));
  if (await exists(target)) {
    throw new SnapshotError(`A snapshot for ${manifest.scenarioId} already exists at ${target}. Snapshots are never overwritten; delete it to regenerate.`);
  }
  await mkdir(snapshotsRoot, { recursive: true });
  const temp = path.join(snapshotsRoot, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    const filesDir = path.join(temp, FILES_DIR);
    await cp(payloadDir, filesDir, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    const files = await hashTree(filesDir);
    const source = await hashTree(payloadDir);
    const drift = compareFiles(source, files, { checkMtime: true });
    if (drift.length > 0) throw new SnapshotError(`Copy did not preserve the payload: ${drift.join('; ')}`);
    const full = SnapshotManifest.parse({ formatVersion: 1, ...manifest, files });
    await writeFile(path.join(temp, MANIFEST_FILE), `${JSON.stringify(full, null, 2)}\n`, { flag: 'wx' });
    if (await exists(target)) throw new SnapshotError(`A snapshot for ${manifest.scenarioId} appeared while writing; not overwriting it.`);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return loadSnapshot(manifest.scenarioId, snapshotsRoot);
}

/** Loads and fully verifies a snapshot: manifest schema, every hash and mtime, the report fingerprint. */
export async function loadSnapshot(id: string, snapshotsRoot: string = SNAPSHOTS_DIR): Promise<LoadedSnapshot> {
  const dir = path.join(snapshotsRoot, ScenarioId.parse(id));
  const filesDir = path.join(dir, FILES_DIR);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch (error) {
    throw new SnapshotError(`No readable snapshot manifest for ${id} at ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = SnapshotManifest.safeParse(raw);
  if (!parsed.success) throw new SnapshotError(`Snapshot manifest for ${id} is invalid:\n${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;
  if (manifest.scenarioId !== id) throw new SnapshotError(`Snapshot in ${dir} belongs to ${manifest.scenarioId}, not ${id}.`);
  await verifyFiles(filesDir, manifest);
  return { manifest, dir, filesDir };
}

/**
 * Copies a snapshot's payload to `dest` (which must not exist), preserving timestamps, and
 * re-verifies the copy. The report's absolute paths stay as generated; the MCP server resolves
 * them relative to the report's own root, so the copy works from any location.
 */
export async function copySnapshotFiles(snapshot: LoadedSnapshot, dest: string): Promise<void> {
  if (await exists(dest)) throw new SnapshotError(`Destination ${dest} already exists; refusing to copy over it.`);
  await cp(snapshot.filesDir, dest, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  await verifyFiles(dest, snapshot.manifest);
}

async function verifyFiles(dir: string, manifest: SnapshotManifest): Promise<void> {
  let actual: FileEntry[];
  try {
    actual = await hashTree(dir);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(`Cannot read snapshot files in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problems = compareFiles(manifest.files, actual, { checkMtime: true });
  if (problems.length > 0) throw new SnapshotError(`Snapshot ${manifest.scenarioId} failed verification: ${problems.join('; ')}`);
  const report = await loadReport(dir).catch((error: unknown) => {
    throw new SnapshotError(`Snapshot ${manifest.scenarioId} report is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (report.fingerprint !== manifest.reportFingerprint) {
    throw new SnapshotError(`Snapshot ${manifest.scenarioId} report fingerprint is ${report.fingerprint}, manifest says ${manifest.reportFingerprint}.`);
  }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}
