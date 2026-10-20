---
name: investigate-failure
description: Investigate failed Playwright tests using the test-detective MCP server (list_test_failures, get_failure_details) plus existing artifacts (test source, error-context.md, screenshots, traces) and produce an evidence-based root-cause report. Use when a Playwright test failed and the user asks why. Read-only; never edits files or reruns tests.
argument-hint: "[test title or spec file — omit for all failures]"
allowed-tools: Read, Grep, Glob, Bash(unzip -l *), Bash(unzip -p *), Bash(grep *), Bash(head *), Bash(ls *), mcp__test-detective__list_test_failures, mcp__test-detective__get_failure_details
disallowed-tools: Edit, Write, NotebookEdit
---

# Investigate failed Playwright tests

Filter: `$ARGUMENTS`

If the filter is empty, investigate **every** failed test. Otherwise investigate only failed tests whose title or spec file path contains the filter (case-insensitive).

## Current artifacts

!`ls -l --time-style=full-iso artifacts/results.json 2>&1 || true`

!`ls -1 test-results 2>&1 || true`

## Rules

- **Read-only.** Do not edit files, rerun tests, install anything, or contact external services, including the application under test. Only use the read-only commands and the two test-detective MCP tools allowed above.
- **Failure data comes from MCP.** Get test outcomes, errors and attachment paths from `list_test_failures` and `get_failure_details`. Never read or parse `artifacts/results.json` yourself, not even as a fallback.
- **Evidence only.** Every finding must cite an artifact or MCP result you actually obtained in this investigation. If an artifact is missing or unreadable, say "not available" and lower your confidence. Never guess its contents or claim you inspected it.
- **One run only.** All evidence must come from the same Playwright run (same `reportFingerprint`). Never combine MCP results from different reports.
- Report paths repo-relative. The MCP tools already return repo-relative POSIX paths.
- Error messages can contain ANSI color codes (`\u001b[31m` and similar). Ignore them when quoting.

## Step 1: Locate failures

1. Call `list_test_failures` (no input).
   - If the tool is not available to you, is denied, or the call fails without returning a result (connection or server error), **stop**. Report "test-detective MCP server unavailable", with the exact error or the tool's absence, and suggest checking `/mcp`. Do not fall back to reading `artifacts/results.json`.
   - If it returns an error result (`{"error": {code, message, hint}}`), report the `code`, `message` and `hint`, then stop. For example, `REPORT_NOT_FOUND` or `REPORT_MALFORMED_JSON` means you should suggest running `npm test`.
2. Note `run.startTime` (when the run started), `run.reportFingerprint`, `stats` (`unexpected`, `flaky`), and `globalErrors`. Report global errors (config, load or global setup failures) even when no test failed.
3. Each entry in `failures[]` has a `testId`, `title`, `titlePath`, `file`, `project`, `outcome`, `finalStatus` and `attempts.statuses`. Read `outcome` with Playwright's semantics:
   - `unexpected`: the **final outcome did not match the expected status**, and no attempt passed. That doesn't mean every attempt failed the same way. Attempts can differ in status (`failed`, `timedOut`, `interrupted`) and in error, so inspect each one in Step 2.
   - `flaky`: the test **eventually passed after an earlier failed attempt**. Report it separately; it's a different problem from an unexpected failure.
4. Apply the filter: case-insensitive match against `title`, any `titlePath` entry, or `file`. If nothing matches, list the failed and flaky tests that do exist (title + file), then stop. If `failures[]` is empty, say there are no failed or flaky tests (with `stats`, and any global errors), then stop.

## Step 2: Extract the error

For each selected failure, call `get_failure_details` with its `testId` **exactly as `list_test_failures` returned it**. Never build or edit a testId yourself.

If it returns `REPORT_CHANGED` (the report was regenerated since you listed it):
1. Call `list_test_failures` once more.
2. Find the same test in the new list by `file`, `titlePath` and `project`.
3. If it's there, call `get_failure_details` with its **new** `testId`. Discard everything you collected from the old report and restart this investigation's evidence from the new `run.reportFingerprint`.
4. If it's no longer listed (it passed or no longer exists), stop and report that explicitly. If a second `REPORT_CHANGED` occurs, stop and report that the report is changing under you.

Other error codes (`TEST_NOT_FOUND`, `TEST_NOT_FAILED`, `INVALID_TEST_ID`): report the code, message and hint for that test, and don't guess its details.

