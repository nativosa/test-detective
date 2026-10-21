import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { leakMarkers } from '../isolation.ts';
import { loadSnapshot, MANIFEST_FILE, SNAPSHOTS_DIR } from '../snapshots.ts';
import { auditWorkspace, checkIntegrity, CONFIG_FILES, createWorkspace, REMOVAL_DEADLINE_MS, removeWorkspace, WORKSPACE_DIR, WORKSPACE_PREFIX, WorkspaceRemovalError } from '../workspace.ts';
import type { Workspace } from '../workspace.ts';
import { fakeSnapshot, tempDir } from './helpers.ts';
import type { FakeRunOptions } from './helpers.ts';

// Workspace materialization and offline audits. Workspaces are created under a per-test temp
// parent, so creation and cleanup are observable and nothing is left behind.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const markers = await leakMarkers();
const canary = markers.canaries[0]!;

async function workspace(t: TestContext, options: FakeRunOptions = {}): Promise<{ ws: Workspace; parent: string }> {
  const { snapshot } = await fakeSnapshot(t, options);
  const parent = await tempDir(t, 'td-parent-');
  const ws = await createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent }, markers);
  t.after(() => removeWorkspace(ws).catch(() => {}));
  return { ws, parent };
}

const file = (ws: Workspace, rel: string) => path.join(ws.root, ...rel.split('/'));
const SPEC = 'tests/ui/login.spec.ts';

describe('createWorkspace', () => {
  test('creates a neutral-named workspace with exactly the snapshot payload and config files', async (t) => {
    const { ws, parent } = await workspace(t);
    assert.equal(path.dirname(ws.container), parent);
    assert.match(path.basename(ws.container), new RegExp(`^${WORKSPACE_PREFIX}[A-Za-z0-9]{6}$`));
    assert.equal(ws.root, path.join(ws.container, WORKSPACE_DIR));
    assert.deepEqual(
      ws.files.map((f) => f.path),
      [
        '.claude/settings.json',
        '.claude/skills/investigate-failure/SKILL.md',
        'artifacts/results.json',
        'playwright.config.ts',
        'test-results/ui-login-signs-in-chromium/error-context.md',
        'test-results/ui-login-signs-in-chromium/test-failed-1.png',
        'test-results/ui-login-signs-in-chromium/trace.zip',
        SPEC,
      ],
    );
    assert.deepEqual(await readdir(ws.container), [WORKSPACE_DIR], 'nothing else in the container');
  });

  test('config files are byte copies of the repo files, with their timestamps', async (t) => {
    const { ws } = await workspace(t);
    for (const rel of CONFIG_FILES) {
      const [copy, original] = await Promise.all([readFile(file(ws, rel)), readFile(path.join(REPO_ROOT, ...rel.split('/')))]);
      assert.deepEqual(copy, original, rel);
      const [a, b] = await Promise.all([stat(file(ws, rel)), stat(path.join(REPO_ROOT, ...rel.split('/')))]);
      assert.ok(Math.abs(a.mtimeMs - b.mtimeMs) <= 2, `${rel} mtime preserved`);
    }
  });

  test('preserves snapshot timestamps', async (t) => {
    const { snapshot } = await fakeSnapshot(t);
    const ws = await createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent: await tempDir(t) }, markers);
    t.after(() => removeWorkspace(ws));
    for (const f of snapshot.manifest.files) {
      const info = await stat(file(ws, f.path));
      assert.ok(Math.abs(info.mtimeMs - f.mtimeMs) <= 2, `${f.path} mtime preserved`);
    }
  });

  test('never copies ground truth, generation data, manifests, CLAUDE.md or eval docs', async (t) => {
    const { ws } = await workspace(t);
    const all = (await readdir(ws.container, { recursive: true })).map((p) => p.split(path.sep).join('/'));
    for (const name of ['truth.json', 'generation.json', MANIFEST_FILE, 'CLAUDE.md', 'README.md', '.mcp.json']) {
      assert.ok(!all.some((p) => p.split('/').includes(name)), `${name} must not be copied`);
    }
    assert.ok(!all.some((p) => /(^|\/)(evals|src|S\d{2})(\/|$)/.test(p)), 'no eval, source or scenario directories');
  });

  test('fails closed and cleans up when the snapshot carries a leak marker', async (t) => {
    const { snapshot } = await fakeSnapshot(t, { errorContextExtra: `\n${canary}\n` });
    const parent = await tempDir(t);
    await assert.rejects(createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent }, markers), /leak marker "TDCANARY-…" in test-results\/.+error-context\.md/);
    assert.deepEqual(await readdir(parent), [], 'container removed');
  });

  test('refuses a location inside a protected root and cleans up', async (t) => {
    const { snapshot } = await fakeSnapshot(t);
    const parent = await tempDir(t);
    await assert.rejects(createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent, protectedRoots: [parent] }, markers), /inside protected path/);
    assert.deepEqual(await readdir(parent), []);
  });

  test('refuses when an ancestor has a CLAUDE.md that Claude Code would load', async (t) => {
    const { snapshot } = await fakeSnapshot(t);
    const parent = await tempDir(t);
    await writeFile(path.join(parent, 'CLAUDE.md'), '# instructions');
    await assert.rejects(createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent }, markers), /ancestor instruction file/);
    assert.deepEqual(await readdir(parent), ['CLAUDE.md']);
  });

  test('refuses a snapshot that was tampered with after it was stored', async (t) => {
    const { snapshot, snapshotsRoot } = await fakeSnapshot(t);
    await writeFile(path.join(snapshot.filesDir, ...SPEC.split('/')), 'changed');
    const parent = await tempDir(t);
    await assert.rejects(createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent }, markers), /hash mismatch/);
    await assert.rejects(loadSnapshot('S02', snapshotsRoot), /hash mismatch/);
    assert.deepEqual(await readdir(parent), []);
  });
});

