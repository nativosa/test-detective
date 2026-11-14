import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { REPO_ROOT, SANDBOX_MARKER, SETUP_SCRIPT } from '../sandbox/config.ts';
import { ADMINISTRATORS_SID, evalIdentity, evalPrincipals, evalReadAccess, INHERIT, Inventory, markerFor, planHash, planRemoval, planSetup, PROPAGATE, RIGHTS, USERS_SID, verifySetup } from '../sandbox/setup-plan.ts';
import type { AclShape, Ace, ActionKind, ChildScan, PathInventory, Plan, Principal, SetupState } from '../sandbox/setup-plan.ts';

// R4b Step 1D: the setup planner (pure, synthetic inventories, ACLs and tokens) and setup.ps1's
// no-mutation modes. No account, group or ACL is ever created or changed here; the PowerShell runs
// use disposable folders and a disposable LOCALAPPDATA.

const exec = promisify(execFile);
const PC = 'TESTPC';
const DEV_SID = 'S-1-5-21-1-2-3-1001';
const GROUP_SID = 'S-1-5-21-1-2-3-2001';
const ACCOUNT_SID = 'S-1-5-21-1-2-3-2002';
const G_NONCE = 'a1b2c3';
const U_NONCE = 'd4e5f6';
const FULL3 = INHERIT.CONTAINER | INHERIT.OBJECT;

const ace = (identity: string, sid: string, type: 'Allow' | 'Deny', rights: number, inherited = true, inheritance: number = FULL3, propagation = 0): Ace => ({ identity, sid, type, rights, inherited, inheritance, propagation });
const users = (inherited = true, inheritance: number = FULL3) => ace('BUILTIN\\Users', USERS_SID, 'Allow', RIGHTS.READ_AND_EXECUTE, inherited, inheritance);
const authUsers = (inheritance: number = FULL3) => ace('NT AUTHORITY\\Authenticated Users', 'S-1-5-11', 'Allow', 0x1301bf, true, inheritance);
const system = ace('NT AUTHORITY\\SYSTEM', 'S-1-5-18', 'Allow', RIGHTS.FULL_CONTROL);
const admins = ace('BUILTIN\\Administrators', ADMINISTRATORS_SID, 'Allow', RIGHTS.FULL_CONTROL);
const dev = ace(`${PC}\\dev`, DEV_SID, 'Allow', RIGHTS.FULL_CONTROL);
const groupAce = (type: 'Allow' | 'Deny', rights: number, inherited: boolean, inheritance: number = FULL3, propagation = 0) => ace(`${PC}\\td-eval-sandbox`, GROUP_SID, type, rights, inherited, inheritance, propagation);
const pathInv = (p: string, aces: Ace[], exists = true, isProtected: boolean | null = false, ownerSid: string | null = DEV_SID): PathInventory => ({ path: p, exists, owner: exists ? `${PC}\\dev` : null, ownerSid: exists ? ownerSid : null, protected: exists ? isProtected : null, aces: exists ? [...aces] : [] });
const missing = (name: string): Principal => ({ name, exists: false, sid: null, description: null, memberships: [], enabled: null, profilePath: null });
const shape = (container: boolean, aces: Ace[], count: number, edit: Partial<AclShape> = {}): AclShape => ({ container, protected: false, owner: null, aces, count, samples: [`C:\\GIT\\x\\${container ? 'dir' : 'file'}${count}`], ...edit });
const scan = (root: string, shapes: AclShape[], edit: Partial<ChildScan> = {}): ChildScan => ({ root, scanned: shapes.reduce((n, s) => n + s.count, 0), topLevel: root === 'C:\\GIT' ? ['other-repo', 'test-detective'] : [], topLevelTruncated: false, shapes, truncated: false, reparsePoints: [], errors: 0, ...edit });
// Children of C:\GIT today: Users and Authenticated Users inherited from C:\ (files carry the copies without inheritance flags).
const openChildren = () => [shape(true, [users(), authUsers()], 400), shape(false, [users(true, 0), authUsers(0)], 600)];
// After the deny: the inherited copy of the group's deny comes first (nearer parent).
const deniedChildren = () => [shape(true, [groupAce('Deny', RIGHTS.FULL_CONTROL, true), users(), authUsers()], 400), shape(false, [groupAce('Deny', RIGHTS.FULL_CONTROL, true, 0), users(true, 0), authUsers(0)], 600)];
const TOKEN = { schema: 1, account: 'td-eval', userSid: ACCOUNT_SID, groups: [['Everyone', 'S-1-1-0'], ['BUILTIN\\Users', USERS_SID], ['NT AUTHORITY\\INTERACTIVE', 'S-1-5-4'], ['NT AUTHORITY\\Local account', 'S-1-5-113'], [`${PC}\\td-eval-sandbox`, GROUP_SID]].map(([name, sid]) => ({ name: name!, sid: sid! })) };

function inventory(edit: (inv: Inventory) => void = () => {}): Inventory {
  const inv: Inventory = {
    schema: 2,
    computer: PC,
    developer: { name: `${PC}\\dev`, sid: DEV_SID, profile: 'C:\\Users\\dev' },
    elevated: false,
    config: {
      account: 'td-eval',
      group: 'td-eval-sandbox',
      root: 'C:\\td-eval',
      denyRoot: 'C:\\GIT',
      credentialFile: 'C:\\Users\\dev\\AppData\\Local\\test-detective\\eval-account.xml',
      stateFile: 'C:\\Users\\dev\\AppData\\Local\\test-detective\\eval-sandbox-state.json',
      tokenFile: 'C:\\Users\\dev\\AppData\\Local\\test-detective\\eval-token.json',
    },
    account: missing('td-eval'),
    group: missing('td-eval-sandbox'),
    nameCollisions: { accountIsGroup: false, groupIsUser: false },
    // As on the development machine: inherited from C:\ (Users ReadAndExecute, Authenticated Users Modify).
    denyRoot: pathInv('C:\\GIT', [admins, system, users(), authUsers()]),
    childScan: scan('C:\\GIT', openChildren()),
    privateRoots: ['C:\\Users\\dev', 'C:\\Users\\dev\\.claude', 'C:\\Users\\dev\\AppData\\Local\\Temp'].map((p) => pathInv(p, [system, dev])),
    sandbox: { root: pathInv('C:\\td-eval', [], false), runtime: pathInv('C:\\td-eval\\runtime', [], false), work: pathInv('C:\\td-eval\\work', [], false), reparsePoints: 0, runtimeScan: scan('C:\\td-eval\\runtime', []) },
    credentialFileExists: false,
    credentialUserName: null,
    tokenFileExists: false,
    observedTokenJson: null,
    state: null,
  };
  edit(inv);
  return inv;
}

const fullAces = () => [{ ...system, inherited: false }, { ...admins, inherited: false }, { ...dev, inherited: false }];
const emptyState = (): SetupState => ({ schema: 2, computer: PC, account: null, group: null, denyAces: [], folders: [], credentialFile: null, pending: null });

