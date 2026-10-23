import { homedir } from 'node:os';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CliArgs } from '../agent/args.ts';
import { buildQueryOptions, MCP_DETAILS, MCP_LIST, MCP_SERVER, MCP_TRACE, BUILTIN_TOOLS, TRACE_SUMMARY_FLAG } from '../agent/config.ts';
import type { QueryFn } from '../agent/run.ts';
import { listScenarioIds } from './scenarios.ts';
import { loadGroundTruth } from './truth.ts';
import { CONFIG_FILES, isInside } from './workspace.ts';
import type { LeakMarkers, Workspace } from './workspace.ts';

// Evaluation session isolation. Two parts, and neither is a sandbox:
// - Mitigation: point the unchanged production session (runInvestigation + buildQueryOptions) at a
//   workspace, and only ADD deny rules. Read deny rules cover Read/Grep/Glob; nothing stops Bash
//   (`ls`, the only allowed command since Stage 3.6) from taking an absolute path elsewhere on the machine.
// - Detection: audit the raw transcript afterwards for canaries, ground-truth references and tool
//   paths outside the workspace. A clean audit means nothing was SEEN, not that nothing leaked.

export const MCP_ENTRY = ['src', 'mcp', 'main.ts'] as const;
const REPO_ROOT_ENV = 'TEST_DETECTIVE_REPO_ROOT';

export type IsolationContext = {
  repoRoot: string;
  workspace: Workspace;
};

/** Distinctive strings from eval-only files. Any of them in a workspace or transcript is a leak. */
export const EVAL_ONLY_STRINGS = [
  'TDCANARY-',
  'expectObservation',
  'profileApi',
  'acceptableAlternatives',
  'requiredEvidence',
  'forbiddenClaims',
  'failureType',
  'reviewableAlternatives',
  'unavailableEvidence',
  'generationConfigSha256',
  'truth.json',
  'generation.json',
];

/** Every scenario's canary plus EVAL_ONLY_STRINGS. Reads ground truth, so the generator never calls this. */
export async function leakMarkers(scenariosRoot?: string): Promise<LeakMarkers> {
  const ids = await listScenarioIds(scenariosRoot);
  const canaries = await Promise.all(ids.map(async (id) => (await loadGroundTruth(id, scenariosRoot)).canary));
  return { canaries, strings: EVAL_ONLY_STRINGS };
}

// ---------------------------------------------------------------------------
// Session options

/** A permission-rule path for an absolute filesystem path: `//c/GIT/repo` on Windows, `//home/x` on POSIX. */
export function rulePath(absolute: string): string {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (win) return `//${win[1]!.toLowerCase()}/${win[2]!.replaceAll('\\', '/')}`.replace(/\/+$/, '');
  return `/${absolute.replace(/\/+$/, '')}`;
}

/** Read deny rules for the protected roots (the repo, ~/.claude). Read rules also apply to Grep and Glob. */
export function evalDenyRules(protectedRoots: string[]): string[] {
  const rules = protectedRoots.map((root) => `Read(${rulePath(path.resolve(root))}/**)`);
  const claudeHome = path.join(homedir(), '.claude');
  if (protectedRoots.some((r) => path.resolve(r) === claudeHome)) rules.push('Read(~/.claude/**)');
  return rules;
}

/**
 * Turns the options production builds for `repoRoot = workspace` into the evaluation options.
 * Changes exactly two things and refuses anything that doesn't look like production output:
 * - the MCP server runs the repo's unchanged src/mcp/main.ts, with TEST_DETECTIVE_REPO_ROOT = workspace;
 * - settings.permissions.deny gains Read rules for the protected roots.
 */
