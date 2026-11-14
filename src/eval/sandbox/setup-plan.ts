import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { NAME_PATTERN, SANDBOX_MARKER } from './config.ts';

// R4b Step 1D: the decisions behind scripts/eval-sandbox/setup.ps1. The script only collects a
// read-only inventory (accounts, groups, ACLs, its own state journal) and executes the actions
// planned here; every rule about conflicts, interrupted runs, ACL scope, rollback and verification
// lives in this pure module so it is unit-tested without an account. Nothing here touches the
// system. The elevated entry point is setup-cli.ts, which imports only this module and config.ts.

// ---------------------------------------------------------------------------
// Inventory (what setup.ps1 reports; validated, never trusted blindly)

/** One access rule as Get-Acl reports it, rights and flags as numbers (FileSystemRights, InheritanceFlags, PropagationFlags). */
export const Ace = z.strictObject({
  identity: z.string(),
  sid: z.string(),
  type: z.enum(['Allow', 'Deny']),
  rights: z.number().int().nonnegative(),
  inherited: z.boolean(),
  inheritance: z.number().int().min(0).max(3),
  propagation: z.number().int().min(0).max(3),
});
export type Ace = z.infer<typeof Ace>;

export const PathInventory = z.strictObject({
  path: z.string(),
  exists: z.boolean(),
  owner: z.string().nullable(),
  ownerSid: z.string().nullable(),
  protected: z.boolean().nullable(),
  aces: z.array(Ace),
});
export type PathInventory = z.infer<typeof PathInventory>;

export const Principal = z.strictObject({
  name: z.string(),
  exists: z.boolean(),
  sid: z.string().nullable(),
  description: z.string().nullable(),
  /** Groups (as SIDs) the account belongs to; members (as SIDs) of a group. */
  memberships: z.array(z.string()),
  enabled: z.boolean().nullable(),
  profilePath: z.string().nullable(),
});
export type Principal = z.infer<typeof Principal>;

/**
 * Items under a scanned root grouped by their ACL as it matters here: folder or file, protected or
 * not, an owner that isn't trusted (null when it is), and every ACE except those of trusted
 * principals (SYSTEM, Administrators, CREATOR OWNER, the developer). Every scanned item is counted
 * in exactly one shape, so analysing the shapes covers the whole tree.
 */
export const AclShape = z.strictObject({
  container: z.boolean(),
  protected: z.boolean(),
  owner: z.string().nullable(),
  aces: z.array(Ace),
  count: z.number().int().positive(),
  samples: z.array(z.string()).max(3),
});
export type AclShape = z.infer<typeof AclShape>;

export const ChildScan = z.strictObject({
  root: z.string(),
  scanned: z.number().int().nonnegative(),
  /** Names of the root's direct children (the deny's scope). */
  topLevel: z.array(z.string()),
  topLevelTruncated: z.boolean(),
  shapes: z.array(AclShape),
  /** True when there were more distinct shapes than the scan keeps; the rest are unknown. */
  truncated: z.boolean(),
  reparsePoints: z.array(z.strictObject({ path: z.string(), target: z.string().nullable() })),
  errors: z.number().int().nonnegative(),
});
export type ChildScan = z.infer<typeof ChildScan>;

export const DenyAceRecord = z.strictObject({ path: z.string(), sid: z.string(), rights: z.number().int(), inheritance: z.number().int(), propagation: z.number().int() });
export type DenyAceRecord = z.infer<typeof DenyAceRecord>;

/** A principal this script created. `nonce` is part of its description (markerFor), chosen and journaled before creation. */
export const PrincipalRecord = z.strictObject({ name: z.string(), sid: z.string(), nonce: z.string().regex(/^[0-9a-f]{6}$/) });
export type PrincipalRecord = z.infer<typeof PrincipalRecord>;