/** The inventory after a successful Apply, a staged runtime and an observed token. */
function applied(edit: (inv: Inventory) => void = () => {}): Inventory {
  return inventory((inv) => {
    inv.group = { name: 'td-eval-sandbox', exists: true, sid: GROUP_SID, description: markerFor(G_NONCE), memberships: [ACCOUNT_SID], enabled: null, profilePath: null };
    inv.account = { name: 'td-eval', exists: true, sid: ACCOUNT_SID, description: markerFor(U_NONCE), memberships: [USERS_SID, GROUP_SID], enabled: true, profilePath: 'C:\\Users\\td-eval' };
    inv.credentialFileExists = true;
    inv.credentialUserName = `${PC}\\td-eval`;
    inv.tokenFileExists = true;
    inv.observedTokenJson = JSON.stringify(TOKEN);
    inv.denyRoot.aces = [groupAce('Deny', RIGHTS.FULL_CONTROL, false), ...inv.denyRoot.aces];
    inv.childScan = scan('C:\\GIT', deniedChildren());
    inv.sandbox = {
      root: pathInv('C:\\td-eval', fullAces(), true, true),
      runtime: pathInv('C:\\td-eval\\runtime', [...fullAces(), groupAce('Allow', RIGHTS.READ_AND_EXECUTE, false)], true, true),
      work: pathInv('C:\\td-eval\\work', fullAces(), true, true),
      reparsePoints: 0,
      runtimeScan: scan('C:\\td-eval\\runtime', [shape(true, [groupAce('Allow', RIGHTS.READ_AND_EXECUTE, true)], 40), shape(false, [groupAce('Allow', RIGHTS.READ_AND_EXECUTE, true, 0)], 974)]),
    };
    inv.state = {
      ...emptyState(),
      account: { name: 'td-eval', sid: ACCOUNT_SID, nonce: U_NONCE },
      group: { name: 'td-eval-sandbox', sid: GROUP_SID, nonce: G_NONCE },
      denyAces: [{ path: 'C:\\GIT', sid: GROUP_SID, rights: RIGHTS.FULL_CONTROL, inheritance: 3, propagation: 0 }],
      folders: ['C:\\td-eval', 'C:\\td-eval\\runtime', 'C:\\td-eval\\work'],
      credentialFile: inv.config.credentialFile,
    };
    edit(inv);
  });
}

const blockers = (plan: { findings: { level: string; message: string }[] }) => plan.findings.filter((f) => f.level === 'blocker').map((f) => f.message);
const kinds = (plan: Plan) => plan.actions.map((a) => a.kind);
const failed = (inv: Inventory) => verifySetup(inv).checks.filter((c) => !c.ok).map((c) => c.id);
const pending = (kind: ActionKind, target: string, nonce: string | null = null) => ({ kind, target, nonce, startedAt: '2026-11-14T00:00:00.000Z' });

describe('ACL access analysis', () => {
  const isEval = evalPrincipals(inventory());

  test('the development machine case: C:\\GIT is readable through inherited Users and Authenticated Users rules', () => {
    const verdict = evalReadAccess(inventory().denyRoot.aces, isEval, 'self');
    assert.equal(verdict.read, 'allowed');
    assert.match(verdict.because.join(';'), /BUILTIN\\Users: Allow ReadAndExecute \(inherited\)/);
    assert.match(verdict.because.join(';'), /Authenticated Users: Allow Modify/);
  });

  test('an explicit deny ahead of the inherited allows blocks the folder and everything it passes on', () => {
    const aces = [ace(`${PC}\\td-eval-sandbox`, 'unresolved', 'Deny', RIGHTS.FULL_CONTROL, false), ...inventory().denyRoot.aces];
    assert.equal(evalReadAccess(aces, isEval, 'self').read, 'denied');
    assert.equal(evalReadAccess(aces, isEval, 'descendants').read, 'denied');
  });

  test('inherit-only rules skip the folder itself; no-propagate rules and non-inheritable rules skip descendants', () => {
    assert.equal(evalReadAccess([ace('BUILTIN\\Users', USERS_SID, 'Allow', RIGHTS.READ_AND_EXECUTE, true, 3, PROPAGATE.INHERIT_ONLY)], isEval, 'self').read, 'none');
    assert.equal(evalReadAccess([ace('BUILTIN\\Users', USERS_SID, 'Allow', RIGHTS.READ_AND_EXECUTE, true, 3, PROPAGATE.NO_PROPAGATE)], isEval, 'descendants').read, 'none');
    assert.equal(evalReadAccess([ace('BUILTIN\\Users', USERS_SID, 'Allow', RIGHTS.READ_AND_EXECUTE, true, 0)], isEval, 'descendants').read, 'none');
  });

  test('generic rights count (GENERIC_READ as stored by some installers); the developer and SYSTEM never count as the evaluation account', () => {
    assert.equal(evalReadAccess([ace('Everyone', 'S-1-1-0', 'Allow', RIGHTS.GENERIC_READ)], isEval, 'self').read, 'allowed');
    assert.equal(evalReadAccess([system, dev], isEval, 'self').read, 'none');
  });

  test('I3: Local account and NTLM Authentication are part of the expected token; the observed token adds its own groups', () => {
    for (const [name, sid] of [['NT AUTHORITY\\Local account', 'S-1-5-113'], ['NT AUTHORITY\\NTLM Authentication', 'S-1-5-64-10']]) {
      assert.equal(evalReadAccess([ace(name!, sid!, 'Allow', RIGHTS.READ_AND_EXECUTE, false)], isEval, 'self').read, 'allowed', name);
    }
    const extra = 'S-1-5-21-1-2-3-3333';
    const withToken = applied((inv) => (inv.observedTokenJson = JSON.stringify({ ...TOKEN, groups: [...TOKEN.groups, { name: `${PC}\\other`, sid: extra }] })));
    assert.equal(evalIdentity(withToken).matchesSid(extra), true, 'a group seen in the real token counts');
    assert.equal(evalIdentity(applied()).matchesSid(extra), false);
    assert.equal(evalIdentity(applied()).unclassified(extra), true, 'neither known to be in nor out of the token');
    assert.equal(evalIdentity(applied((inv) => (inv.observedTokenJson = JSON.stringify({ ...TOKEN, userSid: 'S-1-5-21-9-9-9-9' })))).token, null, 'a token of another account is ignored');
  });
});

