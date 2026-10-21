import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { getFailureDetails, listFailures, loadReport } from '../../mcp/report.ts';
import { generateSnapshot } from '../generate.ts';
import { copySnapshotFiles, hashTree, loadSnapshot, MANIFEST_FILE, SnapshotManifest, SNAPSHOTS_DIR, writeSnapshot } from '../snapshots.ts';
import type { LoadedSnapshot } from '../snapshots.ts';
import { copyScenario, fakePlaywright, tempDir } from './helpers.ts';

// Snapshot storage: write-once, verified on every load, relocatable with timestamps intact.

async function stored(t: TestContext): Promise<{ snapshot: LoadedSnapshot; snapshotsRoot: string; base: string }> {
  const base = await tempDir(t);
  const scenariosRoot = path.join(base, 'scenarios');
  await copyScenario(scenariosRoot, 'S02');
  const snapshotsRoot = path.join(base, 'snapshots');
  const outcome = await generateSnapshot('S02', {
    repoRoot: base,
    scenariosRoot,
    snapshotsRoot,
    workRoot: path.join(base, '.work'),
    runPlaywright: fakePlaywright(),
    repoState: async () => 'unchanged',
  });
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
  return { snapshot: outcome.snapshot, snapshotsRoot, base };
}

const file = (s: LoadedSnapshot, rel: string) => path.join(s.filesDir, ...rel.split('/'));
const TRACE = 'test-results/ui-login-signs-in-chromium/trace.zip';

