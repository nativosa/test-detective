import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ShortPathLookup } from '../workspace.ts';

// R4b Step 1D: the offline file-system enforcement check. The host prepares disposable sentinels
// (random bytes, never printed), lists the attempts, and judges what runtime/bin/probe.mjs reports
// when it runs as the evaluation account. Only a denial by Windows (EACCES/EPERM) counts as
// blocked; an attempt that didn't run, or failed for another reason, is inconclusive, never a pass.
// Every attempt has a unique ID. A missing, duplicated, unknown or malformed result never adds up to
// a PASS, and any forbidden success is a BLOCKER whatever else the probe reported, including one
// claimed only by a malformed result entry for a requested forbidden attempt (Step 1D.2B).
// Real truths, scores and credentials are never targets.

export type AttemptOp = 'read' | 'list' | 'write';
export type Attempt = {
  id: string;
  op: AttemptOp;
  path: string;
  expect: 'allow' | 'deny';
  /** What the attempt exercises: long, short (8.3), junction, device, unc, ... */
  variant: string;
  /** For reads: the SHA-256 of the sentinel. An allowed read must report it; a forbidden read that reports it is verified access. Never sent to the probe. */
  sha256?: string;
};

export const ProbeResult = z.strictObject({
  id: z.string().min(1),
  outcome: z.enum(['ok', 'error']),
  code: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  count: z.number().int().nonnegative().optional(),
  cleaned: z.boolean().optional(),
});
export type ProbeResult = z.infer<typeof ProbeResult>;
/** One group of the probe's token (`whoami /groups`): what Windows checks ACLs against. */
export const TokenGroup = z.strictObject({ name: z.string(), sid: z.string().regex(/^S-1-[0-9-]+$/), attributes: z.string() });
export type TokenGroup = z.infer<typeof TokenGroup>;
const ProbeIdentity = z.strictObject({
  username: z.string(),
  home: z.string(),
  userprofile: z.string().nullable(),
  temp: z.string(),
  sid: z.string().nullable(),
  envNames: z.array(z.string()),
  envMentioningForbidden: z.array(z.string()),
  /** Null when whoami could not be run. */
  tokenGroups: z.array(TokenGroup).nullable(),
});
export type ProbeIdentity = z.infer<typeof ProbeIdentity>;
/**
 * `invalidResults` counts result entries that failed validation and were dropped (parseProbeOutput);
 * `invalidOkIds` are the IDs of dropped entries that still claimed `outcome: "ok"`, so a malformed
 * success can't hide a read.
 */
export type ProbeReport = { identity: ProbeIdentity; results: ProbeResult[]; invalidResults?: number; invalidOkIds?: string[] };
export type TeardownReport = { selected: number; killed: number; remaining: number };

export type Status = 'pass' | 'fail' | 'inconclusive';
export type CheckItem = { id: string; status: Status; detail: string; variant?: string; op?: AttemptOp; code?: string };
export type Verdict = 'PASS' | 'BLOCKER' | 'INCONCLUSIVE';
export type CheckReport = { verdict: Verdict; counts: Record<Status, number>; items: CheckItem[] };

export const DENIED_CODES = new Set(['EACCES', 'EPERM']);
export const ADMINISTRATORS_SID = 'S-1-5-32-544';
const AUTH_ENV = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|AWS_|GOOGLE_APPLICATION|AZURE_)/;

/** Spellings that reach the same file: 8.3, device paths, admin shares over loopback, forward slashes. */
export function aliasVariants(longPath: string, short: string | null): { variant: string; path: string }[] {
  const m = /^([A-Za-z]):\\(.*)$/.exec(longPath);
  if (!m) throw new Error(`Expected an absolute drive path, got ${longPath}.`);
  const [, drive, rest] = m as unknown as [string, string, string];
  const out = [
    { variant: 'long', path: longPath },
    { variant: 'forward-slashes', path: longPath.replaceAll('\\', '/') },
    { variant: 'device-extended', path: `\\\\?\\${longPath}` },
    { variant: 'device-dot', path: `\\\\.\\${longPath}` },
    { variant: 'unc-localhost', path: `\\\\localhost\\${drive}$\\${rest}` },
    { variant: 'unc-loopback', path: `\\\\127.0.0.1\\${drive}$\\${rest}` },
    { variant: 'unc-extended', path: `\\\\?\\UNC\\localhost\\${drive}$\\${rest}` },
  ];
  if (short && short.toLowerCase() !== longPath.toLowerCase()) out.splice(1, 0, { variant: 'short', path: short });
  return out;
}

