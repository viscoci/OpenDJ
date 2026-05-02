/**
 * AbuseModerationService — host-facing block / unblock + summary.
 *
 * The full risk-scoring + rate-limiting impl (per `@opendj/abuse`'s service
 * interfaces) lives in a future slice — this commit covers the moderator
 * surface so hosts can intervene from the dashboard.
 *
 * Block/unblock identifies subjects by their already-salted `subjectHash`
 * (see GuestIdentityService) — never raw fingerprints/IPs.
 */

import type {
  AbuseSubjectRecord,
  AbuseSubjectStatus,
  ActionEventRepository,
  AbuseSubjectRepository,
} from '../repositories/types.js';

export class AbuseModerationServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AbuseModerationServiceError';
    this.code = code;
  }
}

export interface AbuseModerationServiceDeps {
  abuseSubjects: AbuseSubjectRepository;
  actionEvents: ActionEventRepository;
}

export interface BlockGuestInput {
  sessionId: string;
  accountId: string;
  subjectHash: string;
  reason?: string;
  /** Optional auto-expiry (e.g. cool-off after 1 hour). null = sticky. */
  expiresAt?: Date | null;
  /** User id of the host issuing the block — recorded on the action_event row. */
  byUserId: string;
}

export interface AbuseSummary {
  sessionId: string;
  /** Active enforcement rows (excludes expired). */
  subjects: AbuseSubjectRecord[];
  /** Counts by event_kind in the lookback window. */
  recentEventCounts: Array<{ eventKind: string; count: number }>;
  windowMs: number;
}

const DEFAULT_SUMMARY_WINDOW_MS = 30 * 60 * 1000;

export class AbuseModerationService {
  constructor(private readonly deps: AbuseModerationServiceDeps) {}

  async blockGuest(input: BlockGuestInput, nowEpochMs?: number): Promise<AbuseSubjectRecord> {
    const subject = await this.deps.abuseSubjects.upsert({
      subjectHash: input.subjectHash,
      accountId: input.accountId,
      sessionId: input.sessionId,
      status: 'blocked',
      reason: input.reason ?? 'host_blocked',
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
    });
    await this.deps.actionEvents.create({
      accountId: input.accountId,
      sessionId: input.sessionId,
      userId: input.byUserId,
      eventKind: 'abuse_blocked',
      subjectHash: input.subjectHash,
      meta: input.reason ? { reason: input.reason, source: 'host' } : { source: 'host' },
    });
    void nowEpochMs;
    return subject;
  }

  async unblockGuest(input: {
    sessionId: string;
    accountId: string;
    subjectHash: string;
    byUserId: string;
  }): Promise<void> {
    const existing = await this.deps.abuseSubjects.findByHash(input.subjectHash);
    if (existing && existing.sessionId !== input.sessionId) {
      throw new AbuseModerationServiceError(
        'session_mismatch',
        'Subject belongs to a different session.',
      );
    }
    await this.deps.abuseSubjects.delete(input.subjectHash);
    await this.deps.actionEvents.create({
      accountId: input.accountId,
      sessionId: input.sessionId,
      userId: input.byUserId,
      eventKind: 'abuse_unblocked',
      subjectHash: input.subjectHash,
      meta: { source: 'host' },
    });
  }

  async summary(input: {
    sessionId: string;
    statuses?: ReadonlyArray<AbuseSubjectStatus>;
    windowMs?: number;
    nowEpochMs?: number;
  }): Promise<AbuseSummary> {
    const windowMs = input.windowMs ?? DEFAULT_SUMMARY_WINDOW_MS;
    const now = input.nowEpochMs ?? Date.now();
    const since = new Date(now - windowMs);
    const subjects = await this.deps.abuseSubjects.findActiveForSession(
      input.sessionId,
      input.statuses,
    );
    const recentEventCounts = await this.deps.actionEvents.countByKindSince(input.sessionId, since);
    return { sessionId: input.sessionId, subjects, recentEventCounts, windowMs };
  }
}
