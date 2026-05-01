import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl } from '../../src/oauth/authorize.js';
import type { OAuthProviderConfig } from '../../src/oauth/config.js';

const spotify: OAuthProviderConfig = {
  providerId: 'spotify',
  authorizeUrl: 'https://accounts.spotify.com/authorize',
  tokenUrl: 'https://accounts.spotify.com/api/token',
  defaultScopes: ['user-read-playback-state', 'user-modify-playback-state'],
};

const pkceProvider: OAuthProviderConfig = {
  ...spotify,
  providerId: 'spotify-pkce',
  usesPkce: true,
};

describe('buildAuthorizeUrl', () => {
  it('includes core OAuth params', () => {
    const url = buildAuthorizeUrl(spotify, 'client123', 'https://app.example/cb', 'state-abc');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('client123');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example/cb');
    expect(parsed.searchParams.get('state')).toBe('state-abc');
  });

  it('uses default scopes when not overridden', () => {
    const url = buildAuthorizeUrl(spotify, 'c', 'r', 's');
    expect(new URL(url).searchParams.get('scope')).toBe(
      'user-read-playback-state user-modify-playback-state',
    );
  });

  it('overrides scopes when provided', () => {
    const url = buildAuthorizeUrl(spotify, 'c', 'r', 's', ['playlist-read-private']);
    expect(new URL(url).searchParams.get('scope')).toBe('playlist-read-private');
  });

  it('omits PKCE params when config does not enable PKCE', () => {
    const url = buildAuthorizeUrl(spotify, 'c', 'r', 's', undefined, {
      codeChallenge: 'abc',
      codeChallengeMethod: 'S256',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('code_challenge')).toBeNull();
    expect(parsed.searchParams.get('code_challenge_method')).toBeNull();
  });

  it('adds PKCE params when config enables PKCE and challenge provided', () => {
    const url = buildAuthorizeUrl(pkceProvider, 'c', 'r', 's', undefined, {
      codeChallenge: 'abc',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('code_challenge')).toBe('abc');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('honors plain method when explicitly set', () => {
    const url = buildAuthorizeUrl(pkceProvider, 'c', 'r', 's', undefined, {
      codeChallenge: 'abc',
      codeChallengeMethod: 'plain',
    });
    expect(new URL(url).searchParams.get('code_challenge_method')).toBe('plain');
  });

  it('appends to existing query string in authorizeUrl', () => {
    const config: OAuthProviderConfig = {
      ...spotify,
      authorizeUrl: 'https://provider.example/authorize?prompt=consent',
    };
    const url = buildAuthorizeUrl(config, 'c', 'r', 's');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('client_id')).toBe('c');
  });
});
