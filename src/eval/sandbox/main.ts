import { windowsShortPaths } from '../live.ts';
import { verdictExitCode } from './check.ts';
import { DEFAULT_SANDBOX, REPO_ROOT, runtimeDir } from './config.ts';
import { hostFromEnv } from './launcher.ts';
import { discardShadowPending, finalizeShadowCheck, runAccountCheck, runSelfCheck } from './run-check.ts';
import { buildRuntimeManifest, manifestSha256, stageSandboxRuntime } from './runtime.ts';

// R4b Step 1D sandbox commands (no model, no SDK session):
//   node src/eval/sandbox/main.ts runtime-manifest [--stage]   --stage copies into <sandbox>\runtime only (created by setup -Apply)
//   node src/eval/sandbox/main.ts check --self      probe as the current user in temp folders (must end BLOCKER)
//   node src/eval/sandbox/main.ts check --account   probe as the evaluation account (needs setup, a staged runtime and
//                                                   the elevated inventory: vss-inventory.ps1 | node src/eval/sandbox/shadow-record.ts before)
//   node src/eval/sandbox/main.ts check --finalize-shadow   judges the account check's shadow part with the inventory
//                                                   recorded after it (shadow-record.ts after); runs nothing
//   node src/eval/sandbox/main.ts check --discard-shadow-pending <run ID>   removes that run's pending record (only that
//                                                   one, intact and of this computer) so a new account check may run
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
    if (rest[0] === '--discard-shadow-pending') {
      if (rest.length !== 2) throw new Error('check --discard-shadow-pending needs the run ID of the pending account check.');
      const { removed, runId } = await discardShadowPending({ ...hostFromEnv(process.env, { username: '', home: '', sid: null }), runId: rest[1]! });
      console.error(removed ? `Discarded the pending account check${runId ? ` (run ${runId})` : ''}.` : 'No pending account check.');
      return 0;
    }
    if (rest.length !== 1) throw new Error('check needs exactly one of --self, --account, --finalize-shadow or --discard-shadow-pending <run ID>.');
    const run =
      rest[0] === '--account' ? await runAccountCheck(DEFAULT_SANDBOX, { shortPaths: windowsShortPaths })
      : rest[0] === '--self' ? await runSelfCheck({ shortPaths: windowsShortPaths })
      : rest[0] === '--finalize-shadow' ? await finalizeShadowCheck(hostFromEnv(process.env, { username: '', home: '', sid: null }))
      : null;
    if (!run) throw new Error('check needs --self, --account or --finalize-shadow.');
    console.log(JSON.stringify(run, null, 2));
    if (run.mode === 'self') console.error('Self mode runs as the developer: a BLOCKER here is expected and proves nothing about isolation.');
    if (run.mode === 'account') console.error('The shadow-copy part needs the inventory after the probe: in an elevated shell run vss-inventory.ps1 | node src\\eval\\sandbox\\shadow-record.ts after, then check --finalize-shadow.');
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
