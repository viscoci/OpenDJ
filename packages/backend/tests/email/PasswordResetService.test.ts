/**
 * PasswordResetService — request flow doesn't leak; reset replaces the
 * password and is single-use.
 */

import { describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../src/auth/Argon2idPasswordHasher.js';
import {
  InMemoryEmailAdapter,
  PasswordResetError,
  PasswordResetService,
} from '../../src/email/index.js';
import {
  InMemoryAuthSessionRepository,
  InMemoryPasswordCredentialRepository,
  InMemoryPasswordResetTokenRepository,
  InMemoryUserRepository,
} from '../../src/repositories/in-memory/index.js';

function setup(opts: { ttlMs?: number } = {}) {
  const users = new InMemoryUserRepository();
  const tokens = new InMemoryPasswordResetTokenRepository();
  const credentials = new InMemoryPasswordCredentialRepository();
  const authSessions = new InMemoryAuthSessionRepository();
  const email = new InMemoryEmailAdapter();
  const passwordHasher = new Argon2idPasswordHasher({ memoryCost: 8 * 1024, timeCost: 2 });
  const service = new PasswordResetService({
    users,
    tokens,
    credentials,
    authSessions,
    passwordHasher,
    email,
    baseUrl: 'https://app.opendj.test',
    ...(opts.ttlMs !== undefined && { ttlMs: opts.ttlMs }),
  });
  return { service, users, tokens, credentials, authSessions, email, passwordHasher };
}

function extractToken(text: string): string {
  const m = /token=([^\s&]+)/.exec(text);
  if (!m || !m[1]) throw new Error(`No token in email body: ${text}`);
  return decodeURIComponent(m[1]);
}

describe('PasswordResetService.requestReset', () => {
  it('emails a reset link when the email exists', async () => {
    const { service, users, email, tokens } = setup();
    await users.create({ primaryEmail: 'host@example.com' });
    await service.requestReset({ email: 'host@example.com' });
    expect(email.lastFor('host@example.com')?.subject).toBe('Reset your password');
    expect(tokens.rows.size).toBe(1);
  });

  it('does NOT leak when the email is unknown — silent success, no token row', async () => {
    const { service, email, tokens } = setup();
    await service.requestReset({ email: 'never-existed@example.com' });
    expect(email.all()).toHaveLength(0);
    expect(tokens.rows.size).toBe(0);
  });

  it('lowercases the email before lookup', async () => {
    const { service, users, email } = setup();
    await users.create({ primaryEmail: 'host@example.com' });
    await service.requestReset({ email: 'Host@Example.COM' });
    // Email is sent to the lowercased address — that's what we stored.
    expect(email.lastFor('host@example.com')).toBeDefined();
  });
});

describe('PasswordResetService.completeReset', () => {
  it('swaps the password and consumes the token', async () => {
    const { service, users, credentials, email, passwordHasher } = setup();
    const user = await users.create({ primaryEmail: 'host@example.com' });
    await credentials.upsert({
      userId: user.id,
      passwordHash: await passwordHasher.hashPassword('original-password'),
      hashAlgorithm: 'argon2id',
    });
    await service.requestReset({ email: 'host@example.com' });
    const token = extractToken(email.lastFor('host@example.com')!.text);

    const result = await service.completeReset({
      token,
      newPassword: 'brand-new-password',
    });
    expect(result.userId).toBe(user.id);

    const cred = await credentials.findByUser(user.id);
    expect(await passwordHasher.verifyPassword('brand-new-password', cred!.passwordHash)).toBe(
      true,
    );
    expect(await passwordHasher.verifyPassword('original-password', cred!.passwordHash)).toBe(
      false,
    );
  });

  it('rejects a replayed token', async () => {
    const { service, users, credentials, email, passwordHasher } = setup();
    const user = await users.create({ primaryEmail: 'host@example.com' });
    await credentials.upsert({
      userId: user.id,
      passwordHash: await passwordHasher.hashPassword('orig'),
      hashAlgorithm: 'argon2id',
    });
    await service.requestReset({ email: 'host@example.com' });
    const token = extractToken(email.lastFor('host@example.com')!.text);
    await service.completeReset({ token, newPassword: 'new-password-1' });
    await expect(
      service.completeReset({ token, newPassword: 'new-password-2' }),
    ).rejects.toMatchObject({ code: 'invalid_or_expired_token' });
  });

  it('rejects an expired token', async () => {
    const { service, users, credentials, email, passwordHasher } = setup({ ttlMs: 100 });
    const user = await users.create({ primaryEmail: 'host@example.com' });
    await credentials.upsert({
      userId: user.id,
      passwordHash: await passwordHasher.hashPassword('orig'),
      hashAlgorithm: 'argon2id',
    });
    await service.requestReset({ email: 'host@example.com' });
    const token = extractToken(email.lastFor('host@example.com')!.text);
    await expect(
      service.completeReset({
        token,
        newPassword: 'new-password',
        nowEpochMs: Date.now() + 1_000,
      }),
    ).rejects.toMatchObject({ code: 'invalid_or_expired_token' });
  });

  it('rejects a too-short password', async () => {
    const { service } = setup();
    await expect(
      service.completeReset({ token: 'whatever', newPassword: 'short' }),
    ).rejects.toBeInstanceOf(PasswordResetError);
  });

  it('resets failed-attempt counter on success', async () => {
    const { service, users, credentials, email, passwordHasher } = setup();
    const user = await users.create({ primaryEmail: 'host@example.com' });
    await credentials.upsert({
      userId: user.id,
      passwordHash: await passwordHasher.hashPassword('orig'),
      hashAlgorithm: 'argon2id',
    });
    // simulate prior failed attempts
    await credentials.recordFailedAttempt(user.id, null);
    await credentials.recordFailedAttempt(user.id, null);
    expect((await credentials.findByUser(user.id))!.failedAttempts).toBe(2);

    await service.requestReset({ email: 'host@example.com' });
    const token = extractToken(email.lastFor('host@example.com')!.text);
    await service.completeReset({ token, newPassword: 'brand-new-password' });

    expect((await credentials.findByUser(user.id))!.failedAttempts).toBe(0);
  });
});
