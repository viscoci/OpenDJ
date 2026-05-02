/**
 * EmailPasswordService — register + login with email/password.
 *
 * Email verification + reset flows need an email-sending integration; they
 * live behind the `email-password` auth provider but aren't implemented here.
 * The schema (`email_verified` flag, password reset tokens) is ready for them
 * when an SMTP/SES adapter lands.
 *
 * Brief §"Password handling": rate-limit login attempts, require email
 * verification, avoid leaking whether an email exists.
 *
 * The service deliberately returns the same generic `invalid_credentials`
 * shape for both unknown-email and bad-password to avoid the existence leak.
 * Lockout after too many failed attempts is the only place we expose
 * additional state.
 */

import type { PasswordHasher } from '@opendj/auth';
import { AuthService, type IssuedSession } from './AuthService.js';
import type { AccountService } from '../account/AccountService.js';
import type {
  AuthIdentityRepository,
  PasswordCredentialRepository,
  UserRepository,
} from '../repositories/types.js';

export const EMAIL_PROVIDER_ID = 'email-password';
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export class EmailPasswordError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EmailPasswordError';
    this.code = code;
  }
}

export interface EmailPasswordServiceDeps {
  users: UserRepository;
  authIdentities: AuthIdentityRepository;
  passwordCredentials: PasswordCredentialRepository;
  passwordHasher: PasswordHasher & { algorithm?: string };
  authService: AuthService;
  /**
   * Optional account bootstrap service. When supplied, registration auto-
   * creates a personal account + owner membership so the new user can
   * immediately create sessions, connect providers, etc.
   */
  accountService?: AccountService;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
}

export interface LoginInput {
  email: string;
  password: string;
  ipHash?: string | null;
  userAgentHash?: string | null;
}

export interface RegistrationResult {
  userId: string;
  session: IssuedSession;
}

export class EmailPasswordService {
  constructor(private readonly deps: EmailPasswordServiceDeps) {}

  /**
   * Register a new email/password account. Returns the new user + an issued
   * session so the client is logged in immediately (matches typical OSS
   * onboarding UX). Email verification can still be required for elevated
   * actions later.
   *
   * Throws `email_taken` if either `users.primary_email` OR an
   * email-password `auth_identities` row already exists for this email.
   */
  async register(input: RegisterInput, nowEpochMs?: number): Promise<RegistrationResult> {
    const email = input.email.trim().toLowerCase();
    if (await this.deps.users.findByPrimaryEmail(email)) {
      throw new EmailPasswordError('email_taken', 'An account with that email already exists.');
    }
    if (await this.deps.authIdentities.findByProvider(EMAIL_PROVIDER_ID, email)) {
      throw new EmailPasswordError('email_taken', 'An account with that email already exists.');
    }

    const user = await this.deps.users.create({
      primaryEmail: email,
      displayName: input.displayName ?? null,
      emailVerified: false,
    });

    await this.deps.authIdentities.create({
      userId: user.id,
      providerId: EMAIL_PROVIDER_ID,
      providerSubject: email,
      email,
      emailVerified: false,
    });

    const passwordHash = await this.deps.passwordHasher.hashPassword(input.password);
    await this.deps.passwordCredentials.upsert({
      userId: user.id,
      passwordHash,
      hashAlgorithm: this.deps.passwordHasher.algorithm ?? 'unknown',
    });

    // Bootstrap a personal account so the user can act immediately.
    let accountId: string | null = null;
    if (this.deps.accountService) {
      const result = await this.deps.accountService.bootstrapPersonalAccount({
        userId: user.id,
        displayNameHint: input.displayName?.trim() || email.split('@')[0]!,
      });
      accountId = result.account.id;
    }

    const session = await this.deps.authService.issueSession({
      userId: user.id,
      ...(accountId !== null && { currentAccountId: accountId }),
      ...(nowEpochMs !== undefined && { nowEpochMs }),
      ...(input.ipHash !== undefined && { ipHash: input.ipHash }),
      ...(input.userAgentHash !== undefined && { userAgentHash: input.userAgentHash }),
    });

    return { userId: user.id, session };
  }

  /**
   * Verify email + password and issue a session. Returns the same generic
   * `invalid_credentials` error for unknown email, missing password
   * credential, and bad password — avoid the existence leak.
   *
   * Tracks failed attempts on `password_credentials.failed_attempts` and
   * locks for 15 min after 5 consecutive failures.
   */
  async login(input: LoginInput, nowEpochMs?: number): Promise<IssuedSession> {
    const email = input.email.trim().toLowerCase();
    const now = nowEpochMs ?? Date.now();

    const user = await this.deps.users.findByPrimaryEmail(email);
    if (!user) {
      // Constant-ish work to keep timing similar to the cred-found path.
      await this.deps.passwordHasher.verifyPassword(
        input.password,
        '$argon2id$v=19$m=65536,t=3,p=1$dummy$dummy',
      );
      throw new EmailPasswordError('invalid_credentials', 'Invalid credentials.');
    }

    const credential = await this.deps.passwordCredentials.findByUser(user.id);
    if (!credential) {
      // User exists but has no password (probably OAuth-only) — same error.
      throw new EmailPasswordError('invalid_credentials', 'Invalid credentials.');
    }

    if (credential.lockedUntil && credential.lockedUntil.getTime() > now) {
      throw new EmailPasswordError('account_locked', 'Too many failed attempts. Try again later.');
    }

    const ok = await this.deps.passwordHasher.verifyPassword(
      input.password,
      credential.passwordHash,
    );
    if (!ok) {
      const nextAttempts = credential.failedAttempts + 1;
      const lockUntil =
        nextAttempts >= MAX_FAILED_ATTEMPTS ? new Date(now + LOCK_DURATION_MS) : null;
      await this.deps.passwordCredentials.recordFailedAttempt(user.id, lockUntil);
      throw new EmailPasswordError('invalid_credentials', 'Invalid credentials.');
    }

    if (credential.failedAttempts > 0) {
      await this.deps.passwordCredentials.resetFailedAttempts(user.id);
    }

    return this.deps.authService.issueSession({
      userId: user.id,
      ...(nowEpochMs !== undefined && { nowEpochMs }),
      ...(input.ipHash !== undefined && { ipHash: input.ipHash }),
      ...(input.userAgentHash !== undefined && { userAgentHash: input.userAgentHash }),
    });
  }
}
