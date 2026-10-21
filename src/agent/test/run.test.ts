import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MCP_DETAILS, MCP_LIST } from '../config.ts';
import { EXIT_CODES } from '../result.ts';
import { runInvestigation } from '../run.ts';
import type { RunDeps } from '../run.ts';
import {
  args,
  call,
  CHECKBOXES,
  detailsPayload,
  errorResult,
  fakeQuery,
  init,
  investigatedStream,
  investigation,
  listPayload,
  LOGIN,
  REPO_ROOT,
  report,
  skillCall,
  SUBSCRIPTION_ACCOUNT,
  success,
} from './helpers.ts';
import type { FakeScript } from './helpers.ts';

async function run(script: FakeScript, overrides: Parameters<typeof args>[0] = {}, deps: Partial<RunDeps> = {}) {
  const fake = fakeQuery(script);
  const result = await runInvestigation(args(overrides), { repoRoot: REPO_ROOT, query: fake.query, env: {}, ...deps });
  return { result, state: fake.state };
}

describe('runInvestigation: successful sessions', () => {
  test('single failure: facts come from observed MCP results, analysis from the model', async () => {
    const { result, state } = await run({ messages: investigatedStream([CHECKBOXES]) }, { filter: 'checkboxes' });
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
    assert.equal(EXIT_CODES[result.runStatus], 0);
    assert.equal(result.reportStatus, 'investigated');
    const [inv] = result.investigations;
    assert.deepEqual(inv!.facts, {
      testId: CHECKBOXES.testId,
      title: 'toggles checkboxes',
      file: 'tests/ui/checkboxes.spec.ts',
      line: 3,
      project: 'chromium',
      outcome: 'unexpected',
      attempts: [{ retry: 0, status: 'failed' }],
    });
    assert.equal(inv!.analysis.classification, 'Test-code defect');
    assert.equal(result.observed.report?.reportFingerprint, 'abc123def456');
    assert.equal(result.observed.skillDiscovered, true);
    assert.equal(result.observed.skillInvoked, true);
    assert.deepEqual(
      result.observed.toolCalls.map((c) => c.name),
      ['Skill', MCP_LIST, MCP_DETAILS, 'Read'],
    );
    // Paths are shown repo-relative, so no personal path leaks into the output.
    assert.ok(!JSON.stringify(result).includes(REPO_ROOT));
    assert.equal(state.prompts.length, 1, 'the prompt was sent once');
    assert.match(JSON.stringify(state.prompts[0]), /investigate-failure skill with the arguments \\"checkboxes\\"/);
    assert.equal(state.closed, 1, 'the session is closed after the result');
  });

  test('auth and usage facts are recorded without secrets; apiKeySource comes from the stream; cost is the SDK estimate', async () => {
    const { result } = await run({ messages: investigatedStream([CHECKBOXES]) });
    assert.deepEqual(result.observed.auth, {
      mode: 'subscription',
      apiKeySource: 'none',
      apiProvider: 'firstParty',
      subscriptionType: 'Claude Pro',
      tokenSource: null,
    });
    assert.doesNotMatch(JSON.stringify(result), /someone@example\.com|Example Org/);
    assert.equal(result.observed.model, 'claude-opus-5-5');
    assert.equal(result.observed.claudeCodeVersion, '2.1.302');
    assert.deepEqual(
      { ...result.usage, durationMs: 0 },
      { numTurns: 7, durationMs: 0, inputTokens: 1500, outputTokens: 200, estimatedUsageCostUsd: 0.0512 },
    );
  });

  test('multiple failures in one session are all checked against observed results', async () => {
    const { result } = await run({ messages: investigatedStream([CHECKBOXES, LOGIN]) });
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
    assert.deepEqual(
      result.investigations.map((i) => i.facts?.title),
      ['toggles checkboxes', 'logs in with valid credentials'],
    );
  });

  test('no failures', async () => {
    const { result } = await run({
      messages: [init(), ...skillCall(), ...call('l', MCP_LIST, {}, listPayload([])), success(report('no_failures'))],
    });
    assert.equal(result.runStatus, 'completed');
    assert.equal(result.reportStatus, 'no_failures');
    assert.equal(result.observed.report?.failureCount, 0);
    assert.deepEqual(result.investigations, []);
  });

  test('no match is accepted only when no listed failure matches the filter', async () => {
    const stream = (status: string) => [init(), ...skillCall('nothing'), ...call('l', MCP_LIST, {}, listPayload([CHECKBOXES])), success(report(status))];
    assert.equal((await run({ messages: stream('no_match') }, { filter: 'nothing' })).result.runStatus, 'completed');
    const wrong = (await run({ messages: stream('no_match') }, { filter: 'checkbox' })).result;
    assert.equal(wrong.runStatus, 'unverified');
    assert.match(wrong.issues.join(), /1 listed failure\(s\) match the filter/);
  });

  test('permission denials are surfaced', async () => {
    const messages = investigatedStream([CHECKBOXES]);
    messages[messages.length - 1] = success(report('investigated', [investigation(CHECKBOXES.testId)]), {
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'git status' } }],
    });
    const { result } = await run({ messages });
    assert.deepEqual(result.observed.permissionDenials, [{ tool: 'Bash', input: 'git status' }]);
  });
});

