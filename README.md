# test-detective

An AI-assisted tool that investigates failed Playwright tests, identifies likely root causes, suggests fixes, and eventually validates them.

The project is also a hands-on way to learn modern AI-assisted software engineering with Claude Code: custom Skills, Subagents, Hooks, MCP, and later the Claude Agent SDK.

## Status

**Stage 2.4: standalone investigation CLI.** A small, reliable TypeScript Playwright suite against [the-internet.herokuapp.com](https://the-internet.herokuapp.com/) produces rich failure artifacts. A read-only [MCP server](#mcp-server) exposes them as structured tools. The `investigate-failure` Skill and `failure-investigator` Subagent use those tools inside Claude Code, and the [investigation CLI](#investigation-cli-agent-sdk) runs the same Skill and MCP server headlessly through the Claude Agent SDK, returning a validated, typed result.

## Roadmap

1. **Foundation** (done): Playwright suite, reporting, traces, screenshots, conventions.
2. **Investigation agent** (current): read failure artifacts and propose likely root causes. Skill (2.1), Subagent (2.2), MCP server (2.3), their integration (2.3.1) and the Agent SDK CLI (2.4) are in place.
3. **Fix suggestions**: propose concrete code changes.
4. **Validation**: apply a fix and re-run to confirm it.

## Prerequisites

- Node.js 24 LTS (see `.nvmrc`)
- npm

## Setup (Windows, local)

```sh
npm ci
npx playwright install chromium
```

Linux system dependencies (`--with-deps`) will be handled when CI is introduced.

## Scripts

| Command | Description |
|---|---|
| `npm test` | Run the full suite (headless Chromium) |
| `npm run test:headed` | Run with a visible browser |
| `npm run test:ui` | Open Playwright UI mode |
| `npm run test:debug` | Run with the Playwright Inspector |
| `npm run test:repeat` | Run each test 5 times. An initial stability check, not proof of reliability. |
| `npm run report` | Open the last HTML report |
| `npm run typecheck` | Type-check with `tsc --noEmit` |
| `npm run test:mcp` | Unit and protocol tests for the MCP server (no browser, no network) |
| `npm run mcp` | Start the MCP server on stdio (normally your MCP client starts it) |
| `npm run investigate` | Investigate existing failures with the Agent SDK CLI (uses your Claude account, see [below](#investigation-cli-agent-sdk)) |
| `npm run test:agent` | Offline tests for the CLI (no model requests; fake SDK streams and a fake Claude Code process) |

## Test artifacts

| Path | Contents |
|---|---|
| `playwright-report/` | HTML report (open with `npm run report`) |
| `artifacts/results.json` | Machine-readable results (JSON reporter) |
| `test-results/<test-id>/` | Per-failure `trace.zip`, `test-failed-1.png`, `error-context.md` |

Traces and screenshots are kept **only for failed tests**. To open a trace:

```sh
npx playwright show-trace test-results/<test-id>/trace.zip
```

All artifact folders are git-ignored.

## MCP server

`src/mcp/` is a local [Model Context Protocol](https://modelcontextprotocol.io/) server built with the official TypeScript SDK v2 (`@modelcontextprotocol/server`) and Zod v4. It gives any MCP client structured, read-only access to the latest Playwright results. It never runs tests, writes files or contacts the network.

### Tools

| Tool | Input | Returns |
|---|---|---|
| `list_test_failures` | none | Run info (start time, duration, Playwright version, report fingerprint), stats, global errors, and every `unexpected` or `flaky` test with its `testId`, title path, file, project, outcome and per-attempt statuses. Returns an empty `failures` list and a message when nothing failed. |
| `get_failure_details` | `testId` from `list_test_failures` | For one failed or flaky test: location, tags, outcome, configured retries, and per attempt: status, error message, verbatim `Expected…`/`Received…` lines, location, code snippet, trimmed stack, and attachment metadata (screenshot, trace, error-context). |
| `get_trace_summary` (server opt-in, see below) | `testId` and `retry` (the attempt index) | Bounded, sanitized facts from that attempt's `trace.zip`: browser requests and API-context backend fetches, route markers and `route.fulfill`/`continue`/`abort` calls, identifier-based fetch links, redirects, the failing action and its time, console counts, page-error names, and parse coverage. |

The server reports facts from the report and does not diagnose. The `outcome` is Playwright's own:
- `flaky`: an attempt failed and a later one passed.
- `unexpected`: no attempt produced the expected status.

Each attempt's status is listed separately (`failed`, `timedOut`, `passed`…). That's why the server never assumes a test failed the same way every time.

**Output is kept small:**
- ANSI codes are stripped.
- Messages are capped at about 2,000 characters and stacks at 15 frames.
- At most 4 extra errors are kept per attempt.
- stdout/stderr are reported as counts only.
- Attachments are described, never read. A missing screenshot or trace shows up as `exists: false`, not as a tool error. Inline attachment bodies return only their size.

**Errors** come back as `isError: true` results whose single text block is the JSON `{ "error": { "code", "message", "hint" } }`. They have no `structuredContent`, because some clients (MCP Inspector, for example) validate `structuredContent` against the tool's `outputSchema` even on errors. The codes are:
- `REPORT_NOT_FOUND`
- `REPORT_MALFORMED_JSON`
- `REPORT_INVALID_SHAPE`
- `REPORT_TOO_LARGE`
- `REPORT_OUTSIDE_REPO`
- `REPORT_UNREADABLE`
- `INVALID_TEST_ID`
- `REPORT_CHANGED`
- `TEST_NOT_FOUND`
- `TEST_NOT_FAILED`
- `ATTEMPT_NOT_FOUND` (`get_trace_summary` only: the test has no attempt with that `retry`)

Arguments that don't match the input schema are rejected by the SDK before the tool runs.

### `get_trace_summary` (Stage 3.2; used by investigations since Stage 3.3)

The server registers this tool only when it is started with `--enable-trace-summary` (for example `npx @modelcontextprotocol/inspector node src/mcp/main.ts --enable-trace-summary`). The investigation launchers pass it: `.mcp.json` (interactive sessions, the Skill and the `failure-investigator` Subagent) and the Agent SDK CLI. `npm run mcp` doesn't, so a server started that way has only the two original tools. `src/agent/test/trace-tool.test.ts` pins both, and that every allow list names the same three tools.

**Input and selection.** The input is a `testId` and a `retry`, nothing else; extra arguments such as a path are rejected. The trace is the `trace` attachment of that attempt in the current report, resolved and confined to the repo like every other attachment path. An attempt without a trace (passed under `retain-on-failure`, the first try under `on-first-retry`, `trace: 'off'`) returns `trace.status: "missing"`, not an error.

**Status.**
- `ok`: every whitelisted entry was read in full and its CRC-32 verified.
- `partial`: something was not read (a budget, a corrupt or skipped entry, skipped lines). `trace.reasons` and `coverage` say what. Lists then cover only what was read. Anything not listed is **unknown, not absent**.
- `missing`: no readable trace for this attempt.
- `unsupported`: the archive is invalid or hostile, or the trace format isn't verified (only format `version: 10`, Playwright 1.64, is).

**What it reads.** Only `test.trace` and `<n>-trace.trace`/`<n>-trace.network` entries, streamed through `yauzl` (pinned) and never extracted to disk. Screenshots, resources (bodies), sources, attachments and stacks are counted, never read. The ZIP layer refuses invalid, duplicate, NUL/control-character and traversal entry names and too many entries. It checks each entry's local header name against the central directory, counts actual inflated bytes against the limits (an entry whose declared size exceeds the per-entry limit is read only up to it and reported `partial`), verifies CRC-32 incrementally and drops corrupt entries entirely. Lines over 1 MB are skipped and counted.

**Budgets** (initial ceilings, from the Stage 3.2 spike): 100 MB file, 5,000 entries, 64 MB per entry, 128 MB inflated per call, 250,000 lines, 2 s. At most 5,000 network records are kept in memory, by priority: 3,000 failed/error/pending/route-marked/redirect/API records, 1,500 documents/fetch/XHR, 500 static assets; the rest are counted. Of those, the 50 returned are the ones nearest the failure. One trace is parsed at a time. Parsing streams and yields to the event loop, so other tool calls stay responsive. Sanitized summaries are cached per server (16 entries), keyed by the file's identity (device, inode, size, mtime, ctime) and a hash of the archive tail (the central directory, with every entry's CRC). Results cut short by time or cancellation are not cached.

**What it returns, and what it never returns.** Paths without origin, userinfo, query or fragment (secret-looking segments become `:redacted`), standard methods and reason phrases, `net::ERR_*` codes, route markers, call counts, glob paths (`null` for regexes and for globs that name a host or contain a secret-looking part), step locations for Playwright's own route steps (repo-relative with plain file-name characters, otherwise `null`), console counts by level and standard page-error names. Never: headers, cookies, bodies, `Route.fulfill` bodies, query strings, console or page-error messages, stacks, absolute host paths, arbitrary `test.trace` parameters or user step titles. Output is capped at 50 requests, 20 backend fetches/fulfillments/page errors and 64 KB. Redaction is heuristic: it minimizes free text but can't guarantee that no secret survives in a short path segment.

**Observations, not classifications.** The tool never says what kind of defect a failure is. In particular:
- `marker: "fulfilled"` (Playwright's `_wasFulfilled`) does **not** mean the test created the response. A `route.fetch()` response passed to `route.fulfill()` is marked fulfilled too. `routes.fulfillments[].fetch.link: "linked"` (matching fetch identifiers) proves that, with `fetchedStatus` and `statusChanged`. `"none"` means no identifier link, not "created by the test": a fetched response whose body was replaced loses the identifier.
- `marker: "none"` or a missing server address does **not** prove a live backend response.
- `route.fulfill` events carry no request identifier, so the request a call served is correlated by time window. Overlapping candidates stay `ambiguous`.
- Redirects are matched to their target by exact URL; no match or several matches stay `unmatched`/`ambiguous`.

### Test identifiers

A `testId` looks like `b92766bcf73bd5c029a8-b70129c060c649fc9909@1f3b522173b4`:

- **Before the `@`** is Playwright's `spec.id`: `sha1(file)` + `sha1([project=…] file + titles [+ repeat index])`, 20 hex characters each. In Playwright 1.64, every project and every `--repeat-each` run gets its own spec entry, so this part is unique within a report. If a reporter ever merges several projects into one spec, a `.<n>` suffix keeps the IDs unique.
- **After the `@`** is the report fingerprint: the first 12 hex characters of the SHA-256 of `results.json`.

Limitations:
- The first part changes when the test title, a `describe` title, the file path or the project name changes.
- Repeats of the same test in the same project are told apart only by their ID. The report has no repeat index field.
- The fingerprint changes on every new run. An ID from an old report returns `REPORT_CHANGED` instead of silently selecting a different test, so call `list_test_failures` again. IDs are for selecting a test **within the current report**, not permanent keys. The server keeps no state between calls.

### Paths and safety

- The report path is fixed (`artifacts/results.json` under the repo root). Clients never supply file paths.
- The repo root comes from the server file's own location, not the shell's working directory.
- Attachment paths in the report are absolute paths from the machine that ran the tests. Both Windows `C:\…` and POSIX `/…` are supported. Each path is made relative to the report's own config directory and then resolved under this repo. That way, a report produced on a Linux CI machine still maps correctly.
- UNC paths, drive-relative paths, control characters and `..` escapes are rejected. Paths outside the repo are reported as `outside-repo` and not checked.
- Files are only `stat`ed, never read, with one exception: `get_trace_summary` reads the whitelisted event entries of the trace it selected (see above). Symlinks and junctions are resolved first, so a link that points outside the repo is refused.

### Lifecycle

1. **Server startup.** The client spawns `node src/mcp/main.ts`. Node 24 strips the TypeScript types at load time, so there is no build step. `serveStdio()` binds stdin/stdout. The server logs one line to stderr. **stdout is reserved for JSON-RPC.** A single stray `console.log` would corrupt the stream, and a test checks for this.
2. **Client initialization.** The client sends `initialize` with its protocol version and capabilities. The server answers with its name, version and capabilities (`tools`). The client then sends `notifications/initialized`. `serveStdio` pins one `McpServer` instance from `createServer()` to the connection.
3. **Tool discovery.** `tools/list` returns each tool's name, title, description, JSON Schema for input and output (generated from the Zod schemas) and annotations (`readOnlyHint`, `openWorldHint: false`…).
4. **Input validation.** On `tools/call`, the SDK validates arguments against the Zod input schema. Invalid arguments return an `isError` result ("Input validation error…") without running the handler. An unknown tool name is a JSON-RPC protocol error. The handler then validates the `testId` format itself.
5. **Tool execution.** The handler reloads and fingerprints the report on every call, so there is no stale cache. It then runs the pure parsing functions in `report.ts`.
6. **Structured result.** The handler returns `structuredContent`, which the SDK checks against the output schema, plus the same JSON as a `text` block for clients that only show text. Failures return `isError: true` with `{ error: { code, message, hint } }` as JSON text and no `structuredContent`.
7. **Shutdown.** When the client closes stdin (EOF), the transport closes and the process exits. SIGINT/SIGTERM call `handle.close()`. Requests still in flight at EOF are not answered.

### Connecting a client

**Claude Code.** The project's `.mcp.json` registers the server. The command is plain `node`, so it works on Windows without a `cmd /c` wrapper and on Linux as-is, with no personal paths. Claude Code asks you to approve project servers the first time. Run `/mcp` to check that `test-detective` is connected.

**MCP Inspector.** For an interactive look at the protocol (downloads the Inspector via `npx`):

```sh
npx @modelcontextprotocol/inspector node src/mcp/main.ts
```

**Automated.** `npm run test:mcp` connects the SDK `Client` to the server in memory and over real stdio.

Type stripping is on by default in Node 24, so no `--experimental-strip-types` flag is needed.

## Investigation CLI (Agent SDK)

`src/agent/` is a standalone command-line app built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) (`@anthropic-ai/claude-agent-sdk`, pinned). It investigates the **existing** `artifacts/results.json`. It never runs tests or changes files.

```sh
npm run investigate                          # every failed or flaky test
npm run investigate -- --test "checkboxes"   # title or spec file contains the filter
npm run investigate -- --help                # --model, --max-turns, --timeout, --max-budget-usd, --auth, --json
```

### How it works

One SDK session per run. The SDK starts a Claude Code process, which starts our MCP server as its child.

1. **Auth preflight before the prompt.** The CLI checks environment variable names, then reads the session's account from SDK initialization (`apiProvider`, `subscriptionType`, `apiKeySource` when reported). The prompt is held back until that preflight passes, and the stream's first message must then confirm `apiKeySource`. See [Authentication and cost](#authentication-and-cost).
2. **Same procedure as the Subagent.** The prompt asks Claude to invoke the `investigate-failure` Skill, loaded from `.claude/skills` via `settingSources: ['project']`. The Skill's procedure is not copied into the CLI.
3. **Same MCP server.** Passed explicitly (`node src/mcp/main.ts --enable-trace-summary`, using the Node binary running the CLI) with `strictMcpConfig`, so `.mcp.json`, user MCP config and claude.ai connectors are ignored.
4. **Typed result.** The model returns only its analysis as structured output, validated with Zod (`src/agent/result.ts`). The CLI takes test facts (title, file:line, project, outcome, attempts, report fingerprint) from the MCP results it **observed in the stream**, not from the model.
5. **Consistency checks.** A run is `completed` only if the CLI saw a successful Skill invocation (a `Skill` tool call; a discovered skill or a `Read` of `SKILL.md` doesn't count), a `list_test_failures` result, and a `get_failure_details` result for every testId the model cites, and every failure matching the filter was investigated. A report that cites `get_trace_summary` needs an observed `ok` or `partial` result for that test from the same report. Otherwise it is `unverified` (exit 7). A plausible report alone is not accepted.

Output is Markdown with observed facts and model analysis in separate sections, or the full result with `--json`. Exit codes: 0 completed (including "no failures"), 2 invalid arguments, 3 auth refused, 4 MCP unavailable or report error, 5 session or model error, 6 timeout or interrupted, 7 invalid or unverified output.

### How it differs from the Subagent

| | `failure-investigator` Subagent | `npm run investigate` |
|---|---|---|
| Runs in | Your interactive Claude Code session | A separate headless SDK session |
| Output | Free-form Markdown report in the chat | Zod-validated result (Markdown or JSON) plus exit code |
| Settings | Your full Claude Code settings and permission mode | Project settings only; auto memory off; `dontAsk` always |
| Verification | You read the transcript | The CLI checks tool calls itself (`unverified` if missing) |
| Use for | Ad-hoc questions while working | Scripts, and later CI |

### Read-only configuration

These are **runtime restrictions enforced by Claude Code, not an OS sandbox**:

- Only `Read`, `Grep`, `Glob`, `Bash` and `Skill` exist as built-in tools. Edit, Write, NotebookEdit, PowerShell, WebFetch, WebSearch and Agent are removed. `skills: ['investigate-failure']` limits the Skill tool to that one skill: the SDK turns it into a `Skill(investigate-failure)` allow rule and hides every other skill from the listing. It does not add the Skill tool itself. Without `Skill` in `tools`, the skill is discovered but can't be invoked, and the model ends up reading `SKILL.md` as a file (run status `unverified`).
- `permissionMode: 'dontAsk'` with an exact allowlist: the three test-detective MCP tools and the Skill's read-only Bash patterns (`unzip -l`, `unzip -p`, `grep`, `head`, `ls`). Anything else is denied, not prompted.
- Deny rules for `git`, `npm`, `npx`, `node`, `playwright`, `curl`, `wget` and `rm` apply in every mode.
- Skill shell injections are disabled, auto memory is off, and the session is not persisted to disk.
- The CLI compares `git status` before and after the run and warns if anything changed (detection, not prevention).

Limits worth knowing: `grep`, `ls` and `unzip` can read any file your user can read. Network access isn't blocked at the OS level. Claude Code talks to the model provider, and the MCP server and Node aren't sandboxed.

### Authentication and cost

The SDK authenticates like Claude Code. Credentials are checked in this order: cloud-provider variables, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, then your `/login` subscription credentials. An API key in the environment silently wins over your subscription, so the CLI makes the mode explicit:

- **`--auth subscription` (default).** Uses your Claude Code login (for example Pro).
- **`--auth api`.** Deliberate API billing. Requires `ANTHROPIC_API_KEY` (and no other credential variable).

Each run goes through three checks:

| Check | When | Subscription mode | API mode | On failure |
|---|---|---|---|---|
| 1. Environment | Before the SDK starts | None of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_PROFILE`, the federation variables or `CLAUDE_CODE_USE_*` are set | Only `ANTHROPIC_API_KEY` is set | Nothing started |
| 2. Account preflight | After initialization, **before the prompt** | `apiProvider: firstParty`, an eligible `subscriptionType` (Pro, Max, Team or Enterprise), no key-like `tokenSource`, and `apiKeySource` either `none` or **not reported** | `apiProvider: firstParty` and `apiKeySource: ANTHROPIC_API_KEY` reported | Prompt never sent |
| 3. Stream confirmation | First message of the session (system/init) | `apiKeySource: none` | `apiKeySource: ANTHROPIC_API_KEY` | Session aborted at once |

**What this guarantees and what it doesn't.** Checks 1 and 2 run before any prompt exists, so a failure there means no model request was made. Check 3 is different. SDK 0.3.302 doesn't include `apiKeySource` in the initialization account info, so in subscription mode the source is only confirmed by the stream's init message, which can arrive after the prompt has been submitted. A failure there aborts the session immediately. It can't undo a request that's already in flight, so it isn't a guarantee against billing.

What stops API billing from being used silently is that the CLI refuses to start when an API key, token, or provider variable is set, and that the account must report an eligible subscription before the prompt is sent. Any contrary signal stops the run. The CLI never falls back to another credential.

The CLI never prints credential values, email or organization. It reports only the source fields above.

When you run the CLI from a shell that a Claude Code session started, the CLI removes that session's variables (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`) from the SDK subprocess, so it doesn't attach to that session. Other variables, including Claude Code configuration variables, pass through unchanged.

Anthropic's docs say that, unless previously approved, third-party developers may not offer claude.ai login or rate limits in their products, including Agent SDK agents. This CLI is a personal developer tool that runs on your own machine with your own login. Don't package it as a product for others with subscription login. Use API keys for that.

The reported **estimated usage cost** is the SDK's own estimate at list prices (`total_cost_usd`). It is not a bill. On a subscription, usage counts against your plan limits instead. `--max-budget-usd` stops on that estimate. `--max-turns` (default 30) and `--timeout` (default 300 s) bound every run. A timeout or Ctrl+C closes the session. The SDK ends Claude Code's stdin and kills it after a grace period of about 7 s if it's still running.

## Project structure

```
tests/ui/             UI specs, one file per feature area
src/mcp/              MCP server: report.ts (parsing), paths.ts (path safety), trace-summary.ts, trace.ts and zip.ts (get_trace_summary), server.ts (tools), main.ts (stdio)
src/mcp/test/         node:test unit and protocol tests, with synthetic report fixtures and synthetic trace archives
src/agent/            Agent SDK CLI: args.ts, auth.ts, config.ts (SDK options), result.ts (Zod types, Markdown), run.ts (session), main.ts (entry)
src/agent/test/       node:test tests with fake SDK streams and a fake Claude Code process (offline)
playwright.config.ts  Runner, reporters, artifact settings
.mcp.json             Project MCP server registration for Claude Code
CLAUDE.md             Development conventions (for humans and Claude Code)
```

## Troubleshooting

**`Playwright Test did not expect test() to be called here` on Windows.** Windows paths are case-insensitive, but Node's module cache keys are case-sensitive. If your shell's working directory differs in case from the real folder name on disk (for example `C:\git\...` versus an on-disk `C:\GIT\...`), Playwright can load two copies of its internals. To fix it, `cd` into the path using its exact on-disk casing, or rename the folder so the casing matches.

**`npm run investigate` exits 3 (`auth_refused`).** The message names the variable or the session field that didn't match. Unset the variable, or run `claude` and `/login` with your subscription account. To use API billing on purpose, pass `--auth api`.

**Exit 4 with "MCP server … is failed".** Run `npm run test:mcp` and `npm run mcp` to see the server's own error, for example a wrong Node version. The CLI starts the server with the same Node binary that runs the CLI.

**Exit 7 (`unverified`).** The model's report wasn't backed by the tool calls the CLI observed. The issues list says which call or testId was missing. Re-run, or investigate interactively with the Subagent.

**Exit 6 after the timeout.** Raise `--timeout`, or narrow the run with `--test`. The process can take a few more seconds to exit while the SDK shuts Claude Code down.

## License

[MIT](LICENSE)
