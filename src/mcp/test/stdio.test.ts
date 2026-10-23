import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { makeRepo, snapshotTree } from './helpers.ts';
import { ORIGIN, pageTrace, resource, RESULT_DIR, T0, traceReport } from './traces.ts';

// Same command .mcp.json uses, so this exercises the real entry point over real stdio.
const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));
const NODE_ARGS = [MAIN];

describe('stdio server', () => {
  test('initialize, discover, call and close with the SDK client', async (t) => {
    const root = await makeRepo(t, { fixture: 'one-failure' });
    const before = await snapshotTree(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: NODE_ARGS,
      env: { ...getDefaultEnvironment(), TEST_DETECTIVE_REPO_ROOT: root },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => (stderr += chunk));
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);

    assert.equal(client.getServerVersion()?.name, 'test-detective');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_failure_details', 'list_test_failures']);

    const list = await client.callTool({ name: 'list_test_failures', arguments: {} });
    const testId = (list.structuredContent as { failures: { testId: string }[] }).failures[0]!.testId;
    const details = await client.callTool({ name: 'get_failure_details', arguments: { testId } });
    assert.notEqual(details.isError, true);

    await client.close();
    assert.match(stderr, /listening on stdio/, 'logs go to stderr');
    assert.deepEqual(await snapshotTree(root), before, 'no files written');
  });

  test('--enable-trace-summary adds the third tool over real stdio', async (t) => {
    const trace = `${RESULT_DIR}/trace.zip`;
    const root = await makeRepo(t, { raw: traceReport([{ status: 'failed', trace }]), files: { [trace]: pageTrace([], [], [resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 200 })]) } });
    const before = await snapshotTree(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...NODE_ARGS, '--enable-trace-summary'],
      env: { ...getDefaultEnvironment(), TEST_DETECTIVE_REPO_ROOT: root },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => (stderr += chunk));
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_failure_details', 'get_trace_summary', 'list_test_failures']);
    const list = await client.callTool({ name: 'list_test_failures', arguments: {} });
    const testId = (list.structuredContent as { failures: { testId: string }[] }).failures[0]!.testId;
    const summary = await client.callTool({ name: 'get_trace_summary', arguments: { testId, retry: 0 } });
    assert.notEqual(summary.isError, true);
    assert.equal((summary.structuredContent as { trace: { status: string } }).trace.status, 'ok');
    await client.close();
    assert.match(stderr, /get_trace_summary enabled/);
    assert.deepEqual(await snapshotTree(root), before, 'no files written');
  });

  test('stdout carries only JSON-RPC messages and the server exits on stdin EOF', async (t) => {
    const root = await makeRepo(t, { fixture: 'multiple-failures' });
    const child = spawn(process.execPath, NODE_ARGS, {
      env: { ...process.env, TEST_DETECTIVE_REPO_ROOT: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

    const lastResponse = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('"id":4')) resolve();
      });
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_test_failures', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_failure_details', arguments: { testId: 'nope' } } });
    await lastResponse;

    child.stdin.end();
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, `exit code (stderr: ${stderr})`);

    const lines = stdout.split('\n').filter((line) => line.trim() !== '');
    assert.ok(lines.length >= 4);
    const messages = lines.map((line) => {
      assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line.slice(0, 80)}`);
      return JSON.parse(line);
    });
    for (const message of messages) assert.equal(message.jsonrpc, '2.0');

    const byId = new Map(messages.map((m) => [m.id, m]));
    assert.equal(byId.get(1)?.result?.serverInfo?.name, 'test-detective');
    assert.equal(byId.get(2)?.result?.tools?.length, 2);
    assert.equal(byId.get(3)?.result?.structuredContent?.failureCount, 5);
    assert.equal(byId.get(4)?.result?.isError, true);
    assert.equal(byId.get(4)?.result?.structuredContent, undefined, 'error results carry no structuredContent');
    assert.equal(JSON.parse(byId.get(4)?.result?.content?.[0]?.text).error.code, 'INVALID_TEST_ID');
    assert.match(stderr, /listening on stdio/);
  });
});
