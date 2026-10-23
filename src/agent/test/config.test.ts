import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { buildPrompt, buildQueryOptions, MCP_DETAILS, MCP_LIST, MCP_TRACE } from '../config.ts';
import { args, REPO_ROOT } from './helpers.ts';

const options = (overrides = {}, env: Record<string, string | undefined> = { PATH: 'x' }) =>
  buildQueryOptions(args(overrides), REPO_ROOT, new AbortController(), env);

describe('buildQueryOptions: permission surface', () => {
  test('only read-oriented built-in tools and Skill exist; edit, shell-variant, web and subagent tools do not', () => {
    const o = options();
    assert.deepEqual(o.tools, ['Read', 'Grep', 'Glob', 'Bash', 'Skill']);
    assert.deepEqual(o.disallowedTools, ['Edit', 'Write', 'NotebookEdit', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent']);
  });

  test('dontAsk with an exact allowlist: three MCP tools and the Skill\'s Bash patterns', () => {
    const o = options();
    assert.equal(o.permissionMode, 'dontAsk');
    assert.deepEqual(o.allowedTools, [
      'Read',
      'Grep',
      'Glob',
      MCP_LIST,
      MCP_DETAILS,
      MCP_TRACE,
      'Bash(unzip -l *)',
      'Bash(unzip -p *)',
      'Bash(grep *)',
      'Bash(head *)',
      'Bash(ls *)',
    ]);
    assert.ok(!o.allowedTools!.some((t) => t === 'Bash' || t === 'Bash(*)' || t.startsWith('mcp__test-detective__*')));
  });

  test('the Skill tool is scoped to investigate-failure by the skills option, never allowed bare', () => {
    const o = options();
    assert.deepEqual(o.skills, ['investigate-failure']);
    assert.ok(!o.allowedTools!.some((t) => t.startsWith('Skill')), 'the SDK derives Skill(investigate-failure) from skills');
    assert.ok(!o.disallowedTools!.includes('Skill'));
  });

  test('deny rules block git, package managers, node, playwright, network tools and rm in every mode', () => {
    const deny = (options().settings as { permissions: { deny: string[] } }).permissions.deny;
    for (const cmd of ['git', 'npm', 'npx', 'node', 'playwright', 'curl', 'wget', 'rm']) assert.ok(deny.includes(`Bash(${cmd} *)`), cmd);
  });

  test('project settings only, no auto memory, no skill shell injection, no persisted session', () => {
    const o = options();
    assert.deepEqual(o.settingSources, ['project']);
    assert.equal((o.settings as Record<string, unknown>).autoMemoryEnabled, false);
    assert.equal((o.settings as Record<string, unknown>).disableSkillShellExecution, true);
    assert.equal(o.persistSession, false);
    assert.deepEqual(o.skills, ['investigate-failure']);
  });

  test('only our MCP server, started with this Node binary, a repo-derived path and the trace-summary opt-in', () => {
    const o = options();
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(Object.keys(o.mcpServers!), ['test-detective']);
    const server = o.mcpServers!['test-detective'] as { type: string; command: string; args: string[] };
    assert.equal(server.type, 'stdio');
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [path.join(REPO_ROOT, 'src', 'mcp', 'main.ts'), '--enable-trace-summary']);
    assert.equal(o.cwd, REPO_ROOT);
  });

  test('bounds: maxTurns always; model and budget only when given', () => {
    const plain = options();
    assert.equal(plain.maxTurns, 30);
    assert.ok(!('model' in plain));
    assert.ok(!('maxBudgetUsd' in plain));
    const bounded = options({ model: 'claude-sonnet-5-5', maxBudgetUsd: 0.25, maxTurns: 10 });
    assert.equal(bounded.model, 'claude-sonnet-5-5');
    assert.equal(bounded.maxBudgetUsd, 0.25);
    assert.equal(bounded.maxTurns, 10);
  });

  test('structured output uses a draft-07 JSON schema with no extra properties', () => {
    const o = options();
    assert.equal(o.outputFormat?.type, 'json_schema');
    const schema = o.outputFormat!.schema as Record<string, unknown>;
    assert.match(String(schema.$schema), /draft-07/);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['status', 'message', 'investigations']);
  });

  test('system prompt appends only the output mapping to the Claude Code preset', () => {
    const sp = options().systemPrompt as { type: string; preset: string; append: string };
    assert.equal(sp.type, 'preset');
    assert.equal(sp.preset, 'claude_code');
    assert.match(sp.append, /structured output/);
    assert.doesNotMatch(sp.append, /Step 1|Step 2|unzip/, 'the investigation procedure stays in the Skill');
  });

  test('system prompt says git is unavailable, and the git deny rule still stands', () => {
    const o = options();
    assert.match((o.systemPrompt as { append: string }).append, /Git commands are unavailable[^\n]*do not attempt them/);
    assert.ok((o.settings as { permissions: { deny: string[] } }).permissions.deny.includes('Bash(git *)'));
  });

  test('env passes through and identifies the client app', () => {
    const o = options({}, { PATH: 'p', HOME: 'h' });
    assert.deepEqual(o.env, { PATH: 'p', HOME: 'h', CLAUDE_AGENT_SDK_CLIENT_APP: 'test-detective/0.1.0' });
  });

  test('inherited Claude Code session variables are removed; configuration variables are kept', () => {
    const inherited = {
      CLAUDECODE: '1',
      CLAUDE_PID: '1234',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/path/to/claude',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token',
    };
    const config = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000', CLAUDE_CONFIG_DIR: '/cfg', MCP_TOOL_TIMEOUT: '30000', HTTPS_PROXY: 'http://proxy', PATH: 'p' };
    const env = options({}, { ...inherited, ...config }).env!;
    for (const name of Object.keys(inherited)) assert.ok(!(name in env), `${name} removed`);
    assert.deepEqual(env, { ...config, CLAUDE_AGENT_SDK_CLIENT_APP: 'test-detective/0.1.0' });
    assert.ok(!JSON.stringify(env).includes('secret-token'));
  });

  test('cleanup does not touch auth variables: those are refused by the preflight, not hidden', () => {
    const env = options({}, { ANTHROPIC_API_KEY: 'k' }).env!;
    assert.equal(env.ANTHROPIC_API_KEY, 'k');
  });

  test('the abort controller is the one we pass in', () => {
    const controller = new AbortController();
    assert.equal(buildQueryOptions(args(), REPO_ROOT, controller, {}).abortController, controller);
  });
});

describe('buildPrompt', () => {
  test('asks for an explicit Skill tool invocation', () => {
    assert.match(buildPrompt(null), /Use the Skill tool to invoke the investigate-failure skill with no arguments/);
  });

  test('the filter is passed as a JSON string', () => {
    assert.match(buildPrompt('check "boxes"'), /with the arguments "check \\"boxes\\""/);
  });
});