export function adaptOptions(options: Options, context: IsolationContext): Options {
  const { workspace, repoRoot } = context;
  if (options.cwd !== workspace.root) throw new Error(`Expected cwd ${workspace.root}, got ${options.cwd}.`);
  if (options.strictMcpConfig !== true) throw new Error('strictMcpConfig must be true, or other MCP servers could load.');
  const servers = options.mcpServers ?? {};
  const names = Object.keys(servers);
  if (names.length !== 1 || names[0] !== MCP_SERVER) throw new Error(`Expected only the ${MCP_SERVER} MCP server, got ${names.join(', ') || 'none'}.`);
  const server = servers[MCP_SERVER]!;
  // Production passes the trace-summary opt-in (Stage 3.3); the evaluation keeps it, so both sessions see the same tools.
  const expectedArgs = [path.join(workspace.root, ...MCP_ENTRY), TRACE_SUMMARY_FLAG];
  if (!('command' in server) || (server.type !== undefined && server.type !== 'stdio') || JSON.stringify(server.args) !== JSON.stringify(expectedArgs) || server.env) {
    throw new Error(`Unexpected ${MCP_SERVER} server config; production config.ts may have changed.`);
  }
  const settings = options.settings;
  if (typeof settings !== 'object' || settings === null) throw new Error('Expected flag settings as an object.');
  const deny = settings.permissions?.deny ?? [];
  return {
    ...options,
    mcpServers: {
      [MCP_SERVER]: { type: 'stdio', command: server.command, args: [path.join(repoRoot, ...MCP_ENTRY), TRACE_SUMMARY_FLAG], env: { [REPO_ROOT_ENV]: workspace.root } },
    },
    settings: { ...settings, permissions: { ...settings.permissions, deny: [...deny, ...evalDenyRules(workspace.protectedRoots)] } },
  };
}

/** The options a normal `npm run investigate` would use, and the evaluation options for the same args. */
export function sessionOptions(args: CliArgs, context: IsolationContext, env: Record<string, string | undefined>): { baseline: Options; evaluation: Options } {
  return {
    baseline: buildQueryOptions(args, context.repoRoot, new AbortController(), env),
    evaluation: adaptOptions(buildQueryOptions(args, context.workspace.root, new AbortController(), env), context),
  };
}

