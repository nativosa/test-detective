import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { MCP_DETAILS, MCP_LIST, MCP_SERVER } from '../../agent/config.ts';
import { runInvestigation } from '../../agent/run.ts';
import { args, call, fakeQuery, init, investigatedStream, LOGIN, skillCall, toolUse } from '../../agent/test/helpers.ts';
import {
  adaptOptions,
  auditTranscript,
  describeDifferences,
  diffOptions,
  evalDenyRules,
  evalQuery,
  leakMarkers,
  rulePath,
  sessionOptions,
  shellAssignments,
  shellTokens,
  STRUCTURED_OUTPUT_TOOL,
} from '../isolation.ts';
import type { IsolationContext } from '../isolation.ts';
import { createWorkspace, defaultProtectedRoots, isInside, MAX_ROOT_SPELLINGS, projectSlug, removeWorkspace, withShortNameAliases } from '../workspace.ts';
import type { ShortPathLookup } from '../workspace.ts';
import { fakeSnapshot, tempDir } from './helpers.ts';

// The evaluation session config (built from the unchanged production builder) and the transcript
// audit. Fake SDK streams only: no model requests, no credentials.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
const markers = await leakMarkers();
const canary = markers.canaries[0]!;
const ENV = { PATH: 'x', SECRET_TOKEN: 'super-secret-value' };

async function context(t: TestContext): Promise<IsolationContext> {
  const { snapshot } = await fakeSnapshot(t);
  const workspace = await createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent: await tempDir(t, 'td-parent-') }, markers);
  t.after(() => removeWorkspace(workspace));
  return { repoRoot: REPO_ROOT, workspace };
}

describe('deny rules', () => {
  test('rulePath uses the //drive/... form on Windows and //... on POSIX', () => {
    assert.equal(rulePath('C:\\GIT\\test-detective'), '//c/GIT/test-detective');
    assert.equal(rulePath('C:/GIT/test-detective/'), '//c/GIT/test-detective');
    assert.equal(rulePath('/home/me/repo'), '//home/me/repo');
  });

  test('cover the repo and ~/.claude, each also in lower case on Windows', () => {
    const claude = path.join(homedir(), '.claude');
    const lower = (p: string) => (process.platform === 'win32' ? [`Read(${rulePath(p).toLowerCase()}/**)`] : []);
    const expected = [...new Set([`Read(${rulePath(REPO_ROOT)}/**)`, ...lower(REPO_ROOT), `Read(${rulePath(claude)}/**)`, ...lower(claude), 'Read(~/.claude/**)'])];
    assert.deepEqual(evalDenyRules([REPO_ROOT, claude]), expected);
  });

  test('rulePath gives one spelling for backslashes, forward slashes, mixed separators, trailing separators and spaces', () => {
    for (const p of ['C:\\GIT\\test-detective', 'C:/GIT/test-detective', 'C:\\GIT/test-detective\\', 'c:\\GIT\\test-detective']) assert.equal(rulePath(p), '//c/GIT/test-detective', p);
    assert.equal(rulePath('C:\\Program Files\\My Repo\\'), '//c/Program Files/My Repo');
  });

  test('Windows roots also get an all-lower-case rule; duplicates are dropped, first occurrence kept', () => {
    assert.deepEqual(evalDenyRules(['C:\\GIT\\test-detective', 'C:\\git\\test-detective', 'C:\\GIT\\test-detective']), ['Read(//c/GIT/test-detective/**)', 'Read(//c/git/test-detective/**)']);
    assert.deepEqual(evalDenyRules(['C:\\git\\test-detective']), ['Read(//c/git/test-detective/**)'], 'an all-lower-case root gets one rule');
    // POSIX file systems are case-sensitive: no extra spelling.
    if (process.platform !== 'win32') assert.deepEqual(evalDenyRules(['/home/me/Repo']), ['Read(//home/me/Repo/**)']);
  });
});

