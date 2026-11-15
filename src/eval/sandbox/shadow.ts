import { z } from 'zod';
import type { Attempt, CheckItem, ProbeReport, ProbeResult } from './check.ts';
import { DENIED_CODES } from './check.ts';
import { forbiddenReason } from './runtime.ts';

// R4b Step 1D: shadow copies in the enforcement check (designed offline, not wired into run-check yet).
// A shadow copy keeps the ACLs a file had when the copy was taken, so a copy from before the deny may
// still grant the evaluation account read on the repo. Three conditions are kept apart:
//   A. a copy exists and contains the repo (elevated inventory: the repo folder exists in the copy);
//   B. the copy holds the repo with its earlier ACLs (elevated inventory: the SDDL it reports);
//   C. the evaluation account can read through the copy (only the probe, running AS that account, shows it).
// The host never reads a copy itself: the elevated inventory reads only existence and security
// descriptors, and the probe attempts one read of a public, committed control file per relevant copy.
// Only a denial by Windows is a pass; any successful read is a BLOCKER; a missing, duplicated, unknown
// or malformed result, a vanished or invalid device, an unknown inventory entry, or an incomplete,
// stale or unconfirmed inventory is INCONCLUSIVE. File contents never leave the probe: it reports only
// a SHA-256, which the host compares with the committed versions of the control file.
//
// Completeness: the inventory records two independent enumerations (Win32_ShadowCopy and vssadmin) and
// is usable only when they agree, so an empty inventory is distinguishable from a failed one.
// Freshness: the inventory taken just before the probe plans the reads; a second one taken just after
// must show the same copy set. Without both, the shadow part is INCONCLUSIVE.

/** The control file: public, committed, no answers. A read of it shows reachability, nothing else. */
export const SHADOW_CONTROL_FILE = 'package.json';
/** Device paths as Win32_ShadowCopy.DeviceObject reports them; nothing else is ever attempted. */
export const SHADOW_DEVICE = /^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy([1-9][0-9]{0,5})$/;
export const SHADOW_ATTEMPT_PREFIX = 'shadow-';
/** How old the planning inventory may be when the probe starts, and how soon after it ends the second one must be taken. */
export const SHADOW_INVENTORY_MAX_AGE_MS = 30 * 60 * 1000;

const GUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
const SHADOW_ID = new RegExp(`^\\{${GUID}\\}$`);
/** Win32_Volume.DeviceID / Win32_ShadowCopy.VolumeName. */
const VOLUME_NAME = new RegExp(`^\\\\\\\\\\?\\\\Volume\\{${GUID}\\}\\\\$`);
const ISO = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a timestamp');
const PathFact = z.strictObject({
  /** Relative to the copy's root, e.g. `GIT\test-detective`. */
  path: z.string().min(1),
  /** Null when the elevated inventory could not tell. */
  exists: z.boolean().nullable(),
  sddl: z.string().nullable(),
});
const ShadowCopy = z.strictObject({
  id: z.string(),
  createdAt: ISO,
  /** Drive letter of the copied volume (`C:`), or null when it has none; informational, `volumeName` decides. */
  volume: z.string().regex(/^[A-Z]:$/).nullable(),
  volumeName: z.string(),
  device: z.string(),
  repo: PathFact,
  control: PathFact,
});
const Enumeration = z.strictObject({
  /** Copies Win32_ShadowCopy listed (the query itself failing stops the script, so no inventory exists). */
  wmiCount: z.number().int().nonnegative(),
  /** `vssadmin list shadows`: its exit code, the shadow copy IDs it printed, and whether it said there are none. */
  vssadminExitCode: z.number().int(),
  vssadminIds: z.array(z.string()),
  vssadminNoItems: z.boolean(),
});
/** What scripts/eval-sandbox/vss-inventory.ps1 prints as its JSON line (schema 2). */
export const ShadowInventory = z.strictObject({
  schema: z.literal(2),
  computer: z.string().min(1),
  collectedAt: ISO,
  /** The repo root on the live volume, e.g. `C:\GIT\test-detective`. */
  repoRoot: z.string().regex(/^[A-Z]:\\[^\\]+(\\[^\\]+)*$/),
  /** The repo volume's `\\?\Volume{GUID}\`; a copy belongs to it when its volumeName is the same. */
  repoVolumeName: z.string().regex(VOLUME_NAME),
  enumeration: Enumeration,
  copies: z.array(ShadowCopy),
});
export type ShadowInventory = z.infer<typeof ShadowInventory>;
export type ShadowCopy = z.infer<typeof ShadowCopy>;

