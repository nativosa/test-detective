---
name: investigate-failure
description: Investigate failed Playwright tests using the test-detective MCP server (list_test_failures, get_failure_details, get_trace_summary) plus existing artifacts (test source, error-context.md, screenshots, traces) and produce an evidence-based root-cause report. Use when a Playwright test failed and the user asks why. Read-only; never edits files or reruns tests.
argument-hint: "[test title or spec file — omit for all failures]"
allowed-tools: Read, Grep, Glob, Bash(unzip -l *), Bash(unzip -p *), Bash(grep *), Bash(head *), Bash(ls *), mcp__test-detective__list_test_failures, mcp__test-detective__get_failure_details, mcp__test-detective__get_trace_summary
disallowed-tools: Edit, Write, NotebookEdit
---

# Investigate failed Playwright tests

Filter: `$ARGUMENTS`

If the filter is empty, investigate **every** failed test. Otherwise investigate only failed tests whose title or spec file path contains the filter (case-insensitive).

## Current artifacts

!`ls -l --time-style=full-iso artifacts/results.json 2>&1 || true`

!`ls -1 test-results 2>&1 || true`

## Rules

- **Read-only.** Do not edit files, rerun tests, install anything, or contact external services, including the application under test. Only use the read-only commands and the three test-detective MCP tools allowed above.
- **Failure data comes from MCP.** Get test outcomes, errors and attachment paths from `list_test_failures` and `get_failure_details`. Never read or parse `artifacts/results.json` yourself, not even as a fallback.
- **Evidence only.** Every finding must cite an artifact or MCP result you actually obtained in this investigation. If an artifact is missing or unreadable, say "not available" and lower your confidence. Never guess its contents or claim you inspected it. Cite a trace fact only if a successful `get_trace_summary` result (status `ok` or `partial`) or a successful trace command returned it.
- **Observed, inferred, uncertain.** Keep three things apart in the analysis: what a tool result or artifact shows (observed), what you conclude from it (inference), and what the evidence leaves open (uncertainty).
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
- `attachments[]`: `screenshot`, `error-context`, `trace`. Use `path` only when `location` is `repo` and `exists` is `true`. Otherwise mark that artifact ⚠️ not available and quote `issue` if present. Note which attempts (by `retry`) have a `trace` attachment; attempts differ, and passing attempts usually have none.

Note whether the failed attempts agree (same error and location) or differ. If they differ, say so in the report.

## Step 3: Inspect evidence, in priority order

Go only as far as you need to reach a well-supported conclusion. Record each item as inspected, not available, or skipped (with reason).

Read these directly at the repo-relative paths from Step 2. The MCP tools only report that they exist, not what they contain.

