import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { createServer } from '../server.ts';
import { makeRepo, PNG_BYTES, put, readFixture, snapshotTree } from './helpers.ts';
import { call, ORIGIN, pageTrace, resource, RESULT_DIR, SPEC_ID, T0, traceReport } from './traces.ts';

const LOGIN_DIR = 'test-results/ui-login-logs-in-with-valid-credentials-chromium';

async function connect(t: TestContext, repoRoot: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ repoRoot });
  const client = new Client({ name: 'test-harness', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

type Structured = Record<string, any>;

/** Successful result: validated structuredContent, mirrored as a single text block. */
function structured(result: CallToolResult): Structured {
  assert.notEqual(result.isError, true, `unexpected tool error: ${JSON.stringify(result.content)}`);
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object', 'has structuredContent');
  // Every content block is text, and the text mirrors structuredContent.
  assert.equal(result.content.length, 1);
  const [block] = result.content;
  assert.equal(block?.type, 'text');
  assert.deepEqual(JSON.parse((block as { text: string }).text), result.structuredContent);
  return result.structuredContent as Structured;
}

type ToolError = { code: string; message: string; hint: string };

/** Error result: isError, no structuredContent, and { error: { code, message, hint } } as JSON text. */
function toolError(result: CallToolResult): ToolError {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined, 'error results carry no structuredContent');
  assert.equal(result.content.length, 1);
  const [block] = result.content;
  assert.equal(block?.type, 'text');
  const { error } = JSON.parse((block as { text: string }).text);
  for (const key of ['code', 'message', 'hint'] as const) {
    assert.equal(typeof error?.[key], 'string', `error.${key} is a string`);
    assert.ok(error[key].length > 0, `error.${key} is not empty`);
  }
  return error;
}

function errorCode(result: CallToolResult): string {
  return toolError(result).code;
}

describe('tool discovery', () => {
  test('lists both tools with schemas and read-only annotations', async (t) => {
    const client = await connect(t, await makeRepo(t));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_failure_details', 'list_test_failures']);

    for (const tool of tools) {
      assert.ok(tool.title && tool.description, `${tool.name} has title and description`);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.equal(tool.outputSchema?.type, 'object');
    }

    const list = tools.find((tool) => tool.name === 'list_test_failures')!;
    assert.equal(list.inputSchema.type, 'object');
    assert.deepEqual(Object.keys(list.inputSchema.properties ?? {}), []);

    const details = tools.find((tool) => tool.name === 'get_failure_details')!;
    assert.deepEqual(details.inputSchema.required, ['testId']);
    assert.deepEqual(Object.keys(details.inputSchema.properties ?? {}), ['testId']);
    assert.ok((details.outputSchema?.required as string[]).includes('attempts'));
  });
});

describe('tool execution', () => {
  test('list then details returns structured, text-only results with no binaries', async (t) => {
    const root = await makeRepo(t, {
      fixture: 'one-failure',
      files: { [`${LOGIN_DIR}/test-failed-1.png`]: PNG_BYTES, [`${LOGIN_DIR}/trace.zip`]: PNG_BYTES },
    });
    const client = await connect(t, root);

    const list = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    assert.equal(list.failureCount, 1);
    const testId = list.failures[0].testId;

    const result = await client.callTool({ name: 'get_failure_details', arguments: { testId } });
    assert.notEqual(result.isError, true);
    const details = structured(result);
    assert.equal(details.testId, testId);
    const screenshot = details.attempts[0].attachments.find((a: Structured) => a.name === 'screenshot');
    assert.equal(screenshot.exists, true);

    const wire = JSON.stringify(result);
    assert.ok(!wire.includes(PNG_BYTES.toString('base64')), 'no attachment bytes in the response');
    assert.ok(!wire.includes('SU5MSU5FLUJPRFktU0VDUkVU'), 'no inline attachment body in the response');
  });

  test('empty result when nothing failed', async (t) => {
    const client = await connect(t, await makeRepo(t, { fixture: 'no-failures' }));
    const list = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    assert.deepEqual(list.failures, []);
    assert.equal(list.message, 'No failed or flaky tests in this report.');
  });

  test('missing attachments do not fail the tool', async (t) => {
    const client = await connect(t, await makeRepo(t, { fixture: 'one-failure' }));
    const list = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    const result = await client.callTool({ name: 'get_failure_details', arguments: { testId: list.failures[0].testId } });
    assert.notEqual(result.isError, true);
    const files = structured(result).attempts[0].attachments.filter((a: Structured) => a.location === 'repo');
    assert.equal(files.length, 3);
    for (const a of files) assert.equal(a.exists, false);
  });
});

describe('errors', () => {
  test('missing report and malformed JSON are structured tool errors', async (t) => {
    const missing = await connect(t, await makeRepo(t));
    assert.equal(errorCode(await missing.callTool({ name: 'list_test_failures', arguments: {} })), 'REPORT_NOT_FOUND');

    const broken = await connect(t, await makeRepo(t, { raw: 'not json' }));
    const result = await broken.callTool({ name: 'list_test_failures', arguments: {} });
    const error = toolError(result);
    assert.equal(error.code, 'REPORT_MALFORMED_JSON');
    assert.match(error.message, /not valid JSON/);
    assert.match(error.hint, /npm test/);
  });

  test('schema validation rejects missing, wrong-type and oversized testId', async (t) => {
    const client = await connect(t, await makeRepo(t, { fixture: 'one-failure' }));
    for (const args of [{}, { testId: 42 }, { testId: '' }, { testId: 'x'.repeat(201) }]) {
      const result = await client.callTool({ name: 'get_failure_details', arguments: args as Record<string, unknown> });
      assert.equal(result.isError, true, JSON.stringify(args).slice(0, 40));
      assert.match((result.content[0] as { text: string }).text, /Input validation error/);
    }
  });

  test('well-typed but invalid or unknown ids are structured errors', async (t) => {
    const client = await connect(t, await makeRepo(t, { fixture: 'one-failure' }));
    const call = (testId: string) => client.callTool({ name: 'get_failure_details', arguments: { testId } });
    assert.deepEqual(toolError(await call('C:\\Windows\\win.ini')), {
      code: 'INVALID_TEST_ID',
      message: 'testId is not in the format returned by list_test_failures.',
      hint: 'Call list_test_failures and use one of the testId values it returns.',
    });
    const { run } = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    const unknown = toolError(await call(`ffffffffffffffffffff-ffffffffffffffffffff@${run.reportFingerprint}`));
    assert.equal(unknown.code, 'TEST_NOT_FOUND');
    assert.match(unknown.message, /No test with id/);
    const stale = toolError(await call('aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb@000000000000'));
    assert.equal(stale.code, 'REPORT_CHANGED');
    assert.equal(
      stale.message,
      `testId belongs to report 000000000000, but artifacts/results.json is now ${run.reportFingerprint} (it was regenerated).`,
    );
  });

  test('unknown tool is a protocol error', async (t) => {
    const client = await connect(t, await makeRepo(t));
    await assert.rejects(client.callTool({ name: 'run_tests', arguments: {} }), /not found/i);
  });
});

describe('report freshness', () => {
  test('an id from an older report is rejected after the report is regenerated', async (t) => {
    const root = await makeRepo(t, { fixture: 'one-failure' });
    const client = await connect(t, root);
    const before = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    const staleId = before.failures[0].testId;

    // Same test, new run: identical spec id, different report bytes.
    await put(root, 'artifacts/results.json', (await readFixture('one-failure')).replace('16:07:47.973Z', '17:00:00.000Z'));

    const stale = toolError(await client.callTool({ name: 'get_failure_details', arguments: { testId: staleId } }));
    assert.equal(stale.code, 'REPORT_CHANGED');
    assert.match(stale.hint, /list_test_failures/);

    const after = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    assert.notEqual(after.failures[0].testId, staleId);
    const fresh = await client.callTool({ name: 'get_failure_details', arguments: { testId: after.failures[0].testId } });
    assert.notEqual(fresh.isError, true);
  });
});

describe('read-only', () => {
  test('tool calls leave the repository unchanged', async (t) => {
    const root = await makeRepo(t, {
      fixture: 'multiple-failures',
      files: { 'test-results/ui-search-finds-results-chromium/trace.zip': PNG_BYTES },
    });
    const before = await snapshotTree(root);
    const client = await connect(t, root);
    const list = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    for (const failure of list.failures) {
      await client.callTool({ name: 'get_failure_details', arguments: { testId: failure.testId } });
    }
    await client.callTool({ name: 'get_failure_details', arguments: { testId: 'bogus' } });
    assert.deepEqual(await snapshotTree(root), before);
  });
});

describe('get_trace_summary over MCP', () => {
  const TRACE = `${RESULT_DIR}/trace.zip`;

  async function connectTrace(t: TestContext, repoRoot: string): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({ repoRoot, enableTraceSummary: true });
    const client = new Client({ name: 'test-harness', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  const trace = () =>
    pageTrace([{ title: 'Expect "toBeVisible"', method: 'expect', start: T0 + 340, end: T0 + 400, line: 7, error: true }], call('Frame', 'expect', T0 + 345, T0 + 395, { error: true }), [
      resource({ url: `${ORIGIN}/api/profile`, status: 500, start: T0 + 200 }),
    ]);

  test('opt-in: absent by default, listed with a strict testId/retry input when enabled', async (t) => {
    const plain = await connect(t, await makeRepo(t));
    assert.ok(!(await plain.listTools()).tools.some((tool) => tool.name === 'get_trace_summary'));

    const client = await connectTrace(t, await makeRepo(t));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_failure_details', 'get_trace_summary', 'list_test_failures']);
    const tool = tools.find((x) => x.name === 'get_trace_summary')!;
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['retry', 'testId']);
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), ['retry', 'testId']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.match(tool.description ?? '', /does not mean the test created the response/);
    assert.match(tool.description ?? '', /never\s+classifies/);
  });

  test('list, details, trace summary: structured and validated against the output schema', async (t) => {
    const root = await makeRepo(t, { raw: traceReport([{ status: 'failed', trace: TRACE }, { status: 'passed' }]), files: { [TRACE]: trace() } });
    const before = await snapshotTree(root);
    const client = await connectTrace(t, root);
    const { failures } = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    const testId = failures[0].testId;
    const summary = structured(await client.callTool({ name: 'get_trace_summary', arguments: { testId, retry: 0 } }));
    assert.equal(summary.trace.status, 'ok');
    assert.equal(summary.network.requests[0].status, 500);
    assert.equal(structured(await client.callTool({ name: 'get_trace_summary', arguments: { testId, retry: 1 } })).trace.status, 'missing');
    assert.equal(errorCode(await client.callTool({ name: 'get_trace_summary', arguments: { testId, retry: 2 } })), 'ATTEMPT_NOT_FOUND');
    assert.equal(errorCode(await client.callTool({ name: 'get_trace_summary', arguments: { testId: 'C:\\x\\trace.zip', retry: 0 } })), 'INVALID_TEST_ID');
    assert.deepEqual(await snapshotTree(root), before);
  });

  test('input validation rejects paths, extra arguments and bad retries', async (t) => {
    const client = await connectTrace(t, await makeRepo(t, { raw: traceReport([{ status: 'failed', trace: TRACE }]) }));
    const id = `${SPEC_ID}@000000000000`;
    for (const args of [{ testId: id }, { testId: id, retry: -1 }, { testId: id, retry: 1.5 }, { testId: id, retry: '0' }, { testId: id, retry: 100 }, { testId: id, retry: 0, path: 'C:\\Windows\\win.ini' }]) {
      const result = await client.callTool({ name: 'get_trace_summary', arguments: args as Record<string, unknown> });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match((result.content[0] as { text: string }).text, /Input validation error/);
    }
  });

  test('a hostile archive is a result, and the server keeps answering', async (t) => {
    const root = await makeRepo(t, { raw: traceReport([{ status: 'failed', trace: TRACE }]), files: { [TRACE]: Buffer.from('PK\u0005\u0006 not really a zip') } });
    const client = await connectTrace(t, root);
    const { failures } = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    const summary = structured(await client.callTool({ name: 'get_trace_summary', arguments: { testId: failures[0].testId, retry: 0 } }));
    assert.equal(summary.trace.status, 'unsupported');
    assert.equal(structured(await client.callTool({ name: 'list_test_failures', arguments: {} })).failureCount, 1);
  });

  test('concurrent calls are serialized and both answered', async (t) => {
    const root = await makeRepo(t, { raw: traceReport([{ status: 'failed', trace: TRACE }]), files: { [TRACE]: trace() } });
    const client = await connectTrace(t, root);
    const { failures } = structured(await client.callTool({ name: 'list_test_failures', arguments: {} }));
    const args = { testId: failures[0].testId, retry: 0 };
    const [a, b] = await Promise.all([client.callTool({ name: 'get_trace_summary', arguments: args }), client.callTool({ name: 'get_trace_summary', arguments: args })]);
    assert.deepEqual(structured(a), structured(b));
  });
});