describe('protected roots (R4b)', () => {
  const tempClaude = path.join(tmpdir(), 'claude');
  // A deny rule `Read(//x/**)` covers every path whose rule spelling starts with `//x/`. Compared
  // case-insensitively here, so the check errs toward "denied".
  const deniedBy = (rules: string[], absolute: string) => rules.find((r) => (rulePath(absolute) + '/').toLowerCase().startsWith(r.slice('Read('.length, -'**)'.length).toLowerCase()));

  test('projectSlug replaces every character other than a letter or digit, as Claude Code names its project folders', () => {
    assert.equal(projectSlug('C:\\git\\test-detective'), 'C--git-test-detective');
    assert.equal(projectSlug('C:\\GIT\\test-detective'), 'C--GIT-test-detective');
    assert.equal(projectSlug('/home/me/my repo.v2'), '-home-me-my-repo-v2');
  });

  test('cover the repo as given and as spelled on disk, ~/.claude, and this repo\'s Claude Code temp folders', () => {
    const roots = defaultProtectedRoots(REPO_ROOT);
    const spellings = [...new Set([path.resolve(REPO_ROOT), realpathSync.native(REPO_ROOT)])];
    const onDisk = (p: string) => (existsSync(p) ? realpathSync.native(p) : p);
    const temp = spellings.flatMap((s) => [path.join(tempClaude, projectSlug(s)), onDisk(path.join(tempClaude, projectSlug(s)))]);
    assert.deepEqual(roots, [...new Set([...spellings, path.join(homedir(), '.claude'), ...temp])]);
    assert.equal(new Set(roots).size, roots.length, 'no duplicate roots');
    // A path that doesn't exist falls back to its resolved spelling.
    const missing = path.join(tmpdir(), 'td-no-such-repo', 'X');
    assert.deepEqual(defaultProtectedRoots(missing), [missing, path.join(homedir(), '.claude'), path.join(tempClaude, projectSlug(missing))]);
  });

  // os.tmpdir() reads TEMP/TMP (Windows) or TMPDIR at each call, so a test directory can stand in for it.
  test('an existing temp folder is protected under its on-disk spelling, whatever casing the repo path has', { skip: process.platform !== 'win32' && 'case-insensitive file systems only' }, async (t) => {
    const fakeTmp = realpathSync.native(await tempDir(t, 'td-tmp-'));
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = fakeTmp;
    // Created by a session started from C:\fake\repo-name; the evaluation runs from C:\FAKE\Repo-Name.
    const existing = path.join(fakeTmp, 'claude', 'C--fake-repo-name');
    await mkdir(existing, { recursive: true });
    const roots = defaultProtectedRoots('C:\\FAKE\\Repo-Name');
    assert.ok(roots.includes(path.join(fakeTmp, 'claude', 'C--FAKE-Repo-Name')), 'the derived spelling');
    assert.ok(roots.includes(existing), 'the on-disk spelling of the existing folder');
    assert.ok(evalDenyRules(roots).includes(`Read(${rulePath(existing)}/**)`), 'a rule that spells the existing folder exactly');
  });

  test('never cover a workspace, its files, or the evaluation session\'s own Claude Code temp folder', async (t) => {
    const ctx = await context(t);
    const roots = defaultProtectedRoots(REPO_ROOT);
    const rules = evalDenyRules(roots);
    // The live default parent (os.tmpdir()) and the session's own temp folder, named after its cwd.
    const live = path.join(tmpdir(), 'ws-AbC123', 'project');
    for (const p of [live, path.join(live, 'artifacts', 'results.json'), path.join(tempClaude, projectSlug(live)), ctx.workspace.root, ...ctx.workspace.files.map((f) => path.join(ctx.workspace.root, ...f.path.split('/')))]) {
      assert.equal(deniedBy(rules, p), undefined, `${p} must stay readable`);
      assert.ok(!roots.some((r) => isInside(r, p)), `${p} is inside a protected root`);
    }
    for (const p of [path.join(REPO_ROOT, 'evals', 'runs'), path.join(tempClaude, projectSlug(REPO_ROOT), 'session', 'scratchpad', 'copy.json'), path.join(homedir(), '.claude', 'projects')]) {
      assert.ok(deniedBy(rules, p), `${p} must be denied`);
    }
  });

  // The live default parent is os.tmpdir(); nothing is created in the real temp scratch, so the
  // scratch-shaped folder here is built under a test directory.
  test('a workspace container inside a protected Claude Code temp folder is refused', async (t) => {
    const { snapshot } = await fakeSnapshot(t);
    const parent = await tempDir(t, 'td-parent-');
    const scratch = path.join(parent, 'claude', projectSlug(REPO_ROOT));
    await mkdir(scratch, { recursive: true });
    await assert.rejects(createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent: scratch, protectedRoots: [REPO_ROOT, scratch] }, markers), /inside protected path/);
  });

  test('the audit flags protected paths under any casing, separator or relative route, and the temp scratch', async (t) => {
    const ctx = await context(t);
    const scratch = path.join(tempClaude, projectSlug(REPO_ROOT), 'session', 'scratchpad');
    const toRepo = path.relative(ctx.workspace.root, path.join(REPO_ROOT, 'evals', 'runs', 'r', 'score.json'));
    // Alternating case (c:\GiT\TeSt-...): no deny rule spells it, the audit still matches it on Windows.
    const mixed = process.platform === 'win32' ? [...REPO_ROOT].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('') : REPO_ROOT;
    const audit = auditTranscript(
      [
        toolUse('a', 'Read', { file_path: path.join(mixed, 'evals', 'runs', 'r', 'score.json') }),
        toolUse('b', 'Read', { file_path: path.join(REPO_ROOT, 'evals', 'runs').replaceAll('\\', '/') }),
        toolUse('c', 'Read', { file_path: toRepo }),
        toolUse('d', 'Grep', { pattern: 'x', path: scratch }),
        toolUse('e', 'Glob', { pattern: `${scratch.replaceAll('\\', '/')}/**/score.json` }),
        toolUse('f', 'Bash', { command: `ls "${scratch}"` }),
      ],
      ctx,
      markers,
    );
    assert.deepEqual(audit.leaks.map((l) => [l.kind, l.tool]), ['Read', 'Read', 'Read', 'Grep', 'Glob', 'Bash'].map((tool) => ['protected-path', tool]));
  });

  test('the audit leaves workspace evidence alone, and sees an 8.3 short name only as outside the workspace unless its alias is a recorded root', async (t) => {
    const ctx = await context(t);
    const audit = auditTranscript(
      [
        toolUse('a', 'Read', { file_path: 'artifacts/results.json' }),
        toolUse('b', 'Read', { file_path: path.join(ctx.workspace.root, 'tests', 'ui', 'login.spec.ts') }),
        toolUse('c', 'Glob', { pattern: 'test-results/**/*.png' }),
        // An 8.3 short name of the repo (C:\GIT\TEST-D~1) is not resolvable from the transcript.
        toolUse('d', 'Read', { file_path: path.join(path.dirname(REPO_ROOT), 'TEST-D~1', 'evals', 'runs') }),
      ],
      ctx,
      markers,
    );
    assert.deepEqual(audit.leaks, []);
    assert.deepEqual(audit.warnings.map((w) => [w.kind, w.tool]), [['outside-workspace', 'Read']]);
  });
});

