# Karaoke Mic Queue — Foundation Implementation Plan (Plan D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything in spec `docs/superpowers/specs/2026-07-24-karaoke-mic-queue-design.md` §2–§5 landed in the foundation packages on branch `feat/karaoke-mic-queue`, green, changeset for **0.4.0**.

**Architecture:** Three verticals: (D1) session settings via the exact `maxConsecutivePerGuest` mirror pattern; (D2) mic claims — table, core rules, service+routes, wire, realtime events; (D3) spotlight/pause/resume — poller integration + guest endpoints + snapshot state. Each task TDD, one commit(+), reviewed before the next.

**Tech Stack:** existing monorepo stack (drizzle, hono, valibot, vitest).

## Global Constraints

- Branch `feat/karaoke-mic-queue` (from origin/main @ 8e1d003, includes 0.3.0). Conventional Commits with `-s` (DCO). Prettier pre-commit.
- The spec (path above) is BINDING for names, types, defaults, ranges, error codes, event shapes.
- `@opendj/frontend-template` untouched. No UI anywhere.
- Verify per task: `pnpm turbo run lint typecheck test --filter=@opendj/core --filter=@opendj/db --filter=@opendj/backend --filter=@opendj/realtime --filter=@opendj/frontend` green.
- The `maxConsecutivePerGuest` change (commit c4ba271, in main) is the canonical map of every session-settings touchpoint — mirror it.

---

### Task D1: Session settings (4 fields)

Mirror `maxConsecutivePerGuest` (grep it in every package) for, per spec §2 exactly:
`karaokeMode` ('off'|'optional'|'required', default 'off'), `karaokeMicCount` (int 1–8, default 1), `karaokePauseMode` ('off'|'manual'|'auto', default 'manual'), `karaokePauseTimeoutSec` (int 5–180, default 30).

- [ ] core `Session` type + tests where the mirror has them
- [ ] db: sessions columns (`karaoke_mode` text w/ default, `karaoke_mic_count` int default 1, `karaoke_pause_mode` text default 'manual', `karaoke_pause_timeout_sec` int default 30) + drizzle-kit-pattern migration
- [ ] backend: SessionRecord, repos (drizzle + memory), SessionService create/update inputs+defaults, routes CreateBody/UpdateBody valibot (picklist for enums, bounded ints), wire serialization everywhere the mirror appears (GuestIdentityService snapshot, QueueService sessionToDomain, session routes)
- [ ] frontend: `SessionWire` + `CreateSessionRequest`
- [ ] Extend session route test w/ the new fields round-trip. Commit `feat: karaoke session settings`

### Task D2: Mic claims vertical

Spec §3 + §5 (claims part). Files by package:

- [ ] **db**: `karaoke_claims` table per spec (unique `(queue_item_id, guest_id)`, FKs cascade on delete) + migration
- [ ] **core**: `KaraokeClaim` type; pure `canClaimMic(session, item, existingClaims, guestId)` in `packages/core/src/queue/` returning `{ok:true} | {ok:false, reason}` with reasons `karaoke_off | item_not_claimable | mics_full | already_claimed`; `canRemoveClaim(item, claim, guestId)` (own claim, item still waiting). TDD: full reason matrix tests first.
- [ ] **realtime**: event types `karaoke.claim_added {itemId, claim:{guestId,displayName}}`, `karaoke.claim_removed {itemId, guestId}`; `QueueItemSummary.karaokeClaims` array (default empty); reducer folds both events into snapshot queue items. Reducer tests.
- [ ] **backend**: `KaraokeService` (deps style of QueueService): `claim({sessionId, slotToken, queueItemId, displayName})` (sanitize name: trim, strip control chars, 1–40 else `invalid_display_name`; resolve slot→guest like requestTrack; run canClaimMic; insert; broadcast claim_added), `removeClaim` (guest own via slotToken; host via auth override flag), claims included wherever QueueItemSummary is built (grep `toQueueItemSummary`). Repository for karaoke_claims (drizzle + memory). Routes: `POST /api/v1/sessions/:id/karaoke/claims` + `DELETE .../claims/:itemId` (slot token in body/header exactly like queue request routes do it). `requestTrack` gains optional `karaoke: {displayName}` — claim created atomically after item insert (same transaction boundary as feasible; sequential acceptable), `required` mode without it → `karaoke_claim_required` (reject BEFORE insert). Route schema + error mapping.
- [ ] **frontend**: api types (`QueueItemSummary` comes from realtime — just re-export path check) + `KaraokeApi` sub-client (claim/removeClaim) + queue request input extension.
- [ ] Tests at every layer (service happy/reject paths, route auth, reducer). Commit `feat: karaoke mic claims`

### Task D3: Spotlight + pause/resume

Spec §4 + §5 (spotlight/pause part). Depends on D2.

- [ ] **realtime**: snapshot `karaoke: {spotlightItemId: string|null, paused: boolean, pausedUntilEpochMs: number|null}` (default null/false/null); events `karaoke.spotlight {itemId|null, claims}`, `karaoke.paused {itemId, untilEpochMs}`, `karaoke.resumed {itemId}`; reducer folds. Tests.
- [ ] **backend**: spotlight detection in the now-playing poller path (where lyrics lookup hooks track changes): on trackChanged, find earliest waiting (`pending|approved|queued`) OR `playing` queue item with matching trackUri AND ≥1 claim → set room spotlight (server-side per-session state next to the poller's lyric bookkeeping), broadcast `karaoke.spotlight`; none → spotlight null broadcast (only on change). `auto` pause mode: on spotlight set, call provider pause (existing playback control service the host devices routes use) + broadcast `karaoke.paused` with `until = now + karaokePauseTimeoutSec*1000`. Poller tick: if paused && now > until → provider resume + `karaoke.resumed`.
- [ ] **backend routes** (slot-token, claimer-only — guest must hold a claim on the spotlight item, else `not_a_claimer`): `POST .../karaoke/pause` (manual mode only, else `pause_disabled`; sets deadline, pauses provider, broadcasts), `POST .../karaoke/ready` (any claimer; resumes provider, broadcasts resumed). Host resume: existing playback resume endpoint already works — additionally clear karaoke-paused state when provider reports playing again (poller reconcile: isPlaying=true → paused=false + broadcast resumed if was paused).
- [ ] **frontend**: KaraokeApi pause/ready.
- [ ] Tests: poller spotlight unit (fake deps, track change → spotlight event; auto mode → pause called + event), deadline auto-resume, route guards. Commit `feat: karaoke spotlight and pause flow`

### Task D4: Changeset + final verify

- [ ] `.changeset/karaoke-mic-queue.md`: core minor, db minor, backend minor, realtime minor, frontend minor — summary per spec §1.
- [ ] Full `pnpm turbo run lint typecheck test build` across the five packages green. Push branch.
