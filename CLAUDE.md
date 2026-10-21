# CLAUDE.md

Conventions for working on test-detective, for both human contributors and Claude Code.

## Project goal

An AI-assisted tool that investigates failed Playwright tests. A parallel goal is learning Claude Code features (Skills, Subagents, Hooks, MCP, Agent SDK) by using them deliberately. Favor explaining and teaching over silently delegating.

## Current stage: 2.4 (standalone investigation CLI on the Agent SDK)

In scope: the Playwright suite, its config and reporting, the `investigate-failure` Skill, the `failure-investigator` Subagent, the read-only MCP server in `src/mcp/`, the read-only Agent SDK CLI in `src/agent/`, and docs.

**Do not build yet:** auto-fixing or applying changes, running tests from an agent, Hooks, a dashboard, an HTTP API or HTTP MCP transport, multiple agents or parallel investigation, CI/cloud infrastructure. Propose these, but don't implement them without explicit approval.

## Commands

```sh
npm run typecheck     # tsc --noEmit
npm test              # full Playwright suite (needs network)
npm run test:mcp      # MCP server unit + protocol tests (node:test, offline)
npm run mcp           # start the MCP server on stdio
npm run test:agent    # Agent SDK CLI tests (node:test, offline, no model requests)
npm run investigate   # live investigation via the Agent SDK (uses the Claude account; ask first)
npm run test:repeat   # initial stability check (--repeat-each=5)
npm run report        # open HTML report
```

Before declaring a change done, run `npm run typecheck` plus the relevant tests (`npm test` for the UI suite, `npm run test:mcp` for `src/mcp/`, `npm run test:agent` for `src/agent/`) and report the results honestly. Never run `npm run investigate` without the user's approval: it makes real model requests on their account.

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

When classifying, the Skill treats an HTTP error the test mocked itself (`page.route` / `route.fulfill`, or `"_wasFulfilled":true` in the trace) as a test-code defect, not an application defect. Keep that rule if you edit its classification step.

## Claude Code Subagents

| Subagent | Invocation | Purpose |
|---|---|---|
| `failure-investigator` | "Use the failure-investigator subagent to investigate <test or spec>", or `@agent-failure-investigator` | Runs the `investigate-failure` Skill in a separate context and returns only its report |

Subagents live in `.claude/agents/<name>.md`. Run the Skill directly when you want a quick inline look. Delegate to the subagent when you want to keep raw artifacts out of the main context.

`failure-investigator` preloads the Skill through `skills:`. Don't copy the Skill's procedure into the agent file; edit the Skill instead. The agent is meant to stay read-only. Its tool allowlist (`Read, Grep, Glob, Bash` plus the two read-only test-detective MCP tools) and `permissionMode: dontAsk` reduce risk, but they aren't a hard security boundary. Bash can still write files, and if the parent session is in `acceptEdits`, `auto` or `bypassPermissions`, the parent's mode overrides `dontAsk`. Delegate from Default (manual approval) mode.

## MCP server

| Tool | Input | Purpose |
|---|---|---|
| `list_test_failures` | none | Run info, stats, global errors, failed/flaky tests with `testId`s |
| `get_failure_details` | `testId` | Per-attempt errors, locations, snippets, attachment metadata for one test |

Registered in `.mcp.json` as `test-detective` (stdio, `node src/mcp/main.ts`). The README explains the lifecycle, the ID format and the path rules.

- **Layers.** `report.ts` and `paths.ts` hold all Playwright parsing and have no MCP imports. `server.ts` only registers tools and maps results and `ReportError`s to tool results. `main.ts` only wires stdio.
- **Read-only.** The tools only read `artifacts/results.json` (fixed path) and `stat`/`realpath` attachment paths inside the repo. Never accept file paths from clients, never read attachment contents, never run tests, write files or use the network.
- **stdout is protocol only.** Log with `console.error`. The stdio test fails on any non-JSON-RPC stdout line.
- **No diagnosis.** Tools report facts from the report. Root-cause analysis belongs to the Skill (and the agents that run it).
- **IDs** are `<spec.id>@<report fingerprint>`. An ID from an older report returns `REPORT_CHANGED`. Keep that check if you change the ID format.
- **TypeScript runs through Node 24's native type stripping** (no flags). Use erasable syntax only (no `enum`, no parameter properties), `import type` for types, and `.ts` extensions in relative imports. `tsconfig.json` enforces this.
- **Tests** live in `src/mcp/test/` (`*.test.ts`, node:test) with synthetic fixtures in `src/mcp/test/fixtures/`. Never put `*.test.ts` under `tests/`, because Playwright's `testDir` would pick them up. Tests must not depend on the live demo site.
- **Consumers.** The `investigate-failure` Skill gets failure data only from these two tools (never by parsing `results.json`) and reads source, screenshots, error-context and traces directly. If the server is unavailable it reports that and stops; there is no JSON fallback. `failure-investigator` lists both tools by exact name (`mcp__test-detective__list_test_failures`, `mcp__test-detective__get_failure_details`) in `tools:`, because an explicit allowlist does not inherit MCP tools. Listing a tool there makes it available but doesn't approve it, and the Skill's `allowed-tools` doesn't carry into a preloaded `dontAsk` subagent (verified: the call was denied). The project `.claude/settings.json` therefore allows exactly these two tools. The Agent SDK CLI (`src/agent/config.ts`) uses the same two tool names and parses their output with the schemas exported from `report.ts`. If you rename the server key in `.mcp.json` or a tool in `server.ts`, update the agent, the Skill, `.claude/settings.json` and `src/agent/config.ts`. If you change an output schema, run `npm run test:agent` too.

