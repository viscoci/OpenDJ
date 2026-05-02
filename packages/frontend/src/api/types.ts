/**
 * Wire types for `/api/v1/*`.
 *
 * Mirrors the response envelopes built by `@opendj/backend` routes. Domain
 * types come from `@opendj/core` directly, but timestamps land as ISO strings
 * (Hono's JSON serializer) — the wire types redeclare those fields as
 * `string` so callers parse them when needed.
 */

import type { Plan, QueueItemStatus, VoteSkipMode } from '@opendj/core';

export interface SessionWire {
  id: string;
  accountId: string;
  name: string;
  qrSlug: string;
  guestCapOverride: number | null;
  songsPerGuestCap: number;
  moderationEnabled: boolean;
  voteSkipMode: VoteSkipMode;
  voteSkipThreshold: number;
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
  /** Stable per-device fingerprint; the backend salts + hashes before persist. */
  fingerprint: string;
  /** Optional friendly name shown on the host dashboard. */
  name?: string | null;
}

export interface GuestIdentityResponse {
  guestId: string;
  /** Opaque token used in subsequent guest-authenticated requests. */
  slotToken: string;
  /** True when the guest is queued behind the active-guest cap. */
  queued: boolean;
  /** Position in the wait queue (1-based). Null when active. */
  queuePosition: number | null;
}

export interface CreateSessionRequest {
  name: string;
  qrSlug?: string;
  guestCapOverride?: number | null;
  songsPerGuestCap?: number;
  moderationEnabled?: boolean;
  voteSkipMode?: VoteSkipMode;
  voteSkipThreshold?: number;
}

export interface RequestTrackBody {
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl?: string | null;
  durationMs?: number | null;
}

export interface ModerateQueueItemBody {
  decision: 'approved' | 'rejected';
}

export interface LyricsLineWire {
  startMs: number;
  text: string;
  endMs?: number;
}

export interface LyricsResponse {
  trackUri: string;
  source: string;
  isSynced: boolean;
  isInstrumental: boolean;
  matchConfidence: 'low' | 'medium' | 'high';
  attribution: string | null;
  lines: ReadonlyArray<LyricsLineWire>;
  /** Plain-lyrics fallback when no synced LRC is available. */
  plain: string | null;
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
