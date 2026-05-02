/**
 * Apple + Facebook login handlers are stubs — verify they throw
 * LoginProviderNotImplementedError so the route returns 501.
 */

import { describe, expect, it } from 'vitest';
import type { OAuthTokens } from '@opendj/auth';
import { AppleLoginHandler } from '../../src/auth/loginProviders/apple.js';
import { FacebookLoginHandler } from '../../src/auth/loginProviders/facebook.js';
import { LoginProviderNotImplementedError } from '../../src/auth/loginProviders/types.js';

const tokens: OAuthTokens = { accessToken: 'x' };
const noopFetch: typeof fetch = async () => new Response();

describe('AppleLoginHandler', () => {
  it('throws LoginProviderNotImplementedError on fetchProfile', async () => {
    await expect(new AppleLoginHandler().fetchProfile(tokens, noopFetch)).rejects.toBeInstanceOf(
      LoginProviderNotImplementedError,
    );
  });
});

describe('FacebookLoginHandler', () => {
  it('throws LoginProviderNotImplementedError on fetchProfile', async () => {
    await expect(new FacebookLoginHandler().fetchProfile(tokens, noopFetch)).rejects.toBeInstanceOf(
      LoginProviderNotImplementedError,
    );
  });
});