describe('loadSnapshot verification', () => {
  test('detects a modified file (hash mismatch)', async (t) => {
    const { snapshot, snapshotsRoot } = await stored(t);
    const target = file(snapshot, TRACE);
    const { mtime } = await stat(target);
    await writeFile(target, 'tampered!!!!!');
    await utimes(target, mtime, mtime);
    await assert.rejects(loadSnapshot('S02', snapshotsRoot), /hash mismatch: test-results\/ui-login-signs-in-chromium\/trace\.zip/);
  });

  test('detects a same-size modification', async (t) => {
    const { snapshot, snapshotsRoot } = await stored(t);
    const target = file(snapshot, 'tests/ui/login.spec.ts');
    const original = await readFile(target);
    const { mtime } = await stat(target);
    await writeFile(target, Buffer.from(original.toString('latin1').replace('Sign in', 'Sign on'), 'latin1'));
    await utimes(target, mtime, mtime);
    await assert.rejects(loadSnapshot('S02', snapshotsRoot), /hash mismatch: tests\/ui\/login\.spec\.ts/);
  });

  test('detects missing and unexpected files', async (t) => {
    const { snapshot, snapshotsRoot } = await stored(t);
    await rm(file(snapshot, TRACE));
    await writeFile(file(snapshot, 'tests/ui/extra.spec.ts'), 'x');
    await assert.rejects(loadSnapshot('S02', snapshotsRoot), (error: Error) => {
      assert.match(error.message, /missing: test-results\/ui-login-signs-in-chromium\/trace\.zip/);
      assert.match(error.message, /unexpected file: tests\/ui\/extra\.spec\.ts/);
      return true;
    });
  });

  test('detects a changed modification time (it drives source/artifact mismatch checks)', async (t) => {
    const { snapshot, snapshotsRoot } = await stored(t);
    const later = new Date(Date.now() + 60_000);
    await utimes(file(snapshot, 'tests/ui/login.spec.ts'), later, later);
    await assert.rejects(loadSnapshot('S02', snapshotsRoot), /mtime changed: tests\/ui\/login\.spec\.ts/);
  });

  test('detects a manifest whose fingerprint does not match the report', async (t) => {
    const { snapshot, snapshotsRoot } = await stored(t);
    const manifestFile = path.join(snapshot.dir, MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.reportFingerprint = '000000000000';
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(loadSnapshot('S02', snapshotsRoot), /fingerprint is [0-9a-f]{12}, manifest says 000000000000/);
  });

  test('refuses a snapshot stored under another scenario ID', async (t) => {
    const { snapshot, snapshotsRoot } = await stored(t);
    const manifestFile = path.join(snapshot.dir, MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.scenarioId = 'S05';
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(loadSnapshot('S02', snapshotsRoot), /belongs to S05/);
  });

  test('refuses a missing snapshot and invalid scenario IDs', async (t) => {
    const root = await tempDir(t);
    await assert.rejects(loadSnapshot('S02', root), /No readable snapshot manifest/);
    await assert.rejects(loadSnapshot('../S02', root));
  });

  test('refuses symlinks inside the payload', async (t) => {
    const { snapshot, snapshotsRoot, base } = await stored(t);
    const outside = path.join(base, 'outside.txt');
    await writeFile(outside, 'secret');
    try {
      await symlink(outside, file(snapshot, 'tests/ui/link.txt'));
    } catch {
      // File symlinks need a privilege on Windows; directory junctions don't, and lstat reports them as links too.
      await mkdir(path.join(base, 'outside-dir'));
      await symlink(path.join(base, 'outside-dir'), file(snapshot, 'tests/ui/linked-dir'), 'junction');
    }
    await assert.rejects(loadSnapshot('S02', snapshotsRoot), /symlink/);
  });
});

describe('manifest path safety', () => {
  const valid = async (t: TestContext) => JSON.parse(await readFile(path.join((await stored(t)).snapshot.dir, MANIFEST_FILE), 'utf8'));

  test('rejects traversal, absolute, drive, backslash and dot-segment paths', async (t) => {
    const manifest = await valid(t);
    for (const bad of ['../outside.txt', 'tests/../../x', '/etc/passwd', 'C:/Windows/x', 'C:x', 'tests\\ui\\x.ts', 'tests/./x', 'tests//x', '']) {
      const copy = structuredClone(manifest);
      copy.files[0].path = bad;
      assert.equal(SnapshotManifest.safeParse(copy).success, false, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test('a manifest pointing outside its payload cannot load', async (t) => {
    const { snapshot, snapshotsRoot } = await stored(t);
    const manifestFile = path.join(snapshot.dir, MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.files.push({ path: '../../outside.txt', sha256: '0'.repeat(64), sizeBytes: 0, mtimeMs: 0 });
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(loadSnapshot('S02', snapshotsRoot), /invalid/);
  });

  test('only snapshots whose observation passed can be written', async (t) => {
    const { snapshot } = await stored(t);
    const root = await tempDir(t);
    const { files: _files, formatVersion: _v, ...rest } = snapshot.manifest;
    const failed = { ...rest, observation: { ok: false, checks: [] } } as unknown as typeof rest;
    await assert.rejects(writeSnapshot(snapshot.filesDir, failed, root));
    assert.deepEqual((await readdir(root)).filter((n) => !n.startsWith('.tmp-')), []);
  });
});

describe('writeSnapshot', () => {
  test('never overwrites an existing snapshot and leaves no temp directories', async (t) => {
    const { snapshot, snapshotsRoot } = await stored(t);
    const manifestFile = path.join(snapshot.dir, MANIFEST_FILE);
    const before = await readFile(manifestFile, 'utf8');
    const { files: _files, formatVersion: _v, ...rest } = snapshot.manifest;
    await assert.rejects(writeSnapshot(snapshot.filesDir, rest, snapshotsRoot), /already exists/);
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    const entries = await readdir(snapshotsRoot);
    assert.deepEqual(entries, ['S02']);
  });
});

describe('relocation', () => {
  test('a copied snapshot resolves its report and attachments through the MCP layer', async (t) => {
    const { snapshot } = await stored(t);
    const dest = path.join(await tempDir(t, 'td-relocated-'), 'workspace');
    await copySnapshotFiles(snapshot, dest);

    const loaded = await loadReport(dest);
    assert.equal(loaded.fingerprint, snapshot.manifest.reportFingerprint);
    const list = listFailures(loaded);
    assert.equal(list.failureCount, 1);
    assert.equal(list.failures[0]!.file, 'tests/ui/login.spec.ts');
    const details = await getFailureDetails(loaded, list.failures[0]!.testId);
    for (const a of details.attempts[0]!.attachments) {
      assert.equal(a.location, 'repo', `${a.name} resolves inside the copy`);
      assert.equal(a.exists, true, `${a.name} exists in the copy`);
      assert.match(a.path!, /^test-results\//);
    }
  });

  test('preserves modification times and contents', async (t) => {
    const { snapshot } = await stored(t);
    const dest = path.join(await tempDir(t, 'td-relocated-'), 'workspace');
    await copySnapshotFiles(snapshot, dest);
    const copied = await hashTree(dest);
    assert.deepEqual(
      copied.map((f) => [f.path, f.sha256, f.sizeBytes]),
      snapshot.manifest.files.map((f) => [f.path, f.sha256, f.sizeBytes]),
    );
    for (const [i, f] of copied.entries()) assert.ok(Math.abs(f.mtimeMs - snapshot.manifest.files[i]!.mtimeMs) <= 2, `${f.path} mtime preserved`);
  });

  test('refuses to copy onto an existing directory', async (t) => {
    const { snapshot } = await stored(t);
    const dest = await tempDir(t, 'td-relocated-');
    await mkdir(path.join(dest, 'x'));
    await assert.rejects(copySnapshotFiles(snapshot, dest), /already exists/);
  });
});

// The real pilot snapshots are gitignored, so these run only after `npm run eval -- generate`.
describe('generated pilot snapshots (if present)', () => {
  for (const id of ['S02', 'S04', 'S05']) {
    test(`${id} verifies, relocates and keeps its spec older than the run`, async (t) => {
      const present = await stat(path.join(SNAPSHOTS_DIR, id, MANIFEST_FILE)).then(() => true, () => false);
      if (!present) return t.skip(`no ${id} snapshot; run npm run eval -- generate --scenario ${id}`);
      const snapshot = await loadSnapshot(id);
      const dest = path.join(await tempDir(t, 'td-relocated-'), 'workspace');
      await copySnapshotFiles(snapshot, dest);
      const loaded = await loadReport(dest);
      const [failure] = listFailures(loaded).failures;
      assert.ok(failure);
      const details = await getFailureDetails(loaded, failure.testId);
      const attempt = details.attempts[0]!;
      assert.deepEqual(attempt.attachments.map((a) => [a.name, a.location, a.exists]).sort(), [
        ['error-context', 'repo', true],
        ['screenshot', 'repo', true],
        ['trace', 'repo', true],
      ]);
      const spec = await stat(path.join(dest, ...details.file.split('/')));
      assert.ok(spec.mtimeMs < Date.parse(attempt.startTime!), 'spec mtime precedes the attempt, so no false source/artifact mismatch');
    });
  }
});
