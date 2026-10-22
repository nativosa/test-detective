# Evaluation dataset (Stages 2.5–2.6)

Controlled Playwright failures with ground truth, used to measure how accurately, reliably and cheaply test-detective diagnoses failures. This stage evaluates the existing investigation (the `investigate-failure` Skill run by the Agent SDK CLI) as the baseline. It adds no investigation features.

**Status: 2.6.1.** Stage 2.5 built the schemas, the fixture app, three pilot scenarios (S02, S04, S05), snapshot generation and storage, investigation workspaces with isolation checks, offline scoring and reporting, the live adapter, and a one-run-per-scenario pilot benchmark. Stage 2.6.1 adds seven scenarios (S01, S03, S06–S10) aimed at timing, environment, flaky, inconclusive, source-mismatch and no-failure cases, plus the fixture modes, generation options, observation checks and control runs they need. Their snapshots are generated offline; none has been run live yet. Stage 2.6.2 added scorer version 6 for them (see "Scorer version 6" below). Four of them (S08, S07, S03, S09) were then run live once each; scorer version 7 followed from what those runs exposed (see "Scorer version 7").

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

The pilot scenarios are S02, S04 and S05; Stage 2.6 added S01, S03 and S06–S10. The expected answers are only in each scenario's `truth.json` (and, as corrected tests, in `control/`). Don't repeat them in docs, specs, comments, file names or test titles.

## Generation data vs ground truth

The two files are deliberately separated, at both the module and the schema level:

- **`generation.json`** (`GenerationConfig`): the spec path, the fixture-app mode, Playwright retries and timeout, and `expectObservation`, which is what the generated run must show before its snapshot is accepted. It contains no classification, root cause, evidence or recommendations. Optional fields added in Stage 2.6 (leaving one out reproduces the pilot behavior exactly, so the pilot files and their hashes are unchanged, which a test pins):

  | Field | Effect |
  |---|---|
  | `app.profileDelayMs` | delay before a successful `/api/profile` response |
  | `app.server: "down"` | `BASE_URL` points at a released local port, so connections are refused |
  | `playwright.trace`, `playwright.screenshot` | `"off"` turns the artifact off in the stage config |
  | `postRun.replaceSpec` | after Playwright exits, the stage spec is overwritten with `post-run/<spec>` |
  | `expectObservation.absentAttachments` | attachments no attempt may list, and whose files must not exist |
  | `expectObservation.errorContextPattern` | must match each failed attempt's `error-context.md` (what the page showed) |
  | `expectObservation.maxFailedAttemptMs` | upper bound on each failed attempt's duration (fails at once, not by timeout) |
  | `expectObservation.sourceTiming` | `before-run` (default) or `after-run`; goes together with `postRun` |
- **`truth.json`** (`GroundTruth`): `canary`, `description` (the known root cause), `failureType`, `expected` (report status, tests, classification, acceptable alternatives with a confidence cap, source-mismatch flag, acceptable confidence levels), `rootCause` (summary, criteria, forbidden claims), `requiredEvidence`, and `recommendations` (acceptable and forbidden). Optional since Stage 2.6.2 (absent means the Stage 2.5 meaning): `expected.tests[].reportedOutcome` (`unexpected` by default, `flaky` for S07), `expected.reviewableAlternatives` (classifications a person must judge, each with a `requires` criterion its reasoning must match), `expected.unavailableEvidence` (kinds the run did not keep), and `severity: "fail"` on a forbidden claim. The outcome field is `reportedOutcome`, not `outcome`, because `generation.json` already has an `outcome` key and the two files share no keys.

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

The Skill's existing trace command (`grep -oE '"url":"[^"]*"|"_wasFulfilled":true'`) shows the difference as-is: `"_wasFulfilled":true` follows the `/api/profile` URL only in S05. S04 has no `_wasFulfilled: false`; the field is simply absent, so "not mocked" is inferred from absence and from the spec having no `page.route`. The `requiredEvidence` trace entries for S04 and S05 are now confirmed (`provisional: false`). In S04/S05 the error-context YAML has no `# Page snapshot` heading, unlike S02's.

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

Controls are answers, so they are evaluation-side data: the generator never reads `control/` (`separation.test.ts`), the stage that becomes a snapshot never contains it, and no snapshot or workspace ever does. S01, S03 and S09 have controls (a dataset test requires them).

## Fixture app

