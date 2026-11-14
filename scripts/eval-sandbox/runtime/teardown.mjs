// R4b Step 1D: ends every leftover process of the evaluation account. Runs AS THAT ACCOUNT (through
// stage2.mjs), so Windows itself limits it to the account's own processes. It also refuses to run
// under any other account than --account, or (when ending processes) under a token that contains
// Administrators, or outside stage2.mjs, so it can never end the developer's processes.
//   teardown.mjs --account <name>                 end the account's processes (not itself or its parent)
//   teardown.mjs --account <name> --plan          only list what it would end
//   ... --plan --from-stdin                        read `tasklist /V /FO CSV /NH` output from stdin (tests)
// Prints one JSON line. Only Node built-ins.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { fields.push(field); field = ''; } else field += c;
  }
  fields.push(field);
  return fields;
}

/** `tasklist /V /FO CSV /NH` rows: image, PID, session name, session#, memory, status, user name, CPU time, window title. */
function parseTasklist(text) {
  return text.split(/\r?\n/).filter((l) => l.startsWith('"')).map(parseCsvLine).filter((f) => f.length >= 7).map((f) => ({ image: f[0], pid: Number(f[1]), user: f[6] }));
}

/** Exactly the account's processes (by full user name), never the excluded ones (this process, its parent). */
function selectTargets(rows, user, exclude) {
  const want = user.toLowerCase();
  return rows.filter((r) => Number.isInteger(r.pid) && r.pid > 0 && r.user.toLowerCase() === want && !exclude.includes(r.pid)).map((r) => r.pid);
}

function list(user) {
  return parseTasklist(execFileSync(path.join(SYSTEM32, 'tasklist.exe'), ['/V', '/FO', 'CSV', '/NH', '/FI', `USERNAME eq ${user}`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }));
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--account');
  const account = at >= 0 ? argv[at + 1] : undefined;
  const own = os.userInfo().username;
  const out = (o, code) => {
    process.stdout.write(`${JSON.stringify(o)}\n`);
    process.exit(code);
  };
  if (!account || !/^[A-Za-z][A-Za-z0-9-]{1,19}$/.test(account)) out({ refused: 'account' }, 90);
  if (own.toLowerCase() !== account.toLowerCase()) out({ refused: 'identity' }, 97);
  const user = `${process.env.USERDOMAIN ?? os.hostname()}\\${own}`;
  const exclude = [process.pid, process.ppid];
  const rows = argv.includes('--from-stdin') ? parseTasklist(readFileSync(0, 'utf8')) : list(own);
  const targets = selectTargets(rows, user, exclude);
  if (argv.includes('--plan')) out({ user, plan: targets }, 0);
  // Ending processes is only for a child of stage2.mjs, which sets this marker.
  if (process.env.TD_SANDBOX_STAGE2 !== '1') out({ refused: 'not-stage2' }, 96);
  // The evaluation account is a standard user. A token with Administrators in it (even deny-only,
  // as for the developer under UAC) is never the evaluation account: refuse before ending anything.
  const groups = execFileSync(path.join(SYSTEM32, 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (groups.includes('"S-1-5-32-544"')) out({ refused: 'administrator' }, 98);
  let killed = 0;
  for (const pid of targets) {
    try {
      execFileSync(path.join(SYSTEM32, 'taskkill.exe'), ['/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 30_000 });
      killed++;
    } catch {
      // Already gone, or not ours: counted below as remaining if it still exists.
    }
  }
  const remaining = selectTargets(list(own), user, exclude).length;
  out({ user, selected: targets.length, killed, remaining }, remaining === 0 ? 0 : 1);
}

main();
