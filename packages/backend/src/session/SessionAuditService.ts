/**
 * SessionAuditService — thin wrapper around the audit-event repo with
 * a stable action vocabulary so call sites don't sprinkle string
 * literals everywhere. Every interesting host- or guest-driven mutation
 * against a session funnels through here.
 *
 * Failures intentionally do NOT propagate: an audit-write hiccup must
 * never block the user-facing action. Callers `void recordX()` or
 * await without try/catch and we swallow internally.
 */

import type {
  SessionAuditEventRecord,
  SessionAuditEventRepository,
} from '../repositories/types.js';

/**
 * Stable action identifiers persisted in the DB. Keep snake_case-ish to
 * mirror the existing realtime event vocabulary. Adding new values is
 * safe (host UI just falls back to the raw string); removing or
 * renaming requires a migration so historical rows still render.
 */
export type SessionAuditAction =
  // Queue lifecycle (guest + host moderation)
  | 'queue.requested'
  | 'queue.approved'
  | 'queue.rejected'
  | 'queue.removed'
  | 'queue.host_provider_rejected'
  // Skip-vote actions
  | 'skip_vote.cast'
  | 'skip_vote.now_playing_cast'
  | 'skip_vote.provider_track_cast'
  | 'skip_vote.threshold_reached'
  // Playback control (host)
  | 'playback.skip'
  | 'playback.pause'
  | 'playback.resume'
  | 'playback.device_activated'
  // Session lifecycle + settings
  | 'session.created'
  | 'session.ended'
  | 'session.settings_updated'
  // System / auto actions
  | 'system.auto_skip_rejected'
  | 'system.item_marked_played';

export interface RecordAuditInput {
  sessionId: string;
  actorKind: 'host' | 'guest' | 'system';
  actorId?: string | null;
  actorLabel?: string | null;
  action: SessionAuditAction;
  details?: Record<string, unknown>;
}

export interface SessionAuditServiceDeps {
  repository: SessionAuditEventRepository;
  logger?: { warn(msg: string, meta?: unknown): void };
}

export class SessionAuditService {
  private readonly logger: { warn(msg: string, meta?: unknown): void };
  constructor(private readonly deps: SessionAuditServiceDeps) {
    this.logger = deps.logger ?? console;
  }

  /**
   * Record an audit row. Best-effort — a failure logs but never throws,
   * so a busted audit table can't break the user-facing action.
   */
  async record(input: RecordAuditInput): Promise<void> {
    try {
      await this.deps.repository.record(input);
    } catch (err) {
      this.logger.warn('[SessionAuditService] record failed', {
        sessionId: input.sessionId,
        action: input.action,
        error: (err as Error).message,
      });
    }
  }

  async list(
    sessionId: string,
    options?: { limit?: number; before?: Date },
  ): Promise<SessionAuditEventRecord[]> {
    return this.deps.repository.listForSession(sessionId, options);
  }
}

/**
 * Build a short, stable label for a guest actor. Uses the first 6 chars
 * of the guest fingerprint hash so the host UI can distinguish guests
 * without storing or showing PII. Falls back to a slice of the guest id
 * when the fingerprint isn't available.
 */
export function guestLabelFromFingerprint(fingerprintHash: string | null | undefined): string {
  if (fingerprintHash && fingerprintHash.length >= 6) {
    return `Guest ${fingerprintHash.slice(0, 6)}`;
  }
  return 'Guest';
}
