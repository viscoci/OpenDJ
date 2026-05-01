import type { OAuthProviderConfig, OAuthTokens } from './config.js';

interface TokenResponseBody {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

/**
 * Refresh threshold: refresh when fewer than this many ms remain. 60s gives a
 * comfortable margin for clock skew + in-flight requests.
 */
export const REFRESH_LEEWAY_MS = 60_000;

export class OAuthTokenError extends Error {
  readonly providerId: string;
  readonly status: number;
  readonly responseBody: string;

  constructor(providerId: string, status: number, responseBody: string) {
    super(`OAuth token endpoint for "${providerId}" returned ${status}: ${responseBody}`);
    this.name = 'OAuthTokenError';
    this.providerId = providerId;
    this.status = status;
    this.responseBody = responseBody;
  }
}

function normalizeTokens(body: TokenResponseBody, sampledAtEpochMs: number): OAuthTokens {
  const tokens: OAuthTokens = {
    accessToken: body.access_token,
  };
  if (body.refresh_token !== undefined) tokens.refreshToken = body.refresh_token;
  if (body.token_type !== undefined) tokens.tokenType = body.token_type;
  if (body.scope !== undefined) tokens.scopes = body.scope.split(/\s+/).filter(Boolean);
  if (body.id_token !== undefined) tokens.idToken = body.id_token;
  if (body.expires_in !== undefined && Number.isFinite(body.expires_in)) {
    tokens.expiresAtEpochMs = sampledAtEpochMs + body.expires_in * 1000;
  }
  return tokens;
}

async function postToken(
  url: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
}

export interface ExchangeCodeOptions {
  config: OAuthProviderConfig;
  clientId: string;
  clientSecret: string | undefined;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  fetchImpl?: typeof fetch;
  /** Override the sampled time used to compute `expiresAtEpochMs`. Default: Date.now(). */
  nowEpochMs?: number;
}

/**
 * Exchange an authorization code for tokens.
 *
 * Throws `OAuthTokenError` on non-2xx. JSON parse failures throw a regular
 * Error — those almost always indicate a misconfigured tokenUrl.
 */
export async function exchangeCode(options: ExchangeCodeOptions): Promise<OAuthTokens> {
  const { config, clientId, clientSecret, code, redirectUri, codeVerifier } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sampledAt = options.nowEpochMs ?? Date.now();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
  if (clientSecret !== undefined) body.set('client_secret', clientSecret);
  if (codeVerifier !== undefined) body.set('code_verifier', codeVerifier);

  const response = await postToken(config.tokenUrl, body, fetchImpl);
  if (!response.ok) {
    throw new OAuthTokenError(config.providerId, response.status, await response.text());
  }
  const json = (await response.json()) as TokenResponseBody;
  return normalizeTokens(json, sampledAt);
}

export interface RefreshTokensOptions {
  config: OAuthProviderConfig;
  clientId: string;
  clientSecret: string | undefined;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  nowEpochMs?: number;
}

export async function refreshTokens(options: RefreshTokensOptions): Promise<OAuthTokens> {
  const { config, clientId, clientSecret, refreshToken } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sampledAt = options.nowEpochMs ?? Date.now();

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret !== undefined) body.set('client_secret', clientSecret);

  const response = await postToken(config.tokenUrl, body, fetchImpl);
  if (!response.ok) {
    throw new OAuthTokenError(config.providerId, response.status, await response.text());
  }
  const json = (await response.json()) as TokenResponseBody;
  // Some providers omit the new refresh_token on refresh — reuse the old one.
  const tokens = normalizeTokens(json, sampledAt);
  if (tokens.refreshToken === undefined) {
    tokens.refreshToken = refreshToken;
  }
  return tokens;
}

/**
 * Should the caller refresh `tokens` now? True when expiry is within
 * REFRESH_LEEWAY_MS or unknown. False when no refresh token is available
 * (caller should re-authenticate instead).
 */
export function shouldRefresh(tokens: OAuthTokens, nowEpochMs: number): boolean {
  if (tokens.refreshToken === undefined) return false;
  if (tokens.expiresAtEpochMs === undefined) return true;
  return tokens.expiresAtEpochMs - nowEpochMs <= REFRESH_LEEWAY_MS;
}