/** Windows' default junctions over the same folders: `C:\Documents and Settings` -> `C:\Users`, `<profile>\Local Settings` -> `AppData\Local`. */
export function defaultJunctionVariants(longPath: string, profile: string): { variant: string; path: string }[] {
  const out: { variant: string; path: string }[] = [];
  const users = /^([A-Za-z]):\\Users\\(.+)$/i.exec(longPath);
  if (users) out.push({ variant: 'junction-documents-and-settings', path: `${users[1]}:\\Documents and Settings\\${users[2]}` });
  const local = `${profile}\\AppData\\Local\\`;
  if (longPath.toLowerCase().startsWith(local.toLowerCase())) out.push({ variant: 'junction-local-settings', path: `${profile}\\Local Settings\\${longPath.slice(local.length)}` });
  return out;
}

export type CheckSetup = {
  /** A folder the evaluation account may read (its workspace). Gets the allowed sentinel and the test junctions. */
  workspace: string;
  /** Protected parents for disposable probe folders, e.g. `<repo>\.work` and the developer's TEMP. */
  protectedParents: { label: string; dir: string }[];
  /** Further folders where a write must be denied (deny root, runtime copy). */
  writeTargets: { label: string; dir: string }[];
  /** Folders whose listing must be denied (repo root, deny root, profile, TEMP). */
  listTargets: { label: string; dir: string }[];
  /** Expected outcome of a write into the workspace (read-only by design; see evals/README.md). */
  workspaceWrite: 'allow' | 'deny';
  developerProfile: string;
  shortPaths: ShortPathLookup;
};

export type PreparedCheck = { attempts: Attempt[]; created: string[]; cleanup: () => Promise<void> };

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export function duplicateIds(attempts: { id: string }[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of attempts) (seen.has(id) ? duplicates : seen).add(id);
  return [...duplicates].sort();
}

/**
 * The attempt IDs a setup produces, before anything is created: `<label>-read-<variant>`,
 * `<label>-write` and `<label>-list` per protected parent, `<label>-write` per write target and
 * `<label>-list` per list target. Throws on any collision, so two labels can never share a result.
 */
export function plannedAttemptIds(setup: Pick<CheckSetup, 'protectedParents' | 'writeTargets' | 'listTargets'>): string[] {
  const ids = ['workspace-read', 'workspace-write'];
  for (const { label } of setup.protectedParents) ids.push(`${label}-read-*`, `${label}-read-junction`, `${label}-write`, `${label}-list`);
  for (const { label } of setup.writeTargets) ids.push(`${label}-write`);
  for (const { label } of setup.listTargets) ids.push(`${label}-list`);
  const labels = [...setup.protectedParents, ...setup.writeTargets, ...setup.listTargets].map((t) => t.label);
  // `shadow-` IDs belong to the shadow-copy attempts (shadow.ts); no label may produce one.
  const bad = labels.filter((l) => !/^[a-z][a-z0-9-]*$/.test(l) || /^shadow(-|$)/.test(l));
  if (bad.length > 0) throw new Error(`Invalid check labels: ${bad.join(', ')}.`);
  const duplicates = duplicateIds(ids.map((id) => ({ id })));
  if (duplicates.length > 0) throw new Error(`Check attempts need unique IDs; duplicated: ${duplicates.join(', ')}.`);
  return ids;
}

