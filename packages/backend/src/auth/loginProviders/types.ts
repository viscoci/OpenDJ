/**
 * Shared types for login OAuth providers (Google / Apple / Facebook / etc.).
 *
 * Login providers and music-service providers share the same `OAuthProviderConfig`
 * shape from `@opendj/auth`, but login providers also need to fetch a normalized
 * profile after the token exchange so we can upsert `users` + `auth_identities`.
 */

import type { OAuthProviderConfig, OAuthTokens } from '@opendj/auth';

export interface ProviderProfile {
  /**
   * Stable provider-native identifier — Google's `sub`, Apple's `sub`,
   * Facebook's `id`. Goes into `auth_identities.provider_subject`.
   */
  providerSubject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  /** Raw payload for debug + future-extensibility; persisted as `raw_profile` jsonb. */
  raw: unknown;
}

export interface LoginProviderHandler {
  readonly providerId: string;
  readonly oauthConfig: OAuthProviderConfig;
  /**
   * Fetch + normalize the provider's profile after a successful token exchange.
   * `fetchImpl` is supplied by the route layer (Workers can pass an outbound
   * binding; tests pass a mock).
   */
  fetchProfile(tokens: OAuthTokens, fetchImpl: typeof fetch): Promise<ProviderProfile>;
}

export class LoginProviderNotImplementedError extends Error {
  readonly providerId: string;
  constructor(providerId: string, reason: string) {
    super(`Login provider "${providerId}" is not implemented: ${reason}`);
    this.name = 'LoginProviderNotImplementedError';
    this.providerId = providerId;
  }
}