`node evals/app/server.ts [--profile-api ok|error|fail-first|hang] [--profile-delay-ms n] [--port n]` starts it manually. The generator starts it in-process and passes the fault mode itself, so the mode never appears in a spec or in anything copied to an investigation workspace. `fail-first` counts per started server, so each generated run starts at the first request. `hang` never answers `/api/profile`; closing the server drops the connection.

## Scoring is heuristic

The `rootCause.criteria` and `recommendations` patterns are case-insensitive regular expressions. They are transparent signals, not a judge:
- A missing or partial match means **needs manual review**, not automatically wrong. Correct answers can be phrased in ways a pattern misses.
- `forbidden*` patterns also match negations ("not a backend bug"), so a hit flags the answer for review rather than failing it.
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

- **Mitigation (reduces exposure):** the workspace sits outside the repo and holds only allowlisted files. Read deny rules cover the repo and `~/.claude`; Claude Code applies Read rules to Read, Grep and Glob. A Git-ignored directory is no less reachable than any other.
- **Not covered:** the allowed Bash commands (`grep`, `head`, `ls`, `unzip`) accept absolute paths, and Bash deny rules can't reliably match paths inside arguments. The deny-rule path syntax on Windows (`//c/...`) also hasn't been verified against a live session yet; the probe is deferred.
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
- `preflight`: captured before the session: `truthSha256`, `skillSha256`, `settingsSha256`, `sdkVersion`, `nodeVersion`, `capturedAt`, and the sanitized `session` options.
- `repo.unchanged`: the repo state was the same before and after (`null` = not checked).
- `cleanup`: `removed`, the final `error` (or `null`), and, for runs saved since bounded cleanup, `attempts`, `elapsedMs` and `transient` (the errors of retried attempts). A cleanup failure is infrastructure: `score.json` copies it into `cleanup` (`removed`, `removed_after_retry`, `failed`, `no_workspace`, `unknown`), the report lists it under "Infrastructure", and it never changes the category or acceptance.
- `configDifferences`: `describeDifferences()` output.

A finished session must record `snapshot`, `workspace` and `configDifferences`.

### Ground truth versions

Every `score.json` records `inputs.truthSha256`, the hash of the `truth.json` bytes it was scored against, along with the result, transcript and snapshot identities and `scorerVersion`. `score` compares each fresh score with the stored one. If any would change (truth edited, scorer version bumped, saved inputs changed), it **writes nothing** and lists the evaluations and reasons, including what the change does to the category and the audit verdict. `--rescore` replaces them deliberately: each old file is first archived to `<evalId>/score-history/score.v<scorer>.truth-<sha12>.<sha8>.json` (never overwritten). Reviews refer to the score they judged by hash, so after a rescore they are kept unchanged in `review.json` and reported as stale. The summary lists the truth hashes used per scenario and warns when a run mixes versions.

The truth hash is also **captured before the session** (`outcome.preflight.truthSha256`). Scoring requires the current truth to match it. Otherwise the run is invalid setup, because it would be judged against answers that differ from the ones fixed when it ran. A finished session without a captured hash is invalid setup too.

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
| `root_cause` | Searched in `failureSummary`, the analysis points and the confidence justification; a verification-only criterion (v7, see below) also in `verificationSteps`. Every criterion matched passes; a missing criterion means review. A forbidden claim means review, except one with `severity: "fail"` stated in a plain sentence, which fails (`forbidden_definitive`); in a hedged or negated sentence (may, might, cannot, unclear, whether, no evidence, …) it goes to review. |
| `evidence_validity` | Every evidence claim, graded by provenance (table above). `skipped` is not verified. |
| `evidence_sufficiency` | Each `requiredEvidence` item: verified **and** reported passes; verified but not reported, or unresolved provenance, means review; reported but unsupported or confirmed false fails; neither inspected nor reported fails (`not_inspected`, or `access_denied` when every read was denied). Each `unavailableEvidence` kind: reported `not_available` passes; claimed `inspected` fails; `skipped`, or absent from the list but named as unavailable in the reasoning, means review; not acknowledged at all fails (`unacknowledged`). |
| `citations` | Each `evidenceRefs` entry: a verified file or obtained MCP result passes; unresolved provenance, free text, or a file whose every read was denied (`access_denied`: the point may only report the failed access) means review; an unsupported file, a nonexistent path, a path outside the workspace or an MCP result never obtained fails. Bare file names resolve to a unique snapshot path. |
| `confidence` | `exact` with the level outside `expected.confidence`: review (`confidence_outside_range`), not fail. `acceptable_alternative`: within its cap. `reviewable_alternative`: not applicable (judged in the classification review). `incorrect` at High: fail (`high_confidence_incorrect`). Otherwise recorded for calibration only. |
| `source_mismatch` | Equals `expected.sourceMismatch`. |
| `recommendation` | An acceptable pattern in `proposedFix` (a verification-only one also in `verificationSteps`) and no forbidden pattern in `proposedFix` or `verificationSteps` passes; anything else means review. |
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