/** Why a repo-relative file may not be the control (it must be committed public content, never answers or secrets), or null. */
export function controlFileProblem(repoPath: string): string | null {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(repoPath) || repoPath.split('/').some((p) => p === '.' || p === '..')) return 'not a plain repo-relative path';
  const reason = forbiddenReason(repoPath);
  if (reason) return reason;
  if (/(^|\/)\.claude(\/|$)|(^|\/)scenarios(\/|$)|(^|\/)control(\/|$)/.test(repoPath)) return 'evaluation or Claude configuration';
  return null;
}

/** The control file's path inside a copy of the repo's volume: `GIT\test-detective\package.json`. */
export function controlPathInCopy(repoRoot: string, control: string = SHADOW_CONTROL_FILE): string {
  const problem = controlFileProblem(control);
  if (problem) throw new Error(`${control} can't be the shadow-copy control: ${problem}.`);
  const m = /^[A-Z]:\\(.+)$/.exec(repoRoot);
  if (!m) throw new Error(`Expected a canonical drive path, got ${repoRoot}.`);
  return `${m[1]}\\${control.replaceAll('/', '\\')}`;
}

/** Why the two enumerations don't prove the copy list complete, or null. */
export function enumerationProblem(inv: ShadowInventory): string | null {
  const e = inv.enumeration;
  if (e.wmiCount !== inv.copies.length) return `Win32_ShadowCopy counted ${e.wmiCount} copies but the inventory lists ${inv.copies.length}`;
  const vss = e.vssadminIds.map((id) => id.toLowerCase());
  if (new Set(vss).size !== vss.length) return 'vssadmin listed a shadow copy ID twice';
  if (vss.some((id) => !SHADOW_ID.test(id))) return 'vssadmin printed an ID that is not a GUID';
  const wmi = new Set(inv.copies.map((c) => c.id.toLowerCase()));
  if (vss.length !== wmi.size || vss.some((id) => !wmi.has(id))) return 'vssadmin and Win32_ShadowCopy list different shadow copies';
  if (inv.copies.length === 0) {
    // An empty result counts only when vssadmin itself said there are none; silence or an error is not "none".
    if (!e.vssadminNoItems) return 'no shadow copies were listed, but vssadmin did not report "no items"';
  } else if (e.vssadminExitCode !== 0 || e.vssadminNoItems) return `vssadmin did not list the copies cleanly (exit ${e.vssadminExitCode})`;
  return null;
}

type IdentityOptions = { computer: string; repoRoot: string };

/** Validates an inventory and that it describes this computer and repo, completely. */
function usableInventory(raw: unknown, options: IdentityOptions): { inv: ShadowInventory } | { problem: string } {
  const parsed = ShadowInventory.safeParse(raw);
  if (!parsed.success) return { problem: `it is malformed (${parsed.error.issues.length} problems)` };
  const inv = parsed.data;
  const problems: string[] = [];
  if (inv.computer.toLowerCase() !== options.computer.toLowerCase()) problems.push(`it was collected on ${inv.computer}`);
  if (inv.repoRoot.toLowerCase() !== options.repoRoot.toLowerCase()) problems.push(`it describes ${inv.repoRoot}, not ${options.repoRoot}`);
  const incomplete = enumerationProblem(inv);
  if (incomplete) problems.push(`the enumeration is incomplete: ${incomplete}`);
  return problems.length > 0 ? { problem: problems.join('; ') } : { inv };
}

export type ShadowPlan = {
  /** One read per relevant copy, expected to be denied. */
  attempts: Attempt[];
  /** Inventory-level findings: relevance, invalid or duplicate entries, staleness. */
  items: CheckItem[];
  /** Copy ID per attempt, for the report. */
  copyOf: Record<string, string>;
};

type PlanOptions = IdentityOptions & { now: Date; maxAgeMs?: number; control?: string };