describe('runInvestigation: consistency with observed data', () => {
  test('a testId the model never fetched is unverified, with no invented facts', async () => {
    const messages = investigatedStream([CHECKBOXES], ['made-up@id']);
    const { result } = await run({ messages });
    assert.equal(result.runStatus, 'unverified');
    assert.equal(EXIT_CODES.unverified, 7);
    assert.match(result.issues.join('\n'), /made-up@id has no observed successful get_failure_details/);
    assert.match(result.issues.join('\n'), /"toggles checkboxes".*was not investigated/);
    assert.equal(result.investigations[0]!.facts, null);
  });

  test('a failure the model skipped is reported', async () => {
    const { result } = await run({ messages: investigatedStream([CHECKBOXES, LOGIN], [CHECKBOXES.testId]) });
    assert.equal(result.runStatus, 'unverified');
    assert.match(result.issues.join(), /logs in with valid credentials/);
  });

  test('a correct-looking report without the Skill invocation is not enough', async () => {
    const messages = investigatedStream([CHECKBOXES]).filter((m) => !JSON.stringify(m).includes('skill-1'));
    const { result } = await run({ messages });
    assert.equal(result.runStatus, 'unverified');
    assert.equal(result.observed.skillInvoked, false);
    assert.match(result.issues.join(), /No successful investigate-failure Skill invocation/);
  });
});

