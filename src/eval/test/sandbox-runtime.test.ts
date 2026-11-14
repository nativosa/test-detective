import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { REPO_ROOT, RUNTIME_SCRIPTS_DIR } from '../sandbox/config.ts';
import { buildRuntimeManifest, dependencyClosure, forbiddenReason, manifestSha256, resolvesInside, RUNTIME_MANIFEST, RUNTIME_PACKAGE_JSON, runtimeSources, stageRuntime, stageSandboxRuntime, verifyRuntime, verifyStagedRuntime } from '../sandbox/runtime.ts';
import { CONFIG_FILES } from '../workspace.ts';
import { tempDir } from './helpers.ts';

// R4b Step 1D: the runtime copy for the evaluation account. Strict allowlist, deny list, canary
// scan, SHA-256 manifest. Staging happens only into temp folders here.

describe('forbidden paths', () => {
  test('answer keys, evaluation code and data, saved results, credentials and artifacts can never enter', () => {
    for (const p of [
      'src/eval/truth.ts',
      'src/eval/sandbox/runtime.ts',
      'evals/scenarios/S01/truth.json',
      'evals/runs/live-S02/S02-01/score.json',
      'node_modules/zod/truth.json',
      'node_modules/x/generation.json',
      'node_modules/x/review.json',
      'node_modules/x/transcript.jsonl',
      'artifacts/results.json',
      'test-results/a/trace.zip',
      'playwright-report/index.html',
      '.work/stage/x',
      '.git/config',
      '.claude/settings.local.json',
      '.claude/agents/failure-investigator.md',
      'node_modules/x/.credentials.json',
      '.claude.json',
      '.env',
      'node_modules/x/server.key',
      'src/mcp/test/server.test.ts',
      '../outside.txt',
      'C:/Users/dev/.claude/.credentials.json',
    ]) {
      assert.ok(forbiddenReason(p), p);
    }
  });

  test('the allowlisted kinds of files pass', () => {
    for (const p of ['src/mcp/main.ts', 'node_modules/zod/index.js', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', 'scripts/eval-sandbox/runtime/stage2.mjs', ...CONFIG_FILES]) {
      assert.equal(forbiddenReason(p), null, p);
    }
  });
});

describe('dependency closure from the lock file', () => {
  const lock = {
    packages: {
      '': {},
      'node_modules/a': { dependencies: { b: '1', c: '1' }, optionalDependencies: { gone: '1' } },
      'node_modules/a/node_modules/b': { dependencies: { d: '1' } },
      'node_modules/b': { dependencies: { unused: '1' } },
      'node_modules/c': {},
      'node_modules/d': {},
      'node_modules/unused': {},
      'node_modules/other': {},
    },
  };

  test('resolves nested installs before hoisted ones, skips uninstalled optional dependencies, takes nothing else', () => {
    assert.deepEqual(dependencyClosure(lock, ['a']), ['node_modules/a', 'node_modules/a/node_modules/b', 'node_modules/c', 'node_modules/d']);
  });

  test('a missing required dependency or root fails instead of producing a partial runtime', () => {
    assert.throws(() => dependencyClosure({ packages: { 'node_modules/a': { dependencies: { zz: '1' } } } }, ['a']), /needs zz, which is not installed/);
    assert.throws(() => dependencyClosure(lock, ['nope']), /nope is not installed/);
  });
});

/** A small fake repo with every allowlisted source plus decoys that must never be picked up. */
async function fakeRepo(root: string): Promise<void> {
  const file = async (rel: string, text = `// ${rel}\n`) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  await file('package-lock.json', JSON.stringify({
    packages: {
      '': {},
      'node_modules/@modelcontextprotocol/server': { dependencies: { '@modelcontextprotocol/core': '1', zod: '4' } },
      'node_modules/@modelcontextprotocol/core': {},
      'node_modules/zod': {},
      'node_modules/yauzl': { dependencies: { pend: '1' } },
      'node_modules/pend': {},
      'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64': { version: '0.3.302' },
      'node_modules/@playwright/test': {},
    },
  }));
  for (const pkg of ['@modelcontextprotocol/server', '@modelcontextprotocol/core', 'zod', 'yauzl', 'pend', '@playwright/test']) await file(`node_modules/${pkg}/index.js`);
  await file('node_modules/zod/node_modules/nested/index.js');
  for (const f of ['claude.exe', 'LICENSE.md', 'README.md']) await file(`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/${f}`);
  await file('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/package.json', JSON.stringify({ version: '0.3.302' }));
  for (const f of ['main.ts', 'server.ts']) await file(`src/mcp/${f}`);
  await file('src/mcp/test/server.test.ts');
  for (const f of ['stage2.mjs', 'probe.mjs', 'teardown.mjs']) await file(`scripts/eval-sandbox/runtime/${f}`);
  for (const f of CONFIG_FILES) await file(f);
  // Decoys: answer keys, results, credentials and other repo files.
  await file('evals/scenarios/S01/truth.json', '{"canary":"TDCANARY-decoy"}');
  await file('src/eval/truth.ts');
  await file('artifacts/results.json');
  await file('.claude/settings.local.json');
  await file('.claude/agents/failure-investigator.md');
  await file('src/agent/config.ts');
}

describe('runtime manifest, staging and verification', () => {
  test('takes only the allowlist: MCP sources, the dependency closure, the Claude binary, sandbox scripts, approved config', async (t) => {
    const repo = await tempDir(t, 'td-runtime-repo-');
    await fakeRepo(repo);
    const manifest = await buildRuntimeManifest(repo);
    assert.deepEqual(manifest.files.map((f) => f.path), [
      'app/node_modules/@modelcontextprotocol/core/index.js',
      'app/node_modules/@modelcontextprotocol/server/index.js',
      'app/node_modules/pend/index.js',
      'app/node_modules/yauzl/index.js',
      'app/node_modules/zod/index.js',
      'app/package.json',
      'app/src/mcp/main.ts',
      'app/src/mcp/server.ts',
      'bin/probe.mjs',
      'bin/stage2.mjs',
      'bin/teardown.mjs',
      'claude/claude.exe',
      'claude/LICENSE.md',
      'claude/package.json',
      'claude/README.md',
      'config/.claude/settings.json',
      'config/.claude/skills/investigate-failure/SKILL.md',
    ]);
    assert.equal(manifest.claudeVersion, '0.3.302');
    assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.equal(manifest.files.find((f) => f.path === 'app/package.json')!.source, 'generated');
    assert.doesNotMatch(JSON.stringify(manifest), /truth|evals\/|artifacts|settings\.local|agents|playwright|src\/agent|nested|test\//);
  });

  test('stages byte-identical copies, then detects changed, extra and missing files and links', async (t) => {
    const repo = await tempDir(t, 'td-runtime-repo-');
    await fakeRepo(repo);
    const manifest = await buildRuntimeManifest(repo);
    const dest = path.join(await tempDir(t, 'td-runtime-dest-'), 'runtime');
    await stageRuntime(repo, manifest, dest);
    assert.deepEqual(await verifyRuntime(dest, manifest), []);
    assert.equal(await readFile(path.join(dest, 'app', 'package.json'), 'utf8'), RUNTIME_PACKAGE_JSON);
    assert.deepEqual(JSON.parse(await readFile(path.join(dest, RUNTIME_MANIFEST), 'utf8')), manifest);

    await appendFile(path.join(dest, 'bin', 'probe.mjs'), '// changed');
    await writeFile(path.join(dest, 'app', 'node_modules', 'zod', 'extra.js'), '');
    await writeFile(path.join(dest, 'claude', 'README.md'), '');
    await rm(path.join(dest, 'config', '.claude', 'settings.json'));
    assert.deepEqual((await verifyRuntime(dest, manifest)).sort(), ['changed bin/probe.mjs', 'changed claude/README.md', 'extra file app/node_modules/zod/extra.js', 'missing config/.claude/settings.json']);
    if (process.platform === 'win32') {
      await symlink(repo, path.join(dest, 'app', 'link'), 'junction');
      assert.match((await verifyRuntime(dest, manifest)).join(), /is a link/);
    }
  });

  test('refuses to stage into a non-empty folder or inside the repo', async (t) => {
    const repo = await tempDir(t, 'td-runtime-repo-');
    await fakeRepo(repo);
    const manifest = await buildRuntimeManifest(repo);
    const busy = await tempDir(t, 'td-runtime-dest-');
    await writeFile(path.join(busy, 'x'), '');
    await assert.rejects(stageRuntime(repo, manifest, busy), /not empty/);
    await assert.rejects(stageRuntime(repo, manifest, path.join(repo, 'runtime')), /outside the repo/);
  });

  test('I5: the staged copy is checked against a manifest built from the repo, not only against the manifest stored beside it', async (t) => {
    const repo = await tempDir(t, 'td-runtime-repo-');
    await fakeRepo(repo);
    const dest = path.join(await tempDir(t, 'td-runtime-dest-'), 'runtime');
    await stageRuntime(repo, await buildRuntimeManifest(repo), dest);
    assert.deepEqual((await verifyStagedRuntime(repo, dest)).problems, []);

    // Tamper with a staged file AND its manifest entry consistently: the self-check is fooled, the trusted check is not.
    const file = path.join(dest, 'bin', 'probe.mjs');
    await writeFile(file, '// tampered\n');
    const staged = JSON.parse(await readFile(path.join(dest, RUNTIME_MANIFEST), 'utf8')) as { files: { path: string; sha256: string; size: number }[] };
    const entry = staged.files.find((f) => f.path === 'bin/probe.mjs')!;
    entry.sha256 = createHash('sha256').update('// tampered\n').digest('hex');
    entry.size = 12;
    await writeFile(path.join(dest, RUNTIME_MANIFEST), JSON.stringify(staged));
    assert.deepEqual(await verifyRuntime(dest, staged as Parameters<typeof verifyRuntime>[1]), [], 'a copy compared only with itself looks fine');
    const tampered = (await verifyStagedRuntime(repo, dest)).problems;
    assert.match(tampered.join('\n'), /stale: the staged manifest differs from the repo's \(1 files differ, e\.g\. bin\/probe\.mjs\)/);
    assert.ok(tampered.includes('changed bin/probe.mjs'));

    // A copy staged from an older repo state is stale once the repo moves on.
    const fresh = path.join(await tempDir(t, 'td-runtime-dest-'), 'runtime');
    await stageRuntime(repo, await buildRuntimeManifest(repo), fresh);
    await appendFile(path.join(repo, 'src', 'mcp', 'server.ts'), '// newer\n');
    const stale = (await verifyStagedRuntime(repo, fresh)).problems;
    assert.match(stale.join('\n'), /stale/);
    assert.ok(stale.includes('changed app/src/mcp/server.ts'));
    await rm(path.join(fresh, RUNTIME_MANIFEST));
    assert.ok((await verifyStagedRuntime(repo, fresh)).problems.includes('the staged manifest is missing or unreadable'));
  });

  test('I11: an alias that resolves into the repo (junction, 8.3 name) is not "outside the repo"', { skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
    const repo = await tempDir(t, 'td-runtime-repo-');
    await fakeRepo(repo);
    const manifest = await buildRuntimeManifest(repo);
    const outside = await tempDir(t, 'td-runtime-alias-');
    const link = path.join(outside, 'looks-outside');
    await symlink(repo, link, 'junction');
    assert.equal(await resolvesInside(repo, path.join(link, 'runtime')), true);
    await assert.rejects(stageRuntime(repo, manifest, path.join(link, 'runtime')), /outside the repo/);
    assert.ok(!existsSync(path.join(repo, 'runtime')), 'nothing was created through the alias');
    const { windowsShortPaths } = await import('../live.ts');
    const [short] = await windowsShortPaths([repo]);
    if (short && short.toLowerCase() !== repo.toLowerCase()) {
      assert.equal(await resolvesInside(repo, path.join(short, 'runtime')), true, `8.3 alias ${short}`);
      await assert.rejects(stageRuntime(repo, manifest, path.join(short, 'runtime')), /outside the repo/);
    } else {
      t.diagnostic('no 8.3 name for the temp repo on this volume; the junction case still ran');
    }
    assert.equal(await resolvesInside(repo, outside), false);
  });

  test('I11: the CLI stages only into the configured runtime folder, which setup must already have created (never a link)', async (t) => {
    const repo = await tempDir(t, 'td-runtime-repo-');
    await fakeRepo(repo);
    const manifest = await buildRuntimeManifest(repo);
    const root = await tempDir(t, 'td-sandbox-root-');
    const config = { account: 'td-eval', group: 'td-eval-sandbox', root };
    await assert.rejects(stageSandboxRuntime(repo, manifest, config), /does not exist; it is created by setup\.ps1 -Apply/);
    assert.ok(!existsSync(path.join(root, 'runtime')), 'staging never creates the folder (it would inherit permissions)');
    if (process.platform === 'win32') {
      const elsewhere = await tempDir(t, 'td-runtime-elsewhere-');
      await symlink(elsewhere, path.join(root, 'runtime'), 'junction');
      await assert.rejects(stageSandboxRuntime(repo, manifest, config), /not a plain folder/);
      await rm(path.join(root, 'runtime'));
    }
    await mkdir(path.join(root, 'runtime'));
    assert.equal(await stageSandboxRuntime(repo, manifest, config), path.join(root, 'runtime'));
    assert.deepEqual((await verifyStagedRuntime(repo, path.join(root, 'runtime'))).problems, []);
    assert.equal(manifestSha256(JSON.parse(await readFile(path.join(root, 'runtime', RUNTIME_MANIFEST), 'utf8'))), manifestSha256(manifest));
  });

  test('an answer key or a canary hidden inside an allowlisted package stops the build', async (t) => {
    const truthRepo = await tempDir(t, 'td-runtime-repo-');
    await fakeRepo(truthRepo);
    await writeFile(path.join(truthRepo, 'node_modules', 'zod', 'truth.json'), '{}');
    await assert.rejects(buildRuntimeManifest(truthRepo), /Refusing node_modules\/zod\/truth\.json in the runtime: ground truth/);

    const canaryRepo = await tempDir(t, 'td-runtime-repo-');
    await fakeRepo(canaryRepo);
    await writeFile(path.join(canaryRepo, 'node_modules', 'yauzl', 'notes.txt'), 'see TDCANARY-S05-abc');
    await assert.rejects(buildRuntimeManifest(canaryRepo), /app\/node_modules\/yauzl\/notes\.txt contains a scenario canary/);
  });

  test('a link inside an allowlisted package stops the build', { skip: process.platform !== 'win32' && 'junctions are Windows-only' }, async (t) => {
    const repo = await tempDir(t, 'td-runtime-repo-');
    await fakeRepo(repo);
    await symlink(path.join(repo, 'evals'), path.join(repo, 'node_modules', 'zod', 'evals-link'), 'junction');
    await assert.rejects(runtimeSources(repo), /evals-link is a link/);
  });

  test('the real repo: the allowlist resolves, holds no forbidden path, and carries the Claude binary and MCP server', async () => {
    const sources = await runtimeSources(REPO_ROOT);
    const repoPaths = sources.flatMap((s) => ('repoPath' in s ? [s.repoPath] : []));
    assert.deepEqual(repoPaths.filter((p) => forbiddenReason(p)), []);
    assert.ok(repoPaths.includes('src/mcp/main.ts') && repoPaths.includes('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'));
    assert.ok(repoPaths.some((p) => p.startsWith('node_modules/zod/')) && repoPaths.some((p) => p.startsWith('node_modules/yauzl/')));
    assert.ok(!repoPaths.some((p) => /^(src\/(eval|agent)|evals|artifacts|test-results|\.work)\//.test(p)));
    assert.ok(!repoPaths.some((p) => p.startsWith('node_modules/@anthropic-ai/claude-agent-sdk/')), 'the SDK stays with the trusted host');
    assert.deepEqual(repoPaths.filter((p) => p.startsWith('.claude/')).sort(), [...CONFIG_FILES].sort());
  });
});

describe('separation and backward compatibility', () => {
  const SANDBOX_DIR = path.join(REPO_ROOT, 'src', 'eval', 'sandbox');
  const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]!);

  test('scripts that run as the evaluation account import only Node built-ins', async () => {
    for (const f of await readdir(RUNTIME_SCRIPTS_DIR)) {
      assert.deepEqual(importsOf(path.join(RUNTIME_SCRIPTS_DIR, f)).filter((s) => !s.startsWith('node:')), [], f);
    }
  });

  test('the sandbox modules never reach ground truth, scoring or the SDK (main.ts, the CLI, borrows the 8.3 lookup from live.ts)', async () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec));
    };
    for (const f of (await readdir(SANDBOX_DIR)).filter((f) => f.endsWith('.ts') && f !== 'main.ts')) visit(path.join(SANDBOX_DIR, f));
    const reached = [...seen].map((f) => path.relative(path.join(REPO_ROOT, 'src', 'eval'), f).split(path.sep).join('/'));
    // scenarios.ts (ids and folder names, shared by both loaders) is reached through workspace.ts -> snapshots.ts; it holds no answers.
    for (const forbidden of ['truth.ts', 'control.ts', 'score.ts', 'polarity.ts', 'runs.ts', 'report.ts', 'isolation.ts', 'live.ts', '../agent/run.ts']) assert.ok(!reached.includes(forbidden), forbidden);
    for (const f of seen) assert.doesNotMatch(readFileSync(f, 'utf8'), /^\s*import\s(?!type\s)[^;]*from\s+['"]@anthropic-ai\/claude-agent-sdk['"]/m, f);
  });

  test('the live evaluation path does not use the sandbox yet: live.ts, isolation.ts and workspace.ts never import it', () => {
    for (const f of ['live.ts', 'isolation.ts', 'workspace.ts', 'main.ts']) {
      assert.ok(!importsOf(path.join(REPO_ROOT, 'src', 'eval', f)).some((s) => s.includes('sandbox')), f);
    }
  });
});
