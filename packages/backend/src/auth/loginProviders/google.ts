/**
 * Google login provider — OIDC.
 *
 * Authorize/token URLs from Google's discovery doc; userinfo endpoint is
 * `https://openidconnect.googleapis.com/v1/userinfo` and accepts the
 * access token via `Authorization: Bearer`.
 *
 * Scopes: `openid email profile` covers everything we need (sub, email,
 * email_verified, name, picture).
 *
 * `id_token` signature verification against Google's JWKS is intentionally
 * skipped here — the userinfo fetch via Bearer is itself a verification
 * (only Google's authorization server signs tokens it'll accept). For
 * elevated-trust deployments, add JWKS verification before trusting `email`.
 */

import type { OAuthProviderConfig, OAuthTokens } from '@opendj/auth';
import type { LoginProviderHandler, ProviderProfile } from './types.js';

export const googleOAuthConfig: OAuthProviderConfig = {
  providerId: 'google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  defaultScopes: ['openid', 'email', 'profile'],
  verifiesIdToken: true,
};

interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export class GoogleLoginHandler implements LoginProviderHandler {
  readonly providerId = 'google';
  readonly oauthConfig = googleOAuthConfig;

  async fetchProfile(tokens: OAuthTokens, fetchImpl: typeof fetch): Promise<ProviderProfile> {
    const response = await fetchImpl(USERINFO_URL, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Google userinfo failed: ${response.status} ${await response.text().catch(() => '')}`,
      );
    }
    const body = (await response.json()) as GoogleUserInfo;
    return {
      providerSubject: body.sub,
      email: body.email ?? null,
      emailVerified: body.email_verified === true,
      displayName: body.name ?? null,
      avatarUrl: body.picture ?? null,
      raw: body,
    };
  }
}