describe('8.3 short-name aliases of protected roots (R4b Step 1C)', () => {
  // Answers like GetShortPathName: each component replaced by its short name, null below `missing`.
  function lookup(shorts: Record<string, string>, missing: string[] = []) {
    const calls: string[][] = [];
    const fn: ShortPathLookup = async (paths) => {
      calls.push(paths);
      return paths.map((p) => (missing.some((m) => p.toLowerCase().startsWith(m.toLowerCase())) ? null : p.split('\\').map((c) => shorts[c] ?? c).join('\\')));
    };
    return Object.assign(fn, { calls });
  }
  const deniedBy = (rules: string[], absolute: string) => rules.find((r) => (rulePath(absolute) + '/').toLowerCase().startsWith(r.slice('Read('.length, -'**)'.length).toLowerCase()));

  test('adds the short name of the protected directory itself, with one lookup of every ancestor', async () => {
    const shorts = lookup({ 'protected-answers': 'PROTEC~1' });
    assert.deepEqual(await withShortNameAliases(['C:\\Work\\protected-answers'], shorts), ['C:\\Work\\protected-answers', 'C:\\Work\\PROTEC~1']);
    assert.deepEqual(shorts.calls, [['C:\\Work', 'C:\\Work\\protected-answers']]);
  });

  test('adds the short name of an ancestor, not only of the last component', async () => {
    assert.deepEqual(await withShortNameAliases(['C:\\long-parent-folder\\keys'], lookup({ 'long-parent-folder': 'LONG-P~1' })), ['C:\\long-parent-folder\\keys', 'C:\\LONG-P~1\\keys']);
  });

  test('several short components give every long/short combination, mixed ones included', async () => {
    const root = 'C:\\td-alias-x1\\long-parent-directory\\protected-child-dir';
    const roots = await withShortNameAliases([root], lookup({ 'td-alias-x1': 'TD-ALI~1', 'long-parent-directory': 'LONG-P~1', 'protected-child-dir': 'PROTEC~1' }));
    assert.equal(roots.length, 8);
    assert.equal(new Set(roots.map((r) => r.toLowerCase())).size, 8);
    for (const mixed of ['C:\\TD-ALI~1\\long-parent-directory\\PROTEC~1', 'C:\\td-alias-x1\\LONG-P~1\\protected-child-dir', 'C:\\TD-ALI~1\\LONG-P~1\\PROTEC~1']) assert.ok(roots.includes(mixed), mixed);
    const rules = evalDenyRules(roots);
    for (const r of roots) assert.ok(deniedBy(rules, path.win32.join(r, 'truth.json')), `${r} is denied`);
  });

  test('handles spaces, and rule paths keep them', async () => {
    const roots = await withShortNameAliases(['C:\\a dir with spaces\\keys'], lookup({ 'a dir with spaces': 'ADIRWI~1' }));
    assert.deepEqual(roots, ['C:\\a dir with spaces\\keys', 'C:\\ADIRWI~1\\keys']);
    assert.ok(evalDenyRules(roots).includes('Read(//c/a dir with spaces/keys/**)'));
    assert.ok(evalDenyRules(roots).includes('Read(//c/ADIRWI~1/keys/**)'));
  });

  test('adds nothing when no component has a short name, and never looks up non-drive paths', async () => {
    assert.deepEqual(await withShortNameAliases(['C:\\abc\\def'], lookup({})), ['C:\\abc\\def']);
    const none = lookup({});
    assert.deepEqual(await withShortNameAliases(['/home/me/repo', 'C:\\'], none), ['/home/me/repo', 'C:\\']);
    assert.deepEqual(none.calls, [], 'no lookup without a drive path below the root');
  });

  test('a root that does not exist yet still gets the short names of its existing ancestors', async () => {
    const roots = await withShortNameAliases(['C:\\existing-parent\\not-yet-created'], lookup({ 'existing-parent': 'EXISTI~1' }, ['C:\\existing-parent\\not-yet-created']));
    assert.deepEqual(roots, ['C:\\existing-parent\\not-yet-created', 'C:\\EXISTI~1\\not-yet-created']);
  });

  test('fails closed when the lookup fails or answers something it cannot have meant', async () => {
    const root = 'C:\\Work\\protected-answers';
    await assert.rejects(withShortNameAliases([root], async () => { throw new Error('powershell failed'); }), /powershell failed/);
    const answers: [string, (string | null)[] | unknown][] = [
      ['too few answers', ['C:\\Work']],
      ['not an array', 'C:\\Work'],
      ['a non-string answer', ['C:\\Work', 42]],
      ['another drive', ['D:\\Work', 'D:\\Work\\PROTEC~1']],
      ['another depth', ['C:\\Work', 'C:\\Work\\PROTEC~1\\x']],
      ['a component that is no 8.3 name', ['C:\\Work', 'C:\\Work\\not a short name']],
      ['an ancestor that disagrees with its child', ['C:\\WORK~1', 'C:\\Work\\PROTEC~1']],
      ['a child that exists below a missing ancestor', [null, 'C:\\Work\\PROTEC~1']],
    ];
    for (const [label, answer] of answers) {
      await assert.rejects(withShortNameAliases([root], async () => answer as (string | null)[]), /Short path lookup/, label);
    }
  });

  test(`fails closed beyond ${MAX_ROOT_SPELLINGS} spellings of one root`, async () => {
    const parts = ['component-one', 'component-two', 'component-three', 'component-four', 'component-five', 'component-six', 'component-seven'];
    const shorts = Object.fromEntries(parts.map((p, i) => [p, `COMPON~${i + 1}`]));
    await assert.rejects(withShortNameAliases([`C:\\${parts.join('\\')}`], lookup(shorts)), /More than 64 short-name spellings/);
    assert.equal((await withShortNameAliases([`C:\\${parts.slice(0, 6).join('\\')}`], lookup(shorts))).length, 64);
  });

  test('spellings shared by several roots, or differing only in case, are added once', async () => {
    const roots = await withShortNameAliases(['C:\\GIT\\test-detective', 'C:\\git\\test-detective', 'C:\\GIT\\TEST-D~1'], lookup({ 'test-detective': 'TEST-D~1' }));
    assert.deepEqual(roots, ['C:\\GIT\\test-detective', 'C:\\git\\test-detective', 'C:\\GIT\\TEST-D~1']);
    const rules = evalDenyRules(roots);
    assert.equal(new Set(rules).size, rules.length);
  });

  test('the real default roots with their short names never cover the workspace or the session temp folder', async (t) => {
    const ctx = await context(t);
    const shorts = lookup({ 'test-detective': 'TEST-D~1', '.claude': 'CLAUDE~1', [projectSlug(REPO_ROOT)]: 'C--GIT~1', 'AppData': 'APPDAT~1' });
    const roots = await withShortNameAliases(defaultProtectedRoots(REPO_ROOT), shorts);
    const rules = evalDenyRules(roots);
    const live = path.join(tmpdir(), 'ws-AbC123', 'project');
    for (const p of [live, path.join(tmpdir(), 'claude', projectSlug(live)), ctx.workspace.root, ...ctx.workspace.files.map((f) => path.join(ctx.workspace.root, ...f.path.split('/')))]) {
      assert.equal(deniedBy(rules, p), undefined, `${p} must stay readable`);
    }
    if (process.platform === 'win32') {
      assert.ok(deniedBy(rules, path.join(path.dirname(REPO_ROOT), 'TEST-D~1', 'evals', 'runs')), 'the repo by its short name');
      assert.ok(deniedBy(rules, path.join(homedir(), 'CLAUDE~1', 'projects')), '~/.claude by its short name');
    }
  });

  test('the audit recognizes a protected root under its recorded short name', async (t) => {
    const { snapshot } = await fakeSnapshot(t);
    const parent = await tempDir(t, 'td-parent-');
    const shortRepo = path.join(path.dirname(REPO_ROOT), 'TEST-D~1');
    const workspace = await createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent, protectedRoots: [REPO_ROOT, shortRepo] }, markers);
    t.after(() => removeWorkspace(workspace));
    const audit = auditTranscript(
      [
        toolUse('a', 'Read', { file_path: path.join(shortRepo, 'evals', 'runs') }),
        toolUse('b', 'Grep', { pattern: 'x', path: shortRepo.toLowerCase() }),
        toolUse('c', 'Read', { file_path: 'artifacts/results.json' }),
      ],
      { workspace },
      markers,
    );
    assert.deepEqual(audit.leaks.map((l) => [l.kind, l.tool]), [['protected-path', 'Read'], ['protected-path', 'Grep']]);
  });
});

