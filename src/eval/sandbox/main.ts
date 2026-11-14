import { windowsShortPaths } from '../live.ts';
import { verdictExitCode } from './check.ts';
import { DEFAULT_SANDBOX, REPO_ROOT, runtimeDir } from './config.ts';
import { runAccountCheck, runSelfCheck } from './run-check.ts';
import { buildRuntimeManifest, manifestSha256, stageSandboxRuntime } from './runtime.ts';

// R4b Step 1D sandbox commands (no model, no SDK session):
//   node src/eval/sandbox/main.ts runtime-manifest [--stage]   --stage copies into <sandbox>\runtime only (created by setup -Apply)
//   node src/eval/sandbox/main.ts check --self      probe as the current user in temp folders (must end BLOCKER)
//   node src/eval/sandbox/main.ts check --account   probe as the evaluation account (needs setup and a staged runtime)
// The setup planner has its own minimal entry point (setup-cli.ts), because setup.ps1 may run it elevated.
// Exit codes: 0 ok / PASS, 1 error, 2 BLOCKER, 3 INCONCLUSIVE.

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'runtime-manifest') {
    const manifest = await buildRuntimeManifest(REPO_ROOT);
    if (rest.includes('--stage')) {
      if (rest.length !== 1) throw new Error(`--stage takes no folder: it stages only into ${runtimeDir(DEFAULT_SANDBOX)}.`);
      await stageSandboxRuntime(REPO_ROOT, manifest, DEFAULT_SANDBOX);
    } else if (rest.length > 0) {
      throw new Error('runtime-manifest takes only --stage.');
    }
    const bytes = manifest.files.reduce((n, f) => n + f.size, 0);
    const groups = new Map<string, number>();
    const groupOf = (p: string) => p.split('/').slice(0, p.startsWith('app/node_modules/@') ? 4 : p.startsWith('app/node_modules/') ? 3 : 2).join('/');
    for (const f of manifest.files) groups.set(groupOf(f.path), (groups.get(groupOf(f.path)) ?? 0) + 1);
    console.log(JSON.stringify({ claudeVersion: manifest.claudeVersion, files: manifest.files.length, bytes, manifestSha256: manifestSha256(manifest), groups: Object.fromEntries([...groups].sort()) }, null, 2));
    return 0;
  }
  if (command === 'check') {
    const run = rest.includes('--account') ? await runAccountCheck(DEFAULT_SANDBOX, { shortPaths: windowsShortPaths }) : rest.includes('--self') ? await runSelfCheck({ shortPaths: windowsShortPaths }) : null;
    if (!run) throw new Error('check needs --self or --account.');
    console.log(JSON.stringify(run, null, 2));
    if (run.mode === 'self') console.error('Self mode runs as the developer: a BLOCKER here is expected and proves nothing about isolation.');
    return verdictExitCode(run.report.verdict);
  }
  throw new Error('Commands: runtime-manifest, check. (The setup planner is setup-cli.ts.)');
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`sandbox: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