/** Wraps the SDK query: adapts options and records every message. Production code is untouched. */
export function evalQuery(inner: QueryFn, context: IsolationContext, record: (message: SDKMessage) => void): QueryFn {
  return ({ prompt, options }) => {
    const handle = inner({ prompt, options: adaptOptions(options, context) });
    return {
      initializationResult: () => handle.initializationResult(),
      close: () => handle.close(),
      async *[Symbol.asyncIterator]() {
        for await (const message of handle) {
          record(message);
          yield message;
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Recorded configuration differences

export type OptionDifference = { path: string; baseline: unknown; evaluation: unknown };
export type ConfigDifferences = {
  baseline: string;
  options: OptionDifference[];
  environment: { id: string; baseline: string; evaluation: string }[];
};

/**
 * Structural diff of two option objects. abortController is skipped (always a new instance).
 * For `env` only variable NAMES are reported, never values (they may hold credentials).
 */
export function diffOptions(baseline: Options, evaluation: Options): OptionDifference[] {
  const out: OptionDifference[] = [];
  const walk = (a: unknown, b: unknown, at: string) => {
    if (at === 'abortController') return;
    if (at === 'env') {
      const ea = (a ?? {}) as Record<string, unknown>;
      const eb = (b ?? {}) as Record<string, unknown>;
      const changed = [...new Set([...Object.keys(ea), ...Object.keys(eb)])].filter((k) => ea[k] !== eb[k]).sort();
      if (changed.length > 0) out.push({ path: 'env', baseline: `${Object.keys(ea).length} variables`, evaluation: `changed: ${changed.join(', ')}` });
      return;
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(a[key], b[key], at ? `${at}.${key}` : key);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: at, baseline: a, evaluation: b });
  };
  walk(baseline, evaluation, '');
  return out;
}

/** Everything that differs from a normal `npm run investigate`, for the run metadata. */
export function describeDifferences(args: CliArgs, context: IsolationContext, env: Record<string, string | undefined>): ConfigDifferences {
  const { baseline, evaluation } = sessionOptions(args, context, env);
  const { workspace } = context;
  const payloadFiles = workspace.files.length - workspace.configFiles.length;
  return {
    baseline: 'npm run investigate: runInvestigation with repoRoot = the repo, real SDK query',
    options: diffOptions(baseline, evaluation),
    environment: [
      { id: 'cwd-contents', baseline: 'the full repo working tree', evaluation: `fresh workspace: ${payloadFiles} snapshot files + ${CONFIG_FILES.join(', ')}` },
      { id: 'claude-md', baseline: 'repo CLAUDE.md loaded as project instructions', evaluation: 'no CLAUDE.md in the workspace or its ancestors (audited)' },
      ...workspace.configFiles.map((f) => ({ id: f.path, baseline: 'repo file', evaluation: `byte copy, sha256 ${f.sha256}` })),
      { id: 'report', baseline: 'repo artifacts/results.json (whatever the last npm test wrote)', evaluation: `snapshot report, fingerprint ${workspace.reportFingerprint}` },
      { id: 'mcp-server', baseline: 'repo src/mcp/main.ts, repo root from its file location', evaluation: `same file, repo root from ${REPO_ROOT_ENV}` },
      { id: 'git', baseline: 'cwd is a git work tree (git commands denied)', evaluation: 'cwd is not a git work tree (git commands still denied)' },
      { id: 'working-tree-check', baseline: 'main.ts compares git status before/after', evaluation: 'workspace integrity check (hash, size, mtime) before/after' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Transcript audit (detection only)

/** `toolUseId` links a finding to its tool call, so a scorer can tell an attempt from a successful access. */
export type Finding = { kind: string; tool: string | null; toolUseId: string | null; detail: string };
/**
 * What the audit needs from a workspace. A recorded run no longer has the directory, only these facts.
 * `outputFormat`: the session was recorded as running with an output schema (preflight
 * outputFormatSha256). Without it, a StructuredOutput call is an unexpected tool.
 */
export type AuditContext = { workspace: Pick<Workspace, 'root' | 'protectedRoots'>; outputFormat?: boolean };
/** `expected`: recognized SDK-internal tool calls (informational, never a warning). */
export type TranscriptAudit = { leaked: boolean; leaks: Finding[]; warnings: Finding[]; expected: Finding[]; toolCallsAudited: number };

const ALLOWED_TOOLS = new Set([...BUILTIN_TOOLS, MCP_LIST, MCP_DETAILS, MCP_TRACE]);

/**
 * The tool Claude Code adds for `outputFormat: json_schema` (config.ts sets it). It is not in
 * `tools`; the session announces it in its init message. The final report arrives as its input,
 * and an input that fails validation comes back as an error result the model retries (SDK
 * 0.3.302: `error_max_structured_output_retries` ends a session that never gets it right).
 */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * Scans a recorded session. Leaks: a canary or eval-only string anywhere in the transcript, or a
 * tool input touching a protected root. Warnings: tool paths outside the workspace, shell
 * expansions the audit can't resolve (`unresolved-path`) or can resolve only if an earlier `&&`
 * step succeeded (`conditional-expansion`), unexpected tools, a wrong session cwd.
 * Paths are extracted heuristically, so a clean result is not proof of isolation.
 *
 * A StructuredOutput call is expected only if the session ran with an output format, its init
 * announced the tool, and the call is top-level. Its input still gets the leak checks.
 */
export function auditTranscript(messages: SDKMessage[], context: AuditContext, markers: LeakMarkers): TranscriptAudit {
  const leaks: Finding[] = [];
  const warnings: Finding[] = [];
  const expected: Finding[] = [];
  const { workspace } = context;
  let toolCallsAudited = 0;
  let announced = new Set<string>();

  for (const message of messages) {
    const text = JSON.stringify(message);
    for (const canary of markers.canaries) if (text.includes(canary)) leaks.push({ kind: 'canary', tool: null, toolUseId: null, detail: `canary found in a ${message.type} message` });

    if (message.type === 'system' && message.subtype === 'init') {
      announced = new Set(message.tools);
      if (!samePath(message.cwd, workspace.root)) warnings.push({ kind: 'cwd', tool: null, toolUseId: null, detail: `session cwd ${message.cwd} is not the workspace` });
    }
    if (message.type !== 'assistant') continue;
    for (const block of message.message.content) {
      if (block.type !== 'tool_use' && block.type !== 'mcp_tool_use') continue;
      toolCallsAudited++;
      const tool = block.name;
      const id = block.id;
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (tool === STRUCTURED_OUTPUT_TOOL) {
        const problem = structuredOutputProblem(context, announced, message.parent_tool_use_id);
        if (problem) warnings.push({ kind: 'unexpected-tool', tool, toolUseId: id, detail: problem });
        else expected.push({ kind: 'structured-output', tool, toolUseId: id, detail: 'SDK structured-output tool (outputFormat), announced at init' });
      } else if (!ALLOWED_TOOLS.has(tool)) {
        warnings.push({ kind: 'unexpected-tool', tool, toolUseId: id, detail: 'tool is not in the evaluation tool set' });
      }
      const inputText = JSON.stringify(input);
      for (const s of markers.strings) if (inputText.includes(s)) leaks.push({ kind: 'eval-reference', tool, toolUseId: id, detail: `tool input mentions ${JSON.stringify(s)}` });
      const candidates = pathsOf(tool, input);
      if (tool === 'Bash' && typeof input.command === 'string') candidates.push(...bashCandidates(input.command, tool, id, warnings));
      for (const candidate of candidates) classify(candidate, tool, id, context, leaks, warnings);
    }
  }
  return { leaked: leaks.length > 0, leaks, warnings, expected, toolCallsAudited };
}

function structuredOutputProblem(context: AuditContext, announced: Set<string>, parentToolUseId: string | null): string | null {
  if (context.outputFormat !== true) return 'StructuredOutput called, but the session is not recorded as running with an output format';
  if (!announced.has(STRUCTURED_OUTPUT_TOOL)) return 'StructuredOutput called, but the session init did not announce it';
  if (parentToolUseId !== null) return 'StructuredOutput called inside a subagent, not by the session itself';
  return null;
}

/** Path fields of a tool input (Bash commands go through `bashCandidates`). */
export function pathsOf(tool: string, input: Record<string, unknown>): string[] {
  const fields = ['file_path', 'path', 'notebook_path'].map((k) => input[k]).filter((v): v is string => typeof v === 'string');
  if (tool === 'Glob' && typeof input.pattern === 'string') fields.push(input.pattern);
  return fields;
}

/**
 * Path-like words of a Bash command. A word whose `$NAME`/`${NAME}` references all resolve through
 * `shellAssignments` is audited as the substituted literal, so it is checked exactly as if the value
 * had been typed there; any other expansion is left as is and reported as unresolved. A
 * conditional assignment adds a `conditional-expansion` warning, because the inherited value it
 * falls back to is unknown.
 */
function bashCandidates(command: string, tool: string, toolUseId: string, warnings: Finding[]): string[] {
  const assignments = shellAssignments(command);
  const out: string[] = [];
  shellWords(command).forEach((word, index) => {
    if (word.op || !looksLikePath(word.text)) return;
    const conditional = new Set<string>();
    let resolved = true;
    const text = word.text.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (ref, braced: string | undefined, plain: string | undefined) => {
      const name = (braced ?? plain)!;
      const a = assignments.get(name);
      if (!a || index <= a.index) {
        resolved = false;
        return ref;
      }
      if (a.conditional) conditional.add(name);
      return a.value;
    });
    if (!resolved) {
      out.push(word.text);
      return;
    }
    for (const name of conditional) {
      warnings.push({
        kind: 'conditional-expansion',
        tool,
        toolUseId,
        detail: `$${name} is assigned only after && (${truncate(`${name}=${assignments.get(name)!.value}`)}); if an earlier step failed it expands to an inherited value`,
      });
    }
    out.push(text);
  });
  return out;
}

function classify(candidate: string, tool: string, toolUseId: string, context: AuditContext, leaks: Finding[], warnings: Finding[]): void {
  // `~user` and variables can't be resolved here; `~` and `~/...` are the current user's home.
  if (/\$|%[A-Za-z_]+%|`/.test(candidate) || /^~[^\\/]/.test(candidate)) {
    warnings.push({ kind: 'unresolved-path', tool, toolUseId, detail: `cannot resolve ${truncate(candidate)} (shell expansion)` });
    return;
  }
  const expanded = /^~([\\/]|$)/.test(candidate) ? path.join(homedir(), candidate.slice(1)) : candidate;
  const resolved = resolveFrom(context.workspace.root, globPrefix(expanded));
  const protectedRoot = context.workspace.protectedRoots.find((root) => isInside(path.resolve(root), resolved));
  if (protectedRoot) {
    leaks.push({ kind: 'protected-path', tool, toolUseId, detail: `${truncate(candidate)} is inside protected path ${protectedRoot}` });
  } else if (!isInside(context.workspace.root, resolved)) {
    warnings.push({ kind: 'outside-workspace', tool, toolUseId, detail: `${truncate(candidate)} resolves outside the workspace` });
  }
}

/** Splits a shell command into words, honoring single and double quotes; operators split words. */
export function shellTokens(command: string): string[] {
  return shellWords(command)
    .filter((w) => !w.op)
    .map((w) => w.text);
}

type ShellWord = { text: string; op: boolean };

/**
 * Words (quotes removed) and the operators between them: `;`, `&&`, `||`, `|`, `&`, a newline,
 * `(`, `)`, `<`, `>`. Other whitespace only separates words. A tokenizer, not a shell parser.
 */
function shellWords(command: string): ShellWord[] {
  const words: ShellWord[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const flush = () => {
    if (has || current) words.push({ text: current, op: false });
    current = '';
    has = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/[|;&<>()\n]/.test(ch)) {
      flush();
      const pair = command.slice(i, i + 2);
      if (pair === '&&' || pair === '||') {
        words.push({ text: pair, op: true });
        i++;
      } else {
        words.push({ text: ch, op: true });
      }
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      current += ch;
      has = true;
    }
  }
  flush();
  return words;
}

/**
 * Variables a Bash command assigns itself, recognized narrowly so that `$NAME` can be audited as
 * the literal it stands for. NAME qualifies only if:
 * - `NAME=value` is a whole statement at the top level: preceded by the start of the command, `;`,
 *   a newline or `&&`, followed by the end, `;`, a newline, `&&` or `||` (not a pipeline, a
 *   background job, a subshell, a `{ }` group, `if`/`for` bodies or a `VAR=x cmd` prefix);
 * - the value is a plain literal: no `$`, backtick, leading `~`, glob character or whitespace, so
 *   an unquoted `$NAME` neither expands further nor splits;
 * - the command mentions NAME nowhere else except as plain `$NAME` or `${NAME}` (so no second
 *   assignment, `read`, `for`, `export`, `unset`, `${NAME:-x}`, `NAME+=`, `declare -n`, ...);
 * - the command has no backtick and no `eval`, `source` or `.` word, which could assign it unseen.
 * References before the assignment are not resolved (they see the inherited value).
 * `conditional`: the statement follows `&&`, so it is skipped if an earlier step failed, and the
 * reference then expands to whatever the session inherited. Shell functions from the user's
 * environment, or a readonly NAME, could still defeat the assignment; the audit can't see those.
 */
export function shellAssignments(command: string): Map<string, { value: string; conditional: boolean; index: number }> {
  const found = new Map<string, { value: string; conditional: boolean; index: number }>();
  if (command.includes('`')) return found;
  const words = shellWords(command);
  if (words.some((w) => !w.op && ['eval', 'source', '.'].includes(w.text))) return found;
  let depth = 0;
  words.forEach((word, index) => {
    if (word.op) {
      if (word.text === '(') depth++;
      if (word.text === ')') depth--;
      return;
    }
    const match = /^([A-Za-z_]\w*)=(.*)$/s.exec(word.text);
    if (!match || depth !== 0) return;
    const [, name, value] = match as unknown as [string, string, string];
    const before = words[index - 1];
    const after = words[index + 1];
    if (before && !(before.op && [';', '\n', '&&'].includes(before.text))) return;
    if (after && !(after.op && [';', '\n', '&&', '||'].includes(after.text))) return;
    if (value === '' || /[$`*?[{\s]/.test(value) || value.startsWith('~')) return;
    if (!onlyPlainMentions(command, name)) return;
    found.set(name, { value, conditional: before?.text === '&&', index });
  });
  return found;
}

/** Every mention of NAME in the raw command is the single `NAME=` or a plain `$NAME`/`${NAME}`. */
function onlyPlainMentions(command: string, name: string): boolean {
  let assignments = 0;
  for (const m of command.matchAll(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g'))) {
    const at = m.index;
    const end = at + name.length;
    if (command[at - 1] === '$') continue;
    if (command.slice(at - 2, at) === '${' && command[end] === '}') continue;
    if (command[end] === '=' && command[at - 1] !== '$') {
      assignments++;
      continue;
    }
    return false;
  }
  return assignments === 1;
}

/** Absolute paths, home or env references, and relative paths that climb with `..`. */
function looksLikePath(token: string): boolean {
  if (token.startsWith('-')) return false;
  return /^[A-Za-z]:[\\/]/.test(token) || token.startsWith('/') || token.startsWith('\\\\') || token.startsWith('~') || /\$\{?[A-Za-z_]|%[A-Za-z_]+%/.test(token) || /(^|[\\/])\.\.([\\/]|$)/.test(token);
}

/** Git-Bash style /c/Users/... is the Windows path C:\Users\... */
export function resolveFrom(root: string, p: string): string {
  if (process.platform === 'win32') {
    const msys = /^\/([A-Za-z])(\/.*)?$/.exec(p);
    if (msys) return path.resolve(`${msys[1]}:${msys[2] ?? '/'}`);
  }
  return path.resolve(root, p);
}

/** The directory part of a glob before its first wildcard. */
function globPrefix(p: string): string {
  const index = p.search(/[*?[{]/);
  if (index === -1) return p;
  const head = p.slice(0, index);
  return head.slice(0, Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\')) + 1) || '.';
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}
