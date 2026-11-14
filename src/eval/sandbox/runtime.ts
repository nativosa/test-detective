import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILES } from '../workspace.ts';
import { runtimeDir } from './config.ts';
import type { SandboxConfig } from './config.ts';

// R4b Step 1D: the runtime copy the evaluation account may read (staged into <sandbox>\runtime by a
// later step). It holds only what the untrusted side runs: the Claude Code binary, the read-only
// MCP server with its dependency closure, the sandbox scripts and the approved workspace
// configuration (Skill and project settings). Everything comes from an explicit allowlist, every
// path is checked against a deny list, every file is scanned for canaries, and the result is a
// SHA-256 manifest that staging and verification compare byte for byte.

export const RUNTIME_MANIFEST = 'runtime-manifest.json';
/** The MCP server's runtime dependencies (package.json "dependencies" minus the SDK, which the host keeps). */
export const MCP_DEPENDENCIES = ['@modelcontextprotocol/server', 'yauzl', 'zod'] as const;
export const CLAUDE_PACKAGE = '@anthropic-ai/claude-agent-sdk-win32-x64';
const CANARY_PREFIX = Buffer.from('TDCANARY-');

/** Repo paths that may never enter the runtime, whatever the allowlist says. */
const FORBIDDEN: [RegExp, string][] = [
  [/^src\/eval(\/|$)/, 'evaluation code'],
  [/^evals(\/|$)/, 'evaluation data'],
  [/^(src\/[^/]+\/)?test(\/|$)/, 'tests'],
  [/^(artifacts|test-results|playwright-report|blob-report)(\/|$)/, 'root artifacts'],
  [/^\.work(\/|$)/, 'generation stages'],
  [/^\.git(\/|$)/, 'git metadata'],
  [/(^|\/)(truth|generation)\.json$/, 'ground truth or generation config'],
  [/(^|\/)(score|review|outcome|result|summary)\.json$/, 'saved evaluation results'],
  [/(^|\/)transcript\.jsonl$/, 'transcripts'],
  [/(^|\/)\.credentials\.json$|(^|\/)\.claude\.json$/, 'Claude credentials or state'],
  [/(^|\/)settings\.local\.json$/, 'local settings'],
  [/(^|\/)\.env(\.|$)/, 'environment files'],
  [/\.(pem|key|pfx|p12)$/i, 'key material'],
  [/(^|\/)runs(\/|$)|(^|\/)snapshots(\/|$)/, 'saved runs or snapshots'],
];

/** Why a repo-relative path may not enter the runtime, or null. The approved config files are the only `.claude` entries allowed. */
export function forbiddenReason(repoPath: string): string | null {
  const p = repoPath.replaceAll('\\', '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) return 'not a repo-relative path';
  if (p.startsWith('.claude/') && !(CONFIG_FILES as readonly string[]).includes(p)) return 'unapproved .claude file';
  for (const [pattern, reason] of FORBIDDEN) if (pattern.test(p)) return reason;
  return null;
}

export type RuntimeSource = { runtimePath: string; repoPath: string } | { runtimePath: string; generated: string };
export type RuntimeFile = { path: string; source: string; size: number; sha256: string };
export type RuntimeManifest = { schema: 1; claudeVersion: string; packageLockSha256: string; files: RuntimeFile[] };

type LockPackage = { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
type Lock = { packages: Record<string, LockPackage> };

/** The installed folder for `name` as Node resolves it from `from` (a lock key like node_modules/a). */
function resolveLockKey(lock: Lock, from: string, name: string): string | null {
  for (let base = from; ; ) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (lock.packages[key]) return key;
    if (!base) return null;
    const at = base.lastIndexOf('node_modules/');
    base = at <= 0 ? '' : base.slice(0, at - 1);
  }
}

/** Every lock key the given dependencies need, transitively (dependencies, optional and peer dependencies that are installed). */
export function dependencyClosure(lock: Lock, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const pkg = lock.packages[key]!;
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      const dep = resolveLockKey(lock, key, name);
      if (dep) visit(dep);
      else if (pkg.dependencies?.[name]) throw new Error(`${key} needs ${name}, which is not installed.`);
    }
  };
  for (const name of roots) {
    const key = resolveLockKey(lock, '', name);
    if (!key) throw new Error(`${name} is not installed.`);
    visit(key);
  }
  return [...seen].sort();
}

