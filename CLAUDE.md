# CLAUDE.md

Conventions for working on test-detective, for both human contributors and Claude Code.

## Project goal

An AI-assisted tool that investigates failed Playwright tests. A parallel goal is learning Claude Code features (Skills, Subagents, Hooks, MCP, Agent SDK) by using them deliberately. Favor explaining and teaching over silently delegating.

## Current stage: 2.3.1 (Skill and Subagent use the MCP server)

In scope: the Playwright suite, its config and reporting, the `investigate-failure` Skill, the `failure-investigator` Subagent, the read-only MCP server in `src/mcp/`, and docs.

**Do not build yet:** an autonomous AI agent (Agent SDK), Hooks, a dashboard, HTTP MCP transport, CI/cloud infrastructure. Propose these, but don't implement them without explicit approval.

## Commands

```sh
npm run typecheck     # tsc --noEmit
npm test              # full Playwright suite (needs network)
npm run test:mcp      # MCP server unit + protocol tests (node:test, offline)
npm run mcp           # start the MCP server on stdio
npm run test:repeat   # initial stability check (--repeat-each=5)
npm run report        # open HTML report
```

Before declaring a change done, run `npm run typecheck` plus the relevant tests (`npm test` for the UI suite, `npm run test:mcp` for `src/mcp/`) and report the results honestly.

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
- **No diagnosis.** Tools report facts from the report. Root-cause analysis belongs to the Skill or a future agent.
- **IDs** are `<spec.id>@<report fingerprint>`. An ID from an older report returns `REPORT_CHANGED`. Keep that check if you change the ID format.
- **TypeScript runs through Node 24's native type stripping** (no flags). Use erasable syntax only (no `enum`, no parameter properties), `import type` for types, and `.ts` extensions in relative imports. `tsconfig.json` enforces this.
- **Tests** live in `src/mcp/test/` (`*.test.ts`, node:test) with synthetic fixtures in `src/mcp/test/fixtures/`. Never put `*.test.ts` under `tests/`, because Playwright's `testDir` would pick them up. Tests must not depend on the live demo site.
- **Consumers.** The `investigate-failure` Skill gets failure data only from these two tools (never by parsing `results.json`) and reads source, screenshots, error-context and traces directly. If the server is unavailable it reports that and stops; there is no JSON fallback. `failure-investigator` lists both tools by exact name (`mcp__test-detective__list_test_failures`, `mcp__test-detective__get_failure_details`) in `tools:`, because an explicit allowlist does not inherit MCP tools. Listing a tool there makes it available but doesn't approve it, and the Skill's `allowed-tools` doesn't carry into a preloaded `dontAsk` subagent (verified: the call was denied). The project `.claude/settings.json` therefore allows exactly these two tools. If you rename the server key in `.mcp.json` or a tool in `server.ts`, update the agent, the Skill and `.claude/settings.json`.

## Planned layout (future stages; do not create yet)

```
src/agent/   investigation agent (reads the artifact contract above)
```

## Workflow rules

- Small, focused commits. Ask before committing. Never push without explicit approval.
- Never commit artifacts (`artifacts/`, `test-results/`, `playwright-report/`).
- No proprietary or company code. This project will be public.
- Windows dev environment: run commands from the folder's exact on-disk path casing (see the README troubleshooting section).