describe('auditWorkspace', () => {
  test('a fresh workspace passes', async (t) => {
    const { ws } = await workspace(t);
    const audit = await auditWorkspace(ws, markers);
    assert.deepEqual(audit.problems, []);
    assert.equal(audit.ok, true);
  });

  test('detects unexpected files', async (t) => {
    const { ws } = await workspace(t);
    await writeFile(file(ws, 'notes.txt'), 'x');
    const { problems } = await auditWorkspace(ws, markers);
    assert.ok(problems.includes('tampering: unexpected file: notes.txt'));
    assert.ok(problems.includes('unexpected file: notes.txt'));
  });

  test('detects ground-truth file names and scenario-ID directories', async (t) => {
    const { ws } = await workspace(t);
    await writeFile(file(ws, 'tests/ui/truth.json'), '{}');
    await mkdir(file(ws, 'test-results/S04'));
    await writeFile(file(ws, 'test-results/S04/x.md'), 'x');
    const { problems } = await auditWorkspace(ws, markers);
    assert.ok(problems.some((p) => p.startsWith('forbidden path segment "truth.json"')));
    assert.ok(problems.some((p) => p.startsWith('forbidden path segment "S04"')));
  });

  test('detects canaries and eval-only strings in file contents', async (t) => {
    const { ws } = await workspace(t);
    await writeFile(file(ws, 'test-results/ui-login-signs-in-chromium/error-context.md'), `page\n${canary}`);
    await writeFile(file(ws, 'artifacts/results.json'), '{"expectObservation": {}}');
    const { problems } = await auditWorkspace(ws, markers);
    assert.ok(problems.some((p) => p.includes('"TDCANARY-…"') && p.endsWith('error-context.md')));
    assert.ok(problems.some((p) => p.includes('"expectObservation"')));
    assert.ok(!problems.join('\n').includes(canary), 'canary values are never printed');
  });

  test('detects scenario-ID-like tokens in text files', async (t) => {
    const { ws } = await workspace(t);
    await writeFile(file(ws, SPEC), "test('S05 shows profile', async () => {});");
    const { problems } = await auditWorkspace(ws, markers);
    assert.ok(problems.includes(`scenario-ID-like token in ${SPEC}`));
  });

  test('detects modified content and timestamps', async (t) => {
    const { ws } = await workspace(t);
    const later = new Date(Date.now() + 60_000);
    await utimes(file(ws, SPEC), later, later);
    assert.deepEqual(await checkIntegrity(ws), [`mtime changed: ${SPEC}`]);
    await writeFile(file(ws, 'artifacts/results.json'), '{}');
    assert.ok((await checkIntegrity(ws)).includes('hash mismatch: artifacts/results.json'));
  });

  test('detects symbolic links', async (t) => {
    const { ws, parent } = await workspace(t);
    const outside = path.join(parent, 'outside.txt');
    await writeFile(outside, 'secret');
    try {
      await symlink(outside, file(ws, 'tests/ui/link.txt'));
    } catch {
      // File symlinks need a privilege on Windows; directory junctions don't, and lstat reports them as links too.
      await mkdir(path.join(parent, 'outside-dir'));
      await symlink(path.join(parent, 'outside-dir'), file(ws, 'tests/ui/linked-dir'), 'junction');
    }
    const { problems } = await auditWorkspace(ws, markers);
    assert.ok(problems.some((p) => /symlink/.test(p)));
  });

  test('notes leftover workspaces next to this one', async (t) => {
    const { ws, parent } = await workspace(t);
    await mkdir(path.join(parent, `${WORKSPACE_PREFIX}leftover`));
    const audit = await auditWorkspace(ws, markers);
    assert.equal(audit.ok, true);
    assert.match(audit.notes.join(' '), /1 other ws-\* director/);
  });
});

