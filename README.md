# test-detective

An AI-assisted tool that investigates failed Playwright tests, identifies likely root causes, suggests fixes, and eventually validates them.

The project is also a hands-on way to learn modern AI-assisted software engineering with Claude Code: custom Skills, Subagents, Hooks, MCP, and later the Claude Agent SDK.

## Status

**Stage 1: Playwright foundation.** This is a small, reliable TypeScript Playwright suite against [the-internet.herokuapp.com](https://the-internet.herokuapp.com/) that produces rich failure artifacts. There is no AI agent yet.

## Roadmap

1. **Foundation** (current): Playwright suite, reporting, traces, screenshots, conventions.
2. **Investigation agent**: read failure artifacts and propose likely root causes.
3. **Fix suggestions**: propose concrete code changes.
4. **Validation**: apply a fix and re-run to confirm it.

## Prerequisites

- Node.js 22 or newer (see `.nvmrc`)
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

## Project structure

```
tests/ui/             UI specs, one file per feature area
playwright.config.ts  Runner, reporters, artifact settings
CLAUDE.md             Development conventions (for humans and Claude Code)
```

## Troubleshooting

**`Playwright Test did not expect test() to be called here` on Windows.** Windows paths are case-insensitive, but Node's module cache keys are case-sensitive. If your shell's working directory differs in case from the real folder name on disk (for example `C:\git\...` versus an on-disk `C:\GIT\...`), Playwright can load two copies of its internals. To fix it, `cd` into the path using its exact on-disk casing, or rename the folder so the casing matches.

## License

[MIT](LICENSE)
