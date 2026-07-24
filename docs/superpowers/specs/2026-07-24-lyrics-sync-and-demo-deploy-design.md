# Lyrics Sync + Demo Deploy (opendj-live lite) — Design

**Date:** 2026-07-24
**Status:** Approved by Ethan (section-by-section review)
**Deadline context:** live demo targeted 2026-07-25 at https://opendj.com.
**Supersedes (partially):** `2026-07-23-opendj-live-bootstrap-design.md` §6 — the design-canvas-faithful frontend is deferred; opendj-live ships first as a direct implementation of the demo app (vendored `frontend-template`). The rest of the bootstrap spec (published-package consumption, private repo, tunnel deploy, opendj.com) stands and is partially delivered here.

## 1. Goal

Two sub-projects, executed in order:

1. **Lyrics sync end-to-end (foundation repo):** guest phones and the TV view show karaoke-style synced lyrics for the currently playing track — active line highlighted in time, previous/next context, graceful fallback for unsynced/no lyrics — fed by the existing LRCLIB adapter and cache.
2. **opendj-live demo scaffold + deploy:** private repo `viscoci/opendj-live` running the demo app (published `@opendj/*` backend + vendored `frontend-template` UI) behind a cloudflared tunnel at opendj.com.

## 2. Current state (verified by exploration, 2026-07-24)

All primitives exist and are behaviorally tested; the gaps are integration-only:

- `@opendj/lyrics` WORKS: LRCLIB fetch adapter (`getBestMatch`/`search`, never throws), LRC parser, lookup-key normalization, `lyricsDocumentToSyncCues`, `getActiveLyricWindow`, feedback types.
- `@opendj/sync` WORKS but has zero runtime callers: `createPlaybackClockSample`, `predictPlaybackPosition` (confidence decay, clamping), cue helpers.
- Backend PARTIAL: lyrics lookup/feedback routes + Postgres `lyrics_cache` (positive & negative caching, ≥3-report suppression) work. `NowPlayingPoller` (2.5s Spotify poll, robust) never calls `LyricsLookupService` and never emits `lyrics.loaded` or `playback.clock_sampled`. `@opendj/sync` is an unused dependency.
- Realtime PARTIAL: `SessionSnapshot.lyrics`/`playbackClock` fields and all lyric/clock event types exist; `applyEvent` reduces them correctly. `activeLyricsWindow` is never populated by anything.
- Frontend MISSING: no lyrics UI anywhere; `frontend/src/api/lyrics.ts` client is dead code mismatched with the backend contract (`trackUri` param the route rejects; wrong response shape); neither frontend package depends on `@opendj/sync`/`@opendj/lyrics`.
- `@opendj/*@0.1.0` is live on npm; the changesets release pipeline is proven end-to-end.

## 3. Architecture decision — client-computed highlighting

Backend broadcasts **state**, clients compute **presentation** (per agent-brief: "Do not broadcast high-frequency progress ticks. Broadcast clock samples/corrections, then let clients interpolate."):

- Backend publishes `lyrics.loaded { trackUri, lyrics }` once per track change and `playback.clock_sampled { sample }` on the existing 2.5s poll cadence.
- Clients run a local prediction loop (`predictPlaybackPosition` on rAF/interval) and compute the highlight window with `getActiveLyricWindow`.
- `SessionSnapshot.activeLyricsWindow` remains server-side empty; its doc comment is updated to say "client-computed; server does not populate". No `sync.cue_window_updated` emission.

Rejected: server-computed cue windows (extra fan-out, choppier); REST polling (WS room already exists).

## 4. Sub-project 1 — lyrics sync in the foundation

### Backend (`packages/backend`)

`NowPlayingPoller` gains two responsibilities:

- **Clock sampling:** every poll tick with a playing/paused track, build `createPlaybackClockSample(nowPlaying, Date.now-equivalent from injected clock)` and publish `playback.clock_sampled`. (2.5s cadence × one room = negligible fan-out.)
- **Lyrics on track change:** when the track URI changes, fire-and-forget `LyricsLookupService.lookup({trackName, artistName, durationMs, providerTrackUri})`; on resolve, publish `lyrics.loaded { trackUri, lyrics }` **only if that track is still current** (out-of-order guard). On lookup failure/no match, publish `lyrics.loaded { trackUri, lyrics: null }` so clients can show the no-lyrics fallback deterministically. Lyrics failures never affect playback/queue behavior.

