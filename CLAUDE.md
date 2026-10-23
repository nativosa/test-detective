# CLAUDE.md

Conventions for working on test-detective, for both human contributors and Claude Code.

## Project goal

An AI-assisted tool that investigates failed Playwright tests. A parallel goal is learning Claude Code features (Skills, Subagents, Hooks, MCP, Agent SDK) by using them deliberately. Favor explaining and teaching over silently delegating.

## Current stage: Stage 3.3 — trace evidence in investigations (awaiting review)

Stage 3.2 added the read-only `get_trace_summary` MCP tool (yauzl 3.4.0, pinned), designed from the 3.2 trace-format spike. Stage 3.3 enabled it for investigations (the Agent SDK CLI, `.mcp.json`, the Skill and the Subagent) and rewrote the Skill's trace reasoning around its structured fields. The scorer is unchanged (v7) and no live run has used the Stage 3.3 Skill. The Stage 2.6 state below is otherwise unchanged.

### Stage 2.6 — expanding evaluation coverage

Stage 2.5 (agent evaluation framework and three-scenario pilot benchmark) is complete. Stage 2.6.1 added seven scenarios (S01, S03, S06–S10), their fixture modes, generation options, observation checks, control runs and offline snapshots. Stage 2.6.2 added scorer version 6 (flaky outcome, unavailable evidence, reviewable alternatives, definitive claims, no-failure reports) and its golden tests; the pilot results are unchanged under v6. S08, S07, S03 and S09 then ran live once each (S07 not accepted; the others accepted, S08 and S09 after manual review). The Skill's trace step was made permission-safe after S07, so S03 and S09 ran with a different Skill. Scorer version 7 (verification steps, denied access) is implemented and checked on copies; the saved runs are still at v5/v6. Any further live run, or a rescore of saved runs, needs explicit approval.

In scope: the Playwright suite, its config and reporting, the `investigate-failure` Skill, the `failure-investigator` Subagent, the read-only MCP server in `src/mcp/`, the read-only Agent SDK CLI in `src/agent/`, the evaluation dataset in `evals/` and `src/eval/`, and docs.

**Do not build yet:** auto-fixing or applying changes, running tests from an agent, Hooks, a dashboard, an HTTP API or HTTP MCP transport, multiple agents or parallel investigation, CI/cloud infrastructure. Propose these, but don't implement them without explicit approval.

## Commands

```sh
npm run typecheck     # tsc --noEmit
npm test              # full Playwright suite (needs network)
npm run test:mcp      # MCP server unit + protocol tests (node:test, offline)
npm run mcp           # start the MCP server on stdio
npm run test:agent    # Agent SDK CLI tests (node:test, offline, no model requests)
npm run investigate   # live investigation via the Agent SDK (uses the Claude account; ask first)
npm run test:eval     # evaluation dataset, generator, snapshot, isolation, scoring and report tests (node:test, offline)
npm run eval -- generate --scenario <id>  # Playwright snapshot of one scenario (local app, no model); never overwrites
npm run eval -- control --scenario <id>   # the scenario's corrected spec against the same fixture; must pass (no model; stores nothing)
npm run eval -- score --run <dir>         # score a saved run offline (no model, no Playwright); refuses to change stored scores without --rescore
npm run eval -- report --run <dir>        # summary.json + summary.md from the score files (and review.json)
npm run eval -- report --run <a> --run <b> --out <dir>  # one combined summary over several runs; source runs are only read
npm run eval -- live --scenario <id> --max-budget-usd <n>  # ONE live session (real model requests; ask first)
npm run test:repeat   # initial stability check (--repeat-each=5)
npm run report        # open HTML report
npx playwright test --list --reporter=list  # discovery check; see the note below
```

**Artifact safety:** plain `npx playwright test --list` still runs the configured reporters, so the JSON reporter overwrites `artifacts/results.json` with an all-skipped listing. That destroys the last real report, which the MCP server and the Skill read. For discovery checks, always pass `--reporter=list`: it replaces the configured reporters and writes no files (verified with Playwright 1.64.1). Any Playwright run outside `npm test` must also pin `outputDir`/`--output`, because the default output directory is the repo-root `test-results/`, which Playwright empties at the start of every run.

Before declaring a change done, run `npm run typecheck` plus the relevant tests (`npm test` for the UI suite, `npm run test:mcp` for `src/mcp/`, `npm run test:agent` for `src/agent/`, `npm run test:eval` for `src/eval/` and `evals/`) and report the results honestly. Never run `npm run investigate` without the user's approval: it makes real model requests on their account.

