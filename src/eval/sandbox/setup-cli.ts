import { readFileSync } from 'node:fs';
import { Inventory, planRemoval, planSetup, verifySetup } from './setup-plan.ts';

// R4b Step 1D: the planner entry point setup.ps1 runs, possibly from an ELEVATED shell. It imports
// only setup-plan.ts (which imports config.ts and zod): never the Agent SDK, the live harness, the
// scorer, ground truth or MCP code. sandbox-setup.test.ts pins this import graph.
//   node src/eval/sandbox/setup-cli.ts apply|remove|verify   (stdin: inventory JSON from setup.ps1)
// Prints one JSON line. Exit codes: 0 ok, 1 error.

try {
  // Windows PowerShell's process stdin writer may emit a UTF-8 BOM first.
  const inventory = Inventory.parse(JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, '')));
  const kind = process.argv[2];
  const out = kind === 'apply' ? planSetup(inventory) : kind === 'remove' ? planRemoval(inventory) : kind === 'verify' ? verifySetup(inventory) : null;
  if (!out) throw new Error('setup-cli needs apply, remove or verify.');
  process.stdout.write(`${JSON.stringify(out)}\n`);
} catch (error) {
  console.error(`setup-cli: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
