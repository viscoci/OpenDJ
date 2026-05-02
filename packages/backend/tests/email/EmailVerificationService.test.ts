/**
 * EmailVerificationService — issues + consumes one-time verification tokens.
 */

import { describe, expect, it } from 'vitest';
import {
  EmailVerificationError,
  EmailVerificationService,
  InMemoryEmailAdapter,
} from '../../src/email/index.js';
import {
  InMemoryEmailVerificationTokenRepository,
  InMemoryUserRepository,
} from '../../src/repositories/in-memory/index.js';

function setup() {
  const users = new InMemoryUserRepository();
  const tokens = new InMemoryEmailVerificationTokenRepository();
  const email = new InMemoryEmailAdapter();
  const service = new EmailVerificationService({
    users,
    tokens,
    email,
    baseUrl: 'https://app.opendj.test',
  });
  return { service, users, tokens, email };
}

describe('EmailVerificationService.requestVerification', () => {
  it('emails a verification link with an opaque token', async () => {
    const { service, users, email, tokens } = setup();
    const user = await users.create({ primaryEmail: 'host@example.com' });
    await service.requestVerification({ userId: user.id, email: 'host@example.com' });
    const sent = email.lastFor('host@example.com');
    expect(sent).toBeDefined();
    expect(sent?.subject).toBe('Verify your email');
    expect(sent?.text).toMatch(/https:\/\/app\.opendj\.test\/api\/v1\/auth\/email\/verify\?token=/);
    expect(tokens.rows.size).toBe(1);
  });

  it('throws user_not_found for an unknown user id', async () => {
    const { service } = setup();
    await expect(
      service.requestVerification({
        userId: '00000000-0000-0000-0000-000000000000',
        email: 'x@y.test',
      }),
    ).rejects.toMatchObject({ code: 'user_not_found' });
  });
});

describe('EmailVerificationService.verifyToken', () => {
  it('consumes the token and sets users.emailVerified=true', async () => {
    const { service, users, email } = setup();
    const user = await users.create({ primaryEmail: 'host@example.com', emailVerified: false });
    await service.requestVerification({ userId: user.id, email: 'host@example.com' });
    const sent = email.lastFor('host@example.com')!;
    const token = extractToken(sent.text);
    const result = await service.verifyToken(token);
    expect(result.userId).toBe(user.id);
    expect(result.email).toBe('host@example.com');
    const refreshed = await users.findById(user.id);
    expect(refreshed?.emailVerified).toBe(true);
  });

  it('rejects a replayed token (single-use)', async () => {
    const { service, users, email } = setup();
    const user = await users.create({ primaryEmail: 'host@example.com' });
    await service.requestVerification({ userId: user.id, email: 'host@example.com' });
    const token = extractToken(email.lastFor('host@example.com')!.text);
    await service.verifyToken(token);
    await expect(service.verifyToken(token)).rejects.toBeInstanceOf(EmailVerificationError);
  });

  it('rejects an unknown token', async () => {
    const { service } = setup();
    await expect(service.verifyToken('not-a-real-token')).rejects.toMatchObject({
      code: 'invalid_or_expired_token',
    });
  });

  it('rejects an expired token', async () => {
    const users = new InMemoryUserRepository();
    const tokens = new InMemoryEmailVerificationTokenRepository();
    const email = new InMemoryEmailAdapter();
    const service = new EmailVerificationService({
      users,
      tokens,
      email,
      baseUrl: 'https://app.opendj.test',
      ttlMs: 100, // 100ms
    });
    const user = await users.create({ primaryEmail: 'host@example.com' });
    await service.requestVerification({ userId: user.id, email: 'host@example.com' });
    const token = extractToken(email.lastFor('host@example.com')!.text);
    // Verify with a clock 200ms past expiry
    await expect(service.verifyToken(token, Date.now() + 1_000)).rejects.toMatchObject({
      code: 'invalid_or_expired_token',
    });
  });
});

function extractToken(text: string): string {
  const m = /token=([^\s&]+)/.exec(text);
  if (!m || !m[1]) throw new Error(`No token in email body: ${text}`);
  return decodeURIComponent(m[1]);
}