describe('session options', () => {
  test('differ from a normal npm run investigate in exactly cwd, MCP repo root and added deny rules', async (t) => {
    const ctx = await context(t);
    const { baseline, evaluation } = sessionOptions(args(), ctx, ENV);
    const diffs = diffOptions(baseline, evaluation);
    assert.deepEqual(diffs.map((d) => d.path), ['cwd', `mcpServers.${MCP_SERVER}.env`, 'settings.permissions.deny']);
    assert.equal(baseline.cwd, REPO_ROOT);
    assert.equal(evaluation.cwd, ctx.workspace.root);
    const server = evaluation.mcpServers![MCP_SERVER] as { command: string; args: string[]; env: Record<string, string> };
    assert.deepEqual(server.args, [path.join(REPO_ROOT, 'src', 'mcp', 'main.ts'), '--enable-trace-summary'], 'same production server file and opt-in');
    assert.deepEqual(server.env, { TEST_DETECTIVE_REPO_ROOT: ctx.workspace.root });
  });

  test('never widen the permission surface', async (t) => {
    const ctx = await context(t);
    const { baseline, evaluation } = sessionOptions(args(), ctx, ENV);
    for (const key of ['tools', 'allowedTools', 'disallowedTools', 'permissionMode', 'settingSources', 'strictMcpConfig', 'skills', 'persistSession', 'maxTurns', 'outputFormat', 'systemPrompt', 'env'] as const) {
      assert.deepEqual(evaluation[key], baseline[key], `${key} unchanged`);
    }
    const settings = (o: Options) => o.settings as { permissions: { deny: string[] }; autoMemoryEnabled: boolean; disableSkillShellExecution: boolean };
    const before = settings(baseline).permissions.deny;
    const after = settings(evaluation).permissions.deny;
    assert.deepEqual(after.slice(0, before.length), before, 'production deny rules kept, in order');
    assert.deepEqual(after.slice(before.length), evalDenyRules(ctx.workspace.protectedRoots), 'only Read deny rules added');
    assert.ok(after.slice(before.length).every((r) => r.startsWith('Read(')), 'every added rule is a Read deny rule');
    assert.ok(after.includes(`Read(${rulePath(path.join(tmpdir(), 'claude', projectSlug(REPO_ROOT)))}/**)`), "this repo's Claude Code temp folder is denied");
    assert.equal(settings(evaluation).autoMemoryEnabled, false);
    assert.equal(settings(evaluation).disableSkillShellExecution, true);
  });

  test('adaptOptions refuses options that do not look like production output', async (t) => {
    const ctx = await context(t);
    const { evaluation } = sessionOptions(args(), ctx, ENV);
    const production = { ...evaluation, mcpServers: { [MCP_SERVER]: { type: 'stdio' as const, command: process.execPath, args: [path.join(ctx.workspace.root, 'src', 'mcp', 'main.ts'), '--enable-trace-summary'] } } };
    // A server without the production opt-in is not production output.
    assert.throws(() => adaptOptions({ ...production, mcpServers: { [MCP_SERVER]: { ...production.mcpServers[MCP_SERVER], args: [path.join(ctx.workspace.root, 'src', 'mcp', 'main.ts')] } } }, ctx), /Unexpected test-detective server config/);
    assert.doesNotThrow(() => adaptOptions(production, ctx));
    assert.throws(() => adaptOptions({ ...production, cwd: REPO_ROOT }, ctx), /Expected cwd/);
    assert.throws(() => adaptOptions({ ...production, strictMcpConfig: false }, ctx), /strictMcpConfig/);
    assert.throws(() => adaptOptions({ ...production, mcpServers: { ...production.mcpServers, other: { command: 'x' } } }, ctx), /only the test-detective/);
    assert.throws(() => adaptOptions(evaluation, ctx), /Unexpected test-detective server config/, 'already adapted (env set)');
    assert.throws(() => adaptOptions({ ...production, settings: '/tmp/settings.json' }, ctx), /object/);
  });

  test('the recorded differences list every change and never include env values', async (t) => {
    const ctx = await context(t);
    const differences = describeDifferences(args(), ctx, ENV);
    assert.deepEqual(differences.options.map((d) => d.path), ['cwd', `mcpServers.${MCP_SERVER}.env`, 'settings.permissions.deny']);
    assert.deepEqual(
      differences.environment.map((e) => e.id),
      ['cwd-contents', 'claude-md', '.claude/skills/investigate-failure/SKILL.md', '.claude/settings.json', 'report', 'mcp-server', 'git', 'working-tree-check'],
    );
    assert.ok(!JSON.stringify(differences).includes('super-secret-value'));
  });

  test('diffOptions reports env changes by variable name only', () => {
    const diffs = diffOptions({ env: { A: '1', B: 'secret-1' } }, { env: { A: '1', B: 'secret-2', C: 'secret-3' } });
    assert.deepEqual(diffs, [{ path: 'env', baseline: '2 variables', evaluation: 'changed: B, C' }]);
  });
});