describe('runInvestigation: discovered vs read as a file vs invoked', () => {
  const skillMd = (sep: string) => ['C:', 'repo', 'test-detective', '.claude', 'skills', 'investigate-failure', 'SKILL.md'].join(sep);
  /** The shape of the first live run: Skill discovered, SKILL.md read, both MCP tools used, no Skill call. */
  const readInsteadOfInvoke = (filePath: string) => [
    init(),
    ...call('read-skill', 'Read', { file_path: filePath }, '# Investigate failed Playwright tests'),
    ...investigatedStream([CHECKBOXES]).slice(1).filter((m) => !JSON.stringify(m).includes('skill-1')),
  ];

  for (const [label, sep] of [['Windows', '\\'], ['POSIX', '/']] as const) {
    test(`reading SKILL.md (${label} path) is not an invocation, even with a correct report`, async () => {
      const { result } = await run({ messages: readInsteadOfInvoke(skillMd(sep)) }, { filter: 'checkboxes' });
      assert.equal(result.runStatus, 'unverified');
      assert.equal(result.reportStatus, 'investigated');
      assert.equal(result.observed.skillDiscovered, true);
      assert.equal(result.observed.skillReadAsFile, true);
      assert.equal(result.observed.skillInvoked, false);
      assert.match(result.issues.join('\n'), /No successful investigate-failure Skill invocation/);
      assert.match(result.issues.join('\n'), /read \.claude\/skills\/investigate-failure\/SKILL\.md as a file instead of invoking/);
    });
  }

  test('reading SKILL.md after a real invocation does not hurt', async () => {
    const [first, ...rest] = investigatedStream([CHECKBOXES]);
    const messages = [first!, ...call('read-skill', 'Read', { file_path: skillMd('\\') }, '...'), ...rest];
    const { result } = await run({ messages });
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
    assert.equal(result.observed.skillReadAsFile, true);
    assert.equal(result.observed.skillInvoked, true);
  });

  test('a denied Skill call is not an invocation', async () => {
    const messages = investigatedStream([CHECKBOXES]).map((m) =>
      JSON.stringify(m).includes('"tool_use_id":"skill-1"') ? call('skill-1', 'Skill', { skill: 'investigate-failure' }, 'Permission denied', true)[1]! : m,
    );
    const { result } = await run({ messages });
    assert.equal(result.runStatus, 'unverified');
    assert.equal(result.observed.skillInvoked, false);
    assert.deepEqual(result.observed.toolCalls[0], { name: 'Skill', input: 'investigate-failure', outcome: 'error' });
  });

  test('a Skill call for a different skill does not count', async () => {
    const messages = investigatedStream([CHECKBOXES]).filter((m) => !JSON.stringify(m).includes('skill-1'));
    messages.splice(1, 0, ...call('skill-x', 'Skill', { skill: 'code-review' }, 'Launching skill'));
    const { result } = await run({ messages });
    assert.equal(result.runStatus, 'unverified');
    assert.equal(result.observed.skillInvoked, false);
    assert.equal(result.observed.skillReadAsFile, false);
  });

  for (const skill of ['investigate-failure', '/investigate-failure']) {
    test(`a successful Skill call with skill "${skill}" counts`, async () => {
      const messages = investigatedStream([CHECKBOXES]).map((m) =>
        JSON.stringify(m).includes('"id":"skill-1"') ? call('skill-1', 'Skill', { skill, args: 'checkboxes' }, 'Launching skill')[0]! : m,
      );
      const { result } = await run({ messages }, { filter: 'checkboxes' });
      assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
      assert.equal(result.observed.skillInvoked, true);
    });
  }

  test('discovered but no Skill tool in the session stops the run at init', async () => {
    // The init tools that Claude Code 2.1.302 reported for tools: ['Read', 'Grep', 'Glob', 'Bash'].
    const tools = ['Bash', 'Glob', 'Grep', 'Read', 'StructuredOutput', MCP_DETAILS, MCP_LIST];
    const { result, state } = await run({ messages: [init({ tools }), ...investigatedStream([CHECKBOXES]).slice(1)] });
    assert.equal(result.runStatus, 'session_error');
    assert.equal(result.observed.skillDiscovered, true);
    assert.match(result.issues.join(), /Skill tool is missing from the session/);
    assert.deepEqual(result.observed.toolCalls, [], 'stopped before any tool call was processed');
    assert.equal(state.closed, 1);
  });
});

