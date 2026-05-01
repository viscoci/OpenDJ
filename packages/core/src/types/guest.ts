/**
 * Guest in a live session.
 *
 * Schema mirror: see docs/agent-brief.md §"Database schema" → `guests`.
 */

export interface Guest {
  id: string;
  sessionId: string;
  /** Linked when the guest is also a logged-in user; null for anonymous guests. */
  userId: string | null;
  /** Salted, session-scoped fingerprint hash. Never the raw client signal. */
  fingerprint: string;
  name: string | null;
  createdAt: Date;
}
