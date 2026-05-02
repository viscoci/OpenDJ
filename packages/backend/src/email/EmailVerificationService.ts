/**
 * EmailVerificationService — request + verify email-ownership tokens.
 *
 * Token shape: 32 random bytes → hex (`generateSessionToken`). The opaque
 * token is sent to the user's email; only its SHA-256 hash is persisted so a
 * DB read can't be replayed.
 *
 * Default TTL: 24h. Single-use.
 *
 * On verify, sets `users.email_verified=true`. The matching `auth_identities`
 * row stays as-is intentionally — `email_verified` on the identity row is a
 * snapshot of what the OAuth provider asserted, not a user-managed property.
 */

import { generateSessionToken, hashSessionToken } from '@opendj/auth';
import type { EmailAdapter } from './EmailAdapter.js';
import type { EmailVerificationTokenRepository, UserRepository } from '../repositories/types.js';

export class EmailVerificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EmailVerificationError';
    this.code = code;
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface EmailVerificationServiceDeps {
  users: UserRepository;
  tokens: EmailVerificationTokenRepository;
  email: EmailAdapter;
  /** Public origin for the verify link (e.g. `https://app.opendj.live`). */
  baseUrl: string;
  /** Defaults to "OpenDJ <noreply@opendj.live>". */
  fromAddress?: string;
  /** Override TTL — useful for tests. */
  ttlMs?: number;
}

export interface VerifyResult {
  userId: string;
  email: string;
}

export class EmailVerificationService {
  constructor(private readonly deps: EmailVerificationServiceDeps) {}

  /**
   * Generate a fresh verification token for `userId` + `email` and email it.
   *
   * Doesn't deduplicate against existing live tokens — repeated requests
   * issue new tokens (old ones remain valid until expiry / consumption).
   * That's intentional: the user might lose the previous email and need a
   * fresh one delivered.
   */
  async requestVerification(input: { userId: string; email: string }): Promise<void> {
    const user = await this.deps.users.findById(input.userId);
    if (!user) {
      throw new EmailVerificationError('user_not_found', 'Unknown user.');
    }
    const token = generateSessionToken();
    const tokenHash = await hashSessionToken(token);
    const expiresAt = new Date(Date.now() + (this.deps.ttlMs ?? DEFAULT_TTL_MS));
    await this.deps.tokens.create({
      tokenHash,
      userId: input.userId,
      email: input.email.trim().toLowerCase(),
      expiresAt,
    });
    const link = this.buildVerifyLink(token);
    await this.deps.email.send({
      to: input.email,
      ...(this.deps.fromAddress && { from: this.deps.fromAddress }),
      subject: 'Verify your email',
      text: `Hi,\n\nVerify your email by visiting:\n  ${link}\n\nThis link expires in 24 hours.\n\n— OpenDJ`,
      tags: ['email-verification'],
    });
  }

  /**
   * Consume a token. Returns `{ userId, email }` on success; throws
   * `invalid_or_expired_token` otherwise.
   *
   * Side effect: marks `users.email_verified=true`.
   */
  async verifyToken(token: string, nowEpochMs?: number): Promise<VerifyResult> {
    const now = nowEpochMs ?? Date.now();
    const tokenHash = await hashSessionToken(token);
    const row = await this.deps.tokens.findActiveByHash(tokenHash, now);
    if (!row) {
      throw new EmailVerificationError(
        'invalid_or_expired_token',
        'Verification link is invalid or has expired.',
      );
    }
    await this.deps.tokens.consume(tokenHash, now);
    await this.deps.users.setEmailVerified(row.userId);
    return { userId: row.userId, email: row.email };
  }

  private buildVerifyLink(token: string): string {
    const trimmed = this.deps.baseUrl.replace(/\/$/, '');
    return `${trimmed}/api/v1/auth/email/verify?token=${encodeURIComponent(token)}`;
  }
}
