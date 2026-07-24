/**
 * Live event / session domain types.
 *
 * One session = one event. Hosts create sessions; guests join via QR slug.
 *
 * Schema mirror: see docs/agent-brief.md §"Database schema" → `sessions`.
 */

export type VoteSkipMode = 'fixed' | 'percentage' | 'host_approval';

/**
 * `optional`: requester may claim a mic while queuing; `required`: a song
 * request MUST include a mic claim (reject `karaoke_claim_required`).
 */
export type KaraokeMode = 'off' | 'optional' | 'required';

/**
 * `manual`: claimers get a Pause button when their song is playing;
 * `auto`: a claimed song auto-pauses the moment it starts; `off`: no guest
 * pause.
 */
export type KaraokePauseMode = 'off' | 'manual' | 'auto';

export interface Session {
  id: string;
  accountId: string;
  name: string;
  /** Path component used in /u/<slug> guest URLs. Unique. */
  qrSlug: string;
  /** Per-session override for the account's effective guest cap. `null` means "use plan default". */
  guestCapOverride: number | null;
  songsPerGuestCap: number;
  /**
   * Limits how many songs a single guest may have back-to-back at the tail
   * of the waiting queue (pending/approved/queued, ordered by request time).
   * `null` means unlimited (off). When set, must be >= 1.
   */
  maxConsecutivePerGuest: number | null;
  /**
   * When false (default), guests can't request a track that's already in
   * the active queue or currently playing. When true, the same song can
   * appear multiple times — useful for sing-along nights / requested
   * favorites. Enforced server-side; UI annotates queued tracks.
   */
  allowDuplicates: boolean;
  moderationEnabled: boolean;
  voteSkipMode: VoteSkipMode;
  /**
   * For voteSkipMode === 'fixed', the absolute vote count required.
   * For voteSkipMode === 'percentage', the percentage [0..100] of active guests required.
   * Ignored for voteSkipMode === 'host_approval'.
   */
  voteSkipThreshold: number;
  /** `off`: mic claims disabled. See `KaraokeMode` for `optional`/`required`. */
  karaokeMode: KaraokeMode;
  /** Mics available per song; each song can carry up to this many claims. 1-8. */
  karaokeMicCount: number;
  /** See `KaraokePauseMode`. */
  karaokePauseMode: KaraokePauseMode;
  /** Auto-resume deadline (seconds) for any karaoke pause. 5-180. */
  karaokePauseTimeoutSec: number;
  startedAt: Date;
  endedAt: Date | null;
}
