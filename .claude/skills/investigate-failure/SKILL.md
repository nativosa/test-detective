---
name: investigate-failure
description: Investigate failed Playwright tests from existing artifacts (artifacts/results.json, test source, error-context.md, screenshots, traces) and produce an evidence-based root-cause report. Use when a Playwright test failed and the user asks why. Read-only; never edits files or reruns tests.
argument-hint: "[test title or spec file — omit for all failures]"
allowed-tools: Read, Grep, Glob, Bash(unzip -l *), Bash(unzip -p *), Bash(grep *), Bash(head *), Bash(ls *)
disallowed-tools: Edit, Write, NotebookEdit
---

# Investigate failed Playwright tests

Filter: `$ARGUMENTS`

If the filter is empty, investigate **every** failed test. Otherwise investigate only failed tests whose title or spec file path contains the filter (case-insensitive).

## Current artifacts

!`ls -l --time-style=full-iso artifacts/results.json 2>&1 || true`

!`ls -1 test-results 2>&1 || true`

## Rules

- **Read-only.** Do not edit files, rerun tests, install anything, or contact external services, including the application under test. Only use the read-only commands allowed above.
- **Evidence only.** Every finding must cite an artifact you actually read in this investigation. If an artifact is missing or unreadable, say "not available" and lower your confidence. Never guess its contents or claim you inspected it.
- Report paths repo-relative. `results.json` stores absolute paths such as `C:\GIT\test-detective\test-results\...`.
- Error messages contain ANSI color codes (`\u001b[31m` and similar). Ignore them when quoting.

## Step 1: Locate failures

1. Read `artifacts/results.json`. If it's missing or not valid JSON, stop and report that, and suggest running `npm test`. Don't continue.
2. Note `stats.startTime` (when the run started) and `stats.unexpected` / `stats.flaky`.
3. Walk `suites[] → (nested suites[]) → specs[] → tests[]`. For each test, check `status`:
   - `unexpected`: **consistently failed**. Every attempt in `results[]` failed.
   - `flaky`: **flaky**. It failed at least once, then passed on retry. Report it separately; it's a different problem from a consistent failure.
   - `expected` / `skipped`: ignore.
4. Apply the filter. If nothing matches, list the failed and flaky tests that do exist (title + file), then stop. If there are no failures at all, say so and stop.

## Step 2: Extract the error

Note the test's `projectName`. For each failed attempt in `results[]` (note `retry` index, `startTime`, and `status`: `failed`, `timedOut`, `interrupted`), collect:
- `error.message`: the assertion or locator, expected vs actual (or "received"), timeout. Check `errors[]` too, since there can be several (e.g. soft assertions).
- `error.location` (or `errorLocation`): the failing `file:line:column`. For timeouts, the top-level `error` is generic ("Test timeout of …ms exceeded"); use the `errors[]` entry that has a `location` instead.
- `error.snippet`: the code frame as it was **when the test ran**.
- `attachments[]`: `screenshot`, `error-context`, `trace` paths.

## Step 3: Inspect evidence, in priority order

Go only as far as you need to reach a well-supported conclusion. Record each item as inspected, not available, or skipped (with reason).

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

**Source:** `<file>:<line>` · **Project:** <project> · **Outcome:** consistently failed | flaky (passed on retry N)

### Failure summary
<one or two sentences: what failed, expected vs actual>

### Evidence inspected
- ✅/⚠️/⏭️ JSON report — `artifacts/results.json`
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
