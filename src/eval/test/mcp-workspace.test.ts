import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { args } from '../../agent/test/helpers.ts';
import { FailureDetailsOutput, ListFailuresOutput } from '../../mcp/report.ts';
import { MCP_SERVER } from '../../agent/config.ts';
import { leakMarkers, sessionOptions } from '../isolation.ts';
import { loadSnapshot, MANIFEST_FILE, SNAPSHOTS_DIR } from '../snapshots.ts';
import type { LoadedSnapshot } from '../snapshots.ts';
import { checkIntegrity, createWorkspace, removeWorkspace } from '../workspace.ts';
import type { Workspace } from '../workspace.ts';
import { fakeSnapshot, tempDir } from './helpers.ts';

// The real, unchanged MCP server over real stdio, launched exactly as the evaluation session
// config says (command, args, env), against a relocated snapshot in a workspace.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
const markers = await leakMarkers();

async function connect(t: TestContext, workspace: Workspace, envOverride?: Record<string, string>): Promise<Client> {
  const { evaluation } = sessionOptions(args(), { repoRoot: REPO_ROOT, workspace }, {});
  const server = evaluation.mcpServers![MCP_SERVER] as { command: string; args: string[]; env: Record<string, string> };
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...getDefaultEnvironment(), ...(envOverride ?? server.env) },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'eval-workspace-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

async function investigateLikeTheSkill(client: Client) {
  const listed = await client.callTool({ name: 'list_test_failures', arguments: {} });
  assert.notEqual(listed.isError, true, JSON.stringify(listed.content));
  const list = ListFailuresOutput.parse(listed.structuredContent);
  const details = [];
  for (const f of list.failures) {
    const result = await client.callTool({ name: 'get_failure_details', arguments: { testId: f.testId } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    details.push(FailureDetailsOutput.parse(result.structuredContent));
  }
  return { list, details };
}

async function checkWorkspace(t: TestContext, snapshot: LoadedSnapshot, requireLocation = false) {
  const workspace = await createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent: await tempDir(t, 'td-parent-') }, markers);
  t.after(() => removeWorkspace(workspace));
  const { list, details } = await investigateLikeTheSkill(await connect(t, workspace));

  assert.equal(list.run.reportPath, 'artifacts/results.json');
  assert.equal(list.run.reportFingerprint, snapshot.manifest.reportFingerprint, 'the server read the snapshot report');
  assert.equal(list.failureCount, 1);
  const [detail] = details;
  assert.ok(detail);
  assert.match(detail.file, /^tests\/ui\/[a-z-]+\.spec\.ts$/);
  for (const attempt of detail.attempts) {
    assert.deepEqual(attempt.attachments.map((a) => a.name).sort(), ['error-context', 'screenshot', 'trace']);
    for (const a of attempt.attachments) {
      assert.equal(a.location, 'repo', `${a.name} maps into the workspace`);
      assert.equal(a.exists, true, `${a.name} exists in the workspace`);
      assert.ok(await stat(path.join(workspace.root, ...a.path!.split('/'))).then((s) => s.isFile()), `${a.path} is a real file`);
    }
    // A timeout's top-level error has no location; Playwright puts it on the additional locator error.
    const locations = [attempt.error?.location, ...attempt.additionalErrors.map((e) => e.location)].filter((l) => l !== null && l !== undefined);
    for (const l of locations) assert.ok(l.file?.startsWith('tests/ui/'), `error location ${l.file} maps into the workspace`);
    if (requireLocation) assert.ok(locations.length > 0, 'the real report records an error location');
  }
  assert.deepEqual(await checkIntegrity(workspace), [], 'the MCP server wrote nothing');
  return { workspace, list };
}

describe('MCP server on a relocated snapshot', () => {
  test('lists the failure and resolves every attachment inside the workspace', async (t) => {
    const { snapshot } = await fakeSnapshot(t);
    await checkWorkspace(t, snapshot);
  });

  test('without the env override the server reads a different root, so the override is what selects the snapshot', async (t) => {
    const { snapshot } = await fakeSnapshot(t);
    const workspace = await createWorkspace(snapshot, { repoRoot: REPO_ROOT, parent: await tempDir(t, 'td-parent-') }, markers);
    t.after(() => removeWorkspace(workspace));
    const other = await tempDir(t, 'td-empty-');
    const client = await connect(t, workspace, { TEST_DETECTIVE_REPO_ROOT: other });
    const listed = await client.callTool({ name: 'list_test_failures', arguments: {} });
    assert.equal(listed.isError, true);
    assert.match(JSON.stringify(listed.structuredContent ?? listed.content), /REPORT_NOT_FOUND/);
  });

  for (const id of ['S02', 'S04', 'S05']) {
    test(`${id} pilot snapshot (if present)`, async (t) => {
      const present = await stat(path.join(SNAPSHOTS_DIR, id, MANIFEST_FILE)).then(() => true, () => false);
      if (!present) return t.skip(`no ${id} snapshot`);
      const { list } = await checkWorkspace(t, await loadSnapshot(id), true);
      assert.equal(list.run.playwrightVersion, '1.64.1');
    });
  }
});
