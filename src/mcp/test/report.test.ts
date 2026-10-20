import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { toRepoRelative } from '../paths.ts';
import { getFailureDetails, listFailures, loadReport, ReportError } from '../report.ts';
import { makeRepo, PNG_BYTES, put, readFixture } from './helpers.ts';

const LOGIN_DIR = 'test-results/ui-login-logs-in-with-valid-credentials-chromium';

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ReportError, `expected ReportError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.ok(error.hint.length > 0, 'error has an actionable hint');
    return true;
  });
}

describe('loadReport', () => {
  test('missing report', async (t) => {
    await rejectsWith(loadReport(await makeRepo(t)), 'REPORT_NOT_FOUND');
  });

  test('malformed JSON', async (t) => {
    await rejectsWith(loadReport(await makeRepo(t, { raw: '{ "suites": [' })), 'REPORT_MALFORMED_JSON');
  });

  test('valid JSON that is not a Playwright report', async (t) => {
    await rejectsWith(loadReport(await makeRepo(t, { raw: '{"hello": "world"}' })), 'REPORT_INVALID_SHAPE');
  });

  test('fingerprint changes when the report changes', async (t) => {
    const root = await makeRepo(t, { fixture: 'one-failure' });
    const before = await loadReport(root);
    await put(root, 'artifacts/results.json', (await readFixture('one-failure')).replace('10432', '10433'));
    const after = await loadReport(root);
    assert.match(before.fingerprint, /^[0-9a-f]{12}$/);
    assert.notEqual(before.fingerprint, after.fingerprint);
  });
});

describe('listFailures', () => {
  test('no failures', async (t) => {
    const result = listFailures(await loadReport(await makeRepo(t, { fixture: 'no-failures' })));
    assert.deepEqual(result.failures, []);
    assert.equal(result.failureCount, 0);
    assert.equal(result.message, 'No failed or flaky tests in this report.');
    assert.equal(result.stats.expected, 1);
    assert.equal(result.run.playwrightVersion, '1.64.1');
    assert.equal(result.run.reportPath, 'artifacts/results.json');
  });

  test('one failed test', async (t) => {
    const loaded = await loadReport(await makeRepo(t, { fixture: 'one-failure' }));
    const { failures } = listFailures(loaded);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0], {
      testId: `aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb@${loaded.fingerprint}`,
      title: 'logs in with valid credentials',
      titlePath: ['logs in with valid credentials'],
      file: 'tests/ui/login.spec.ts',
      line: 3,
      column: 5,
      project: 'chromium',
      outcome: 'unexpected',
      expectedStatus: 'passed',
      finalStatus: 'failed',
      attempts: { count: 1, statuses: ['failed'] },
    });
  });

  test('multiple failures, nested suites, projects, repeats, flaky and merged specs', async (t) => {
    const loaded = await loadReport(await makeRepo(t, { fixture: 'multiple-failures' }));
    const { failures, failureCount } = listFailures(loaded);
    assert.equal(failureCount, 5);

    const ids = failures.map((f) => f.testId);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');

    const discount = failures.filter((f) => f.title === 'applies discount');
    assert.equal(discount.length, 3, 'two chromium repeats + one firefox');
    for (const f of discount) assert.deepEqual(f.titlePath, ['cart', 'checkout', 'applies discount']);
    assert.deepEqual(discount.map((f) => f.project).sort(), ['chromium', 'chromium', 'firefox']);

    const firefox = discount.find((f) => f.project === 'firefox');
    assert.deepEqual(firefox?.attempts, { count: 2, statuses: ['timedOut', 'failed'] });

    const flaky = failures.find((f) => f.outcome === 'flaky');
    assert.equal(flaky?.title, 'finds results');
    assert.equal(flaky?.finalStatus, 'passed');
    assert.deepEqual(flaky?.attempts.statuses, ['failed', 'passed']);

    // The merged spec carries two projects; only the failing one is listed, with an index suffix.
    const merged = failures.find((f) => f.title === 'merged across projects');
    assert.equal(merged?.project, 'firefox');
    assert.match(merged?.testId ?? '', /^5555555555aaaaaaaaaa-7777777777aaaaaaaaaa\.1@/);
  });

  test('global errors are preserved when no test failed', async (t) => {
    const result = listFailures(await loadReport(await makeRepo(t, { fixture: 'global-error' })));
    assert.equal(result.failureCount, 0);
    assert.equal(result.globalErrors.count, 1);
    assert.equal(result.globalErrors.items[0]?.message, "Error: Cannot find module './helpers'");
    assert.deepEqual(result.globalErrors.items[0]?.location, { file: 'tests/ui/login.spec.ts', line: 2, column: 1 });
    assert.match(result.message, /global errors/);
  });
});

describe('getFailureDetails', () => {
  test('error, location, attachments and outcome for one failure', async (t) => {
    const root = await makeRepo(t, {
      fixture: 'one-failure',
      files: { [`${LOGIN_DIR}/test-failed-1.png`]: PNG_BYTES, [`${LOGIN_DIR}/error-context.md`]: '# Page snapshot' },
    });
    const loaded = await loadReport(root);
    const [summary] = listFailures(loaded).failures;
    const details = await getFailureDetails(loaded, summary!.testId);

    assert.equal(details.outcome, 'unexpected');
    assert.equal(details.configuredRetries, 0);
    assert.deepEqual(details.tags, ['smoke']);
    assert.equal(details.attempts.length, 1);

    const attempt = details.attempts[0]!;
    assert.equal(attempt.status, 'failed');
    assert.deepEqual(attempt.omitted, { stdoutEntries: 1, stderrEntries: 0, additionalErrors: 0 });
    const error = attempt.error!;
    assert.doesNotMatch(error.message, /\u001b/, 'ANSI codes stripped');
    assert.equal(error.expected, '"You logged into a secure area!"');
    assert.equal(error.actual, '"Your username is invalid!"');
    assert.deepEqual(error.location, { file: 'tests/ui/login.spec.ts', line: 11, column: 41 });
    assert.match(error.snippet ?? '', /> 11 \|/);
    assert.equal(error.stack, '    at C:\\ci\\repo\\tests\\ui\\login.spec.ts:11:41');

    const byName = Object.fromEntries(attempt.attachments.map((a) => [a.name, a]));
    assert.deepEqual(byName.screenshot, {
      name: 'screenshot', contentType: 'image/png', location: 'repo',
      path: `${LOGIN_DIR}/test-failed-1.png`, exists: true, sizeBytes: PNG_BYTES.length, issue: null,
    });
    // Missing trace: metadata with exists:false, not a tool failure.
    assert.equal(byName.trace?.exists, false);
    assert.equal(byName.trace?.path, `${LOGIN_DIR}/trace.zip`);
    // Report path differs in case (C:\CI\Repo); Windows paths are case-insensitive.
    assert.equal(byName['error-context']?.path, `${LOGIN_DIR}/error-context.md`);
    assert.equal(byName['error-context']?.exists, true);
    // Inline body: size only.
    assert.deepEqual(byName.note, { name: 'note', contentType: 'text/plain', location: 'inline', path: null, exists: null, sizeBytes: 18, issue: null });
    assert.doesNotMatch(JSON.stringify(details), /SU5MSU5FLUJPRFktU0VDUkVU/);
  });

  test('flaky test reports the failed attempt and the passing retry', async (t) => {
    const loaded = await loadReport(await makeRepo(t, { fixture: 'multiple-failures' }));
    const flaky = listFailures(loaded).failures.find((f) => f.outcome === 'flaky')!;
    const details = await getFailureDetails(loaded, flaky.testId);
    assert.equal(details.outcome, 'flaky');
    assert.equal(details.configuredRetries, 1);
    assert.deepEqual(details.attempts.map((a) => [a.retry, a.status, a.error !== null]), [[0, 'failed', true], [1, 'passed', false]]);
    assert.deepEqual(details.attempts[0]!.additionalErrors, [], 'errors[0] duplicates error and is not repeated');
  });

  test('timeout keeps the secondary error that has the location', async (t) => {
    const loaded = await loadReport(await makeRepo(t, { fixture: 'multiple-failures' }));
    const firefox = listFailures(loaded).failures.find((f) => f.title === 'applies discount' && f.project === 'firefox')!;
    const [first] = (await getFailureDetails(loaded, firefox.testId)).attempts;
    assert.equal(first!.error?.message, 'Test timeout of 30000ms exceeded.');
    assert.equal(first!.additionalErrors.length, 1);
    assert.deepEqual(first!.additionalErrors[0]!.location, { file: 'tests/ui/cart.spec.ts', line: 6, column: 50 });
  });

  test('unsafe and malformed attachment paths are never resolved', async (t) => {
    const loaded = await loadReport(await makeRepo(t, { fixture: 'multiple-failures' }));
    const chromium = listFailures(loaded).failures.find((f) => f.testId.startsWith('1111111111aaaaaaaaaa-2222222222aaaaaaaaaa@'))!;
    const [first] = (await getFailureDetails(loaded, chromium.testId)).attempts;
    const byName = Object.fromEntries(first!.attachments.map((a) => [a.name, a]));
    assert.equal(byName.outside?.location, 'outside-repo');
    assert.equal(byName.unc?.location, 'invalid');
    assert.equal(byName.traversal?.location, 'outside-repo');
    assert.equal(byName['posix-on-windows-report']?.location, 'outside-repo');
    assert.equal(byName['drive-relative']?.location, 'invalid');
    assert.equal(byName['nul-byte']?.location, 'invalid');
    for (const a of first!.attachments) {
      assert.equal(a.path, null, `${a.name} exposes no path`);
      assert.equal(a.exists, null, `${a.name} was not checked on disk`);
    }
  });

  test('POSIX paths from a Linux CI report map into the repo', async (t) => {
    const root = await makeRepo(t, {
      fixture: 'linux-ci',
      files: { 'test-results/ui-dropdown-selects-an-option-chromium/test-failed-1.png': PNG_BYTES },
    });
    const loaded = await loadReport(root);
    const [summary] = listFailures(loaded).failures;
    assert.equal(summary!.file, 'tests/ui/dropdown.spec.ts');
    const [attempt] = (await getFailureDetails(loaded, summary!.testId)).attempts;
    const byName = Object.fromEntries(attempt!.attachments.map((a) => [a.name, a]));
    assert.equal(byName.screenshot?.path, 'test-results/ui-dropdown-selects-an-option-chromium/test-failed-1.png');
    assert.equal(byName.screenshot?.exists, true);
    assert.equal(byName.elsewhere?.location, 'outside-repo');
    assert.equal(byName['windows-on-linux-report']?.location, 'outside-repo');
    assert.deepEqual(attempt!.error?.location, { file: 'tests/ui/dropdown.spec.ts', line: 8, column: 3 });
  });

  test('attachment symlinked to a file outside the repo is refused', async (t) => {
    const outside = await makeRepo(t, { files: { 'secret.txt': 'top secret' } });
    const root = await makeRepo(t, { fixture: 'one-failure' });
    await put(root, `${LOGIN_DIR}/.keep`, '');
    try {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, ...LOGIN_DIR.split('/'), 'trace.zip'), 'file');
    } catch (error) {
      // Windows needs Developer Mode or admin rights for symlinks.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks not permitted on this machine');
      throw error;
    }
    const loaded = await loadReport(root);
    const [summary] = listFailures(loaded).failures;
    const trace = (await getFailureDetails(loaded, summary!.testId)).attempts[0]!.attachments.find((a) => a.name === 'trace');
    assert.equal(trace?.exists, null);
    assert.equal(trace?.issue, 'symlink resolves outside the repository');
  });

  test('directory symlink escaping the repo is refused', async (t) => {
    const outside = await makeRepo(t, { files: { 'trace.zip': 'zip' } });
    const root = await makeRepo(t, { fixture: 'one-failure' });
    await put(root, 'test-results/.keep', '');
    try {
      // Junctions work on Windows without extra privileges.
      await symlink(outside, path.join(root, 'test-results', 'ui-login-logs-in-with-valid-credentials-chromium'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks not permitted on this machine');
      throw error;
    }
    const loaded = await loadReport(root);
    const [summary] = listFailures(loaded).failures;
    const trace = (await getFailureDetails(loaded, summary!.testId)).attempts[0]!.attachments.find((a) => a.name === 'trace');
    assert.equal(trace?.exists, null);
    assert.equal(trace?.issue, 'symlink resolves outside the repository');
  });

  test('long messages and stacks are truncated', async (t) => {
    const report = JSON.parse(await readFixture('one-failure'));
    const error = report.suites[0].specs[0].tests[0].results[0].error;
    error.message = `Error: ${'x'.repeat(10_000)}`;
    error.stack = `${error.message}\n${Array.from({ length: 200 }, (_, i) => `    at frame${i} (file.ts:${i}:1)`).join('\n')}`;
    const loaded = await loadReport(await makeRepo(t, { raw: JSON.stringify(report) }));
    const [summary] = listFailures(loaded).failures;
    const detail = (await getFailureDetails(loaded, summary!.testId)).attempts[0]!.error!;
    assert.ok(detail.message.length < 2100, `message length ${detail.message.length}`);
    assert.equal(detail.stack?.split('\n').length, 15);
    assert.equal(detail.truncated, true);
  });

  test('invalid, unknown, stale and non-failing ids', async (t) => {
    const root = await makeRepo(t, { fixture: 'one-failure' });
    const loaded = await loadReport(root);
    const fp = loaded.fingerprint;
    await rejectsWith(getFailureDetails(loaded, 'not an id'), 'INVALID_TEST_ID');
    await rejectsWith(getFailureDetails(loaded, '../../etc/passwd'), 'INVALID_TEST_ID');
    await rejectsWith(getFailureDetails(loaded, 'aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb'), 'INVALID_TEST_ID');
    await rejectsWith(getFailureDetails(loaded, `ffffffffffffffffffff-ffffffffffffffffffff@${fp}`), 'TEST_NOT_FOUND');
    await rejectsWith(getFailureDetails(loaded, `aaaaaaaaaaaaaaaaaaaa-cccccccccccccccccccc@${fp}`), 'TEST_NOT_FAILED');
    await rejectsWith(getFailureDetails(loaded, 'aaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb@000000000000'), 'REPORT_CHANGED');
  });
});

describe('toRepoRelative', () => {
  const winRoot = 'C:\\ci\\repo';
  test('Windows absolute paths, mixed separators and case', () => {
    assert.deepEqual(toRepoRelative('C:\\ci\\repo\\test-results\\a\\trace.zip', winRoot), { kind: 'repo', relative: 'test-results/a/trace.zip' });
    assert.deepEqual(toRepoRelative('c:/CI/Repo/test-results/a/trace.zip', winRoot), { kind: 'repo', relative: 'test-results/a/trace.zip' });
    assert.deepEqual(toRepoRelative('D:\\ci\\repo\\x', winRoot), { kind: 'outside-repo' });
    assert.deepEqual(toRepoRelative('C:\\ci\\repo-other\\x', winRoot), { kind: 'outside-repo' });
  });
  test('POSIX absolute paths', () => {
    assert.deepEqual(toRepoRelative('/w/repo/test-results/x.png', '/w/repo'), { kind: 'repo', relative: 'test-results/x.png' });
    assert.deepEqual(toRepoRelative('/w/repo/../x', '/w/repo'), { kind: 'outside-repo' });
    assert.deepEqual(toRepoRelative('/w/repo/x', undefined), { kind: 'outside-repo' });
  });
  test('malformed paths', () => {
    for (const bad of ['', '\\\\server\\share\\x', '//server/share/x', 'C:x', 'a\u0000b', 'test-results/a:b', 'x'.repeat(2000), 42]) {
      assert.equal(toRepoRelative(bad, winRoot).kind, 'invalid', JSON.stringify(bad).slice(0, 40));
    }
  });
});
