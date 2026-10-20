import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

// A fake PNG: real signature bytes, so a leaked base64 copy would be easy to spot.
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);

export async function readFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, `${name}.json`), 'utf8');
}

type RepoOptions = {
  /** Fixture name, or raw report text. Omit to create a repo without a report. */
  fixture?: string;
  raw?: string;
  /** Repo-relative files to create (e.g. attachments). */
  files?: Record<string, string | Buffer>;
};

/** Builds a throwaway repo in the OS temp dir. Removed automatically when the test ends. */
export async function makeRepo(t: TestContext, options: RepoOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'td-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = options.raw ?? (options.fixture ? await readFixture(options.fixture) : undefined);
  if (report !== undefined) await put(root, 'artifacts/results.json', report);
  for (const [file, content] of Object.entries(options.files ?? {})) await put(root, file, content);
  return root;
}

export async function put(root: string, file: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, ...file.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** Path, size and mtime of every file and directory under root, for "nothing was written" checks. */
export async function snapshotTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const info = await stat(full);
      out.push(`${path.relative(root, full)}|${info.size}|${info.mtimeMs}`);
      if (entry.isDirectory()) await walk(full);
    }
  };
  out.push(`.|${(await stat(root)).mtimeMs}`);
  await walk(root);
  return out.sort();
}