## Test conventions

- One feature area per spec file in `tests/ui/`, named `<feature>.spec.ts`.
- Locator priority: `getByRole` > `getByLabel` > `getByText` > CSS ids. Leave a comment when you fall back to CSS or positional locators.
- Web-first assertions only (`await expect(locator)...`). Never use `waitForTimeout` or sleeps.
- Tests are independent and parallel-safe: no shared state, no ordering assumptions.
- Use relative URLs (`page.goto('/login')`). `baseURL` lives in `playwright.config.ts`.
- No Page Objects or helpers until real duplication justifies them.
- Keep dependencies minimal. Ask before adding one.

## Artifact contract

The Skill, the Subagent and the MCP server (`src/mcp/report.ts`) depend on these paths. Don't change them without updating this file and the README.

| Path | Contents |
|---|---|
| `artifacts/results.json` | JSON reporter output: stats, per-test status, error message/stack, attachment paths |
| `test-results/<test-id>/trace.zip` | Playwright trace (failures only, `retain-on-failure`) |
| `test-results/<test-id>/test-failed-1.png` | Screenshot (failures only) |
| `test-results/<test-id>/error-context.md` | Page snapshot at failure |
| `playwright-report/` | HTML report |

Local runs use no retries, so flaky failures surface instead of being hidden. CI uses 1 retry.

## Claude Code Skills

| Skill | Invocation | Purpose |
|---|---|---|
| `investigate-failure` | `/investigate-failure [test title or spec]` | Read-only root-cause report for failed tests, built from the MCP tools and the artifact contract above |

Skills live in `.claude/skills/<name>/SKILL.md`. `investigate-failure` must stay read-only: it never edits files, reruns tests, or contacts external services. If you change the artifact contract, update the Skill too.

The Skill reads traces through `get_trace_summary` first. Its Bash trace commands are a restricted fallback (tool unavailable, denied or failed, or `unsupported`) and must stay plain pipelines of the CLI's allowlisted Bash commands (`unzip`, `grep`, `head`), each run as its own call, with one retry after a denial. `src/agent/test/skill.test.ts` checks this against `ALLOWED_TOOLS`. If you change either the commands or the allowlist, keep the two in sync and record the new Skill hash in `evals/README.md` ("Skill versions").

When classifying, the Skill never decides from an HTTP status or route marker alone. `"_wasFulfilled":true` / `marker: "fulfilled"` only says a route handler answered: the response may come from `route.fetch()`, passed on unchanged or modified. A missing marker doesn't prove a live backend. The Skill weighs the spec's route handler with the trace summary's identifier-based fetch links (`fetchedStatus`, `statusChanged`), request correlation, timing and coverage; a test that fulfills its own error and then expects success is a test-code defect, a linked fetch whose error status the handler passed on unchanged points to the backend, and anything ambiguous lowers confidence or stays Inconclusive. It labels analysis points as observed, inference or uncertain. Keep these rules if you edit its classification step.

## Claude Code Subagents

| Subagent | Invocation | Purpose |
|---|---|---|
| `failure-investigator` | "Use the failure-investigator subagent to investigate <test or spec>", or `@agent-failure-investigator` | Runs the `investigate-failure` Skill in a separate context and returns only its report |

Subagents live in `.claude/agents/<name>.md`. Run the Skill directly when you want a quick inline look. Delegate to the subagent when you want to keep raw artifacts out of the main context.

`failure-investigator` preloads the Skill through `skills:`. Don't copy the Skill's procedure into the agent file; edit the Skill instead. The agent is meant to stay read-only. Its tool allowlist (`Read, Grep, Glob, Bash` plus the three read-only test-detective MCP tools) and `permissionMode: dontAsk` reduce risk, but they aren't a hard security boundary. Bash can still write files, and if the parent session is in `acceptEdits`, `auto` or `bypassPermissions`, the parent's mode overrides `dontAsk`. Delegate from Default (manual approval) mode.

## MCP server

| Tool | Input | Purpose |
|---|---|---|
| `list_test_failures` | none | Run info, stats, global errors, failed/flaky tests with `testId`s |
| `get_failure_details` | `testId` | Per-attempt errors, locations, snippets, attachment metadata for one test |
| `get_trace_summary` (server opt-in: `--enable-trace-summary`) | `testId`, `retry` | Bounded, sanitized trace facts for one attempt (requests, backend fetches, route calls and links, redirects, failure timing, console counts, page-error names, coverage) |

