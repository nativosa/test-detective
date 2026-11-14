import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { credentialFile, LAUNCHER_SCRIPT, NAME_PATTERN, runtimeDir } from './config.ts';
import type { SandboxConfig } from './config.ts';

// R4b Step 1D: the host side of the restricted process launcher. It builds a validated request for
// scripts/eval-sandbox/launch-as.ps1, which starts runtime/bin/stage2.mjs as the evaluation account
// (CreateProcessWithLogonW) inside a kill-on-close job object. The password never passes through
// here: launch-as.ps1 loads the DPAPI-protected credential itself. stage2 reports its identity on
// stderr before starting anything, and the launch is rejected (and killed) unless that identity is
// the evaluation account and not the developer. Not wired into the live evaluation yet.

export const IDENTITY_PREFIX = 'TD-SANDBOX-IDENTITY ';
export const RUNTIME_SCRIPTS = ['probe.mjs', 'teardown.mjs'] as const;
export const ENV_ALLOWED = /^(CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_AGENT_SDK_[A-Z0-9_]+|DEBUG_CLAUDE_AGENT_SDK|MCP_TIMEOUT|MCP_TOOL_TIMEOUT)$/;
export const ENV_REFUSED = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_|VERTEX_)/;
const MAX_HEADER = 24_000;

/** Facts about the host the launch depends on (from the environment in production, fixed in tests). */
export type LaunchHost = {
  computer: string;
  localAppData: string;
  programFiles: string;
  systemRoot: string;
  developer: { username: string; home: string; sid: string | null };
};

export type Stage2Target = { kind: 'claude'; args: string[] } | { kind: 'script'; script: (typeof RUNTIME_SCRIPTS)[number]; args: string[] };
export type Stage2Header = { target: Stage2Target; env: Record<string, string>; expect: { account: string } };

export type LaunchRequest = { account: string; node: string; credentialFile: string; runtime: string; cwd: string; header: string };
export type LaunchCommand = { command: string; args: string[]; env: Record<string, string>; request: LaunchRequest };

