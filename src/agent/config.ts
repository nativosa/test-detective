import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { CliArgs } from './args.ts';
import { modelReportJsonSchema } from './result.ts';

// Builds the SDK options. Pure: no I/O, so tests can assert the exact permission surface.
// These settings are runtime restrictions enforced by Claude Code, not an OS sandbox.

export const SKILL_NAME = 'investigate-failure';
export const MCP_SERVER = 'test-detective';
export const MCP_LIST = `mcp__${MCP_SERVER}__list_test_failures`;
export const MCP_DETAILS = `mcp__${MCP_SERVER}__get_failure_details`;

export const SKILL_TOOL = 'Skill';

/**
 * Built-in tools that exist in the session at all. Everything else is absent.
 * `tools` is the CLI's --tools list, so the Skill tool must be named here: the `skills` option
 * below only filters the skill listing and adds a `Skill(investigate-failure)` allow rule.
 * Without it the model never sees the Skill tool or the listing (observed with 2.1.302).
 */
export const BUILTIN_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', SKILL_TOOL];

/** Auto-approved calls. With permissionMode dontAsk, anything not listed is denied. */
export const ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  MCP_LIST,
  MCP_DETAILS,
  // The investigate-failure Skill's read-only commands, nothing broader.
  'Bash(unzip -l *)',
  'Bash(unzip -p *)',
  'Bash(grep *)',
  'Bash(head *)',
  'Bash(ls *)',
];

/** Removed from the model's context even if something else would enable them. */
export const DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent'];

/** Deny rules apply in every permission mode. Bash specifiers go here, not in disallowedTools. */
export const DENY_RULES = [
  'Bash(git *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(node *)',
  'Bash(playwright *)',
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(rm *)',
];

const SYSTEM_APPEND = `You are running inside the test-detective CLI, non-interactively. Nobody can answer questions.
Git commands are unavailable during this investigation (they are denied); do not attempt them, alone or chained.
Follow the investigate-failure skill exactly, then return its report ONLY as the structured output:
- status: "investigated" if you investigated at least one failed or flaky test; "no_failures" if list_test_failures returned none;
  "no_match" if failures exist but none match the filter; "mcp_unavailable" if the test-detective MCP tools are missing, denied or
  unreachable; "report_error" if list_test_failures returned an error result (put its code and hint in message).
- message: one or two sentences summarizing the outcome.
- investigations: one entry per investigated test. testId must be exactly the testId you passed to get_failure_details.
  Map the skill's report sections: "Failure summary" -> failureSummary, "Evidence inspected" rows -> evidence,
  "Root-cause analysis" -> classification plus analysis points (cite evidence refs), "Confidence" -> confidence,
  "Proposed fix" -> proposedFix, "Verification steps" -> verificationSteps.
Do not restate the test title, file, line, project, outcome or attempts: the CLI reads those from the MCP results itself.`;

/**
 * Variables a parent Claude Code session sets in its shells (session identity, messaging socket
 * and token, entrypoint). Inherited by an SDK subprocess they could tie it to that session, so they
 * are removed. Everything else, including CLAUDE_CODE_* configuration variables, passes through.
 */
export const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
];

export function subprocessEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) if (!INHERITED_SESSION_VARS.includes(name)) out[name] = value;
  return { ...out, CLAUDE_AGENT_SDK_CLIENT_APP: 'test-detective/0.1.0' };
}

export function buildPrompt(filter: string | null): string {
  const scope = filter === null ? 'with no arguments (investigate every failure)' : `with the arguments ${JSON.stringify(filter)}`;
  return `Use the Skill tool to invoke the ${SKILL_NAME} skill ${scope}, and follow it.`;
}

export function buildQueryOptions(args: CliArgs, repoRoot: string, abortController: AbortController, env: Record<string, string | undefined>): Options {
  return {
    cwd: repoRoot,
    abortController,
    // Project settings only: CLAUDE.md, .claude/settings.json and .claude/skills. Not the user's
    // ~/.claude settings and not .claude/settings.local.json.
    settingSources: ['project'],
    // Flag-layer settings (highest user-controlled priority). Auto memory is personal and lives
    // outside the repo; skill shell injections would run outside the permission rules below.
    settings: {
      autoMemoryEnabled: false,
      disableSkillShellExecution: true,
      permissions: { deny: DENY_RULES },
    },
    // Only our server: ignores .mcp.json, user MCP config and claude.ai connectors.
    strictMcpConfig: true,
    mcpServers: {
      [MCP_SERVER]: { type: 'stdio', command: process.execPath, args: [path.join(repoRoot, 'src', 'mcp', 'main.ts')] },
    },
    tools: BUILTIN_TOOLS,
    skills: [SKILL_NAME],
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    permissionMode: 'dontAsk',
    persistSession: false,
    maxTurns: args.maxTurns,
    ...(args.maxBudgetUsd !== null ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
    ...(args.model !== null ? { model: args.model } : {}),
    outputFormat: { type: 'json_schema', schema: modelReportJsonSchema() },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
    env: subprocessEnv(env),
  };
}