Registered in `.mcp.json` as `test-detective` (stdio, `node src/mcp/main.ts --enable-trace-summary`). The README explains the lifecycle, the ID format and the path rules.

- **Layers.** `report.ts` and `paths.ts` hold all Playwright report parsing and have no MCP imports. `trace-summary.ts` (attempt and file resolution, cache), `trace.ts` (pure record interpretation, output schema) and `zip.ts` (the bounded yauzl wrapper) implement `get_trace_summary`; none imports MCP code, and `report.ts` never imports them (the scorer imports `report.ts`; `separation.test.ts` checks its graph). `server.ts` only registers tools and maps results and `ReportError`s to tool results. `main.ts` only wires stdio.
- **Read-only.** The tools only read `artifacts/results.json` (fixed path) and `stat`/`realpath` attachment paths inside the repo. Never accept file paths from clients, never run tests, write files or use the network. The one exception to "never read attachment contents": `get_trace_summary` reads the trace attachment of the requested attempt, only its whitelisted event entries (`test.trace`, `<n>-trace.trace`, `<n>-trace.network`), streamed and never extracted, and returns only allowlisted, sanitized fields (trace events only, never raw contents). Never return headers, cookies, bodies, query strings, message texts, stacks, absolute paths, `test.trace` parameter values or user step titles; when a safe representation is uncertain, omit the field and report the limitation.
- **`get_trace_summary` is registered only on request.** `createServer` registers it only with `enableTraceSummary`, and `main.ts` sets that only for `--enable-trace-summary`. Since Stage 3.3 the investigation launchers pass it: `.mcp.json`, `src/agent/config.ts` (`TRACE_SUMMARY_FLAG`) and, through `adaptOptions`, the eval workspace. A server started any other way (`npm run mcp`, an inspector without the flag) has only the two original tools. `src/agent/test/trace-tool.test.ts` pins both, and that `ALLOWED_TOOLS`, `.claude/settings.json`, the Subagent's `tools:` and the Skill's `allowed-tools` name exactly the same three MCP tools.
- **Trace semantics.** The tool reports observations. `_wasFulfilled` (`marker: "fulfilled"`) does not mean the test created the response (`route.fetch()` responses are fulfilled too); a missing marker or server address does not prove a live backend. Fetch-to-fulfill links only come from matching identifiers (`fetchResponseUid` = `fetchUid`); time-window correlations that aren't unique stay `ambiguous`. With `partial` status, unlisted evidence is unknown, never absent. Only trace format 10 is supported; anything else is `unsupported`. Keep the ZIP checks, budgets (`DEFAULT_TRACE_LIMITS`) and output caps (`OUTPUT_LIMITS`) covered by `zip.test.ts` and `trace.test.ts` if you change them.
- **stdout is protocol only.** Log with `console.error`. The stdio test fails on any non-JSON-RPC stdout line.
- **No diagnosis.** Tools report facts from the report. Root-cause analysis belongs to the Skill (and the agents that run it).
- **IDs** are `<spec.id>@<report fingerprint>`. An ID from an older report returns `REPORT_CHANGED`. Keep that check if you change the ID format.
- **TypeScript runs through Node 24's native type stripping** (no flags). Use erasable syntax only (no `enum`, no parameter properties), `import type` for types, and `.ts` extensions in relative imports. `tsconfig.json` enforces this.
- **Tests** live in `src/mcp/test/` (`*.test.ts`, node:test) with synthetic fixtures in `src/mcp/test/fixtures/` and synthetic trace archives built in memory (`traces.ts`, `zipwriter.ts`). Never put `*.test.ts` under `tests/`, because Playwright's `testDir` would pick them up. Tests must not depend on the live demo site or on the gitignored evaluation snapshots (`trace-snapshots.test.ts` only supplements and skips without them).
- **Consumers.** The `investigate-failure` Skill gets failure data only from `list_test_failures` and `get_failure_details` (never by parsing `results.json`), trace facts from `get_trace_summary` (with restricted Bash commands as fallback), and reads source, screenshots and error-context directly. If the server is unavailable it reports that and stops; there is no JSON fallback. `failure-investigator` lists the three tools by exact name (`mcp__test-detective__list_test_failures`, `mcp__test-detective__get_failure_details`, `mcp__test-detective__get_trace_summary`) in `tools:`, because an explicit allowlist does not inherit MCP tools. Listing a tool there makes it available but doesn't approve it, and the Skill's `allowed-tools` doesn't carry into a preloaded `dontAsk` subagent (verified: the call was denied). The project `.claude/settings.json` therefore allows exactly these three tools. The Agent SDK CLI (`src/agent/config.ts`, `MCP_TOOLS`) uses the same three tool names and parses their output with the schemas exported from `report.ts` and `trace-summary.ts`. If you rename the server key in `.mcp.json` or a tool in `server.ts`, update the agent, the Skill, `.claude/settings.json` and `src/agent/config.ts`. If you change an output schema, run `npm run test:agent` too.

