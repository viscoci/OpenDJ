# Karaoke Mic Queue — Design

**Date:** 2026-07-24 (late night)
**Status:** Draft — pending Ethan's approval
**Split:** ALL domain/state/enforcement/realtime in the OSS foundation (ships as `@opendj/*@0.4.0`). ALL product UI in the private `OpenDJ-live` repo only — `@opendj/frontend-template` is untouched.

## 1. Concept

Guests can claim a **mic** on a queued song. When that song plays, the room knows who's singing: the TV shows their name, their phone tells them to grab a mic, and (optionally) playback holds until they're ready.

## 2. Session settings (host-controlled)

| Setting                  | Type                                | Default  | Meaning                                                                                                                                           |
| ------------------------ | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `karaokeMode`            | `'off' \| 'optional' \| 'required'` | `off`    | `optional`: requester may claim a mic while queuing; `required`: a song request MUST include a mic claim (reject `karaoke_claim_required`).       |
| `karaokeMicCount`        | int 1–8                             | 1        | Mics available per song. Each song can carry up to this many claims.                                                                              |
| `karaokePauseMode`       | `'off' \| 'manual' \| 'auto'`       | `manual` | `manual`: claimers get a Pause button when their song is playing; `auto`: a claimed song auto-pauses the moment it starts; `off`: no guest pause. |
| `karaokePauseTimeoutSec` | int 5–180                           | 30       | Auto-resume deadline for any karaoke pause.                                                                                                       |

All four ride the existing session-settings pipeline (create/PATCH, valibot bounds, wire echo) exactly like `maxConsecutivePerGuest` did.

## 3. Domain model (foundation)

- New table `karaoke_claims`: `id, sessionId, queueItemId (FK queue_items), guestId (FK guests), displayName (trimmed, 1–40 chars, control chars stripped), createdAt`. Unique `(queueItemId, guestId)` — one mic per guest per song.
- Rules (core, pure functions like `canEnqueue`):
  - `canClaimMic(session, item, existingClaims, guestId)` → rejects when `karaokeMode === 'off'`, item not waiting (`pending|approved|queued`) or playing, claims full (`>= karaokeMicCount`), or guest already holds one on this item.
  - Claims are open to ANY guest in the session (duets), not just the requester.
  - Removing: a guest may remove their own claim while the item is still waiting; host can remove any claim.
- Request+claim atomically: `requestTrack` input gains optional `karaoke: { displayName: string }`. In `required` mode, absence → reject `karaoke_claim_required` (mapped like other canEnqueue failures).

## 4. Playback handoff (foundation)

- The now-playing poller already tracks track changes. New: when the playing track's URI matches a waiting queue item that has claims (earliest matching item wins), the room enters a **karaoke spotlight** for that item.
- `auto` pause mode: on spotlight start, backend pauses playback via the existing provider playback control and broadcasts a pause with deadline `now + karaokePauseTimeoutSec`.
- `manual` mode: any claimer of the spotlight item may POST pause (same deadline applies).
- Resume: any claimer taps Ready → resume + broadcast; OR the poller auto-resumes when `now > deadline`; OR the host resumes from existing playback controls.
- Guest endpoints (slot-token auth, same guard style as queue requests): claim create/remove, pause, ready. Rate-limited like requests.

## 5. Wire + realtime (foundation)

- `SessionWire` gains the four settings.
- `QueueItemSummary` gains `karaokeClaims: Array<{ guestId: string; displayName: string }>` (empty when none) and the session snapshot exposes `karaoke: { spotlightItemId: string | null; paused: boolean; pausedUntilEpochMs: number | null }`.
- New events: `karaoke.claim_added { itemId, claim }`, `karaoke.claim_removed { itemId, guestId }`, `karaoke.paused { itemId, untilEpochMs }`, `karaoke.resumed { itemId }`, `karaoke.spotlight { itemId | null, claims }`. Reducer (`applyEvent`) folds all of them into the snapshot.

## 6. Product UI (OpenDJ-live ONLY)

Glass styling throughout (blurred translucent cards, brand gradient accents), matching the TV design language.

- **Guest — request flow:** after picking a track, a glass overlay: `optional` → "Want the mic? 🎤" name input + "Just queue it" skip; `required` → same overlay, no skip. Name persisted per device (localStorage) so repeat claims prefill.
- **Guest — queue rows:** each waiting song shows mic state: claimed names (`🎤 Ana, Ben`) + "1 mic open — join in" button when open; tapping opens the same name overlay. Own claim shows "Leave mic".
- **Guest — you're up:** when the spotlight item includes THIS guest's claim: full-screen glass takeover "You're up, {name}! Grab a mic 🎤" with: Ready button (when paused), Pause button (manual mode + playing), countdown ring for the auto-resume deadline.
- **Host:** settings card gains the four controls; queue rows show claim chips; now-playing card shows current singers, pause state with countdown, and a Resume-now button.
- **TV (all three layouts, toggleable in TV settings — "Show singers", default on):** when the spotlight is active, a singer banner: `🎤 Ana & Ben` (overlay: under track meta; centered: badge in the rail under now-playing; split: under the art meta). Up-next rows show `🎤 2` open-mic count / claimed names condensed.

## 7. Sequencing

1. Foundation branch `feat/karaoke-mic-queue`: core rules + db migration + backend services/routes/poller + realtime events + frontend wire types, full TDD, changeset (core/db/backend/realtime/frontend minor) → PR → **0.4.0** (Ethan merges in the morning).
2. OpenDJ-live: bump pins, then UI work (guest overlay + queue chips + you're-up takeover, host controls, TV banner) — all safe to build against local types before 0.4.0 publishes, merged after.
3. Demo stack rebuild after both land.

## 8. Risks

| Risk                                    | Mitigation                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Spotify pause/resume race with poller   | Spotlight state lives server-side; poller reconciles isPlaying each tick; deadline auto-resume is idempotent |
| Guest spam-claims silly names           | length/char sanitization + rate limit + host can remove claims; profanity filtering out of scope tonight     |
| Track URI matches multiple queued items | earliest waiting item wins the spotlight; others keep their claims for their own plays                       |
| Server restart mid-pause                | deadline is wall-clock in the broadcast; poller re-derives and resumes anything past deadline                |
