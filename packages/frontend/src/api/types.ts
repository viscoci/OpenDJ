/**
 * Wire types for `/api/v1/*`.
 *
 * Mirrors the response envelopes built by `@opendj/backend` routes. Domain
 * types come from `@opendj/core` directly, but timestamps land as ISO strings
 * (Hono's JSON serializer) — the wire types redeclare those fields as
 * `string` so callers parse them when needed.
 */

import type {
  KaraokeMode,
  KaraokePauseMode,
  Plan,
  QueueItemStatus,
  VoteSkipMode,
} from '@opendj/core';

export interface SessionWire {
  id: string;
  accountId: string;
  name: string;
  qrSlug: string;
  guestCapOverride: number | null;
  songsPerGuestCap: number;
  /**
   * Limits how many songs a single guest may have back-to-back at the tail
   * of the waiting queue. `null` means unlimited (off).
   */
  maxConsecutivePerGuest: number | null;
  /** When false (default), duplicate trackUris are rejected on enqueue. */
  allowDuplicates?: boolean;
  moderationEnabled: boolean;
  voteSkipMode: VoteSkipMode;
  voteSkipThreshold: number;
  /** `off`: mic claims disabled. See `KaraokeMode` for `optional`/`required`. */
  karaokeMode: KaraokeMode;
  /** Mics available per song; each song can carry up to this many claims. 1-8. */
  karaokeMicCount: number;
  /** See `KaraokePauseMode`. */
  karaokePauseMode: KaraokePauseMode;
  /** Auto-resume deadline (seconds) for any karaoke pause. 5-180. */
  karaokePauseTimeoutSec: number;
  startedAt: string;
  endedAt: string | null;
}

export interface QueueItemSummaryWire {
  id: string;
  sessionId: string;
  guestId: string;
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs: number | null;
  status: QueueItemStatus;
  skipVotes: number;
  createdAt: string;
  decidedAt: string | null;
}

export interface UserWire {
  id: string;
  publicUserId: number;
  displayName: string | null;
  primaryEmail: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
}

export interface AccountWire {
  id: string;
  displayName: string;
  slug: string;
  plan: Plan;
}

export interface MeResponse {
  user: UserWire;
  currentAccount: AccountWire | null;
  accounts: ReadonlyArray<AccountWire>;
  /** Capability claims attached to the active account context. */
  claims: ReadonlyArray<string>;
}

export interface GuestIdentityRequest {
  /**
   * Already-hashed device fingerprint. The frontend computes a stable hash
   * (e.g. SHA-256 of a per-device random) and sends it; the backend re-hashes
   * with a session+date salt before persist.
   */
  fingerprintHash: string;
  /** The session's `qrSlug` from the QR code. */
  eventSlug: string;
}

export type GuestSlotStatusWire = 'active' | 'queued' | 'priority_queued';

export interface GuestIdentityResponse {
  guestId: string;
  sessionId: string;
  /** Opaque token used as `Authorization: Bearer <slotToken>` on follow-ups. */
  slotToken: string;
  status: GuestSlotStatusWire;
  /** 1-based position in the wait queue. Absent when status is `'active'`. */
  queuePosition?: number;
}

export interface CreateSessionRequest {
  name: string;
  qrSlug?: string;
  guestCapOverride?: number | null;
  songsPerGuestCap?: number;
  maxConsecutivePerGuest?: number | null;
  allowDuplicates?: boolean;
  moderationEnabled?: boolean;
  voteSkipMode?: VoteSkipMode;
  voteSkipThreshold?: number;
  karaokeMode?: KaraokeMode;
  karaokeMicCount?: number;
  karaokePauseMode?: KaraokePauseMode;
  karaokePauseTimeoutSec?: number;
}

/**
 * Body of POST /api/v1/sessions/:id/queue. Matches `@opendj/core` Track —
 * NOT QueueItemSummaryWire, which uses `trackName/artistName/...` style
 * field names. Search results are returned in the SearchResultWire shape;
 * callers translate to this body shape on submit.
 */
export interface RequestTrackBody {
  uri: string;
  name: string;
  artist: string;
  albumArt: string | null;
  durationMs: number;
}

export interface ModerateQueueItemBody {
  decision: 'approved' | 'rejected';
}

export interface LyricsFeedbackBody {
  /** `wrong_song` | `bad_timing` | `offensive` | `missing` — backend accepts any string. */
  kind: string;
  lineId?: string | null;
  comment?: string | null;
}

export interface SearchResultWire {
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs: number | null;
}

export interface SearchResponse {
  results: ReadonlyArray<SearchResultWire>;
  providerId: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  displayName?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface SessionEnvelope<T> {
  session: T;
}

export interface ItemEnvelope<T> {
  item: T;
}

export interface ItemsEnvelope<T> {
  items: ReadonlyArray<T>;
}
