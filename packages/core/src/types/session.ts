/**
 * Live event / session domain types.
 *
 * One session = one event. Hosts create sessions; guests join via QR slug.
 *
 * Schema mirror: see docs/agent-brief.md §"Database schema" → `sessions`.
 */

export type VoteSkipMode = 'fixed' | 'percentage' | 'host_approval';

export interface Session {
  id: string;
  accountId: string;
  name: string;
  /** Path component used in /u/<slug> guest URLs. Unique. */
  qrSlug: string;
  /** Per-session override for the account's effective guest cap. `null` means "use plan default". */
  guestCapOverride: number | null;
  songsPerGuestCap: number;
  moderationEnabled: boolean;
  voteSkipMode: VoteSkipMode;
  /**
   * For voteSkipMode === 'fixed', the absolute vote count required.
   * For voteSkipMode === 'percentage', the percentage [0..100] of active guests required.
   * Ignored for voteSkipMode === 'host_approval'.
   */
  voteSkipThreshold: number;
  startedAt: Date;
  endedAt: Date | null;
}
