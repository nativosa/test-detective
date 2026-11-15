import { shadowInventoryFile } from './config.ts';
import { shownPath, writePrivateJson } from './private-state.ts';

// R4b Step 1D.2B: records one elevated shadow-copy inventory in the developer's private state folder.
// Run in the ELEVATED shell, piped from the inventory script (no intermediate file):
//   scripts\eval-sandbox\vss-inventory.ps1 | node src\eval\sandbox\shadow-record.ts before|after
// It keeps only the TD-VSS-INVENTORY line, checks that it is one JSON object of schema 2, and writes
// it atomically to %LOCALAPPDATA%\test-detective\eval-vss-<phase>.json (fixed names, no destination
// parameter; links, aliases and hard links refused by private-state.ts). The host validates it fully
// when it uses it (shadow.ts). It imports only Node built-ins, config.ts and private-state.ts,
// because it runs elevated.

const PREFIX = 'TD-VSS-INVENTORY ';

async function readStdin(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(argv: string[]): Promise<void> {
  const [phase, ...rest] = argv;
  if ((phase !== 'before' && phase !== 'after') || rest.length > 0) throw new Error('Usage: vss-inventory.ps1 | node src/eval/sandbox/shadow-record.ts before|after');
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA is not set.');
  const lines = (await readStdin()).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.startsWith(PREFIX));
  if (lines.length !== 1) throw new Error(`Expected exactly one ${PREFIX.trim()} line, got ${lines.length}; no inventory recorded.`);
  let inventory: unknown;
  try {
    inventory = JSON.parse(lines[0]!.slice(PREFIX.length));
  } catch {
    throw new Error('The inventory line is not JSON; no inventory recorded.');
  }
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) || (inventory as { schema?: unknown }).schema !== 2) throw new Error('The inventory is not a schema 2 object; no inventory recorded.');

  const file = shadowInventoryFile(localAppData, phase);
  await writePrivateJson(localAppData, file, inventory);
  const { copies, collectedAt } = inventory as { copies?: unknown; collectedAt?: unknown };
  console.error(`Recorded the ${phase} inventory (${Array.isArray(copies) ? copies.length : '?'} copies, collected ${String(collectedAt)}) in ${shownPath(file)}.`);
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`shadow-record: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