describe('runInvestigation: consistency checks (continued)', () => {
  test('a report without any observed MCP call is not enough', async () => {
    const { result } = await run({ messages: [init(), ...skillCall(), success(report('no_failures'))] });
    assert.equal(result.runStatus, 'unverified');
    assert.match(result.issues.join(), /No list_test_failures call was observed/);
  });

  test('"no failures" contradicting the observed list is unverified', async () => {
    const { result } = await run({
      messages: [init(), ...skillCall(), ...call('l', MCP_LIST, {}, listPayload([CHECKBOXES])), success(report('no_failures'))],
    });
    assert.equal(result.runStatus, 'unverified');
    assert.match(result.issues.join(), /returned 1/);
  });

  test('a details call that failed does not count as evidence', async () => {
    const messages = [
      init(),
      ...skillCall(),
      ...call('l', MCP_LIST, {}, listPayload([CHECKBOXES])),
      ...call('d', MCP_DETAILS, { testId: CHECKBOXES.testId }, { error: { code: 'REPORT_CHANGED', message: 'm', hint: 'h' } }, true),
      success(report('investigated', [investigation(CHECKBOXES.testId)])),
    ];
    const { result } = await run({ messages });
    assert.equal(result.runStatus, 'unverified');
    assert.equal(result.observed.toolCalls.find((c) => c.name === MCP_DETAILS)?.outcome, 'error');
  });
});

describe('runInvestigation: MCP availability and report errors', () => {
  for (const mcpStatus of ['failed', 'disabled', 'needs-auth', null]) {
    test(`MCP server ${mcpStatus ?? 'absent'} at init stops the run`, async () => {
      const { result, state } = await run({ messages: [init({ mcpStatus }), ...investigatedStream([CHECKBOXES]).slice(1)] });
      assert.equal(result.runStatus, 'mcp_unavailable');
      assert.equal(EXIT_CODES[result.runStatus], 4);
      assert.equal(state.closed, 1);
    });
  }

  test('connected server without its tools stops the run', async () => {
    const { result } = await run({ messages: [init({ tools: ['Read', 'Skill'] })] });
    assert.equal(result.runStatus, 'mcp_unavailable');
    assert.match(result.issues.join(), /tools are missing/);
  });

  test('model reports MCP unavailable (tool calls denied) and nothing contradicts it', async () => {
    const messages = [
      init(),
      ...skillCall(),
      ...call('l', MCP_LIST, {}, 'Permission to use mcp__test-detective__list_test_failures has been denied', true),
      success(report('mcp_unavailable', [], 'test-detective MCP server unavailable')),
    ];
    const { result } = await run({ messages });
    assert.equal(result.runStatus, 'mcp_unavailable');
    assert.equal(result.reportStatus, 'mcp_unavailable');
  });

  test('missing report: the list error result backs the report_error status', async () => {
    const messages = [
      init(),
      ...skillCall(),
      ...call('l', MCP_LIST, {}, { error: { code: 'REPORT_NOT_FOUND', message: 'No report', hint: 'Run npm test' } }, true),
      success(report('report_error', [], 'REPORT_NOT_FOUND: run npm test')),
    ];
    const { result } = await run({ messages });
    assert.equal(result.runStatus, 'report_error');
    assert.equal(EXIT_CODES[result.runStatus], 4);
    assert.deepEqual(result.issues, []);
  });

  test('skill not discovered by the SDK stops the run', async () => {
    const { result } = await run({ messages: [init({ skills: ['other-skill'] })] });
    assert.equal(result.runStatus, 'session_error');
    assert.equal(result.observed.skillDiscovered, false);
    assert.match(result.issues.join(), /did not discover the investigate-failure skill/);
  });
});

describe('runInvestigation: authentication (fails closed, before the prompt is sent)', () => {
  for (const [label, account] of [
    ['Console login (API-billed)', { ...SUBSCRIPTION_ACCOUNT, apiKeySource: '/login managed key' }],
    ['API key', { ...SUBSCRIPTION_ACCOUNT, apiKeySource: 'ANTHROPIC_API_KEY' }],
    ['cloud provider', { apiProvider: 'bedrock' as const }],
    ['ineligible plan', { ...SUBSCRIPTION_ACCOUNT, subscriptionType: 'free' }],
    ['no account info', {}],
  ] as const) {
    test(`${label} in subscription mode is refused`, async () => {
      const { result, state } = await run({ account, messages: investigatedStream([CHECKBOXES]) });
      assert.equal(result.runStatus, 'auth_refused');
      assert.equal(EXIT_CODES[result.runStatus], 3);
      assert.equal(state.prompts.length, 0, 'no prompt reached the model');
      assert.equal(state.closed, 1);
    });
  }

  test('env preflight refuses before the SDK is even started', async () => {
    const { result, state } = await run({ messages: [] }, {}, { env: { ANTHROPIC_API_KEY: 'x' } });
    assert.equal(result.runStatus, 'auth_refused');
    assert.equal(state.calls, 0);
  });

});

