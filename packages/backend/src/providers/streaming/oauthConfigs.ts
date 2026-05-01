/**
 * Streaming-provider OAuth configurations.
 *
 * Same shape used by `@opendj/auth`'s `OAuthProviderConfig` — the helpers
 * (`buildAuthorizeUrl`, `exchangeCode`, `refreshTokens`) consume these.
 *
 * Extend the registry as new providers gain real OAuth implementations.
 */

import type { OAuthProviderConfig } from '@opendj/auth';
import { SPOTIFY_SCOPES } from '@opendj/core';

export const spotifyOAuthConfig: OAuthProviderConfig = {
  providerId: 'spotify',
  authorizeUrl: 'https://accounts.spotify.com/authorize',
  tokenUrl: 'https://accounts.spotify.com/api/token',
  defaultScopes: SPOTIFY_SCOPES,
};

export type StreamingProviderOAuthRegistry = Readonly<Record<string, OAuthProviderConfig>>;

/**
 * Default registry — covers the providers OpenDJ supports today. Hosted /
 * private deployments can extend at the call site.
 */
export const defaultStreamingProviderOAuthConfigs: StreamingProviderOAuthRegistry = {
  spotify: spotifyOAuthConfig,
};