describe('removeWorkspace', () => {
  test('removes the whole container', async (t) => {
    const { ws, parent } = await workspace(t);
    await removeWorkspace(ws);
    assert.deepEqual(await readdir(parent), []);
  });

  test('refuses anything that is not a workspace container', async (t) => {
    const { ws } = await workspace(t);
    const forged = { ...ws, container: path.dirname(ws.container), root: path.join(path.dirname(ws.container), WORKSPACE_DIR) };
    await assert.rejects(removeWorkspace(forged), /not a workspace container/);
    assert.equal(await stat(ws.root).then(() => true), true);
  });

  test('a clean removal takes one attempt and records no retries', async (t) => {
    const { ws } = await workspace(t);
    const removal = await removeWorkspace(ws);
    assert.equal(removal.attempts, 1);
    assert.deepEqual(removal.transient, []);
  });
});

describe('removeWorkspace: busy workspaces (Windows EBUSY)', () => {
  // The first live S02 run: rmdir of the workspace root failed with EBUSY because the session's
  // processes (cwd = workspace root) had not exited yet; close() does not wait for them.
  const busy = (dir: string) => Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path.join(dir, WORKSPACE_DIR)}'`), { code: 'EBUSY' });

  /** A fake clock: sleep advances it, so deadlines are exact and tests don't wait. */
  function clock() {
    let now = 0;
    const sleeps: number[] = [];
    return { sleeps, now: () => now, sleep: async (ms: number) => void (sleeps.push(ms), (now += ms)) };
  }

  test('transient EBUSY: retried with backoff, then removed, and every retry is recorded', async (t) => {
    const { ws, parent } = await workspace(t);
    const c = clock();
    let calls = 0;
    const removal = await removeWorkspace(ws, {
      ...c,
      rm: async (dir) => {
        if (++calls <= 3) throw busy(dir);
        await rm(dir, { recursive: true, force: true });
      },
    });
    assert.equal(removal.attempts, 4);
    assert.equal(removal.transient.length, 3);
    assert.match(removal.transient[0]!, /^EBUSY/);
    assert.deepEqual(c.sleeps, [100, 200, 400]);
    assert.equal(removal.elapsedMs, 700);
    assert.deepEqual(await readdir(parent), []);
  });

  test('persistent EBUSY: gives up at the deadline with the attempt record, and never deletes anything else', async (t) => {
    const { ws } = await workspace(t);
    const c = clock();
    const error: unknown = await removeWorkspace(ws, { ...c, rm: async (dir) => { throw busy(dir); } }).catch((e: unknown) => e);
    assert.ok(error instanceof WorkspaceRemovalError);
    assert.match(error.message, /^EBUSY: .* \(still failing after \d+ attempt\(s\) over \d+ ms; a process may still be using the workspace\)$/);
    assert.ok(error.removal.elapsedMs <= REMOVAL_DEADLINE_MS, 'bounded');
    assert.equal(error.removal.elapsedMs + Math.min(100 * 2 ** (error.removal.attempts - 1), 1000) > REMOVAL_DEADLINE_MS, true, 'stopped only when the next wait would pass the deadline');
    assert.equal(error.removal.transient.length, error.removal.attempts - 1, 'every retried attempt recorded');
    assert.equal(c.sleeps.reduce((a, b) => a + b, 0), error.removal.elapsedMs);
    assert.ok(await stat(ws.root), 'workspace left in place for inspection');
  });

  test('a non-lock error fails at once, without retries', async (t) => {
    const { ws } = await workspace(t);
    const c = clock();
    const error: unknown = await removeWorkspace(ws, { ...c, rm: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } }).catch((e: unknown) => e);
    assert.ok(error instanceof WorkspaceRemovalError);
    assert.deepEqual(error.removal, { attempts: 1, elapsedMs: 0, transient: [] });
    assert.deepEqual(c.sleeps, []);
  });

  test('a removal that reports success but leaves the container is a failure', async (t) => {
    const { ws } = await workspace(t);
    await assert.rejects(removeWorkspace(ws, { rm: async () => {} }), (e: unknown) => e instanceof WorkspaceRemovalError && /still exists after removal/.test(e.message));
  });

  // The real mechanism: a process whose cwd is the workspace root. Windows only; POSIX allows it.
  const windows = process.platform === 'win32' ? test : test.skip;

  windows('real process: removal succeeds once a process using the workspace as cwd exits', async (t) => {
    const { ws, parent } = await workspace(t);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { cwd: ws.root, stdio: 'ignore' });
    t.after(() => child.kill());
    await once(child, 'spawn');
    const removal = await removeWorkspace(ws);
    assert.ok(removal.transient.length > 0, 'was busy at first');
    assert.match(removal.transient[0]!, /^EBUSY/);
    assert.deepEqual(await readdir(parent), []);
  });

  windows('real process: a process that keeps the workspace busy is reported, not waited out', async (t) => {
    const { ws } = await workspace(t);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd: ws.root, stdio: 'ignore' });
    t.after(() => child.kill());
    await once(child, 'spawn');
    const error: unknown = await removeWorkspace(ws, { deadlineMs: 600 }).catch((e: unknown) => e);
    assert.ok(error instanceof WorkspaceRemovalError);
    assert.match(error.message, /^EBUSY: .*a process may still be using the workspace/);
    child.kill();
    await once(child, 'exit');
    assert.equal((await removeWorkspace(ws)).attempts >= 1, true, 'removable once the process is gone');
  });
});

// Gitignored; present only after `npm run eval -- generate`.
describe('pilot snapshot workspaces (if present)', () => {
  for (const id of ['S02', 'S04', 'S05']) {
    test(`${id} materializes into a clean, audited workspace`, async (t) => {
      const present = await stat(path.join(SNAPSHOTS_DIR, id, MANIFEST_FILE)).then(() => true, () => false);
      if (!present) return t.skip(`no ${id} snapshot`);
      const parent = await tempDir(t, 'td-parent-');
      const ws = await createWorkspace(await loadSnapshot(id), { repoRoot: REPO_ROOT, parent }, markers);
      t.after(() => removeWorkspace(ws));
      assert.deepEqual((await auditWorkspace(ws, markers)).problems, []);
      assert.deepEqual(await checkIntegrity(ws), []);
    });
  }
});
