# test-detective

An AI-assisted tool that investigates failed Playwright tests, identifies likely root causes, suggests fixes, and eventually validates them.

The project is also a hands-on way to learn modern AI-assisted software engineering with Claude Code: custom Skills, Subagents, Hooks, MCP, and later the Claude Agent SDK.

## Status

**Stage 2.3: local MCP server.** A small, reliable TypeScript Playwright suite against [the-internet.herokuapp.com](https://the-internet.herokuapp.com/) produces rich failure artifacts. The `investigate-failure` Skill and `failure-investigator` Subagent read them, and a read-only [MCP server](#mcp-server) exposes them as structured tools.

## Roadmap

1. **Foundation** (done): Playwright suite, reporting, traces, screenshots, conventions.
2. **Investigation agent** (current): read failure artifacts and propose likely root causes. Skill (2.1), Subagent (2.2) and MCP server (2.3) are in place.
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

Arguments that don't match the input schema are rejected by the SDK before the tool runs.

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
- Files are only `stat`ed, never read. Symlinks and junctions are resolved first, so a link that points outside the repo is refused.

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

## Project structure

```
tests/ui/             UI specs, one file per feature area
src/mcp/              MCP server: report.ts (parsing), paths.ts (path safety), server.ts (tools), main.ts (stdio)
src/mcp/test/         node:test unit and protocol tests, with synthetic report fixtures
playwright.config.ts  Runner, reporters, artifact settings
.mcp.json             Project MCP server registration for Claude Code
CLAUDE.md             Development conventions (for humans and Claude Code)
```

## Troubleshooting

**`Playwright Test did not expect test() to be called here` on Windows.** Windows paths are case-insensitive, but Node's module cache keys are case-sensitive. If your shell's working directory differs in case from the real folder name on disk (for example `C:\git\...` versus an on-disk `C:\GIT\...`), Playwright can load two copies of its internals. To fix it, `cd` into the path using its exact on-disk casing, or rename the folder so the casing matches.

## License

[MIT](LICENSE)
