/**
 * GoogleLoginHandler.fetchProfile — verifies the OIDC userinfo endpoint is
 * called with the right Bearer token and the response is normalized.
 */

import { describe, expect, it } from 'vitest';
import type { OAuthTokens } from '@opendj/auth';
import { GoogleLoginHandler } from '../../src/auth/loginProviders/google.js';

const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function tokens(): OAuthTokens {
  return { accessToken: 'goog-access' };
}

describe('GoogleLoginHandler.fetchProfile', () => {
  it('fetches userinfo with Bearer auth and normalizes the response', async () => {
    let calledUrl = '';
    let calledAuth = '';
    const fakeFetch: typeof fetch = async (input, init) => {
      calledUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calledAuth = headers['authorization'] ?? '';
      return new Response(
        JSON.stringify({
          sub: '108888777666',
          email: 'someone@gmail.com',
          email_verified: true,
          name: 'Some One',
          picture: 'https://lh3.googleusercontent.com/a/abc',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const handler = new GoogleLoginHandler();
    const profile = await handler.fetchProfile(tokens(), fakeFetch);
    expect(calledUrl).toBe(USERINFO_URL);
    expect(calledAuth).toBe('Bearer goog-access');
    expect(profile).toEqual({
      providerSubject: '108888777666',
      email: 'someone@gmail.com',
      emailVerified: true,
      displayName: 'Some One',
      avatarUrl: 'https://lh3.googleusercontent.com/a/abc',
      raw: expect.any(Object),
    });
  });

  it('handles missing optional fields (no picture, no email)', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ sub: 'sub-only' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const handler = new GoogleLoginHandler();
    const profile = await handler.fetchProfile(tokens(), fakeFetch);
    expect(profile.providerSubject).toBe('sub-only');
    expect(profile.email).toBeNull();
    expect(profile.emailVerified).toBe(false);
    expect(profile.displayName).toBeNull();
    expect(profile.avatarUrl).toBeNull();
  });

  it('throws on non-2xx userinfo response', async () => {
    const fakeFetch: typeof fetch = async () => new Response('Unauthorized', { status: 401 });
    const handler = new GoogleLoginHandler();
    await expect(handler.fetchProfile(tokens(), fakeFetch)).rejects.toThrow(
      /Google userinfo failed: 401/,
    );
  });
});
