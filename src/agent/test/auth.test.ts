import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { authFacts, checkSessionAuth, preflightAuth } from '../auth.ts';
import { SUBSCRIPTION_ACCOUNT } from './helpers.ts';

const SECRET = 'sk-ant-THIS-MUST-NEVER-BE-PRINTED';

describe('preflightAuth (env var names only)', () => {
  test('subscription mode accepts a clean environment', () => {
    assert.deepEqual(preflightAuth({ PATH: '/bin' }, 'subscription'), { ok: true });
  });

  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_PROFILE',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_IDENTITY_TOKEN',
    'ANTHROPIC_IDENTITY_TOKEN_FILE',
  ]) {
    test(`subscription mode refuses ${name}, naming it but never its value`, () => {
      const result = preflightAuth({ [name]: SECRET }, 'subscription');
      assert.equal(result.ok, false);
      const reason = (result as { reason: string }).reason;
      assert.match(reason, new RegExp(name));
      assert.doesNotMatch(reason, /THIS-MUST-NEVER/);
    });
  }

  test('an empty variable counts as unset', () => {
    assert.deepEqual(preflightAuth({ ANTHROPIC_API_KEY: '' }, 'subscription'), { ok: true });
  });

  test('api mode requires ANTHROPIC_API_KEY and nothing ambiguous', () => {
    assert.equal(preflightAuth({}, 'api').ok, false);
    assert.deepEqual(preflightAuth({ ANTHROPIC_API_KEY: SECRET }, 'api'), { ok: true });
    const ambiguous = preflightAuth({ ANTHROPIC_API_KEY: SECRET, ANTHROPIC_AUTH_TOKEN: SECRET }, 'api');
    assert.equal(ambiguous.ok, false);
    assert.match((ambiguous as { reason: string }).reason, /ANTHROPIC_AUTH_TOKEN/);
    assert.doesNotMatch((ambiguous as { reason: string }).reason, /THIS-MUST-NEVER/);
  });
});

describe('authFacts', () => {
  test('keeps only non-secret fields: never email or organization', () => {
    const facts = authFacts({ ...SUBSCRIPTION_ACCOUNT, apiKeySource: 'none', tokenSource: 'claude.ai' });
    assert.deepEqual(facts, { apiKeySource: 'none', apiProvider: 'firstParty', subscriptionType: 'Claude Pro', tokenSource: 'claude.ai' });
    assert.doesNotMatch(JSON.stringify(facts), /example/i);
  });

  test('fields the SDK omits become nulls', () => {
    assert.deepEqual(authFacts(SUBSCRIPTION_ACCOUNT), { apiKeySource: null, apiProvider: 'firstParty', subscriptionType: 'Claude Pro', tokenSource: null });
    assert.deepEqual(authFacts(undefined), { apiKeySource: null, apiProvider: null, subscriptionType: null, tokenSource: null });
  });
});

describe('checkSessionAuth (preflight on the initialization account, fails closed)', () => {
  // SDK 0.3.302 returns this for a Pro login: no apiKeySource, no tokenSource.
  const sub = authFacts(SUBSCRIPTION_ACCOUNT);

  test('missing apiKeySource is accepted with a first-party provider and an eligible subscription', () => {
    assert.equal(sub.apiKeySource, null);
    assert.deepEqual(checkSessionAuth(sub, 'subscription'), { ok: true });
    assert.deepEqual(checkSessionAuth({ ...sub, apiKeySource: 'none' }, 'subscription'), { ok: true });
    for (const subscriptionType of ['Claude Max', 'pro', 'Team', 'Claude Enterprise']) {
      assert.deepEqual(checkSessionAuth({ ...sub, subscriptionType }, 'subscription'), { ok: true }, subscriptionType);
    }
  });

  test('an explicitly reported non-subscription apiKeySource is still refused', () => {
    for (const apiKeySource of ['ANTHROPIC_API_KEY', '/login managed key', 'apiKeyHelper', 'oauth', 'temporary']) {
      const result = checkSessionAuth({ ...sub, apiKeySource }, 'subscription');
      assert.equal(result.ok, false, apiKeySource);
      assert.match((result as { reason: string }).reason, new RegExp(apiKeySource.replace('/', '\\/')));
    }
  });

  test('missing apiKeySource is refused when anything else is missing or contradicts a subscription', () => {
    const refused = (facts: typeof sub) => assert.equal(checkSessionAuth(facts, 'subscription').ok, false, JSON.stringify(facts));
    refused({ ...sub, subscriptionType: null });
    refused({ ...sub, subscriptionType: '' });
    refused({ ...sub, subscriptionType: 'free' });
    refused({ ...sub, subscriptionType: 'unknown' });
    refused({ ...sub, apiProvider: 'bedrock' });
    refused({ ...sub, apiProvider: 'gateway' });
    refused({ ...sub, apiProvider: null });
    refused({ ...sub, tokenSource: 'apiKeyHelper' });
    refused({ ...sub, tokenSource: 'ANTHROPIC_API_KEY' });
    refused(authFacts(undefined));
  });

  test('api mode requires apiKeySource=ANTHROPIC_API_KEY to be reported, not inferred', () => {
    assert.deepEqual(checkSessionAuth({ ...sub, apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: null }, 'api'), { ok: true });
    assert.equal(checkSessionAuth(sub, 'api').ok, false, 'absent apiKeySource is not enough in api mode');
    assert.equal(checkSessionAuth({ ...sub, apiKeySource: 'none' }, 'api').ok, false);
    assert.equal(checkSessionAuth(authFacts(undefined), 'api').ok, false);
  });
});