/**
 * Plans the shadow-copy reads from a validated, complete elevated inventory. Only copies of the repo's
 * volume (by volume GUID) that the inventory shows to contain the repo and the control file are
 * attempted, each through exactly the device path the inventory reported; no device numbers are guessed.
 */
export function planShadowAttempts(raw: unknown, options: PlanOptions): ShadowPlan {
  const items: CheckItem[] = [];
  const attempts: Attempt[] = [];
  const copyOf: Record<string, string> = {};
  const unusable = (detail: string): ShadowPlan => ({ attempts, copyOf, items: [{ id: 'shadow-inventory', status: 'inconclusive', detail: `the shadow-copy inventory can't be used: ${detail}` }] });
  const usable = usableInventory(raw, options);
  if ('problem' in usable) return unusable(usable.problem);
  const inv = usable.inv;
  const age = options.now.getTime() - Date.parse(inv.collectedAt);
  if (age < 0) return unusable('its timestamp is in the future');
  if (age > (options.maxAgeMs ?? SHADOW_INVENTORY_MAX_AGE_MS)) return unusable('it is older than the allowed age; collect it again just before the check');
  const control = options.control ?? SHADOW_CONTROL_FILE;
  const expectedControl = controlPathInCopy(options.repoRoot, control);
  const expectedRepo = expectedControl.slice(0, expectedControl.length - control.length - 1);

  const drive = options.repoRoot.slice(0, 2);
  const repoVolume = inv.repoVolumeName.toLowerCase();
  const seenIds = new Set<string>();
  const seenDevices = new Set<string>();
  let relevant = 0;
  for (const [index, copy] of inv.copies.entries()) {
    const device = SHADOW_DEVICE.exec(copy.device);
    const label = device ? `${SHADOW_ATTEMPT_PREFIX}${device[1]}` : `${SHADOW_ATTEMPT_PREFIX}entry-${index + 1}`;
    const key = copy.id.toLowerCase();
    if (!SHADOW_ID.test(copy.id) || !device) {
      items.push({ id: `${label}-device`, status: 'inconclusive', detail: `copy ${copy.id} has an invalid ID or device path; it can't be tested` });
      continue;
    }
    if (seenIds.has(key) || seenDevices.has(copy.device.toLowerCase())) {
      items.push({ id: `${label}-device`, status: 'inconclusive', detail: `copy ${copy.id} or its device appears twice in the inventory` });
      continue;
    }
    seenIds.add(key);
    seenDevices.add(copy.device.toLowerCase());
    if (!VOLUME_NAME.test(copy.volumeName)) {
      items.push({ id: `${label}-scope`, status: 'inconclusive', detail: `copy ${copy.id}: its source volume (${copy.volumeName || 'none'}) is not a volume GUID, so it can't be ruled out` });
      continue;
    }
    const onRepoVolume = copy.volumeName.toLowerCase() === repoVolume;
    if (onRepoVolume ? copy.volume !== null && copy.volume !== drive : copy.volume === drive) {
      items.push({ id: `${label}-scope`, status: 'inconclusive', detail: `copy ${copy.id}: its drive letter (${copy.volume}) and volume GUID disagree about whether it is of ${drive}` });
      continue;
    }
    if (!onRepoVolume) {
      items.push({ id: `${label}-scope`, status: 'pass', detail: `copy ${copy.id} is of ${copy.volume ?? copy.volumeName}, not the repo's volume ${drive}` });
      continue;
    }
    if (copy.repo.path.toLowerCase() !== expectedRepo.toLowerCase() || copy.control.path.toLowerCase() !== expectedControl.toLowerCase()) {
      items.push({ id: `${label}-scope`, status: 'inconclusive', detail: `copy ${copy.id} was inventoried for other paths than ${expectedRepo} and ${expectedControl}` });
      continue;
    }
    if (copy.repo.exists === false) {
      items.push({ id: `${label}-scope`, status: 'pass', detail: `copy ${copy.id} (${copy.createdAt}) does not contain ${expectedRepo}` });
      continue;
    }
    if (copy.repo.exists === null || copy.control.exists !== true) {
      items.push({ id: `${label}-scope`, status: 'inconclusive', detail: `copy ${copy.id} (${copy.createdAt}): the inventory could not show the repo and the control file in it, so it can't be tested` });
      continue;
    }
    relevant++;
    const id = `${label}-read`;
    attempts.push({ id, op: 'read', path: `${copy.device}\\${expectedControl}`, expect: 'deny', variant: 'shadow-copy' });
    copyOf[id] = copy.id;
  }
  if (inv.copies.length === 0) {
    items.push({ id: 'shadow-inventory', status: 'pass', detail: 'complete enumeration (Win32_ShadowCopy and vssadmin agree): this computer has no shadow copies' });
  } else if (relevant === 0 && items.every((i) => i.status === 'pass')) {
    items.push({ id: 'shadow-inventory', status: 'pass', detail: `complete enumeration of ${inv.copies.length} copies: none of ${drive} contains the repo` });
  }
  return { attempts, copyOf, items };
}

