# CLAUDE.md

Conventions for working on test-detective, for both human contributors and Claude Code.

## Project goal

An AI-assisted tool that investigates failed Playwright tests. A parallel goal is learning Claude Code features (Skills, Subagents, Hooks, MCP, Agent SDK) by using them deliberately. Favor explaining and teaching over silently delegating.

## Current stage: 1 (Playwright foundation)

In scope: the Playwright suite, its config, reporting, and docs.

**Do not build yet:** the AI agent, a dashboard, MCP integrations, CI/cloud infrastructure. Propose these, but don't implement them without explicit approval.

## Commands

```sh
npm run typecheck     # tsc --noEmit
npm test              # full suite
npm run test:repeat   # initial stability check (--repeat-each=5)
npm run report        # open HTML report
```

Before declaring a change done, run `npm run typecheck` and `npm test` and report the results honestly.

## Test conventions

- One feature area per spec file in `tests/ui/`, named `<feature>.spec.ts`.
- Locator priority: `getByRole` > `getByLabel` > `getByText` > CSS ids. Leave a comment when you fall back to CSS or positional locators.
- Web-first assertions only (`await expect(locator)...`). Never use `waitForTimeout` or sleeps.
- Tests are independent and parallel-safe: no shared state, no ordering assumptions.
- Use relative URLs (`page.goto('/login')`). `baseURL` lives in `playwright.config.ts`.
- No Page Objects or helpers until real duplication justifies them.
- Keep dependencies minimal. Ask before adding one.

## Artifact contract

The future investigation agent depends on these paths. Don't change them without updating this file and the README.

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
| `investigate-failure` | `/investigate-failure [test title or spec]` | Read-only root-cause report for failed tests, built from the artifact contract above |

Skills live in `.claude/skills/<name>/SKILL.md`. `investigate-failure` must stay read-only: it never edits files, reruns tests, or contacts external services. If you change the artifact contract, update the Skill too.

When classifying, the Skill treats an HTTP error the test mocked itself (`page.route` / `route.fulfill`, or `"_wasFulfilled":true` in the trace) as a test-code defect, not an application defect. Keep that rule if you edit its classification step.

## Planned layout (future stages; do not create yet)

```
src/agent/   investigation agent (reads the artifact contract above)
```

## Workflow rules

- Small, focused commits. Ask before committing. Never push without explicit approval.
- Never commit artifacts (`artifacts/`, `test-results/`, `playwright-report/`).
- No proprietary or company code. This project will be public.
- Windows dev environment: run commands from the folder's exact on-disk path casing (see the README troubleshooting section).