/** Creates the disposable sentinels and junctions and lists every attempt. `cleanup` removes exactly what was created. */
export async function prepareCheck(setup: CheckSetup): Promise<PreparedCheck> {
  plannedAttemptIds(setup);
  const created: string[] = [];
  const cleanup = async () => {
    for (const p of [...created].reverse()) await rm(p, { recursive: true, force: true });
  };
  try {
    const attempts: Attempt[] = [];
    const tag = randomBytes(4).toString('hex');
    const allowed = path.join(setup.workspace, `allowed-${tag}.txt`);
    const allowedBytes = randomBytes(64);
    await writeFile(allowed, allowedBytes, { flag: 'wx' });
    created.push(allowed);
    attempts.push({ id: 'workspace-read', op: 'read', path: allowed, expect: 'allow', variant: 'long', sha256: sha256(allowedBytes) });
    attempts.push({ id: 'workspace-write', op: 'write', path: setup.workspace, expect: setup.workspaceWrite, variant: 'long' });

    const probes: { label: string; dir: string; file: string; sha256: string }[] = [];
    for (const { label, dir } of setup.protectedParents) {
      await mkdir(dir, { recursive: true });
      const probeDir = await mkdtemp(path.join(dir, 'td-acl-probe-'));
      created.push(probeDir);
      const file = path.join(probeDir, 'sentinel.txt');
      const bytes = randomBytes(64);
      await writeFile(file, bytes, { flag: 'wx' });
      probes.push({ label, dir: probeDir, file, sha256: sha256(bytes) });
    }
    const shorts = await setup.shortPaths(probes.map((p) => p.file));
    probes.forEach((probe, i) => {
      for (const v of [...aliasVariants(probe.file, shorts[i] ?? null), ...defaultJunctionVariants(probe.file, setup.developerProfile)]) {
        attempts.push({ id: `${probe.label}-read-${v.variant}`, op: 'read', path: v.path, expect: 'deny', variant: v.variant, sha256: probe.sha256 });
      }
      attempts.push({ id: `${probe.label}-write`, op: 'write', path: probe.dir, expect: 'deny', variant: 'long' });
      attempts.push({ id: `${probe.label}-list`, op: 'list', path: probe.dir, expect: 'deny', variant: 'long' });
    });
    for (const probe of probes) {
      const link = path.join(setup.workspace, `link-${probe.label}-${tag}`);
      await symlink(probe.dir, link, 'junction');
      created.push(link);
      attempts.push({ id: `${probe.label}-read-junction`, op: 'read', path: path.join(link, 'sentinel.txt'), expect: 'deny', variant: 'junction', sha256: probe.sha256 });
    }
    for (const { label, dir } of setup.writeTargets) attempts.push({ id: `${label}-write`, op: 'write', path: dir, expect: 'deny', variant: 'long' });
    for (const { label, dir } of setup.listTargets) attempts.push({ id: `${label}-list`, op: 'list', path: dir, expect: 'deny', variant: 'long' });
    const duplicates = duplicateIds(attempts);
    if (duplicates.length > 0) throw new Error(`Check attempts need unique IDs; duplicated: ${duplicates.join(', ')}.`);
    return { attempts, created, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** The payload probe.mjs receives (argv[2]): attempts without expectations, plus strings the environment must not mention. */
export function probePayload(attempts: Attempt[], forbidden: string[]): string {
  return Buffer.from(JSON.stringify({ attempts: attempts.map(({ id, op, path: p }) => ({ id, op, path: p })), forbidden }), 'utf8').toString('base64');
}

export type Expectations = {
  account: string;
  developer: { username: string; home: string; sid: string | null };
  /** `COMPUTER\group`: the group the deny ACE names, which the token must contain. Null or absent in self mode. */
  tokenGroup?: string | null;
};

export function judgeAttempt(attempt: Attempt, result: ProbeResult | undefined): CheckItem {
  const base = { id: attempt.id, variant: attempt.variant, op: attempt.op };
  if (!result) return { ...base, status: 'inconclusive', detail: 'not attempted' };
  if (attempt.expect === 'allow') {
    if (result.outcome !== 'ok') return { ...base, status: 'inconclusive', code: result.code, detail: `allowed ${attempt.op} failed (${result.code}); denials elsewhere prove nothing` };
    if (attempt.op === 'read' && result.sha256 !== attempt.sha256) return { ...base, status: 'fail', detail: 'read returned different content' };
    return { ...base, status: 'pass', detail: `allowed ${attempt.op} succeeded${attempt.op === 'read' ? ' (hash matches)' : ''}` };
  }
  if (result.outcome === 'ok') return { ...base, status: 'fail', detail: `forbidden ${attempt.op} SUCCEEDED${result.count !== undefined ? ` (${result.count} entries)` : ''} (${accessEvidence(attempt, result)})` };
  if (result.code && DENIED_CODES.has(result.code)) return { ...base, status: 'pass', code: result.code, detail: 'denied by Windows' };
  return { ...base, status: 'inconclusive', code: result.code, detail: `failed with ${result.code}, which is not an access denial` };
}

/** Reported is not verified: only a forbidden read returning the sentinel's own hash proves the access independently. */
function accessEvidence(attempt: Attempt, result: ProbeResult): string {
  if (attempt.op === 'read' && attempt.sha256 !== undefined && result.sha256 === attempt.sha256) return 'verified: the content matches the sentinel';
  return 'reported by the probe, not independently verified';
}

/**
 * Several results for one attempt: a forbidden success among them still fails; otherwise the duplicate is inconclusive, never a pass.
 * `malformedSuccesses` counts dropped (malformed) entries with this exact ID that claimed `outcome: "ok"`: for a forbidden
 * attempt they are a reported success, so a BLOCKER, even next to valid denials. For an allowed attempt they prove nothing.
 */
export function judgeAttemptResults(attempt: Attempt, results: ProbeResult[], malformedSuccesses = 0): CheckItem {
  const malformed = attempt.expect === 'deny' && malformedSuccesses > 0 ? `${malformedSuccesses} malformed result${malformedSuccesses === 1 ? '' : 's'} for this ID claimed success` : null;
  if (results.length <= 1 && !malformed) return judgeAttempt(attempt, results[0]);
  const failed = results.map((r) => judgeAttempt(attempt, r)).find((j) => j.status === 'fail');
  if (failed) return { ...failed, detail: `${failed.detail} (one of ${results.length} results for this ID${malformed ? `; ${malformed}` : ''})` };
  if (malformed) return { id: attempt.id, variant: attempt.variant, op: attempt.op, status: 'fail', detail: `forbidden ${attempt.op} reported as SUCCEEDED by a malformed result (reported by the probe, not independently verified; ${malformed}, ${results.length} valid)` };
  return { id: attempt.id, variant: attempt.variant, op: attempt.op, status: 'inconclusive', detail: `${results.length} results for one attempt; a duplicate never counts as denied` };
}

export function judgeIdentity(identity: ProbeIdentity, expect: Expectations): CheckItem[] {
  const eq = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
  const under = (p: string, root: string) => {
    const rel = path.win32.relative(root.toLowerCase(), p.toLowerCase());
    return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
  };
  const item = (id: string, ok: boolean, detail: string): CheckItem => ({ id, status: ok ? 'pass' : 'fail', detail });
  const auth = identity.envNames.filter((n) => AUTH_ENV.test(n));
  const notDeveloper = !eq(identity.username, expect.developer.username) && identity.sid !== null && !eq(identity.sid, expect.developer.sid);
  const locations: [string, string | null][] = [['home', identity.home], ['USERPROFILE', identity.userprofile], ['TEMP', identity.temp]];
  const inProfile = locations.filter(([, p]) => p !== null && under(p, expect.developer.home)).map(([name]) => name);
  return [
    item('identity-account', eq(identity.username, expect.account), `runs as ${identity.username}`),
    item('identity-not-developer', notDeveloper, identity.sid === null ? 'no SID reported' : notDeveloper ? 'user and SID differ from the developer' : 'runs with the developer identity'),
    item('profile-isolated', inProfile.length === 0, inProfile.length === 0 ? 'home, USERPROFILE and TEMP are outside the developer profile' : `inside the developer profile: ${inProfile.join(', ')}`),
    item('env-isolated', identity.envMentioningForbidden.length === 0, identity.envMentioningForbidden.length === 0 ? 'no variable mentions the developer profile' : `variables mentioning the developer: ${identity.envMentioningForbidden.join(', ')}`),
    item('env-no-auth', auth.length === 0, auth.length === 0 ? 'no auth variables' : `auth variables present: ${auth.join(', ')}`),
    ...judgeToken(identity.tokenGroups, expect.tokenGroup ?? null),
  ];
}

/** The token decides what the ACLs grant: it must hold the denied group and no Administrators (enabled or deny-only). */
export function judgeToken(groups: TokenGroup[] | null, tokenGroup: string | null): CheckItem[] {
  if (!groups || groups.length === 0) return [{ id: 'token-observed', status: 'inconclusive', detail: 'the probe could not list its token groups' }];
  const items: CheckItem[] = [
    { id: 'token-observed', status: 'pass', detail: `${groups.length} token groups observed` },
    groups.some((g) => g.sid === ADMINISTRATORS_SID)
      ? { id: 'token-standard', status: 'fail', detail: 'the token contains Administrators' }
      : { id: 'token-standard', status: 'pass', detail: 'no Administrators in the token' },
  ];
  if (tokenGroup) {
    const has = groups.some((g) => g.name.toLowerCase() === tokenGroup.toLowerCase());
    items.push({ id: 'token-has-group', status: has ? 'pass' : 'fail', detail: has ? `${tokenGroup} is in the token` : `${tokenGroup} is not in the token: the deny ACE would not apply` });
  }
  return items;
}

export function judgeTeardown(teardown: TeardownReport | null): CheckItem {
  if (!teardown) return { id: 'teardown', status: 'inconclusive', detail: 'teardown not attempted' };
  return { id: 'teardown', status: teardown.remaining === 0 ? 'pass' : 'fail', detail: `${teardown.selected} leftover processes, ${teardown.killed} ended, ${teardown.remaining} remaining` };
}

/**
 * Any fail is a BLOCKER; otherwise anything inconclusive (no probe report, a missing, duplicated,
 * unknown or malformed result, duplicate attempt IDs) is INCONCLUSIVE; PASS needs every item to pass.
 * A malformed entry claiming success for a requested forbidden attempt fails that attempt; the
 * malformed-results diagnostic stays. One for an allowed or unrequested ID stays inconclusive.
 * `extra` adds items the caller judged (a refused launch, for example).
 */
export function evaluateCheck(attempts: Attempt[], probe: ProbeReport | null, expect: Expectations, teardown: TeardownReport | null, extra: CheckItem[] = []): CheckReport {
  const byId = new Map<string, ProbeResult[]>();
  for (const r of probe?.results ?? []) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const malformedOk = new Map<string, number>();
  for (const id of probe?.invalidOkIds ?? []) malformedOk.set(id, (malformedOk.get(id) ?? 0) + 1);
  const requested = new Set(attempts.map((a) => a.id));
  const duplicates = duplicateIds(attempts);
  const unknown = [...byId.keys()].filter((id) => !requested.has(id));
  const items: CheckItem[] = [
    ...(duplicates.length > 0 ? [{ id: 'attempt-ids', status: 'inconclusive' as const, detail: `duplicate attempt IDs: ${duplicates.join(', ')}` }] : []),
    ...attempts.map((a) => judgeAttemptResults(a, byId.get(a.id) ?? [], malformedOk.get(a.id) ?? 0)),
    ...(unknown.length > 0 ? [{ id: 'probe-unknown-results', status: 'inconclusive' as const, detail: `${unknown.length} results for attempts that were not requested` }] : []),
    ...(probe?.invalidResults ? [{ id: 'probe-malformed-results', status: 'inconclusive' as const, detail: `${probe.invalidResults} malformed results were dropped` }] : []),
    ...(probe ? judgeIdentity(probe.identity, expect) : [{ id: 'identity', status: 'inconclusive' as const, detail: 'probe produced no valid report' }]),
    judgeTeardown(teardown),
    ...extra,
  ];
  return reportOf(items);
}

/** Counts and verdict over the items: any fail is a BLOCKER, then any inconclusive item is INCONCLUSIVE. */
export function reportOf(items: CheckItem[]): CheckReport {
  const counts: Record<Status, number> = { pass: 0, fail: 0, inconclusive: 0 };
  for (const i of items) counts[i.status]++;
  const verdict: Verdict = counts.fail > 0 ? 'BLOCKER' : counts.inconclusive > 0 ? 'INCONCLUSIVE' : 'PASS';
  return { verdict, counts, items };
}

/**
 * The probe's one JSON line, validated. No line, several lines, invalid JSON or an invalid identity
 * give null (INCONCLUSIVE). Malformed result entries are dropped and counted, so the valid ones are
 * still judged (a forbidden success among them stays a BLOCKER).
 */
export function parseProbeOutput(stdout: string): ProbeReport | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith('{'));
  if (lines.length !== 1) return null;
  let value: unknown;
  try {
    value = JSON.parse(lines[0]!);
  } catch {
    return null;
  }
  const outer = z.strictObject({ identity: ProbeIdentity, results: z.array(z.unknown()) }).safeParse(value);
  if (!outer.success) return null;
  const results: ProbeResult[] = [];
  const invalidOkIds: string[] = [];
  let invalidResults = 0;
  for (const entry of outer.data.results) {
    const parsed = ProbeResult.safeParse(entry);
    if (parsed.success) {
      results.push(parsed.data);
      continue;
    }
    invalidResults++;
    const loose = entry as { id?: unknown; outcome?: unknown } | null;
    if (loose && typeof loose === 'object' && typeof loose.id === 'string' && loose.id.length > 0 && loose.outcome === 'ok') invalidOkIds.push(loose.id);
  }
  return { identity: outer.data.identity, results, invalidResults, invalidOkIds };
}

export type ObservedTokenFile = { schema: 1; account: string; userSid: string; groups: { sid: string; name: string }[] };

/** What the account's token was observed to contain; setup.ps1 -Verify reads it back (setup-plan.ts ObservedToken). */
export function observedToken(identity: ProbeIdentity, account: string): ObservedTokenFile | null {
  if (!identity.sid || !identity.tokenGroups || identity.tokenGroups.length === 0) return null;
  return { schema: 1, account, userSid: identity.sid, groups: identity.tokenGroups.map(({ sid, name }) => ({ sid, name })) };
}

export const verdictExitCode = (verdict: Verdict): number => (verdict === 'PASS' ? 0 : verdict === 'BLOCKER' ? 2 : 3);
