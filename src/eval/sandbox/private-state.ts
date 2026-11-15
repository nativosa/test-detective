import { createHash } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './config.ts';

// R4b Step 1D.2B: the developer's private state files (%LOCALAPPDATA%\test-detective): the shadow-copy
// inventories and the pending account check. Fixed names only (config.ts), no destination parameter.
// The folder must be reached by its own canonical spelling (no link, no 8.3 alias, no junction above
// it), and every file must be a plain file with one name (no link, no second hard link). Messages name
// the files relative to %LOCALAPPDATA%, never by the developer's profile path. Only Node built-ins and
// config.ts: shadow-record.ts runs this elevated.

export const shownPath = (file: string): string => `%LOCALAPPDATA%\\test-detective\\${path.win32.basename(file)}`;

export const sha256Json = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Checks the state folder and the given files; throws on anything unexpected. Returns false when the
 * folder does not exist (and `create` is false), true otherwise.
 */
export async function checkPrivatePaths(localAppData: string, files: string[], options: { create: boolean }): Promise<boolean> {
  const base = localAppData.replace(/\\+$/, '');
  if (!/^[A-Za-z]:\\[^\\]/.test(base) || path.win32.normalize(base) !== base) throw new Error('LOCALAPPDATA is not a plain absolute drive path.');
  const dir = stateDir(base);
  let stat = await lstat(dir).catch((error: unknown) => (isMissing(error) ? null : Promise.reject(error)));
  if (!stat) {
    if (!options.create) return false;
    await mkdir(dir);
    stat = await lstat(dir);
  }
  if (stat.isSymbolicLink()) throw new Error(`${shownPath(dir)} is a link; refusing to use it.`);
  if (!stat.isDirectory()) throw new Error(`${shownPath(dir)} is not a folder.`);
  if ((await realpath(dir)).toLowerCase() !== dir.toLowerCase()) throw new Error('The private state folder is reached through another spelling (an alias or a link above it); refusing to use it.');
  for (const file of files) {
    if (path.win32.dirname(file).toLowerCase() !== dir.toLowerCase()) throw new Error(`${shownPath(file)} is not directly in the private state folder.`);
    const f = await lstat(file).catch((error: unknown) => (isMissing(error) ? null : Promise.reject(error)));
    if (!f) continue;
    if (f.isSymbolicLink()) throw new Error(`${shownPath(file)} is a link; refusing to use it.`);
    if (!f.isFile()) throw new Error(`${shownPath(file)} is not a plain file.`);
    if (f.nlink > 1) throw new Error(`${shownPath(file)} has another name (a hard link); refusing to use it.`);
  }
  return true;
}

/** One JSON file of the state folder: its value, `missing`, or a problem (link, alias, not a plain file, not JSON); never a partial value. */
export async function readPrivateJson(localAppData: string, file: string): Promise<{ value: unknown } | { missing: true } | { problem: string }> {
  try {
    if (!(await checkPrivatePaths(localAppData, [file], { create: false }))) return { missing: true };
    const text = await readFile(file, 'utf8').catch((error: unknown) => (isMissing(error) ? null : Promise.reject(error)));
    if (text === null) return { missing: true };
    return { value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (error) {
    return { problem: error instanceof SyntaxError ? `${shownPath(file)} is not JSON` : error instanceof Error ? error.message : String(error) };
  }
}

/** Writes through `<file>.tmp` and renames over the file, so a reader sees the old or the new content, never a partial one. */
export async function writePrivateJson(localAppData: string, file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await checkPrivatePaths(localAppData, [file, tmp], { create: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

/**
 * Like writePrivateJson, but never replaces an existing file: the complete temp file gets the final
 * name through a hard link, which fails if the name exists. Throws `EEXIST` in that case.
 */
export async function createPrivateJson(localAppData: string, file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await checkPrivatePaths(localAppData, [file, tmp], { create: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await link(tmp, file);
  } finally {
    await unlink(tmp);
  }
}

/**
 * Recovers from a createPrivateJson interrupted between `link` and `unlink`: the temp name is then the
 * file's second hard link, and every check refuses the file. Removes `<file>.tmp` only when it is
 * exactly that (same volume and file ID, two names, both plain files); true when it did.
 */
export async function dropInterruptedCreate(localAppData: string, file: string): Promise<boolean> {
  if (!(await checkPrivatePaths(localAppData, [], { create: false }))) return false;
  const tmp = `${file}.tmp`;
  const [a, b] = await Promise.all([file, tmp].map((p) => lstat(p, { bigint: true }).catch((error: unknown) => (isMissing(error) ? null : Promise.reject(error)))));
  if (!a || !b || !a.isFile() || !b.isFile() || a.nlink !== 2n || b.nlink !== 2n || a.dev !== b.dev || a.ino !== b.ino || a.ino === 0n) return false;
  await unlink(tmp);
  return true;
}

/** Removes one state file after the same checks; false when it was not there. */
export async function removePrivateFile(localAppData: string, file: string): Promise<boolean> {
  if (!(await checkPrivatePaths(localAppData, [file], { create: false }))) return false;
  return unlink(file).then(() => true, (error: unknown) => (isMissing(error) ? false : Promise.reject(error)));
}
