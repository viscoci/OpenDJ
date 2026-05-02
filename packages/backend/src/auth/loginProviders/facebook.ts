/**
 * Facebook login provider — STUB.
 *
 * Facebook is OAuth 2.0, not OIDC, with several behavior quirks:
 *
 * 1. Token exchange uses GET (not POST) at `/oauth/access_token`
 * 2. Profile is fetched from `/me?fields=id,name,email` (Graph API) with
 *    explicit `fields` query
 * 3. Email is OPTIONAL even with the `email` scope — users can deny it; routes
 *    must handle the missing-email case
 * 4. `email_verified` is implied by Facebook, but not exposed
 *
 * Marking as not-implemented for v1 — the OAuth config is registered so the
 * route framework recognizes `/auth/facebook/...` but `fetchProfile` throws.
 */

import type { OAuthProviderConfig, OAuthTokens } from '@opendj/auth';
import {
  LoginProviderNotImplementedError,
  type LoginProviderHandler,
  type ProviderProfile,
} from './types.js';

export const facebookOAuthConfig: OAuthProviderConfig = {
  providerId: 'facebook',
  authorizeUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
  tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
  defaultScopes: ['email', 'public_profile'],
};

export class FacebookLoginHandler implements LoginProviderHandler {
  readonly providerId = 'facebook';
  readonly oauthConfig = facebookOAuthConfig;

  async fetchProfile(_tokens: OAuthTokens, _fetchImpl: typeof fetch): Promise<ProviderProfile> {
    throw new LoginProviderNotImplementedError(
      'facebook',
      'OAuth2 (non-OIDC) flow + Graph API profile fetch are not implemented yet.',
    );
  }
}
