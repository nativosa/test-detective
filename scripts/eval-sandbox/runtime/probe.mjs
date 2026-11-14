// R4b Step 1D: the file-system enforcement probe. Meant to run AS THE EVALUATION ACCOUNT (through
// stage2.mjs); the host (src/eval/sandbox/check.ts) decides what each outcome means. It attempts
// each read, list or write from the base64 JSON plan in argv[2] and prints ONE JSON line:
//   { identity, results: [{ id, outcome: "ok" | "error", code?, sha256?, count?, cleaned? }] }
// The identity includes the token's groups (whoami /groups), which decide what the ACLs grant.
// It never prints file contents or names: a read reports only the SHA-256 of what it got, a list
// only the number of entries. Only Node built-ins.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WHOAMI = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');

function whoamiSid() {
  try {
    return /"(S-1-[0-9-]+)"/.exec(execFileSync(WHOAMI, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }))?.[1] ?? null;
  } catch {
    return null;
  }
}

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

/** The token's groups (`whoami /groups`: name, type, SID, attributes); null when whoami fails. */
function tokenGroups() {
  try {
    const out = execFileSync(WHOAMI, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    return out.split(/\r?\n/).filter((l) => l.startsWith('"')).map(parseCsvLine).filter((f) => f.length >= 4 && /^S-1-[0-9-]+$/.test(f[2])).map((f) => ({ name: f[0], sid: f[2], attributes: f[3] }));
  } catch {
    return null;
  }
}

function attempt({ id, op, path: target }) {
  try {
    if (op === 'read') return { id, outcome: 'ok', sha256: createHash('sha256').update(readFileSync(target)).digest('hex') };
    if (op === 'list') return { id, outcome: 'ok', count: readdirSync(target).length };
    if (op === 'write') {
      const file = path.join(target, `td-write-probe-${randomUUID()}.tmp`);
      writeFileSync(file, 'x', { flag: 'wx' });
      let cleaned = true;
      try {
        unlinkSync(file);
      } catch {
        cleaned = false;
      }
      return { id, outcome: 'ok', cleaned };
    }
    return { id, outcome: 'error', code: 'BAD_OP' };
  } catch (error) {
    return { id, outcome: 'error', code: typeof error?.code === 'string' ? error.code : 'UNKNOWN' };
  }
}

function main() {
  const plan = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
  const forbidden = (plan.forbidden ?? []).filter((s) => typeof s === 'string' && s.length > 0).map((s) => s.toLowerCase());
  const env = process.env;
  const identity = {
    username: os.userInfo().username,
    home: os.homedir(),
    userprofile: env.USERPROFILE ?? null,
    temp: os.tmpdir(),
    sid: whoamiSid(),
    envNames: Object.keys(env).sort(),
    envMentioningForbidden: Object.entries(env).filter(([, v]) => forbidden.some((f) => String(v).toLowerCase().includes(f))).map(([k]) => k).sort(),
    tokenGroups: tokenGroups(),
  };
  const results = (plan.attempts ?? []).map(attempt);
  process.stdout.write(`${JSON.stringify({ identity, results })}\n`);
}

main();
