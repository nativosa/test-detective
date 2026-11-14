import { realpathSync } from 'node:fs';
import { cp, lstat, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { compareFiles, copySnapshotFiles, hashTree, sha256 } from './snapshots.ts';
import type { FileEntry, LoadedSnapshot } from './snapshots.ts';

// Investigation workspaces: one fresh, neutral-named directory per run, outside the repo, holding
// only what a real investigation needs. This is a leakage MITIGATION, not a sandbox: the agent's
// tools can still reach absolute paths elsewhere on the machine. See isolation.ts for detection.
//
//   <tmpdir>/ws-XXXXXX/project/            session cwd
//     playwright.config.ts, tests/, artifacts/results.json, test-results/   (from the snapshot)
//     .claude/skills/investigate-failure/SKILL.md, .claude/settings.json      (from the repo, byte copies)

export const WORKSPACE_PREFIX = 'ws-';
export const WORKSPACE_DIR = 'project';
/** Copied from the repo into every workspace, byte for byte. Nothing else from the repo is. */
export const CONFIG_FILES = ['.claude/skills/investigate-failure/SKILL.md', '.claude/settings.json'] as const;

/** Payload path shapes a workspace may contain, in addition to CONFIG_FILES. */
const PAYLOAD_PATTERNS = [/^playwright\.config\.ts$/, /^tests\/[a-z0-9/-]+\.spec\.ts$/, /^artifacts\/results\.json$/, /^test-results\/.+$/];
/** Names that must never appear as a path segment in a workspace. */
const FORBIDDEN_SEGMENTS = new Set(['truth.json', 'generation.json', 'manifest.json', 'evals', 'snapshots', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', 'settings.local.json']);
/** Instruction files Claude Code would load from the cwd's ancestors. */
const ANCESTOR_INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md'];

export type Workspace = {
  /** The mkdtemp directory; removing it removes everything. */
  container: string;
  /** The session cwd. */
  root: string;
  /** Host-side bookkeeping only; never written into the workspace. */
  scenarioId: string;
  reportFingerprint: string;
  /** Expected contents: the snapshot payload plus CONFIG_FILES. */
  files: FileEntry[];
  configFiles: { path: string; sha256: string }[];
  protectedRoots: string[];
};

export type WorkspaceOptions = {
  repoRoot: string;
  /** Where to create the container. Default os.tmpdir(). Tests pass their own temp dir. */
  parent?: string;
  /** Paths the workspace must not be inside of. Default: the repo and ~/.claude. */
  protectedRoots?: string[];
};

/** Strings whose presence anywhere in a workspace means ground truth or eval data leaked. */
export type LeakMarkers = { canaries: string[]; strings: string[] };

export type AuditResult = { ok: boolean; problems: string[]; notes: string[] };

/**
 * The paths a workspace must stay out of and an evaluation session must not read:
 * - the repo, as given and as spelled on disk (Windows paths are case-insensitive, and Node keeps
 *   the casing of the cwd it was started from, so both C:\git\x and C:\GIT\x occur);
 * - ~/.claude (memory, plans and transcripts of earlier sessions);
 * - Claude Code's temporary folders of sessions in this repo, <tmpdir>/claude/<project slug>: their
 *   scratchpads and tool outputs held copies of truth files and saved scores (R4b). Only this repo's
 *   slugs are protected; an evaluation session's own folder there (named after its workspace) is not.
 *   The folder is named after the cwd a session was started from, so an existing one is also
 *   protected under its on-disk spelling (C--git-… is found from C:\GIT\… as well).
 */
export function defaultProtectedRoots(repoRoot: string): string[] {
  const spellings = [...new Set([path.resolve(repoRoot), onDisk(repoRoot)])];
  const sessionTemp = spellings.flatMap((s) => {
    const folder = path.join(tmpdir(), 'claude', projectSlug(s));
    return [folder, onDisk(folder)];
  });
  return [...new Set([...spellings, path.join(homedir(), '.claude'), ...sessionTemp])];
}

/** Claude Code's folder name for a project path: every character other than a letter or digit becomes "-". */
export function projectSlug(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** The path as spelled on disk (realpath.native), or as resolved when it doesn't exist. */
function onDisk(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Full Windows short (8.3) paths for absolute drive paths, in order: null for a path that doesn't
 * exist, the path itself where no component has a short name. Throws when the lookup fails.
 */
export type ShortPathLookup = (paths: string[]) => Promise<(string | null)[]>;

/** Spellings allowed per protected root; each component with a short name doubles them. More fails closed. */
export const MAX_ROOT_SPELLINGS = 64;

const DRIVE_PATH = /^([A-Za-z]:)\\(.*)$/;
/** An 8.3 name as Windows generates it: no spaces, dots or path characters in the base name. */
const SHORT_NAME = /^[A-Za-z0-9!#$%&'()@^_`{}~-]{1,8}(\.[A-Za-z0-9!#$%&'()@^_`{}~-]{1,3})?$/;

/**
 * The protected roots plus every 8.3 spelling of them (R4b). A Read through a short name
 * (C:\GIT\TEST-D~1\…) bypassed deny rules spelled with long names in the first live probe. Any
 * component with a short name can be spelled either way, ancestors included, so each root gets all
 * long/short combinations of its components, looked up once at setup. The lookup runs in the live
 * adapter; this function only validates and combines its answers. Fails closed (throws) on a
 * malformed answer or more than MAX_ROOT_SPELLINGS spellings for one root.
 *
 * Covered: short names that exist at setup. Not covered (no finite list): junctions such as
 * "Local Settings" or "Application Data", symlinks, UNC and \\?\ / \\.\ device paths, and short
 * names created after setup, including that of a root that doesn't exist yet (its existing
 * ancestors' short names are still covered).
 */
export async function withShortNameAliases(roots: string[], lookup: ShortPathLookup): Promise<string[]> {
  const parsed = roots.flatMap((root) => {
    const match = DRIVE_PATH.exec(path.win32.normalize(root));
    const parts = match ? match[2]!.split('\\').filter(Boolean) : [];
    return match && parts.length > 0 ? [{ drive: match[1]!.toUpperCase(), parts }] : [];
  });
  const prefixes = [...new Set(parsed.flatMap(({ drive, parts }) => parts.map((_, i) => [drive, ...parts.slice(0, i + 1)].join('\\'))))];
  const answers = prefixes.length === 0 ? [] : await lookup(prefixes);
  if (!Array.isArray(answers) || answers.length !== prefixes.length) throw new Error(`Short path lookup returned ${Array.isArray(answers) ? answers.length : typeof answers} answer(s) for ${prefixes.length} path(s).`);
  const shortOf = new Map<string, string | null>();
  prefixes.forEach((prefix, i) => shortOf.set(prefix, checkedShortPath(prefix, answers[i])));

  const seen = new Set(roots.map((r) => path.win32.normalize(r).toLowerCase()));
  const aliases: string[] = [];
  for (const { drive, parts } of parsed) {
    let spellings = [drive];
    let previousShort: string | null = drive;
    for (let i = 0; i < parts.length; i++) {
      const short = shortOf.get([drive, ...parts.slice(0, i + 1)].join('\\')) ?? null;
      // Each answer must extend the previous one by exactly one component.
      if (short !== null && (previousShort === null || short.slice(0, previousShort.length + 1).toLowerCase() !== `${previousShort}\\`.toLowerCase())) {
        throw new Error(`Short path lookup returned an inconsistent answer for ${[drive, ...parts.slice(0, i + 1)].join('\\')}.`);
      }
      const names = [parts[i]!];
      if (short !== null && path.win32.basename(short).toLowerCase() !== parts[i]!.toLowerCase()) names.push(path.win32.basename(short));
      spellings = spellings.flatMap((s) => names.map((n) => `${s}\\${n}`));
      if (spellings.length > MAX_ROOT_SPELLINGS) throw new Error(`More than ${MAX_ROOT_SPELLINGS} short-name spellings of ${[drive, ...parts].join('\\')}; refusing to start.`);
      previousShort = short;
    }
    for (const s of spellings) {
      if (seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      aliases.push(s);
    }
  }
  return [...roots, ...aliases];
}

/** One lookup answer, validated: same drive and depth, every differing component a valid 8.3 name. */
function checkedShortPath(longPath: string, answer: unknown): string | null {
  if (answer === null) return null;
  const fail = () => new Error(`Short path lookup returned an invalid answer for ${longPath}.`);
  if (typeof answer !== 'string') throw fail();
  const match = DRIVE_PATH.exec(answer);
  const long = DRIVE_PATH.exec(longPath)!;
  if (!match || match[1]!.toUpperCase() !== long[1]!.toUpperCase()) throw fail();
  const shortParts = match[2]!.split('\\');
  const longParts = long[2]!.split('\\');
  if (shortParts.length !== longParts.length) throw fail();
  shortParts.forEach((s, i) => {
    if (s.toLowerCase() !== longParts[i]!.toLowerCase() && !SHORT_NAME.test(s)) throw fail();
  });
  return `${match[1]!.toUpperCase()}\\${match[2]}`;
}

/**
 * Materializes a verified snapshot as a fresh workspace and checks it before returning.
 * Fails closed: any problem removes the container and throws.
 */
export async function createWorkspace(snapshot: LoadedSnapshot, options: WorkspaceOptions, markers: LeakMarkers): Promise<Workspace> {
  const protectedRoots = options.protectedRoots ?? defaultProtectedRoots(options.repoRoot);
  const container = await mkdtemp(path.join(options.parent ?? tmpdir(), WORKSPACE_PREFIX));
  try {
    const inside = await insideAny(container, protectedRoots);
    if (inside) throw new Error(`Workspace container ${container} is inside protected path ${inside}.`);
    const root = path.join(container, WORKSPACE_DIR);
    // Re-verifies every hash and mtime of the copy against the snapshot manifest.
    await copySnapshotFiles(snapshot, root);
    const payload = new Set(snapshot.manifest.files.map((f) => f.path));
    const configFiles: Workspace['configFiles'] = [];
    for (const rel of CONFIG_FILES) {
      if (payload.has(rel)) throw new Error(`Snapshot payload already contains ${rel}.`);
      const source = path.join(options.repoRoot, ...rel.split('/'));
      const info = await lstat(source);
      if (!info.isFile()) throw new Error(`${rel} in the repo is not a regular file.`);
      await cp(source, path.join(root, ...rel.split('/')), { preserveTimestamps: true, errorOnExist: true, force: false });
    }
    const files = await hashTree(root);
    for (const rel of CONFIG_FILES) {
      const entry = files.find((f) => f.path === rel);
      const original = sha256(await readFile(path.join(options.repoRoot, ...rel.split('/'))));
      if (entry?.sha256 !== original) throw new Error(`${rel} copy differs from the repo.`);
      configFiles.push({ path: rel, sha256: original });
    }
    const expected = [...snapshot.manifest.files, ...files.filter((f) => (CONFIG_FILES as readonly string[]).includes(f.path))];
    const drift = compareFiles(sortEntries(expected), files, { checkMtime: true });
    if (drift.length > 0) throw new Error(`Workspace does not match snapshot plus config: ${drift.join('; ')}`);

    const workspace: Workspace = {
      container,
      root,
      scenarioId: snapshot.manifest.scenarioId,
      reportFingerprint: snapshot.manifest.reportFingerprint,
      files,
      configFiles,
      protectedRoots,
    };
    const audit = await auditWorkspace(workspace, markers);
    if (!audit.ok) throw new Error(`Workspace audit failed: ${audit.problems.join('; ')}`);
    return workspace;
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Offline workspace checks: location, symlinks and special files, unexpected or forbidden paths,
 * tampering (hash, size, mtime), leak markers in file bytes, and instruction files in ancestors.
 * Compressed archives (trace.zip) are scanned as raw bytes only, so their contents are not inspected.
 */
export async function auditWorkspace(workspace: Workspace, markers: LeakMarkers): Promise<AuditResult> {
  const problems: string[] = [];
  const notes: string[] = [];

  const inside = await insideAny(workspace.root, workspace.protectedRoots);
  if (inside) problems.push(`workspace is inside protected path ${inside}`);

  let actual: FileEntry[] = [];
  try {
    actual = await hashTree(workspace.root);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  problems.push(...compareFiles(workspace.files, actual, { checkMtime: true }).map((p) => `tampering: ${p}`));

  for (const { path: rel } of actual) {
    const segments = rel.split('/');
    const forbidden = segments.find((s) => FORBIDDEN_SEGMENTS.has(s) || /^S\d{2}$/.test(s));
    if (forbidden) problems.push(`forbidden path segment "${forbidden}": ${rel}`);
    const allowed = (CONFIG_FILES as readonly string[]).includes(rel) || PAYLOAD_PATTERNS.some((p) => p.test(rel));
    if (!allowed) problems.push(`unexpected file: ${rel}`);
  }

  const needles = [...markers.canaries, ...markers.strings].filter((s) => s.length > 0);
  for (const { path: rel } of actual) {
    const text = (await readFile(path.join(workspace.root, ...rel.split('/')))).toString('latin1');
    for (const needle of needles) if (text.includes(needle)) problems.push(`leak marker ${JSON.stringify(redact(needle))} in ${rel}`);
    if (/\.(ts|md|json)$/.test(rel) && /\bS\d{2}\b/.test(text)) problems.push(`scenario-ID-like token in ${rel}`);
  }

  for (const dir of ancestors(workspace.root)) {
    for (const name of ANCESTOR_INSTRUCTION_FILES) {
      if (await isFile(path.join(dir, name))) problems.push(`ancestor instruction file would be loaded: ${path.join(dir, name)}`);
    }
  }
  const siblings = (await readdir(path.dirname(workspace.container)).catch(() => [])).filter(
    (n) => n.startsWith(WORKSPACE_PREFIX) && n !== path.basename(workspace.container),
  );
  if (siblings.length > 0) notes.push(`${siblings.length} other ${WORKSPACE_PREFIX}* director(ies) next to this workspace (leftovers from other runs?)`);
  return { ok: problems.length === 0, problems, notes };
}

/** Tampering check after a session: every file unchanged (hash, size, mtime), nothing added or removed. */
export async function checkIntegrity(workspace: Workspace): Promise<string[]> {
  try {
    return compareFiles(workspace.files, await hashTree(workspace.root), { checkMtime: true });
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * How long removal may wait for the session's processes to let go of the workspace.
 *
 * On Windows a directory that is some process's cwd cannot be removed (EBUSY on its rmdir). The
 * Claude Code CLI runs with cwd = workspace root, and so does the MCP server it starts. SDK
 * 0.3.302's close() ends the CLI's stdin and returns without waiting; a CLI still running 2 s later
 * gets 5 s more on Windows, then SIGKILL. The MCP server exits on stdin EOF (src/mcp/test/stdio.test.ts).
 * So every holder should be gone within about 7 s. Anything still holding the workspace at this
 * deadline is a process leak and is reported as a cleanup failure, not waited out.
 */
export const REMOVAL_DEADLINE_MS = 10_000;
/** Errors Windows reports while a handle (or a process cwd) is still open in the tree. Anything else fails at once. */
const TRANSIENT_REMOVAL_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/** How a removal went. `transient` holds the error of every retried attempt, so retries stay visible. */
export type Removal = { attempts: number; elapsedMs: number; transient: string[] };

export type RemovalOptions = {
  deadlineMs?: number;
  /** Tests inject these. */
  rm?: (dir: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class WorkspaceRemovalError extends Error {
  readonly removal: Removal;
  constructor(message: string, removal: Removal) {
    super(message);
    this.name = 'WorkspaceRemovalError';
    this.removal = removal;
  }
}

/**
 * Removes the container. Refuses anything that doesn't look like a container this module made.
 * Retries only lock errors, with backoff, until REMOVAL_DEADLINE_MS; throws WorkspaceRemovalError
 * (with the attempt record) on any other error, at the deadline, or if the container survives.
 */
export async function removeWorkspace(workspace: Workspace, options: RemovalOptions = {}): Promise<Removal> {
  if (!path.basename(workspace.container).startsWith(WORKSPACE_PREFIX) || path.join(workspace.container, WORKSPACE_DIR) !== workspace.root) {
    throw new Error(`Refusing to remove ${workspace.container}: not a workspace container.`);
  }
  const remove = options.rm ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? REMOVAL_DEADLINE_MS;
  const start = now();
  const transient: string[] = [];
  for (let attempts = 1; ; attempts++) {
    try {
      await remove(workspace.container);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const elapsedMs = now() - start;
      const delay = Math.min(100 * 2 ** (attempts - 1), 1_000);
      if (!TRANSIENT_REMOVAL_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
        throw new WorkspaceRemovalError(text, { attempts, elapsedMs, transient });
      }
      if (elapsedMs + delay > deadlineMs) {
        throw new WorkspaceRemovalError(
          `${text} (still failing after ${attempts} attempt(s) over ${elapsedMs} ms; a process may still be using the workspace)`,
          { attempts, elapsedMs, transient },
        );
      }
      transient.push(text);
      await sleep(delay);
      continue;
    }
    const removal = { attempts, elapsedMs: now() - start, transient };
    if (await stat(workspace.container).then(() => true, () => false)) throw new WorkspaceRemovalError(`Workspace ${workspace.container} still exists after removal.`, removal);
    return removal;
  }
}

// ---------------------------------------------------------------------------

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = path.dirname(path.resolve(dir));
  while (true) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/** The first protected root that contains `p` (after resolving symlinks where possible). */
async function insideAny(p: string, roots: string[]): Promise<string | null> {
  const real = await realpath(p).catch(() => path.resolve(p));
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => path.resolve(root));
    if (isInside(realRoot, real)) return root;
  }
  return null;
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function isFile(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile(), () => false);
}

function redact(needle: string): string {
  return needle.startsWith('TDCANARY-') ? 'TDCANARY-…' : needle;
}
