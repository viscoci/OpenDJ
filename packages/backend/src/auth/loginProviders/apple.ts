/**
 * Apple login provider — STUB.
 *
 * Apple's "Sign in with Apple" needs:
 * 1. JWT signature verification against Apple's JWKS (`https://appleid.apple.com/auth/keys`)
 * 2. id_token claim parsing (Apple has no `/userinfo` — profile lives in the JWT)
 * 3. Private-relay email handling (Apple may proxy a `*.privaterelay.appleid.com` address)
 * 4. First-login `name` capture from the form_post body (Apple only sends it once)
 *
 * Shipping a half-implemented login provider is worse than no provider — the
 * stub here registers the OAuth config so the route framework recognizes
 * `/auth/apple/...` URLs but throws at the profile-fetch step. Routes return
 * 501 `login_provider_not_implemented`.
 */

import type { OAuthProviderConfig, OAuthTokens } from '@opendj/auth';
import {
  LoginProviderNotImplementedError,
  type LoginProviderHandler,
  type ProviderProfile,
} from './types.js';

export const appleOAuthConfig: OAuthProviderConfig = {
  providerId: 'apple',
  authorizeUrl: 'https://appleid.apple.com/auth/authorize',
  tokenUrl: 'https://appleid.apple.com/auth/token',
  defaultScopes: ['name', 'email'],
  verifiesIdToken: true,
};

export class AppleLoginHandler implements LoginProviderHandler {
  readonly providerId = 'apple';
  readonly oauthConfig = appleOAuthConfig;

  async fetchProfile(_tokens: OAuthTokens, _fetchImpl: typeof fetch): Promise<ProviderProfile> {
    throw new LoginProviderNotImplementedError(
      'apple',
      'JWKS-based id_token verification is not implemented yet.',
    );
  }
}
