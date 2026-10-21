import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InvestigationResult, modelReportJsonSchema, parseModelReport, renderMarkdown } from '../result.ts';
import { CHECKBOXES, investigation, report } from './helpers.ts';

describe('parseModelReport', () => {
  test('accepts single, multiple and empty reports', () => {
    assert.equal(parseModelReport(report('investigated', [investigation('a')])).ok, true);
    assert.equal(parseModelReport(report('investigated', [investigation('a'), investigation('b')])).ok, true);
    assert.equal(parseModelReport(report('no_failures')).ok, true);
    assert.equal(parseModelReport(report('no_match')).ok, true);
  });

  test('rejects missing fields, bad enums, extra keys and non-objects', () => {
    const { confidence: _, ...noConfidence } = investigation('a');
    const cases: unknown[] = [
      report('investigated', [noConfidence]),
      report('investigated', [{ ...investigation('a'), classification: 'Flaky' }]),
      report('investigated', [{ ...investigation('a'), title: 'invented by the model' }]),
      { ...report('no_failures'), extra: true },
      report('done'),
      'not json',
      null,
      undefined,
    ];
    for (const value of cases) assert.equal(parseModelReport(value).ok, false, JSON.stringify(value));
  });

  test('validation errors are readable', () => {
    const result = parseModelReport(report('investigated', [{ ...investigation('a'), classification: 'Flaky' }]));
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /classification/);
  });
});

describe('modelReportJsonSchema', () => {
  test('is a strict draft-07 object schema the SDK can send', () => {
    const schema = modelReportJsonSchema();
    assert.match(String(schema.$schema), /draft-07/);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    const props = schema.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(props), ['status', 'message', 'investigations']);
  });
});

function result(overrides: Partial<InvestigationResult> = {}): InvestigationResult {
  return InvestigationResult.parse({
    runStatus: 'completed',
    issues: [],
    observed: {
      auth: { mode: 'subscription', apiKeySource: 'none', apiProvider: 'firstParty', subscriptionType: 'pro', tokenSource: null },
      model: 'claude-opus-5-5',
      claudeCodeVersion: '2.1.302',
      mcpServerStatus: 'connected',
      skillDiscovered: true,
      skillReadAsFile: false,
      skillInvoked: true,
      toolCalls: [{ name: 'mcp__test-detective__list_test_failures', input: '{}', outcome: 'ok' }],
      permissionDenials: [],
      report: { reportFingerprint: 'abc123def456', startTime: 't', stats: { expected: 4, unexpected: 1, flaky: 0, skipped: 0 }, failureCount: 1 },
    },
    reportStatus: 'investigated',
    message: 'One test-code defect.',
    investigations: [
      {
        facts: { testId: CHECKBOXES.testId, title: CHECKBOXES.title, file: CHECKBOXES.file, line: 3, project: 'chromium', outcome: 'unexpected', attempts: [{ retry: 0, status: 'failed' }] },
        analysis: investigation(CHECKBOXES.testId),
      },
    ],
    usage: { numTurns: 7, durationMs: 12_300, inputTokens: 1500, outputTokens: 200, estimatedUsageCostUsd: 0.0512 },
    ...overrides,
  });
}

describe('renderMarkdown', () => {
  test('separates observed facts from model analysis and labels cost as an estimate', () => {
    const md = renderMarkdown(result());
    assert.match(md, /## toggles checkboxes/);
    assert.match(md, /### Observed \(from MCP results, not model output\)/);
    assert.match(md, /`tests\/ui\/checkboxes\.spec\.ts:3` · \*\*Project:\*\* chromium · \*\*Outcome:\*\* unexpected/);
    assert.match(md, /### Analysis \(model-generated\)/);
    assert.match(md, /\*\*Classification:\*\* Test-code defect/);
    assert.match(md, /\*\*Proposed fix \(not applied\):\*\*/);
    assert.match(md, /Estimated usage cost:\*\* \$0\.0512 \(SDK estimate at list prices; not necessarily a charge/);
    assert.match(md, /mcp__test-detective__list_test_failures \{\} → ok/);
  });

  test('flags analysis whose testId was never observed', () => {
    const md = renderMarkdown(result({ runStatus: 'unverified', issues: ['testId x has no observed result'], investigations: [{ facts: null, analysis: investigation('x') }] }));
    assert.match(md, /# test-detective investigation: unverified/);
    assert.match(md, /## Unverified testId x/);
    assert.match(md, /No MCP result for this testId was observed/);
  });

  test('a summary table appears for multiple failures', () => {
    const base = result();
    const md = renderMarkdown({ ...base, investigations: [base.investigations[0]!, { facts: null, analysis: investigation('y') }] });
    assert.match(md, /\| Test \| Outcome \| Classification \| Confidence \|/);
  });

  test('never prints account email or organization (they are not part of the result type)', () => {
    assert.throws(() =>
      InvestigationResult.parse({ ...result(), observed: { ...result().observed, auth: { ...result().observed.auth, email: 'a@b.c' } } }),
    );
  });
});