type StabilityOptions = IdentityOptions & { probeStartedAt: Date; probeEndedAt: Date; maxGapMs?: number };

/** One copy as the stability check compares it. */
const copyKey = (c: ShadowCopy) => JSON.stringify([c.id.toLowerCase(), c.device.toLowerCase(), c.volumeName.toLowerCase(), Date.parse(c.createdAt), c.repo.exists, c.control.exists]);

/**
 * Whether the copy set stayed the same around the probe: `before` (which planned the reads) was
 * collected at most `maxGapMs` before the probe started, `after` at most `maxGapMs` after it ended,
 * both are complete and describe this computer, repo and repo volume, and they list the same copies.
 * Anything else, a missing `after` included, is inconclusive.
 */
export function judgeShadowStability(before: unknown, after: unknown, options: StabilityOptions): CheckItem {
  const no = (detail: string): CheckItem => ({ id: 'shadow-inventory-stable', status: 'inconclusive', detail: `the shadow-copy set can't be shown unchanged during the probe: ${detail}` });
  if (after === null || after === undefined) return no('no inventory was taken after the probe');
  const b = usableInventory(before, options);
  if ('problem' in b) return no(`the inventory before the probe: ${b.problem}`);
  const a = usableInventory(after, options);
  if ('problem' in a) return no(`the inventory after the probe: ${a.problem}`);
  const gap = options.maxGapMs ?? SHADOW_INVENTORY_MAX_AGE_MS;
  const start = options.probeStartedAt.getTime();
  const end = options.probeEndedAt.getTime();
  const tb = Date.parse(b.inv.collectedAt);
  const ta = Date.parse(a.inv.collectedAt);
  if (!(end >= start)) return no('the probe window is invalid');
  if (!(tb <= start && start - tb <= gap)) return no('the inventory before the probe was not taken shortly before it started');
  if (!(ta >= end && ta - end <= gap)) return no('the inventory after the probe was not taken shortly after it ended');
  if (a.inv.repoVolumeName.toLowerCase() !== b.inv.repoVolumeName.toLowerCase()) return no('the repo volume changed');
  const keysBefore = new Set(b.inv.copies.map(copyKey));
  const keysAfter = new Set(a.inv.copies.map(copyKey));
  const added = [...keysAfter].filter((k) => !keysBefore.has(k)).length;
  const removed = [...keysBefore].filter((k) => !keysAfter.has(k)).length;
  if (added > 0 || removed > 0 || keysBefore.size !== b.inv.copies.length || keysAfter.size !== a.inv.copies.length) {
    return no(`${added} copies appeared and ${removed} disappeared or changed between the two inventories`);
  }
  return { id: 'shadow-inventory-stable', status: 'pass', detail: `the same ${b.inv.copies.length} shadow copies before and after the probe (complete enumerations)` };
}

/** What a failed shadow read means; only the denial codes are evidence of enforcement. */
export type ShadowCategory = 'denied' | 'not-found' | 'invalid-device' | 'unsupported' | 'read-succeeded' | 'missing' | 'duplicate' | 'malformed';

export function categorize(result: ProbeResult): ShadowCategory {
  // Any success is a read, however odd the rest of the result: a forbidden success is never discounted.
  if (result.outcome === 'ok') return 'read-succeeded';
  if (result.sha256 !== undefined || result.count !== undefined || result.cleaned !== undefined || !result.code) return 'malformed';
  if (DENIED_CODES.has(result.code)) return 'denied';
  if (result.code === 'ENOENT' || result.code === 'ENOTDIR') return 'not-found';
  if (['EINVAL', 'ENODEV', 'ENXIO', 'EISDIR', 'ERR_INVALID_ARG_VALUE'].includes(result.code)) return 'invalid-device';
  return 'unsupported';
}

