# Evaluation dataset (Stages 2.5–3.5)

Controlled Playwright failures with ground truth, used to measure how accurately, reliably and cheaply test-detective diagnoses failures. This stage evaluates the existing investigation (the `investigate-failure` Skill run by the Agent SDK CLI) as the baseline. It adds no investigation features.

**Status: Stage 3.6 (retrospective).** Stage 2.5 built the schemas, the fixture app, three pilot scenarios (S02, S04, S05), snapshot generation and storage, investigation workspaces with isolation checks, offline scoring and reporting, the live adapter, and a one-run-per-scenario pilot benchmark. Stage 2.6.1 adds seven scenarios (S01, S03, S06–S10) aimed at timing, environment, flaky, inconclusive, source-mismatch and no-failure cases, plus the fixture modes, generation options, observation checks and control runs they need. Their snapshots are generated offline. Stage 2.6.2 added scorer version 6 for them (see "Scorer version 6" below). Four of them (S08, S07, S03, S09) were then run live once each; scorer version 7 followed from what those runs exposed (see "Scorer version 7"). Stage 3 added structured trace evidence (`get_trace_summary`), scorer version 8 and one more live run each of S07, S05 and S04 (see "Stage 3.5 live runs"). After Stage 3.6, S12 added a test that works with a second browser page (see "What the S12 artifacts contain"). It has a snapshot and a control, and one live run with the Stage 3.6 Skill (`live-S12-20261025T081519Z`: exact, accepted automatically under scorer v8). S11 then added a link that is hidden until its photo is hovered (see "What the S11 artifacts contain"), and S14 a test that keeps an element handle across a reset that replaces the element (see "What the S14 artifacts contain"). Each has a snapshot and a control. S13 added a report download that the fixture server answers with HTTP 503 (see "What the S13 artifacts contain"). It has a snapshot and no control (as for S04). S14, S11 and S13 then ran live once each with the Stage 3.6 Skill; all three were exact and accepted automatically under scorer v8 (see "Live runs of S11, S13 and S14"). R1 then added a ground-truth regression corpus for S11, S13 and S14, and R3a scorer version 9 (polarity-aware review-severity forbidden matching; see "Scorer version 9"). R3b added scorer version 10's recommendation roles and marked S13's fail-fast status check as supporting, which changed S13's truth hash (see "Scorer version 10" and "Ground truth versions"). R3c added scorer version 11: acceptable fixes now have polarity, so a negated, retracted or merely reported fix no longer counts (see "Scorer version 11"); no truth changed. R3d added scorer version 12: a negation on one line or bullet no longer hides a forbidden item on the next (see "Scorer version 12"); no truth changed. Every saved run stays at its stored version and truth.

## Layout

```
evals/
  app/server.ts               fixture app (node:http, built-ins only, 127.0.0.1)
  snapshots/<id>/             generated, gitignored (see "Snapshots")
  scenarios/<id>/
    generation.json           how to produce the failure        -> generator only
    truth.json                what a correct diagnosis says     -> scoring and dataset tests only
    tests/ui/<name>.spec.ts   the scenario's test, as the agent will see it
    post-run/tests/ui/...     optional: the edited spec written over the stage spec after the run -> generator only
    control/tests/ui/...      optional: the corrected test, which must pass -> control runs only (an answer)
src/eval/
  scenarios.ts                discovery, shared helpers (file names only)
  generation.ts               GenerationConfig schema and loader (never imports truth.ts)
  truth.ts                    GroundTruth schema and loader
  generate.ts                 snapshot generation (Playwright only; reads generation.json, never truth.json)
  control.ts                  control runs: the corrected spec against the same fixture; must pass; stores nothing
  snapshots.ts                snapshot manifest, storage, verified loading, relocation
  workspace.ts                per-run workspace: materialize, audit, integrity check, remove
  isolation.ts                eval session options, recorded config differences, query wrapper, transcript audit
  runs.ts                     saved-run format (RunManifest, RunOutcome), loading, score/report file I/O
  live.ts                     live adapter: one scenario, one session -> saved run -> score + report
  score.ts                    pure, deterministic scorer: saved run + truth + snapshot -> ScoreRecord
  report.ts                   pure aggregation (summary.json, summary.md) and the human-review schema
  main.ts                     CLI: npm run eval -- generate | control | score | report | live
  test/                       offline node:test suite (npm run test:eval); golden.ts builds scorer-validation fixtures (never agent-performance data)
```

Scenario specs live outside the main config's `testDir` (`./tests`), so `npm test` never runs them. A test in `test:eval` checks this.

The pilot scenarios are S02, S04 and S05; Stage 2.6 added S01, S03 and S06–S10; S12, S11, S14 and S13 followed Stage 3.6. The expected answers are only in each scenario's `truth.json` (and, as corrected tests, in `control/`). Don't repeat them in docs, specs, comments, file names or test titles.

## Generation data vs ground truth

The two files are deliberately separated, at both the module and the schema level:

- **`generation.json`** (`GenerationConfig`): the spec path, the fixture-app mode, Playwright retries and timeout, and `expectObservation`, which is what the generated run must show before its snapshot is accepted. It contains no classification, root cause, evidence or recommendations. Optional fields added in Stage 2.6 (leaving one out reproduces the pilot behavior exactly, so the pilot files and their hashes are unchanged, which a test pins):

  | Field | Effect |
  |---|---|
  | `app.profileDelayMs` | delay before a successful `/api/profile` response |
  | `app.server: "down"` | `BASE_URL` points at a released local port, so connections are refused |
  | `app.reportsApi` (after Stage 3.6) | `/reports/monthly.csv`: `ok` (default) serves the CSV attachment, `unavailable` answers 503 with an HTML error page |
  | `playwright.trace`, `playwright.screenshot` | `"off"` turns the artifact off in the stage config |
  | `postRun.replaceSpec` | after Playwright exits, the stage spec is overwritten with `post-run/<spec>` |
  | `expectObservation.absentAttachments` | attachments no attempt may list, and whose files must not exist |
  | `expectObservation.errorContextPattern` | must match each failed attempt's `error-context.md` (what the page showed) |
  | `expectObservation.maxFailedAttemptMs` | upper bound on each failed attempt's duration (fails at once, not by timeout) |
  | `expectObservation.sourceTiming` | `before-run` (default) or `after-run`; goes together with `postRun` |
- **`truth.json`** (`GroundTruth`): `canary`, `description` (the known root cause), `failureType`, `expected` (report status, tests, classification, acceptable alternatives with a confidence cap, source-mismatch flag, acceptable confidence levels), `rootCause` (summary, criteria, forbidden claims), `requiredEvidence`, and `recommendations` (acceptable and forbidden). Optional since Stage 2.6.2 (absent means the Stage 2.5 meaning): `expected.tests[].reportedOutcome` (`unexpected` by default, `flaky` for S07), `expected.reviewableAlternatives` (classifications a person must judge, each with a `requires` criterion its reasoning must match), `expected.unavailableEvidence` (kinds the run did not keep), and `severity: "fail"` on a forbidden claim. Optional since scorer v10 (R3b): `role` on an acceptable recommendation (`corrective` when omitted, or `supporting`; see "Scorer version 10"). The outcome field is `reportedOutcome`, not `outcome`, because `generation.json` already has an `outcome` key and the two files share no keys.

`separation.test.ts` enforces the split:
- `generation.ts` imports nothing from `truth.ts`.
- The generation loader works when `truth.json` is absent.
- The two schemas share only `id`.
- `generation.json` uses no ground-truth keys, classification labels or canaries.
- Specs contain no canaries, labels, scenario IDs or comments.

## Snapshots

```sh
npm run eval -- generate --scenario S02   # Playwright + local fixture app only; no model requests
```

Each run:
1. Creates a fresh `.work/<random>/` stage.
2. Copies in only the declared spec (timestamps preserved), plus a generated neutral `playwright.config.ts`.
3. Starts the fixture app on a random 127.0.0.1 port (for `server: "down"`, binds and releases a port instead) and runs Playwright with `--workers=1`. For `postRun`, it then writes `post-run/<spec>` over the stage spec. The spec is written, not copied, because `copyFile` keeps the source's mtime on Windows.
4. Checks the run against `expectObservation`: exit code, global errors, outcome, attempts vs `retries`, `errorPattern` on every failed attempt, and the required attachments existing under `test-results/`; plus, when set, absent attachments, error-context contents and failed-attempt duration. These checks read the report through the MCP layer (`src/mcp/report.ts`), so they see what the investigator will see. Every new generation also checks **source timing**: by default the stored spec must be older than the run start; for `after-run`, newer than the run end, with the failing line differing from the error snippet.
5. Writes the snapshot, write-once:

```
evals/snapshots/<id>/manifest.json   scenario ID, report fingerprint, Playwright/Node versions, timestamp,
                                     generation.json hash, stage root, observation checks,
                                     and every file's path, SHA-256, size and mtime
evals/snapshots/<id>/files/...       playwright.config.ts, tests/, artifacts/results.json, test-results/
```

Rules:
- **Never overwritten.** An existing snapshot is refused. Delete the directory to regenerate.
- **Verified on load.** `loadSnapshot` refuses any hash, size or mtime change, any missing or extra file, symlinks, unsafe manifest paths, and a report whose fingerprint differs from the manifest's.
- **Relocatable.** `copySnapshotFiles` copies the payload with timestamps preserved and re-verifies the copy. The report keeps the stage's absolute paths, and the MCP layer resolves them relative to the report's own root, so attachments resolve wherever the copy lives. Preserved mtimes keep the spec older than the run, which avoids false source/artifact mismatches.
- **The repo is guarded.** The generator records the root `artifacts/results.json` hash, the root `test-results/` and `playwright-report/` listings, and `git status` before and after the run, and discards the snapshot if any of them changed.
- **The stage is removed** after every run unless you pass `--keep-stage`.

**Gotcha found on the first real run:** Playwright's default `outputDir` resolves next to the nearest `package.json` (the repo root), not next to the config, and Playwright empties it at the start of every run. The stage config therefore sets `outputDir: './test-results'`, and the generator also passes `--output <stage>/test-results`. A test asserts both.

### What the pilot artifacts contain (Playwright 1.64.1, Chromium)

| | S02 | S04 | S05 |
|---|---|---|---|
| Status | `timedOut` (15 s test timeout) | `failed` (10 s expect timeout) | `failed` (10 s expect timeout) |
| Top error | `Test timeout of 15000ms exceeded.` | `expect(locator).toBeVisible() failed`, `Locator: getByText('Dana Demo')`, `element(s) not found` | same as S04 |
| Locator detail | `additionalErrors[0]`: `locator.click: Test timeout…`, `waiting for getByRole('button', { name: 'Sign in' })` | in the top error | in the top error |
| error-context page snapshot | `button "Log in"` | `alert: Something went wrong while loading your profile…` | same alert; its embedded test source shows `page.route` / `route.fulfill` |
| Attachments | screenshot, error-context, trace | same | same |

**Real 500 vs mocked 500 in the trace.** In both traces, the `.network` resource-snapshot for `/api/profile` has `status: 500` and `statusText: "Internal Server Error"`, so the status alone doesn't distinguish them. What does:

| Field | S04 (real server) | S05 (`route.fulfill`) |
|---|---|---|
| `"_wasFulfilled"` in `.network` | absent | `true` |
| Response headers | server's own (`Date`, `Connection`, `Keep-Alive`, `Transfer-Encoding`, `cache-control`) | only what the test set (`content-type`, `content-length`) |
| `test.trace` steps | no route steps | `Route requests`, `Fulfill request` (`method: "fulfill"`) |

The Stage 2.5 Skill's trace command (`grep -oE '"url":"[^"]*"|"_wasFulfilled":true'`) shows the difference as-is: `"_wasFulfilled":true` follows the `/api/profile` URL only in S05. S04 has no `_wasFulfilled: false`; the field is simply absent, so "not mocked" is inferred from absence and from the spec having no `page.route`. The `requiredEvidence` trace entries for S04 and S05 are now confirmed (`provisional: false`). In S04/S05 the error-context YAML has no `# Page snapshot` heading, unlike S02's.

### What the Stage 2.6 artifacts contain (Playwright 1.64.1, Chromium, observed in offline spikes and in the stored snapshots)

| | S01 | S03 | S06 | S07 | S08 | S09 | S10 |
|---|---|---|---|---|---|---|---|
| Fixture | `ok` | `ok`, 1.5 s API delay | server down | `fail-first`, retries 1 | `hang`, trace and screenshot off | `ok`, spec edited after the run | `ok` |
| Attempts | `failed` (10 s expect timeout) | `failed` in ~0.2 s | `failed` in ~0.2 s | `failed` (10 s) then `passed`; outcome `flaky`, exit 0 | `failed` (10 s) | `failed` (10 s) | `passed`, exit 0 |
| Top error | `toHaveText`, Expected `"My Profile"`, Received `"Profile"` | `expect(received).toBe(expected)`, Expected `true`, Received `false` (not a timeout) | `page.goto: net::ERR_CONNECTION_REFUSED` | `toBeVisible` on `Dana Demo`, `element(s) not found` | same as S07 | as S01 | none |
| error-context page | heading `Profile` | heading, paragraph `Loading your profile…` | **no page snapshot** | retry 0: alert `Something went wrong…` | `Loading your profile…` | heading `Profile` | – |
| Screenshot | yes | yes | yes, **blank** | retry 0 only | **none** | yes | – |
| Trace `/api/profile` | 200 | **status -1, no response** (still pending when the check ran) | the navigation has `_failureText: net::ERR_CONNECTION_REFUSED` | retry 0: 500, server `Date` header, no `_wasFulfilled` | **no trace** | 200 | – |