1. **Test source.** Read the spec around `error.location`. Then check for a **source/artifact mismatch**: compare the current line with `error.snippet`, and compare the file's modification time (`ls -l --time-style=full-iso <file>`) with the attempt's `startTime`. If the code differs or the file was modified after the run started, warn prominently: the diagnosis may be based on source that doesn't match the artifacts.
2. **error-context.md.** This is the page's accessibility snapshot at failure. Compare it with the failing locator and expected value. For example: does the element exist under a different name or role? Is the expected text present?
3. **Screenshot.** Read the PNG and describe only what is actually visible: error pages, unexpected state, blank page.
4. **Trace, through `get_trace_summary`.** Call it when any of these holds:
   - the test is flaky, and a failed attempt has a trace;
   - the failure involves network requests, navigation, or content that never appeared;
   - the screenshot or error context shows a loading, error or unexpectedly blank state;
   - telling a test-code defect from an application defect depends on network behavior (for example the spec has `page.route`/`context.route` and the page showed an HTTP error).

   Skip it (⏭️, with the reason) for a plain locator or assertion mismatch that items 1–3 already explain.

   Pass the `testId` exactly as listed and `retry` = the `attempts[].retry` of the failed attempt you are explaining. Call it only for attempts whose `trace` attachment exists, one call per attempt you need; never assume every attempt has a trace. Handle the result by `trace.status`:
   - `ok`: every trace entry was read and verified. Lists are still capped: check `network.omitted` before treating a request as absent.
   - `partial`: use what is listed, and treat anything not listed as **unknown, never absent**. Read `trace.reasons`, `coverage.countsAreLowerBounds` and `coverage.readUntilMs` (if it is before `failure.atMs`, the events around the failure were not read). Lower your confidence when the deciding evidence may be in the unread part.
   - `missing`: there is no readable trace for this attempt (`trace.reasons` says why). Report ⚠️ not available (missing). Don't run trace commands.
   - `unsupported`: the trace exists but can't be interpreted safely. Report that and use the fallback commands below.
   - An error result: `REPORT_CHANGED` is handled as in Step 2; for `ATTEMPT_NOT_FOUND` and other codes, report the code and don't guess. If the tool is unavailable or denied, use the fallback commands below.

   **What the fields mean.** They are observations, not verdicts:
   - `network.requests[].marker`: `fulfilled` means a route handler answered the request. It does **not** mean the test invented the response: `route.fetch()` gets the real backend response, which the handler can pass on unchanged or modify. `none` means no route marker was recorded; it does **not** prove a live backend response. `continued`, `aborted` and `unknown` mean what they say.
   - `routes.fulfillments[]`: one per `route.fulfill` call. `fetch.link: "linked"` is proven by matching trace identifiers: the fulfill reused a `route.fetch()` response; `fetchedStatus` is what the backend returned, and `statusChanged` says whether the test changed the status. `"none"` means no identifier link: the test may have built the response, or fetched one and replaced its body; the trace can't tell which. `"unresolved"` means the link could not be followed. `bodyProvided` says the call supplied its own body.
   - `routes.fulfillments[].request.correlation`: only `unique` ties a fulfill to one request (`ref`). `ambiguous`, `none` and `undetermined` tie it to none; never pick one yourself.
   - `backendFetches`: requests made by API request contexts (`route.fetch()`, the `request` fixture). These reached a backend.
   - `failure` (`source`, `action`, `atMs`) and each item's `startedMs`/`beforeFailure`: whether a request or page error happened before the failing action. `redirect`, `pageErrors` (names only) and `console.counts` complete the picture.

   **Fallback trace commands.** Use these only when `get_trace_summary` is unavailable, denied or failed, or returned `unsupported`. Never read a whole trace. Be selective:
   - `unzip -l <trace.zip>` lists the contents.
   - `unzip -p <trace.zip> '*.trace' | grep -E '"error"|"console"|pageError' | head -n 30` shows action errors and console output.
   - `unzip -p <trace.zip> '*.network' | grep -E '"status":\s*[45][0-9]{2}|"failure"' | head -n 20` shows HTTP errors and failed requests.
   - `unzip -p <trace.zip> '*.network' | grep -oE '"url":"[^"]*"|"_wasFulfilled":true' | head -n 40` shows which requests a route handler answered (`"_wasFulfilled":true` follows the request's URL; like `marker: "fulfilled"`, it doesn't say whether the response came from `route.fetch()`).

   **Run these commands exactly as written**, replacing only `<trace.zip>` with the trace `path` from Step 2. Each command is a separate Bash call. Only `unzip`, `grep` and `head` are permitted, and a call that contains anything else is denied as a whole. Never add shell variables or assignments (`T=…`, `$T`), `;`, `&&`, `||`, `echo`, `cut`, redirections or any other command, and never combine several of these commands into one call.

   **If a trace command is denied**, retry once: run the documented command for the evidence you need, alone and exactly as written. If you are unsure which one, use `unzip -l <trace.zip>`. Do not try other variations. Report the trace as not available only if that retry also fails.

   **Report only what succeeded.** Trace contents count as inspected only if a `get_trace_summary` result with status `ok` or `partial`, or a command that returned them, succeeded. Never describe trace contents you didn't obtain that way. Keep these two cases apart:
   - **Missing**: Step 2 reported no trace, or `exists` is `false` or `location` isn't `repo`. Report it as ⚠️ not available (missing).
   - **Present but not inspectable**: the trace exists, but `get_trace_summary` and the fallback commands were denied or failed, or the summary was `unsupported` and the commands failed too. Report it as ⚠️ not available (exists at `<path>` but could not be inspected) and quote the denial or error. Name the evidence it might have held (for example HTTP status codes, or which requests were mocked), and lower your confidence accordingly.

## Step 4: Classify

Pick exactly one:
- **Test-code defect**: the test is wrong. Examples: a locator doesn't match an element that exists, the expected value contradicts what the app correctly shows, a race or missing wait in the test.
- **Application defect**: the app misbehaves. Examples: a 5xx response, a JS error, a broken or missing feature that the test reasonably expects.
- **Environment issue**: the run conditions failed. Examples: DNS/connection errors, browser launch failure, missing browsers, a timeout with no app response, path or setup problems.
- **Inconclusive**: the evidence is missing or conflicting. State what additional evidence would resolve it.

**A status code or route marker never classifies a failure on its own.** Before calling a 4xx/5xx or failed request an application defect, work out where the response came from. Use the spec source (`page.route`, `context.route`, and what the handler does: `route.fulfill` with its own status/body, `route.fetch()`, `route.continue`, `route.abort`) together with the trace summary:
- **The test made the error.** The handler fulfills with its own error status (spec), the fulfillment correlates `unique` with the failing request, and there is no fetch link. Or the fetch is `linked` with `statusChanged: true`, so the test changed the status. If the test then expects success, it contradicts itself: **Test-code defect**. Cite the spec lines and the trace fields.
- **The backend returned the error.** The fetch is `linked` with `statusChanged: false` and an error `fetchedStatus`, so the handler passed the real response on. Or the request has `marker: "none"` and the spec routes nothing that matches it. Point to the application (or the environment, for connection-level failures), weighed with the rest of the evidence. `marker: "none"` alone doesn't prove a live backend.
- **It can't be told apart.** The correlation is `ambiguous`, `none` or `undetermined`, the fetch link is `none` while the handler calls `route.fetch()`, the trace is `partial` around the failure, or there is no trace. Don't settle it from the marker or the status. Rely on the source, lower your confidence, or classify **Inconclusive** and say which evidence would decide it.

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
- ✅/⚠️/⏭️ Trace — `<path>` (`get_trace_summary` retry N: <status>, or the trace commands run; <what was examined>)

(✅ inspected · ⚠️ not available · ⏭️ skipped — say why)

### Root-cause analysis
**Classification:** <one of the four>
<reasoning, each point tied to a cited piece of evidence and labelled **Observed**, **Inference** or **Uncertain**>

### Confidence
**<High|Medium|Low>**: <justification>

### Proposed fix
<the specific change, as a short diff or description; not applied>

### Verification steps
<how to confirm the fix, e.g. the exact `npx playwright test <file>` command, and what result to expect>
```

End by reminding the user that no files were changed and nothing was rerun.
