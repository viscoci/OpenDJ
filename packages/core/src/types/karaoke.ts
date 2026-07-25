/**
 * Karaoke mic-claim domain type.
 *
 * A claim binds a guest to a queued song as one of its singers. Each song
 * carries up to `session.karaokeMicCount` claims; `(queueItemId, guestId)`
 * is unique — one mic per guest per song.
 *
 * Schema mirror: see `karaoke_claims` in @opendj/db.
 */
export interface KaraokeClaim {
  id: string;
  sessionId: string;
  queueItemId: string;
  guestId: string;
  /** Sanitized singer name shown on TV/host/guest views. 1–40 chars. */
  displayName: string;
  createdAt: Date;
}
