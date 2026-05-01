import type { OAuthProviderConfig } from './config.js';

/**
 * Build the provider authorize URL.
 *
 * `state` is a server-generated nonce stored in `oauth_states` (or KV) so the
 * callback can validate it and recover the originating user/account context.
 *
 * Pure function — does not hash, does not store. Persistence is the caller's
 * responsibility.
 */
export function buildAuthorizeUrl(
  config: OAuthProviderConfig,
  clientId: string,
  redirectUri: string,
  state: string,
  scopes?: ReadonlyArray<string>,
  options: { codeChallenge?: string; codeChallengeMethod?: 'S256' | 'plain' } = {},
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: (scopes ?? config.defaultScopes).join(' '),
  });
  if (config.usesPkce && options.codeChallenge) {
    params.set('code_challenge', options.codeChallenge);
    params.set('code_challenge_method', options.codeChallengeMethod ?? 'S256');
  }
  const sep = config.authorizeUrl.includes('?') ? '&' : '?';
  return `${config.authorizeUrl}${sep}${params.toString()}`;
}