export function hostFromEnv(env: NodeJS.ProcessEnv, developer: LaunchHost['developer']): LaunchHost {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set.`);
    return value;
  };
  return { computer: need('COMPUTERNAME'), localAppData: need('LOCALAPPDATA'), programFiles: need('ProgramFiles'), systemRoot: need('SystemRoot'), developer };
}

const isInsideWin = (parent: string, child: string) => {
  const rel = path.win32.relative(path.win32.resolve(parent), path.win32.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
};

/** Refuses anything stage2 would refuse, before a process starts; returns the header as base64. */
export function encodeHeader(header: Stage2Header): string {
  const { target } = header;
  if (target.kind !== 'claude' && !(target.kind === 'script' && (RUNTIME_SCRIPTS as readonly string[]).includes(target.script))) throw new Error('Unknown stage2 target.');
  if (!target.args.every((a) => typeof a === 'string' && !a.includes('\0'))) throw new Error('Target arguments must be strings without NUL.');
  for (const [name, value] of Object.entries(header.env)) {
    if (!ENV_ALLOWED.test(name) || ENV_REFUSED.test(name)) throw new Error(`Environment variable ${name} may not be passed to the evaluation account.`);
    if (value.includes('\0')) throw new Error(`Environment variable ${name} contains NUL.`);
  }
  const encoded = Buffer.from(JSON.stringify(header), 'utf8').toString('base64');
  if (encoded.length > MAX_HEADER) throw new Error('The stage2 header is too long.');
  return encoded;
}

/**
 * The exact process the host starts: Windows PowerShell running launch-as.ps1, with a minimal
 * environment (no credentials, no inherited Claude or API variables) plus TD_LAUNCH_REQUEST.
 */
export function buildLaunch(config: SandboxConfig, host: LaunchHost, header: Stage2Header, cwd: string): LaunchCommand {
  if (!NAME_PATTERN.test(config.account)) throw new Error(`Invalid account name ${config.account}.`);
  if (config.account.toLowerCase() === host.developer.username.toLowerCase()) throw new Error('The evaluation account cannot be the developer account.');
  if (header.expect.account !== config.account) throw new Error('The header must expect the configured account.');
  if (!path.win32.isAbsolute(cwd) || !isInsideWin(config.root, cwd)) throw new Error(`The working directory must be inside ${config.root}.`);
  const request: LaunchRequest = {
    account: config.account,
    node: path.win32.join(host.programFiles, 'nodejs', 'node.exe'),
    credentialFile: credentialFile(host.localAppData),
    runtime: runtimeDir(config),
    cwd: path.win32.resolve(cwd),
    header: encodeHeader(header),
  };
  const powershell = path.win32.join(host.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const keep: Record<string, string> = {
    SystemRoot: host.systemRoot,
    windir: host.systemRoot,
    ProgramFiles: host.programFiles,
    LOCALAPPDATA: host.localAppData,
    COMPUTERNAME: host.computer,
    USERNAME: host.developer.username,
    USERPROFILE: host.developer.home,
    TEMP: path.win32.join(host.localAppData, 'Temp'),
    TMP: path.win32.join(host.localAppData, 'Temp'),
    PATH: [path.win32.join(host.systemRoot, 'System32'), path.win32.join(host.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
  };
  return {
    command: powershell,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER_SCRIPT],
    env: { ...keep, TD_LAUNCH_REQUEST: JSON.stringify(request) },
    request,
  };
}

export type SandboxIdentity = { username: string; domain: string | null; home: string; sid: string | null };

export function parseIdentityLine(line: string): SandboxIdentity | null {
  if (!line.startsWith(IDENTITY_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(IDENTITY_PREFIX.length)) as Partial<SandboxIdentity>;
    if (typeof value.username !== 'string' || typeof value.home !== 'string') return null;
    return { username: value.username, domain: typeof value.domain === 'string' ? value.domain : null, home: value.home, sid: typeof value.sid === 'string' ? value.sid : null };
  } catch {
    return null;
  }
}

/** Problems with a reported identity; empty means it is the evaluation account and nothing of the developer's. */
export function identityProblems(identity: SandboxIdentity, config: SandboxConfig, host: LaunchHost): string[] {
  const problems: string[] = [];
  const same = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
  if (!same(identity.username, config.account)) problems.push(`runs as ${identity.username}, expected ${config.account}`);
  if (same(identity.username, host.developer.username)) problems.push('runs as the developer');
  if (identity.domain !== null && !same(identity.domain, host.computer)) problems.push(`account domain ${identity.domain} is not this computer`);
  if (same(identity.sid, host.developer.sid)) problems.push('has the developer SID');
  if (identity.sid === null) problems.push('reported no SID');
  if (same(path.win32.resolve(identity.home), path.win32.resolve(host.developer.home))) problems.push('uses the developer profile');
  return problems;
}

/** A refused launch. `identity` is true when stage2 reported a wrong identity (a BLOCKER), false for a start failure or timeout. */
export class RestrictedLaunchError extends Error {
  readonly identity: boolean;
  constructor(message: string, identity: boolean) {
    super(`Restricted launch refused: ${message}`);
    this.identity = identity;
  }
}

export type SpawnFn =(command: string, args: string[], options: { env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean }) => ChildProcessWithoutNullStreams;

export type RestrictedProcess = {
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the verified identity; rejects (after killing the launcher) on a mismatch, a missing handshake or an early exit. */
  identity: Promise<SandboxIdentity>;
};

/**
 * Starts the launcher. The caller must await `identity` before trusting anything the process sends;
 * on any problem the launcher is killed, which closes its job object and ends the whole tree.
 * Further stderr lines go to `onStderr` (diagnostics only).
 */
export function launchRestricted(
  config: SandboxConfig,
  host: LaunchHost,
  header: Stage2Header,
  cwd: string,
  options: { spawn?: SpawnFn; handshakeTimeoutMs?: number; onStderr?: (line: string) => void } = {},
): RestrictedProcess {
  const launch = buildLaunch(config, host, header, cwd);
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const identity = new Promise<SandboxIdentity>((resolve, reject) => {
    let settled = false;
    const fail = (message: string, wrongIdentity = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new RestrictedLaunchError(message, wrongIdentity));
    };
    const timer = setTimeout(() => fail('no identity handshake in time'), options.handshakeTimeoutMs ?? 30_000);
    child.once('error', (error) => fail(`launcher could not start (${error.message})`));
    child.once('exit', (code) => fail(`launcher exited (${code}) before the handshake`));
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (settled) return options.onStderr?.(line);
      const reported = parseIdentityLine(line);
      if (!reported) return options.onStderr?.(line);
      const problems = identityProblems(reported, config, host);
      if (problems.length > 0) return fail(problems.join('; '), true);
      settled = true;
      clearTimeout(timer);
      resolve(reported);
    });
  });
  return { child, identity };
}