describe('setup plan (dry-run planning)', () => {
  test('a fresh machine: group, standard user, memberships, one deny ACE on C:\\GIT, three protected folders', () => {
    const plan = planSetup(inventory());
    assert.equal(plan.blocked, false);
    assert.deepEqual(kinds(plan), ['create-group', 'create-user', 'add-member', 'add-member', 'add-deny-ace', 'create-folder', 'create-folder', 'create-folder']);
    assert.deepEqual(plan.actions.filter((a) => a.requiresElevation).map((a) => a.kind), ['create-group', 'create-user', 'add-member', 'add-member']);
    assert.equal(plan.actions[2]!.group, USERS_SID);
    assert.match(plan.findings.find((f) => f.topic === 'deny-root')!.message, /C:\\GIT is NOT blocked: the evaluation account could read it today \(BUILTIN\\Users: Allow ReadAndExecute \(inherited\)/);
    const deny = plan.actions.find((a) => a.kind === 'add-deny-ace')!;
    assert.match(deny.description, /Every existing ACE stays as it is/);
    assert.match(deny.description, /Afterwards: TESTPC\\td-eval-sandbox: Deny FullControl \(explicit\)/);
    assert.deepEqual(plan.actions.filter((a) => a.kind === 'create-folder').map((a) => [a.target, a.grantGroupRead]), [['C:\\td-eval', false], ['C:\\td-eval\\runtime', true], ['C:\\td-eval\\work', false]]);
    assert.match(plan.actions.find((a) => a.kind === 'create-folder')!.description, /atomically with a protected ACL/);
    assert.ok(plan.findings.some((f) => f.topic === 'elevation'), 'says Apply needs elevation');
    for (const a of plan.actions) assert.doesNotMatch(JSON.stringify(a), /password\s*[:=]/i, 'no secret in any action');
  });

  test('the plan hash binds the reviewed actions: same inventory, same hash; any change, another hash', () => {
    const a = planSetup(inventory());
    assert.equal(planSetup(inventory()).sha256, a.sha256);
    assert.equal(a.sha256, planHash('apply', a.actions));
    assert.notEqual(planSetup(inventory((inv) => (inv.config.denyRoot = inv.denyRoot.path = 'C:\\Work'))).sha256, a.sha256);
    assert.equal(planSetup(inventory((inv) => (inv.elevated = true))).sha256, a.sha256, 'the elevated run reproduces the reviewed hash');
  });

  test('I9: the deny scope (every top-level entry and the item count under C:\\GIT) is in the plan and its hash; a changed scope is refused', () => {
    const plan = planSetup(inventory());
    assert.match(plan.actions.find((a) => a.kind === 'add-deny-ace')!.description, /Scope: everything under C:\\GIT, not only this repo: 1000 items in 2 top-level entries \(other-repo, test-detective\)\./);
    assert.notEqual(planSetup(inventory((inv) => inv.childScan.topLevel.push('new-repo'))).sha256, plan.sha256, 'a new repo next to this one changes the hash');
    assert.notEqual(planSetup(inventory((inv) => (inv.childScan.scanned += 1))).sha256, plan.sha256, 'one more item changes the hash');
    assert.match(blockers(planSetup(inventory((inv) => (inv.childScan.topLevelTruncated = true)))).join(), /scope can't be stated in full/);
  });

  test('an existing account or group not created by this script stops the plan; nothing is taken over', () => {
    const foreignUser = planSetup(inventory((inv) => (inv.account = { ...missing('td-eval'), exists: true, sid: 'S-1-5-21-9-9-9-1', description: 'someone else' })));
    assert.equal(foreignUser.blocked, true);
    assert.deepEqual(foreignUser.actions, []);
    assert.match(blockers(foreignUser).join(), /already exists and was not created by this script/);
    const markerOnly = planSetup(inventory((inv) => (inv.group = { ...missing('td-eval-sandbox'), exists: true, sid: 'S-1-5-21-9-9-9-2', description: markerFor(G_NONCE) })));
    assert.equal(markerOnly.blocked, true, 'the marker alone is not enough without the recorded SID');
    const plainMarker = planSetup(applied((inv) => (inv.group.description = SANDBOX_MARKER)));
    assert.equal(plainMarker.blocked, true, 'the recorded nonce must be in the description');
  });

  test('a local user named like the group, or a group named like the account, stops the plan before anything is created', () => {
    assert.match(blockers(planSetup(inventory((inv) => (inv.nameCollisions.accountIsGroup = true)))).join(), /A local group is named td-eval/);
    assert.match(blockers(planSetup(inventory((inv) => (inv.nameCollisions.groupIsUser = true)))).join(), /A local user is named td-eval-sandbox/);
  });

  test('re-running after a complete Apply plans nothing; a partial Apply resumes only what is missing', () => {
    assert.deepEqual(planSetup(applied()).actions, []);
    assert.equal(planSetup(applied()).blocked, false);
    const partial = planSetup(applied((inv) => {
      inv.denyRoot.aces = inv.denyRoot.aces.slice(1);
      inv.childScan = scan('C:\\GIT', openChildren());
      inv.state!.denyAces = [];
      inv.account.memberships = [USERS_SID];
    }));
    assert.deepEqual(kinds(partial), ['add-member', 'add-deny-ace']);
    assert.equal(partial.actions[0]!.group, GROUP_SID);
  });

  test('an owned account that is an administrator, or whose credential is gone or decrypts to another name, stops the plan', () => {
    assert.match(blockers(planSetup(applied((inv) => inv.account.memberships.push(ADMINISTRATORS_SID)))).join(), /must be a standard user/);
    assert.match(blockers(planSetup(applied((inv) => (inv.credentialFileExists = false)))).join(), /credential file is missing/);
    assert.match(blockers(planSetup(applied((inv) => (inv.credentialUserName = `${PC}\\someone`)))).join(), /does not decrypt to TESTPC\\td-eval/);
    assert.match(blockers(planSetup(inventory((inv) => (inv.credentialFileExists = true)))).join(), /credential file already exists/);
    assert.match(blockers(planSetup(inventory((inv) => (inv.config.account = 'dev')))).join(), /cannot be the developer account/);
  });

  test('explicit allows under C:\\GIT for any identity of the evaluation account (also Local account) stop the plan instead of being rewritten', () => {
    const plan = planSetup(inventory((inv) => {
      inv.childScan = scan('C:\\GIT', [...openChildren(), shape(false, [users(false, 0), users(true, 0)], 2), shape(false, [ace('NT AUTHORITY\\Local account', 'S-1-5-113', 'Allow', RIGHTS.READ_AND_EXECUTE, false, 0)], 1), shape(false, [{ ...dev, inherited: false, inheritance: 0 }], 5)]);
    }));
    assert.equal(plan.blocked, true);
    assert.equal(blockers(plan).length, 2, 'the Users and Local account grants block; a developer-only grant is never in a shape');
    assert.match(blockers(plan)[0]!, /explicit allow \(BUILTIN\\Users ReadAndExecute\) on 2 files, e\.g\. C:\\GIT\\x\\file2/);
    assert.match(blockers(plan)[1]!, /Local account/);
  });

  test('an incomplete scan stops the plan; protected items, items owned by the account and links are reported', () => {
    assert.match(blockers(planSetup(inventory((inv) => (inv.childScan.truncated = true)))).join(), /Too many distinct ACLs/);
    assert.match(blockers(planSetup(inventory((inv) => (inv.childScan.errors = 3)))).join(), /3 items under C:\\GIT could not be inspected/);
    const plan = planSetup(inventory((inv) => {
      inv.childScan = scan('C:\\GIT', [...openChildren(), shape(true, [], 1, { protected: true })], { reparsePoints: [{ path: 'C:\\GIT\\link', target: 'D:\\elsewhere' }] });
    }));
    assert.equal(plan.blocked, false);
    assert.ok(plan.findings.some((f) => f.level === 'warning' && /don't inherit/.test(f.message)));
    assert.ok(plan.findings.some((f) => f.level === 'warning' && /link to D:\\elsewhere/.test(f.message)));
    assert.match(blockers(planSetup(applied((inv) => inv.childScan.shapes.push(shape(false, deniedChildren()[1]!.aces, 1, { owner: ACCOUNT_SID }))))).join(), /owned by S-1-5-21-1-2-3-2002/);
  });

  test('I3: read granted to an unclassified principal is reported until the observed token decides', () => {
    const other = ace('TESTPC\\helpers', 'S-1-5-21-1-2-3-4444', 'Allow', RIGHTS.READ_AND_EXECUTE, false, 0);
    const before = planSetup(inventory((inv) => inv.childScan.shapes.push(shape(false, [other], 3))));
    assert.ok(before.findings.some((f) => f.level === 'warning' && /principals outside the expected token: TESTPC\\helpers \(S-1-5-21-1-2-3-4444\) on 3 items\. Unverified/.test(f.message)));
    const known = applied((inv) => inv.childScan.shapes.push(shape(false, [other, ...deniedChildren()[1]!.aces], 3)));
    assert.ok(planSetup(known).findings.some((f) => f.level === 'info' && /observed token holds none of them/.test(f.message)));
    const inToken = applied((inv) => {
      inv.childScan.shapes.push(shape(false, [other, ...deniedChildren()[1]!.aces], 3));
      inv.observedTokenJson = JSON.stringify({ ...TOKEN, groups: [...TOKEN.groups, { name: 'TESTPC\\helpers', sid: other.sid }] });
    });
    assert.match(blockers(planSetup(inToken)).join(), /explicit allow \(TESTPC\\helpers ReadAndExecute\)/, 'once the token shows the group, its grant overrides the deny');
  });

  test('the developer profile, ~/.claude and TEMP must already be private; setup never changes them', () => {
    const plan = planSetup(inventory((inv) => inv.privateRoots[2]!.aces.push(users())));
    assert.equal(plan.blocked, true);
    assert.match(blockers(plan).join(), /Temp is readable by the evaluation account .*Setup never changes a profile ACL/);
  });

  test('a sandbox folder that exists without being recorded, or a recorded one whose ACL changed, is never treated as configured', () => {
    assert.match(blockers(planSetup(inventory((inv) => (inv.sandbox.root = pathInv('C:\\td-eval', [system]))))).join(), /C:\\td-eval already exists/);
    assert.match(blockers(planSetup(applied((inv) => inv.sandbox.work.aces.push(users(false))))).join(), /C:\\td-eval\\work was created by this script but its ACL is no longer exactly the planned one/);
    assert.match(blockers(planSetup(applied((inv) => (inv.sandbox.root.protected = false)))).join(), /C:\\td-eval was created/);
  });
});

describe('I1: interrupted runs are reconciled from the journal (before and after every mutation)', () => {
  /** A machine where the run stopped after `done` and before (or during) `kind`. */
  const at = (kind: ActionKind, target: string, nonce: string | null, edit: (inv: Inventory) => void) =>
    inventory((inv) => {
      inv.state = { ...emptyState(), pending: pending(kind, target, nonce) };
      edit(inv);
    });
  const groupMade = (inv: Inventory, description = markerFor(G_NONCE)) => (inv.group = { name: 'td-eval-sandbox', exists: true, sid: GROUP_SID, description, memberships: [], enabled: null, profilePath: null });
  const groupRecorded = (inv: Inventory) => {
    groupMade(inv);
    inv.state!.group = { name: 'td-eval-sandbox', sid: GROUP_SID, nonce: G_NONCE };
  };
  const userMade = (inv: Inventory) => (inv.account = { name: 'td-eval', exists: true, sid: ACCOUNT_SID, description: markerFor(U_NONCE), memberships: [USERS_SID], enabled: true, profilePath: null });
  const resolution = (plan: Plan) => plan.actions[0]?.kind === 'resolve-pending' ? plan.actions[0].resolution : null;

  test('create-group: not created -> discarded and planned again; created -> adopted by its nonce; any other group -> refused', () => {
    const before = planSetup(at('create-group', 'TESTPC\\td-eval-sandbox', G_NONCE, () => {}));
    assert.equal(resolution(before), 'discard');
    assert.equal(kinds(before)[1], 'create-group');
    const after = planSetup(at('create-group', 'TESTPC\\td-eval-sandbox', G_NONCE, (inv) => groupMade(inv)));
    assert.equal(resolution(after), 'adopt');
    assert.equal(after.actions[0]!.sid, GROUP_SID);
    assert.ok(!kinds(after).includes('create-group'));
    assert.equal(after.blocked, false);
    for (const description of [markerFor('ffffff'), SANDBOX_MARKER, 'something else']) {
      const foreign = planSetup(at('create-group', 'TESTPC\\td-eval-sandbox', G_NONCE, (inv) => groupMade(inv, description)));
      assert.match(blockers(foreign).join(), /does not carry the interrupted operation's marker/, description);
    }
  });

  test('create-user: not created -> planned again; created with its credential stored -> adopted; created without it -> Apply refuses, Remove deletes it', () => {
    const before = planSetup(at('create-user', 'TESTPC\\td-eval', U_NONCE, groupRecorded));
    assert.equal(resolution(before), 'discard');
    assert.ok(kinds(before).includes('create-user'));
    const stored = (inv: Inventory) => {
      groupRecorded(inv);
      userMade(inv);
      inv.credentialFileExists = true;
      inv.credentialUserName = `${PC}\\td-eval`;
    };
    const adopted = planSetup(at('create-user', 'TESTPC\\td-eval', U_NONCE, stored));
    assert.equal(resolution(adopted), 'adopt');
    assert.match(adopted.actions[0]!.description, /and its credential file/);
    assert.ok(!kinds(adopted).includes('create-user'));
    // Interrupted between New-LocalUser and Export-Clixml: the password is gone.
    const lost = (inv: Inventory) => {
      groupRecorded(inv);
      userMade(inv);
    };
    assert.match(blockers(planSetup(at('create-user', 'TESTPC\\td-eval', U_NONCE, lost))).join(), /credential was not stored; the password is lost\. Run -Remove/);
    const removal = planRemoval(at('create-user', 'TESTPC\\td-eval', U_NONCE, lost));
    assert.deepEqual(kinds(removal), ['resolve-pending', 'remove-user', 'remove-group']);
    assert.equal(removal.actions[1]!.sid, ACCOUNT_SID);
    // A half-written credential file is deleted with it.
    const half = planRemoval(at('create-user', 'TESTPC\\td-eval', U_NONCE, (inv) => {
      lost(inv);
      inv.credentialFileExists = true;
    }));
    assert.ok(kinds(half).includes('remove-file'));
    // The account recorded (saved mid-operation) but the credential not yet: same outcome.
    assert.match(blockers(planSetup(at('create-user', 'TESTPC\\td-eval', U_NONCE, (inv) => {
      lost(inv);
      inv.state!.account = { name: 'td-eval', sid: ACCOUNT_SID, nonce: U_NONCE };
    }))).join(), /password is lost/);
  });

  test('add-member: always re-planned from the observed memberships', () => {
    const plan = planSetup(at('add-member', 'TESTPC\\td-eval', null, (inv) => {
      groupRecorded(inv);
      userMade(inv);
      inv.state!.account = { name: 'td-eval', sid: ACCOUNT_SID, nonce: U_NONCE };
      inv.credentialFileExists = true;
      inv.credentialUserName = `${PC}\\td-eval`;
    }));
    assert.equal(resolution(plan), 'discard');
    assert.deepEqual(kinds(plan).filter((k) => k === 'add-member'), ['add-member'], 'Users is already there; only the group membership is missing');
  });

  test('add-deny-ace: not applied -> planned again; applied -> adopted exactly; partly propagated -> refused until the tree is consistent', () => {
    const base = (inv: Inventory) => {
      groupRecorded(inv);
      userMade(inv);
      inv.account.memberships = [USERS_SID, GROUP_SID];
      inv.state!.account = { name: 'td-eval', sid: ACCOUNT_SID, nonce: U_NONCE };
      inv.credentialFileExists = true;
      inv.credentialUserName = `${PC}\\td-eval`;
    };
    const before = planSetup(at('add-deny-ace', 'C:\\GIT', null, base));
    assert.equal(resolution(before), 'discard');
    assert.ok(kinds(before).includes('add-deny-ace'));
    const after = planSetup(at('add-deny-ace', 'C:\\GIT', null, (inv) => {
      base(inv);
      inv.denyRoot.aces = [groupAce('Deny', RIGHTS.FULL_CONTROL, false), ...inv.denyRoot.aces];
      inv.childScan = scan('C:\\GIT', deniedChildren());
    }));
    assert.equal(resolution(after), 'adopt');
    assert.deepEqual(after.actions[0]!.ace, { path: 'C:\\GIT', sid: GROUP_SID, rights: RIGHTS.FULL_CONTROL, inheritance: 3, propagation: 0 });
    assert.ok(!kinds(after).includes('add-deny-ace'));
    const partial = planSetup(at('add-deny-ace', 'C:\\GIT', null, (inv) => {
      base(inv);
      inv.denyRoot.aces = [groupAce('Deny', RIGHTS.FULL_CONTROL, false), ...inv.denyRoot.aces];
      inv.childScan = scan('C:\\GIT', [...deniedChildren(), ...openChildren()]);
    }));
    assert.match(blockers(partial).join(), /The deny is not effective on 400 folders/);
  });

  test('create-folder: not created -> planned again; created with exactly the planned ACL -> adopted; anything else (an inherited ACL) -> refused', () => {
    const base = (inv: Inventory) => groupRecorded(inv);
    const before = planSetup(at('create-folder', 'C:\\td-eval', null, base));
    assert.equal(resolution(before), 'discard');
    assert.equal(kinds(before).filter((k) => k === 'create-folder').length, 3);
    const after = planSetup(at('create-folder', 'C:\\td-eval', null, (inv) => {
      base(inv);
      inv.sandbox.root = pathInv('C:\\td-eval', fullAces(), true, true);
    }));
    assert.equal(resolution(after), 'adopt');
    assert.equal(kinds(after).filter((k) => k === 'create-folder').length, 2);
    // What a non-atomic create would leave behind: the folder with permissions inherited from C:\.
    for (const folder of [pathInv('C:\\td-eval', [system, admins, users(), authUsers()], true, false), pathInv('C:\\td-eval', fullAces(), true, true, 'S-1-5-21-9-9-9-1'), pathInv('C:\\td-eval', [...fullAces(), users(false)], true, true)]) {
      const plan = planSetup(at('create-folder', 'C:\\td-eval', null, (inv) => {
        base(inv);
        inv.sandbox.root = folder;
      }));
      assert.match(blockers(plan).join(), /does not have exactly the planned protected ACL; it is not treated as configured/);
      assert.equal(verifySetup(at('create-folder', 'C:\\td-eval', null, (inv) => (inv.sandbox.root = folder))).ok, false);
    }
    const runtimeRead = planSetup(at('create-folder', 'C:\\td-eval\\runtime', null, (inv) => {
      base(inv);
      inv.state!.folders = ['C:\\td-eval'];
      inv.sandbox.root = pathInv('C:\\td-eval', fullAces(), true, true);
      inv.sandbox.runtime = pathInv('C:\\td-eval\\runtime', fullAces(), true, true);
    }));
    assert.match(blockers(runtimeRead).join(), /runtime exists but does not have exactly the planned protected ACL/, 'the runtime folder needs its group read too');
  });

  test('an interrupted -Remove is finished by -Remove, never by -Apply; the journal from another computer is refused', () => {
    for (const kind of ['remove-folder', 'remove-user', 'forget-record'] as const) {
      assert.match(blockers(planSetup(at(kind, 'x', null, () => {}))).join(), /earlier -Remove was interrupted/);
      assert.equal(resolution(planRemoval(at(kind, 'x', null, () => {}))), 'discard');
    }
    assert.match(blockers(planSetup(at('create-group', 'x', null, (inv) => (inv.state!.computer = 'OTHER')))).join(), /belongs to computer OTHER/);
  });

  test('verification fails while an operation is pending', () => {
    assert.deepEqual(failed(applied((inv) => (inv.state!.pending = pending('add-member', 'TESTPC\\td-eval')))), ['state-complete']);
  });
});

describe('rollback plan', () => {
  test('with no state, nothing was created and nothing is removed', () => {
    const plan = planRemoval(inventory());
    assert.deepEqual(plan.actions, []);
    assert.equal(plan.blocked, false);
  });

  test('removes exactly the recorded objects, deny ACE first and the account before the group, and the observed token', () => {
    const plan = planRemoval(applied());
    assert.deepEqual(plan.actions.map((a) => [a.kind, a.target]), [
      ['remove-deny-ace', 'C:\\GIT'],
      ['remove-folder', 'C:\\td-eval\\runtime'],
      ['remove-folder', 'C:\\td-eval\\work'],
      ['remove-folder', 'C:\\td-eval'],
      ['remove-profile', 'C:\\Users\\td-eval'],
      ['remove-user', 'TESTPC\\td-eval'],
      ['remove-group', 'TESTPC\\td-eval-sandbox'],
      ['remove-file', 'C:\\Users\\dev\\AppData\\Local\\test-detective\\eval-account.xml'],
      ['remove-file', 'C:\\Users\\dev\\AppData\\Local\\test-detective\\eval-token.json'],
    ]);
    assert.deepEqual(plan.actions[0]!.ace, { path: 'C:\\GIT', sid: GROUP_SID, rights: RIGHTS.FULL_CONTROL, inheritance: 3, propagation: 0 });
  });

  test('restartable: records of objects that are already gone are cleared, so a resumed rollback empties the journal', () => {
    const resumed = planRemoval(applied((inv) => {
      inv.denyRoot.aces = inv.denyRoot.aces.slice(1);
      inv.sandbox.runtime = pathInv('C:\\td-eval\\runtime', [], false);
      inv.sandbox.work = pathInv('C:\\td-eval\\work', [], false);
      inv.account = missing('td-eval');
      inv.credentialFileExists = false;
      inv.tokenFileExists = false;
    }));
    assert.deepEqual(resumed.actions.map((a) => [a.kind, a.record ?? null, a.target]), [
      ['forget-record', 'deny-ace', 'C:\\GIT'],
      ['forget-record', 'folder', 'C:\\td-eval\\runtime'],
      ['forget-record', 'folder', 'C:\\td-eval\\work'],
      ['remove-folder', null, 'C:\\td-eval'],
      ['forget-record', 'account', 'TESTPC\\td-eval'],
      ['remove-group', null, 'TESTPC\\td-eval-sandbox'],
      ['forget-record', 'credential', 'C:\\Users\\dev\\AppData\\Local\\test-detective\\eval-account.xml'],
    ]);
  });

  test('an ACE that no longer matches the recorded one is left alone; unrelated ACEs are never named', () => {
    const plan = planRemoval(applied((inv) => (inv.denyRoot.aces[0] = { ...inv.denyRoot.aces[0]!, rights: RIGHTS.READ_AND_EXECUTE })));
    assert.ok(!plan.actions.some((a) => a.kind === 'remove-deny-ace'));
    assert.ok(plan.actions.every((a) => a.kind !== 'remove-deny-ace' || a.ace!.sid === GROUP_SID));
  });

  test('a principal whose SID or description changed, links in the sandbox, another computer or another credential path stop the rollback', () => {
    assert.match(blockers(planRemoval(applied((inv) => (inv.account.sid = 'S-1-5-21-9-9-9-9')))).join(), /Not removing it/);
    assert.match(blockers(planRemoval(applied((inv) => (inv.group.description = 'changed')))).join(), /Not removing it/);
    assert.match(blockers(planRemoval(applied((inv) => (inv.sandbox.reparsePoints = 1)))).join(), /links/);
    assert.match(blockers(planRemoval(applied((inv) => (inv.state!.computer = 'OTHER')))).join(), /belongs to computer OTHER/);
    assert.match(blockers(planRemoval(applied((inv) => (inv.state!.credentialFile = 'C:\\elsewhere\\x.xml')))).join(), /not the configured one/);
  });
});

describe('verification after Apply', () => {
  test('the applied state with a staged runtime and an observed token passes every check', () => {
    const report = verifySetup(applied());
    assert.deepEqual(report.checks.filter((c) => !c.ok), []);
    assert.equal(report.ok, true);
  });

  test('a missing deny ACE, a writable runtime grant, an administrator account or an extra ACE fail', () => {
    assert.deepEqual(failed(applied((inv) => (inv.denyRoot.aces = inv.denyRoot.aces.slice(1)))), ['deny-ace', 'deny-root-blocked']);
    assert.deepEqual(failed(applied((inv) => (inv.sandbox.runtime.aces.at(-1)!.rights = 0x1301bf))), ['folder:runtime']);
    assert.deepEqual(failed(applied((inv) => inv.account.memberships.push(ADMINISTRATORS_SID))), ['account-standard']);
    assert.deepEqual(failed(applied((inv) => inv.sandbox.work.aces.push(users(false)))), ['folder:work']);
    assert.deepEqual(failed(applied((inv) => (inv.credentialUserName = null))), ['credential']);
  });

  test('I2: the deny must be effective on every inheriting item, however Windows represents the inherited copy', () => {
    // Propagation stopped part-way: one subtree still carries only the inherited allows.
    const stopped = applied((inv) => inv.childScan.shapes.push(shape(true, [users(), authUsers()], 37), shape(false, [users(true, 0)], 120)));
    assert.deepEqual(failed(stopped), ['deny-propagated']);
    assert.match(verifySetup(stopped).checks.find((c) => c.id === 'deny-propagated')!.detail, /not effective on 37 folders.*not effective on 120 files/);
    // The same deny split by Windows into an inherit-only part and a part for the item itself: still effective.
    const split = applied((inv) => inv.childScan.shapes.push(shape(true, [groupAce('Deny', RIGHTS.FULL_CONTROL, true, 0), groupAce('Deny', RIGHTS.GENERIC_ALL, true, FULL3, PROPAGATE.INHERIT_ONLY), users(), authUsers()], 5)));
    assert.deepEqual(failed(split), []);
    // A folder whose own deny copy lost its inheritance flags stops the deny below it.
    const flat = applied((inv) => inv.childScan.shapes.push(shape(true, [groupAce('Deny', RIGHTS.FULL_CONTROL, true, 0), users(), authUsers()], 2)));
    assert.deepEqual(failed(flat), ['deny-propagated']);
    // An explicit allow (canonically ahead of every inherited ACE) both defeats the deny and is a structural finding.
    assert.deepEqual(failed(applied((inv) => inv.childScan.shapes.push(shape(false, [users(false, 0), ...deniedChildren()[1]!.aces], 1)))), ['deny-propagated', 'acl-scan']);
    assert.deepEqual(failed(applied((inv) => (inv.childScan.errors = 1))), ['deny-propagated', 'acl-scan'], 'an incomplete scan never passes');
    assert.deepEqual(failed(applied((inv) => (inv.childScan.truncated = true))), ['deny-propagated', 'acl-scan']);
  });

  test('I3: verification requires the observed token: present, of this account, holding the group, without Administrators', () => {
    assert.deepEqual(failed(applied((inv) => ((inv.observedTokenJson = null), (inv.tokenFileExists = false)))), ['token-observed']);
    assert.match(verifySetup(applied((inv) => ((inv.observedTokenJson = null), (inv.tokenFileExists = false)))).checks.find((c) => c.id === 'token-observed')!.detail, /run check --account/);
    assert.deepEqual(failed(applied((inv) => (inv.observedTokenJson = '{not json'))), ['token-observed']);
    assert.deepEqual(failed(applied((inv) => (inv.observedTokenJson = JSON.stringify({ ...TOKEN, groups: TOKEN.groups.filter((g) => g.sid !== GROUP_SID) })))), ['token-observed']);
    assert.deepEqual(failed(applied((inv) => (inv.observedTokenJson = JSON.stringify({ ...TOKEN, groups: [...TOKEN.groups, { name: 'BUILTIN\\Administrators', sid: ADMINISTRATORS_SID }] })))), ['token-observed']);
  });

  test('I11: the staged runtime must inherit group read only: no explicit ACEs, no protected items, no write, trusted owners', () => {
    const runtimeFiles = (aces: Ace[], edit: Partial<AclShape> = {}) => applied((inv) => inv.sandbox.runtimeScan.shapes.push(shape(false, aces, 1, edit)));
    const inheritedRead = groupAce('Allow', RIGHTS.READ_AND_EXECUTE, true, 0);
    assert.deepEqual(failed(runtimeFiles([inheritedRead, groupAce('Allow', RIGHTS.READ_AND_EXECUTE, false, 0)])), ['runtime-acl'], 'explicit ACE');
    assert.deepEqual(failed(runtimeFiles([inheritedRead], { protected: true })), ['runtime-acl'], 'protected');
    assert.deepEqual(failed(runtimeFiles([groupAce('Allow', 0x1301bf, true, 0)])), ['runtime-acl'], 'writable');
    assert.deepEqual(failed(runtimeFiles([inheritedRead, users(true, 0), authUsers(0)])), ['runtime-acl'], 'inherited Users/Authenticated Users Modify (a copy that inherited from C:\\)');
    assert.deepEqual(failed(runtimeFiles([inheritedRead], { owner: ACCOUNT_SID })), ['runtime-acl'], 'owned by the account');
    assert.deepEqual(failed(runtimeFiles([])), ['runtime-acl'], 'not readable by the account');
    assert.deepEqual(failed(applied((inv) => (inv.sandbox.runtimeScan.reparsePoints = [{ path: 'C:\\td-eval\\runtime\\l', target: 'C:\\GIT' }]))), ['runtime-acl']);
    assert.deepEqual(failed(applied((inv) => (inv.sandbox.runtimeScan = scan('C:\\td-eval\\runtime', [])))), [], 'an empty runtime (nothing staged yet) is consistent');
  });
});

describe('setup.ps1 never changes anything without -Apply/-Remove and the reviewed hash', () => {
  const script = readFileSync(SETUP_SCRIPT, 'utf8');
  // Commands and .NET calls that persist a change (in-memory ACL objects are not listed).
  const MUTATORS =
    /\b(New-LocalUser|New-LocalGroup|Add-LocalGroupMember|Remove-LocalGroupMember|Set-LocalUser|Set-LocalGroup|Enable-LocalUser|Disable-LocalUser|Remove-LocalUser|Remove-LocalGroup|Remove-CimInstance|Set-CimInstance|Export-Clixml|Set-Acl|SetAccessControl|Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Rename-Item|Move-Item|Copy-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|icacls|takeown|cacls|net(\.exe)?\s+(user|localgroup)|CreateDirectory|WriteAllText|WriteAllBytes|AppendAllText|File\]::(Replace|Move|Delete|Copy)|Directory\]::(Move|Delete)|Start-Process|Invoke-Item|reg(\.exe)?\s+(add|delete)|Set-ExecutionPolicy)\b/;
  const ALLOWED_FUNCTIONS = new Set(['Invoke-SetupAction', 'Invoke-RemovalAction', 'Save-State']);
  const lines = script.split(/\r?\n/);

  test('every mutating command sits inside the action functions or the WhatIf-guarded state cleanup', () => {
    let current: string | null = null;
    const outside: string[] = [];
    for (const line of lines) {
      const fn = /^function ([\w-]+)/.exec(line);
      if (fn) current = fn[1]!;
      else if (/^\S/.test(line) && !line.startsWith('}')) current = null;
      if (line.trimStart().startsWith('#') || !MUTATORS.test(line)) continue;
      if (current && ALLOWED_FUNCTIONS.has(current)) continue;
      outside.push(line.trim());
    }
    assert.deepEqual(outside, ['Remove-Item -LiteralPath $StateFile -Force']);
    const at = lines.findIndex((l) => l.trim() === outside[0]);
    assert.match(lines[at - 1]!, /^if \(-not \$WhatIfPreference -and \$Mode -eq 'remove'/, 'only after a real removal emptied the state');
  });

  test('the action functions and journal writes run only inside ShouldProcess, after the hash and elevation checks; intent is journaled first', () => {
    const calls = [...script.matchAll(/^(.*)\b(Invoke-SetupAction|Invoke-RemovalAction) \$action/gm)];
    assert.equal(calls.length, 1);
    const at = script.indexOf(calls[0]![0]);
    const before = script.slice(0, at);
    const gate = before.lastIndexOf('$PSCmdlet.ShouldProcess(');
    assert.ok(gate > before.lastIndexOf('if ($PlanSha256 -ne $result.sha256)'));
    assert.ok(before.includes('if ($result.blocked) { exit 2 }') && before.includes("if ($Mode -eq 'plan') { exit 0 }"));
    assert.match(script, /SupportsShouldProcess = \$true/);
    const mainStart = script.indexOf('# Main\n') >= 0 ? script.indexOf('# Main\n') : script.indexOf('# Main\r\n');
    const mainSaves = [...script.slice(mainStart).matchAll(/Save-State \$state/g)].map((m) => mainStart + m.index!);
    assert.equal(mainSaves.length, 2);
    assert.ok(mainSaves.every((i) => i > gate), 'the journal is written only for an approved change');
    assert.ok(mainSaves[0]! < at && mainSaves[1]! > at, 'pending before the change, confirmed after it');
    assert.match(script.slice(gate, at), /\$state\.pending = \[ordered\]@\{ kind = \$action\.kind/);
  });

  test('state writes are atomic, folders are created with their ACL in one call, application files have fixed paths', () => {
    assert.match(script, /WriteAllText\(\$tmp, .*\[System\.IO\.File\]::Replace\(\$tmp, \$StateFile, \$null\)/s);
    assert.match(script, /\[System\.IO\.Directory\]::CreateDirectory\(\$Action\.target, \(New-FolderSecurity/);
    assert.doesNotMatch(script, /New-Item -ItemType Directory -Path \$Action\.target/);
    assert.doesNotMatch(script, /\[string\]\$(CredentialFile|StateFile|TokenFile)/, 'no parameter can redirect a write');
    assert.match(script, /\$Cli = Join-Path \$RepoRoot 'src\\eval\\sandbox\\setup-cli\.ts'/);
  });

  test('no secret handling shortcuts: no plain-text secure strings, no Invoke-Expression, nothing printed from the password', () => {
    assert.doesNotMatch(script, /ConvertTo-SecureString|AsPlainText|Invoke-Expression|\biex\b|Write-Host|GetNetworkCredential/);
    assert.doesNotMatch(script, /\$secure[^\n]*(Write-|Out-|ConvertTo-Json|Set-Content)/);
    assert.doesNotMatch(script, /(Write-Output|Write-Error|Stop-Setup)[^\n]*\$(secure|credential|cred|stored)\b/i);
    assert.match(script, /\$credentialUser = \$stored\.UserName/, 'only the user name is read from the stored credential');
  });
});

describe('I4: the elevated planner entry point imports only the planner', () => {
  test('setup-cli.ts reaches setup-plan.ts, config.ts, zod and Node built-ins, nothing else (no SDK, live harness, scorer, truth or MCP code)', () => {
    const entry = path.join(REPO_ROOT, 'src', 'eval', 'sandbox', 'setup-cli.ts');
    const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]!);
    const files = new Set<string>();
    const packages = new Set<string>();
    const visit = (file: string) => {
      if (files.has(file)) return;
      files.add(file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec));
        else packages.add(spec);
      }
    };
    visit(entry);
    assert.deepEqual([...files].map((f) => path.basename(f)).sort(), ['config.ts', 'setup-cli.ts', 'setup-plan.ts']);
    assert.deepEqual([...packages].filter((p) => !p.startsWith('node:')), ['zod']);
    assert.doesNotMatch(readFileSync(SETUP_SCRIPT, 'utf8'), /sandbox\\main\.ts/, 'setup.ps1 never runs the general sandbox CLI');
  });
});

describe('setup.ps1 on disposable folders (no account, group, ACL or real application file is touched)', { skip: process.platform !== 'win32' && 'Windows only', timeout: 600_000 }, () => {
  /** A disposable LOCALAPPDATA, deny root and sandbox root; random principal names that don't exist. */
  async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
    const tmp = await mkdtemp(path.join(tmpdir(), 'td-setup-test-'));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const deny = path.join(tmp, 'deny');
    await mkdir(path.join(deny, 'repo-a', 'sub'), { recursive: true });
    await mkdir(path.join(deny, 'repo-b'), { recursive: true });
    await writeFile(path.join(deny, 'repo-a', 'sub', 'file.txt'), 'x');
    const appData = path.join(tmp, 'appdata');
    await mkdir(appData);
    const name = `tdt${Date.now().toString(36).slice(-6)}`;
    const args = ['-Account', `${name}a`, '-Group', `${name}g`, '-SandboxRoot', path.join(tmp, 'sandbox'), '-DenyRoot', deny];
    const secret = path.join(appData, 'test-detective');
    const run = async (extra: string[]) => {
      try {
        const { stdout, stderr } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SETUP_SCRIPT, ...args, ...extra], { env: { ...process.env, LOCALAPPDATA: appData }, windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const e = error as { code: number; stdout: string; stderr: string };
        return { code: e.code, stdout: e.stdout, stderr: e.stderr };
      }
    };
    const sddl = async () => (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${deny}').Sddl; (Get-Acl -LiteralPath '${path.join(deny, 'repo-a', 'sub', 'file.txt')}').Sddl`], { windowsHide: true })).stdout;
    return { tmp, deny, appData, secret, name, args, run, sddl, sandboxRoot: path.join(tmp, 'sandbox') };
  }

  test('plan, -WhatIf and refusals: no account, group, folder, file or ACL appears; arbitrary destinations are not accepted', async (t) => {
    const s = await sandbox(t);
    const before = await s.sddl();
    const plan = await s.run(['-Json']);
    assert.equal(plan.code, 0, plan.stderr);
    const parsed = JSON.parse(plan.stdout) as { sha256: string; actions: { kind: string; description: string }[]; blocked: boolean };
    assert.equal(parsed.blocked, false);
    assert.deepEqual(parsed.actions.map((a) => a.kind), ['create-group', 'create-user', 'add-member', 'add-member', 'add-deny-ace', 'create-folder', 'create-folder', 'create-folder']);
    assert.match(parsed.actions[4]!.description, /: 4 items in 2 top-level entries \(repo-a, repo-b\)/, 'the scope names every top-level entry');

    const noHash = await s.run(['-Apply']);
    assert.equal(noHash.code, 1);
    assert.match(noHash.stderr, /needs -PlanSha256/);
    const wrongHash = await s.run(['-Apply', '-PlanSha256', '0'.repeat(64)]);
    assert.equal(wrongHash.code, 1);
    assert.match(wrongHash.stderr, /plan changed since it was reviewed/);
    assert.equal((await s.run(['-WhatIf'])).code, 1, '-WhatIf without -Apply/-Remove is refused, not silently ignored');
    for (const param of ['-CredentialFile', '-StateFile', '-TokenFile']) {
      const r = await s.run([param, path.join(s.tmp, 'elsewhere.json')]);
      assert.notEqual(r.code, 0, `${param} is not a parameter`);
    }

    const whatIf = await s.run(['-Apply', '-WhatIf', '-PlanSha256', parsed.sha256]);
    assert.equal(whatIf.code, 0, whatIf.stderr);
    assert.equal((whatIf.stdout.match(/What if:/g) ?? []).length, 8, 'every planned change is described');

    assert.equal(await s.sddl(), before, 'the deny folder ACLs are byte-identical');
    assert.deepEqual((await readdir(s.tmp)).sort(), ['appdata', 'deny'], 'no sandbox folder was created');
    assert.deepEqual(await readdir(s.appData), [], 'no credential, journal or token was written');
    const again = JSON.parse((await s.run(['-Json'])).stdout) as { sha256: string };
    assert.equal(again.sha256, parsed.sha256, 'nothing changed in between');
    await writeFile(path.join(s.deny, 'repo-c.txt'), '');
    assert.notEqual((JSON.parse((await s.run(['-Json'])).stdout) as { sha256: string }).sha256, parsed.sha256, 'a new top-level entry changes the reviewed hash');
  });

  test('-InventoryOnly: the inventory validates, every scanned item is in exactly one ACL shape or a link, and the runtime is scanned', async (t) => {
    const s = await sandbox(t);
    await mkdir(path.join(s.sandboxRoot, 'runtime', 'bin'), { recursive: true });
    await writeFile(path.join(s.sandboxRoot, 'runtime', 'bin', 'stage2.mjs'), '');
    await symlink(path.join(s.deny, 'repo-b'), path.join(s.deny, 'repo-a', 'link'), 'junction');
    const r = await s.run(['-InventoryOnly']);
    assert.equal(r.code, 0, r.stderr);
    const inv = Inventory.parse(JSON.parse(r.stdout));
    const childScan = inv.childScan;
    assert.equal(childScan.errors, 0);
    assert.deepEqual([...childScan.topLevel].sort(), ['repo-a', 'repo-b']);
    assert.equal(childScan.shapes.reduce((n, sh) => n + sh.count, 0) + childScan.reparsePoints.length, childScan.scanned, 'complete: every item counted once');
    assert.equal(childScan.scanned, 5);
    assert.deepEqual(childScan.reparsePoints.map((p) => p.path), [path.join(s.deny, 'repo-a', 'link')]);
    assert.ok(childScan.shapes.every((sh) => sh.aces.every((a) => a.sid !== inv.developer.sid && a.sid !== 'S-1-5-18')), 'trusted principals are left out of the shapes');
    assert.equal(inv.sandbox.runtimeScan.scanned, 2);
    assert.equal(inv.state, null);
    assert.equal(inv.credentialUserName, null);
    assert.deepEqual(blockers(planSetup(inv)).map((b) => b.replace(s.tmp, '<tmp>')), ['<tmp>\\sandbox already exists and was not created by this script. Not taking it over.', '<tmp>\\sandbox\\runtime already exists and was not created by this script. Not taking it over.'], 'only the pre-made sandbox folders block');
  });

  async function syntheticState(s: Awaited<ReturnType<typeof sandbox>>, edit: (state: Record<string, unknown>) => void = () => {}) {
    for (const f of ['runtime', 'work']) await mkdir(path.join(s.sandboxRoot, f), { recursive: true });
    await mkdir(s.secret, { recursive: true });
    await writeFile(path.join(s.secret, 'eval-account.xml'), '<not a credential/>');
    await writeFile(path.join(s.secret, 'eval-token.json'), JSON.stringify({ ...TOKEN, account: `${s.name}a` }));
    // Shaped as Windows PowerShell 5.1 writes it (ConvertTo-Json): CRLF, nested objects, one-element arrays, nulls.
    const state: Record<string, unknown> = {
      schema: 2,
      computer: process.env.COMPUTERNAME,
      account: { name: `${s.name}a`, sid: 'S-1-5-21-1-2-3-99901', nonce: U_NONCE },
      group: { name: `${s.name}g`, sid: 'S-1-5-21-1-2-3-99902', nonce: G_NONCE },
      denyAces: [{ path: s.deny, sid: 'S-1-5-21-1-2-3-99902', rights: RIGHTS.FULL_CONTROL, inheritance: 3, propagation: 0 }],
      folders: [s.sandboxRoot, path.join(s.sandboxRoot, 'runtime'), path.join(s.sandboxRoot, 'work')],
      credentialFile: path.join(s.secret, 'eval-account.xml'),
      pending: null,
    };
    edit(state);
    const text = JSON.stringify(state, null, 4).replace(/\n/g, '\r\n');
    await writeFile(path.join(s.secret, 'eval-sandbox-state.json'), text);
    return text;
  }
  const snapshot = async (s: Awaited<ReturnType<typeof sandbox>>) => ({
    secret: (await readdir(s.secret)).sort(),
    state: await readFile(path.join(s.secret, 'eval-sandbox-state.json'), 'utf8'),
    sandbox: existsSync(s.sandboxRoot) ? (await readdir(s.sandboxRoot)).sort() : null,
    acl: await s.sddl(),
  });

  test('I8: -Remove -WhatIf on a synthetic journal describes every removal and changes nothing', async (t) => {
    const s = await sandbox(t);
    await syntheticState(s);
    const before = await snapshot(s);
    const plan = JSON.parse((await s.run(['-Remove', '-Json'])).stdout) as Plan;
    assert.equal(plan.blocked, false, JSON.stringify(plan.findings));
    assert.deepEqual(plan.actions.map((a) => [a.kind, a.record ?? null]), [
      ['forget-record', 'deny-ace'],
      ['remove-folder', null],
      ['remove-folder', null],
      ['remove-folder', null],
      ['forget-record', 'account'],
      ['forget-record', 'group'],
      ['remove-file', null],
      ['remove-file', null],
    ]);
    const whatIf = await s.run(['-Remove', '-WhatIf', '-PlanSha256', plan.sha256]);
    assert.equal(whatIf.code, 0, whatIf.stderr);
    assert.equal((whatIf.stdout.match(/What if:/g) ?? []).length, 8);
    assert.deepEqual(await snapshot(s), before, 'journal byte-identical, folders, files and ACLs untouched');
    assert.ok(!existsSync(path.join(s.secret, 'eval-sandbox-state.json.tmp')));
  });

  test('I8: a partly completed rollback resumes; single-element arrays, an empty list and a pending entry survive the PowerShell round trip', async (t) => {
    const s = await sandbox(t);
    await syntheticState(s, (state) => {
      state.folders = [s.sandboxRoot];
      state.denyAces = [];
      state.group = null;
      state.pending = { kind: 'remove-folder', target: path.join(s.sandboxRoot, 'runtime'), nonce: null, startedAt: '2026-11-14T00:00:00.000Z' };
    });
    await rm(path.join(s.sandboxRoot, 'runtime'), { recursive: true });
    const before = await snapshot(s);
    const plan = JSON.parse((await s.run(['-Remove', '-Json'])).stdout) as Plan;
    assert.equal(plan.blocked, false, JSON.stringify(plan.findings));
    assert.deepEqual(plan.actions.map((a) => [a.kind, a.resolution ?? a.record ?? null]), [['resolve-pending', 'discard'], ['remove-folder', null], ['forget-record', 'account'], ['remove-file', null], ['remove-file', null]]);
    const whatIf = await s.run(['-Remove', '-WhatIf', '-PlanSha256', plan.sha256]);
    assert.equal(whatIf.code, 0, whatIf.stderr);
    assert.deepEqual(await snapshot(s), before);
    // An interrupted -Remove must be finished by -Remove.
    const apply = await s.run(['-Json']);
    assert.equal(apply.code, 2);
    assert.match(apply.stdout, /earlier -Remove was interrupted/);
  });

  test('I1 through PowerShell: a folder left with inherited permissions by an interrupted create is refused, not adopted', async (t) => {
    const s = await sandbox(t);
    await syntheticState(s, (state) => {
      state.account = null;
      state.group = null;
      state.denyAces = [];
      state.folders = [];
      state.credentialFile = null;
      state.pending = { kind: 'create-folder', target: s.sandboxRoot, nonce: null, startedAt: '2026-11-14T00:00:00.000Z' };
    });
    await rm(path.join(s.secret, 'eval-account.xml'));
    const plan = await s.run(['-Json']);
    assert.equal(plan.code, 2);
    assert.match(plan.stdout, /does not have exactly the planned protected ACL; it is not treated as configured/);
  });

  test('a malformed journal or a link in the application folder fails closed before anything runs', async (t) => {
    const s = await sandbox(t);
    await syntheticState(s, (state) => (state.folders = s.sandboxRoot));
    const before = await snapshot(s);
    const malformed = await s.run(['-Remove', '-Json']);
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /The planner failed/);
    assert.deepEqual(await snapshot(s), before);

    const t2 = await sandbox(t);
    const elsewhere = path.join(t2.tmp, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, t2.secret, 'junction');
    const linked = await t2.run(['-Json']);
    assert.equal(linked.code, 1);
    assert.match(linked.stderr, /is a link; refusing/);
    assert.deepEqual(await readdir(elsewhere), []);
  });
});
