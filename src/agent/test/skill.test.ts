import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { ALLOWED_TOOLS, SKILL_NAME } from '../config.ts';

// The Skill must stay runnable under the CLI's dontAsk allowlist: a Bash call is denied unless every
// command in it matches an allow rule. Since Stage 3.6 traces are read only through get_trace_summary;
// the raw archive commands are gone. These are text checks on SKILL.md, not model behavior.

const skill = await readFile(new URL(`../../../.claude/skills/${SKILL_NAME}/SKILL.md`, import.meta.url), 'utf8');

const section = (from: string, to: string) => {
  const start = skill.indexOf(from);
  const end = skill.indexOf(to);
  assert.ok(start > 0 && end > start, `${from} not found`);
  return skill.slice(start, end);
};
const evidenceStep = section('## Step 3', '## Step 4');
const traceStep = section('4. **Trace', '## Step 4');

/** Prefixes of the CLI's `Bash(<prefix> *)` allow rules. */
const allowedPrefixes = ALLOWED_TOOLS.flatMap((t) => /^Bash\((.+) \*\)$/.exec(t)?.slice(1) ?? []);

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

/** Why a command would not be auto-approved: shell syntax outside quotes, or a command with no allow rule. */
const problems = (command: string) => {
  const found: string[] = [];
  const unquoted = command.replace(/<[a-z.]+>/g, 'x').replace(/'[^']*'/g, "''");
  if (/[;&$`<>]|(^|\s)\w+=/.test(unquoted)) found.push('shell syntax outside quotes');
  for (const segment of segments(command)) {
    if (!allowedPrefixes.some((p) => segment.startsWith(`${p} `))) found.push(`not allowlisted: "${segment}"`);
  }
  return found;
};

/** The raw trace commands the Skill documented until Stage 3.6 (Skill bb6a78c5). */
const RAW_TRACE_COMMANDS = [
  'unzip -l <trace.zip>',
  `unzip -p <trace.zip> '*.trace' | grep -E '"error"|"console"|pageError' | head -n 30`,
  `unzip -p <trace.zip> '*.network' | grep -E '"status":\\s*[45][0-9]{2}|"failure"' | head -n 20`,
  `unzip -p <trace.zip> '*.network' | grep -oE '"url":"[^"]*"|"_wasFulfilled":true' | head -n 40`,
  `grep -a '_wasFulfilled' <trace.zip>`,
  'head -c 4096 <trace.zip>',
];

describe('investigate-failure Skill: permission surface', () => {
  test('the Skill frontmatter grants exactly the CLI\'s Bash patterns, which are only ls', () => {
    const line = /^allowed-tools: (.+)$/m.exec(skill)?.[1] ?? '';
    const bash = line.split(', ').filter((t) => t.startsWith('Bash('));
    assert.deepEqual(bash, ALLOWED_TOOLS.filter((t) => t.startsWith('Bash(')));
    assert.deepEqual(bash, ['Bash(ls *)']);
  });

  test('the one documented shell command (ls -l for modification times) is allowlisted', () => {
    const documented = [...evidenceStep.matchAll(/`((?:ls|unzip|grep|head|cat|tail) [^`]+)`/g)].map((m) => m[1]!);
    assert.deepEqual(documented, ['ls -l --time-style=full-iso <file>']);
    assert.deepEqual(problems(documented[0]!), []);
  });

  test('raw trace archive commands are no longer approved', () => {
    for (const command of RAW_TRACE_COMMANDS) assert.notDeepEqual(problems(command), [], command);
  });

  test('the checker still rejects the compound command denied in the S07 live run', () => {
    const denied = `T=test-results/x/trace.zip; unzip -l $T; echo ---; unzip -p $T '*.network' | grep -oE '"url":"[^"]*"' | head -n 40; echo ---; unzip -p $T '*.trace' | grep -E '"console"|pageError' | head -n 20 | cut -c1-400`;
    const found = problems(denied);
    assert.ok(found.includes('shell syntax outside quotes'), found.join('; '));
    assert.ok(found.some((f) => f.includes('cut -c1-400')), found.join('; '));
  });
});

describe('investigate-failure Skill: trace evidence', () => {
  test('get_trace_summary is the only way into a trace; no archive commands remain', () => {
    assert.doesNotMatch(skill, /unzip|zipinfo|Fallback trace commands/);
    assert.match(traceStep, /\*\*`get_trace_summary` is the only way into a trace\.\*\* Never open, list or search a trace archive/);
    assert.match(traceStep, /never retry a denied call in another form/);
  });

  test('unsupported, unavailable, denied and failed summaries make the trace present but not inspectable', () => {
    assert.match(traceStep, /- `unsupported`: .*present but not inspectable.*`trace\.reasons`/);
    assert.match(traceStep, /If the tool is unavailable or denied, or the call fails, the trace is present but not inspectable/);
    assert.match(traceStep, /- `missing`: .*⚠️ not available \(missing\)/);
  });

  test('keeps evidence reporting honest when the trace was not inspected', () => {
    assert.match(traceStep, /Never say that a trace you didn't inspect that way contains, or doesn't contain/);
    assert.match(traceStep, /\*\*Missing\*\*: .*`exists` is `false`.*the summary was `missing`/);
    assert.match(traceStep, /\*\*Present but not inspectable\*\*: .*unavailable, denied or failed, or returned `unsupported`.*with the reason.*lower your confidence: don't rate it \*\*High\*\*/s);
    assert.match(skill, /Cite a trace fact only if a successful `get_trace_summary` result \(status `ok` or `partial`\) returned it\./);
  });
});

describe('investigate-failure Skill: report clarity and classification', () => {
  test('Observed holds only retrieved facts; causes go in Inference, unknowns in Uncertain', () => {
    assert.match(skill, /\*\*Observed\*\*: only facts a tool result or artifact directly returned.*No cause/);
    assert.match(skill, /\*\*Inference\*\*: the causal interpretation/);
    assert.match(skill, /\*\*Uncertain\*\*: what the evidence leaves open/);
    assert.match(skill, /write two points: the fact as Observed, its meaning as Inference/);
    assert.match(skill, /conclusions go in Inference points, never in Observed ones/);
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
    assert.match(traceStep, /`fulfilled` means a route handler answered the request\. It does \*\*not\*\* mean the test invented the response/);
  });
});