/** Regular files under root/rel (POSIX-style relative paths); refuses links. `skipNested` leaves out nested node_modules (those come from the lock closure). */
async function walk(root: string, rel: string, out: string[], skipNested = false): Promise<void> {
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    const info = await lstat(path.join(root, child));
    if (info.isSymbolicLink()) throw new Error(`${child} is a link; the runtime takes regular files only.`);
    if (info.isDirectory()) {
      if (skipNested && entry.name === 'node_modules' && rel.includes('node_modules')) continue;
      await walk(root, child, out, skipNested);
    } else if (info.isFile()) out.push(child);
    else throw new Error(`${child} is not a regular file.`);
  }
}

/** The generated package.json: only what Node needs to treat the MCP server's .ts files as ES modules. */
export const RUNTIME_PACKAGE_JSON = `${JSON.stringify({ name: 'test-detective-eval-runtime', private: true, type: 'module' }, null, 2)}\n`;

/**
 * Every file the runtime will hold, from the allowlist only. Throws if any source is forbidden,
 * a link or not a regular file. Reads directory listings and package-lock.json, nothing else.
 */
export async function runtimeSources(repoRoot: string): Promise<RuntimeSource[]> {
  const lock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8')) as Lock;
  const sources: RuntimeSource[] = [{ runtimePath: 'app/package.json', generated: RUNTIME_PACKAGE_JSON }];
  const add = (repoPath: string, runtimePath: string) => sources.push({ repoPath, runtimePath });

  for (const name of (await readdir(path.join(repoRoot, 'src', 'mcp'), { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.ts')).map((e) => e.name).sort()) {
    add(`src/mcp/${name}`, `app/src/mcp/${name}`);
  }
  for (const key of dependencyClosure(lock, MCP_DEPENDENCIES)) {
    const files: string[] = [];
    await walk(repoRoot, key, files, true);
    for (const f of files) add(f, `app/${f}`);
  }
  const claudeKey = resolveLockKey(lock, '', CLAUDE_PACKAGE);
  if (!claudeKey) throw new Error(`${CLAUDE_PACKAGE} is not installed.`);
  for (const f of ['claude.exe', 'package.json', 'LICENSE.md', 'README.md']) add(`${claudeKey}/${f}`, `claude/${f}`);
  for (const f of ['stage2.mjs', 'probe.mjs', 'teardown.mjs']) add(`scripts/eval-sandbox/runtime/${f}`, `bin/${f}`);
  for (const f of CONFIG_FILES) add(f, `config/${f}`);

  for (const s of sources) {
    if (!('repoPath' in s)) continue;
    const reason = forbiddenReason(s.repoPath);
    if (reason) throw new Error(`Refusing ${s.repoPath} in the runtime: ${reason}.`);
    const info = await lstat(path.join(repoRoot, s.repoPath));
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${s.repoPath} is not a regular file.`);
  }
  const seen = new Set<string>();
  for (const s of sources) {
    if (seen.has(s.runtimePath.toLowerCase())) throw new Error(`Duplicate runtime path ${s.runtimePath}.`);
    seen.add(s.runtimePath.toLowerCase());
  }
  return sources;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function contents(repoRoot: string, source: RuntimeSource): Promise<Buffer> {
  const data = 'generated' in source ? Buffer.from(source.generated, 'utf8') : await readFile(path.join(repoRoot, source.repoPath));
  if (data.includes(CANARY_PREFIX)) throw new Error(`${source.runtimePath} contains a scenario canary; refusing.`);
  return data;
}

/** Hashes every allowlisted file (and refuses any that carries a canary). */
export async function buildRuntimeManifest(repoRoot: string): Promise<RuntimeManifest> {
  const sources = await runtimeSources(repoRoot);
  const files: RuntimeFile[] = [];
  for (const source of sources) {
    const data = await contents(repoRoot, source);
    files.push({ path: source.runtimePath, source: 'generated' in source ? 'generated' : source.repoPath, size: data.length, sha256: sha256(data) });
  }
  const claude = JSON.parse(await readFile(path.join(repoRoot, 'node_modules', ...CLAUDE_PACKAGE.split('/'), 'package.json'), 'utf8')) as { version: string };
  return { schema: 1, claudeVersion: claude.version, packageLockSha256: sha256(await readFile(path.join(repoRoot, 'package-lock.json'))), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export const manifestSha256 = (manifest: RuntimeManifest): string => sha256(JSON.stringify(manifest));

/**
 * The path as Windows resolves it: the nearest existing ancestor through realpath (which expands 8.3
 * names and follows junctions and symlinks), plus the parts that don't exist yet.
 */
export async function resolveExisting(p: string): Promise<string> {
  const missing: string[] = [];
  for (let current = path.resolve(p); ; ) {
    try {
      // fs/promises realpath has fs.realpath.native semantics (GetFinalPathNameByHandle on Windows).
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Whether `child` is `parent` or inside it after resolving both, so an alias can't make a path inside look outside (case-insensitive on Windows). */
export async function resolvesInside(parent: string, child: string): Promise<boolean> {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(await resolveExisting(parent)), norm(await resolveExisting(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Copies the manifest's files into an empty `dest` outside the repo and verifies each copy. The
 * repo check resolves both paths first, so an 8.3 name, a junction or a symlink that leads back into
 * the repo is refused. The CLI only stages into the configured runtime folder (stageSandboxRuntime);
 * tests stage into temp folders.
 */
export async function stageRuntime(repoRoot: string, manifest: RuntimeManifest, dest: string): Promise<void> {
  if (await resolvesInside(repoRoot, dest)) throw new Error('The runtime must be staged outside the repo.');
  await mkdir(dest, { recursive: true });
  if ((await lstat(dest)).isSymbolicLink()) throw new Error(`${dest} is a link.`);
  if ((await readdir(dest)).length > 0) throw new Error(`${dest} is not empty.`);
  const sources = new Map((await runtimeSources(repoRoot)).map((s) => [s.runtimePath, s]));
  for (const file of manifest.files) {
    const source = sources.get(file.path);
    if (!source) throw new Error(`${file.path} is not in the allowlist.`);
    const target = path.join(dest, ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    if ('generated' in source) await writeFile(target, source.generated, { flag: 'wx' });
    else await copyFile(path.join(repoRoot, source.repoPath), target);
  }
  await writeFile(path.join(dest, RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const problems = await verifyRuntime(dest, manifest);
  if (problems.length > 0) throw new Error(`Staged runtime does not match its manifest: ${problems.join('; ')}`);
}

/**
 * Stages into the sandbox's runtime folder only. Setup (-Apply) creates that folder with its
 * protected ACL, so it must already exist, be a real folder (no link) and be empty; staging never
 * creates it, so the copy can't end up with inherited permissions. setup.ps1 -Verify then checks
 * the ACLs of everything inside it.
 */
export async function stageSandboxRuntime(repoRoot: string, manifest: RuntimeManifest, config: SandboxConfig): Promise<string> {
  const dest = runtimeDir(config);
  let info;
  try {
    info = await lstat(dest);
  } catch {
    throw new Error(`${dest} does not exist; it is created by setup.ps1 -Apply with its protected ACL.`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dest} is not a plain folder.`);
  if ((await resolveExisting(dest)).toLowerCase() !== path.win32.resolve(dest).toLowerCase()) throw new Error(`${dest} resolves elsewhere.`);
  await stageRuntime(repoRoot, manifest, dest);
  return dest;
}

/**
 * Checks a staged runtime against a manifest built now from the repo (never only against the
 * manifest stored beside the copy): a copy staged from an older or changed repo state is stale, and
 * every file must match the trusted hashes.
 */
export async function verifyStagedRuntime(repoRoot: string, runtime: string): Promise<{ trusted: RuntimeManifest; problems: string[] }> {
  const trusted = await buildRuntimeManifest(repoRoot);
  const problems: string[] = [];
  let staged: RuntimeManifest | null = null;
  try {
    staged = JSON.parse(await readFile(path.join(runtime, RUNTIME_MANIFEST), 'utf8')) as RuntimeManifest;
  } catch {
    problems.push('the staged manifest is missing or unreadable');
  }
  if (staged && manifestSha256(staged) !== manifestSha256(trusted)) {
    const want = new Map(trusted.files.map((f) => [f.path, f.sha256]));
    const differing = staged.files?.filter((f) => want.get(f.path) !== f.sha256).map((f) => f.path) ?? [];
    problems.push(`stale: the staged manifest differs from the repo's (${differing.length} files differ${differing.length > 0 ? `, e.g. ${differing.slice(0, 3).join(', ')}` : ''})`);
  }
  problems.push(...(await verifyRuntime(runtime, trusted)));
  return { trusted, problems };
}

/** Every difference between a staged runtime and the manifest: missing, changed or extra files, links. */
export async function verifyRuntime(dest: string, manifest: RuntimeManifest): Promise<string[]> {
  const problems: string[] = [];
  const present: string[] = [];
  try {
    await walk(dest, '', present);
  } catch (error) {
    return [(error as Error).message];
  }
  const expected = new Map(manifest.files.map((f) => [f.path, f]));
  for (const p of present) if (p !== RUNTIME_MANIFEST && !expected.has(p)) problems.push(`extra file ${p}`);
  for (const file of manifest.files) {
    if (!present.includes(file.path)) {
      problems.push(`missing ${file.path}`);
      continue;
    }
    if (sha256(await readFile(path.join(dest, ...file.path.split('/')))) !== file.sha256) problems.push(`changed ${file.path}`);
  }
  return problems;
}
