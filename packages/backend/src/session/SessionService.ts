/**
 * SessionService — host-side session lifecycle.
 *
 * Routes layer on `requireClaim('session:create' | 'session:update' | 'session:end')`
 * — the service trusts that the caller has already been gated. It still
 * validates account membership at the data level (a host can only mutate
 * sessions belonging to their `currentAccountId`).
 *
 * QR-slug generation is intentionally simple — random URL-safe ID. Full
 * vanity-slug support (custom `/u/<slug>`) is left to downstream consumers
 * to build on top.
 */

import { generateSessionToken } from '@opendj/auth';
import { DEFAULT_SONGS_PER_GUEST_CAP } from '@opendj/core';
import type { SessionRecord, SessionRepository } from '../repositories/types.js';

export class SessionServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionServiceError';
    this.code = code;
  }
}

export interface SessionServiceDeps {
  sessions: SessionRepository;
  /**
   * Optional QR-slug generator. Defaults to a 12-char URL-safe random ID
   * derived from `generateSessionToken` (which produces 64 hex chars).
   */
  generateQrSlug?: () => string;
}

export interface CreateSessionInput {
  accountId: string;
  name: string;
  qrSlug?: string;
  guestCapOverride?: number | null;
  songsPerGuestCap?: number;
  maxConsecutivePerGuest?: number | null;
  allowDuplicates?: boolean;
  moderationEnabled?: boolean;
  voteSkipMode?: 'fixed' | 'percentage' | 'host_approval';
  voteSkipThreshold?: number;
  karaokeMode?: 'off' | 'optional' | 'required';
  karaokeMicCount?: number;
  karaokePauseMode?: 'off' | 'manual' | 'auto';
  karaokePauseTimeoutSec?: number;
}

export interface UpdateSessionInput {
  id: string;
  /** AccountId of the caller — guards against cross-account mutation. */
  accountId: string;
  name?: string;
  guestCapOverride?: number | null;
  songsPerGuestCap?: number;
  maxConsecutivePerGuest?: number | null;
  allowDuplicates?: boolean;
  moderationEnabled?: boolean;
  voteSkipMode?: 'fixed' | 'percentage' | 'host_approval';
  voteSkipThreshold?: number;
  karaokeMode?: 'off' | 'optional' | 'required';
  karaokeMicCount?: number;
  karaokePauseMode?: 'off' | 'manual' | 'auto';
  karaokePauseTimeoutSec?: number;
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const qrSlug = input.qrSlug ?? this.defaultQrSlug();
    // Only an ACTIVE session blocks the slug — ended sessions release
    // theirs so the same QR code can host next week's party.
    const existing = await this.deps.sessions.findByQrSlug(qrSlug);
    if (existing && existing.endedAt === null)
      throw new SessionServiceError('qr_slug_taken', `QR slug "${qrSlug}" is already in use.`);
    return this.deps.sessions.create({
      accountId: input.accountId,
      name: input.name,
      qrSlug,
      guestCapOverride: input.guestCapOverride ?? null,
      songsPerGuestCap: input.songsPerGuestCap ?? DEFAULT_SONGS_PER_GUEST_CAP,
      maxConsecutivePerGuest: input.maxConsecutivePerGuest ?? null,
      allowDuplicates: input.allowDuplicates ?? false,
      moderationEnabled: input.moderationEnabled ?? false,
      voteSkipMode: input.voteSkipMode ?? 'fixed',
      voteSkipThreshold: input.voteSkipThreshold ?? 5,
      karaokeMode: input.karaokeMode ?? 'off',
      karaokeMicCount: input.karaokeMicCount ?? 1,
      karaokePauseMode: input.karaokePauseMode ?? 'manual',
      karaokePauseTimeoutSec: input.karaokePauseTimeoutSec ?? 30,
    });
  }

  async getById(id: string, requireAccountId?: string): Promise<SessionRecord> {
    const session = await this.deps.sessions.findById(id);
    if (!session) throw new SessionServiceError('session_not_found', 'Unknown session.');
    if (requireAccountId !== undefined && session.accountId !== requireAccountId) {
      throw new SessionServiceError('account_mismatch', 'Session belongs to a different account.');
    }
    return session;
  }

  /** Resolve by `qrSlug`. Public — used by the guest landing page. */
  async getBySlug(qrSlug: string): Promise<SessionRecord> {
    const session = await this.deps.sessions.findByQrSlug(qrSlug);
    if (!session) throw new SessionServiceError('session_not_found', 'Unknown session.');
    return session;
  }

  async update(input: UpdateSessionInput): Promise<SessionRecord> {
    const existing = await this.getById(input.id, input.accountId);
    if (existing.endedAt !== null) {
      throw new SessionServiceError('session_ended', 'Cannot update an ended session.');
    }
    const { accountId: _ignoreAccount, id, ...rest } = input;
    void _ignoreAccount;
    const updated = await this.deps.sessions.update({ id, ...rest });
    if (!updated)
      throw new SessionServiceError('session_not_found', 'Session disappeared mid-update.');
    return updated;
  }

  async end(id: string, accountId: string, nowEpochMs?: number): Promise<SessionRecord> {
    await this.getById(id, accountId);
    const ended = await this.deps.sessions.end(id, new Date(nowEpochMs ?? Date.now()));
    if (!ended) throw new SessionServiceError('session_not_found', 'Session disappeared.');
    return ended;
  }

  /**
   * Reopen an ended session — clears `endedAt` so guests can rejoin via the
   * original slug/QR. Idempotent on an already-active session. Fails with
   * `qr_slug_taken` when a DIFFERENT active session now holds the slug
   * (the host recreated it under the same QR after ending this one).
   */
  async reopen(id: string, accountId: string): Promise<SessionRecord> {
    const session = await this.getById(id, accountId);
    if (session.endedAt === null) return session;
    const slugHolder = await this.deps.sessions.findByQrSlug(session.qrSlug);
    if (slugHolder && slugHolder.endedAt === null && slugHolder.id !== id) {
      throw new SessionServiceError(
        'qr_slug_taken',
        `QR slug "${session.qrSlug}" is now used by an active session.`,
      );
    }
    const reopened = await this.deps.sessions.reopen(id);
    if (!reopened) throw new SessionServiceError('session_not_found', 'Session disappeared.');
    return reopened;
  }

  async listForAccount(accountId: string): Promise<SessionRecord[]> {
    return this.deps.sessions.findByAccount(accountId);
  }

  private defaultQrSlug(): string {
    if (this.deps.generateQrSlug) return this.deps.generateQrSlug();
    // 12 hex chars = 48 bits of entropy — plenty for a session slug.
    return generateSessionToken().slice(0, 12);
  }
}
