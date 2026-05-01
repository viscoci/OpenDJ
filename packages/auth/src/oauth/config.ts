/**
 * OAuth provider configuration. The same shape drives login providers (Google,
 * Apple, Facebook) and music/service providers (Spotify, Soundtrack, ...).
 *
 * Concrete configs live in @opendj/backend (where the route layer needs them);
 * @opendj/auth keeps the type + pure helpers so adapters can be unit-tested
 * without bringing in Hono.
 */

export interface OAuthProviderConfig {
  providerId: string;
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: ReadonlyArray<string>;
  /** PKCE is required for public-client flows (e.g. native apps). */
  usesPkce?: boolean;
  /**
   * Some providers (e.g. Apple) sign their responses; verifier injection happens
   * in the consumer route. This flag is informational — it doesn't change
   * behavior in the helpers below.
   */
  verifiesIdToken?: boolean;
}

/**
 * OAuth tokens as returned (and normalized from) the provider's token endpoint.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Wall-clock expiry. Computed from `expires_in` + sample time. */
  expiresAtEpochMs?: number;
  tokenType?: string;
  scopes?: ReadonlyArray<string>;
  /** OIDC id_token, when present. */
  idToken?: string;
}
