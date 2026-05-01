import { describe, expect, it, vi } from 'vitest';
import type { OAuthProviderConfig } from '../../src/oauth/config.js';
import {
  exchangeCode,
  OAuthTokenError,
  refreshTokens,
  REFRESH_LEEWAY_MS,
  shouldRefresh,
} from '../../src/oauth/token.js';

const config: OAuthProviderConfig = {
  providerId: 'spotify',
  authorizeUrl: 'https://accounts.spotify.com/authorize',
  tokenUrl: 'https://accounts.spotify.com/api/token',
  defaultScopes: ['scope-a'],
};

function fakeFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return impl(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function getBody(fetchImpl: typeof fetch): URLSearchParams {
  const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as
    | RequestInit
    | undefined;
  return new URLSearchParams(init?.body as string);
}

describe('exchangeCode', () => {
  it('POSTs grant_type=authorization_code with code + redirect_uri + client_id', async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
    );
    await exchangeCode({
      config,
      clientId: 'c',
      clientSecret: 's',
      code: 'CODE',
      redirectUri: 'https://app.example/cb',
      fetchImpl,
      nowEpochMs: 1_000_000,
    });
    const body = getBody(fetchImpl);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('redirect_uri')).toBe('https://app.example/cb');
    expect(body.get('client_id')).toBe('c');
    expect(body.get('client_secret')).toBe('s');
  });

  it('omits client_secret when undefined (PKCE-only public clients)', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ access_token: 'AT' }));
    await exchangeCode({
      config,
      clientId: 'c',
      clientSecret: undefined,
      code: 'CODE',
      redirectUri: 'r',
      codeVerifier: 'verifier',
      fetchImpl,
    });
    const body = getBody(fetchImpl);
    expect(body.has('client_secret')).toBe(false);
    expect(body.get('code_verifier')).toBe('verifier');
  });

  it('normalizes the response: expiresAtEpochMs derived from expires_in + nowEpochMs', async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
    );
    const tokens = await exchangeCode({
      config,
      clientId: 'c',
      clientSecret: 's',
      code: 'CODE',
      redirectUri: 'r',
      fetchImpl,
      nowEpochMs: 1_000_000,
    });
    expect(tokens.accessToken).toBe('AT');
    expect(tokens.refreshToken).toBe('RT');
    expect(tokens.expiresAtEpochMs).toBe(1_000_000 + 3_600_000);
  });

  it('parses scope string into a scopes array', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ access_token: 'AT', scope: 'a b  c' }));
    const tokens = await exchangeCode({
      config,
      clientId: 'c',
      clientSecret: 's',
      code: 'CODE',
      redirectUri: 'r',
      fetchImpl,
    });
    expect(tokens.scopes).toEqual(['a', 'b', 'c']);
  });

  it('throws OAuthTokenError on non-2xx response', async () => {
    const fetchImpl = fakeFetch(() => new Response('bad', { status: 400 }));
    await expect(
      exchangeCode({
        config,
        clientId: 'c',
        clientSecret: 's',
        code: 'CODE',
        redirectUri: 'r',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OAuthTokenError);
  });
});

describe('refreshTokens', () => {
  it('POSTs grant_type=refresh_token + refresh_token', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ access_token: 'NEW_AT' }));
    await refreshTokens({
      config,
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'RT',
      fetchImpl,
    });
    const body = getBody(fetchImpl);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('RT');
  });

  it('reuses the old refresh token when the response omits one', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ access_token: 'NEW_AT' }));
    const tokens = await refreshTokens({
      config,
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'RT',
      fetchImpl,
    });
    expect(tokens.refreshToken).toBe('RT');
  });

  it('uses the new refresh token when the response includes one', async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({ access_token: 'NEW_AT', refresh_token: 'RT2' }),
    );
    const tokens = await refreshTokens({
      config,
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'RT',
      fetchImpl,
    });
    expect(tokens.refreshToken).toBe('RT2');
  });

  it('throws OAuthTokenError on failure', async () => {
    const fetchImpl = fakeFetch(() => new Response('bad', { status: 401 }));
    await expect(
      refreshTokens({
        config,
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'RT',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OAuthTokenError);
  });
});

describe('shouldRefresh', () => {
  it('returns false with no refresh token (cannot refresh anyway)', () => {
    expect(shouldRefresh({ accessToken: 'AT' }, 1_000_000)).toBe(false);
  });

  it('returns true when expiry unknown (treat as immediate)', () => {
    expect(shouldRefresh({ accessToken: 'AT', refreshToken: 'RT' }, 1_000_000)).toBe(true);
  });

  it('returns false when comfortably in the future', () => {
    expect(
      shouldRefresh(
        { accessToken: 'AT', refreshToken: 'RT', expiresAtEpochMs: 2_000_000 },
        1_000_000,
      ),
    ).toBe(false);
  });

  it('returns true when within REFRESH_LEEWAY_MS of expiry', () => {
    expect(
      shouldRefresh(
        {
          accessToken: 'AT',
          refreshToken: 'RT',
          expiresAtEpochMs: 1_000_000 + REFRESH_LEEWAY_MS - 1,
        },
        1_000_000,
      ),
    ).toBe(true);
  });

  it('returns true when already expired', () => {
    expect(
      shouldRefresh(
        { accessToken: 'AT', refreshToken: 'RT', expiresAtEpochMs: 999_000 },
        1_000_000,
      ),
    ).toBe(true);
  });
});