describe('runInvestigation: apiKeySource confirmed from the stream (abort only, after the prompt)', () => {
  test('account without apiKeySource (the real SDK 0.3.302 shape) proceeds and is confirmed by init', async () => {
    assert.equal(SUBSCRIPTION_ACCOUNT.apiKeySource, undefined);
    const { result, state } = await run({ messages: investigatedStream([CHECKBOXES]) });
    assert.equal(result.runStatus, 'completed', result.issues.join('\n'));
    assert.equal(state.prompts.length, 1);
    assert.equal(result.observed.auth.apiKeySource, 'none', 'recorded from the init message');
  });

  for (const apiKeySource of ['/login managed key', 'ANTHROPIC_API_KEY', 'apiKeyHelper']) {
    test(`init reporting ${apiKeySource} aborts at once and says the prompt may have been sent`, async () => {
      const messages = investigatedStream([CHECKBOXES]);
      messages[0] = init({ apiKeySource });
      const { result, state } = await run({ messages });
      assert.equal(result.runStatus, 'auth_refused');
      assert.equal(EXIT_CODES[result.runStatus], 3);
      assert.match(result.issues.join(), new RegExp(`apiKeySource=${apiKeySource.replace('/', '\\/')}.*may already have been submitted`));
      assert.equal(state.prompts.length, 1, 'the prompt had been sent: this check cannot prevent that');
      assert.equal(state.closed, 1);
      assert.deepEqual(result.observed.toolCalls, [], 'nothing after the init message was processed');
    });
  }

  test('init contradicting an apiKeySource reported at initialization aborts', async () => {
    const { result } = await run({ account: { ...SUBSCRIPTION_ACCOUNT, apiKeySource: 'none' }, messages: [init({ apiKeySource: 'ANTHROPIC_API_KEY' })] });
    assert.equal(result.runStatus, 'auth_refused');
  });

  test('output before any init message aborts: the source was never confirmed', async () => {
    const { result, state } = await run({ messages: investigatedStream([CHECKBOXES]).slice(1) });
    assert.equal(result.runStatus, 'auth_refused');
    assert.match(result.issues.join(), /before reporting its authentication source/);
    assert.equal(state.closed, 1);
  });

  test('api mode: init must report ANTHROPIC_API_KEY', async () => {
    const apiAccount = { apiProvider: 'firstParty' as const, apiKeySource: 'ANTHROPIC_API_KEY' };
    const env = { ANTHROPIC_API_KEY: 'x' };
    const ok = await run({ account: apiAccount, messages: [init({ apiKeySource: 'ANTHROPIC_API_KEY' })] }, { auth: 'api' }, { env });
    assert.notEqual(ok.result.runStatus, 'auth_refused', ok.result.issues.join());
    const bad = await run({ account: apiAccount, messages: [init({ apiKeySource: 'none' })] }, { auth: 'api' }, { env });
    assert.equal(bad.result.runStatus, 'auth_refused');
  });
});