## Agent SDK CLI

`npm run investigate [-- --test <filter>]` runs one `@anthropic-ai/claude-agent-sdk` session (version pinned exactly; SDK `0.3.N` bundles Claude Code `2.1.N`). It invokes the `investigate-failure` Skill and uses the `test-detective` MCP server. The README covers usage, auth and exit codes.

- **Layers.** `args.ts` (CLI parsing), `auth.ts` (auth checks), `config.ts` (pure: builds SDK `Options`), `result.ts` (Zod types and Markdown) and `run.ts` (consumes the SDK stream) have no side effects on import. `main.ts` only wires argv, Ctrl+C, the `git status` check and the exit code. `run.ts` takes `query` as a parameter. That parameter is the only test seam, so don't add adapter classes.
- **Reuse, don't copy.** The investigation procedure lives in the Skill. The `systemPrompt.append` in `config.ts` only maps the Skill's report onto the structured output. The CLI reuses the MCP output schemas from `src/mcp/report.ts` to parse observed tool results.
- **Observed facts vs model output.** Test facts (title, file:line, project, outcome, attempts, fingerprint) come from MCP tool results observed in the stream, never from the model. Keep the consistency checks in `run.ts`. A report without the observed Skill call, `list_test_failures` result and per-testId `get_failure_details` result is `unverified`. `get_trace_summary` results are validated against `TraceSummaryOutput` and kept in `observed.traceSummaries` (status and reason codes only, never trace facts; optional in the schema so older results parse). A report that cites `get_trace_summary` for a test without an observed `ok` or `partial` result for that test, a summary from another report, or an unparseable summary makes the run `unverified`. Trace claims based on Bash commands are left to the scorer, as before. `src/agent/test/trace-evidence.test.ts` covers this with real tool output from synthetic traces.
- **Permission surface.** `config.ts` keeps `tools`, `allowedTools` (exact names and the Skill's Bash patterns), `disallowedTools`, deny rules (in `settings.permissions.deny`, because Bash specifiers in `disallowedTools` may remove the whole tool), `permissionMode: 'dontAsk'`, `settingSources: ['project']`, `strictMcpConfig`, `autoMemoryEnabled: false`, `disableSkillShellExecution` and `persistSession: false`. `config.test.ts` asserts all of them. Widening any of them needs approval. None of this is an OS sandbox. `tools` must include `Skill`: the `skills` option only adds the `Skill(investigate-failure)` allow rule and filters the listing, and `init.skills` means "discovered", not "invocable". `process.test.ts` pins the SDK's flag translation. Don't add a bare `Skill` to `allowedTools`.
- **Auth fails closed, in three checks.** (1) Env var names before the SDK starts. (2) `initializationResult().account` before the prompt is sent. SDK 0.3.302 omits `apiKeySource` there, so subscription mode accepts its absence only with `apiProvider: firstParty`, an eligible `subscriptionType`, and a clean env; a reported `apiKeySource` is still checked strictly. (3) The stream's init `apiKeySource` must match the mode, or the session is aborted. Check 3 runs after the prompt is sent, so never describe it as preventing billing. Never print credential values, email or organization. Never switch silently to API billing. Label `total_cost_usd` as an estimate.
- **Subprocess env.** `subprocessEnv()` removes only the inherited Claude Code session variables listed in `INHERITED_SESSION_VARS` (session identity, messaging socket/token, entrypoint). Don't strip by prefix: `CLAUDE_CODE_*` configuration variables must pass through. Auth variables are refused by the preflight, never hidden.
- **Cancellation.** Timeouts and Ctrl+C abort the controller and call `close()`. With SDK 0.3.302, `close()` ends the child's stdin, then sends SIGKILL after about 7 s. `process.test.ts` checks that the child process really exits.
- **Tests** live in `src/agent/test/` (node:test). They use fake SDK streams (`helpers.ts`) and a fake Claude Code process, and must never make model requests or need credentials.

## Evaluation (Stages 2.5–2.6)

`evals/README.md` covers the dataset layout and methodology. Stage 2.5 is complete. It includes schemas, the fixture app, three pilot scenarios (S02, S04, S05), snapshot generation and storage (`generate.ts`, `snapshots.ts`), workspaces and isolation (`workspace.ts`, `isolation.ts`), offline scoring and reporting of saved runs, including a combined report over several runs (`runs.ts`, `score.ts`, `report.ts`), and the live adapter (`live.ts`). Every further live run still needs approval.

**Pilot benchmark (2.5.3, scorer v5).** One live run per scenario, combined with `report --run … --out`. Results: 3/3 exact classifications (two test-code defects, one application defect, all at High confidence), 3/3 fully accepted diagnoses, every check passed, no audit violations or suspicious findings. Total about 118 s, 32 turns and an estimated $0.52 at SDK list prices (not a charge). S04 and S05 fail identically (same alert, same HTTP 500). The agent separated them by the spec source (`page.route`/`route.fulfill`) and the trace's `_wasFulfilled` marker, not by the status code. **Three single-run scenarios do not establish statistical reliability:** each result shows what one session did, not a success rate. Don't quote these numbers as accuracy, and don't tune the Skill or the ground truth to them. The saved runs live in `evals/runs/` (gitignored). Their history is part of the record and must not be edited: S02's workspace cleanup failed (EBUSY; infrastructure only), and S04 has three dismissed `conditional-expansion` findings from a Bash call that was denied.

- **Generation vs ground truth.** `generation.json` (read by the generator through `src/eval/generation.ts`) never contains answers. `truth.json` (`src/eval/truth.ts`) is for scoring only. `generation.ts` must not import `truth.ts`. `separation.test.ts` enforces this.
- **No leaks into what the agent sees.** Scenario specs have neutral names and titles, no comments, and never mention classifications, scenario IDs or canaries. Never repeat expected answers outside `truth.json`.
- **Workspaces.** Evaluation sessions run in `<tmpdir>/ws-XXXXXX/project` and contain only the snapshot payload, `SKILL.md` and `.claude/settings.json`. Production code is reused unchanged: `runInvestigation(repoRoot = workspace)` with `evalQuery` wrapping the SDK query. `adaptOptions` may only repoint the MCP server's root (`TEST_DETECTIVE_REPO_ROOT`) and append Read deny rules. Every other option must equal `buildQueryOptions` output, and `describeDifferences` records the delta for run metadata. Never widen tools or permissions here.
- **Leakage controls are mitigations, not a sandbox.** Workspace separation, canaries and transcript audits reduce and detect leaks but can't guarantee isolation. Describe them that way.
- **Verification steps are not evidence of a diagnosis.** Only a verification-only criterion (every pattern a pure re-run phrase) may be met from `verificationSteps`; causal and fix criteria never are. Forbidden recommendations are searched there too.
- **Denied is not absent and not inspected.** `access_denied` needs the SDK's `permission_denials` record plus an error result for every attempt on the file. It makes an honest "not available" claim pass and a citation go to review, but required evidence still fails. Never treat a denial as having read the file.
- **Heuristic scoring.** Regex criteria are signals. Uncertain matches go to manual review. No LLM judge. The only automatic failures from text are forbidden claims marked `severity: "fail"` stated in a plain (unhedged, unnegated) sentence; keep that rule narrow.
- **Reviewable alternatives are a person's decision.** A `reviewable_alternative` verdict is never accepted or rejected automatically, and its confidence is not judged automatically; only a review of the `classification` check decides it, and no review ever changes a verdict. Exact agreement stays separate from acceptance.
- **New truth fields are optional** (`reportedOutcome`, `reviewableAlternatives`, `unavailableEvidence`, `severity`). Leaving them out keeps the Stage 2.5 meaning, so pilot scores stay identical; check that offline on copies of the saved runs before any scorer change, and never `--rescore` the saved pilot runs without approval.
- **Scoring is offline and pure.** `score.ts` and `report.ts` do no I/O; `runs.ts` reads saved files only. Scoring never imports the SDK at runtime, `agent/run.ts`, the generator or `child_process` (`separation.test.ts`). Facts, tool use and evidence provenance come from the raw transcript and the verified snapshot, never from the model's claims; provenance is graded (verified, unresolved -> review, unsupported or confirmed false -> fail), and a missing Read alone is never called fabrication. Classification verdicts (exact, acceptable alternative, reviewable alternative, incorrect, abstained, missing; per test, no partial credit) are reported separately from full acceptance (every check passed, reviews resolved). Only confirmed violations (canary seen, successful protected-path access, workspace changed) invalidate a run; ambiguous paths go to review. Scores record the truth hash; `score` refuses to replace a stored score that would change unless `--rescore`, which archives the old one. Reviews (`review.json`) never modify `score.json`. Golden fixtures are scorer-validation data (`source: scorer_validation`), never agent-performance measurements. The saved-run format, categories, checks and review schema are documented in `evals/README.md`; keep it in sync.
- **Baseline parity.** The baseline is normal `npm run investigate` behavior. Record every eval-specific configuration difference in run metadata and test it.
- **Generation never touches the root artifacts.** Stages live in `.work/<random>/`, and Playwright's `outputDir` is pinned to the stage in both the config and `--output`, because the default resolves to the repo root and is emptied on every run. The generator discards a snapshot if the root `artifacts/results.json`, `test-results/`, `playwright-report/` or `git status` changed. Snapshots are write-once and hash-verified on load. `.work/`, `evals/snapshots/` and `evals/runs/` are gitignored.
- **Scenario specs stay outside `testDir`**, so `npm test` never runs intentional failures. `*.test.ts` files go in `src/eval/test/`, never under `tests/`.
- **Generation options stay backward-compatible.** Every `GenerationConfig` field added after the pilot is optional and its absence reproduces the pilot behavior; a test pins the pilot `generation.json` hashes and their byte-identical stage config. Never edit the pilot scenario files or regenerate their snapshots.
- **Control specs are answers.** `control/<spec>` (the corrected test) is evaluation-side data, like `truth.json`: only `control.ts` reads it, the generator never names it (`separation.test.ts`), and it never enters a stage, snapshot or workspace. A control must pass against the scenario's own fixture behavior.
- **`post-run/<spec>` is generation-side.** It becomes the source the agent sees (S09), so it follows the spec rules: neutral, no comments, no labels. The generator writes it after Playwright exits (written, not copied, so its mtime is real), and the `source-timing` check proves it is newer than the run and differs from the error snippet.
- **Every scenario failure is synthetic and deterministic.** S07's flakiness is a scripted fail-first counter and S03's race always loses. Never describe results on them as measurements of natural flakiness or failure rates.
- Live evaluation (model requests) needs explicit approval per run. Never run a whole benchmark automatically, and never retry model requests. Never run `npm run eval -- live` without the user's approval; tests inject `query` and must never reach the real SDK (CLI tests may only use refused arguments).
- **Live adapter.** `live.ts` is the only eval module that loads the SDK at runtime (`separation.test.ts`). It runs exactly one scenario and one `runInvestigation` per invocation, requires `--max-budget-usd` (capped at 2), captures the truth, snapshot, Skill and settings hashes before the session, appends the transcript as it streams, always removes the workspace, and saves failed and interrupted runs too. A run with an injected query is labelled `scorer_validation`, never `live`.
- **Workspace cleanup is bounded.** SDK `close()` doesn't wait for the CLI and its MCP server (both with cwd = workspace) to exit, so on Windows an immediate removal fails with EBUSY. `removeWorkspace` retries only lock errors until `REMOVAL_DEADLINE_MS` (above the SDK's ~7 s SIGKILL path) and records every retried attempt in `outcome.json`. A workspace still busy at the deadline is a leak and is reported as a cleanup failure. Never raise the deadline or widen the retried codes to make that go away. Cleanup is infrastructure: it is shown in the score and report but never changes the category.
- **Shell variables in the audit.** `$NAME` is resolved only for a narrow literal `NAME=value` assignment in the same command (`shellAssignments`), and the value then gets every path check. Everything else stays `unresolved-path`. An assignment after `&&` adds a `conditional-expansion` warning. That warning, and only that one, is dismissed (kept visible in `audit.dismissed`) when the result's `permission_denials` and an error result both show the call never ran. Never classify shell variables as safe in general.
- **`StructuredOutput` is expected, not allowed.** It is the SDK's tool for `outputFormat`. The audit records it under `audit.expected` only when the session recorded an output schema, the init message announced the tool, and the call is top-level. It is not added to any tool or permission list.

## Workflow rules

- Small, focused commits. Ask before committing. Never push without explicit approval.
- Never commit artifacts (`artifacts/`, `test-results/`, `playwright-report/`).
- No proprietary or company code. This project will be public.
- Windows dev environment: run commands from the folder's exact on-disk path casing (see the README troubleshooting section).