## Agent SDK CLI

`npm run investigate [-- --test <filter>]` runs one `@anthropic-ai/claude-agent-sdk` session (version pinned exactly; SDK `0.3.N` bundles Claude Code `2.1.N`). It invokes the `investigate-failure` Skill and uses the `test-detective` MCP server. The README covers usage, auth and exit codes.

- **Layers.** `args.ts` (CLI parsing), `auth.ts` (auth checks), `config.ts` (pure: builds SDK `Options`), `result.ts` (Zod types and Markdown) and `run.ts` (consumes the SDK stream) have no side effects on import. `main.ts` only wires argv, Ctrl+C, the `git status` check and the exit code. `run.ts` takes `query` as a parameter. That parameter is the only test seam, so don't add adapter classes.
- **Reuse, don't copy.** The investigation procedure lives in the Skill. The `systemPrompt.append` in `config.ts` only maps the Skill's report onto the structured output. The CLI reuses the MCP output schemas from `src/mcp/report.ts` to parse observed tool results.
- **Observed facts vs model output.** Test facts (title, file:line, project, outcome, attempts, fingerprint) come from MCP tool results observed in the stream, never from the model. Keep the consistency checks in `run.ts`. A report without the observed Skill call, `list_test_failures` result and per-testId `get_failure_details` result is `unverified`.
- **Permission surface.** `config.ts` keeps `tools`, `allowedTools` (exact names and the Skill's Bash patterns), `disallowedTools`, deny rules (in `settings.permissions.deny`, because Bash specifiers in `disallowedTools` may remove the whole tool), `permissionMode: 'dontAsk'`, `settingSources: ['project']`, `strictMcpConfig`, `autoMemoryEnabled: false`, `disableSkillShellExecution` and `persistSession: false`. `config.test.ts` asserts all of them. Widening any of them needs approval. None of this is an OS sandbox. `tools` must include `Skill`: the `skills` option only adds the `Skill(investigate-failure)` allow rule and filters the listing, and `init.skills` means "discovered", not "invocable". `process.test.ts` pins the SDK's flag translation. Don't add a bare `Skill` to `allowedTools`.
- **Auth fails closed, in three checks.** (1) Env var names before the SDK starts. (2) `initializationResult().account` before the prompt is sent. SDK 0.3.302 omits `apiKeySource` there, so subscription mode accepts its absence only with `apiProvider: firstParty`, an eligible `subscriptionType`, and a clean env; a reported `apiKeySource` is still checked strictly. (3) The stream's init `apiKeySource` must match the mode, or the session is aborted. Check 3 runs after the prompt is sent, so never describe it as preventing billing. Never print credential values, email or organization. Never switch silently to API billing. Label `total_cost_usd` as an estimate.
- **Subprocess env.** `subprocessEnv()` removes only the inherited Claude Code session variables listed in `INHERITED_SESSION_VARS` (session identity, messaging socket/token, entrypoint). Don't strip by prefix: `CLAUDE_CODE_*` configuration variables must pass through. Auth variables are refused by the preflight, never hidden.
- **Cancellation.** Timeouts and Ctrl+C abort the controller and call `close()`. With SDK 0.3.302, `close()` ends the child's stdin, then sends SIGKILL after about 7 s. `process.test.ts` checks that the child process really exits.
- **Tests** live in `src/agent/test/` (node:test). They use fake SDK streams (`helpers.ts`) and a fake Claude Code process, and must never make model requests or need credentials.

## Workflow rules

- Small, focused commits. Ask before committing. Never push without explicit approval.
- Never commit artifacts (`artifacts/`, `test-results/`, `playwright-report/`).
- No proprietary or company code. This project will be public.
- Windows dev environment: run commands from the folder's exact on-disk path casing (see the README troubleshooting section).
