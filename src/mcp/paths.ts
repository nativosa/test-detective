import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

// Paths in a Playwright report are absolute paths from the machine that ran the tests
// (Windows `C:\...` locally, POSIX `/...` on Linux CI). We never trust them as-is: each one is
// re-expressed relative to the report's own root and then resolved under *our* repo root.

export type PathResolution =
  | { kind: 'repo'; relative: string }
  | { kind: 'outside-repo' }
  | { kind: 'invalid'; reason: string };

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC = /^(\\\\|\/\/)/;
const CONTROL_CHARS = /[\u0000-\u001f]/;

function flavorOf(p: string): 'win32' | 'posix' | 'relative' {
  if (WINDOWS_ABSOLUTE.test(p)) return 'win32';
  if (p.startsWith('/')) return 'posix';
  return 'relative';
}

/**
 * Maps a path recorded in the report to a repo-relative POSIX path, without touching the disk.
 * `reportRoot` is the directory of the config file that produced the report (absolute, in the
 * report machine's own path flavor), or undefined if the report doesn't say.
 */
export function toRepoRelative(rawPath: unknown, reportRoot: string | undefined): PathResolution {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return { kind: 'invalid', reason: 'empty or not a string' };
  if (rawPath.length > 1024) return { kind: 'invalid', reason: 'path too long' };
  if (CONTROL_CHARS.test(rawPath)) return { kind: 'invalid', reason: 'contains control characters' };
  if (UNC.test(rawPath)) return { kind: 'invalid', reason: 'network (UNC) paths are not allowed' };
  if (/^[A-Za-z]:(?![\\/])/.test(rawPath)) return { kind: 'invalid', reason: 'drive-relative Windows path' };

  let relative: string;
  const flavor = flavorOf(rawPath);
  if (flavor === 'relative') {
    relative = rawPath;
  } else {
    if (!reportRoot || flavorOf(reportRoot) !== flavor) return { kind: 'outside-repo' };
    // path.win32.relative compares case-insensitively, matching Windows semantics.
    relative = path[flavor].relative(reportRoot, rawPath);
    if (path[flavor].isAbsolute(relative)) return { kind: 'outside-repo' };
  }

  const segments = relative.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return { kind: 'outside-repo' };
  if (segments.some((s) => s.includes(':'))) return { kind: 'invalid', reason: 'unexpected ":" in path segment' };
  const posix = segments.join('/');
  return { kind: 'repo', relative: posix };
}

/** True when `child` is `parent` or inside it (both absolute, same platform). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export type FileCheck =
  | { exists: true; sizeBytes: number }
  | { exists: false }
  | { exists: null; issue: string };

/**
 * Checks a repo-relative path on disk using only stat/realpath (never reads contents).
 * Symlinks are resolved so a link inside the repo pointing outside it is refused.
 */
export async function checkFile(repoRoot: string, relative: string): Promise<FileCheck> {
  const candidate = path.resolve(repoRoot, ...relative.split('/'));
  if (!isInside(repoRoot, candidate)) return { exists: null, issue: 'resolves outside the repository' };
  let real: string;
  let realRoot: string;
  try {
    realRoot = await realpath(repoRoot);
    real = await realpath(candidate);
  } catch (error) {
    if (isNotFound(error)) return { exists: false };
    return { exists: null, issue: 'could not be checked' };
  }
  if (!isInside(realRoot, real)) return { exists: null, issue: 'symlink resolves outside the repository' };
  try {
    const info = await stat(real);
    if (!info.isFile()) return { exists: null, issue: 'not a regular file' };
    return { exists: true, sizeBytes: info.size };
  } catch (error) {
    if (isNotFound(error)) return { exists: false };
    return { exists: null, issue: 'could not be checked' };
  }
}

export function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