Note the test's `project`, `configuredRetries` and `timeoutMs`. Inspect **every** entry in `attempts[]` individually (`retry`, `startTime`, `status`). Passing attempts of a flaky test are context; failed attempts are evidence. For each failed attempt, collect:
- `error.message`, `error.expected`, `error.actual`: the assertion or locator, expected vs received, timeout. Also check `additionalErrors[]`, since there can be several (e.g. soft assertions). `omitted.additionalErrors` > 0 means some were cut; say so.
- `error.location`: the failing `file:line:column`. For timeouts, the top-level error is generic ("Test timeout of …ms exceeded"); use the `additionalErrors[]` entry that has a `location` instead.
- `error.snippet`: the code frame as it was **when the test ran**. `error.truncated: true` means the message or stack was shortened.
- `attachments[]`: `screenshot`, `error-context`, `trace`. Use `path` only when `location` is `repo` and `exists` is `true`. Otherwise mark that artifact ⚠️ not available and quote `issue` if present.

Note whether the failed attempts agree (same error and location) or differ. If they differ, say so in the report.

## Step 3: Inspect evidence, in priority order

Go only as far as you need to reach a well-supported conclusion. Record each item as inspected, not available, or skipped (with reason).

Read these directly at the repo-relative paths from Step 2. The MCP tools only report that they exist, not what they contain.

1. **Test source.** Read the spec around `error.location`. Then check for a **source/artifact mismatch**: compare the current line with `error.snippet`, and compare the file's modification time (`ls -l --time-style=full-iso <file>`) with the attempt's `startTime`. If the code differs or the file was modified after the run started, warn prominently: the diagnosis may be based on source that doesn't match the artifacts.
2. **error-context.md.** This is the page's accessibility snapshot at failure. Compare it with the failing locator and expected value. For example: does the element exist under a different name or role? Is the expected text present?
3. **Screenshot.** Read the PNG and describe only what is actually visible: error pages, unexpected state, blank page.
4. **Trace (only if the above is insufficient).** Never read a whole trace. Be selective:
   - `unzip -l <trace.zip>` lists the contents.
   - `unzip -p <trace.zip> '*.trace' | grep -E '"error"|"console"|pageError' | head -n 30` shows action errors and console output.
   - `unzip -p <trace.zip> '*.network' | grep -E '"status":\s*[45][0-9]{2}|"failure"' | head -n 20` shows HTTP errors and failed requests.
   - `unzip -p <trace.zip> '*.network' | grep -oE '"url":"[^"]*"|"_wasFulfilled":true' | head -n 40` shows which requests the test answered itself (`"_wasFulfilled":true` follows the mocked request's URL).

## Step 4: Classify

Pick exactly one:
- **Test-code defect**: the test is wrong. Examples: a locator doesn't match an element that exists, the expected value contradicts what the app correctly shows, a race or missing wait in the test.
- **Application defect**: the app misbehaves. Examples: a 5xx response, a JS error, a broken or missing feature that the test reasonably expects.
- **Environment issue**: the run conditions failed. Examples: DNS/connection errors, browser launch failure, missing browsers, a timeout with no app response, path or setup problems.
- **Inconclusive**: the evidence is missing or conflicting. State what additional evidence would resolve it.

**Mocked responses are not application defects.** Before classifying a 4xx/5xx or failed request as an application defect, check whether the test produced it: look for `page.route`, `context.route`, `route.fulfill` or `route.abort` in the spec, and for `"_wasFulfilled":true` on that request in the trace's `.network` file. If the test mocked the failing response and then expected success, classify it as a **Test-code defect** (the test contradicts itself) and cite both pieces of evidence.

Confidence: **High** means direct evidence explains the failure and nothing contradicts it. **Medium** means the explanation is likely but rests on partial evidence or inference. **Low** means the evidence is thin, missing or mismatched.

## Step 5: Report

If there are several failures, start with a summary table (test | outcome | classification | confidence), and note failures that share a cause. Then write one block per test, using exactly this structure:

```markdown
## <test title>

**Source:** `<file>:<line>` · **Project:** <project> · **Outcome:** unexpected (N attempts: <statuses>) | flaky (passed on retry N)

### Failure summary
<one or two sentences: what failed, expected vs actual>

### Evidence inspected
- ✅/⚠️/⏭️ MCP — `list_test_failures`, `get_failure_details` (`<testId>`, report `<reportFingerprint>`)
- ✅/⚠️/⏭️ Test source — `<file>` (mismatch: yes/no)
- ✅/⚠️/⏭️ Error context — `<path>`
- ✅/⚠️/⏭️ Screenshot — `<path>`
- ✅/⚠️/⏭️ Trace — `<path>` (<what was examined>)

(✅ inspected · ⚠️ not available · ⏭️ skipped — say why)

### Root-cause analysis
**Classification:** <one of the four>
<reasoning, each point tied to a cited piece of evidence>

### Confidence
**<High|Medium|Low>**: <justification>

### Proposed fix
<the specific change, as a short diff or description; not applied>

### Verification steps
<how to confirm the fix, e.g. the exact `npx playwright test <file>` command, and what result to expect>
```

End by reminding the user that no files were changed and nothing was rerun.
