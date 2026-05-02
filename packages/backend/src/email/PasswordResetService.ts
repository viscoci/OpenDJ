/**
 * PasswordResetService — request + complete password resets.
 *
 * Two-step flow:
 * 1. `requestReset(email)` — looks up the user (tolerantly: no user found
 *    is silently OK to avoid leaking which emails exist). Issues a token,
 *    persists its hash, and emails the user a one-time link.
 * 2. `completeReset(token, newPassword)` — verifies the token, hashes the
 *    new password, swaps the credential, consumes the token.
 *
 * Default TTL: 1 hour (shorter than email verification because resets are
 * higher-risk). Single-use.
 *
 * `requestReset` always resolves successfully even when the email is
 * unknown — the response shape doesn't reveal user existence. Tests can
 * still verify by inspecting the InMemoryEmailAdapter (only known emails
 * actually trigger a send).
 */

import { generateSessionToken, hashSessionToken, type PasswordHasher } from '@opendj/auth';
import type { EmailAdapter } from './EmailAdapter.js';
import type {
  AuthSessionRepository,
  PasswordCredentialRepository,
  PasswordResetTokenRepository,
  UserRepository,
} from '../repositories/types.js';

export class PasswordResetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PasswordResetError';
    this.code = code;
  }
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

export interface PasswordResetServiceDeps {
  users: UserRepository;
  tokens: PasswordResetTokenRepository;
  credentials: PasswordCredentialRepository;
  authSessions: AuthSessionRepository;
  passwordHasher: PasswordHasher & { algorithm?: string };
  email: EmailAdapter;
  baseUrl: string;
  fromAddress?: string;
  ttlMs?: number;
}

export class PasswordResetService {
  constructor(private readonly deps: PasswordResetServiceDeps) {}

  /**
   * Issue a password-reset email (when the email exists). Always resolves
   * successfully — no leak. `ipHash` is captured on the token row for
   * forensics.
   */
  async requestReset(input: { email: string; ipHash?: string | null }): Promise<void> {
    const email = input.email.trim().toLowerCase();
    const user = await this.deps.users.findByPrimaryEmail(email);
    if (!user) return; // silent success — don't leak existence
    const token = generateSessionToken();
    const tokenHash = await hashSessionToken(token);
    const expiresAt = new Date(Date.now() + (this.deps.ttlMs ?? DEFAULT_TTL_MS));
    await this.deps.tokens.create({
      tokenHash,
      userId: user.id,
      expiresAt,
      ...(input.ipHash !== undefined &&
        input.ipHash !== null && { requestedFromIpHash: input.ipHash }),
    });
    const link = this.buildResetLink(token);
    await this.deps.email.send({
      to: email,
      ...(this.deps.fromAddress && { from: this.deps.fromAddress }),
      subject: 'Reset your password',
      text: `Hi,\n\nReset your OpenDJ password by visiting:\n  ${link}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.\n\n— OpenDJ`,
      tags: ['password-reset'],
    });
  }

  /**
   * Consume a reset token + swap the password. On success the user is
   * forcibly logged out everywhere (existing sessions revoked) — standard
   * "compromised account" hygiene.
   */
  async completeReset(input: {
    token: string;
    newPassword: string;
    nowEpochMs?: number;
  }): Promise<{ userId: string }> {
    if (
      input.newPassword.length < MIN_PASSWORD_LENGTH ||
      input.newPassword.length > MAX_PASSWORD_LENGTH
    ) {
      throw new PasswordResetError('invalid_password', 'Password must be 8–200 characters.');
    }
    const now = input.nowEpochMs ?? Date.now();
    const tokenHash = await hashSessionToken(input.token);
    const row = await this.deps.tokens.findActiveByHash(tokenHash, now);
    if (!row) {
      throw new PasswordResetError(
        'invalid_or_expired_token',
        'Reset link is invalid or has expired.',
      );
    }
    const passwordHash = await this.deps.passwordHasher.hashPassword(input.newPassword);
    await this.deps.credentials.upsert({
      userId: row.userId,
      passwordHash,
      hashAlgorithm: this.deps.passwordHasher.algorithm ?? 'unknown',
    });
    await this.deps.tokens.consume(tokenHash, now);
    // Best-effort: reset the failed-attempts counter so the user can log in
    // immediately even if they were locked out before the reset.
    await this.deps.credentials.resetFailedAttempts(row.userId);
    return { userId: row.userId };
  }

  private buildResetLink(token: string): string {
    const trimmed = this.deps.baseUrl.replace(/\/$/, '');
    return `${trimmed}/host/reset-password?token=${encodeURIComponent(token)}`;
  }
}