export type ShadowJudgement = { items: CheckItem[]; categories: Record<ShadowCategory, number> };

/**
 * Judges the probe's shadow results. `committedHashes` are the SHA-256s of every committed version of
 * the control file (computed by the host from git, never from a copy). `stability` is
 * judgeShadowStability's item; null means it wasn't established. A PASS needs a denial for every
 * planned read, no inconclusive inventory item, and a stable copy set.
 */
export function judgeShadowResults(plan: ShadowPlan, results: ProbeResult[], committedHashes: ReadonlySet<string>, stability: CheckItem | null): ShadowJudgement {
  const categories: Record<ShadowCategory, number> = { denied: 0, 'not-found': 0, 'invalid-device': 0, unsupported: 0, 'read-succeeded': 0, missing: 0, duplicate: 0, malformed: 0 };
  const mine = results.filter((r) => r.id.startsWith(SHADOW_ATTEMPT_PREFIX));
  const planned = new Set(plan.attempts.map((a) => a.id));
  const items: CheckItem[] = [...plan.items];
  for (const attempt of plan.attempts) {
    const copy = plan.copyOf[attempt.id];
    const got = mine.filter((r) => r.id === attempt.id);
    const base = { id: attempt.id, variant: attempt.variant, op: attempt.op };
    const kinds = got.map(categorize);
    if (kinds.includes('read-succeeded')) {
      categories['read-succeeded']++;
      const hash = got.find((r) => r.outcome === 'ok')!.sha256;
      const known = !hash ? 'no hash was reported' : committedHashes.has(hash) ? 'the content matches a committed version' : 'the content matches no committed version';
      items.push({ ...base, status: 'fail', detail: `the evaluation account READ the control file through shadow copy ${copy}; ${known}${got.length > 1 ? ` (one of ${got.length} results)` : ''}` });
      continue;
    }
    if (got.length === 0) {
      categories.missing++;
      items.push({ ...base, status: 'inconclusive', detail: `no result for shadow copy ${copy}` });
      continue;
    }
    if (got.length > 1) {
      categories.duplicate++;
      items.push({ ...base, status: 'inconclusive', detail: `${got.length} results for shadow copy ${copy}; a duplicate never counts as denied` });
      continue;
    }
    const kind = kinds[0]!;
    categories[kind]++;
    const code = got[0]!.code;
    if (kind === 'denied') items.push({ ...base, code, status: 'pass', detail: `Windows denied the read through shadow copy ${copy} (${code})` });
    else if (kind === 'malformed') items.push({ ...base, status: 'inconclusive', detail: `the result for shadow copy ${copy} has fields a failed read can't have` });
    else if (kind === 'not-found') items.push({ ...base, code, status: 'inconclusive', detail: `${code} through shadow copy ${copy}: the copy or the file was not found (deleted since the inventory?), so no denial was observed` });
    else if (kind === 'invalid-device') items.push({ ...base, code, status: 'inconclusive', detail: `${code} through shadow copy ${copy}: the device path was not usable, so no denial was observed` });
    else items.push({ ...base, code, status: 'inconclusive', detail: `${code} through shadow copy ${copy}: unsupported or unknown error, not a denial` });
  }
  const unknown = mine.filter((r) => !planned.has(r.id));
  if (unknown.length > 0) items.push({ id: 'shadow-unknown-results', status: 'inconclusive', detail: `${unknown.length} shadow results for attempts that were not planned` });
  items.push(stability ?? { id: 'shadow-inventory-stable', status: 'inconclusive', detail: 'the shadow-copy set was not confirmed unchanged during the probe' });
  return { items, categories };
}

/** The probe report without shadow results, for evaluateCheck (which judges the other attempts). */
export function withoutShadowResults(report: ProbeReport): ProbeReport {
  return { ...report, results: report.results.filter((r) => !r.id.startsWith(SHADOW_ATTEMPT_PREFIX)) };
}