## Reports (`report.ts`)

`summary.json` (schema `Summary`) and `summary.md` keep two diagnostic metrics apart and never merge them into one number:
- **Classification agreement:** verdict counts over *eligible investigations* (one per expected test in an eligible run), `exact k/n`, with how many are still pending review.
- **Fully accepted diagnosis rate:** accepted / eligible runs, plus pending-review and not-accepted counts. It requires an exact classification, passing root cause, evidence, citations and recommendation, and every required review resolved.

Always visible alongside them: a by-failure-type table (evaluations, eligible, investigations, exact, reviewable alternatives, fully accepted), each test's observed outcome (`unexpected`, `flaky`) next to its verdict, attempted evaluations, every excluded category with its count, eligible runs with pending reviews, high-confidence incorrect diagnoses (listed), a confusion matrix and confidence-vs-verdict calibration over eligible investigations, per-check status counts, evidence and citation provenance counts, root-cause and recommendation results, usage totals and maxima over all attempts, per-scenario-and-test agreement across attempts, the truth hashes used, the investigator Skill per evaluation (`skillVersions`, from `outcome.json` `preflight.skillSha256`; more than one is flagged, because results from different Skills are not like-for-like), and per-evaluation details, including each review's reviewer and date. Per evaluation, a provenance and usage table lists the run, scorer version, truth hash, Skill hash, snapshot fingerprint, duration, wall clock, turns, input/output tokens, tool calls, SDK-estimated cost, audit counts (violations / suspicious / dismissed) and workspace cleanup. Different scorer versions in one summary are flagged. If the run is scorer validation, a notice at the top says the numbers test the scorer and are not agent-performance measurements. A live summary always states its sample instead (scenarios and attempts per scenario) and that it does not establish statistical reliability: the report computes counts only, never rates, intervals or variance.

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
- Only `coverage`, `root_cause`, `evidence_validity`, `evidence_sufficiency`, `citations` and `recommendation` can be reviewed, to `pass`, `partial` or `fail`, plus `classification` for a run with a `reviewable_alternative` verdict: `pass` accepts the alternative as defensible, anything else blocks acceptance. A `classification` review of any other verdict is rejected and reported. Exact checks can't be reviewed, and no review changes a verdict.
- `audit.verdict` resolves suspicious findings (`clean`) or confirms them (`violation`). A confirmed violation can't be cleared.
- Check overrides on runs that aren't eligible (unverified, invalid, …) are rejected and reported.
- After review, a `needs_review` run becomes `scored` once no `review` check and no open suspicious finding remains, and its acceptance is recomputed from the reviewed statuses.
- `scoreSha256` ties a review to the exact score it judged. If `score.json` changes (only possible with `--rescore`), the review is reported as **stale** and not applied, and the reviewed score stays in `score-history/`.

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

A further test scores three S08 variants against the **stored** S08 snapshot when it exists (fingerprint `3e9afc1329e3`), and checks that the MCP tools show the agent only the error-context attachment. The workspace test checks, for every stored snapshot, that a workspace contains exactly the snapshot payload plus `SKILL.md` and `.claude/settings.json`.

## Adding a scenario

1. Create `scenarios/S<nn>/` containing `generation.json`, `truth.json` (with a fresh canary: `node -e "console.log('TDCANARY-'+crypto.randomUUID())"`) and `tests/ui/<neutral-name>.spec.ts`.
2. Keep the spec natural: a neutral file name and title, no comments, nothing that names the fault. The same applies to an optional `post-run/` spec (the workspace shows it). A `control/` spec keeps the test title.
3. Run `npm run typecheck` and `npm run test:eval`.
4. Generate the snapshot, check its artifacts by hand, and run the control if there is one. Mark a `requiredEvidence` entry `provisional: false` only after the artifacts confirm it.
