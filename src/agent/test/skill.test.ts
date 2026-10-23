import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { ALLOWED_TOOLS, SKILL_NAME } from '../config.ts';

// The Skill's trace step must stay runnable under the CLI's dontAsk allowlist: a Bash call is denied
// unless every command in it matches an allow rule. These are text checks on SKILL.md, not model behavior.

const skill = await readFile(new URL(`../../../.claude/skills/${SKILL_NAME}/SKILL.md`, import.meta.url), 'utf8');

const traceStep = (() => {
  const start = skill.indexOf('4. **Trace');
  const end = skill.indexOf('## Step 4');
  assert.ok(start > 0 && end > start, 'trace step not found');
  return skill.slice(start, end);
})();

/** Prefixes of the CLI's `Bash(<prefix> *)` allow rules. */
const allowedPrefixes = ALLOWED_TOOLS.flatMap((t) => /^Bash\((.+) \*\)$/.exec(t)?.slice(1) ?? []);

/** Documented trace commands: inline code spans in the trace step that start with `unzip`. */
const documented = [...traceStep.matchAll(/`(unzip [^`]+)`/g)].map((m) => m[1]!);

/** Splits a pipeline on `|` outside single quotes. */
const segments = (command: string) => {
  const out = [''];
  let quoted = false;
  for (const ch of command) {
    if (ch === "'") quoted = !quoted;
    if (ch === '|' && !quoted) out.push('');
    else out[out.length - 1] += ch;
  }
  return out.map((s) => s.trim());
};

/** Why a trace command would not be auto-approved: shell syntax outside quotes, or a command with no allow rule. */
const problems = (command: string) => {
  const found: string[] = [];
  const unquoted = command.replaceAll('<trace.zip>', 'test-results/x/trace.zip').replace(/'[^']*'/g, "''");
  if (/[;&$`<>]|\b\w+=/.test(unquoted)) found.push('shell syntax outside quotes');
  for (const segment of segments(command)) {
    if (!allowedPrefixes.some((p) => segment.startsWith(`${p} `))) found.push(`not allowlisted: "${segment}"`);
  }
  return found;
};

describe('investigate-failure Skill: permission-safe trace inspection', () => {
  test('the Skill frontmatter grants exactly the CLI\'s Bash patterns', () => {
    const line = /^allowed-tools: (.+)$/m.exec(skill)?.[1] ?? '';
    const bash = line.split(', ').filter((t) => t.startsWith('Bash('));
    assert.deepEqual(bash, ALLOWED_TOOLS.filter((t) => t.startsWith('Bash(')));
  });

  test('every documented trace command is a plain pipeline of allowlisted commands', () => {
    assert.equal(documented.length, 5, documented.join('\n'));
    for (const command of documented) {
      assert.ok(command.startsWith('unzip -l <trace.zip>') || command.startsWith('unzip -p <trace.zip> '), command);
      assert.deepEqual(problems(command), [], command);
    }
  });

  test('the checker rejects the compound command denied in the S07 live run', () => {
    const denied = `T=test-results/x/trace.zip; unzip -l $T; echo ---; unzip -p $T '*.network' | grep -oE '"url":"[^"]*"' | head -n 40; echo ---; unzip -p $T '*.trace' | grep -E '"console"|pageError' | head -n 20 | cut -c1-400`;
    const found = problems(denied);
    assert.ok(found.includes('shell syntax outside quotes'), found.join('; '));
    assert.ok(found.some((f) => f.includes('cut -c1-400')), found.join('; '));
  });

  test('requires exact commands, one per call, and prohibits unsafe compound forms', () => {
    assert.match(traceStep, /exactly as written/);
    assert.match(traceStep, /Each command is a separate Bash call/);
    assert.match(traceStep, /denied as a whole/);
    for (const banned of ['`T=…`', '`$T`', '`;`', '`&&`', '`||`', '`echo`', '`cut`', 'redirections', 'any other command']) {
      assert.ok(traceStep.includes(banned), `does not prohibit ${banned}`);
    }
  });

  test('requires one retry with a documented command after a denial', () => {
    assert.match(traceStep, /If a trace command is denied\*\*, retry once/);
    assert.match(traceStep, /use `unzip -l <trace\.zip>`/);
    assert.match(traceStep, /Do not try other variations/);
    assert.match(traceStep, /only if that retry also fails/);
  });

  test('keeps evidence reporting honest when inspection stays blocked', () => {
    assert.match(traceStep, /Never describe trace contents you didn't obtain/);
    assert.match(traceStep, /\*\*Missing\*\*: .*`exists` is `false`/);
    assert.match(traceStep, /\*\*Present but not inspectable\*\*: .*denied or failed.*quote the denial or error.*lower your confidence/s);
  });

  test('read-only rules, evidence order and classifications are unchanged', () => {
    assert.match(skill, /^disallowed-tools: Edit, Write, NotebookEdit$/m);
    assert.match(skill, /\*\*Read-only\.\*\* Do not edit files, rerun tests/);
    assert.match(skill, /\*\*Evidence only\.\*\* Every finding must cite an artifact or MCP result you actually obtained/);
    const order = ['1. **Test source.**', '2. **error-context.md.**', '3. **Screenshot.**', '4. **Trace, through `get_trace_summary`.**'];
    const at = order.map((o) => skill.indexOf(o));
    assert.ok(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1]!)), 'evidence priority order changed');
    for (const c of ['Test-code defect', 'Application defect', 'Environment issue', 'Inconclusive']) assert.match(skill, new RegExp(`- \\*\\*${c}\\*\\*: `));
  });

  test('route markers are observations: the old "_wasFulfilled means mocked" rule is gone', () => {
    assert.doesNotMatch(skill, /Mocked responses are not application defects/);
    assert.match(skill, /\*\*A status code or route marker never classifies a failure on its own\.\*\*/);
    // The fallback grep for _wasFulfilled may stay, but only with the caveat that it can be a fetched response.
    assert.match(traceStep, /"_wasFulfilled":true.*doesn't say whether the response came from `route\.fetch\(\)`/);
  });

  test('fallback trace commands are reserved for an unavailable, failed or unsupported trace summary', () => {
    const fallback = traceStep.slice(traceStep.indexOf('**Fallback trace commands.**'));
    assert.ok(fallback.length < traceStep.length, 'fallback section not found');
    assert.equal([...fallback.matchAll(/`(unzip [^`]+)`/g)].length, documented.length, 'every trace command sits in the fallback section');
    assert.match(fallback, /only when `get_trace_summary` is unavailable, denied or failed, or returned `unsupported`/);
  });
});