### Frontend shared engine (`@opendj/frontend`)

- New deps: `@opendj/sync`, `@opendj/lyrics`.
- New `LyricsEngine` (framework-light service consumed by Angular): input = RealtimeClient events + initial snapshot; runs a prediction loop; exposes signals/observable state: `mode: 'synced' | 'unsynced' | 'none' | 'paused'`, `activeLine`, `prevLines`, `nextLines`, `normalizedProgress`.
- Fix `LyricsApi` client to the real contract (`trackName`+`artistName` query; `{ match: LyricsDocument | null }` response) — used for guest first-paint before the first WS event arrives; add tests.

### Frontend UI (`packages/frontend-template`)

- **TV page (`/tv/:slug`):** karaoke panel — large active line, dimmed prev/next context, unsynced fallback (static lyrics panel), clean no-lyrics fallback (current layout unchanged). Honors `paused` state.
- **Guest page (`/u/:slug`):** compact live-lyrics card (active + next line), collapsible, never blocks the request flow.

### Testing

- Poller wiring: unit tests with fake provider + fake lyrics provider — track change → lookup → `lyrics.loaded` publish; out-of-order guard; failure → `lyrics: null` publish; clock sample published per tick. Injected clock (pattern already in repo).
- `LyricsEngine`: unit tests for mode transitions and window computation against a fixed clock.
- Manual gate before release: oss-demo compose + real Spotify — synced track, unsynced track, instrumental/no-match track.

### Release

Changeset(s) minor → `0.2.0` published via the existing pipeline before opendj-live scaffolding starts.

## 5. Sub-project 2 — opendj-live demo scaffold + deploy

```
opendj-live/                private — github.com/viscoci/opendj-live
├── apps/
│   ├── server/             main.ts modeled on apps/oss-demo (createDeps/createApp, WS mount,
│   │                       static SPA serve) — deps pinned to published @opendj/*@0.2.0
│   └── web/                vendored copy of frontend-template (its designed purpose; it is
│                           unpublished by design) — becomes the product frontend over time
├── deploy/
│   ├── docker-compose.yml  app + postgres + cloudflared (tunnel token via env, not committed)
│   └── .env.example
└── docs/
```

- pnpm workspace + minimal CI later; tomorrow needs build + compose only.
- Cloudflare: named tunnel → `app:8888`; DNS `opendj.com` (and `www`) → tunnel. TLS terminates at Cloudflare; `__Host-` cookies work over the tunnel.
- Spotify Developer app: add `https://opendj.com/api/v1/provider/connections/spotify/callback`; `BASE_URL=https://opendj.com`.
- SMTP/forgot-password: skipped for the demo (env left unset).
- Runs on the basement box; identical compose runs on the laptop as fallback (tunnel follows wherever `cloudflared` runs).

## 6. Demo-day checklist (operational, not code)

1. Pre-warm `lyrics_cache` for the planned setlist (play tracks once, or hit `/api/v1/lyrics/lookup` per track).
2. Host Spotify Premium logged in, device active before guests join.
3. QR poster/URL for `https://opendj.com/u/<slug>`; TV browser fullscreen on `/tv/<slug>`.
4. Fallback: laptop compose + same tunnel token.

## 7. Risks

| Risk                                     | Mitigation                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| LRCLIB match quality varies              | Pre-warm cache with the demo setlist tonight; pick tracks with verified synced lyrics                          |
| New infra (tunnel/DNS) night before demo | LAN/laptop fallback; tunnel is machine-portable; test end-to-end tonight                                       |
| Highlight drift between 2.5s samples     | `predictPlaybackPosition` confidence decay + snap correction on each sample; acceptable at demo fidelity       |
| Release pipeline hiccup on 0.2.0         | Pipeline proven on 0.1.0 today incl. provenance; failures are re-runnable                                      |
| Time                                     | Sub-project 1 is demo-critical; scaffold (sub-project 2) is mechanical; TV panel before guest card if squeezed |