describe('evalQuery with the unchanged runInvestigation', () => {
  test('runs against the workspace, adapts options and records the whole stream', async (t) => {
    const ctx = await context(t);
    const { query, state } = fakeQuery({ messages: investigatedStream([LOGIN]) });
    const recorded: SDKMessage[] = [];
    const result = await runInvestigation(args(), { repoRoot: ctx.workspace.root, query: evalQuery(query, ctx, (m) => recorded.push(m)), env: {} });
    assert.equal(result.runStatus, 'completed', result.issues.join('; '));
    const expected = sessionOptions(args(), ctx, {}).evaluation;
    assert.deepEqual(diffOptions(expected, state.options!), [], 'the SDK received exactly the evaluation options');
    assert.deepEqual(recorded, investigatedStream([LOGIN]), 'every message recorded, in order');
    assert.equal(state.closed, 1);
  });
});

describe('auditTranscript', () => {
  const assistant = (...blocks: SDKMessage[]) => blocks;

  test('a normal investigation inside the workspace is clean', async (t) => {
    const ctx = await context(t);
    const root = ctx.workspace.root;
    const messages = [
      { ...init(), cwd: root } as SDKMessage,
      ...skillCall(),
      ...call('m1', MCP_LIST, {}, '{}'),
      ...call('m2', MCP_DETAILS, { testId: LOGIN.testId }, '{}'),
      toolUse('r1', 'Read', { file_path: path.join(root, 'tests', 'ui', 'login.spec.ts') }),
      toolUse('r2', 'Read', { file_path: 'test-results/ui-login-signs-in-chromium/error-context.md' }),
      toolUse('b1', 'Bash', { command: "unzip -p test-results/x/trace.zip '*.network' | grep -oE '\"url\":\"[^\"]*\"|\"_wasFulfilled\":true' | head -n 40" }),
      toolUse('b2', 'Bash', { command: 'ls -l --time-style=full-iso tests/ui/login.spec.ts' }),
      toolUse('g1', 'Glob', { pattern: 'test-results/**/*.md' }),
    ];
    const audit = auditTranscript(messages, ctx, markers);
    assert.deepEqual(audit.leaks, []);
    assert.deepEqual(audit.warnings, []);
    assert.equal(audit.toolCallsAudited, 8, 'Skill, two MCP calls, two Reads, two Bash, one Glob');
  });

  test('flags a canary anywhere, including tool results, without printing it', async (t) => {
    const ctx = await context(t);
    const audit = auditTranscript(call('r', 'Read', { file_path: 'tests/ui/login.spec.ts' }, `text ${canary}`), ctx, markers);
    assert.equal(audit.leaked, true);
    assert.deepEqual(audit.leaks.map((l) => l.kind), ['canary']);
    assert.ok(!JSON.stringify(audit).includes(canary));
  });

  test('flags tool inputs that reach protected roots', async (t) => {
    const ctx = await context(t);
    const msys = `/${REPO_ROOT[0]!.toLowerCase()}${REPO_ROOT.slice(2).replaceAll('\\', '/')}/README.md`;
    const messages = assistant(
      toolUse('a', 'Read', { file_path: path.join(REPO_ROOT, 'CLAUDE.md') }),
      toolUse('b', 'Grep', { pattern: 'x', path: path.join(REPO_ROOT, 'src') }),
      toolUse('c', 'Glob', { pattern: `${REPO_ROOT.replaceAll('\\', '/')}/**/*.ts` }),
      toolUse('d', 'Bash', { command: `grep -r expected "${path.join(REPO_ROOT, 'src')}" | head -n 5` }),
      toolUse('e', 'Read', { file_path: '~/.claude/plans/x.md' }),
      toolUse('f', 'Bash', { command: `head -n 3 ${msys}` }),
    );
    const audit = auditTranscript(messages, ctx, markers);
    const byTool = audit.leaks.filter((l) => l.kind === 'protected-path').map((l) => l.tool);
    assert.deepEqual(byTool, ['Read', 'Grep', 'Glob', 'Bash', 'Read', ...(process.platform === 'win32' ? ['Bash'] : [])]);
  });

  test('flags references to eval-only files even with relative paths', async (t) => {
    const ctx = await context(t);
    const audit = auditTranscript(assistant(toolUse('a', 'Glob', { pattern: '**/truth.json' }), toolUse('b', 'Bash', { command: 'ls generation.json' })), ctx, markers);
    assert.deepEqual(audit.leaks.map((l) => [l.kind, l.tool]), [
      ['eval-reference', 'Glob'],
      ['eval-reference', 'Bash'],
    ]);
  });

  test('warns about paths outside the workspace, unresolvable expansions, unexpected tools and a wrong cwd', async (t) => {
    const ctx = await context(t);
    const elsewhere = path.join(path.dirname(ctx.workspace.container), 'elsewhere.txt');
    const messages = [
      init(),
      toolUse('a', 'Bash', { command: 'cat ../../other/file.txt' }),
      toolUse('b', 'Read', { file_path: elsewhere }),
      toolUse('c', 'Bash', { command: 'ls $HOME/.claude' }),
      toolUse('d', 'Bash', { command: 'ls %USERPROFILE%' }),
      toolUse('e', 'WebFetch', { url: 'https://example.com' }),
    ];
    const audit = auditTranscript(messages, ctx, markers);
    assert.equal(audit.leaked, false);
    assert.deepEqual(audit.warnings.map((w) => [w.kind, w.tool]), [
      ['cwd', null],
      ['outside-workspace', 'Bash'],
      ['outside-workspace', 'Read'],
      ['unresolved-path', 'Bash'],
      ['unresolved-path', 'Bash'],
      ['unexpected-tool', 'WebFetch'],
    ]);
  });

  test('a WebFetch call stays unexpected even in an outputFormat session', async (t) => {
    const ctx = await context(t);
    const audit = auditTranscript([init({ tools: ['WebFetch', STRUCTURED_OUTPUT_TOOL] }), toolUse('w', 'WebFetch', { url: 'https://example.com' })], { ...ctx, outputFormat: true }, markers);
    assert.deepEqual(audit.warnings.map((w) => [w.kind, w.tool]), [['cwd', null], ['unexpected-tool', 'WebFetch']]);
    assert.deepEqual(audit.expected, []);
  });

  test('shellTokens honors quotes and splits on shell operators', () => {
    assert.deepEqual(shellTokens(`unzip -p "a b/trace.zip" '*.network'|grep -E 'x|y' >out;ls`), ['unzip', '-p', 'a b/trace.zip', '*.network', 'grep', '-E', 'x|y', 'out', 'ls']);
  });
});