Observations that matter for the scenarios:
- **error-context.md always embeds the test source as it ran** (`# Test source`), and every trace stores it under `src/`. In S09 both still show the line with `'My Profile'` while the workspace spec says `'Profile'`, so the mismatch is visible in three places, not only by timestamp.
- **error-context.md is written even with trace and screenshot off** (S08). Its page snapshot is the only view of the page there.
- **S09's timestamps are real and narrow.** The edited spec's mtime is ~20 ms after the run end (the edit follows Playwright's exit), about 10 s after the attempt's `startTime`, and copies preserve it into the workspace.
- **S06's artifacts carry almost no page evidence:** a blank screenshot and no page snapshot. The error message and the trace's navigation failure are the evidence.
- Every snapshot also contains `test-results/.last-run.json` (Playwright's own file).

### What the S12 artifacts contain (Playwright 1.64.1, Chromium, two independent generations)

The spec clicks a `target="_blank"` link on `/help`, which opens `/help/guide` as a second page in the same browser context. Both generations gave identical facts (only the report fingerprint differs):

| | S12 |
|---|---|
| Fixture | `ok` (the `/help` pages don't depend on the profile mode) |
| Attempts | `failed` (10 s expect timeout), `tests/ui/help.spec.ts:8` |
| Top error | `toBeVisible` on `getByRole('heading', { name: 'User guide' })`, `element(s) not found` |
| error-context page | heading `Help`, link `Open the user guide` (the page the test started on) |
| Screenshots | **two**: `test-failed-1.png` shows `/help`, `test-failed-2.png` shows `/help/guide` with its `User guide` heading. Playwright captures every page of the context on failure. |
| `get_trace_summary` retry 0 | `ok`, coverage complete; browser context `pages: 2`, `requests: 2`: document `GET /help` 200 and document `GET /help/guide` 200, both before the failure; no routes, page errors or console messages |

**What the trace summary can't show.** It counts pages per context but doesn't attribute requests, or the failed `Frame.expect`, to a page. So it shows that a second page existed and that `/help/guide` loaded, but not which page the failed check ran on. The error-context snapshot and the first screenshot show that page, the second screenshot shows the other one, and the spec shows which page object the check uses. S12's required evidence is therefore `get_failure_details`, the spec and `error-context.md`. The second screenshot and `get_trace_summary` corroborate that the popup opened but are optional.

**Failure type.** S12 uses `incorrect_locator`, the closest existing type. The selector itself is well-formed and matches the popup's heading; the defect is the `Page` object the locator is created on (the original page instead of the popup), not a malformed selector. The truth schema has no separate page-context type, and none was added.

### What the S11 artifacts contain (Playwright 1.64.1, Chromium, three independent generations)

`/team` shows three member photos and the text "Hover over a team member's photo to see their name and profile link." Each name and `View <first name>'s profile` link sits in a `figcaption` that the page's CSS hides until its figure is hovered. The spec asserts `toBeVisible` on `getByText("View Ana's profile")` without hovering. Two candidate generations (snapshots written to a disposable directory) and the stored one gave identical facts once report fingerprints, IDs, times and stage paths were normalized:

| | S11 |
|---|---|
| Fixture | `ok` (the `/team` pages don't depend on the profile mode) |
| Attempts | `failed` (10 s expect timeout), `tests/ui/team.spec.ts:7` |
| Top error | `expect(locator).toBeVisible() failed`, `Expected: visible`, `Received: hidden`; call log `23 × locator resolved to <a href="/team/ana-lopez">View Ana's profile</a>`, `unexpected value "hidden"`. `get_failure_details` returns it in full (`error.actual: "hidden"`, not truncated, no `additionalErrors`) |
| error-context page | heading `Team`, the hover instruction, three `figure`s each holding only an `img` (`Ana Lopez`, …). **No link node**: the page snapshot leaves out hidden elements. Each figure's accessible name still includes its hidden caption text (`figure "Ana Lopez View Ana's profile"`) |
| Screenshot | the heading, the instruction and three plain photos; no names or links |
| `get_trace_summary` retry 0 | `ok`, coverage complete; one request, document `GET /team` 200, `marker: none`; failure `Frame.expect`; no routes, page errors or console messages; no navigation to a profile |

**Why `getByText` and an explicit `toBeVisible`.** A role locator excludes hidden elements (`tests/ui/hovers.spec.ts` notes the same), so `getByRole('link')` would fail as "element(s) not found", which looks just like a missing or misnamed element (S02, S12). A bare `click()` would end at the test timeout with the visibility log in a 500-character `additionalErrors` entry. With `getByText` and `toBeVisible`, the error shows in the 2000-character top error that the element exists and is hidden.

**What the investigator can't see.** No tool returns CSS or DOM: the trace summary has network, route and timing facts only, and error-context is an accessibility snapshot. That the link is revealed **by hover** is therefore an inference from the spec (no hover), the page's instruction text and the hidden state of an element that exists. S11's required evidence is `get_failure_details`, the spec and `error-context.md`; the screenshot and `get_trace_summary` are optional, and nothing requires CSS or DOM details.

**Failure type.** S11 uses `incorrect_locator`, the closest existing type, as S12 does. The locator is correct and resolves; the defect is the missing hover before using conditionally visible content. The truth schema has no interaction-step type, and none was added.

### What the S14 artifacts contain (Playwright 1.64.1, Chromium, three independent generations)

`/settings` has an `Email notifications` checkbox (checked on load), a `Reset preferences` button and a status region. Reset builds a new, unchecked checkbox with `document.createElement`, replaces the original with it and shows `Preferences reset`; there are no timers or requests. The spec takes `elementHandle()` for the checkbox, clicks Reset, waits for the status text, then calls `check()` on the handle. A separate browser check (outside the test runner) confirmed that after reset the original node is disconnected and the page holds one, different checkbox. Two candidate generations and the stored one gave identical facts once report fingerprints, IDs, times and stage paths were normalized:

| | S14 |
|---|---|
| Fixture | `ok` (`/settings` doesn't depend on the profile mode) |
| Attempts | `failed` after about 0.3 s, `tests/ui/settings.spec.ts:10` (`maxFailedAttemptMs` 5000 pins that it fails at once) |
| Top error | `Error: elementHandle.check: Element is not attached to the DOM`, no expected/actual value, no call log. `get_failure_details` returns it in full (not truncated, no `additionalErrors`) |
| error-context page | heading `Settings`, a paragraph with `checkbox "Email notifications"` (unchecked), button `Reset preferences` `[active]`, `status: Preferences reset` |
| Screenshot | the same: an unchecked checkbox, the button and `Preferences reset` |
| `get_trace_summary` retry 0 | `ok`, coverage complete; one request, document `GET /settings` 200, `marker: none`; failure `source: action`, `action: ElementHandle.check`, about 0.3 s into the trace; no routes, page errors or console messages |

**What the investigator can't see.** No tool exposes DOM node identity, so "the reset **replaced** the checkbox" is an inference: the handle's node is detached, yet error-context (taken after the reset finished, as its status shows) has a checkbox with the same name. The original checked state isn't visible either; only the spec and the unchecked replacement are. Because the failure is immediate and follows a passed status assertion, the evidence argues against timing. S14's required evidence is `get_failure_details`, the spec and `error-context.md`; the screenshot and `get_trace_summary` (which names the failed `ElementHandle.check` action) are optional.

**Failure type.** S14 uses `incorrect_locator`, the closest existing type, as S11 and S12 do. The selector is correct and resolves to the replacement; the defect is a one-time element reference held across a DOM replacement. The truth schema has no stale-reference type, and none was added.

### What the S13 artifacts contain (Playwright 1.64.1, Chromium, three independent generations)

`/reports` has a `Download monthly report` link to `/reports/monthly.csv`. S13 runs the fixture with `reportsApi: "unavailable"`, so the real local server answers that URL with HTTP 503 `text/html` (a bare "Service Unavailable" page) and no `Content-Disposition`; nothing in the spec routes, mocks or fulfills. The spec starts `waitForEvent('download')`, clicks the link, awaits the download and then checks its filename and contents. A feasibility run before implementation established Chromium's behavior in both modes in a disposable directory, and an isolated run of the committed spec against the default mode passed (download event, `monthly-report.csv`, exact CSV contents). Two candidate generations and the stored one gave identical facts once report fingerprints, IDs, times, sizes and stage paths were normalized:

| | S13 |
|---|---|
| Fixture | `profileApi: "ok"`, `reportsApi: "unavailable"` |
| Attempts | `timedOut` after about 15.1 s (15 s test timeout) |
| Top error | `Test timeout of 15000ms exceeded.`, no location |
| `additionalErrors[0]` | `Error: page.waitForEvent: Test timeout of 15000ms exceeded.`, log `waiting for event "download"`, snippet with the arrow at `tests/ui/reports.spec.ts:7:32` (the line that **starts** waiting, not the click or the `await`). 578 characters in the stage, so `get_failure_details` cuts 78; only the trailing `at <stage path>:7:32` stack line is lost |
| error-context page | heading `Service Unavailable`, paragraph `The report service is temporarily unavailable.` The Reports page is gone: Chromium navigated to the 503 response |
| Screenshot | the same error page |
| `get_trace_summary` retry 0 | `ok`, coverage complete; document `GET /reports` 200 and document `GET /reports/monthly.csv` **503** `Service Unavailable`, both `marker: none` and before the failure; no interception patterns, no route calls, no backend fetches; failure `source: test_error`, `action: null` (the wait is not a recorded action); 1 console error (its text is not exposed), no page errors |

**Why no download event.** Without an attachment header, Chromium treats the 503 HTML response to a link click as a navigation and renders it, so Playwright never sees a download and the wait ends at the test timeout. The timeout is the symptom; on its own it reads like a timing problem.

**What only the trace shows.** The HTTP status, and that no route was involved, appear only in `get_trace_summary`; error-context and the screenshot show the page's text. S13's required evidence is therefore `get_failure_details`, the spec, `error-context.md` and the trace, the latter through MCP with `observations` (a browser request matching `^/reports/monthly\.csv$`, status 503, marker `none`). The screenshot is optional. `marker: none` alone doesn't prove a live backend (see "Scorer version 8"); here it comes with no interception patterns, no route calls and a spec without `page.route`.

**Classification.** Application defect (`failureType: application_failure`): the app serves its pages but fails the report endpoint, and the test is correct. Environment issue is a reviewable alternative, because a 503 often means a dependency or deployment problem; its reasoning must cite the 503 *and* say the operational cause is uncertain (one pattern with a lookahead, since `requires` is a single criterion). A 503 alone never makes it acceptable. The investigator has no server logs and one run, so whether the outage is transient stays unknown either way, and a report that names a specific server-side cause as fact (a database, a crash, a deployment) goes to review, as does one that treats `marker: none` by itself as proof of a live backend.

**Fixes.** Acceptable: investigate or repair the report endpoint and its dependencies so it serves the CSV attachment again, say the test needs no change, or (optional) have the test check the response status so it fails fast instead of waiting for the timeout. Forbidden: mocking the response, longer timeouts, sleeps, retries, skipping, changing the locator, and changing download permissions or settings.

**Scoring limitations.** The patterns are heuristics, checked against paraphrases offline; since R1 those checks are permanent tests (see "Ground-truth regression corpus"). The truth's forbidden patterns guard against a negation within four words before the match ("do not increase the timeout", "nothing was intercepted by the test"). Under v8 a negation further away, or after the match ("acceptDownloads is not the issue"), still sent the item to review, never to fail, since every S13 forbidden item has review severity; since v9 the scorer's polarity rules handle those, and match from each clause start so the guard no longer hides a recommendation after an earlier negated clause (see "Scorer version 9"). The guard still hides "Do not forget to increase the timeout." A correct report that never says the test itself is fine misses `test-correct` and goes to review. Required trace evidence means a report that skips or can't read the trace can't be fully accepted, by design: the trace is the only source of the 503.

**Healthy behavior without a control.** A control runs against the scenario's own fixture mode, which here is the failure itself, so S13 has none (as S04, S05 and S07). The fixture tests pin both modes' status, headers and body. The browser behavior in the healthy mode was checked once, in isolated runs outside the test suites, and relies on the pinned Playwright 1.64.1; `test:eval` launches no browser.

### Synthetic vs naturally occurring failures

Every scenario failure is **synthetic and deterministic**: the fixture app or the generator injects it, and each generation reproduces it identically, which the observation checks enforce.
- **S07's flakiness is scripted.** A per-server counter fails the first `/api/profile` request and passes the rest. It tests whether the investigator handles a flaky-outcome report: reading every attempt, and not over-claiming about failure frequency. It is not natural flakiness, and one run says nothing about a failure rate.
- **S03's race always loses.** A 1.5 s API delay meets a one-shot check made within milliseconds. A natural race passes intermittently. S03 does not measure detection of intermittent races.
- **Natural flakiness** (timing variance, resource contention) is not modelled here. Repetition of the real suite (`npm run test:repeat`) is the only natural-flakiness signal in this project.

## Control runs

```sh
npm run eval -- control --scenario S03   # Playwright + local fixture app only; no model requests
```

A control is the scenario's test, corrected (`control/<spec>`). It runs in a fresh `.work/` stage with the scenario's own fixture behavior and Playwright settings, and must pass on the first attempt with exit code 0 and no global errors, without changing repo state. It writes nothing. A passing control shows the failure comes from what the correction changed, not from a broken fixture, which supports the ground truth independently of any model.

Controls are answers, so they are evaluation-side data: the generator never reads `control/` (`separation.test.ts`), the stage that becomes a snapshot never contains it, and no snapshot or workspace ever does. S01, S03, S09, S11, S12 and S14 have controls (a dataset test requires them). S13 has none: its spec is correct and only the server mode differs, which a control can't change. Its healthy behavior is covered by the fixture tests (`app.test.ts`: 200 `text/csv` attachment with the exact CSV when `reportsApi` is omitted or `ok`, 503 HTML without an attachment when `unavailable`) and by an isolated Playwright run of the identical spec against the default mode, which passed (see "What the S13 artifacts contain").

## Fixture app

`node evals/app/server.ts [--profile-api ok|error|fail-first|hang] [--profile-delay-ms n] [--reports-api ok|unavailable] [--port n]` starts it manually. The generator starts it in-process and passes the fault mode itself, so the mode never appears in a spec or in anything copied to an investigation workspace. `fail-first` counts per started server, so each generated run starts at the first request. `/help` (a page with a link that opens `/help/guide` in a new window) and `/help/guide` are served in every mode, as are `/team` (three member photos; each name and profile link is shown only while its photo is hovered) and `/team/<slug>` for those members (404 otherwise), and `/settings` (an `Email notifications` checkbox and a `Reset preferences` button that replaces the checkbox with a new element, then shows `Preferences reset`), and `/reports` (a `Download monthly report` link to `/reports/monthly.csv`). `/reports/monthly.csv` follows `reportsApi` (default `ok`). `hang` never answers `/api/profile`; closing the server drops the connection.

## Scoring is heuristic

The `rootCause.criteria` and `recommendations` patterns are case-insensitive regular expressions. They are transparent signals, not a judge:
- A missing or partial match means **needs manual review**, not automatically wrong. Correct answers can be phrased in ways a pattern misses.
- A `forbidden*` pattern match flags the answer for review rather than failing it. Since scorer v9 a review-severity match that is clearly negated in its clause ("Do not increase the timeout", "A race condition is not the cause") is recorded but not flagged; anything less clear still goes to review (see "Scorer version 9").
- Only exact checks are decisive: classification, report status, schema validity, observed tool use, and evidence backed (or not) by the transcript and snapshot.

A `requiredEvidence` entry marked `"provisional": true` hasn't been confirmed against real artifacts; the scorer turns a failure on it into a review item. All pilot entries are confirmed.

## Investigation workspaces (2.5.2a)

Each evaluation run gets a fresh workspace, created by `createWorkspace(snapshot, …)`:

```
<os.tmpdir()>/ws-XXXXXX/project/        session cwd (mkdtemp, random suffix)
  playwright.config.ts  tests/  artifacts/results.json  test-results/      from the verified snapshot
  .claude/skills/investigate-failure/SKILL.md  .claude/settings.json      byte copies from the repo
```

- **Copied:** the snapshot payload (re-verified against its manifest, with timestamps preserved) and the two config files the session needs. **Never copied:** `generation.json`, `truth.json`, `manifest.json`, scenario IDs, canaries, eval code or docs, `CLAUDE.md`, `.mcp.json`, `settings.local.json`.
- **Fails closed.** Before it returns, `auditWorkspace` must pass, and any failure removes the container. The audit checks:
  - The workspace is not inside the repo or `~/.claude`.
  - Only regular files are present: no symlinks or junctions, no unsafe paths.
  - Exactly the expected files exist, with matching hash, size and mtime.
  - File paths match the allowlisted shapes, and no path segment is forbidden (`truth.json`, `evals`, `S01`, and so on).
  - No file contains a canary or an eval-only string (`expectObservation`, `requiredEvidence`, …), and no `.ts`/`.md`/`.json` file contains a scenario-ID-like token.
  - No `CLAUDE.md` or `CLAUDE.local.md` sits in any ancestor directory, where Claude Code would load it.
  - It also notes leftover `ws-*` siblings.
- **`checkIntegrity`** re-hashes the workspace after a session to detect tampering. **`removeWorkspace`** deletes only directories that look like a container it made. Tests pass their own parent directory, so creation and cleanup are deterministic and observable.
- **Bounded cleanup on Windows.** A directory that is a process's cwd can't be removed on Windows (`EBUSY` on its `rmdir`; nothing inside is deleted). The Claude Code CLI and the MCP server it starts both run with cwd = workspace root, and SDK 0.3.302's `close()` returns without waiting for them: it ends the CLI's stdin, and a CLI still alive after 2 s gets 5 s more, then `SIGKILL`. The MCP server exits on stdin EOF. So `removeWorkspace` retries only `EBUSY`/`EPERM`/`ENOTEMPTY`, with backoff (100 ms doubling to 1 s), until `REMOVAL_DEADLINE_MS` (10 s). Every retried attempt is recorded (`Removal.transient`). A workspace still busy at the deadline is a process leak and is reported as a cleanup failure, not waited out. Any other error fails at once. The first live S02 run (before this) tried removal about 50 ms after `close()` and left its workspace behind.

### Session configuration

The live adapter (`live.ts`) calls the **unchanged** `runInvestigation` with `repoRoot = workspace` and a wrapped SDK `query` (`evalQuery`). `adaptOptions` changes exactly two things in the options that the production `buildQueryOptions` returns, and refuses anything that doesn't look like production output:

1. The MCP server runs the repo's unchanged `src/mcp/main.ts`, with `TEST_DETECTIVE_REPO_ROOT=<workspace>` (production would look for `<workspace>/src/mcp/main.ts`, which doesn't exist).
2. `settings.permissions.deny` gets extra `Read(//c/GIT/test-detective/**)`, `Read(//c/Users/<you>/.claude/**)` and `Read(~/.claude/**)` rules. These are only additions: `tools`, `allowedTools`, `disallowedTools`, `permissionMode`, `settingSources`, `strictMcpConfig`, the skills, the prompt and the env are identical. A test asserts this.

`describeDifferences` records the full delta from a normal `npm run investigate` for the run metadata:
- **Option differences** (exactly `cwd`, `mcpServers.test-detective.env` and `settings.permissions.deny`; env changes are reported by variable name only).
- **Environment differences:** workspace contents, no `CLAUDE.md`, the Skill and settings copy hashes, the snapshot report fingerprint, how the MCP root is chosen, the cwd not being a git work tree, and the integrity check replacing `git status`.

## Data leakage: mitigation and detection, not a sandbox

The investigating agent must not see `truth.json`, these docs, eval code, or the conversations and plans under `~/.claude`. **Nothing here guarantees that.**

**Status after R4b (Step 1C):** the SDK Read deny rules below are defense-in-depth only, not an isolation boundary. In a controlled probe (one session on disposable files), a Read through a Windows 8.3 short name bypassed them. The short-name hardening covers that demonstrated alias, but not the junction, UNC, device-path or dynamically created aliases listed under "Not covered". **R4 live benchmark runs require a separately verified, OS-enforced access boundary** (planned: a dedicated restricted Windows account; not built yet). Until that boundary exists and has been verified, no R4 live run starts.

- **Mitigation (reduces exposure):** the workspace sits outside the repo and holds only allowlisted files. Read deny rules (`defaultProtectedRoots` → `evalDenyRules`) cover the repo as given and as spelled on disk (`C:\git\…` and `C:\GIT\…` both occur), `~/.claude`, and since R4b this repo's Claude Code temp folders (`<tmpdir>/claude/<project slug>`, an existing one also under its on-disk spelling, since the name follows the casing of the cwd a session started from), whose scratchpads and tool outputs held copies of truth files and saved scores. On Windows each rule is also added in all lower case. Since R4b Step 1C the live adapter also protects every 8.3 short spelling of each root (`withShortNameAliases`, looked up once at setup through `GetShortPathName`): every component with a short name can be spelled either way, ancestors included, so a root gets all long/short combinations (`C:\GIT\TEST-D~1`, `…\claude\C--GIT~1`, `C:\Users\<user>\CLAUDE~1` here), each with its own Read rule and recorded in `outcome.workspace.protectedRoots`, so the audit flags them too. A failed or malformed lookup, or more than 64 spellings of one root, is a setup failure: no session starts. An evaluation session's own temp folder there (named after its workspace) is not covered. Claude Code applies Read rules to Read, Grep and Glob. A Git-ignored directory is no less reachable than any other.
- **Not covered:** the allowed Bash command (`ls`; until Stage 3.6 also `grep`, `head` and `unzip`) accepts absolute paths, and Bash deny rules can't reliably match paths inside arguments. Path rules can't list every spelling of a folder: Windows' default junctions (`C:\Documents and Settings`, `%USERPROFILE%\Local Settings`, the self-referencing `AppData\Local\Application Data`, repeatable without end), other symlinks and junctions, UNC paths (`\\localhost\C$\…`, `\\127.0.0.1\C$\…`, any host name), `\\?\`, `\\.\` and `\\?\UNC\` device paths all reach the same files (checked on disposable folders), and short names created after setup aren't known. The first live probe (R4b, one session on disposable files) saw Read denied for the exact, lower-case, forward-slash, `..` and upper-case spellings, but a Read through an 8.3 short name returned the protected file: that is what the short-name roots address. Whether they are enforced, and how Claude Code treats junction, UNC and device paths, Grep and Glob, has not been verified live. Unit tests only check the rule strings and the audit.
- **Detection (after the fact):** `auditTranscript` scans the raw recorded stream. It reports:
  - **leaks:** any canary anywhere, including tool results; an eval-only string in a tool input; a tool path resolving into a protected root (Windows, `C:/…` and Git-Bash `/c/…` paths, and `~` are understood).
  - **warnings:** paths outside the workspace, unresolvable `$VAR`/`%VAR%` expansions (`unresolved-path`), conditional expansions (`conditional-expansion`, below), unexpected tools, and a session cwd that isn't the workspace.
  - **Variables a Bash command assigns itself** (`shellAssignments`, scorer version 5). `$NAME`/`${NAME}` is replaced by its value, and the word is then audited exactly as if the literal had been typed there (outside-workspace and protected-root checks included), only when all of these hold: `NAME=value` is a whole top-level statement (start of the command, or after `;`, a newline or `&&`; not in a pipeline, background job, subshell, `{ }` group, `if`/`for` body or as a `NAME=x cmd` prefix); the value has no `$`, backtick, leading `~`, glob character or whitespace; the command mentions NAME nowhere else except as plain references after the assignment (no reassignment, `+=`, `read`, `for`, `export`, `unset`, `${NAME:-x}`, …); and the command has no backtick, `eval`, `source` or `.`. Everything else stays `unresolved-path`. An assignment after `&&` is skipped if an earlier step failed, and the reference then expands to an inherited value the audit can't know, so each such reference also gets a `conditional-expansion` warning. Shell functions from the user's environment or a readonly variable could still defeat an assignment; the audit can't see those.
  - **expected:** `StructuredOutput` calls. Production sets `outputFormat`, so Claude Code adds this tool itself (it isn't in `tools`) and the final report arrives as its input. An input that fails validation comes back as an error result and the model retries, so a session can contain several calls (the first live S02 run had two). A call counts as expected only if the session's recorded options include the output schema (`preflight.session.outputFormatSha256`), the init message announced the tool, and the call is top-level (not inside a subagent). Otherwise it is an unexpected tool. Its input still gets the leak checks. The permission surface is unchanged: this only classifies what the SDK already does.
  - Path extraction is heuristic (Bash commands are tokenized). Expect false warnings, for example a grep pattern like `/api/profile` is read as an absolute path. Expect misses too: obfuscated commands, or content read without a canary.
- **Limits of the content scan:** `trace.zip` is scanned as raw bytes only (compressed entries aren't inspected), and the canary proves a leak only when the leaked part contains it.

A clean audit means no leak was observed, not that none happened.

## Live adapter (2.5.2c)

```sh
npm run eval -- live --scenario S02 --max-budget-usd 0.50 [--max-turns 30] [--timeout 300] [--model <id>] [--auth subscription|api] [--run <dir>]
```

**This makes real model requests on your account.** Run it only deliberately, one scenario at a time. `src/eval/live.ts`:
- **One scenario, one session, no retries.** Exactly one `--scenario` (no `--all`, no lists, no extra positionals). `runInvestigation` is called once per invocation; a failed session is recorded, never retried. `--run <dir>` adds the next attempt (`S02-02`, …) to an existing run of the same source; otherwise a new run is created under `evals/runs/`.
- **Limits.** `--max-budget-usd` is required and capped at 2 (below the CLI's own limit of 100). `--max-turns` (1–100) and `--timeout` (10–3600 s) go through the production argument parser. The budget is the SDK's estimate, checked after each turn, so a session can overshoot by one turn.
- **Auth is unchanged.** `runInvestigation` applies the production preflight, account check and stream check. Subscription mode refuses API-key variables before any SDK call, and nothing ever switches modes silently. Credential values are never saved.
- **Preflight, before the session:** the `truth.json` hash, the verified snapshot (all hashes, mtimes and the fingerprint) and its manifest hash, the SKILL.md and settings hashes, the SDK and Node versions, and the sanitized session options (`preflight.session`: no env values, and hashes in place of the output schema and system-prompt append). A missing or tampered snapshot, an unreadable truth file or a failed workspace audit is saved as `setup_failed`, and no session starts.
- **Session.** The production options pass through `evalQuery`, which applies only the approved restrictions (MCP root via `TEST_DETECTIVE_REPO_ROOT`, extra Read deny rules). Every SDK message is appended to `transcript.jsonl` as it arrives, so timeouts, Ctrl+C and crashes keep the partial transcript.
- **Afterwards:** `checkIntegrity` on the workspace, and the repo state (root `artifacts/results.json`, `test-results/`, `playwright-report/`, `git status`) compared with before. Then the workspace is removed (bounded, see "Bounded cleanup on Windows"), and `cleanup` records whether that worked and how many attempts it took. `outcome.json` and `result.json` are written even after failures, then the run is scored and reported offline. A scoring problem (e.g. a stored score conflict) never loses the saved run.
- **Labels.** Only the real SDK produces `source: "live"`. A run made with an injected (fake) query is labelled `scorer_validation`, and attempts of different sources can't be mixed in one run.
- **Usage.** Tokens, turns, duration, the SDK-estimated cost and permission denials come from the session's `result.json` (`usage`, `observed.permissionDenials`).
- **Exit status.** `eval live` exits 0 when the session finished and was scored, 1 otherwise, 2 for a refused or invalid invocation, and 130 after Ctrl+C. The saved run directory (`outcome.json`, `score.json`) is the record either way. Don't truncate the output with a pipe: in Windows PowerShell, `… | Select-Object -First N` stops the pipeline early (the Stage 3.5 S04 run reported exit 255 that way, after its files were already written), and `2>&1` on a native command wraps stderr lines in `NativeCommandError` records. Run it plain and read `$LASTEXITCODE`, or keep a full log through `cmd`, whose redirection doesn't touch the exit code:

  ```powershell
  cmd /c "npm run eval -- live --scenario S04 --max-budget-usd 0.50 > live.log 2>&1"; $LASTEXITCODE
  ```

  In Git Bash, `npm run eval -- live … 2>&1 | tee live.log; echo "${PIPESTATUS[0]}"` keeps both (plain `$?` is `tee`'s status). Both forms were checked with a refused invocation (exit 2, no session).

## Saved runs (input to `score` and `report`)

```sh
npm run eval -- score --run <dir> [--snapshots <dir>] [--scenarios <dir>] [--rescore]   # writes <evalId>/score.json
npm run eval -- report --run <dir>                                                      # writes summary.json, summary.md
npm run eval -- report --run <dir> --run <dir> [...] --out <dir>                        # one summary over several runs, in <dir>
```

Both commands are offline: they read saved files, the current `truth.json` files and verified snapshots, and never start a session, call a model or run Playwright (`separation.test.ts` checks their import graph). Live runs will be written to `evals/runs/<runId>/` (gitignored). The format, defined in `src/eval/runs.ts`:

```
<run>/
  run.json              {formatVersion: 1, runId, createdAt, source: "live" | "scorer_validation", description}
  review.json           optional human review (see "Human review")
  summary.json          written by report
  summary.md            written by report
  <evalId>/             one session; evalId = <scenarioId>-<NN>, e.g. S02-01 (NN = attempt)
    outcome.json        RunOutcome, written by the harness (required)
    result.json         the InvestigationResult that runInvestigation returned (when harness.status is session_finished)
    transcript.jsonl    every SDK message the session yielded, one JSON object per line (when a session started)
    score.json          ScoreRecord, written by score; never silently replaced (see "Ground truth versions")
    score-history/      earlier score.json files archived by score --rescore
```

`source: "scorer_validation"` marks synthetic fixtures that test the scorer. The report labels them as such, and their numbers are never agent-performance measurements.

`outcome.json` (`RunOutcome`) holds:
- `evalId`, `scenarioId`, `attempt`, `startedAt`, `finishedAt`.
- `harness.status`: `session_finished` (runInvestigation returned, whatever its runStatus), `setup_failed` (snapshot, workspace or audit failed; no session), or `harness_error`. Plus `harness.detail`.
- `args`: the CLI args the session ran with.
- `snapshot`: `reportFingerprint` and `manifestSha256` (the manifest bytes the workspace was made from).
- `workspace`: `root` (the session cwd, kept for the path audit after the directory is deleted), `protectedRoots`, `auditBefore` `{ok, problems}`, and `integrityAfter` (`checkIntegrity` problems; `[]` = unchanged, `null` = not checked).
- `preflight`: captured before the session: `truthSha256`, `skillSha256`, `settingsSha256`, `sdkVersion`, `mcpServerVersion` (the test-detective MCP server version, `src/mcp/server.ts`; absent in runs saved before Stage 3.4), `nodeVersion`, `capturedAt`, and the sanitized `session` options.
- `repo.unchanged`: the repo state was the same before and after (`null` = not checked).
- `cleanup`: `removed`, the final `error` (or `null`), and, for runs saved since bounded cleanup, `attempts`, `elapsedMs` and `transient` (the errors of retried attempts). A cleanup failure is infrastructure: `score.json` copies it into `cleanup` (`removed`, `removed_after_retry`, `failed`, `no_workspace`, `unknown`), the report lists it under "Infrastructure", and it never changes the category or acceptance.
- `configDifferences`: `describeDifferences()` output.

A finished session must record `snapshot`, `workspace` and `configDifferences`.

### Skill versions

`preflight.skillSha256` identifies the Skill a run used. Compare results only between runs that share it.

| SHA-256 of `SKILL.md` | Runs | Change |
|---|---|---|
| `995a548c3447290899291ae14a3b0306d14ae85be4e0d2b974307fc7695d476d` | pilot S02, S04, S05; Stage 2.6 S08, S07 | — |
| `ed2a523b32e9e652f54942a9b13db9d2c45bad39a1954c2a9ca13bb92e7863b9` | Stage 2.6 S03, S09 | Permission-safe trace inspection: trace commands run exactly as written, one per Bash call, with no compound syntax; one retry with a documented command after a denial; a missing trace is reported separately from one that is present but couldn't be inspected. Triggered by the S07 run, where one compound command was denied and never retried. |
| `bb6a78c5e277cfe5fb34bc6990d7fc5d7d00f870c62aa6fff2fedaa1042580c4` | Stage 3.5 S07, S05, S04 | Stage 3.3: trace facts come from `get_trace_summary` (called for flaky attempts, network, navigation, loading/error/blank states and test-vs-application questions, per retry index), with status-specific handling (`ok`, `partial` = unlisted is unknown, `missing`, `unsupported`). Bash trace commands are a fallback for an unavailable, failed or unsupported summary. Classification no longer treats `_wasFulfilled` as test-created: route markers and status codes never decide alone; identifier-based fetch links, status changes, correlations, timing and coverage do. Analysis points are labelled observed, inference or uncertain. Scorer v8 (Stage 3.4) grades its trace evidence. |
| `3a205d3b630b34cb79a89c15cce37a28d03d3a580706180352e77d2ed9ca9a17` | S12 (`live-S12-20261025T081519Z`); S14, S11, S13 (`live-S14-20261111T000802Z`, `live-S11-20261111T001123Z`, `live-S13-20261111T001753Z`) | Stage 3.6: no Bash trace fallback (the `unzip`/`grep`/`head` permissions were removed); an unavailable, denied, failed or `unsupported` summary makes the trace present but not inspectable, with the reason and no **High** confidence when the classification depends on it, and the Skill never says an uninspected trace contains or lacks an event. Observed points hold only retrieved facts; causal conclusions go in Inference, unknowns in Uncertain. The only shell command left is `ls -l`. Scorer v8 still recognizes Bash trace reads in older transcripts. |

### Ground truth versions

Every `score.json` records `inputs.truthSha256`, the hash of the `truth.json` bytes it was scored against, along with the result, transcript and snapshot identities and `scorerVersion`. `score` compares each fresh score with the stored one. If any would change (truth edited, scorer version bumped, saved inputs changed), it **writes nothing** and lists the evaluations and reasons, including what the change does to the category and the audit verdict. `--rescore` replaces them deliberately: each old file is first archived to `<evalId>/score-history/score.v<scorer>.truth-<sha12>.<sha8>.json` (never overwritten). Reviews refer to the score they judged by hash, so after a rescore they are kept unchanged in `review.json` and reported as stale. The summary lists the truth hashes used per scenario and warns when a run mixes versions.

The truth hash is also **captured before the session** (`outcome.preflight.truthSha256`). Scoring requires the current truth to match it. Otherwise the run is invalid setup, because it would be judged against answers that differ from the ones fixed when it ran. A finished session without a captured hash is invalid setup too.

**Truth changes after a saved run.** Only one so far:

| Scenario | Truth SHA-256 | In use | Change |
|---|---|---|---|
| S13 | `87577f6127c72c3a187b5001382f223a2d4ed575903013dbac2830fc7cfd1c7a` | `live-S13-20261111T001753Z` (preflight and stored v8 score); committed in `266899a` | — |
| S13 | `a9230f2c7be03ce2fd1326904c4c0c81c740b4977a5d6e1d1c6f303a3e6e158e` | new evaluations (R3b) | `"role": "supporting"` on the `check-status` acceptable fix; nothing else |

The saved S13 run stays tied to `87577f61`. Its stored score is history: it is never replaced or recomputed in place, and scoring it against the current truth gives `invalid_setup` (checked on a copy). The current truth applies to new evaluations only. An explicitly approved historical rescore needs the original truth, taken from Git (extract `git archive 266899a evals/scenarios`, or any later commit before R3b, and pass that directory to `score --scenarios`) or from an independently verified archive whose hash matches.

## Scoring (`score.ts`)

Deterministic: the same saved files, truth and snapshots give byte-identical `score.json` files. Nothing is taken on the model's word:
- **Test facts and tool use come from the raw transcript:** MCP results parsed with the MCP output schemas, and tool calls paired with their results. `result.json` must agree with the transcript (structured output, Skill invocation, facts), or the run is invalid setup.
- **Evidence "exists"** only if the file is in the verified snapshot (or is one of the two copied config files).
- **Evidence provenance is graded, never assumed.** A missing `Read` is not by itself proof of fabrication:

| Provenance | Meaning | Status |
|---|---|---|
| `verified` | A successful `Read` of the file, `Grep` on it (or on its directory, with the file in the output), a `Bash` command naming its full path, or, for MCP evidence, an obtained MCP result. | pass |
| `unresolved` | Only a partial channel (a Bash command naming only the base name, an inspected claim without a ref, a null-ref "not available" while the snapshot has that kind of file), or a transcript too incomplete to show that no read happened. | review |
| `unsupported` | The file exists, and a **complete** transcript (init and result messages, every tool call answered; `score.transcript`) shows no successful read of it. An error snippet in a `get_failure_details` result does not count as reading the file. | fail |
| `confirmed_false` | Demonstrably false: the file isn't in the snapshot, the path is outside the workspace, every attempt to read it failed, or an MCP result that was never obtained. | fail |
| `false_unavailable` | Claimed not available although the snapshot has it, and nothing denied access to it. | fail |
| `access_denied` | The file exists, but every attempt to read it was denied by the permission system (the result's `permission_denials` **and** an error tool_result; a command that merely failed doesn't count). Never counts as inspected. Scorer v7. | "not available" claim: pass · citation: review · required evidence: fail |

**Trace evidence through `get_trace_summary` (scorer v8).** Each call is validated against `TraceSummaryOutput` and must answer exactly the `testId` and `retry` it asked for; anything else is `invalid`. Only `ok` and `partial` results are obtained evidence. `missing`, `unsupported`, an error result, a denied call (`permission_denials` plus an error result) and an invalid result never count as inspected: an "inspected" claim naming the tool is `confirmed_false`, a "not available" claim passes (`unavailable`, or `access_denied` when every call was denied). A trace obtained this way is cited as `get_trace_summary` (refs such as `get_trace_summary (retry 0)` resolve too). The Bash fallback keeps the file-based provenance above, so a session may meet a trace requirement either way.

### Outcome categories

Decided in this order, one per evaluation:

| Category | When |
|---|---|
| `confirmed_violation` | A canary appears anywhere in the transcript; a tool call into a protected root (repo, `~/.claude`) **succeeded**, even if the file had no canary; the workspace changed during the session (`integrityAfter` not empty); or the repo state changed (`repo.unchanged` false). |
| `invalid_setup` | Execution or setup failure: outcome or truth unreadable; setup failed or the harness errored; the snapshot is missing or fails verification; its manifest hash or fingerprint differs from the run's; the session read a different report; the workspace audit failed; a session option differs from the baseline beyond `cwd`, `mcpServers.test-detective.env` and `settings.permissions.deny`; `result.json` or the transcript is missing or doesn't match; or the session ended `mcp_unavailable`/`report_error` when the scenario doesn't expect it. |
| `invalid_output` | runStatus `invalid_output`. |
| `timeout` | runStatus `timeout`. |
| `session_error` | runStatus `auth_refused`, `session_error` or `interrupted`. |
| `unverified` | runStatus `unverified`, or the transcript doesn't show a successful Skill invocation, `list_test_failures` and `get_failure_details` for every investigated testId. The checks are still computed, for information. |
| `needs_review` | Otherwise, if any check is `review` or the audit has suspicious findings. |
| `scored` | Otherwise. Failing checks are still `scored`: they're decided, just not passed. |

`scored` and `needs_review` are **eligible** for diagnostic metrics; every other category is excluded and counted on its own line.

**Audit outcomes are kept apart.** Only confirmed violations invalidate a run automatically. *Suspicious* findings stay visible in `audit.suspicious` and `review.reasons` and send an otherwise scored run to `needs_review`: a protected-path attempt that was denied or failed, a tool input naming an eval-only file or field (`truth.json`, `requiredEvidence`, …), ambiguous paths outside the workspace, unresolved `$VAR`/`%VAR%`, unexpected tools, a wrong session cwd, or integrity not checked. Recognized `StructuredOutput` calls go to `audit.expected` with their outcome (accepted, or rejected and retried) instead. They are informational and never a review reason (scorer version 4; version 3 flagged them as unexpected tools).

A `conditional-expansion` warning goes to `audit.dismissed` instead of `audit.suspicious` only when the call never ran: the result message's `permission_denials` (the SDK's authoritative record) lists it **and** its tool result is an error. An error result without a recorded denial means the command ran and failed, so the warning stays. The literal value was already audited; only the unknown fallback is dismissed, and that matters only if the command executed. No other finding is dismissed for a denied call: an unresolved target, an outside path or a protected-path attempt still says something about what the agent tried to reach. Dismissed findings stay visible in `score.json` and the report and are never a review reason (scorer version 5; score files from earlier versions have no `dismissed` field and read as empty).

If a scenario expects `mcp_unavailable` and the CLI stopped the session at start, the run is scored on report status alone (no Skill call is required, because no model turn happened).

### Classification and acceptance

The **label** and the **investigation** are judged separately:
- **Classification verdict, per expected test** (multi-test scenarios keep every test's verdict; nothing is collapsed to a worst case): `exact`, `acceptable_alternative` (listed in the truth file, at or below its `maxConfidence`), `reviewable_alternative` (listed under `reviewableAlternatives`, and its reasoning matches the `requires` criterion), `incorrect`, `abstained` (`Inconclusive` when something else was expected) or `missing`. There is no partial credit. An alternative above its confidence cap is `incorrect`, and so is a reviewable alternative whose reasoning lacks the required element (for S08, explicit caution).
- **Reviewable alternatives are decided by a person, never automatically.** The `classification` check is `review`, the run is `needs_review`, and acceptance stays `pending_review` until a reviewer passes the `classification` check (then the diagnosis can be accepted) or fails it (then it is blocked). Their confidence is not judged automatically, so a confident but cautious alternative is not rejected for its confidence alone. The verdict itself never changes, so exact agreement counts stay separate.
- **High-confidence incorrect:** an `incorrect` verdict at High confidence is flagged on the verdict (`highConfidenceIncorrect`), fails the `confidence` check and is listed in the summary.
- **Acceptance** (`acceptance.status`): `accepted` only if the run is eligible, every test is `exact`, and every other check passed or doesn't apply. `not_accepted` lists the blockers. `pending_review` lists the open reviews (checks or audit). `not_eligible` covers excluded runs. A correct label with unsupported or false evidence therefore counts as a correct label but is not an accepted investigation.

### Checks

Each check is `pass`, `partial`, `fail`, `review` or `not_applicable`, with items explaining it. Items carry a stable `tag` (provenance, verdict, `criterion`, `forbidden`, `high_confidence_incorrect`) used by the reporter. Checks run only for `scored`, `needs_review` and `unverified`, except `structured_output`, which always runs.

| Check | Rule |
|---|---|
| `structured_output` | `result.json` parses as `InvestigationResult`, runStatus isn't `invalid_output`, and the transcript's structured output re-validates against `ModelReport`. |
| `report_status` | Exactly the expected `reportStatus` (taken from runStatus when the CLI stopped the session before any model report). |
| `coverage` | Every expected test (title + file) was investigated under a testId with an observed `get_failure_details` result, and the MCP tools reported the outcome the truth expects (`reportedOutcome`, default `unexpected`; a mismatch fails as `outcome_mismatch`). An unlisted extra test means review; a testId with no observed result fails. |
| `classification` | Per test: `exact` passes, `acceptable_alternative` is `partial`, `reviewable_alternative` is `review`, anything else fails. |
| `root_cause` | Searched in `failureSummary`, the analysis points and the confidence justification; a verification-only criterion (v7, see below) also in `verificationSteps`. Every criterion matched passes; a missing criterion means review. A forbidden claim means review (v9: unless every match is clearly negated, which leaves a `forbidden_negated` audit item), except one with `severity: "fail"` stated in a plain sentence, which fails (`forbidden_definitive`); in a hedged or negated sentence (may, might, cannot, unclear, whether, no evidence, …) it goes to review. |
| `evidence_validity` | Every evidence claim, graded by provenance (table above). `skipped` is not verified. |
| `evidence_sufficiency` | Each `requiredEvidence` item: verified **and** reported passes (a trace may be verified through a `get_trace_summary` result, see scorer version 8); verified but not reported, or unresolved provenance, means review; reported but unsupported or confirmed false fails; neither inspected nor reported fails (`not_inspected`, or `access_denied` when every read was denied). Each `unavailableEvidence` kind: reported `not_available` passes; claimed `inspected` fails; `skipped`, or absent from the list but named as unavailable in the reasoning, means review; not acknowledged at all fails (`unacknowledged`). |
| `trace_consistency` | Scorer v8. Structured trace claims in evidence notes and analysis points that cite `get_trace_summary`, compared with the summaries obtained for that test (the cited retry, else all). Checked shapes only: retry attribution and the stated trace status per retry; a request path with one HTTP status; the route marker; the fetch link; a status change (`statusChanged`, "changed"/"unchanged"); the status the backend returned; "test-created"; "no backend fetch"; absence claims ("no page errors", "no failed requests", …); "complete trace". **Pass** (`consistent`) when a summary shows it. **Fail** only for a clear contradiction (`contradiction`), a retry whose trace was not obtained (`retry_mismatch`), or a claim with no obtained trace evidence at all (`unsupported`). **Review** (`unresolved`) when the summary can't decide: it is partial or omits records, no fulfillment is linked to a fetch, or several values can't be paired. `fulfilled` alone never confirms "test-created"; a pass-through link (`linked`, `statusChanged: false`) contradicts it. An unlinked fulfillment never shows that no backend fetch happened; recorded `backendFetches` contradict that claim. A partial summary never shows that something is absent. `not_applicable` when no claim cites the tool. |
| `citations` | Each `evidenceRefs` entry: a verified file or obtained MCP result passes; unresolved provenance, free text, or a file whose every read was denied (`access_denied`: the point may only report the failed access) means review; an unsupported file, a nonexistent path, a path outside the workspace or an MCP result never obtained fails. Bare file names resolve to a unique snapshot path. |
| `confidence` | `exact` with the level outside `expected.confidence`: review (`confidence_outside_range`), not fail. `acceptable_alternative`: within its cap. `reviewable_alternative`: not applicable (judged in the classification review). `incorrect` at High: fail (`high_confidence_incorrect`). Otherwise recorded for calibration only. |
| `source_mismatch` | Equals `expected.sourceMismatch`. |
| `recommendation` | An acceptable pattern in `proposedFix` (a verification-only one also in `verificationSteps`) and no forbidden pattern in `proposedFix` or `verificationSteps` passes (v9: a clearly negated forbidden match doesn't count; v10: the acceptable pattern must be a corrective one, supporting ones alone mean review; v11: the matched acceptable fix must also be endorsed, not negated, retracted or only reported; v12: a forbidden match is negated only when it reads negated both with and without the field's line breaks); anything else means review. |
| `process` | From the transcript: a successful `Skill` call for `investigate-failure` (reading SKILL.md as a file doesn't count), `list_test_failures`, and `get_failure_details` for every investigated and listed testId. Permission denials are counted. |

`metrics` holds wall-clock time (from `outcome.json`), session duration, turns, tokens, tool calls, permission denials and `estimatedUsageCostUsd` (an SDK estimate, not a charge).

### Scorer version 6 (Stage 2.6.2)

Added for the Stage 2.6 scenarios. Every new rule applies only when the truth file uses the new optional fields, so the pilot results are unchanged. Re-scoring copies of the saved S02, S04 and S05 runs gave identical categories, acceptance, verdicts, check and item statuses, audit results, inputs and metrics, with no wording changes; the stored v5 score files were not touched.
- Score records carry `failureType`, and each test verdict its observed `outcome`; files from earlier versions read as `null` (reported as failure type "unknown").
- Forbidden claims are also searched in the confidence justification.
- How the Stage 2.6 decisions are encoded:

| Scenario | Encoding |
|---|---|
| S01 | No acceptable alternative. Application defect is reviewable only with reasoning about a requirements ambiguity. |
| S07 | `reportedOutcome: flaky`. High or Medium confidence fits. Environment issue is reviewable only when it cites the observed 500. Recognizing the failed first attempt and the passing retry is a root-cause criterion, so without it the run stays pending review and is never accepted automatically. A frequency or recurrence claim (`frequency-claim`) fails when stated plainly. |
| S08 | Inconclusive at Low or Medium. Application defect and Environment issue are reviewable only with explicitly cautious reasoning (uncertainty or missing evidence named). Definitive claims about the server, the response, the test or the network fail when stated plainly. The fixture's hang is not visible to the investigator, so "the API was hung" is such a claim. `unavailableEvidence: [trace, screenshot]`. |
| S09 | `sourceMismatch: true` (a miss fails). Inconclusive is reviewable when grounded in the mismatch. Criteria require recognizing that the source changed and recommending a re-run; missing either means review, so no automatic acceptance. Assuming the failure persists, or treating the corrected source as proof it never happened, fails. |
| S10 | `no_failures` and no tests. A different status fails `report_status`; an invented investigation fails `coverage` (and the CLI marks the run `unverified`). `get_failure_details` is not required. |

**Known limits.** These are regex heuristics over the model's text:
- The hedge rule is lexical. A plainly stated claim phrased outside a pattern is missed (at worst it shows up as an unmatched criterion, which means review). A plain claim inside a sentence that happens to contain a hedge word goes to review instead of failing.
- "Mandatory" recognition (S07's retry, S09's re-run) is a criterion: missing it blocks automatic acceptance through review rather than failing, because a regex miss may be a paraphrase.
- A reviewable alternative's `requires` match shows the reasoning names the right thing, not that it is sound. That is why a person decides.

### Scorer version 7 (after the Stage 2.6 live runs)

Two labelling problems the live runs exposed. Neither changes what a correct investigation must contain.

- **Verification steps.** S09's live answer recommended the re-run only as a verification command, so v6 sent a correct answer to review. In v7 a criterion is **verification-only** when every one of its patterns matches a pure re-run phrase (`rerun`, `re-run`, `run it again`, `run the test again`, `npx playwright test`). Only such criteria and acceptable recommendations may be met from `verificationSteps`, and the item says so (`in verificationSteps`). Across the current truth files that is S09's two `rerun` items and nothing else. A causal criterion (S07's `flaky`) or a fix (S03's `web-first`) never is, so a verification command cannot stand in for a diagnosis or a fix. Forbidden recommendations are searched in `proposedFix` **and** `verificationSteps`, so a valid re-run cannot hide a fixed wait.
- **Denied access.** In S07 the agent's only trace command was denied, and it reported the trace honestly as "not available". v6 labelled that a false absence and the citation of the trace as fabricated. v7 adds `access_denied`, recorded only when every attempt on that file was denied (an SDK permission denial with an error result). The "not available" claim then passes; a citation of the file goes to review, because a regex can't tell a point that reports the denial from one that claims its contents; required evidence still **fails**, because its contents were never obtained. Claiming to have inspected a denied file stays `confirmed_false`. A later successful read is `verified`. A command that merely failed keeps the v6 labels.

**Parity on copies of the seven live runs** (S02, S04, S05 stored at v5; S08, S07, S03, S09 at v6). Rescored copies; the stored files were not touched.
- S02, S04, S05, S08, S03: identical categories, acceptance, verdicts, check and item statuses and tags, audit, cleanup and inputs, with no wording changes.
- S07: still **not accepted**. evidence_validity fail → pass (`false_unavailable` → `access_denied`); citations fail → review (`confirmed_false` → `access_denied`); evidence_sufficiency stays fail (`not_inspected` → `access_denied`). The blockers shrink to `evidence_sufficiency`; root_cause and citations are pending.
- S09: root_cause and recommendation review → pass (the `rerun` items matched in `verificationSteps`), so it would be accepted automatically. The manual review reached the same decision.
- The S08 and S09 reviews name the scores they judged by hash, so on a v7 rescore they would be reported as stale. The saved runs stay at their versions until a rescore is approved.

### Scorer version 8 (Stage 3.4)

Recognizes `get_trace_summary` (Stage 3.2/3.3) as a source of trace evidence and compares structured trace claims with what it returned. A session that never calls the tool scores exactly as under v7, plus the new records below.
- **Provenance** (see the note under the provenance table): a call counts only with status `ok` or `partial`, tied to its `testId`, `retry` and report (its fingerprint must be the snapshot's, like every MCP result). The transcript audit expects the tool.
- **Required trace observations.** A truth `requiredEvidence` item of kind `trace` may list `observations` (`source` browser or backend, a `path` regex, optional `status` and `marker`). Met through MCP only if a returned summary contains each one. A partial summary that lacks one goes to **review** (it may be in the unread part), never pass or fail. Without `observations` (every current truth file), a fully read summary (`ok`) meets the requirement and a partial one goes to review. The field is optional; no truth file was changed.
- **`trace_consistency`** (new check, table above). Deliberately narrow: no free-text fact checking beyond the listed shapes, and only text that cites the tool.
- **Records.** `score.json` gains `traceEvidence.tests[]`: per expected test, `acquisition` (`mcp`, `bash` = the trace file read through a tool call, `mcp_and_bash`, `not_obtained`, `no_trace` = the report kept none), each call's `retry`/`status`/`reasons`, and coverage `limitations` (partial reads, omitted records). `inputs.model` and `inputs.mcpServerVersion` record the model the session reported and the server version captured before it (`null` = not recorded). Files from earlier versions read as `null`.

**Parity on copies of the seven live runs** (stored at v5/v6; first rescored as v7, then as v8, both on copies; the 58 stored files are byte-identical before and after). Between v7 and v8, for every run: categories, acceptance (blockers, pending), classification verdicts, every pre-existing check with its status, items, tags and wording, audit (violations, suspicious, expected, dismissed), cleanup, metrics, reasons and review flags are **identical**. The only differences: `scorerVersion` 7 → 8; `trace_consistency` added as `not_applicable` (no session called the tool); `inputs.model` (`claude-opus-5-5` for all seven) and `inputs.mcpServerVersion` (`null`: not recorded then); `traceEvidence`: S03, S04, S05 `bash`; S02, S07, S09 `not_obtained` (S02 and S09 had no need for it, S07's trace commands were denied); S08 `no_trace`.
- S07 stays **not accepted** (blocker `evidence_sufficiency`, pending `root_cause` and `citations`), as under v7.
- S08 and S09: their reviews are bound to the stored score files, which are unchanged, so they stay valid. On a rescored copy they read as stale (new hash), as designed; re-bound to the v8 score, the same decisions give the same reviewed result (S08 accepted after its `root_cause` review, S09 accepted).

**Known limits.** Claim extraction is regex-based. A paraphrased claim outside the listed shapes is not checked (not a pass, no item). A sentence with several paths and statuses is only checked for values that match none. The fulfill-to-request correlation is the tool's time window, so `trace_consistency` never ties a fulfillment to a request itself. Required observations exist only in test fixtures so far.

### Scorer version 9 (R3a: negation in forbidden items)

**Scope.** Only **review-severity** forbidden claims (`root_cause`) and forbidden recommendations (`recommendation`). Unchanged: `severity: "fail"` items (S07–S09; their sentence-level negation and hedge rules), root-cause criteria, acceptable fixes, evidence, citations, `trace_consistency`, classification and acceptance rules, every truth file and schema. No LLM: `src/eval/polarity.ts` is a pure, bounded, deterministic module (`src/eval/test/polarity.test.ts`).

**Matching.** Each report field (summary, each analysis point, the justification; the fix and each verification step) is searched on its own, on the whole field **and** from every clause start, so a truth lookbehind can no longer see a negator in an earlier clause (S13-E10). Matching is additive: every match v8 found is still found, plus those recovered from clause starts. Clause boundaries are `. ! ? ;`, commas, colons (not before a literal such as `true` or `500`) and `and`, `but`, `then`, `so`, `yet`, `however`, `whereas`, `although`, `though`; not `or`/`nor`, so "do not use force: true or dispatchEvent" negates both. Punctuation inside backticks or matched brackets (`setTimeout(() => {}, 500)`) is not a boundary.

**Polarity of each match, in its clause.**

| Polarity | When | Effect |
|---|---|---|
| negated | a negator before the match (not, no, never, nothing, none, neither, nor, without, avoid, cannot, n't, instead of, rather than), or the match is the subject of a directly negated predicate ("A longer timeout is not the answer", "won't help") | not flagged |
| ambiguous | a hedge ("can't rule out"), reported or quoted advice ("suggested to …"), a negation only in a subordinate clause ("if … not …"), a reversal ("no evidence against"), a double negation, a clause too long to judge | review |
| positive | anything else, including affirming negations ("don't forget to", "not only") | review |

**Cross-field matches.** v8 searched all fields joined by a space, so a pattern could match across two fields ("… if it is not, remove" + "the display: none rule …" for S11 `change-app`; any multi-word pattern can bridge a join, and `.{0,40}`/`.{0,30}` ones easily). v9 still runs that joined search. A joined match that starts where a field's own match starts is the same claim (a greedy pattern may only run on past the field's end) and is judged by that field's polarity, so a negated match isn't re-flagged. Any other joined match (it starts at a join, or where its field has no match, so it reaches into or depends on another field) is unresolved and goes to `review`, whatever the per-field polarities; its polarity is not judged. Without this, a field holding only a negated match would hide the cross-field one and could be accepted where v8 sent it to review (R1 S11-E8).

**Outcome per forbidden item.** Any positive or ambiguous match → `review`, tag `forbidden`, as before. A negated match never hides another match: one positive match among negated ones still goes to review. Every match negated → no finding; a `pass` item tagged **`forbidden_negated`** records the matches, their clause excerpts and reasons (at most 3 matches, excerpts capped). No match and no unresolved joined match → no item, as in v8.

**Truncated analysis → one review item per check.** A field with more than 50 matches of a pattern, or more than 500 clauses, or more than 50 joined matches, can't be fully judged, so incomplete analysis can never lead to acceptance. Instead of one finding per forbidden pattern, the check gets **one** `review` item, id `forbidden-analysis`, tag **`forbidden_incomplete`**, naming the fields and limits and up to 5 affected pattern ids ("forbidden recommendation analysis incomplete in proposedFix (max_clauses): a missing or negated match there is not trusted (sleep, more-time, …)"). Observed matches keep their own items: a positive or ambiguous one is its own `forbidden` review, a negated one stays a `forbidden_negated` audit item; either notes "(analysis incomplete, see forbidden-analysis)".

**Audit items are inert.** `forbidden_negated` items never decide a check's status (`fromItems` ignores them), so they can't change categories, acceptance, blockers or pending checks. The report counts only `forbidden` items as suspicious claims or recommendations (`forbiddenHits`); a `forbidden_incomplete` item is not a suspicious claim, so it isn't counted there, but it sends its check to review like any review item; evidence and citation checks never read these items. The score schema is unchanged (`tag` and `detail` are free strings). Reviews are per check, so they don't refer to these items.

**Conservative review, not automatic acceptance.** Polarity only ever removes a review trigger for a clearly negated match; it never accepts anything. A diagnosis is still accepted only when every check passes. Where the rules are unsure they send the item to review, which costs a reviewer's time, never a wrong acceptance. Known over-flagging, by design: "Do not add retries, sleeps or longer timeouts" (the comma ends the negation, so `longer timeouts` is flagged), "Avoid waitForTimeout and setTimeout" (`and` starts a clause), "another report suggested … but that is wrong" (reported advice stays ambiguous).

**Remaining limitation: truth-level guards still suppress.** S13 (all items) and S14 (`timing`, `checkbox-missing`, `app-broken`, `change-app`) embed negation lookbehinds. When a guard sees a negation in the same clause, the regex produces no match, so polarity has nothing to judge: "Do not forget to increase the timeout." (S13-E11) is still accepted without a `more-time` flag. Only a revised truth guard fixes that class; R3a changes no truth file. Paraphrase gaps (e.g. "increasing the timeout" matches no `more-time` pattern) are untouched.

**Residual risks.** (1) Same-start equivalence: a joined match that starts where a field's own match starts is treated as that field's claim and judged by its polarity; if the part that runs on into the next field changed the meaning, v9 would not see it. (2) Unresolved cross-field matches are not polarity-judged, so a negated statement split across two fields goes to review (over-flagging, never acceptance). (3) Regex execution time is not bounded: `POLARITY_LIMITS` caps matches, clauses and windows, not the time a truth pattern takes on a long field. (4) The `severity: "fail"` path keeps its own sentence-level negation rule, so there are two notions of negation.

**History is immutable.** v8 records keep their meaning; no saved run was rescored, no snapshot regenerated, and truth hashes are unchanged. `score` refuses to replace a stored v8 score without `--rescore`, and combined reports flag mixed versions.

**Parity on copies of the 14 saved live evaluations** (v8 = a `git archive` of `c4fe7bd`, v9 = this tree; same snapshots, the truth files whose hashes the runs recorded, which are the current ones). The seven scores stored at v8 recompute byte-identically under v8. Between v8 and v9, every score file is byte-identical apart from `scorerVersion`: no forbidden item, check, category or acceptance changed. The saved sessions contain no review-severity forbidden match (their only forbidden item is S08's severity-fail `definite-response`, unchanged), so this shows no regression but gives no field evidence for the new rules; that comes from the R1 corpus and the unit tests.

### Scorer version 10 (R3b: recommendation roles)

**Problem.** The `recommendation` check passed as soon as any acceptable-fix pattern matched. S13 lists an optional fail-fast status check (`check-status`) with the same weight as the real fix (`fix-server`), so a report that only adds `waitForResponse` and never says to investigate or restore the endpoint returning 503 was accepted (R1 S13-C5).

**Mechanism.** An acceptable fix may carry `role` in the truth file: `corrective` (the default when omitted, i.e. every v9 truth) or `supporting`. `GroundTruth` rejects any other value and an acceptable list whose every entry is supporting (an empty list stays valid); other criteria take no role. Corrective means the action addresses the diagnosed defect, or, when the diagnosis is uncertain, the investigation that resolves it ("investigate the endpoint", "collect the server logs"); no speculative code change is required. Supporting means a useful addition (a diagnostic, an extra assertion) that never satisfies the recommendation alone.

| Matched acceptable fixes | `acceptable` item |
|---|---|
| at least one corrective (alternatives: any one) | `pass`, `matched <ids>`; supporting ones are listed as `<id> (supporting)` |
| supporting only, in `proposedFix` or (verification-only ones) `verificationSteps` | `review`, `only a supporting recommendation matched (<ids>); no corrective fix matched (<ids>)` |
| none | `review`, as before |

Forbidden recommendations are judged as in v9, so a corrective fix never hides forbidden advice. The item keeps its id and tag (`acceptable`), so the score schema, `report` serialization and aggregation are unchanged: a supporting-only item is a review, not counted in `acceptableMatched`. A supporting-only fix is never an automatic failure: a person decides whether it is enough. Classification, root cause, evidence and polarity are untouched. A truth without roles scores exactly as under v9.

**Truth use.** Only S13 sets a role: `check-status` (a `waitForResponse` / status assertion that makes the test fail fast) is supporting. `fix-server` and `keep-test` stay corrective. Every other truth is unchanged, so all their acceptable fixes are corrective; `score.test.ts` checks that each of them (S04, S05, S07, S08, S13, S14) still passes on its own and that S10 has none.

**S13-C5 fixed.** Under v9 a fail-fast status check as the whole fix was accepted. Under v10 with the new S13 truth it goes to review: `only a supporting recommendation matched (check-status); no corrective fix matched (fix-server, keep-test)`, pending `recommendation`. The R1 corpus keeps the case id (`FIXED IN v10`) and adds cases for each combination (see "Ground-truth regression corpus").

**Verified offline only** (no live v10 evaluation has run). On copies of the 14 saved live evaluations:
- *Reproducibility*: v9 (a `git archive` of `a437bb4`) and v10 (this tree), both against the original truths (`a437bb4`'s `evals/scenarios`), give byte-identical score files apart from `scorerVersion`. The saved S13 score (v8) also recomputes identically apart from `scorerVersion` under v10 with its original truth.
- *What-if* (modified truth, not a reproduction): the S13 copy scored by v10 against the new truth, with only the copy's `preflight.truthSha256` changed to the new hash (unchanged, the copy is `invalid_setup`). It stays `accepted`: the investigator's fix ("Find out why /reports/monthly.csv returns 503 … and restore it …") matches corrective `fix-server`, and `check-status` is listed as `(supporting)`. That label and the truth hash are the only differences.

The real saved runs, scores and snapshots were not touched.

**Remaining limitations.** `keep-test` ("the test itself needs no change") stays corrective in S04, S07 and S13, so it alone is still accepted although it doesn't address the server defect (R1 S13-C4); deciding that is out of R3b. Acceptable-fix patterns had no negation handling under v10: "Do not fix the server; add waitForResponse." matched `fix-server` and was accepted (R1 S13-C12; fixed in v11, see "Scorer version 11").

### Scorer version 11 (R3c: polarity of acceptable fixes)

**Problem.** Under v10 an acceptable fix counted as soon as one of its regexes matched `proposedFix`, wherever the match stood. "Do not fix the server; add waitForResponse." matched corrective `fix-server` inside the negated clause and was accepted (R1 S13-C12). A greedy pattern (`fix .{0,40}server`) could also match across a retraction: in "Fix the server. Actually, don't fix the server." its only full-text match ran over both sentences.

**Mechanism.** v10's regex match stays the **gate**: v11 judges only criteria v10 matched, so it never counts a criterion v10 didn't. Each gated criterion is then judged by `polarity.ts` in clause mode, over all of its `anyOf` patterns together:
- *Fields.* `proposedFix` is one field. A verification-only criterion also reads each `verificationSteps` entry as its own field, so a negation never reaches the next step (v10 joined them). Other criteria never read the steps (v7). The field text is exactly v10's search text (ANSI removed, whitespace collapsed); `collapseWhitespace` keeps its line breaks as offsets.
- *Line breaks.* A blank line, or a list item after another item, is a hard break (a clause boundary). Any other line break is soft: a match is judged with and without it, and if the readings differ it is ambiguous. A line that ends in a negator ("Do not⏎…"), or a break inside an open quote, is always soft. Breaks inside backtick code or brackets are ignored, so multi-line code stays one clause.
- *Clause-local matches.* Each pattern also runs on every clause alone, and only a match inside one clause can be positive. A match that crosses a clause boundary or a soft break is ambiguous (`spans_clauses`): it is never an instruction by itself.
- *Direct versus reported advice.* The author's own advice counts: "I/we [would|do|strongly|still] recommend|suggest|propose|advise [that] [you|we] …" and "my/our recommendation|suggestion|proposal|advice is|would be [to|that] …" are masked before judging, so the rest of the clause decides ("I recommend that you do not fix the server" stays negated). Any other "suggested", "recommended", "said" etc. (v9's reported words), and any other advice noun before the match ("the recommendation was to …"), make the match ambiguous. An advice noun before the match and "is/was wrong|incorrect|mistaken|misguided|a mistake" right after it make it negated (`rejected_advice`). These are fixed word lists, nothing broader.
- *Endorsement of one criterion* (in this order): a truncated analysis is unresolved; no clause-local match (only across clauses or fields) is unresolved; the same words positive in one clause and negated in another is a **conflict**; a positive match next to any negated or ambiguous match of the same criterion, whatever its words, is **unresolved**, because one criterion's patterns may name one action in different words ("fix the backend", "fix the server"), so a rejected alternative can't be told from a retraction; only positive matches are **endorsed**; only ambiguous ones are unresolved; only negated ones are **rejected**.

| Gated acceptable fixes | `acceptable` item |
|---|---|
| at least one corrective endorsed | `pass`, `matched <ids>` as in v10, then `; not counted: <id> (<verdict>: <matches>)` for each discounted fix |
| supporting endorsed only | `review`, v10's wording (`no corrective fix endorsed` when a corrective one was discounted), then the not-counted list |
| none endorsed, some discounted | `review`, `no acceptable fix endorsed; not counted: …` |
| none matched | `review`, as before |

Only an endorsed criterion counts for its role (v10's corrective/supporting rules are unchanged). Rejected, conflicting and unresolved criteria never count and never fail: they go to review. Criteria stay independent: one endorsed corrective fix is enough even when another criterion is rejected or conflicting (R1 S13-C16, S14-C8, S14-C9). Each discounted fix lists its verdict and at most three matches with polarity and reason, so the detail stays bounded. With nothing discounted, every detail is byte-identical to v10. Item id, tag, score schema, `report` serialization and aggregation are unchanged. Forbidden items, root cause, evidence, classification and `trace_consistency` are untouched; under v11 forbidden matching still ran without line breaks (fixed in v12, see "Scorer version 12").

**S13-C12 fixed.** v10: accepted. v11: `only a supporting recommendation matched (check-status); no corrective fix endorsed (fix-server, keep-test); not counted: fix-server (rejected: "fix the server" negated: negator_before)`, pending `recommendation`.

**Verified offline only** (no live v11 evaluation has run). On copies of the 14 saved live evaluations, scored by v10 (a `git archive` of `1de64ba`) and v11 (this tree), both against the truths the runs recorded (`a437bb4`'s `evals/scenarios`, every hash checked against `outcome.preflight.truthSha256`, S13 at `87577f61`): every score file is byte-identical apart from `scorerVersion`. Accepted fix ids, recommendation status, review findings, categories and acceptance are all unchanged; every matched acceptable fix in those sessions is endorsed. The real saved runs, scores and snapshots were not touched.

**Remaining limitations.**
- *Alternatives inside one criterion go to review.* "Do not fix the server; fix the backend." and "Investigate the backend; do not restore the CSV attachment." are unresolved (S13-C17), even when the second phrase is a real alternative. That is deliberate.
- *Wrapped lines.* A line break inside a match ("Investigate the⏎backend", S13-C24), or a fix on the line after a negated one ("Don't add a sleep⏎Restore the report endpoint", S13-C25), is unresolved, so a review. Both are KNOWN LIMITATION cases.
- *Wording.* "I'd recommend …" and "we'd suggest …" are not in the direct-advice list (ambiguous). A retraction outside the fixed forms ("… was a bad idea") or by pronoun ("don't fix it") is not recognized. Gerunds ("suggested fixing the server") match no pattern at all, as before.
- *Oversized fields.* An acceptable fix whose own analysis hits a polarity limit is unresolved, even when positive matches were seen before the limit, because a retraction may lie beyond it (R1 S14-E13–E15, whose fixes repeat "use a locator, " 505 times; they were already pending review for the forbidden-analysis item, so their acceptance and pending checks are unchanged). `maxMatches` applies per pattern, so another corrective criterion in the same field can still be endorsed; a field over `maxClauses` is incomplete as a whole, so nothing in it endorses (`score.test.ts`, "truncation invariant").
- *`keep-test`* stays corrective (S13-C4, unchanged).
- *R3d, separate.* Under v9–v11 forbidden items get no line breaks: "Restore the report endpoint.⏎- Don't mock it⏎- add retries: 2" collapses to one clause, so `retries` reads as negated and the fix is accepted. Adding breaks there alone is not monotone (a smaller clause can lose a reported word and turn ambiguous into negated). Fixed in v12 ("Scorer version 12").

### Scorer version 12 (R3d: line breaks in forbidden items)

**Problem.** v9–v11 judge a review-severity forbidden match in its clause of the whitespace-collapsed field, so a line break was no boundary. "Restore the report endpoint.⏎- Don't mock it⏎- add retries: 2" put "add retries" in the clause "- Don't mock it - add retries: 2": negated (`negator_before`), audit item only, accepted (R1 S13-E13). The same happened to a forbidden item on the line after any negated line or bullet, and to claims in `root_cause` (S14-E20).

**Mechanism (`forbiddenItem`, review severity only).** Each field is read twice by `polarity.ts` in text mode:
- *plain*: exactly v11 (no breaks).
- *lined*: the same text with the field's line breaks from `collapseWhitespace` (the text is checked to be identical; if it ever weren't, only plain is used and the field gets a `forbidden-analysis` review). A hard break (a blank line, or a list item after another item) ends a clause. A soft break (any other line break, and always after a line ending in a negator or "or") is judged both ways; if the readings differ the match is ambiguous (`line_break_scope`). The pattern is also searched from every break, so a truth lookbehind can't see a negator on an earlier line (S13-E16).
- *Merge by span*: a span keeps plain's match unless plain reads it negated and lined doesn't; a span only lined found keeps lined's reading. **A match is negated only when every reading that found it negates it**, so v12 never drops a review trigger of v11 (the no-review-removal invariant): reported advice that a blank line would cut off stays ambiguous (S14-E21), which lined alone would have accepted.
- *Truncation* in either reading gives the check's one `forbidden-analysis` item; line items count as clauses, so a field that only its line breaks push over `maxClauses` is now reviewed (S13-E22).
- *Unchanged*: cross-field matching (`crossFieldMatches` still uses plain's per-field matches, so a break-only match can't make a joined match look accounted for), severity `"fail"` items, acceptable fixes (v11), roles (v10), item ids, tags, statuses, the score schema and aggregation. A field without line breaks, or whose two readings agree, gets byte-identical details.

| Text (scenario) | v11 | v12 |
|---|---|---|
| "Restore the report endpoint.⏎- Don't mock it⏎- add retries: 2" (S13-E13) | `retries` negated, **accepted** | `retries` review (positive in "- add retries: 2"), pending |
| "…⏎⏎Don't add retries⏎- increase the timeout." (S13-E15) | `more-time` negated, **accepted** | ambiguous (`line_break_scope`), pending |
| "- Don't use force: true⏎- add retries: 2" (S14-E17) | both negated, **accepted** | `force` negated, `retries` review, pending |
| "- Don't use force: true⏎- Don't add retries⏎- Never add waitForTimeout" (S14-E18) | all negated, accepted | the same |
| "Another engineer suggested several things⏎⏎Do not increase the timeout." (S14-E21) | review (reported) | review (kept by the merge) |

**Conservative false reviews** (KNOWN LIMITATION cases): "Do not⏎increase the timeout." (S13-E17; v11 found no match because of S13's lookbehind, the break scan finds it and the two readings differ), code after "Do not mock it like this:" (S13-E18), "Never use force: true or⏎waitForTimeout." (S14-E19). All three go to review, never to acceptance.

**Remaining limitations.** An inline " - " or "→" separator without a line break is no boundary, so "Don't mock it - add retries: 2" is still negated and accepted (S13-E19). Truth-regex gaps stay: "adding retries", "sleeps", and S13's lookbehind hiding "Do not forget to increase the timeout." (S13-E11). Quoted advice that the report rejects stays ambiguous (review). Severity `"fail"` items still split sentences after collapsing whitespace, so a negator on the previous line turns a plain statement into review instead of fail (never into a pass); R3d leaves them unchanged.

**Verified offline only** (no live v12 evaluation has run). Before any R1 expectation changed, the unchanged suite under v12 failed only the version pin (805 tests). On copies of the 14 saved live evaluations scored by v11 (a `git archive` of `75af6a5`) and v12 (this tree) against the truths the runs recorded (`a437bb4`'s `evals/scenarios`, every hash checked, S13 at `87577f61`), every score file is byte-identical apart from `scorerVersion`: none of those sessions has a review-severity forbidden match. The real saved runs, scores and snapshots were not touched.

### Stage 3.5 live runs

One live session each of S07, S05 and S04 with Skill `bb6a78c5`, MCP server 0.2.0, scorer v8, `claude-opus-5-5`, SDK 0.3.302 and subscription auth, run from commit `d479526`. The earlier runs of the same scenarios used Skill `995a548c` and are stored at scorer v5/v6, so the two columns differ in Skill and scorer version: compare them as single sessions, not as like-for-like measurements.

| Scenario | Run | Classification (verdict) | Trace evidence | Denials / audit (violations/suspicious/dismissed) | Automatic acceptance | Reviewed acceptance | Turns / duration / SDK-estimated cost |
|---|---|---|---|---|---|---|---|
| S07 (flaky backend 500) | `live-S07-20261022T064416Z` | Application defect, Medium (exact) | not obtained (compound Bash command denied, not retried) | 1 / 0/0/0 | not accepted (evidence validity, sufficiency, citations fail) | not accepted | 11 / 31.4 s / $0.152 |
| | `live-S07-20261023T181747Z` | Application defect, High (exact) | `get_trace_summary` retry 0 `ok` | 0 / 0/0/0 | pending review (`trace_consistency`) | accepted | 11 / 53.6 s / $0.274 |
| S05 (test-mocked 500) | `live-S05-20261021T211540Z` | Test-code defect, High (exact) | Bash `unzip -p … \| grep` | 0 / 0/0/0 | accepted | accepted | 10 / 27.7 s / $0.124 |
| | `live-S05-20261023T191300Z` | Test-code defect, High (exact) | `get_trace_summary` retry 0 `ok` | 0 / 0/0/0 | pending review (`root_cause`) | accepted | 11 / 27.9 s / $0.178 |
| S04 (backend 500) | `live-S04-20261021T210049Z` | Application defect, High (exact) | Bash `unzip -p … \| grep` (after one denied call) | 1 / 0/0/3 | accepted | accepted | 12 / 55.6 s / $0.167 |
| | `live-S04-20261023T191659Z` | Application defect, High (exact) | `get_trace_summary` retry 0 `ok` | 0 / 0/0/0 | accepted | accepted | 12 / 43.2 s / $0.222 |

Costs are the SDK's estimate at list prices, not charges. Every Stage 3.5 workspace was removed after bounded EBUSY retries (infrastructure only).

- **What changed.** Each new session obtained complete trace evidence through the tool, with no denials and no Bash fallback. The old S05 run decided "test-created" from `_wasFulfilled:true` alone, which the Stage 3.3 Skill no longer allows; the new one combined the route handler's source (no `route.fetch()`), the unlinked fulfillment and zero backend fetches in a complete trace. The new S07 run is the first accepted S07.
- **Why two runs needed review.** Both were scorer pattern gaps, not diagnostic errors. S07: analysis point 5 ("the trace does not show why the backend returned 500") matched the `trace_consistency` fetched-status shape, which compares against `backendFetches` (API-context fetches only, none here), so it went to review. S04 said "server returned 500" in the same place and produced no item. S05: the `test-mock` root-cause criterion matches `page.route`, `route.fulfill`, mock, stub or intercept; the report said "the test's own route handler answered … with a 500" and "test-injected 500", and "mocks" appeared only in the top-level message, which `root_cause` does not search.
- **Recurring report issues** (not scored): in all three new reports at least one point labelled Observed ends with a conclusion (S07 point 2, S05 point 2, S04 point 3); S07 and S04 needed a second `StructuredOutput` call after unparseable JSON. That happened in 5 of the 10 saved live runs (S02, S03, S08 as well, across all three Skill versions), and every time the SDK's own validation rejected the call and the model's next call succeeded.
- **Not a reliability estimate.** Three single sessions on synthetic, deterministic scenarios show what those sessions did. They give no success rate, interval or run-to-run variance.

### Stage 3 retrospective

What Stage 3 (3.2–3.5) changed, and what the three Stage 3.5 sessions do and don't show. Every count below is one session per scenario.

- **Results.** All three Stage 3.5 sessions classified exactly at High confidence. **Automatic** acceptance: S04 only. **Reviewed** acceptance: all three; S07 and S05 each had one check pending review (`trace_consistency`, `root_cause`), both scorer pattern gaps (above), decided by a review. The earlier sessions of the same scenarios were also exact (S07 at Medium); S05 and S04 were accepted automatically and S07 was not accepted.
- **Structured trace evidence.** In Stage 3.5 every trace was obtained through `get_trace_summary` (retry 0, status `ok`; `traceEvidence.tests[].acquisition: mcp`), with no Bash trace command and no permission denial. The earlier sessions of the same scenarios used Bash pipelines (S05; S04 after one denied call) or obtained nothing (S07, denied and not retried). All three CLI results are `completed` with no consistency issues, so every cited summary was observed in the stream.
- **Historical comparisons are not like-for-like.** The two sessions of each scenario differ in Skill (`995a548c` → `bb6a78c5`), scorer version (v5/v6 → v8) and date. The seven earlier runs stay at their stored versions; their v8 parity was checked on copies only ("Scorer version 8").
- **SDK-estimated usage.** Stage 3.5: 34 turns, 124.7 s and $0.674 in total; the earlier sessions of the same scenarios: 33 turns, 114.7 s and $0.443. The dollar figures are the SDK's `total_cost_usd` estimate at list prices; the sessions ran on subscription auth, so they are not charges. The estimate is higher for each Stage 3.5 session than for the earlier one; with one session each, that is an observation, not a measured cost of the change.
- **Security.** `get_trace_summary` is read-only, takes no path from the client, reads only the requested attempt's whitelisted trace entries through a bounded ZIP layer, and returns only allowlisted, sanitized fields (README, "`get_trace_summary`"). Its path redaction is heuristic: short identifiers and the API structure pass through, so a summary is low-sensitivity, not safe to publish. Stage 3.6 removed the raw trace Bash permissions (`unzip -l`, `unzip -p`, `grep`, `head`) and denies `unzip` in the CLI, so the sanitized summary is the only approved way into a trace; `ls` stays for source modification times. Scorer v8 still grades Bash trace reads found in older transcripts (`acquisition: bash`), so the historical runs keep their meaning.
- **Report clarity.** All three Stage 3.5 reports had an Observed point ending in a conclusion, and two needed a second `StructuredOutput` call. Stage 3.6 tightened the Skill's labels (Observed = retrieved facts only) and added a schema-validity check to the CLI's output instructions, without changing `ModelReport` or adding retries. Neither change has been run live.
- **Supported trace format.** Only format `version: 10` (Playwright 1.64.1), exercised with Chromium traces only. Any other, missing or mixed version is reported `unsupported` with a reason code, never interpreted as version 10.
- **Manual-review provenance.** The S07 and S05 reviews were drafted by Claude Code and name it as `reviewer` (see "Human review"). They record a decision, not an authenticated human sign-off.
- **Exit codes.** The S04 command reported exit 255 because a PowerShell `Select-Object -First` pipe ended it early; the run itself had finished and was saved. `eval live` exits 0/1/2/130 ("Live adapter"); read `$LASTEXITCODE` from an unpiped command.

### Live runs of S11, S13 and S14

One live session each, in the order S14, S11, S13, run from commit `266899a` with Skill `3a205d3b` (Stage 3.6, the same as the S12 run), MCP server 0.2.0, scorer v8, `claude-opus-5-5` (Claude Code 2.1.302), SDK 0.3.302 and subscription auth. Limits: `--max-budget-usd 0.5 --max-turns 20 --timeout 240`, one session each, no retries. Each run was scored by the live adapter as it finished. No review was needed, so there is no `review.json`.

| Scenario (mechanism) | Run | Classification (verdict) | Trace evidence | Denials / audit (violations/suspicious/dismissed) | Automatic acceptance | Turns / duration / SDK-estimated cost |
|---|---|---|---|---|---|---|
| S14 (element handle kept across a DOM replacement) | `live-S14-20261111T000802Z` | Test-code defect, High (exact) | not requested (optional) | 0 / 0/0/0 | accepted | 10 / 30.6 s / $0.225 |
| S11 (link hidden until its photo is hovered) | `live-S11-20261111T001123Z` | Test-code defect, High (exact) | not requested (optional) | 0 / 0/0/0 | accepted | 10 / 29.4 s / $0.151 |
| S13 (report download answered with HTTP 503 by the fixture server) | `live-S13-20261111T001753Z` | Application defect, Medium (exact) | `get_trace_summary` retry 0 `ok` | 0 / 0/0/0 | accepted | 11 / 48.5 s / $0.204 |

Costs are the SDK's estimate at list prices, not charges (subscription auth). Every workspace was removed after two or three bounded lock retries, under 1 s (infrastructure only).

- **What the sessions did.**
  - S14: cited the `elementHandle.check` "not attached" error, showed the handle was taken before the reset, and used error-context (a replacement checkbox and "Preferences reset") to infer the node replacement. It recommended a Locator.
  - S11: cited "Received: hidden" with the locator resolving to the link, read the spec's missing hover, and used the page's instruction to infer hover-dependent visibility. It recommended hovering the photo first.
  - In both, the replacement and the hover appear as Inference, not as Observed.
- **S13's trace evidence.** The required trace item with its `observations` (`/reports/monthly.csv`, status 503, marker `none`) was met through `get_trace_summary`. All 5 trace claims were consistent with the summary. The report didn't treat `marker: none` alone as proof of a live backend: it combined the marker with "no route in the spec" and "no route activity in the trace". It kept Medium confidence, saying the artifacts don't show whether the 503 comes from the code or an unavailable dependency, and named no specific cause. All 6 root-cause criteria matched; the fix matched `fix-server` and `check-status` (under the R3b truth `check-status` is supporting; the stored score stays at v8 with truth `87577f61`, see "Ground truth versions"). The Environment alternative and S13's negation guards were not exercised.
- **S13's first structured output was invalid JSON.** The SDK rejected the call ("could not be parsed as JSON"), and the model's next `StructuredOutput` call in the same session succeeded. The audit records both calls under `expected`. That is the same in-session recovery seen in earlier runs ("Stage 3.5 live runs"), not a retry by the adapter. S14 and S11 needed one call each.
- **Minor, unscored.** S11's fix also switched `getByText` to `getByRole('link')` without saying why. That is correct after the hover, but unneeded.
- **Not a reliability estimate.** Three single sessions on synthetic, deterministic scenarios show what those sessions did. They give no accuracy rate, interval or run-to-run variance, and they don't show how the agent would do on unseen or natural failures.
- **Local data.** The run directories, like every saved run and snapshot, are gitignored (`evals/runs/`, `evals/snapshots/`) and exist only on the machine that produced them. The figures here are the record; anyone with only the repository can regenerate the snapshots offline, not these runs.
- **Scorer v8 stays as it is.** Its known wording limits (the fetched-status claim shape compared only with API-context `backendFetches`; the `test-mock` root-cause vocabulary missing "route handler" phrasing; `root_cause` not searching the top-level `message`) send correct answers to review, never to a wrong pass or fail. A scorer v9 is deferred; any change would be checked for parity on copies first, never tuned to these three runs. (Later, R3a added v9 for negated forbidden matches, not for these limits; see "Scorer version 9". These runs stay at v8.)

## Reports (`report.ts`)

`summary.json` (schema `Summary`) and `summary.md` keep two diagnostic metrics apart and never merge them into one number:
- **Classification agreement:** verdict counts over *eligible investigations* (one per expected test in an eligible run), `exact k/n`, with how many are still pending review.
- **Fully accepted diagnosis rate:** accepted / eligible runs, plus pending-review and not-accepted counts. It requires an exact classification, passing root cause, evidence, citations and recommendation, and every required review resolved.

Always visible alongside them: a by-failure-type table (evaluations, eligible, investigations, exact, reviewable alternatives, fully accepted), each test's observed outcome (`unexpected`, `flaky`) next to its verdict, attempted evaluations, every excluded category with its count, eligible runs with pending reviews, high-confidence incorrect diagnoses (listed), a confusion matrix and confidence-vs-verdict calibration over eligible investigations, per-check status counts, evidence and citation provenance counts, trace-claim counts (consistent, contradictions, retry mismatches, without trace evidence, unresolved; v8), trace evidence acquisition per expected test (MCP, Bash, both, not obtained, no trace kept), `get_trace_summary` results by status and the coverage limitations of what was obtained (descriptive, not an acceptance criterion), root-cause and recommendation results, usage totals and maxima over all attempts, per-scenario-and-test agreement across attempts, the truth hashes used, the investigator Skill per evaluation (`skillVersions`, from `outcome.json` `preflight.skillSha256`; more than one is flagged, because results from different Skills are not like-for-like), and per-evaluation details, including each review's reviewer and date. Per evaluation, a provenance and usage table lists the run, scorer version, truth hash, Skill hash, model, MCP server version, snapshot fingerprint, duration, wall clock, turns, input/output tokens, tool calls, SDK-estimated cost, audit counts (violations / suspicious / dismissed) and workspace cleanup. Different scorer versions in one summary are flagged. If the run is scorer validation, a notice at the top says the numbers test the scorer and are not agent-performance measurements. A live summary always states its sample instead (scenarios and attempts per scenario) and that it does not establish statistical reliability: the report computes counts only, never rates, intervals or variance.

Counts and denominators, not percentages: the dataset is small.

**Combined reports.** `report --run a --run b ... --out <dir>` aggregates several scored runs (for example one live run per pilot scenario) into `<dir>/summary.json` and `summary.md`; the directory name becomes the summary's ID, and `summary.runs` lists each source run with its evaluations. It reads only `score.json` and `review.json` and writes nothing into the source runs; scoring, transcripts, results and ground truth are untouched. It refuses runs with different `source` labels (scorer-validation fixtures are never counted as agent performance), an evaluation ID that occurs in two runs, a review naming another run's evaluation, and an `--out` that is, contains or lies inside a source run or already holds anything but a previous combined summary.

## Human review

Optional `review.json` in the run directory (schema `ReviewFile` in `report.ts`):

```json
{
  "formatVersion": 1,
  "reviews": [
    {
      "evalId": "S02-03",
      "reviewer": "your-name",
      "reviewedAt": "2026-10-21",
      "scoreSha256": "<sha256 of the score.json you reviewed>",
      "checks": { "root_cause": { "status": "fail", "note": "Blames the password, not the locator." } },
      "audit": { "verdict": "clean", "note": "The outside path was a harmless temp file." },
      "note": "optional free text"
    }
  ]
}
```

- Reviews **never modify `score.json`**. `report` shows the automatic and the reviewed results side by side: `automatic` and `reviewed` metrics, and both values per check, category and acceptance status.
- Only `coverage`, `root_cause`, `evidence_validity`, `evidence_sufficiency`, `citations`, `trace_consistency` (v8) and `recommendation` can be reviewed, to `pass`, `partial` or `fail`, plus `classification` for a run with a `reviewable_alternative` verdict: `pass` accepts the alternative as defensible, anything else blocks acceptance. A `classification` review of any other verdict is rejected and reported. Exact checks can't be reviewed, and no review changes a verdict.
- `audit.verdict` resolves suspicious findings (`clean`) or confirms them (`violation`). A confirmed violation can't be cleared.
- Check overrides on runs that aren't eligible (unverified, invalid, …) are rejected and reported.
- After review, a `needs_review` run becomes `scored` once no `review` check and no open suspicious finding remains, and its acceptance is recomputed from the reviewed statuses.
- `scoreSha256` ties a review to the exact score it judged. If `score.json` changes (only possible with `--rescore`), the review is reported as **stale** and not applied, and the reviewed score stays in `score-history/`.
- **Reviewer provenance.** `reviewer` is free text, recorded as written and never authenticated. A review drafted by Claude Code names it as the reviewer (the Stage 3.5 S07 and S05 reviews do); there is no confirmation or sign-off mechanism, so a person's name belongs in `reviewer` only when that person wrote or explicitly adopted the review in the file. Agreement given elsewhere (for example in conversation) is not recorded by the review schema. Reports show the reviewer next to each reviewed result, and the automatic result always stays visible beside it.

## Scorer-validation fixtures

`src/eval/test/golden.ts` builds **scorer-validation fixtures**: synthetic saved runs of S02 whose `run.json` says `source: "scorer_validation"`. They exist to test the scorer and reporter and are never measurements of agent performance. Each replays a scripted SDK stream through the **unchanged** `runInvestigation` + `evalQuery`, in a real workspace made from a fake-Playwright snapshot, so `result.json` is exactly what production produces for that stream.

The 23 evaluations cover:
- **Diagnoses:** correct, wrong classification at High confidence, correct label with a wrong root cause, abstention, forbidden recommendation.
- **Evidence:** unsupported, confirmed false (failed read; nonexistent file; false "not available"), unresolved (MCP snippet only).
- **Process:** missing Skill invocation, missing MCP calls.
- **Run failures:** invalid output, timeout, session error, auth refused, unexpected MCP unavailable, setup failure.
- **Integrity:** canary leak, protected read without a canary, suspicious paths, tampering, fingerprint mismatch, changed snapshot.

`node src/eval/test/golden.ts <outDir>` writes them for a manual demo.

`src/eval/test/golden-scenarios.ts` does the same for the Stage 2.6 scenarios S01, S03, S06, S07, S08, S09 and S10, with fake-Playwright snapshots of the real scenario files (their output matches what 2.6.1 observed), scored against the **real** truth files by `score-scenarios.test.ts`. Each of its 42 variants states the category, acceptance and verdict it must get:
- **Accepted:** a correct diagnosis for each scenario, including S07 at High confidence and S10's `no_failures`.
- **Reviewable (pending review):** S01 Application defect citing a requirements ambiguity, S07 Environment issue citing the 500, S08 cautious Environment issue, S09 Inconclusive citing the mismatch; plus S07 without the retry recognized, a hedged recurrence remark, and S09 without a re-run recommendation.
- **Not accepted:** S01 Application defect at High, S03 blaming a slow backend, S06 claiming an application error, S07 frequency claim, S07 Environment issue without the 500, S08 definitive Application defect, S08 cautious answer that still states a definitive cause, S09 missed mismatch, S09 denying or assuming the failure, S10 wrong status, S10 invented investigation (unverified).
- **Artifact availability**, kept apart explicitly:

  | Case | Example | Result |
  |---|---|---|
  | Genuinely absent, reported not available | S08 trace and screenshot | pass (`unavailable`) |
  | Present, optional, skipped | S01 screenshot and trace | pass (`skipped`) |
  | Present and required, not read or reported | S01 error context | `evidence_sufficiency` fail (`not_inspected`) |
  | Present, claimed not available | S01 error context | `evidence_validity` fail (`false_unavailable`) |
  | Present, claimed inspected, never read | S01 error context | fail (`unsupported`) |
  | Absent, claimed inspected with a path | S08 trace | fail (`confirmed_false`) in both checks |
  | Absent, claimed inspected without a path | S08 trace | validity review (`unresolved`); `unavailable:trace` fails (`confirmed_false`) |
  | Absent, not acknowledged | S08 trace and screenshot | `evidence_sufficiency` fail (`unacknowledged`) |
  | Present, every read denied, reported not available (the S07 live shape) | S07 trace | validity pass and citation review (`access_denied`); `evidence_sufficiency` fail (`access_denied`); not accepted |
  | Present, denied, then read with the documented command | S07 trace | `verified`; accepted |
  | Present, every read denied, claimed inspected | S07 trace | `confirmed_false` in validity and sufficiency |
  | Present, command failed without a denial, reported not available | S07 trace | v6 labels: `false_unavailable`, citation `confirmed_false`, `not_inspected` |
- **Verification steps (v7):** S09 with the re-run only as a verification command is accepted; the same with an incorrect High-confidence class is not accepted; with a fixed wait in the fix it goes to review. S03's web-first fix stated only in a verification step, and a fixed wait in a verification step, both go to review. S07's flakiness named only in a verification step does not meet the `flaky` criterion.

`src/eval/test/score-trace.test.ts` covers scorer v8 with 24 sessions that call `get_trace_summary`, against fake-Playwright snapshots whose `trace.zip` is a real synthetic Playwright trace (`src/mcp/test/scenarios.ts`); every tool result in a transcript is the real tool output for that workspace. Scored against the real S04, S05 and S07 truth files, plus temporary S04 copies that add required trace observations:
- **Accepted:** S04 through MCP (500, path and marker verified), a full read meeting required observations, S05 test-created fulfillment (and its correct "no backend fetch"), a backend 500 fetched and passed through unchanged, a fetched 200 changed to 500 (Test-code defect), S07 with retry 0 `ok` and retry 1 `missing` attributed correctly, the permitted Bash fallback after a denied call, a partial trace that still returned the decisive observation.
- **Not accepted (fail):** a marker or status that contradicts the summary, "test-created" for a pass-through, "no backend fetch" with a recorded backend fetch, "unchanged" for a linked status change, a 500 attributed to retry 1 when only retry 0 was read, a partial trace described as complete, a denied or unsupported trace honestly reported (required evidence missing).
- **Review:** a partial trace without the decisive observation, an absence claim on a partial trace, a status change with no fetch link (ambiguous correlation).
- **Unverified (the CLI's own check, Stage 3.3):** citing the tool without calling it, network claims citing an unsupported trace, an invalid tool result.
`score-scenarios.test.ts` checks that the Stage 2.6 variants (no tool calls) have `trace_consistency` not applicable and no recorded calls, with Bash trace reads counted as `bash`.

A further test scores three S08 variants against the **stored** S08 snapshot when it exists (fingerprint `3e9afc1329e3`), and checks that the MCP tools show the agent only the error-context attachment. The workspace test checks, for every stored snapshot, that a workspace contains exactly the snapshot payload plus `SKILL.md` and `.claude/settings.json`.

### Ground-truth regression corpus (R1)

`src/eval/test/score-regression.test.ts` turns the manual paraphrase checks of the S11, S13 and S14 truth files into permanent offline tests. It runs as part of `npm run test:eval`; alone: `node --test --test-reporter=spec src/eval/test/score-regression.test.ts` (about 8 s, no model, no browser, no Playwright run, nothing written outside a temp directory).

**How it works.** Each case is one scripted session, built like the other scorer-validation fixtures: a fake-Playwright snapshot of the real scenario files, the unchanged `runInvestigation`, and `scoreRun` → `scoreEvaluation` against the **real** truth file (the test checks its hash). The evidence is valid and complete in every case (spec and page snapshot read; S13's trace through the real `get_trace_summary` output for a synthetic trace with the 503), and the analysis points are neutral, so only the text under test (summary, fix, label, confidence, and for some S13 cases one trace point) decides the result. The test reimplements no matching: it reads the scorer's items. Each case declares exactly:
- the classification verdict (and whether it is a High-confidence incorrect one),
- which root-cause criteria go to review (all others must match), and exactly which forbidden claims are flagged, with their status,
- exactly which corrective acceptable fixes match and exactly which supporting ones (v10; listed `(supporting)` next to a corrective match, or a review alone), exactly which matched fixes are not counted and with which verdict (v11: `rejected`, `conflict` or `unresolved`), and exactly which forbidden recommendations are flagged,
- the acceptance status and the exact `pending` and blocking checks.

A typo in a criterion or item id fails the run, because every id must exist in the truth file. The harness also pins `SCORER_VERSION` (to 12 since R3d; recorded under 8 at R1, 9 at R3a, 10 at R3b and 11 at R3c), so a scorer change has to revisit the corpus on purpose. A forbidden item expected as `negated` is a `forbidden_negated` audit item with status `pass` (v9).

**Coverage** (166 cases plus 10 harness tests; R1 had 106 and 4, R3a 122 and 9, R3b 132 and 9, R3c 149 and 9):

| Scenario | A correct diagnoses | B incorrect / reviewable | C acceptable fixes | D forbidden fixes | E negation / clauses / lines | Total | fixed in v9 | fixed in v10 | fixed in v11 | fixed in v12 | remaining limitations |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S11 | 5 | 7 | 5 | 8 | 10 | 35 | 3 | 0 | 0 | 0 | 2 |
| S13 | 7 | 12 | 25 | 11 | 23 | 78 | 5 | 1 | 1 | 4 | 8 |
| S14 | 6 | 7 | 11 | 8 | 21 | 53 | 4 | 0 | 0 | 2 | 3 |

**Added in R3d** (scorer v12, line breaks in forbidden items): S13-E13 the motivating bullet case and S13-E14 a timeout increase in its own bullet (both review); S13-E15 a plain line break that changes the reading (ambiguous, review); S13-E16 a match the S13 lookbehind hid behind a negator before a blank line (now found, review); S13-E17 a wrapped "Do not⏎", S13-E18 code after a negated colon line and S14-E19 a dangling "or" (conservative reviews, limitations); S13-E19 the inline-dash limitation (still accepted); S13-E20 attributed advice in a bullet (review); S13-E21 a match only across `proposedFix` and a step (review); S13-E22 a step only its line breaks push over the clause limit and S13-E23 one over it in both readings (one `forbidden-analysis` each); S14-E17 negated `force` and positive `retries` bullets; S14-E18 all bullets negated (accepted); S14-E20 a `timing` claim in a bullet (`root_cause` review); S14-E21 the merge guard (reported advice stays review); S11-E10 a negated force line before a list item (accepted). A harness test pins the exact details of the key cases. `score.test.ts` ("forbidden items with line breaks (scorer v12)") checks byte-identical v11 details without line breaks or when the readings agree, independent occurrences of one pattern, serialization and aggregation, and monotonicity over all 14 truths (every review trigger of the v11 reading, claims and recommendations, is a v12 review; a `forbidden_negated` audit item doesn't count). That test fails if the merge is replaced by the lined reading alone.

**Added in R3c** (scorer v11, acceptable-fix polarity): S13-C13 positive corrective plus negated supporting (accepted, `check-status` rejected); S13-C14 negated corrective alone (rejected, review); S13-C15 a direct retraction (conflict, review); S13-C16 a conflicting `fix-server` next to an endorsed `keep-test` (accepted); S13-C17 a rejected and an endorsed phrase of one criterion (unresolved, review); S13-C18 direct first-person advice (accepted); S13-C19 advice reported from someone else (unresolved, review); S13-C20 earlier advice called wrong (rejected, review); S13-C21 a conditional fix (accepted); S13-C22 bullet items (accepted); S13-C23 a fix followed by a fenced code block (accepted); S13-C24 and S13-C25 the line-break limitations; S14-C8 rejected `use-locator` with endorsed `reacquire` (accepted); S14-C9 retracted `use-locator` with endorsed `reacquire` (accepted); S14-C10 negated `reacquire` alone (review); S14-C11 a fix followed by multi-line code (accepted). S14-E13–E15 now also expect `use-locator` unresolved (its own analysis is truncated); their acceptance and pending checks are unchanged. The harness parses the `; not counted:` list and checks it exactly. `score.test.ts` ("acceptable-fix polarity on the real truths (scorer v11)") covers the other scenarios: S04/S07 `keep-test` (its own negation stays positive; a negated "test is correct" is rejected), S05 alternatives, S08 `collect-evidence`, S09 `rerun` per verification step (a negated step is rejected, a negation never reaches the next step, a negated and a positive step are unresolved), S11/S12 multi-line and code, S10 not applicable, a truncated analysis, bounded details, and monotonicity (every counted fix matched v10's regex).

**Added in R3b** (recommendation sufficiency, S13 truth with `check-status` supporting): S13-C6 corrective only (accepted); S13-C7 supporting only (review, pending `recommendation`); S13-C8 corrective plus supporting (accepted, both recorded); S13-C9 no fix (review); S13-C10 supporting advice only in `verificationSteps` (not matched there, review) and S13-C11 a corrective fix only in `verificationSteps` next to a supporting `proposedFix` (not met there, v7; review); S13-D10 supporting plus `more-time` (review, both reasons recorded); S13-D11 corrective plus `retries` (review despite the corrective match); S13-B12 the reviewable Environment alternative with a supporting-only fix (pending both `classification` and `recommendation`, judged separately); S13-C12 the named acceptable-fix negation limitation. S13-C1 now expects `check-status (supporting)`.

**Added in R3a** (scorer-level integration of v9, through the real scorer): S11-E6 and S14-E10 negated code expressions (`{ force: true }`, `dispatchEvent('click')`, `page.waitForTimeout(500)`, `setTimeout(() => {}, 500)`); S11-E7, S14-E7 a positive and a negated recommendation in one field; S14-E8 a positive and a negated match of the same claim; S14-E9 and S13-E12 ambiguous (a hedge, reported advice); S14-E11 a positive code expression after `then`; S14-E12 truncated candidates and S14-E13–E16 truncated clauses (one `forbidden-analysis` review per affected check although every match seen is negated, with no match at all, next to a positive match, and in the summary); S11-E8 a forbidden fix split across two verification steps (review; accepted without the cross-field check) and S11-E9 a negated match the joined text only extends (stays negated, accepted); S13-E11 the named S13 guard limitation. Harness tests check that every `forbidden_negated` item passes, never decides its check and stays bounded, that a truncation is one bounded `forbidden-analysis` item per check with exact wording, that the two cross-field cases really match only across the joined fields, and that `report` counts only review findings (`forbiddenHits`) and the same acceptance totals as the records.

**What it protects.** Equivalent wordings of each mechanism (e.g. S11 "present but hidden … never hovers", "matched the anchor … not visible … mouseover"; S14 "stale handle … re-rendered", "captured element … disconnected … rebuilt"; S13 "download URL responded 503 … navigated … waitForEvent hit the test timeout"). Explicit rejections of competing diagnoses ("not a timing issue and not an application defect"). Wrong root causes going to review and wrong labels being blocked: S11 missing link or broken hover effect, S14 race or disabled checkbox, S13 slow download, a test-made mock, disabled downloads, or a late listener. An abstention is blocked as `abstained`. Unsupported claims next to correct criteria (S13 `marker-proof` and `specific-cause`, S11/S14 "broken" or "application bug") keep a diagnosis in review even when every criterion matches. S13's Environment alternative is `reviewable_alternative` (pending review, at Medium or High) only with the 503 and a stated uncertainty, and `incorrect` without it. Every forbidden fix is checked, and a valid fix never hides one. A diagnostic alone isn't counted as the fix for S11 or S14, nor (since v10) S13's fail-fast status check. S13's negation guards hold for the examples in its truth design ("Do not increase the timeout." is not flagged; "Do not increase the timeout; change the locator instead." still flags `change-locator`; "503, not a mocked response" in a trace claim is honored by `trace_consistency`).

**Fixed in scorer v9 (R3a).** These 12 cases were known limitations under v8. They keep their ids; the test name says `FIXED IN v9` and records the v8 behavior (`fixedIn.before`).

| Case | v8 (pinned until R3a) | v9 |
|---|---|---|
| S11-E3, S14-E3 "Do not increase the timeout; …" | `more-time` flagged (review), pending | negated (`negator_before`), accepted |
| S11-E5 "Do not use force: true or dispatchEvent" | `force` and `dispatch` flagged, pending | both negated, accepted |
| S14-E6 "No sleep is needed" | `sleep` flagged, pending | negated, accepted |
| S11-E4 "not a race condition" | `timing` flagged, pending | negated, accepted |
| S14-E4 "no race or timing problem"; S13-E6 "neither … nor a race condition" | `timing` flagged, pending | negated, accepted |
| S14-E5 "A race condition is not the cause"; S13-E8 "A longer timeout is not the answer"; S13-E9 "acceptDownloads is not the issue" | flagged, pending | negated (`negated_predicate_after`), accepted |
| S13-E7 "Do not mock the endpoint or add a sleep" | `sleep` flagged, pending | negated, accepted |
| **S13-E10** "Fix the report endpoint. Do not change anything else and increase the timeout." | **accepted** (no `more-time`): a false negative, the lookbehind saw "not" in the earlier clause | `more-time` flagged (matched from the clause start after `and`, positive), pending review |

**Fixed in scorer v10 (R3b).** The test name says `FIXED IN v10`.

| Case | v9 with the original S13 truth (pinned until R3b) | v10 with the R3b S13 truth |
|---|---|---|
| **S13-C5** "Add waitForResponse and expect response.ok() before waiting for the download." | **accepted** (`check-status`): no required-vs-optional distinction | `check-status` supporting only, pending review (`recommendation`) |

**Fixed in scorer v11 (R3c).** The test name says `FIXED IN v11`.

| Case | v10 (pinned until R3c) | v11 |
|---|---|---|
| **S13-C12** "Do not fix the server; add waitForResponse." | **accepted**: `fix-server` matched inside the negated clause, `check-status` listed as supporting | `fix-server` rejected (not counted), only the supporting `check-status` counts: pending review (`recommendation`) |

**Fixed in scorer v12 (R3d).** New cases that record their v11 behavior; the test name says `FIXED IN v12`.

| Case | v11 | v12 |
|---|---|---|
| **S13-E13** "Restore the report endpoint.⏎- Don't mock it⏎- add retries: 2"; **S13-E14** the same with "increase the timeout to 60 seconds" | **accepted**: negated by the previous bullet's "Don't" | `retries` / `more-time` review, pending |
| **S13-E15** "…⏎⏎Don't add retries⏎- increase the timeout." | **accepted** | ambiguous (`line_break_scope`), pending |
| **S13-E16** "… Don't touch the spec⏎⏎increase the timeout." | **accepted**: the S13 lookbehind saw "n't" across the blank line, no match | `more-time` review, pending |
| **S14-E17** "Use a locator.⏎- Don't use force: true⏎- add retries: 2" | **accepted** | `retries` review (`force` stays negated), pending |
| **S14-E20** summary "…⏎- It is not flaky⏎- a race condition in the reset" | **accepted** | `timing` review, pending (`root_cause`) |

**Known limitations (characterization cases).** These pin the **current** (v12) behavior. The test name says `KNOWN LIMITATION` and states the desired behavior. They aren't endorsements: fixing one means updating the case and this table, not working around it.

| Case | Current (v12) | Desired |
|---|---|---|
| S13-E17 "Do not⏎increase the timeout." | `more-time` review (found from the break; the two readings differ) | one negated instruction: accepted |
| S13-E18 code after "Do not mock it like this:" | `mock-it` review (ambiguous) | the negated example it introduces: accepted |
| S14-E19 "Never use force: true or⏎waitForTimeout." | `sleep` review (ambiguous) | the negation distributes over the wrapped "or": accepted |
| **S13-E19** "Don't mock it - add retries: 2" (no line break) | **accepted** (`retries` negated) | `retries` flagged: pending review |
| **S13-E11** "Fix the report endpoint. Do not forget to increase the timeout." | **accepted** (no `more-time`): the S13 lookbehind sees "not" in the same clause, so there is no match to judge | `more-time` flagged; needs a truth guard change |
| S13-C24 "Investigate the⏎backend." | `fix-server` unresolved (the match crosses a line break of unknown role): review | one wrapped instruction: accepted |
| S13-C25 "Don't add a sleep⏎Restore the report endpoint." | `fix-server` unresolved (the line may continue the negation): review | separate lines read as separate instructions: accepted |
| S13-D9 a mock "returning the CSV" | `fix-server` matches as well as `mock-it` | `fix-server` does not match (acceptance is unaffected: the mock still sends it to review) |
| S13-A7 "the test times out waiting for it" | `timeout` criterion missed (review) | matched (`timed? ?out` misses "times out") |
| S11-C5 "Move the mouse over Ana's picture before …"; S14-C7 "Look the checkbox up by role at the moment you check it" | no acceptable fix (review) | `hover-first`; `reacquire` |
| S11-D8 "Remove the toBeVisible assertion"; S14-D8 "Remove the Reset preferences click" | not flagged as forbidden; review only because no acceptable fix matched | a forbidden item for dropping correct test steps |

Also by design, not a limitation: none of the three truths has a `severity: "fail"` item, so with the right label a wrong root cause never fails automatically. It goes to review (`pending_review`). Only a wrong classification (and a High-confidence one in the `confidence` check) blocks acceptance on its own. S13-C4 ("the test is correct and needs no change" as the whole fix) is accepted because the truth lists `keep-test` as an acceptable fix; R3b keeps it corrective and records it as a remaining recommendation-sufficiency limitation ("Scorer version 10").

**What it doesn't cover.** Other scenarios (v9 applies to every scenario's review-severity items; the corpus exercises it only through S11, S13 and S14). Sessions with missing or invalid evidence (covered by `score-scenarios.test.ts` and `score-trace.test.ts`). Hedged-sentence handling for `severity: "fail"` items (none in these three truths). Any claim of accuracy: these are scorer-validation fixtures, not agent measurements.

## Adding a scenario

1. Create `scenarios/S<nn>/` containing `generation.json`, `truth.json` (with a fresh canary: `node -e "console.log('TDCANARY-'+crypto.randomUUID())"`) and `tests/ui/<neutral-name>.spec.ts`.
2. Keep the spec natural: a neutral file name and title, no comments, nothing that names the fault. The same applies to an optional `post-run/` spec (the workspace shows it). A `control/` spec keeps the test title.
3. Run `npm run typecheck` and `npm run test:eval`.
4. Generate the snapshot, check its artifacts by hand, and run the control if there is one. Mark a `requiredEvidence` entry `provisional: false` only after the artifacts confirm it.
