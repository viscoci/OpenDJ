import { describe, expect, it } from 'vitest';
import type { PasswordHasher } from '@opendj/auth';
import { Argon2idPasswordHasher } from '../../src/auth/Argon2idPasswordHasher.js';
import { AuthService } from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import {
  EMAIL_PROVIDER_ID,
  EmailPasswordError,
  EmailPasswordService,
} from '../../src/auth/EmailPasswordService.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthIdentityRepository,
  InMemoryAuthSessionRepository,
  InMemoryMembershipRepository,
  InMemoryPasswordCredentialRepository,
  InMemoryUserRepository,
} from '../../src/repositories/in-memory/index.js';

const NOW = new Date('2026-04-30T12:00:00Z').getTime();

function setup(opts: { hasher?: PasswordHasher & { algorithm?: string } } = {}) {
  const clock = { now: () => new Date(NOW) };
  const users = new InMemoryUserRepository(clock);
  const accounts = new InMemoryAccountRepository();
  const memberships = new InMemoryMembershipRepository();
  const authIdentities = new InMemoryAuthIdentityRepository(clock);
  const authSessions = new InMemoryAuthSessionRepository(clock);
  const passwordCredentials = new InMemoryPasswordCredentialRepository(clock);
  const claims = new ClaimsService({ memberships, accounts });
  const authService = new AuthService({ authSessions, claims });
  const passwordHasher =
    opts.hasher ?? new Argon2idPasswordHasher({ memoryCost: 8 * 1024, timeCost: 2 });
  const service = new EmailPasswordService({
    users,
    authIdentities,
    passwordCredentials,
    passwordHasher,
    authService,
  });
  return {
    service,
    users,
    authIdentities,
    authSessions,
    passwordCredentials,
    passwordHasher,
    authService,
  };
}

describe('EmailPasswordService.register', () => {
  it('creates a user, auth_identity, password_credential, and issues a session', async () => {
    const { service, users, authIdentities, passwordCredentials } = setup();
    const result = await service.register(
      { email: 'user@Example.com', password: 'correct horse battery staple', displayName: 'U' },
      NOW,
    );
    expect(result.session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(users.rows.size).toBe(1);
    const user = [...users.rows.values()][0]!;
    expect(user.primaryEmail).toBe('user@example.com'); // lowercased
    expect(user.displayName).toBe('U');
    const identity = await authIdentities.findByProvider(EMAIL_PROVIDER_ID, 'user@example.com');
    expect(identity?.userId).toBe(user.id);
    const credential = await passwordCredentials.findByUser(user.id);
    expect(credential?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(credential?.hashAlgorithm).toBe('argon2id');
  });

  it('throws email_taken when an existing user has the same primary email', async () => {
    const { service, users } = setup();
    await users.create({ primaryEmail: 'user@example.com' });
    await expect(
      service.register({ email: 'USER@example.com', password: 'pw-long-enough' }, NOW),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('throws email_taken when an email-password identity already exists', async () => {
    const { service, authIdentities, users } = setup();
    const u = await users.create({ primaryEmail: null });
    await authIdentities.create({
      userId: u.id,
      providerId: EMAIL_PROVIDER_ID,
      providerSubject: 'user@example.com',
      email: 'user@example.com',
    });
    await expect(
      service.register({ email: 'user@example.com', password: 'pw-long-enough' }, NOW),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });
});

describe('EmailPasswordService.login', () => {
  async function registerAndLogin(opts: { wrongPassword?: boolean } = {}) {
    const harness = setup();
    await harness.service.register(
      { email: 'user@example.com', password: 'correct-horse-battery-staple' },
      NOW,
    );
    return {
      ...harness,
      doLogin: () =>
        harness.service.login(
          {
            email: 'user@example.com',
            password: opts.wrongPassword ? 'wrong-password' : 'correct-horse-battery-staple',
          },
          NOW + 1000,
        ),
    };
  }

  it('returns a session for valid credentials', async () => {
    const { doLogin } = await registerAndLogin();
    const session = await doLogin();
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects invalid_credentials for wrong password (no leak)', async () => {
    const { doLogin } = await registerAndLogin({ wrongPassword: true });
    await expect(doLogin()).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects invalid_credentials for unknown email (no leak)', async () => {
    const { service } = setup();
    await expect(
      service.login({ email: 'never-existed@example.com', password: 'whatever' }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects invalid_credentials when the user has no password credential (OAuth-only user)', async () => {
    const { service, users } = setup();
    await users.create({ primaryEmail: 'oauth-only@example.com' });
    await expect(
      service.login({ email: 'oauth-only@example.com', password: 'whatever' }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('locks the account after 5 failed attempts', async () => {
    const harness = setup();
    await harness.service.register(
      { email: 'user@example.com', password: 'correct-horse-battery-staple' },
      NOW,
    );
    for (let i = 0; i < 5; i += 1) {
      await expect(
        harness.service.login({ email: 'user@example.com', password: 'wrong' }, NOW + i),
      ).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
    await expect(
      harness.service.login(
        { email: 'user@example.com', password: 'correct-horse-battery-staple' },
        NOW + 100,
      ),
    ).rejects.toMatchObject({ code: 'account_locked' });
  });

  it('resets the failed-attempt counter on successful login', async () => {
    const { service, passwordCredentials } = setup();
    const reg = await service.register(
      { email: 'user@example.com', password: 'correct-horse-battery-staple' },
      NOW,
    );
    // Two bad attempts, then a good one
    await expect(
      service.login({ email: 'user@example.com', password: 'wrong' }, NOW + 1),
    ).rejects.toThrow();
    await expect(
      service.login({ email: 'user@example.com', password: 'wrong' }, NOW + 2),
    ).rejects.toThrow();
    let credential = await passwordCredentials.findByUser(reg.userId);
    expect(credential?.failedAttempts).toBe(2);
    await service.login(
      { email: 'user@example.com', password: 'correct-horse-battery-staple' },
      NOW + 3,
    );
    credential = await passwordCredentials.findByUser(reg.userId);
    expect(credential?.failedAttempts).toBe(0);
  });
});