export const ACTION_KINDS = [
  'create-group',
  'create-user',
  'add-member',
  'add-deny-ace',
  'create-folder',
  'remove-deny-ace',
  'remove-folder',
  'remove-profile',
  'remove-user',
  'remove-group',
  'remove-file',
  'resolve-pending',
  'forget-record',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** The change that was started but not confirmed: written before every mutation, cleared after it. */
export const PendingOperation = z.strictObject({
  kind: z.enum(ACTION_KINDS),
  target: z.string(),
  nonce: z.string().regex(/^[0-9a-f]{6}$/).nullable(),
  startedAt: z.string(),
});
export type PendingOperation = z.infer<typeof PendingOperation>;

/** What previous runs created (the journal). Removal touches only these objects. */
export const SetupState = z.strictObject({
  schema: z.literal(2),
  computer: z.string(),
  account: PrincipalRecord.nullable(),
  group: PrincipalRecord.nullable(),
  denyAces: z.array(DenyAceRecord),
  folders: z.array(z.string()),
  credentialFile: z.string().nullable(),
  pending: PendingOperation.nullable(),
});
export type SetupState = z.infer<typeof SetupState>;

/** The evaluation account's token as `check --account` observed it (check.ts observedToken). */
export const ObservedToken = z.strictObject({
  schema: z.literal(1),
  account: z.string(),
  userSid: z.string(),
  groups: z.array(z.strictObject({ sid: z.string(), name: z.string() })),
});
export type ObservedToken = z.infer<typeof ObservedToken>;

export const Inventory = z.strictObject({
  schema: z.literal(2),
  computer: z.string().regex(/^[A-Za-z0-9-]{1,63}$/),
  developer: z.strictObject({ name: z.string(), sid: z.string(), profile: z.string() }),
  elevated: z.boolean(),
  config: z.strictObject({
    account: z.string().regex(NAME_PATTERN),
    group: z.string().regex(NAME_PATTERN),
    root: z.string(),
    denyRoot: z.string(),
    credentialFile: z.string(),
    stateFile: z.string(),
    tokenFile: z.string(),
  }),
  account: Principal,
  group: Principal,
  /** A local group named like the account, or a local user named like the group. */
  nameCollisions: z.strictObject({ accountIsGroup: z.boolean(), groupIsUser: z.boolean() }),
  denyRoot: PathInventory,
  childScan: ChildScan,
  /** Folders that must already be private to the developer (profile, TEMP, ~/.claude); setup never changes them. */
  privateRoots: z.array(PathInventory),
  sandbox: z.strictObject({ root: PathInventory, runtime: PathInventory, work: PathInventory, reparsePoints: z.number().int().nonnegative(), runtimeScan: ChildScan }),
  credentialFileExists: z.boolean(),
  /** The user name inside the stored credential (decrypted by the developer, password never read); null if absent or unreadable. */
  credentialUserName: z.string().nullable(),
  tokenFileExists: z.boolean(),
  /** The raw token file; parsed and validated here (observedTokenOf). */
  observedTokenJson: z.string().nullable(),
  state: SetupState.nullable(),
});
export type Inventory = z.infer<typeof Inventory>;

// ---------------------------------------------------------------------------
// Rights and identities

export const RIGHTS = {
  READ_DATA: 0x1,
  WRITE_DATA: 0x2,
  APPEND_DATA: 0x4,
  DELETE_CHILD: 0x40,
  DELETE: 0x10000,
  WRITE_DAC: 0x40000,
  WRITE_OWNER: 0x80000,
  GENERIC_ALL: 0x10000000,
  GENERIC_WRITE: 0x40000000,
  GENERIC_READ: 0x80000000,
  FULL_CONTROL: 0x1f01ff,
  READ_AND_EXECUTE: 0x1200a9,
} as const;
export const INHERIT = { CONTAINER: 1, OBJECT: 2 } as const;
export const PROPAGATE = { NO_PROPAGATE: 1, INHERIT_ONLY: 2 } as const;

export const grantsRead = (rights: number): boolean => (rights & (RIGHTS.READ_DATA | RIGHTS.GENERIC_READ | RIGHTS.GENERIC_ALL)) !== 0;
export const grantsWrite = (rights: number): boolean =>
  (rights & (RIGHTS.WRITE_DATA | RIGHTS.APPEND_DATA | RIGHTS.DELETE_CHILD | RIGHTS.DELETE | RIGHTS.WRITE_DAC | RIGHTS.WRITE_OWNER | RIGHTS.GENERIC_WRITE | RIGHTS.GENERIC_ALL)) !== 0;

/**
 * Well-known SIDs a standard local account logged on interactively (CreateProcessWithLogonW) is
 * expected to carry. Not exhaustive: verification requires the token observed under the account
 * (ObservedToken), and ACEs for unclassified principals are reported until it is known.
 */
export const EVAL_TOKEN_SIDS: Record<string, string> = {
  'S-1-1-0': 'Everyone',
  'S-1-2-0': 'LOCAL',
  'S-1-2-1': 'CONSOLE LOGON',
  'S-1-5-4': 'INTERACTIVE',
  'S-1-5-3': 'BATCH',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-15': 'This Organization',
  'S-1-5-113': 'Local account',
  'S-1-5-64-10': 'NTLM Authentication',
  'S-1-5-32-545': 'BUILTIN\\Users',
};
export const ADMINISTRATORS_SID = 'S-1-5-32-544';
export const USERS_SID = 'S-1-5-32-545';
export const SYSTEM_SID = 'S-1-5-18';
/** Principals that are never in a standard interactive user's token (services, app containers, creator placeholders, Administrators). */
const NEVER_EVAL = /^(S-1-5-(18|19|20)|S-1-5-32-544|S-1-3-[0-9]+|S-1-5-(80|82|83|90|96)-[0-9-]+|S-1-15-[0-9-]+)$/;

export type EvalIdentity = {
  /** Whether an ACE names the evaluation account or a group in its (expected or observed) token. */
  matches: (ace: Ace) => boolean;
  matchesSid: (sid: string) => boolean;
  /** Whether a SID is neither the evaluation account's nor known to be outside its token. */
  unclassified: (sid: string) => boolean;
  /** The observed token, when it belongs to the inventoried account. */
  token: ObservedToken | null;
};

export function observedTokenOf(inv: Inventory): ObservedToken | null {
  if (!inv.observedTokenJson) return null;
  try {
    const parsed = ObservedToken.safeParse(JSON.parse(inv.observedTokenJson));
    if (!parsed.success) return null;
    const token = parsed.data;
    return token.account.toLowerCase() === inv.config.account.toLowerCase() && inv.account.sid !== null && token.userSid === inv.account.sid ? token : null;
  } catch {
    return null;
  }
}

/** Identities the evaluation account would match: the expected token SIDs, the observed token, the account and the group (by SID or, before they exist, by name). */
export function evalIdentity(inv: Inventory): EvalIdentity {
  const names = new Set([`${inv.computer}\\${inv.config.account}`, `${inv.computer}\\${inv.config.group}`].map((n) => n.toLowerCase()));
  const sids = new Set(Object.keys(EVAL_TOKEN_SIDS));
  for (const p of [inv.account, inv.group]) if (p.sid) sids.add(p.sid);
  const token = observedTokenOf(inv);
  if (token) for (const s of [token.userSid, ...token.groups.map((g) => g.sid)]) sids.add(s);
  const trusted = new Set([inv.developer.sid, SYSTEM_SID, ADMINISTRATORS_SID]);
  const matchesSid = (sid: string) => sids.has(sid);
  return {
    matches: (ace) => sids.has(ace.sid) || names.has(ace.identity.toLowerCase()),
    matchesSid,
    unclassified: (sid) => !matchesSid(sid) && !trusted.has(sid) && !NEVER_EVAL.test(sid),
    token,
  };
}

/** Kept for callers that only need the ACE predicate. */
export const evalPrincipals = (inv: Inventory): ((ace: Ace) => boolean) => evalIdentity(inv).matches;

export type AccessVerdict = { read: 'denied' | 'allowed' | 'none'; because: string[] };

const appliesToSelf = (ace: Ace) => (ace.propagation & PROPAGATE.INHERIT_ONLY) === 0;
const appliesToDescendants = (ace: Ace) => (ace.inheritance & (INHERIT.CONTAINER | INHERIT.OBJECT)) !== 0 && (ace.propagation & PROPAGATE.NO_PROPAGATE) === 0;

/**
 * Whether the evaluation account could read a folder (`self`) or what it inherits (`descendants`),
 * from the ACL in its canonical order: the first ACE for one of its identities that denies or grants
 * read decides. Effective, not structural: it doesn't matter how Windows split or flagged an
 * inherited copy, only which rule decides first. An approximation of the access check for planning
 * and verification; the enforcement check (check.ts, as the account) is what proves the result.
 */
export function evalReadAccess(aces: Ace[], isEval: (ace: Ace) => boolean, scope: 'self' | 'descendants'): AccessVerdict {
  const applies = scope === 'self' ? appliesToSelf : appliesToDescendants;
  const relevant = aces.filter((a) => applies(a) && isEval(a) && grantsRead(a.rights));
  const first = relevant[0];
  if (!first) return { read: 'none', because: ['no access rule grants read to the evaluation account or a group it belongs to'] };
  const describe = (a: Ace) => `${a.identity}: ${a.type} ${rightsName(a.rights)}${a.inherited ? ' (inherited)' : ' (explicit)'}`;
  if (first.type === 'Deny') return { read: 'denied', because: [describe(first)] };
  return { read: 'allowed', because: relevant.filter((a) => a.type === 'Allow').map(describe) };
}

export function rightsName(rights: number): string {
  if ((rights & RIGHTS.FULL_CONTROL) === RIGHTS.FULL_CONTROL || rights & RIGHTS.GENERIC_ALL) return 'FullControl';
  if (grantsWrite(rights) && grantsRead(rights)) return 'Modify';
  if ((rights & RIGHTS.READ_AND_EXECUTE) === RIGHTS.READ_AND_EXECUTE || rights & RIGHTS.GENERIC_READ) return 'ReadAndExecute';
  if (grantsRead(rights)) return 'Read';
  if (grantsWrite(rights)) return 'Write';
  return `0x${rights.toString(16)}`;
}

/** The description a principal created by this script carries: the marker plus the operation's nonce (at most 48 characters). */
export const markerFor = (nonce: string): string => `${SANDBOX_MARKER} #${nonce}`;

/** The deny ACE setup adds on the deny root: the group, FullControl, inherited by folders and files. */
export function plannedDenyAce(inv: Inventory, groupSid: string | null = inv.group.sid): Ace {
  return {
    identity: `${inv.computer}\\${inv.config.group}`,
    sid: groupSid ?? `unresolved:${inv.config.group}`,
    type: 'Deny',
    rights: RIGHTS.FULL_CONTROL,
    inherited: false,
    inheritance: INHERIT.CONTAINER | INHERIT.OBJECT,
    propagation: 0,
  };
}

const isPlannedDeny = (ace: Ace, inv: Inventory) =>
  ace.type === 'Deny' && !ace.inherited && (ace.rights & RIGHTS.FULL_CONTROL) === RIGHTS.FULL_CONTROL && ace.inheritance === (INHERIT.CONTAINER | INHERIT.OBJECT) && ace.propagation === 0 &&
  ((inv.group.sid !== null && ace.sid === inv.group.sid) || ace.identity.toLowerCase() === `${inv.computer}\\${inv.config.group}`.toLowerCase());

const denyRecord = (inv: Inventory, groupSid: string): DenyAceRecord => ({ path: inv.config.denyRoot, sid: groupSid, rights: RIGHTS.FULL_CONTROL, inheritance: 3, propagation: 0 });
const hasExactAce = (target: PathInventory, record: DenyAceRecord) =>
  target.aces.some((a) => a.type === 'Deny' && !a.inherited && a.sid === record.sid && a.rights === record.rights && a.inheritance === record.inheritance && a.propagation === record.propagation);

/**
 * Whether a sandbox folder has exactly the ACL setup gives it: protected (no inheritance), only
 * explicit ACEs, FullControl for SYSTEM, Administrators and the developer, plus (runtime only) the
 * group's ReadAndExecute, nothing else, and a trusted owner. A folder that doesn't match was not
 * created (or was changed) and is never treated as configured or private.
 */
export function folderMatches(inv: Inventory, folder: PathInventory, grantGroupRead: boolean, groupSid: string | null = inv.group.sid): boolean {
  if (!folder.exists || folder.protected !== true) return false;
  if (folder.ownerSid === null || ![SYSTEM_SID, ADMINISTRATORS_SID, inv.developer.sid].includes(folder.ownerSid)) return false;
  const full = [SYSTEM_SID, ADMINISTRATORS_SID, inv.developer.sid];
  const isFull = (a: Ace) => a.type === 'Allow' && !a.inherited && full.includes(a.sid) && (a.rights & RIGHTS.FULL_CONTROL) === RIGHTS.FULL_CONTROL && a.inheritance === 3 && a.propagation === 0;
  const isGroupRead = (a: Ace) => grantGroupRead && groupSid !== null && a.type === 'Allow' && !a.inherited && a.sid === groupSid && grantsRead(a.rights) && !grantsWrite(a.rights) && a.inheritance === 3 && a.propagation === 0;
  if (!folder.aces.every((a) => isFull(a) || isGroupRead(a))) return false;
  if (!full.every((sid) => folder.aces.some((a) => isFull(a) && a.sid === sid))) return false;
  return !grantGroupRead || folder.aces.some(isGroupRead);
}

// ---------------------------------------------------------------------------
// Plans

/**
 * One change setup.ps1 may make. The script maps each kind to one fixed function and re-validates
 * every field; it never evaluates text from here as code.
 */
export type Action = {
  kind: ActionKind;
  target: string;
  description: string;
  requiresElevation: boolean;
  /** create-folder: the protected ACL; true adds the group's ReadAndExecute. */
  grantGroupRead?: boolean;
  /** add-member: the group's SID or name. */
  group?: string;
  /** remove-*, resolve-pending: the SID recorded at (or observed after) creation, which must still match. */
  sid?: string;
  ace?: DenyAceRecord;
  /** resolve-pending: what happens to the interrupted operation. */
  resolution?: 'adopt' | 'discard';
  pendingKind?: ActionKind;
  nonce?: string;
  /** forget-record: which record of an object that no longer exists is cleared. */
  record?: 'account' | 'group' | 'deny-ace' | 'folder' | 'credential';
};

export type Finding = { level: 'info' | 'warning' | 'blocker'; topic: string; message: string };

export type Plan = { mode: 'apply' | 'remove'; findings: Finding[]; actions: Action[]; blocked: boolean; sha256: string };

/** The hash -Apply / -Remove must be given: binds the run to the exact actions that were reviewed. */
export function planHash(mode: Plan['mode'], actions: Action[]): string {
  return createHash('sha256').update(JSON.stringify({ mode, actions })).digest('hex');
}

function finish(mode: Plan['mode'], findings: Finding[], actions: Action[]): Plan {
  const blocked = findings.some((f) => f.level === 'blocker');
  return { mode, findings, actions: blocked ? [] : actions, blocked, sha256: planHash(mode, blocked ? [] : actions) };
}

const owned = (p: Principal, recorded: PrincipalRecord | null | undefined) =>
  p.exists && recorded != null && recorded.sid === p.sid && p.description === markerFor(recorded.nonce) && recorded.name.toLowerCase() === p.name.toLowerCase();

const sandboxFolders = (inv: Inventory): [PathInventory, boolean][] => [
  [inv.sandbox.root, false],
  [inv.sandbox.runtime, true],
  [inv.sandbox.work, false],
];

/**
 * Reconciles an operation that was journaled as started but never confirmed (the run was
 * interrupted). Only exact identities are adopted: a principal whose description carries the
 * journaled nonce, the exact deny ACE, a folder with exactly the planned ACL. A principal or folder
 * that exists without that proof is never taken over. An account whose credential wasn't stored is
 * never adopted by Apply (the password is gone): -Remove deletes it. Returns the first action and
 * the state the rest of the plan works from.
 */
export function resolvePending(inv: Inventory, mode: Plan['mode']): { action: Action | null; findings: Finding[]; state: SetupState | null } {
  const state = inv.state;
  const pending = state?.pending;
  if (!state || !pending) return { action: null, findings: [], state };
  const findings: Finding[] = [];
  const base = { kind: 'resolve-pending' as const, target: pending.target, pendingKind: pending.kind, requiresElevation: false };
  const next: SetupState = { ...state, pending: null };
  const discard = (why: string) => ({ action: { ...base, resolution: 'discard' as const, description: `Clear the interrupted ${pending.kind} on ${pending.target}: ${why}.` }, findings, state: next });
  const block = (message: string) => {
    findings.push({ level: 'blocker', topic: 'interrupted', message });
    return { action: null, findings, state };
  };
  const fq = (name: string) => `${inv.computer}\\${name}`;

  if (mode === 'apply' && /^(remove-|forget-)/.test(pending.kind)) return block(`An earlier -Remove was interrupted during ${pending.kind} on ${pending.target}; run -Remove again to finish it.`);
  switch (pending.kind) {
    case 'create-group':
    case 'create-user': {
      const isUser = pending.kind === 'create-user';
      const p = isUser ? inv.account : inv.group;
      const recorded = isUser ? state.account : state.group;
      const name = isUser ? inv.config.account : inv.config.group;
      if (!p.exists) {
        if (isUser && inv.credentialFileExists && !state.credentialFile) return block(`A credential file exists at ${inv.config.credentialFile} but the interrupted create-user created no account; remove it by hand.`);
        return discard('the object was never created');
      }
      if (!pending.nonce || !p.sid || p.description !== markerFor(pending.nonce) || (recorded !== null && recorded.sid !== p.sid)) {
        return block(`${fq(name)} exists but does not carry the interrupted operation's marker (nonce ${pending.nonce ?? 'none'}); not adopting it.`);
      }
      const record = { name, sid: p.sid, nonce: pending.nonce };
      const credentialOk = inv.credentialFileExists && inv.credentialUserName?.toLowerCase() === fq(inv.config.account).toLowerCase();
      if (isUser && mode === 'apply' && !credentialOk) {
        return block(`${fq(name)} (SID ${p.sid}) was created by the interrupted run, but its credential was not stored; the password is lost. Run -Remove to delete it, then apply again.`);
      }
      // Apply keeps only a credential that decrypts to the account; Remove takes any credential file,
      // which can only come from this operation (planning refuses a credential without its account).
      const keepCredential = isUser && (mode === 'apply' ? credentialOk : inv.credentialFileExists);
      const adopted: SetupState = isUser ? { ...next, account: record, credentialFile: keepCredential ? inv.config.credentialFile : next.credentialFile } : { ...next, group: record };
      return {
        action: { ...base, resolution: 'adopt', sid: p.sid, nonce: pending.nonce, description: `Record ${fq(name)} (SID ${p.sid}, description "${markerFor(pending.nonce)}"), created by the interrupted run${keepCredential ? ', and its credential file' : ''}.` },
        findings,
        state: adopted,
      };
    }
    case 'add-deny-ace': {
      const groupSid = state.group?.sid;
      if (!groupSid) return discard('no group was recorded, so no deny ACE can have been added');
      const record = denyRecord(inv, groupSid);
      if (pending.target.toLowerCase() !== inv.config.denyRoot.toLowerCase()) return block(`The interrupted deny ACE was for ${pending.target}; pass the same -DenyRoot.`);
      if (!hasExactAce(inv.denyRoot, record)) return discard(`the exact deny ACE is not on ${inv.config.denyRoot}`);
      if (state.denyAces.some((d) => d.path.toLowerCase() === record.path.toLowerCase() && d.sid === record.sid)) return discard('the deny ACE is already recorded');
      return {
        action: { ...base, resolution: 'adopt', ace: record, description: `Record the deny ACE for SID ${groupSid} on ${record.path}, added by the interrupted run (its propagation is checked by the scan).` },
        findings,
        state: { ...next, denyAces: [...next.denyAces, record] },
      };
    }
    case 'create-folder': {
      const entry = sandboxFolders(inv).find(([f]) => f.path.toLowerCase() === pending.target.toLowerCase());
      if (!entry) return block(`The interrupted folder ${pending.target} is not one of this run's sandbox folders; pass the same -SandboxRoot.`);
      const [folder, grant] = entry;
      if (!folder.exists) return discard('the folder was never created');
      if (state.folders.some((f) => f.toLowerCase() === folder.path.toLowerCase())) return discard('the folder is already recorded');
      if (!folderMatches(inv, folder, grant, state.group?.sid ?? null)) return block(`${folder.path} exists but does not have exactly the planned protected ACL; it is not treated as configured. Remove it by hand after checking it.`);
      return {
        action: { ...base, resolution: 'adopt', grantGroupRead: grant, description: `Record ${folder.path}, created by the interrupted run with exactly the planned protected ACL.` },
        findings,
        state: { ...next, folders: [...next.folders, folder.path] },
      };
    }
    default:
      return discard(mode === 'remove' ? 'removal is re-planned from what exists now' : 'membership is re-planned from what exists now');
  }
}

/** Findings about one scanned tree, from its ACL shapes. `expectDeny`: every inheriting item must now be denied to the evaluation account. */
export function scanFindings(scan: ChildScan, id: EvalIdentity, options: { topic: string; expectDeny: boolean }): Finding[] {
  const findings: Finding[] = [];
  const { topic } = options;
  const where = (s: AclShape) => `${s.count} ${s.container ? 'folders' : 'files'}${s.samples.length > 0 ? `, e.g. ${s.samples.join(', ')}` : ''}`;
  if (scan.errors > 0) findings.push({ level: 'blocker', topic, message: `${scan.errors} items under ${scan.root} could not be inspected; the deny's reach there is unknown.` });
  if (scan.truncated) findings.push({ level: 'blocker', topic, message: `Too many distinct ACLs under ${scan.root}; the scan kept only part of them, the rest are unknown.` });
  const unclassified = new Map<string, number>();
  let missingDeny = 0;
  for (const shape of scan.shapes) {
    const explicitRead = shape.aces.filter((a) => !a.inherited && a.type === 'Allow' && id.matches(a) && grantsRead(a.rights));
    if (explicitRead.length > 0) {
      findings.push({ level: 'blocker', topic, message: `An explicit allow (${explicitRead.map((a) => `${a.identity} ${rightsName(a.rights)}`).join(', ')}) on ${where(shape)} would override the inherited deny. Setup never rewrites child ACLs: review it by hand.` });
    }
    if (shape.owner !== null && id.matchesSid(shape.owner)) findings.push({ level: 'blocker', topic, message: `${where(shape)} are owned by ${shape.owner}, an identity of the evaluation account (owners can change the ACL).` });
    for (const a of shape.aces) if (a.type === 'Allow' && grantsRead(a.rights) && id.unclassified(a.sid)) unclassified.set(`${a.identity} (${a.sid})`, (unclassified.get(`${a.identity} (${a.sid})`) ?? 0) + shape.count);
    if (shape.protected) {
      findings.push({ level: 'warning', topic, message: `${where(shape)} don't inherit; the deny won't reach them (${evalReadAccess(shape.aces, id.matches, 'self').read === 'none' ? 'none grants the evaluation account read' : 'see the blockers'}).` });
      continue;
    }
    if (options.expectDeny) {
      const self = evalReadAccess(shape.aces, id.matches, 'self');
      const desc = shape.container ? evalReadAccess(shape.aces, id.matches, 'descendants') : null;
      if (self.read !== 'denied' || (desc !== null && desc.read !== 'denied')) {
        missingDeny += shape.count;
        findings.push({ level: 'blocker', topic, message: `The deny is not effective on ${where(shape)}: ${(self.read !== 'denied' ? self : desc!).because.join('; ')}.` });
      }
    }
  }
  if (unclassified.size > 0) {
    findings.push({
      level: id.token ? 'info' : 'warning',
      topic,
      message: `Read granted to principals outside the expected token: ${[...unclassified].slice(0, 10).map(([who, n]) => `${who} on ${n} items`).join('; ')}. ${id.token ? 'The observed token holds none of them.' : 'Unverified until the token is observed (check --account, then -Verify).'}`,
    });
  }
  if (options.expectDeny && missingDeny === 0) findings.push({ level: 'info', topic, message: `The deny is effective on every inheriting item under ${scan.root}.` });
  for (const rp of scan.reparsePoints.slice(0, 10)) {
    findings.push({ level: 'warning', topic: 'reparse-point', message: `${rp.path} is a link to ${rp.target ?? 'an unknown target'}; the deny covers the link, not the target's own ACL. Not followed by the scan.` });
  }
  findings.push({ level: 'info', topic, message: `Scanned ${scan.scanned} items under ${scan.root} (${scan.shapes.length} distinct ACLs).` });
  return findings;
}

/** Findings shared by planning and verification: the private roots and the scan under the deny root. */
function aclFindings(inv: Inventory, id: EvalIdentity, expectDeny: boolean): Finding[] {
  const findings: Finding[] = [];
  for (const root of inv.privateRoots) {
    if (!root.exists) {
      findings.push({ level: 'warning', topic: 'private-root', message: `${root.path} does not exist; nothing to protect there.` });
      continue;
    }
    const self = evalReadAccess(root.aces, id.matches, 'self');
    const desc = evalReadAccess(root.aces, id.matches, 'descendants');
    if (self.read === 'allowed' || desc.read === 'allowed') {
      findings.push({ level: 'blocker', topic: 'private-root', message: `${root.path} is readable by the evaluation account (${[...self.because, ...desc.because].join('; ')}). Setup never changes a profile ACL: fix it by hand or choose another folder.` });
    } else {
      findings.push({ level: 'info', topic: 'private-root', message: `${root.path} is private: ${self.because.join('; ')}.` });
    }
  }
  findings.push(...scanFindings(inv.childScan, id, { topic: 'child-acl', expectDeny }));
  return findings;
}

/** The deny's scope as stated in the plan (and so in its hash): every top-level entry under the deny root and the item count. */
export function denyScope(inv: Inventory): string {
  const scan = inv.childScan;
  return `Scope: everything under ${inv.config.denyRoot}, not only this repo: ${scan.scanned} items in ${scan.topLevel.length} top-level entries (${scan.topLevel.join(', ')}).`;
}

/** Plans the changes Apply would make, or stops with blockers. Idempotent: objects this script already created are left alone. */
export function planSetup(inv: Inventory): Plan {
  const findings: Finding[] = [];
  const actions: Action[] = [];
  const { config, computer } = inv;
  const id = evalIdentity(inv);
  const fq = (name: string) => `${computer}\\${name}`;

  if (config.account.toLowerCase() === inv.developer.name.split('\\').pop()!.toLowerCase()) {
    findings.push({ level: 'blocker', topic: 'account', message: 'The evaluation account cannot be the developer account.' });
  }
  if (inv.nameCollisions.accountIsGroup) findings.push({ level: 'blocker', topic: 'account', message: `A local group is named ${config.account}; users and groups share one namespace.` });
  if (inv.nameCollisions.groupIsUser) findings.push({ level: 'blocker', topic: 'group', message: `A local user is named ${config.group}; users and groups share one namespace.` });
  if (inv.state && inv.state.computer.toLowerCase() !== computer.toLowerCase()) {
    findings.push({ level: 'blocker', topic: 'state', message: `The state file belongs to computer ${inv.state.computer}.` });
    return finish('apply', findings, []);
  }
  const pending = resolvePending(inv, 'apply');
  findings.push(...pending.findings);
  if (pending.action) actions.push(pending.action);
  const state = pending.state;
  const groupSid = inv.group.sid;

  // Group
  if (!inv.group.exists) {
    if (state?.group) findings.push({ level: 'blocker', topic: 'group', message: `The recorded group ${state.group.name} no longer exists; run -Remove to clear the state first.` });
    actions.push({ kind: 'create-group', target: fq(config.group), description: `Create the local group ${fq(config.group)} (description "${SANDBOX_MARKER} #<nonce>", the nonce journaled before creation). Deny ACEs name this group.`, requiresElevation: true });
  } else if (!owned(inv.group, state?.group)) {
    findings.push({ level: 'blocker', topic: 'group', message: `A group named ${config.group} already exists and was not created by this script (description or recorded SID differs). Not taking it over.` });
  } else {
    findings.push({ level: 'info', topic: 'group', message: `${fq(config.group)} exists and was created by this script.` });
  }

  // Account
  if (!inv.account.exists) {
    if (state?.account) findings.push({ level: 'blocker', topic: 'account', message: `The recorded account ${state.account.name} no longer exists; run -Remove to clear the state first.` });
    if (inv.credentialFileExists) findings.push({ level: 'blocker', topic: 'credential', message: `A credential file already exists at ${config.credentialFile} without its account. Not overwriting it.` });
    actions.push({
      kind: 'create-user',
      target: fq(config.account),
      description: `Create the local standard user ${fq(config.account)} with a random password that is never displayed (password never expires, user may not change it, description "${SANDBOX_MARKER} #<nonce>"), and store the credential DPAPI-encrypted for ${inv.developer.name} only in ${config.credentialFile}.`,
      requiresElevation: true,
    });
  } else if (!owned(inv.account, state?.account)) {
    findings.push({ level: 'blocker', topic: 'account', message: `An account named ${config.account} already exists and was not created by this script (description or recorded SID differs). Not taking it over.` });
  } else {
    if (inv.account.memberships.includes(ADMINISTRATORS_SID)) findings.push({ level: 'blocker', topic: 'account', message: `${fq(config.account)} is a member of Administrators; the evaluation account must be a standard user.` });
    if (!inv.credentialFileExists) findings.push({ level: 'blocker', topic: 'credential', message: `${fq(config.account)} exists but its credential file is missing; the password can't be recovered. Run -Remove, then apply again.` });
    else if (inv.credentialUserName?.toLowerCase() !== fq(config.account).toLowerCase()) findings.push({ level: 'blocker', topic: 'credential', message: `The stored credential does not decrypt to ${fq(config.account)} for this user. Run -Remove, then apply again.` });
    findings.push({ level: 'info', topic: 'account', message: `${fq(config.account)} exists and was created by this script.` });
  }
  const groupRef = groupSid ?? fq(config.group);
  if (!inv.account.exists || !inv.account.memberships.includes(USERS_SID)) {
    actions.push({ kind: 'add-member', target: fq(config.account), group: USERS_SID, description: `Add ${fq(config.account)} to BUILTIN\\Users if it isn't already (needed for local logon; grants no administrator rights).`, requiresElevation: true });
  }
  if (!inv.account.exists || groupSid === null || !inv.account.memberships.includes(groupSid)) {
    actions.push({ kind: 'add-member', target: fq(config.account), group: groupRef, description: `Add ${fq(config.account)} to ${fq(config.group)} if it isn't already.`, requiresElevation: true });
  }

  // Deny root
  const root = inv.denyRoot;
  let denyPresent = false;
  if (!root.exists) {
    findings.push({ level: 'blocker', topic: 'deny-root', message: `${config.denyRoot} does not exist.` });
  } else {
    const before = { self: evalReadAccess(root.aces, id.matches, 'self'), descendants: evalReadAccess(root.aces, id.matches, 'descendants') };
    denyPresent = root.aces.some((a) => isPlannedDeny(a, inv));
    const readable = before.self.read === 'allowed' || before.descendants.read === 'allowed';
    const blocked = before.self.read === 'denied' && before.descendants.read === 'denied';
    findings.push({
      level: 'info',
      topic: 'deny-root',
      message: readable
        ? `${config.denyRoot} is NOT blocked: the evaluation account could read it today (${(before.self.read === 'allowed' ? before.self : before.descendants).because.join('; ')}).`
        : blocked
          ? `${config.denyRoot} is blocked for the evaluation account: ${before.self.because.join('; ')}.`
          : `${config.denyRoot} is not readable by the evaluation account today (no access rule grants it read), but nothing blocks it explicitly: a later grant to Users would open it.`,
    });
    if (inv.childScan.topLevelTruncated) findings.push({ level: 'blocker', topic: 'deny-root', message: `${config.denyRoot} has more top-level entries than the scan lists; the deny's scope can't be stated in full.` });
    if (!denyPresent) {
      const after = [plannedDenyAce(inv), ...root.aces];
      const simulated = { self: evalReadAccess(after, id.matches, 'self'), descendants: evalReadAccess(after, id.matches, 'descendants') };
      if (simulated.self.read !== 'denied' || simulated.descendants.read !== 'denied') {
        findings.push({ level: 'blocker', topic: 'deny-root', message: `The planned deny would not block ${config.denyRoot}; refusing.` });
      }
      actions.push({
        kind: 'add-deny-ace',
        target: config.denyRoot,
        group: groupRef,
        description: `Add one explicit Deny FullControl ACE for ${fq(config.group)} on ${config.denyRoot}, inherited by all folders and files (this folder, subfolders and files). Every existing ACE stays as it is; Windows propagates the inherited copy to children that inherit. ${denyScope(inv)} Afterwards: ${simulated.self.because.join('; ')}.`,
        requiresElevation: false,
      });
    } else {
      findings.push({ level: 'info', topic: 'deny-root', message: `The deny ACE for ${fq(config.group)} is already on ${config.denyRoot}. ${denyScope(inv)}` });
    }
  }

  // Sandbox folders
  const purposes = ['the sandbox root', 'the runtime copy (the group may read and execute)', 'evaluation workspaces (granted per run later; no group access by default)'];
  sandboxFolders(inv).forEach(([folder, grantGroupRead], i) => {
    if (folder.exists) {
      if (!state?.folders.some((f) => f.toLowerCase() === folder.path.toLowerCase())) {
        findings.push({ level: 'blocker', topic: 'sandbox', message: `${folder.path} already exists and was not created by this script. Not taking it over.` });
      } else if (!folderMatches(inv, folder, grantGroupRead)) {
        findings.push({ level: 'blocker', topic: 'sandbox', message: `${folder.path} was created by this script but its ACL is no longer exactly the planned one; check it by hand or run -Remove.` });
      }
      return;
    }
    actions.push({
      kind: 'create-folder',
      target: folder.path,
      grantGroupRead,
      description: `Create ${folder.path} for ${purposes[i]} atomically with a protected ACL (no inheritance): SYSTEM, Administrators and ${inv.developer.name} FullControl${grantGroupRead ? `, ${fq(config.group)} ReadAndExecute` : ''}.`,
      requiresElevation: false,
    });
  });

  findings.push(...aclFindings(inv, id, denyPresent && groupSid !== null));
  if (actions.some((a) => a.requiresElevation) && !inv.elevated) {
    findings.push({ level: 'info', topic: 'elevation', message: 'Creating the account and group needs an elevated PowerShell; -Apply refuses to start without it.' });
  }
  return finish('apply', findings, actions);
}

/** Plans the rollback: only objects the state file records (or the interrupted operation proves), and only while they still match. Restartable: records of objects already gone are cleared. */
export function planRemoval(inv: Inventory): Plan {
  const findings: Finding[] = [];
  const actions: Action[] = [];
  if (!inv.state) {
    const notes: Finding[] = [{ level: 'info', topic: 'state', message: 'No setup state recorded: this script created nothing to remove.' }];
    if (inv.tokenFileExists) notes.push({ level: 'info', topic: 'state', message: `${inv.config.tokenFile} exists without setup state; it holds only an observed token and is left alone.` });
    return finish('remove', notes, []);
  }
  if (inv.state.computer.toLowerCase() !== inv.computer.toLowerCase()) {
    return finish('remove', [{ level: 'blocker', topic: 'state', message: `The state file belongs to computer ${inv.state.computer}.` }], []);
  }
  const pending = resolvePending(inv, 'remove');
  findings.push(...pending.findings);
  if (pending.action) actions.push(pending.action);
  const state = pending.state!;

  for (const record of state.denyAces) {
    if (record.path.toLowerCase() !== inv.denyRoot.path.toLowerCase()) {
      findings.push({ level: 'blocker', topic: 'deny-root', message: `The recorded ACE is on ${record.path}, which this run did not inventory; pass the same -DenyRoot.` });
      continue;
    }
    if (hasExactAce(inv.denyRoot, record)) actions.push({ kind: 'remove-deny-ace', target: record.path, ace: record, description: `Remove exactly the Deny ACE this script added on ${record.path} (SID ${record.sid}); every other ACE stays.`, requiresElevation: false });
    else actions.push({ kind: 'forget-record', record: 'deny-ace', target: record.path, ace: record, description: `Clear the record of the deny ACE on ${record.path} (SID ${record.sid}), which is already gone.`, requiresElevation: false });
  }

  const folderInv = sandboxFolders(inv).map(([f]) => f);
  for (const folder of [...state.folders].sort((a, b) => b.length - a.length)) {
    const current = folderInv.find((f) => f.path.toLowerCase() === folder.toLowerCase());
    if (!current) {
      findings.push({ level: 'blocker', topic: 'sandbox', message: `${folder} is recorded but is not one of this run's sandbox folders; pass the same -SandboxRoot.` });
      continue;
    }
    if (!current.exists) {
      actions.push({ kind: 'forget-record', record: 'folder', target: folder, description: `Clear the record of ${folder}, which is already gone.`, requiresElevation: false });
      continue;
    }
    if (inv.sandbox.reparsePoints > 0) {
      findings.push({ level: 'blocker', topic: 'sandbox', message: `${inv.sandbox.root.path} contains ${inv.sandbox.reparsePoints} links (junctions or symlinks); remove them by hand first so deletion can't follow one.` });
      break;
    }
    actions.push({ kind: 'remove-folder', target: folder, description: `Delete ${folder} (created by this script) and its contents.`, requiresElevation: false });
  }

  const principal = (p: Principal, recorded: PrincipalRecord | null, kind: 'user' | 'group') => {
    if (!recorded) return;
    const record = kind === 'user' ? 'account' : 'group';
    if (!p.exists) {
      actions.push({ kind: 'forget-record', record, target: `${inv.computer}\\${recorded.name}`, sid: recorded.sid, description: `Clear the record of the local ${kind} ${recorded.name} (SID ${recorded.sid}), which no longer exists.`, requiresElevation: false });
      return;
    }
    if (p.sid !== recorded.sid || p.description !== markerFor(recorded.nonce)) {
      findings.push({ level: 'blocker', topic: kind, message: `${p.name} exists but its SID or description differs from what this script created. Not removing it.` });
      return;
    }
    if (kind === 'user' && p.profilePath) {
      actions.push({ kind: 'remove-profile', target: p.profilePath, sid: recorded.sid, description: `Delete the Windows profile of ${recorded.name} (${p.profilePath}), created at its first logon.`, requiresElevation: true });
    }
    actions.push({ kind: kind === 'user' ? 'remove-user' : 'remove-group', target: `${inv.computer}\\${recorded.name}`, sid: recorded.sid, description: `Delete the local ${kind} ${recorded.name} (SID ${recorded.sid}).`, requiresElevation: true });
  };
  principal(inv.account, state.account, 'user');
  principal(inv.group, state.group, 'group');

  if (state.credentialFile) {
    if (state.credentialFile.toLowerCase() !== inv.config.credentialFile.toLowerCase()) findings.push({ level: 'blocker', topic: 'credential', message: `The recorded credential ${state.credentialFile} is not the configured one; not deleting it.` });
    else if (inv.credentialFileExists) actions.push({ kind: 'remove-file', target: state.credentialFile, description: `Delete the stored credential ${state.credentialFile}.`, requiresElevation: false });
    else actions.push({ kind: 'forget-record', record: 'credential', target: state.credentialFile, description: `Clear the record of ${state.credentialFile}, which is already gone.`, requiresElevation: false });
  }
  if (inv.tokenFileExists) actions.push({ kind: 'remove-file', target: inv.config.tokenFile, description: `Delete the observed token ${inv.config.tokenFile} (it describes the account being removed).`, requiresElevation: false });
  return finish('remove', findings, actions);
}

// ---------------------------------------------------------------------------
// Verification (read-only, after Apply)

export type VerifyCheck = { id: string; ok: boolean; detail: string };
export type VerifyReport = { ok: boolean; checks: VerifyCheck[] };

/**
 * Structural checks of the applied state (ACLs as recorded and propagated, accounts, the observed
 * token). They predict, but do not prove, what Windows enforces: `check --account` proves it by
 * attempting the forbidden reads as the account itself.
 */
export function verifySetup(inv: Inventory): VerifyReport {
  const checks: VerifyCheck[] = [];
  const id = evalIdentity(inv);
  const add = (checkId: string, ok: boolean, detail: string) => checks.push({ id: checkId, ok, detail });
  const { account, group, config } = inv;
  const fq = (name: string) => `${inv.computer}\\${name}`;

  add('state-complete', inv.state !== null && inv.state.pending === null, inv.state === null ? 'no setup state' : inv.state.pending ? `an interrupted ${inv.state.pending.kind} on ${inv.state.pending.target}; run the plan again` : 'no interrupted operation');
  add('account-owned', owned(account, inv.state?.account), account.exists ? `${account.name}: description ${inv.state?.account && account.description === markerFor(inv.state.account.nonce) ? 'matches' : 'differs'}, SID ${account.sid === inv.state?.account?.sid ? 'recorded' : 'not recorded'}` : 'missing');
  add('account-enabled', account.enabled === true, `enabled = ${account.enabled}`);
  add('account-standard', account.exists && !account.memberships.includes(ADMINISTRATORS_SID), 'not a member of Administrators');
  add('account-users', account.memberships.includes(USERS_SID), 'member of BUILTIN\\Users');
  add('group-owned', owned(group, inv.state?.group), group.exists ? `${group.name}` : 'missing');
  add('account-in-group', group.sid !== null && account.memberships.includes(group.sid), `member of ${config.group}`);
  const credentialOk = inv.credentialFileExists && inv.credentialUserName?.toLowerCase() === fq(config.account).toLowerCase();
  add('credential', credentialOk, inv.credentialFileExists ? `credential file decrypts to ${credentialOk ? 'the account' : 'something else'} (password never read)` : 'credential file missing');

  const token = id.token;
  const tokenProblems: string[] = [];
  if (!token) tokenProblems.push(inv.tokenFileExists ? 'the token file is invalid or belongs to another account' : 'not observed yet: run check --account, then -Verify again');
  else {
    if (group.sid === null || !token.groups.some((g) => g.sid === group.sid)) tokenProblems.push(`${config.group} is not in the token`);
    if (token.groups.some((g) => g.sid === ADMINISTRATORS_SID)) tokenProblems.push('Administrators is in the token');
  }
  add('token-observed', tokenProblems.length === 0, tokenProblems.length === 0 ? `${token!.groups.length} groups observed; the ACL analysis used them` : tokenProblems.join('; '));

  const root = inv.denyRoot;
  add('deny-ace', root.aces.some((a) => isPlannedDeny(a, inv)), `explicit deny for ${config.group} on ${config.denyRoot}`);
  const self = evalReadAccess(root.aces, id.matches, 'self');
  const desc = evalReadAccess(root.aces, id.matches, 'descendants');
  add('deny-root-blocked', self.read === 'denied' && desc.read === 'denied', `${config.denyRoot}: ${self.because.join('; ')}`);
  const scan = scanFindings(inv.childScan, id, { topic: 'child-acl', expectDeny: true });
  const notReached = scan.filter((f) => f.level === 'blocker' && f.message.startsWith('The deny is not effective'));
  add('deny-propagated', notReached.length === 0 && inv.childScan.errors === 0 && !inv.childScan.truncated, notReached.length === 0 ? `effective on every inheriting item of ${inv.childScan.scanned}` : notReached.map((f) => f.message).join(' | '));
  const other = [...aclFindings(inv, id, true).filter((f) => f.level === 'blocker' && !f.message.startsWith('The deny is not effective'))];
  add('acl-scan', other.length === 0, other.length === 0 ? 'private roots private, no explicit allows or evaluation-owned items under the deny root, scan complete' : other.map((b) => b.message).join(' | '));

  for (const [folder, grant] of sandboxFolders(inv)) {
    const ok = folderMatches(inv, folder, grant);
    add(`folder:${path.win32.basename(folder.path)}`, ok, `${folder.path}: ${folder.exists ? `${folder.protected ? 'protected' : 'inherits'}, ${folder.aces.length} ACEs, ${ok ? 'exactly as planned' : 'NOT as planned'}` : 'missing'}`);
  }
  const runtime = runtimeAclProblems(inv.sandbox.runtimeScan, id);
  add('runtime-acl', runtime.length === 0, runtime.length === 0 ? `${inv.sandbox.runtimeScan.scanned} items: inherited group read only, no write, trusted owners` : runtime.join(' | '));
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * What the staged runtime must look like to the evaluation account: every item inherits from the
 * runtime folder (no protected ACLs, no explicit ACEs), a trusted owner, read through its group
 * and no write, delete or ACL rights at all. Applies to an empty runtime too (nothing staged yet).
 */
export function runtimeAclProblems(scan: ChildScan, id: EvalIdentity): string[] {
  const problems: string[] = [];
  const where = (s: AclShape) => `${s.count} ${s.container ? 'folders' : 'files'}${s.samples.length > 0 ? ` (e.g. ${s.samples[0]})` : ''}`;
  if (scan.errors > 0) problems.push(`${scan.errors} items could not be inspected`);
  if (scan.truncated) problems.push('too many distinct ACLs; scan incomplete');
  if (scan.reparsePoints.length > 0) problems.push(`${scan.reparsePoints.length} links in the runtime`);
  for (const shape of scan.shapes) {
    if (shape.protected) problems.push(`${where(shape)} don't inherit`);
    if (shape.aces.some((a) => !a.inherited)) problems.push(`${where(shape)} have explicit ACEs`);
    if (shape.owner !== null) problems.push(`${where(shape)} are owned by ${shape.owner}, not a trusted principal`);
    const writable = shape.aces.filter((a) => a.type === 'Allow' && (id.matches(a) || id.unclassified(a.sid)) && grantsWrite(a.rights));
    if (writable.length > 0) problems.push(`${where(shape)} are writable by ${writable.map((a) => a.identity).join(', ')}`);
    if (evalReadAccess(shape.aces, id.matches, 'self').read !== 'allowed') problems.push(`${where(shape)} are not readable by the evaluation account`);
  }
  return problems;
}
