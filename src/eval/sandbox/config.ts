import path from 'node:path';
import { fileURLToPath } from 'node:url';

// R4b Step 1D: configuration of the OS-enforced investigator sandbox (a dedicated standard Windows
// account whose file access Windows itself checks). Pure: nothing here touches the system.
// Nothing in the live evaluation path uses this yet.

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts', 'eval-sandbox');
/** Scripts that run as the evaluation account; staged into the runtime's bin/ (runtime.ts). */
export const RUNTIME_SCRIPTS_DIR = path.join(SCRIPTS_DIR, 'runtime');
export const LAUNCHER_SCRIPT = path.join(SCRIPTS_DIR, 'launch-as.ps1');
export const SETUP_SCRIPT = path.join(SCRIPTS_DIR, 'setup.ps1');

export type SandboxConfig = {
  /** Local standard account the investigator runs as. */
  account: string;
  /** Local group named in deny ACEs, so another evaluation account only has to join it. */
  group: string;
  /** Root of the sandbox folders (runtime/, work/). Created with a protected ACL by setup. */
  root: string;
};

export const DEFAULT_SANDBOX: SandboxConfig = { account: 'td-eval', group: 'td-eval-sandbox', root: 'C:\\td-eval' };

/** Written into the account's and the group's description; setup only reuses or removes objects that carry it. */
export const SANDBOX_MARKER = 'test-detective evaluation sandbox (R4b)';

/** Local account and group names: SAM allows 20 characters; this is stricter (no spaces, quotes or wildcards). */
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{1,19}$/;

export const runtimeDir = (config: SandboxConfig): string => path.win32.join(config.root, 'runtime');
export const workDir = (config: SandboxConfig): string => path.win32.join(config.root, 'work');

/** The DPAPI-protected credential (PowerShell Export-Clixml) and the setup state, both inside the developer's private profile. */
export const stateDir = (localAppData: string): string => path.win32.join(localAppData, 'test-detective');
export const credentialFile = (localAppData: string): string => path.win32.join(stateDir(localAppData), 'eval-account.xml');
export const setupStateFile = (localAppData: string): string => path.win32.join(stateDir(localAppData), 'eval-sandbox-state.json');
/** The evaluation account's token as `check --account` observed it; setup.ps1 -Verify requires it. */
export const tokenFile = (localAppData: string): string => path.win32.join(stateDir(localAppData), 'eval-token.json');
/** The elevated shadow-copy inventories around a check (shadow-record.ts writes them), and the check's shadow record waiting for the second one. */
export const shadowInventoryFile = (localAppData: string, phase: 'before' | 'after'): string => path.win32.join(stateDir(localAppData), `eval-vss-${phase}.json`);
export const shadowPendingFile = (localAppData: string): string => path.win32.join(stateDir(localAppData), 'eval-shadow-pending.json');

/**
 * The folder setup denies to the group: the repo's top-level folder on its drive (`C:\GIT` for
 * `C:\GIT\test-detective`), so sibling repos and copies next to it are covered too. A repo directly
 * under a drive root is denied itself.
 */
export function denyRootFor(repoRoot: string): string {
  const resolved = path.win32.resolve(repoRoot);
  const match = /^([A-Za-z]:)\\([^\\]+)/.exec(resolved);
  if (!match) throw new Error(`Expected a repo on a drive path, got ${repoRoot}.`);
  return `${match[1]!.toUpperCase()}\\${match[2]}`;
}

export function checkNames(config: SandboxConfig): void {
  for (const [label, name] of [['account', config.account], ['group', config.group]] as const) {
    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid ${label} name: ${JSON.stringify(name)}.`);
  }
  if (config.account.toLowerCase() === config.group.toLowerCase()) throw new Error('The account and the group need different names.');
  if (!/^[A-Za-z]:\\[^\\]+(\\[^\\]+)*$/.test(config.root) || /[<>:"|?*]/.test(config.root.slice(2))) throw new Error(`Invalid sandbox root: ${config.root}.`);
}
