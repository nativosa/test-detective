// R4b Step 1D: second stage of the sandbox launcher. Runs AS THE EVALUATION ACCOUNT (started by
// launch-as.ps1) from the runtime copy's bin/ folder. It waits for the relay's job confirmation
// (exit 95 without it), announces its identity on stderr, refuses to continue under any other
// account, and starts one allowlisted target with inherited stdio:
//   - "claude": <runtime>/claude/claude.exe with the given arguments (wired in a later step);
//   - "script": node <runtime>/bin/{probe,teardown}.mjs with the given arguments.
// The header (argv[2]) is base64 JSON from the trusted host: { target, env, expect: { account } }.
// Only Node built-ins; nothing from the repo is imported.
import { execFileSync, spawn } from 'node:child_process';
import { readSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.dirname(BIN);
const SCRIPTS = new Set(['probe.mjs', 'teardown.mjs']);
/** Configuration variables the host may pass on; never auth or provider switches. */
const ENV_ALLOWED = /^(CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_AGENT_SDK_[A-Z0-9_]+|DEBUG_CLAUDE_AGENT_SDK|MCP_TIMEOUT|MCP_TOOL_TIMEOUT)$/;
const ENV_REFUSED = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_|VERTEX_)/;
const IDENTITY_PREFIX = 'TD-SANDBOX-IDENTITY ';

function identity() {
  let sid = null;
  try {
    const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
    const out = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    sid = /"(S-1-[0-9-]+)"/.exec(out)?.[1] ?? null;
  } catch {
    sid = null;
  }
  return { username: os.userInfo().username, domain: process.env.USERDOMAIN ?? null, home: os.homedir(), sid };
}

function fail(message, code = 90) {
  process.stderr.write(`stage2: ${message}\n`);
  process.exit(code);
}

/**
 * The launcher's relay (TdSandboxRelay.cs) writes this line on stdin only after this process is in its
 * kill-on-close job. Read byte by byte, so nothing after it is consumed: the target inherits the
 * rest of stdin untouched. Until then nothing is started (not even whoami), so no descendant can
 * exist outside the job. .NET Framework's Process.Start may write a UTF-8 BOM to the redirected stdin
 * first (when the console code page is UTF-8); it is consumed here, so the target never sees it.
 */
const JOB_CONFIRMATION = 'TD-JOB-ASSIGNED';
const BOM = [0xef, 0xbb, 0xbf];

function jobConfirmed() {
  const byte = Buffer.alloc(1);
  let line = '';
  let bom = 0;
  while (line.length <= JOB_CONFIRMATION.length) {
    let n;
    try {
      n = readSync(0, byte, 0, 1, null);
    } catch (error) {
      if (error?.code === 'EAGAIN') continue;
      return false;
    }
    if (n === 0) return false;
    if (line === '' && bom < BOM.length && byte[0] === BOM[bom]) {
      bom++;
      continue;
    }
    if (bom > 0 && bom < BOM.length) return false;
    if (byte[0] === 0x0a) return line === JOB_CONFIRMATION;
    line += String.fromCharCode(byte[0]);
  }
  return false;
}

function main() {
  if (!jobConfirmed()) fail('the launcher did not confirm the job object; starting nothing', 95);
  let header;
  try {
    header = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
  } catch {
    fail('the header is not base64 JSON');
  }
  const me = identity();
  process.stderr.write(`${IDENTITY_PREFIX}${JSON.stringify(me)}\n`);
  const expected = header?.expect?.account;
  if (typeof expected !== 'string' || me.username.toLowerCase() !== expected.toLowerCase()) fail('running under an unexpected account; refusing', 97);

  const env = { ...process.env, TD_SANDBOX_STAGE2: '1' };
  for (const [name, value] of Object.entries(header.env ?? {})) {
    if (!ENV_ALLOWED.test(name) || ENV_REFUSED.test(name) || typeof value !== 'string' || value.includes('\0')) fail(`environment variable ${name} is not allowed`);
    env[name] = value;
  }
  const target = header.target ?? {};
  const args = target.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) fail('arguments must be strings');
  let command;
  let argv;
  if (target.kind === 'claude') {
    command = path.join(RUNTIME, 'claude', 'claude.exe');
    argv = args;
  } else if (target.kind === 'script' && SCRIPTS.has(target.script)) {
    command = process.execPath;
    argv = [path.join(BIN, target.script), ...args];
  } else {
    fail('unknown target');
  }
  const child = spawn(command, argv, { stdio: 'inherit', env, cwd: process.cwd(), windowsHide: true });
  child.on('error', (error) => fail(`could not start the target: ${error.code ?? error.message}`, 92));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

main();