describe('auditTranscript: variables a Bash command assigns itself', () => {
  const TRACE = 'test-results/ui-profile-shows-the-signed-in-user-on-the-profile-page-chromium/trace.zip';
  const audit = async (t: TestContext, command: string | ((root: string) => string)) => {
    const ctx = await context(t);
    const text = typeof command === 'string' ? command : command(ctx.workspace.root);
    return auditTranscript([toolUse('b', 'Bash', { command: text })], ctx, markers);
  };
  const kinds = (a: { leaks: { kind: string }[]; warnings: { kind: string }[] }) => [...a.leaks, ...a.warnings].map((f) => f.kind);

  test('an unconditional literal assignment is audited as the literal: clean inside the workspace', async (t) => {
    for (const command of [
      `T=${TRACE}; unzip -l $T; unzip -p "\${T}" '*.network' | head -n 5`,
      `D=test-results/x\nls $D/trace.zip && unzip -l "$D/trace.zip"`,
      `T=${TRACE} && unzip -l $T`,
    ]) {
      assert.deepEqual(kinds(await audit(t, command)), [], command);
    }
  });

  test('the S04 command: assigned after cd ... &&, so each of the three references stays a conditional-expansion warning', async (t) => {
    // Verbatim shape of the denied Bash call in the live S04 run, with this test's workspace.
    const a = await audit(
      t,
      (root) =>
        `cd "${root.replaceAll('\\', '/')}" && T=${TRACE}; unzip -l $T; echo ---; unzip -p $T '*.network' | grep -oE '"url":"[^"]*"|"status":\\s*[0-9]{3}|"_wasFulfilled":true|"failure"' | head -n 40; echo ---; unzip -p $T '*.trace' | grep -E '"error"|"console"|pageError' | head -n 30 | cut -c1-400`,
    );
    assert.deepEqual(kinds(a), ['conditional-expansion', 'conditional-expansion', 'conditional-expansion']);
    assert.match(a.warnings[0]!.detail, /^\$T is assigned only after && \(T=test-results\/.*\); if an earlier step failed it expands to an inherited value$/);
  });

  test('a resolved value gets the same checks as the literal: outside the workspace, protected roots', async (t) => {
    assert.deepEqual(kinds(await audit(t, 'T=../../other/file.txt; cat $T')), ['outside-workspace']);
    const a = await audit(t, `T=${path.join(REPO_ROOT, 'CLAUDE.md').replaceAll('\\', '/')}; cat $T`);
    assert.deepEqual(kinds(a), ['protected-path'], 'the substituted reference reaches the repo');
  });

  test('anything the narrow rule does not cover stays unresolved', async (t) => {
    for (const command of [
      'cat $T; T=a.txt', // reference before the assignment sees the inherited value
      'T=a.txt; T=b.txt; cat $T', // reassigned
      'T=a.txt; T+=x; cat $T',
      'export T=a.txt; cat $T',
      'T=a.txt; export T; cat $T',
      'read T; cat $T',
      'for T in a.txt; do cat $T; done',
      'T=a.txt cat $T', // a prefix assignment applies to cat only; $T is expanded before it
      '(T=a.txt); cat $T', // subshell
      'true | T=a.txt; cat $T', // pipeline
      'T=a.txt & cat $T', // background job
      'false || T=a.txt; cat $T', // runs only if the previous step failed
      '{ T=a.txt; }; cat $T',
      'if true; then T=a.txt; fi; cat $T',
      'echo $(T=a.txt; echo); cat $T',
      'T=$HOME/x; cat $T',
      'T=~/x; cat $T',
      'T="a b"; cat $T', // would word-split
      'T=*.zip; cat $T', // would glob
      'T=a.txt; cat `echo $T`',
      'eval "$X"; T=a.txt; cat $T',
      'source ./env.sh; T=a.txt; cat $T',
      'T=a.txt; cat ${T:-/etc/passwd}',
      'T=a.txt; cat $U',
      'T=a.txt; cat $T/$U',
      'T=a.txt; grep T $T', // another mention of T
    ]) {
      const k = kinds(await audit(t, command));
      assert.ok(k.includes('unresolved-path'), `${command}: ${JSON.stringify(k)}`);
    }
  });

  test('shellAssignments records value, statement position and whether it is conditional', () => {
    assert.deepEqual([...shellAssignments('cd x && T=a.txt; unzip -l $T')], [['T', { value: 'a.txt', conditional: true, index: 3 }]]);
    assert.deepEqual([...shellAssignments('T=a.txt\nunzip -l $T')], [['T', { value: 'a.txt', conditional: false, index: 0 }]]);
    assert.deepEqual([...shellAssignments('T=a; T=b; cat $T')], []);
  });
});

