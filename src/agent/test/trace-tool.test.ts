import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ALLOWED_TOOLS, BUILTIN_TOOLS, buildQueryOptions, DISALLOWED_TOOLS, MCP_SERVER, MCP_TOOLS, MCP_TRACE, TRACE_SUMMARY_FLAG } from '../config.ts';
import { args } from './helpers.ts';

// Stage 3.3 authorizes get_trace_summary for investigations: the SDK session, the project's
// .mcp.json (interactive sessions and the failure-investigator subagent), .claude/settings.json and
// the Skill. The server still registers it only with --enable-trace-summary, so a server started
// any other way (npm run mcp, an inspector without the flag) keeps the two original tools.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file: string) => readFile(path.join(REPO, file), 'utf8');
const mcpNames = (list: string[]) => list.filter((t) => t.startsWith(`mcp__${MCP_SERVER}__`));

async function connect(t: { after: (fn: () => Promise<void>) => void }, command: string, serverArgs: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'td-agent-'));
  const transport = new StdioClientTransport({ command, args: serverArgs, env: { ...getDefaultEnvironment(), TEST_DETECTIVE_REPO_ROOT: root }, stderr: 'pipe' });
  const client = new Client({ name: 'agent-surface-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  return client;
}

describe('get_trace_summary: authorized for investigations, unavailable elsewhere', () => {
  test('the SDK session starts the server with the opt-in flag, and that server lists and serves the tool', async (t) => {
    const server = buildQueryOptions(args(), REPO, new AbortController(), { PATH: 'x' }).mcpServers?.[MCP_SERVER];
    assert.ok(server && 'command' in server && 'args' in server);
    assert.deepEqual(server.args, [path.join(REPO, 'src', 'mcp', 'main.ts'), TRACE_SUMMARY_FLAG]);
    const client = await connect(t, server.command, server.args ?? []);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => `mcp__${MCP_SERVER}__${tool.name}`).sort(), [...MCP_TOOLS].sort());
    // The tool runs (and fails closed on an empty workspace with a documented error, not "unknown tool").
    const result = await client.callTool({ name: 'get_trace_summary', arguments: { testId: 'x@000000000000', retry: 0 } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /REPORT_NOT_FOUND/);
  });

  test('a server started without the flag (npm run mcp) neither lists nor serves it', async (t) => {
    const pkg = JSON.parse(await read('package.json'));
    assert.equal(pkg.scripts.mcp, 'node src/mcp/main.ts', 'npm run mcp stays without the flag');
    const client = await connect(t, process.execPath, [path.join(REPO, 'src', 'mcp', 'main.ts')]);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_failure_details', 'list_test_failures']);
    await assert.rejects(client.callTool({ name: 'get_trace_summary', arguments: { testId: 'x@000000000000', retry: 0 } }), /not found/i);
  });

  test('every allow surface names exactly the same three MCP tools', async () => {
    const options = buildQueryOptions(args(), REPO, new AbortController(), { PATH: 'x' });
    assert.deepEqual(mcpNames(options.allowedTools ?? []), MCP_TOOLS);
    const settings = JSON.parse(await read('.claude/settings.json'));
    assert.deepEqual(settings.permissions.allow, MCP_TOOLS, 'project settings allow only the MCP tools');
    const agent = await read('.claude/agents/failure-investigator.md');
    const agentTools = (/^tools: (.+)$/m.exec(agent)?.[1] ?? '').split(', ');
    assert.deepEqual(mcpNames(agentTools), MCP_TOOLS);
    const skill = await read('.claude/skills/investigate-failure/SKILL.md');
    assert.deepEqual(mcpNames((/^allowed-tools: (.+)$/m.exec(skill)?.[1] ?? '').split(', ')), MCP_TOOLS);
    const mcpJson = JSON.parse(await read('.mcp.json'));
    assert.deepEqual(mcpJson.mcpServers[MCP_SERVER].args, ['src/mcp/main.ts', TRACE_SUMMARY_FLAG]);
  });

  test('no new built-in, Bash, write, network or subagent permission came with it', async () => {
    const options = buildQueryOptions(args(), REPO, new AbortController(), { PATH: 'x' });
    assert.deepEqual(BUILTIN_TOOLS, ['Read', 'Grep', 'Glob', 'Bash', 'Skill']);
    assert.deepEqual(
      ALLOWED_TOOLS.filter((tool) => !tool.startsWith('mcp__')),
      ['Read', 'Grep', 'Glob', 'Bash(ls *)'],
    );
    assert.deepEqual(DISALLOWED_TOOLS, ['Edit', 'Write', 'NotebookEdit', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent']);
    assert.equal(options.permissionMode, 'dontAsk');
    assert.ok(ALLOWED_TOOLS.includes(MCP_TRACE));
    const agent = await read('.claude/agents/failure-investigator.md');
    assert.deepEqual((/^tools: (.+)$/m.exec(agent)?.[1] ?? '').split(', ').filter((tool) => !tool.startsWith('mcp__')), ['Read', 'Grep', 'Glob', 'Bash']);
    assert.match(agent, /^disallowedTools: Edit, Write, NotebookEdit, PowerShell$/m);
    assert.match(agent, /^permissionMode: dontAsk$/m);
  });
});
