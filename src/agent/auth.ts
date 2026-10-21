import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';

// Authentication checks. Fail closed: anything unexpected or ambiguous stops the run before the
// prompt is sent. Only variable NAMES and non-secret account fields are ever reported; values,
// tokens, email addresses and organization names are never read into output.

export type AuthMode = 'subscription' | 'api';

/** Env vars that make Claude Code use something other than the subscription login. */
const NON_SUBSCRIPTION_VARS = [
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
] as const;

function present(env: Record<string, string | undefined>): string[] {
  return NON_SUBSCRIPTION_VARS.filter((name) => (env[name] ?? '') !== '');
}

/** Before the SDK starts: refuse environments that could silently change how the run is billed. */
export function preflightAuth(env: Record<string, string | undefined>, mode: AuthMode): { ok: true } | { ok: false; reason: string } {
  const found = present(env);
  if (mode === 'subscription') {
    if (found.length === 0) return { ok: true };
    return {
      ok: false,
      reason:
        `Subscription mode refuses to start because ${found.join(', ')} ${found.length === 1 ? 'is' : 'are'} set, ` +
        'which would take precedence over your subscription login. Unset it, or pass --auth api to use API billing deliberately.',
    };
  }
  const others = found.filter((name) => name !== 'ANTHROPIC_API_KEY');
  if (!found.includes('ANTHROPIC_API_KEY')) return { ok: false, reason: 'API mode requires ANTHROPIC_API_KEY to be set.' };
  if (others.length > 0) {
    return { ok: false, reason: `API mode is ambiguous because ${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} also set. Unset ${others.length === 1 ? 'it' : 'them'}.` };
  }
  return { ok: true };
}

export type AuthFacts = {
  apiKeySource: string | null;
  apiProvider: string | null;
  subscriptionType: string | null;
  tokenSource: string | null;
};

/** Copies only the non-secret fields. Never email or organization. */
export function authFacts(account: AccountInfo | undefined): AuthFacts {
  return {
    apiKeySource: account?.apiKeySource ?? null,
    apiProvider: account?.apiProvider ?? null,
    subscriptionType: account?.subscriptionType ?? null,
    tokenSource: account?.tokenSource ?? null,
  };
}

/** Plans that include Claude Code usage. Matched against AccountInfo.subscriptionType (e.g. "Claude Pro"). */
const ELIGIBLE_SUBSCRIPTION = /\b(pro|max|team|enterprise)\b/i;
/** tokenSource values that would mean a key rather than a subscription login. */
const KEY_LIKE_TOKEN_SOURCE = /api[\s_-]?key|apikeyhelper|console|managed key/i;

/** The apiKeySource each mode must end up with, as reported by the stream's system/init message. */
export const EXPECTED_API_KEY_SOURCE: Record<AuthMode, string> = { subscription: 'none', api: 'ANTHROPIC_API_KEY' };

/**
 * Preflight on the account reported by SDK initialization, before the prompt is sent. Run it
 * only after preflightAuth() passed. `apiKeySource` "none" means "no API key" (subscription login,
 * bearer token or cloud provider); "/login managed key" is a Console (API-billed) login.
 *
 * SDK 0.3.302 omits apiKeySource from the initialization account info. Subscription mode then
 * accepts its absence only when nothing else contradicts a subscription login, and the caller must
 * confirm apiKeySource from the stream's init message (see EXPECTED_API_KEY_SOURCE). That second
 * check can only abort the session: the prompt may already have been submitted by then.
 */
export function checkSessionAuth(facts: AuthFacts, mode: AuthMode): { ok: true } | { ok: false; reason: string } {
  const describe =
    `apiKeySource=${facts.apiKeySource ?? 'not reported'}, apiProvider=${facts.apiProvider ?? 'not reported'}, ` +
    `subscriptionType=${facts.subscriptionType ?? 'not reported'}`;
  if (facts.apiProvider !== 'firstParty') {
    return { ok: false, reason: `Unexpected or unknown API provider (${describe}); expected firstParty.` };
  }
  const expected = EXPECTED_API_KEY_SOURCE[mode];
  if (facts.apiKeySource !== null && facts.apiKeySource !== expected) {
    return { ok: false, reason: `Session would use apiKeySource=${facts.apiKeySource}, but ${mode} mode requires ${expected} (${describe}). Refusing to run.` };
  }
  if (mode === 'api') {
    if (facts.apiKeySource === null) {
      return { ok: false, reason: `API mode could not confirm apiKeySource=ANTHROPIC_API_KEY before the prompt (${describe}). Refusing to run.` };
    }
    return { ok: true };
  }
  if (!facts.subscriptionType || !ELIGIBLE_SUBSCRIPTION.test(facts.subscriptionType)) {
    return { ok: false, reason: `No eligible subscription reported (${describe}); the login source is ambiguous. Refusing to run.` };
  }
  if (facts.tokenSource !== null && KEY_LIKE_TOKEN_SOURCE.test(facts.tokenSource)) {
    return { ok: false, reason: `tokenSource=${facts.tokenSource} contradicts a subscription login. Refusing to run.` };
  }
  return { ok: true };
}