describe('auditTranscript: StructuredOutput, the SDK outputFormat tool', () => {
  // Real events from the first live S02 run (Claude Code 2.1.302), verbatim except a trimmed init
  // and synthetic session, message, request, uuid and tool-use IDs: the first call's input could not
  // be parsed as JSON and came back as an InputValidationError result; the model retried and the
  // second call was accepted. Scorer v3 flagged both calls as unexpected tools.
  const FIRST = 'toolu_fixture01';
  const SECOND = 'toolu_fixture02';
  async function recorded(root: string): Promise<any[]> {
    const text = await readFile(new URL('./fixtures/structured-output-retry.jsonl', import.meta.url), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((m) => (m.type === 'system' ? { ...m, cwd: root } : m));
  }

  test('the fixture is the real retry: announced at init, one rejected call, one accepted call', async (t) => {
    const messages = await recorded((await context(t)).workspace.root);
    assert.ok(messages[0].tools.includes(STRUCTURED_OUTPUT_TOOL));
    const results = messages.filter((m) => m.type === 'user').map((m) => m.message.content[0]);
    assert.deepEqual(results.map((r) => [r.tool_use_id, r.is_error === true]), [[FIRST, true], [SECOND, false]]);
    assert.match(results[0].content, /InputValidationError/);
  });

  test('both calls are expected entries, not warnings, when the session ran with an output format', async (t) => {
    const ctx = await context(t);
    const audit = auditTranscript(await recorded(ctx.workspace.root), { ...ctx, outputFormat: true }, markers);
    assert.deepEqual(audit.warnings, []);
    assert.deepEqual(audit.leaks, []);
    assert.deepEqual(audit.expected.map((e) => [e.kind, e.tool, e.toolUseId]), [
      ['structured-output', STRUCTURED_OUTPUT_TOOL, FIRST],
      ['structured-output', STRUCTURED_OUTPUT_TOOL, SECOND],
    ]);
    assert.equal(audit.toolCallsAudited, 2);
  });

  test('without a recorded output format, StructuredOutput stays an unexpected tool (fails closed)', async (t) => {
    const ctx = await context(t);
    for (const outputFormat of [undefined, false]) {
      const audit = auditTranscript(await recorded(ctx.workspace.root), { ...ctx, outputFormat }, markers);
      assert.deepEqual(audit.warnings.map((w) => [w.kind, w.toolUseId]), [['unexpected-tool', FIRST], ['unexpected-tool', SECOND]]);
      assert.match(audit.warnings[0]!.detail, /not recorded as running with an output format/);
      assert.deepEqual(audit.expected, []);
    }
  });

  test('a StructuredOutput call the session init did not announce is unexpected', async (t) => {
    const ctx = await context(t);
    const messages = await recorded(ctx.workspace.root);
    messages[0].tools = messages[0].tools.filter((n: string) => n !== STRUCTURED_OUTPUT_TOOL);
    const audit = auditTranscript(messages, { ...ctx, outputFormat: true }, markers);
    assert.deepEqual(audit.warnings.map((w) => w.detail), Array(2).fill('StructuredOutput called, but the session init did not announce it'));
  });

  test('a StructuredOutput call inside a subagent is unexpected', async (t) => {
    const ctx = await context(t);
    const messages = await recorded(ctx.workspace.root);
    messages.find((m) => m.type === 'assistant' && m.message.content[0].id === SECOND).parent_tool_use_id = 'toolu_agent';
    const audit = auditTranscript(messages, { ...ctx, outputFormat: true }, markers);
    assert.deepEqual(audit.warnings.map((w) => [w.toolUseId, w.detail]), [[SECOND, 'StructuredOutput called inside a subagent, not by the session itself']]);
    assert.deepEqual(audit.expected.map((e) => e.toolUseId), [FIRST]);
  });

  test('its input still gets the leak checks', async (t) => {
    const ctx = await context(t);
    const messages = await recorded(ctx.workspace.root);
    const call = messages.find((m) => m.type === 'assistant' && m.message.content[0].id === SECOND);
    call.message.content[0].input.message += ' (see truth.json)';
    const audit = auditTranscript(messages, { ...ctx, outputFormat: true }, markers);
    assert.deepEqual(audit.leaks.map((l) => [l.kind, l.tool, l.toolUseId]), [['eval-reference', STRUCTURED_OUTPUT_TOOL, SECOND]]);
  });
});