describe('runInvestigation: SDK result messages and errors', () => {
  const prefix = [init(), ...skillCall()];

  for (const subtype of ['error_max_turns', 'error_during_execution', 'error_max_budget_usd']) {
    test(`${subtype} is a session error`, async () => {
      const { result } = await run({ messages: [...prefix, errorResult(subtype, ['limit reached'])] });
      assert.equal(result.runStatus, 'session_error');
      assert.equal(EXIT_CODES[result.runStatus], 5);
      assert.match(result.issues.join(), new RegExp(`${subtype}.*limit reached`));
    });
  }

  test('error_max_structured_output_retries is invalid output', async () => {
    const { result } = await run({ messages: [...prefix, errorResult('error_max_structured_output_retries')] });
    assert.equal(result.runStatus, 'invalid_output');
  });

  test('success with is_error (API error) is a session error', async () => {
    const { result } = await run({ messages: [...prefix, success(undefined, { is_error: true, result: 'API Error: 529 overloaded' })] });
    assert.equal(result.runStatus, 'session_error');
    assert.match(result.issues.join(), /529 overloaded/);
  });

  test('missing structured output', async () => {
    const { result } = await run({ messages: [...prefix, success(undefined)] });
    assert.equal(result.runStatus, 'invalid_output');
    assert.match(result.issues.join(), /no structured output/);
  });

  test('malformed structured output', async () => {
    const { result } = await run({ messages: [...prefix, success({ status: 'investigated', message: 1 })] });
    assert.equal(result.runStatus, 'invalid_output');
    assert.match(result.issues.join(), /failed validation/);
  });

  test('the SDK throwing mid-stream is a session error and still closes', async () => {
    const { result, state } = await run({ messages: prefix, throwError: new Error('Claude Code process exited with code 1') });
    assert.equal(result.runStatus, 'session_error');
    assert.match(result.issues.join(), /process exited with code 1/);
    assert.equal(state.closed, 1);
  });

  test('the SDK throwing after an error result reports the result', async () => {
    const { result } = await run({ messages: [...prefix, errorResult('error_max_turns')], throwError: new Error('thrown after result') });
    assert.equal(result.runStatus, 'session_error');
    assert.match(result.issues.join(), /error_max_turns/);
  });

  test('a stream that ends without a result', async () => {
    const { result } = await run({ messages: prefix });
    assert.equal(result.runStatus, 'session_error');
    assert.match(result.issues.join(), /ended without a result/);
  });
});

describe('runInvestigation: timeout and cancellation', () => {
  test('an unresponsive stream times out and the session is closed', async () => {
    const started = Date.now();
    const { result, state } = await run({ messages: [init(), ...skillCall()], hang: true }, { timeoutMs: 200 });
    assert.equal(result.runStatus, 'timeout');
    assert.equal(EXIT_CODES[result.runStatus], 6);
    assert.equal(state.closed, 1);
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(result.observed.toolCalls.map((c) => c.name), ['Skill'], 'partial observations are kept');
  });

  test('a hung initialization times out before any prompt is sent', async () => {
    const { result, state } = await run({ hangInit: true }, { timeoutMs: 200 });
    assert.equal(result.runStatus, 'timeout');
    assert.equal(state.prompts.length, 0);
    assert.equal(state.closed, 1);
  });

  test('Ctrl+C mid-stream interrupts and closes the session', async () => {
    const interrupt = new AbortController();
    setTimeout(() => interrupt.abort(), 100);
    const { result, state } = await run({ messages: [init()], hang: true }, {}, { signal: interrupt.signal });
    assert.equal(result.runStatus, 'interrupted');
    assert.equal(state.closed, 1);
  });

  test('an already-aborted signal never starts a session', async () => {
    const interrupt = new AbortController();
    interrupt.abort();
    const { result, state } = await run({ messages: investigatedStream([CHECKBOXES]) }, {}, { signal: interrupt.signal });
    assert.equal(result.runStatus, 'interrupted');
    assert.equal(state.calls, 0);
  });
});

describe('details fixtures', () => {
  test('helpers produce payloads the MCP schemas accept', async () => {
    const { FailureDetailsOutput, ListFailuresOutput } = await import('../../mcp/report.ts');
    assert.ok(ListFailuresOutput.safeParse(listPayload([CHECKBOXES])).success);
    assert.ok(FailureDetailsOutput.safeParse(detailsPayload(CHECKBOXES)).success);
  });
});
