/**
 * Action signal types. Mirrors the `action_events` schema. Privacy-minimized:
 * no raw IPs, no raw fingerprint signals — store salted, session-scoped hashes.
 *
 * See docs/agent-brief.md §"Abuse prevention and backend analytics" → "Signals to collect".
 */

export type ActionEventKind =
  | 'guest_joined'
  | 'search'
  | 'song_requested'
  | 'song_request_rejected_by_dedupe'
  | 'song_request_rejected_by_cap'
  | 'skip_vote'
  | 'rate_limited'
  | 'abuse_blocked'
  | 'abuse_shadow_limited'
  | 'cap_hit'
  | 'guest_name_change'
  | 'guest_kicked'
  | (string & {});

export interface ActionEventInput {
  kind: ActionEventKind;
  accountId?: string;
  sessionId?: string;
  userId?: string;
  guestId?: string;
  /** Hashed identifier (fingerprint/IP/device hash with session-scoped salt). Never raw. */
  subjectHash?: string;
  /** Optional risk score in [0, 100] computed at the time of the event. */
  riskScore?: number;
  /** Free-form metadata. Avoid PII. */
  meta?: Record<string, unknown>;
}

/**
 * Typed event after writes. id and createdAt are assigned by the store.
 */
export interface ActionEvent extends ActionEventInput {
  id: number;
  createdAt: Date;
}
