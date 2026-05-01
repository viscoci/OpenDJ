# OpenDJ — Agent Build Brief

You are building **OpenDJ** (`opendj.live`) from scratch — a collaborative, multi-provider music queue management SaaS for live events. Guests scan a QR code to request songs; hosts moderate the queue from a dashboard. Read this document fully before writing any code.

---

## What you are building

A clean, professional foundation for a collaborative, multi-provider music queue product, split into an OSS project and a private hosted implementation.

1. **OpenDJ OSS** — public repo at `github.com/viscoci/opendj`. Self-hosted, Node 22 LTS + Docker Compose, single-tenant. This is the reusable foundation: core domain logic, provider contracts, backend primitives, realtime abstractions, and a basic template frontend with free-tier functionality. It is also a portfolio asset, so README quality, commit hygiene, CI, examples, and docs must reflect senior SWE standards.
2. **OpenDJ Live** — private repo at `github.com/viscoci/opendj-live`. Hosted commercial implementation deployed to `opendj.live`, using Cloudflare Pages + Workers + Durable Objects + Postgres via Hyperdrive. It consumes the OSS packages as dependencies and implements the full hosted product, paid features, billing, private product analytics, branding, and production operations.

**Architectural thesis:** The public repo should expose the foundation, not the entire business. The OSS project provides reusable packages such as `@opendj/core`, `@opendj/auth`, `@opendj/backend`, `@opendj/realtime`, `@opendj/sync`, `@opendj/lyrics`, `@opendj/frontend`, and `@opendj/frontend-template`. The private `opendj-live` repo composes those packages into the production SaaS and adds commercial-only feature modules. Multi-tenancy is still achieved by always carrying an `account_id`; OSS simply runs with exactly one account row. Realtime session state is abstracted behind a `RealtimeRoom` interface so hosted sessions use Durable Objects and OSS sessions use an in-process WebSocket room with optional Valkey pub/sub when scaling beyond one Node process. The frontend should be web-first but Capacitor-ready from the start, so the same Angular application can later ship as iOS, Android, and possibly desktop shells without changing backend contracts or fragmenting the product.

**Open-source boundary:** Do not open-source the complete `opendj.live` implementation. The OSS README should present `opendj.live` as a working hosted example built on the OSS libraries, not as the same repo with private files removed.

---

## Repository layout

Use two repositories. The public repo is a productized foundation. The private repo is the hosted business implementation.

### Public repo: `github.com/viscoci/opendj`

```
opendj/
├── packages/
│   ├── core/                        ← Pure TypeScript domain logic, zero runtime imports
│   │   ├── providers/
│   │   │   └── IStreamingProvider.ts
│   │   ├── queue/                   ← Cap enforcement, dedupe, moderation, skip logic
│   │   ├── plan/                    ← Free/OSS feature gates + extension hooks
│   │   └── types/                   ← Shared public types
│   ├── db/                          ← Drizzle schema, base migrations, query helpers
│   ├── auth/                        ← OSS identity, auth providers, password hashing, sessions, claims
│   ├── backend/                     ← Hono routes/services usable from Node + Workers
│   │   ├── routes/                  ← auth, sessions, queue, guest, moderation, provider
│   │   └── middleware/
│   │       └── tenant-context.ts
│   ├── realtime/                    ← Runtime-neutral realtime contracts/events/snapshots
│   ├── abuse/                       ← Abuse signals, risk scoring, rate-limit contracts, analytics primitives
│   ├── sync/                        ← Song timing/synchronization contracts and normalized progress helpers
│   ├── lyrics/                      ← Lyrics lookup, LRC parsing, cache contracts, feedback primitives
│   ├── frontend/                    ← Reusable Angular/Ionic-compatible UI/services for host + guest flows
│   ├── frontend-template/           ← Basic Angular 21 OSS/free-tier frontend; Capacitor-ready but web-first
│   ├── app-shell/                   ← Runtime/platform adapters: browser vs Capacitor shell hooks
│   └── agent-tools/                 ← Dev-only MCP server + repo map tools; never shipped to prod
├── apps/
│   └── oss-demo/                    ← Self-host reference app
│       ├── src/main.ts              ← Node entrypoint using @opendj/backend
│       ├── docker-compose.yml       ← app + postgres + optional valkey
│       ├── Dockerfile
│       ├── .env.example
│       └── README.md
├── examples/
│   ├── minimal-node/
│   └── custom-provider/
└── docs/
    ├── ONBOARDING.md
    ├── PROVIDERS.md
    ├── REPO_BOUNDARY.md
    └── AGENTS.md
```

### Private repo: `github.com/viscoci/opendj-live`

```
opendj-live/
├── apps/
│   ├── landing/                     ← `opendj.live` marketing site
│   ├── app/                         ← `app.opendj.live` full hosted SPA / shared web build
│   ├── mobile/                      ← P2 Capacitor iOS/Android wrapper around the hosted app shell
│   ├── desktop/                     ← P2/P3 desktop shell experiment, only if justified
│   └── api/                         ← `api.opendj.live` Cloudflare Worker
│       ├── src/worker.ts
│       ├── src/realtime/SessionRoom.ts
│       ├── queues/
│       ├── cron/
│       └── wrangler.toml
├── packages/
│   ├── live-features/               ← paid/commercial feature modules
│   ├── billing/                     ← subscriptions, webhooks, plan enforcement
│   ├── analytics/                   ← private hosted funnel/product analytics dashboards
│   └── branding/                    ← Branding Studio, white-label, templates
└── package.json                     ← depends on @opendj/* packages
```

### Package publishing

Publish the public packages under the `@opendj/*` npm scope when stable:

- `@opendj/core`
- `@opendj/db`
- `@opendj/auth`
- `@opendj/backend`
- `@opendj/realtime`
- `@opendj/abuse`
- `@opendj/sync`
- `@opendj/lyrics`
- `@opendj/frontend`
- `@opendj/frontend-template`
- `@opendj/app-shell`

During early development, `opendj-live` may consume `github:viscoci/opendj` workspace packages directly. Move to npm releases once the package boundaries settle.

---

## Tech stack (recommended v2)

The original stack is close, but the weak spot is realtime/shared session state. Hundreds of guests watching the same queue should not all poll Postgres or hit normal stateless API routes for every queue/progress update. The hosted layer should treat each live session as a small stateful actor.

| Concern | Choice | Reason |
|---|---|---|
| Server framework | **Hono** | Keep. Runs cleanly on Node and Cloudflare Workers; good fit for one route tree across deploy targets. |
| Runtime | **Node 22 LTS for OSS; Cloudflare Workers for hosted** | Node 20 is still acceptable, but starting new work on Node 22 gives a longer support runway. |
| Language | **TypeScript strict** | Everywhere, no exceptions. |
| ORM / SQL | **Drizzle ORM + Postgres.js adapter** | Drizzle keeps schema/type control; Postgres.js works well with Cloudflare Hyperdrive and Node. Avoid `node-postgres` in code that must run in Workers. |
| Primary database | **Postgres** | Source of truth for accounts, sessions, queue history, billing, and analytics. Hosted recommendation: Neon first for low initial cost + branching/autoscaling; any managed Postgres remains swappable through `DATABASE_URL` + Hyperdrive. |
| Hosted realtime/cache | **Cloudflare Durable Objects per live session** | One authoritative room actor per session handles WebSockets, hot queue state, guest slots, heartbeats, skip votes, and fan-out. This avoids Redis for hosted while remaining horizontally scalable. |
| Hosted background work | **Cloudflare Queues + scheduled Workers** | Use Queues for analytics ingestion, provider command retries, token refresh work, billing webhooks, and non-blocking jobs. Use cron only for periodic sweeps. |
| OSS realtime/cache | **In-process room registry; optional Valkey** | Default self-host should stay cheap and simple. Add Valkey only when the OSS deploy runs more than one app container. |
| Frontend | **Angular 21 + Capacitor-ready app architecture** | Public repo ships reusable `@opendj/frontend` components plus a basic `@opendj/frontend-template`; private `opendj-live` ships the full hosted SPA. Keep the app web-first, but avoid assumptions that would prevent wrapping it with Capacitor later. Angular now has stronger AI tooling, MCP support, production-ready zoneless change detection, signals, standalone components, and modern control flow. |
| Frontend state | **Angular signals + resource/httpResource where stable** | Keep state explicit and fast. Avoid heavy global state libraries until real complexity appears. |
| Native/mobile shell | **Ionic Capacitor, P2** | Use Capacitor as the planned native runtime for iOS/Android wrappers, but do not make native apps block the web/SaaS launch. Ionic UI components may be used where they help mobile polish, but the OpenDJ design system remains authoritative. |
| DI | **Explicit provider registry / factory functions, not InversifyJS** | Inversify adds decorators/reflection/bundling complexity. A small typed registry is easier for Workers, tests, and agents to reason about. |
| API contract | **OpenAPI generated from route schemas** | Gives the Angular app, tests, docs, and MCP/dev agents a single contract. |
| Auth / identity | **OSS `@opendj/auth` package with OAuth/OIDC, email/password fallback, server sessions, and claims** | Hosts and guests are both users. Authorization must check token/session claims at every protected route instead of assuming host-only auth. |
| Abuse prevention | **OSS `@opendj/abuse` package + realtime room enforcement** | Hosts should be able to leave a session running with minimal babysitting. Abuse detection must operate near real time using request, slot, vote, search, and device/fingerprint signals. |
| Song synchronization | **`@opendj/sync` timing contracts + adapters** | OSS provides predicted playback positions, normalized progress helpers, and adapter interfaces for lyrics, lighting, and other time-based integrations. Concrete provider/integration implementations can live in `opendj-live` or third-party packages. |
| Lyrics / karaoke | **`@opendj/lyrics` + LRCLIB adapter as day-one feature** | Lyrics are a core differentiator for the live/TV view. Use LRCLIB as the initial lookup source for synced and unsynced lyrics, cache normalized results, and expose feedback/correction hooks without promising perfect karaoke timing. |
| Validation | **Valibot or Zod at route boundaries** | Required for safe public APIs. Prefer Valibot if bundle size matters; Zod if agent familiarity and ecosystem matter more. |
| Tests | **Vitest + Miniflare/Workers test harness + Playwright smoke** | Unit tests for core, Worker integration tests for hosted, browser smoke for guest/host flows. |
| CI | **GitHub Actions** | Lint + typecheck + test + OSS smoke on push/PR. |
| AI/dev-agent support | **Angular MCP + local OpenDJ MCP server** | Use MCP for build agents and internal admin tooling, not in the guest request hot path. |
| License | **MIT** | Good default for OSS adoption. |

### Explicit stack decision

Use **Durable Objects as the hosted high-speed caching/coordination layer**, not Redis. Redis/Valkey belongs in the OSS scale-out path, not the initial hosted path. The hosted platform already has a stateful edge primitive that maps almost perfectly to “hundreds of clients connected to one live event.”


### Cross-platform app shell decision

Build the Angular frontend so it can run in three shells without forking product logic:

1. **Web/PWA shell** — P0. Browser-first hosted app at `app.opendj.live` and the OSS demo at `localhost:8888`.
2. **Capacitor mobile shell** — P2. Native iOS/Android wrappers around the same Angular app for App Store / Play Store distribution.
3. **Desktop shell** — P2/P3 experiment. Consider Capacitor community Electron or a separate Tauri shell only after the web and mobile paths prove useful.

Capacitor is an app shell, not a reason to move core logic into the client. Backend APIs, claims, abuse prevention, realtime rooms, provider commands, and queue mutation authority remain server-side.

Guidelines:

- Use Angular standalone components, signals, and route-level lazy loading.
- Keep UI components compatible with both browser and WebView environments.
- Use Ionic/Capacitor for native packaging and native APIs, but do not let Ionic components override the OpenDJ design system by default.
- Keep guest flows fully usable from a QR-scanned browser session. Do not require guests to install the app.
- Treat native apps as host/power-user convenience surfaces first: saved login, native share sheet, push notifications, QR scanning, device wake/keep-awake, deeplinks, and eventually richer host controls.
- Do not assume native apps keep WebSockets alive in the background. Mobile OS suspension still applies; realtime correctness must recover from fresh snapshots on foreground/resume.
- Abstract platform-specific behavior behind `@opendj/app-shell` services rather than sprinkling Capacitor checks through feature components.
- Native OAuth should use the system browser/deeplink callback flow and secure platform storage. Browser web auth should continue to use secure, httpOnly cookies.
- The app shell must consume the same `/api/v1` contract as the web app. Do not create native-only API routes unless unavoidable.

---

## Realtime and caching architecture

### Core rule

Postgres is the durable source of truth. A session room is the realtime source of truth while a session is live.

### Hosted: `SessionRoom` Durable Object

One Durable Object instance owns one active session. It keeps hot state in memory and persists critical state transitions to Postgres through the Worker.

Responsibilities:

- Accept guest and host WebSocket connections.
- Maintain a compact in-memory session snapshot: now playing, queue summary, pending requests, skip votes, active guest count, guest slots.
- Broadcast `SessionEvent` messages to connected clients.
- Debounce/fold high-frequency progress updates so guests do not receive wasteful fan-out.
- Enforce guest slot heartbeats and promotion from queued → active.
- Serialize queue mutations to avoid race conditions between guests and host moderation.
- Persist durable mutations to Postgres.
- Send non-critical work to Queues: analytics, provider retry, notification events.

### OSS: `NodeSessionRoom`

The OSS deploy uses the same `RealtimeRoom` interface. Default mode is an in-process room registry. Optional scale-out mode uses Valkey pub/sub so multiple Node containers can fan out events.

```typescript
export interface RealtimeRoom {
  connect(client: RealtimeClient): Promise<void>;
  disconnect(clientId: string): Promise<void>;
  getSnapshot(): Promise<SessionSnapshot>;
  publish(event: SessionEvent): Promise<void>;
  mutate<T>(command: SessionCommand): Promise<T>;
}
```

### Event model

```typescript
export type SessionEvent =
  | { type: 'queue.item_requested'; item: QueueItemSummary }
  | { type: 'queue.item_approved'; itemId: string }
  | { type: 'queue.item_rejected'; itemId: string }
  | { type: 'queue.item_removed'; itemId: string }
  | { type: 'now_playing.updated'; track: NowPlayingTrack | null }
  | { type: 'skip_vote.updated'; itemId: string; votes: number; threshold: number }
  | { type: 'guest_slots.updated'; activeCount: number; queuedCount: number }
  | { type: 'session.ended' };
```

### Caching rules

- **Do cache:** provider search results by normalized query/provider/account for short TTLs, public session snapshots for initial page load, album art/media through normal CDN caching.
- **Do not cache blindly:** OAuth tokens, moderation decisions before persistence, provider command results, guest identity tokens.
- **Progress bar:** clients interpolate locally from `{ startedAt, progressMs, durationMs, isPlaying }`; server broadcasts correction events only periodically or when track/playback state changes.
- **Queue reads:** guests should receive snapshots/events from the room. Avoid `GET /queue` polling loops.

---

## Song synchronization architecture

OpenDJ should expose a small, useful synchronization layer in OSS without promising perfect beat-accurate timing. The goal is to make it easy to build features that need approximate song position: karaoke-style lyrics, TV visualizations, lighting cues, countdowns, progress rings, and “next lyric soon” displays.

### Core rule

The OSS layer provides normalized timing primitives, prediction helpers, and adapter interfaces. Lyrics are the first first-class use case for this layer. The OSS layer may include generic lyric lookup/cache contracts, LRC parsing, and an LRCLIB adapter, but it should not ship commercial lyric catalogs, DMX/light integrations, proprietary lyric APIs, or venue-specific automation. Those belong in `opendj-live`, third-party packages, or user code.

### Package

Create `packages/sync/` and publish it as `@opendj/sync` once stable. It must be runtime-neutral TypeScript and usable from Node, Workers, and the browser.

```typescript
export interface PlaybackClockSample {
  providerId: string;
  trackUri: string;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  sampledAtEpochMs: number;
  providerLatencyMs?: number;
  confidence: 'low' | 'medium' | 'high';
}

export interface PredictedPlaybackPosition {
  trackUri: string;
  progressMs: number;
  normalizedProgress: number; // 0..1
  remainingMs: number;
  isPlaying: boolean;
  confidence: 'low' | 'medium' | 'high';
  predictedAtEpochMs: number;
}

export interface SongSyncAdapter<TCue = unknown> {
  readonly adapterId: string;
  readonly displayName: string;
  canHandle(track: Track): boolean | Promise<boolean>;
  loadCues(track: Track): Promise<TCue[]>;
  getActiveCues(position: PredictedPlaybackPosition, cues: TCue[]): TCue[];
}

export interface SyncCue {
  id: string;
  startsAtMs: number;
  endsAtMs?: number;
  kind: 'lyric' | 'lighting' | 'visual' | 'custom';
  payload: unknown;
}
```

### Lyrics and karaoke — day-one feature

Lyrics should be treated as a core OpenDJ feature, not only a future extension. The target product behavior is:

- If synchronized lyrics are available for the current track, the TV/live view shows karaoke-style active and upcoming lines.
- If only plain lyrics are available, the TV/live view may show a non-synced lyrics panel or a compact “lyrics available” view.
- If no lyrics are available, the UI falls back cleanly to the normal now-playing / queue display.
- Guest and host flows should never block on lyrics lookup. Lyrics enrich the experience; queueing and playback remain primary.

Create `packages/lyrics/` and publish it as `@opendj/lyrics` once stable. It should be runtime-neutral TypeScript and depend on `@opendj/sync` for timing/cue primitives.

```typescript
export type LyricsProviderId = 'lrclib' | string;

export interface LyricsLookupInput {
  trackName: string;
  artistName: string;
  albumName?: string | null;
  durationMs?: number | null;
  providerTrackUri?: string;
  isrc?: string | null;
}

export interface LyricsLine {
  id: string;
  text: string;
  startsAtMs?: number;
  endsAtMs?: number;
}

export interface LyricsDocument {
  id: string;
  source: LyricsProviderId;
  providerLyricsId?: string | number;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  durationMs?: number | null;
  isSynced: boolean;
  isInstrumental?: boolean;
  lines: LyricsLine[];
  rawLrc?: string;
  plainText?: string;
  attribution?: string;
  matchConfidence: 'low' | 'medium' | 'high';
}

export interface LyricsProvider {
  readonly providerId: LyricsProviderId;
  search(input: LyricsLookupInput): Promise<LyricsDocument[]>;
  getBestMatch(input: LyricsLookupInput): Promise<LyricsDocument | null>;
}
```

### LRCLIB adapter

Use LRCLIB as the first lyrics provider adapter because it exposes an HTTP API for searching and retrieving both synchronized and unsynchronized lyrics. The adapter must be written with `fetch`, not a Node-only SDK, so it works in Workers and Node.

Implementation rules:

- Normalize track metadata before lookup: trim punctuation noise, preserve artist/title, include duration when available.
- Prefer synced lyrics over unsynced lyrics when match confidence is acceptable.
- Cache both positive and negative lookups to avoid repeated API calls for popular tracks.
- Store enough metadata to attribute the source and allow future revalidation.
- Parse LRC timestamps into `LyricsLine[]` and convert lines into `SyncCue` values with `kind: 'lyric'`.
- Never make provider playback fail because lyrics lookup fails.
- Treat lyrics data as third-party content. Keep source attribution and avoid implying OpenDJ authored or owns the lyrics.

### Lyrics feedback

Add feedback hooks from day one so bad matches can be corrected over time without building a full lyrics editor yet.

Feedback types:

```typescript
export type LyricsFeedbackKind =
  | 'wrong_song'
  | 'bad_timing'
  | 'wrong_line'
  | 'missing_lyrics'
  | 'offensive_or_bad_content'
  | 'other';

export interface LyricsFeedbackInput {
  sessionId?: string;
  trackUri?: string;
  lyricsDocumentId?: string;
  kind: LyricsFeedbackKind;
  lineId?: string;
  comment?: string;
}
```

Feedback behavior:

- Host can report wrong lyrics, bad timing, or missing lyrics from the TV/live view or host dashboard.
- Guests may optionally report lyrics issues if logged in or if abuse/rate limits allow it.
- Feedback should create product signals and can suppress a specific lyrics match for an account/session when confidence is low.
- Do not attempt crowd-edited lyric publishing in P0. Start with feedback capture and local match suppression.
```

### Helpers

```typescript
createPlaybackClockSample(input: NowPlayingTrack, sampledAtEpochMs: number): PlaybackClockSample
predictPlaybackPosition(sample: PlaybackClockSample, nowEpochMs: number): PredictedPlaybackPosition
normalizeProgress(progressMs: number, durationMs: number): number
findActiveCues<T extends SyncCue>(positionMs: number, cues: T[]): T[]
findUpcomingCues<T extends SyncCue>(positionMs: number, cues: T[], windowMs: number): T[]
lyricsDocumentToSyncCues(document: LyricsDocument): SyncCue[]
getActiveLyricWindow(position: PredictedPlaybackPosition, lyrics: LyricsDocument, previousCount?: number, nextCount?: number): LyricsLine[]
```

Prediction rules:

- If `isPlaying` is false, do not advance `progressMs`.
- Clamp `progressMs` to `0..durationMs`.
- Report `normalizedProgress` as `progressMs / durationMs`, clamped to `0..1`.
- Confidence decays as the sample gets older.
- Clients should interpolate locally and accept correction events from the room.
- Do not claim frame-perfect, beat-perfect, or DMX-safe synchronization without a dedicated integration that measures and corrects device latency.

### Realtime integration

Add sync timing to the session snapshot and realtime event model:

```typescript
export interface SessionSnapshot {
  nowPlaying: NowPlayingTrack | null;
  playbackClock: PlaybackClockSample | null;
  lyrics: LyricsDocument | null;
  activeLyricsWindow: LyricsLine[];
  queue: QueueItemSummary[];
  pending: QueueItemSummary[];
  activeGuestCount: number;
}

export type SessionEvent =
  | { type: 'playback.clock_sampled'; sample: PlaybackClockSample }
  | { type: 'playback.corrected'; position: PredictedPlaybackPosition }
  | { type: 'lyrics.loaded'; trackUri: string; lyrics: LyricsDocument | null }
  | { type: 'lyrics.feedback_recorded'; trackUri: string; feedbackKind: LyricsFeedbackKind }
  | { type: 'sync.cue_window_updated'; trackUri: string; cues: SyncCue[] };
```

Do not broadcast high-frequency progress ticks. Broadcast clock samples/corrections, then let clients interpolate.

### Example extension targets

These are extension targets, not required OSS implementations:

- Lyrics/karaoke adapter: P0 day-one adapter maps timestamped lyrics to `SyncCue`, starting with LRCLIB.
- Lighting adapter: maps cue windows to lighting scenes or DMX commands.
- Visualizer adapter: maps normalized progress, sections, or cue windows to TV effects.
- Beat/grid adapter: estimates beat phase from BPM metadata when available.

---

## App shell and native platform adapters

Create `packages/app-shell/` and publish it as `@opendj/app-shell` once stable. This package contains platform-neutral interfaces and browser/Capacitor implementations for app-shell behavior. Feature packages should depend on these interfaces instead of importing Capacitor directly.

```typescript
export type AppPlatform = 'web' | 'ios' | 'android' | 'desktop';

export interface AppShell {
  getPlatform(): AppPlatform;
  isNative(): boolean;
  openExternalUrl(url: string): Promise<void>;
  share(input: { title?: string; text?: string; url?: string }): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
  refreshRealtimeSnapshotOnResume(callback: () => Promise<void>): void;
}

export interface NativeAuthAdapter {
  startOAuth(input: {
    providerId: string;
    startUrl: string;
    callbackScheme: string;
  }): Promise<{ callbackUrl: string }>;

  storeNativeSession(input: {
    accessToken: string;
    refreshToken?: string;
    expiresAtEpochMs: number;
  }): Promise<void>;

  clearNativeSession(): Promise<void>;
}
```

Rules:

- `@opendj/frontend` may depend on `@opendj/app-shell` interfaces.
- Capacitor-specific code lives in adapter implementations, not feature components.
- Browser implementation uses normal links, Clipboard API, Web Share API where available, and secure httpOnly cookie sessions.
- Native implementation may use Capacitor plugins for App, Browser, Share, Clipboard, Push Notifications, and secure storage, but each plugin must be introduced only when a concrete feature needs it.
- OSS should remain runnable as a normal web app without Xcode, Android Studio, or native build tooling.

## AI / MCP support

AI support should improve development speed and maintainability. It should not add production risk to the guest/host hot path.

Create `packages/agent-tools/` with a local MCP server that exposes safe, read-heavy tools for coding agents:

- `get_architecture_summary`
- `list_routes`
- `list_db_tables`
- `get_provider_contract`
- `get_session_event_contract`
- `get_frontend_routes`
- `run_typecheck`
- `run_tests`

Rules:

- MCP server is **P2/dev-only** and must never block P0/P1 product work.
- MCP server is **dev-only** by default.
- No production secrets exposed.
- No arbitrary shell tool. Use allowlisted commands only.
- No direct write access to production databases.
- Keep `AGENTS.md`, OpenAPI, route schemas, and event schemas in sync so agents have deterministic context.

Use Angular’s official AI/MCP resources during UI generation. Prefer small, standalone, signal-based Angular components that agents can reason about without global magic.

---

## Provider Architecture (implement first — everything depends on it)

### Core principle

Provider support must be composable. Do **not** model providers as one broad class with a few coarse booleans such as `supportsPlaybackControl`. That shape will create broken UI and route behavior when a provider supports skip but not volume, playlist read but not playlist mutation, queue injection but not playlist switching, etc.

Use two layers:

1. **Base provider contract** — lifecycle, identity, and capability discovery.
2. **Modular feature interfaces** — small interfaces such as `ISupportsSearch`, `ISupportsQueueTrack`, `ISupportsSkip`, `ISupportsVolumeSet`, `ISupportsPlaylistRead`, etc.

Routes and UI must check granular capabilities before exposing or calling feature-specific behavior.

### Base provider types

```typescript
// packages/core/providers/IStreamingProvider.ts

export type ProviderId = 'spotify' | 'soundtrack' | 'apple-music' | string;

export interface Track {
  uri: string;           // provider-native URI, e.g. spotify:track:xxx
  name: string;
  artist: string;
  albumArt: string | null;
  durationMs: number;
}

export interface Zone {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface NowPlayingTrack extends Track {
  progressMs: number;
  isPlaying: boolean;
  zoneId: string;
}

export interface ProviderCredentials {
  [key: string]: string; // provider-specific: accessToken, refreshToken, accountId, etc.
}

export interface ProviderFeatureDescriptor {
  id: string;
  supported: boolean;
  access: 'guest' | 'host' | 'account' | 'internal';
  reliability?: 'native' | 'emulated' | 'best_effort' | 'unsupported';
  notes?: string;
}

export interface ProviderCapabilities {
  providerId: ProviderId;
  features: Record<string, ProviderFeatureDescriptor>;
}

export interface IStreamingProvider {
  readonly providerId: ProviderId;
  readonly displayName: string;

  connect(credentials: ProviderCredentials): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  refreshCredentials(): Promise<ProviderCredentials>;

  getCapabilities(): ProviderCapabilities;
}
```

### Feature IDs

Use stable feature IDs so backend routes, frontend controls, docs, and tests can share the same vocabulary.

```typescript
export const PROVIDER_FEATURES = {
  Search: 'search',
  NowPlayingRead: 'now_playing.read',
  PlaybackProgressRead: 'playback.progress.read',
  QueueTrack: 'queue.track',
  PlaylistSwitch: 'playlist.switch',
  SkipTrack: 'playback.skip',
  Pause: 'playback.pause',
  Resume: 'playback.resume',
  VolumeRead: 'volume.read',
  VolumeSetAbsolute: 'volume.set_absolute',
  VolumeStepUp: 'volume.step_up',
  VolumeStepDown: 'volume.step_down',
  ZonesRead: 'zones.read',
  ZoneSelect: 'zones.select',
  PlaylistsRead: 'playlists.read',
  PlaylistsCreate: 'playlists.create',
  PlaylistTracksRead: 'playlist_tracks.read',
  PlaylistTracksAdd: 'playlist_tracks.add',
  PlaylistTracksRemove: 'playlist_tracks.remove',
  LibraryTracksRead: 'library_tracks.read',
  LyricsRead: 'lyrics.read',
  SyncClockRead: 'sync.clock.read',
} as const;

export type ProviderFeatureId = typeof PROVIDER_FEATURES[keyof typeof PROVIDER_FEATURES];
```

### Modular provider feature interfaces

Providers implement only the interfaces they actually support. For example, Spotify may support search, queue injection, skip, now-playing, volume set, and playlist reads. Another provider might support search and playlist switching, but no direct queue injection or volume control.

```typescript
export interface ISupportsSearch {
  search(query: string, limit?: number): Promise<Track[]>;
}

export interface ISupportsZonesRead {
  listZones(): Promise<Zone[]>;
}

export interface ISupportsNowPlayingRead {
  getNowPlaying(zoneId?: string): Promise<NowPlayingTrack | null>;
}

export interface QueueResult {
  success: boolean;
  status: 'queued' | 'playlist_switched' | 'pending_host_action';
  message?: string;
}

export interface ISupportsQueueTrack {
  queueTrack(track: Track, zoneId?: string): Promise<QueueResult>;
}

export interface ISupportsPlaylistSwitch {
  switchPlaylist(playlistUri: string, zoneId?: string): Promise<QueueResult>;
}

export interface ISupportsSkipTrack {
  skipTrack(zoneId?: string): Promise<void>;
}

export interface ISupportsPause {
  pause(zoneId?: string): Promise<void>;
}

export interface ISupportsResume {
  resume(zoneId?: string): Promise<void>;
}

export interface ISupportsVolumeRead {
  getVolume(zoneId?: string): Promise<{ volumePercent: number }>;
}

export interface ISupportsVolumeSetAbsolute {
  setVolume(volumePercent: number, zoneId?: string): Promise<void>;
}

export interface ISupportsVolumeStep {
  increaseVolume(stepPercent?: number, zoneId?: string): Promise<void>;
  decreaseVolume(stepPercent?: number, zoneId?: string): Promise<void>;
}

export interface PlaylistSummary {
  uri: string;
  name: string;
  description?: string | null;
  trackCount?: number;
  imageUrl?: string | null;
}

export interface ISupportsPlaylistsRead {
  listPlaylists(limit?: number, cursor?: string): Promise<{ items: PlaylistSummary[]; nextCursor?: string }>;
}

export interface ISupportsPlaylistTracksRead {
  listPlaylistTracks(playlistUri: string, limit?: number, cursor?: string): Promise<{ items: Track[]; nextCursor?: string }>;
}

export interface ISupportsPlaylistTracksAdd {
  addTracksToPlaylist(playlistUri: string, trackUris: string[]): Promise<void>;
}
```

### Type guards

Use feature type guards instead of assuming methods exist from the base provider type.

```typescript
export function supportsSearch(provider: IStreamingProvider): provider is IStreamingProvider & ISupportsSearch {
  return provider.getCapabilities().features[PROVIDER_FEATURES.Search]?.supported === true
    && typeof (provider as Partial<ISupportsSearch>).search === 'function';
}

export function supportsQueueTrack(provider: IStreamingProvider): provider is IStreamingProvider & ISupportsQueueTrack {
  return provider.getCapabilities().features[PROVIDER_FEATURES.QueueTrack]?.supported === true
    && typeof (provider as Partial<ISupportsQueueTrack>).queueTrack === 'function';
}

export function supportsVolumeSetAbsolute(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsVolumeSetAbsolute {
  return provider.getCapabilities().features[PROVIDER_FEATURES.VolumeSetAbsolute]?.supported === true
    && typeof (provider as Partial<ISupportsVolumeSetAbsolute>).setVolume === 'function';
}

export function supportsVolumeStep(provider: IStreamingProvider): provider is IStreamingProvider & ISupportsVolumeStep {
  const features = provider.getCapabilities().features;
  return features[PROVIDER_FEATURES.VolumeStepUp]?.supported === true
    && features[PROVIDER_FEATURES.VolumeStepDown]?.supported === true
    && typeof (provider as Partial<ISupportsVolumeStep>).increaseVolume === 'function'
    && typeof (provider as Partial<ISupportsVolumeStep>).decreaseVolume === 'function';
}
```

### Emulated capabilities

A provider may expose a higher-level method by emulating it through lower-level provider APIs, but the capability descriptor must say so.

Example: if a provider only supports volume up/down but not absolute set, the implementation may offer `setVolume()` by reading the current value and stepping toward the target. In that case mark absolute set as `reliability: 'best_effort'` or do not expose it at all if the result cannot be bounded safely.

```typescript
export const spotifyCapabilities: ProviderCapabilities = {
  providerId: 'spotify',
  features: {
    [PROVIDER_FEATURES.Search]: {
      id: PROVIDER_FEATURES.Search,
      supported: true,
      access: 'guest',
      reliability: 'native',
    },
    [PROVIDER_FEATURES.QueueTrack]: {
      id: PROVIDER_FEATURES.QueueTrack,
      supported: true,
      access: 'guest',
      reliability: 'native',
    },
    [PROVIDER_FEATURES.SkipTrack]: {
      id: PROVIDER_FEATURES.SkipTrack,
      supported: true,
      access: 'host',
      reliability: 'native',
    },
    [PROVIDER_FEATURES.VolumeSetAbsolute]: {
      id: PROVIDER_FEATURES.VolumeSetAbsolute,
      supported: true,
      access: 'host',
      reliability: 'native',
    },
    [PROVIDER_FEATURES.ZonesRead]: {
      id: PROVIDER_FEATURES.ZonesRead,
      supported: false,
      access: 'host',
      reliability: 'unsupported',
      notes: 'Spotify has devices, not OpenDJ zones. OSS may expose one synthetic default zone.',
    },
  },
};
```

### Provider behavior rules

- Do not show a frontend control unless the provider capability for that specific action is supported.
- Do not authorize a route solely because the user has a host claim; also verify the active provider supports the requested operation.
- Do not group unrelated controls under broad flags like `supportsPlaybackControl`. Skip, pause, resume, volume read, absolute volume set, and volume step are separate capabilities.
- Prefer explicit `501 not_supported_by_provider` errors over silent no-ops.
- When using emulated capabilities, expose the reliability value to the UI so the product can present less precise behavior honestly.

### Providers to implement

| Provider | `providerId` | Search | Queue track | Playlist switch | Now playing | Skip | Volume | Zones | Playlist read | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Spotify | `spotify` | ✅ | ✅ | ❌/later | ✅ | ✅ | ✅ | Synthetic default | P1 | Custom fetch wrapper. Do **not** use `spotify-web-api-node`; it is Node-only and unsuitable for Workers. |
| Soundtrack Your Brand | `soundtrack` | ✅ | ❌ | ✅ | ✅ | Provider-dependent | Provider-dependent | ✅ | P1/P2 | Commercial venue-friendly provider. Model playlist switching separately from queue injection. |
| Apple Music | `apple-music` | Stub | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | MusicKit JS is browser-oriented. Server provider should start as a stub throwing `NotImplementedError`. |

### Backend package directory structure

```
packages/backend/src/
├── app.ts                           # Hono app factory
├── deps.ts                          # Explicit dependency graph, no decorator DI
├── config.ts                        # Runtime config parser
│
├── auth/
│   ├── AuthService.ts               # Login/session lifecycle, OAuth callback handling
│   ├── ClaimsService.ts             # Issue/validate claims, account membership, route authorization
│   ├── PasswordService.ts           # Password hashing abstraction; Node default uses Argon2id
│   ├── authProviders.ts             # google/apple/facebook/email/password provider registry
│   └── middleware.ts                # requireAuth, requireClaim, optionalAuth
│
├── abuse/
│   ├── AbuseSignalService.ts        # writes normalized abuse/analytics signals
│   ├── RiskScoringService.ts        # near-realtime risk decisions
│   ├── RateLimitService.ts          # route/action/session scoped limits
│   └── middleware.ts                # enforce risk/rate decisions before handlers
│
├── providers/
│   └── streaming/
│       ├── IStreamingProvider.ts    # Interface + shared types
│       ├── StreamingRouter.ts       # Resolves active provider per host session
│       ├── providerRegistry.ts
│       ├── oauth/                   # Generic provider OAuth helpers/configs
│       ├── spotify/
│       │   ├── SpotifyProvider.ts   # fetch-based Spotify REST implementation
│       ├── soundtrack/
│       │   ├── SoundtrackProvider.ts
│       └── apple-music/
│           ├── AppleMusicProvider.ts  # Stub — throws NotImplementedError
│
├── services/
│   ├── guest/
│   │   ├── GuestIdentityService.ts  # Fingerprint registration + validation
│   │   ├── SlotManager.ts           # Slot lifecycle, heartbeat, expiry
│   ├── queue/
│   │   ├── QueueService.ts          # Routes approved requests to active provider
│   └── session/
│       ├── SessionService.ts
│
└── routes/
    ├── guest.ts
    ├── host.ts
    └── provider.ts
```

### `StreamingRouter` contract

```typescript
class StreamingRouter {
  async getProvider(hostId: string): Promise<IStreamingProvider>
  async switchProvider(hostId: string, providerId: string, credentials: ProviderCredentials): Promise<void>
  async queueTrack(hostId: string, track: Track): Promise<QueueResult>
  async getNowPlaying(hostId: string): Promise<NowPlayingTrack | null>
  async search(hostId: string, query: string): Promise<Track[]>
}
```

### Provider registry pattern

Use explicit construction instead of InversifyJS. This is less magical, easier to test, easier for agents to modify, and safer across Node/Workers bundling.

```typescript
export type ProviderFactory = (ctx: ProviderContext) => IStreamingProvider;

export const providerRegistry: Record<string, ProviderFactory> = {
  spotify: (ctx) => new SpotifyProvider(ctx),
  soundtrack: (ctx) => new SoundtrackProvider(ctx),
  'apple-music': (ctx) => new AppleMusicProvider(ctx),
};

export function createDeps(config: Config): AppDeps {
  const db = createDb(config.databaseUrl);
  const providerContext = { fetch: globalThis.fetch, db, config };

  return {
    config,
    db,
    streamingRouter: new StreamingRouter({
      db,
      providerRegistry,
      providerContext,
    }),
    authService: new AuthService({ db, config }),
    claimsService: new ClaimsService({ db, config }),
    abuseSignalService: new AbuseSignalService({ db, config }),
    riskScoringService: new RiskScoringService({ db, config }),
    rateLimitService: new RateLimitService({ db, config }),
    guestIdentityService: new GuestIdentityService({ db, config }),
    slotManager: new SlotManager({ db, config }),
    queueService: new QueueService({ db, config }),
    sessionService: new SessionService({ db, config }),
  };
}
```

---

## Database schema

Same schema for both OSS and hosted. OSS has exactly one row in `accounts`; hosted has many.

```sql
-- Central user identity. Use random UUIDs internally; expose short serial/display IDs only where useful.
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_user_id  BIGSERIAL UNIQUE,                 -- human/referenceable id; never use for authorization
  display_name    TEXT,
  primary_email   TEXT,
  email_verified  BOOLEAN NOT NULL DEFAULT false,
  avatar_url      TEXT,
  status          TEXT NOT NULL DEFAULT 'active',    -- active | disabled | deleted
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_primary_email_unique ON users (lower(primary_email)) WHERE primary_email IS NOT NULL;

-- Host account / tenant. A user can belong to multiple accounts; OSS creates one default account.
CREATE TABLE accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,      -- hosted: /u/<slug>; OSS may ignore
  plan         TEXT NOT NULL DEFAULT 'free',  -- 'free' | 'paid_monthly' | 'paid_event' | 'oss'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User membership and account-scoped claims. Hosts are not a separate identity type.
CREATE TABLE account_memberships (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'active',        -- active | invited | disabled
  role       TEXT NOT NULL DEFAULT 'member',        -- owner | admin | host | member
  claims     TEXT[] NOT NULL DEFAULT '{}',          -- account:read, session:create, queue:moderate, billing:manage, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_memberships_user ON account_memberships(user_id);

-- Generic login identity storage for Google, Apple, Facebook, email/password, etc.
CREATE TABLE auth_identities (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id          TEXT NOT NULL,              -- google | apple | facebook | email-password | etc.
  provider_subject     TEXT NOT NULL,              -- OIDC sub or internal email subject
  email                TEXT,
  email_verified       BOOLEAN NOT NULL DEFAULT false,
  raw_profile          JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_subject)
);
CREATE INDEX auth_identities_user ON auth_identities(user_id);

-- Password credential for the non-preferred email/password method.
-- Store only a slow password hash and metadata. Never store plaintext passwords.
CREATE TABLE password_credentials (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash        TEXT NOT NULL,              -- Argon2id in Node OSS; use PasswordHasher abstraction for edge runtimes
  hash_algorithm       TEXT NOT NULL,
  password_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  failed_attempts      INT NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ
);

-- Server-side sessions. Browser clients receive only opaque session ids in secure httpOnly cookies.
CREATE TABLE auth_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  session_hash       TEXT NOT NULL UNIQUE,          -- hash of the opaque cookie token
  claims_snapshot    TEXT[] NOT NULL DEFAULT '{}',  -- refreshed on login/account switch/claim change
  ip_hash            TEXT,
  user_agent_hash    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ
);
CREATE INDEX auth_sessions_user_active ON auth_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

-- Generic provider identity + OAuth/token storage for music/service integrations.
-- Do not create one token table per provider. Providers differ by payload, not by schema.
CREATE TABLE provider_connections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connected_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  provider_id          TEXT NOT NULL,              -- spotify | soundtrack | apple-music | etc.
  provider_account_id  TEXT,                       -- provider-native user/account/tenant id
  display_name         TEXT,
  access_token         TEXT,
  refresh_token        TEXT,
  expires_at           TIMESTAMPTZ,
  scopes               TEXT[],
  token_type           TEXT,
  raw_profile          JSONB,
  raw_token_response   JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id),
  UNIQUE (provider_id, provider_account_id)
);
CREATE INDEX provider_connections_account_provider ON provider_connections(account_id, provider_id);

-- Generic OAuth state storage for hosted/OSS fallback when KV/in-memory storage is not used.
-- Used both for login providers and provider/service connection flows.
CREATE TABLE oauth_states (
  state         TEXT PRIMARY KEY,
  flow_kind     TEXT NOT NULL DEFAULT 'login',      -- login | connect-provider
  provider_id   TEXT NOT NULL,
  account_id    UUID REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  redirect_to   TEXT,
  code_verifier TEXT,
  nonce         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

-- One event = one session
CREATE TABLE sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  qr_slug             TEXT NOT NULL UNIQUE,
  guest_cap_override  INT,
  songs_per_guest_cap INT NOT NULL DEFAULT 3,
  moderation_enabled  BOOLEAN NOT NULL DEFAULT false,
  vote_skip_mode      TEXT NOT NULL DEFAULT 'fixed',  -- 'fixed' | 'percentage' | 'host_approval'
  vote_skip_threshold INT NOT NULL DEFAULT 5,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ
);

-- Per-session guest fingerprints (cap enforcement)
CREATE TABLE guests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL, -- optional: logged-in guest account
  fingerprint TEXT NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, fingerprint)
);

-- Song requests
CREATE TABLE queue_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  guest_id      UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  track_uri     TEXT NOT NULL,
  track_name    TEXT NOT NULL,
  artist_name   TEXT NOT NULL,
  album_art_url TEXT,
  duration_ms   INT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | queued | playing | rejected
  skip_votes    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);
CREATE INDEX queue_items_session_status ON queue_items (session_id, status);
CREATE INDEX queue_items_session_created ON queue_items (session_id, created_at);

-- Append-only event stream for realtime replay/debugging. Keep compact; payload is public/session-safe only.
CREATE TABLE session_events (
  id          BIGSERIAL PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX session_events_session_created ON session_events (session_id, created_at);

-- Reliable provider/background side effects. Workers/Queues consume and mark processed.
CREATE TABLE outbox_events (
  id              BIGSERIAL PRIMARY KEY,
  account_id      UUID REFERENCES accounts(id) ON DELETE CASCADE,
  session_id      UUID REFERENCES sessions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);
CREATE INDEX outbox_events_pending ON outbox_events (status, next_attempt_at);

-- Guest capacity slot system
CREATE TABLE guest_slots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL REFERENCES sessions(id),
  fingerprint_hash TEXT NOT NULL,
  slot_token       TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'active',  -- active | queued | priority_queued
  queue_position   INT,
  last_heartbeat   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, fingerprint_hash)
);
CREATE INDEX guest_slots_heartbeat ON guest_slots(session_id, last_heartbeat) WHERE status = 'active';

-- Priority re-entry for guests who held a slot and lost it
CREATE TABLE fingerprint_priority (
  fingerprint_hash TEXT NOT NULL,
  session_id       UUID NOT NULL REFERENCES sessions(id),
  released_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '48 hours',
  PRIMARY KEY (fingerprint_hash, session_id)
);

-- Lyrics lookup/cache. OSS includes generic lyric caching because lyrics are a core live-view feature.
CREATE TABLE lyrics_cache (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                TEXT NOT NULL,                 -- lrclib | manual | provider-specific | etc.
  source_lyrics_id       TEXT,
  provider_track_uri     TEXT,
  track_name             TEXT NOT NULL,
  artist_name            TEXT NOT NULL,
  album_name             TEXT,
  duration_ms            INT,
  isrc                   TEXT,
  is_synced              BOOLEAN NOT NULL DEFAULT false,
  is_instrumental        BOOLEAN NOT NULL DEFAULT false,
  match_confidence       TEXT NOT NULL DEFAULT 'medium', -- low | medium | high
  synced_lrc             TEXT,
  plain_lyrics           TEXT,
  normalized_payload     JSONB,
  attribution            TEXT,
  lookup_key_hash        TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at           TIMESTAMPTZ,
  suppressed_at          TIMESTAMPTZ,
  suppressed_reason      TEXT,
  UNIQUE (source, lookup_key_hash)
);
CREATE INDEX lyrics_cache_track_lookup ON lyrics_cache(lower(track_name), lower(artist_name), duration_ms);
CREATE INDEX lyrics_cache_provider_track ON lyrics_cache(provider_track_uri) WHERE provider_track_uri IS NOT NULL;

-- Feedback about lyrics quality/timing/matches. Privacy-minimized and useful for suppressing bad matches.
CREATE TABLE lyrics_feedback (
  id                 BIGSERIAL PRIMARY KEY,
  account_id          UUID REFERENCES accounts(id) ON DELETE CASCADE,
  session_id          UUID REFERENCES sessions(id) ON DELETE SET NULL,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  guest_id            UUID REFERENCES guests(id) ON DELETE SET NULL,
  lyrics_cache_id     UUID REFERENCES lyrics_cache(id) ON DELETE SET NULL,
  provider_track_uri  TEXT,
  kind                TEXT NOT NULL, -- wrong_song | bad_timing | wrong_line | missing_lyrics | offensive_or_bad_content | other
  line_id             TEXT,
  comment             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lyrics_feedback_session_created ON lyrics_feedback(session_id, created_at);
CREATE INDEX lyrics_feedback_lyrics_kind ON lyrics_feedback(lyrics_cache_id, kind);

-- Hosted-only: billing subscriptions
CREATE TABLE subscriptions (
  account_id           UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  billing_provider     TEXT NOT NULL,
  external_customer_id TEXT NOT NULL,
  plan                 TEXT NOT NULL,
  status               TEXT NOT NULL,
  current_period_end   TIMESTAMPTZ,
  raw_payload          JSONB
);

-- OSS action/abuse analytics. Keep payloads privacy-minimized and session-scoped.
CREATE TABLE action_events (
  id           BIGSERIAL PRIMARY KEY,
  account_id   UUID REFERENCES accounts(id) ON DELETE CASCADE,
  session_id   UUID REFERENCES sessions(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  guest_id     UUID REFERENCES guests(id) ON DELETE SET NULL,
  event_kind   TEXT NOT NULL, -- guest_joined | search | song_requested | skip_vote | rate_limited | abuse_blocked | cap_hit
  subject_hash TEXT,          -- fingerprint/ip/device hash when applicable; never raw IP/fingerprint
  risk_score   NUMERIC(5,2),
  meta         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX action_events_session_created ON action_events(session_id, created_at);
CREATE INDEX action_events_subject_created ON action_events(subject_hash, created_at) WHERE subject_hash IS NOT NULL;

-- Current risk state used for near-realtime prevention.
CREATE TABLE abuse_subjects (
  subject_hash     TEXT PRIMARY KEY,
  account_id       UUID REFERENCES accounts(id) ON DELETE CASCADE,
  session_id       UUID REFERENCES sessions(id) ON DELETE CASCADE,
  risk_score       NUMERIC(5,2) NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'normal', -- normal | throttled | shadow_limited | blocked
  reason           TEXT,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ
);
CREATE INDEX abuse_subjects_session_status ON abuse_subjects(session_id, status);
```

`subscriptions` and hosted funnel/product analytics live only in the private `opendj-live` repo. The public `@opendj/db` package includes minimal `action_events`/`abuse_subjects` because abuse prevention is core product safety, not just business analytics. Public packages should expose extension hooks/migration composition, but should not include billing or private funnel dashboards.

---


## Authentication, accounts, and claims

OpenDJ must treat hosts and logged-in guests as the same base identity type: `User`. A user may be a host for one account, a guest in another venue's session, or both at the same time. Do not model hosts and guests as separate authentication systems.

### Auth providers

Support these login providers in the OSS auth layer:

| Provider | Purpose | Notes |
|---|---|---|
| Google | Preferred social login | OIDC/OAuth provider config; map provider `sub` to `auth_identities.provider_subject`. |
| Apple | Preferred social login | Preserve Apple private relay emails and treat email as mutable metadata, not stable identity. |
| Facebook | Optional social login | Same identity model as other OAuth/OIDC providers. |
| Email/password | Fallback, not preferred | Requires email verification, strong password hashing, login throttling, and recovery flow. |

Music-service provider connections such as Spotify are **not** the same as login identities. A user can log in with Google and connect Spotify for playback. Store login identities in `auth_identities`; store music/service integrations in `provider_connections`.

### Claims model

All protected endpoints must authorize against claims, not route naming assumptions. Claims are account-scoped unless explicitly marked as global.

```typescript
export type Claim =
  | 'account:read'
  | 'account:update'
  | 'account:manage_members'
  | 'session:create'
  | 'session:read'
  | 'session:update'
  | 'session:end'
  | 'queue:moderate'
  | 'provider:connect'
  | 'provider:control_playback'
  | 'billing:manage'
  | 'admin:global';

export interface AuthContext {
  userId: string | null;
  currentAccountId: string | null;
  guestId?: string;
  sessionId?: string;
  claims: Claim[];
  authKind: 'anonymous_guest' | 'logged_in_guest' | 'host' | 'service';
}
```

Route middleware:

```typescript
optionalAuth(): Middleware;
requireAuth(): Middleware;
requireClaim(claim: Claim): Middleware;
requireAnyClaim(claims: Claim[]): Middleware;
requireSessionGuest(): Middleware; // validates slot token/fingerprint session access
```

### Authorization rules

- Host endpoints require a valid user session plus account-scoped claims.
- Logged-in guest account endpoints require `requireAuth()` but should not imply host permissions.
- Anonymous guest session endpoints use slot tokens and event-scoped fingerprint hashes, not account claims.
- A logged-in guest can also have a guest slot. Link `guests.user_id` when present, but continue enforcing session caps by fingerprint/slot to avoid account-switch abuse.
- A host joining their own or another venue's guest page should receive guest capabilities for that session in addition to any account-scoped host claims they already have.
- Regenerate/rotate sessions on login, logout, password change, account switch, and claim changes.
- Browser auth should use secure, httpOnly cookies. If JWTs are introduced later, keep them short-lived and still validate account membership/claim freshness server-side for privileged actions.

### Password handling

Email/password is supported for completeness, but should not be the default onboarding path. Use a `PasswordHasher` interface so implementations can differ by runtime:

```typescript
export interface PasswordHasher {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
}
```

Default OSS Node implementation should use Argon2id with per-password salts. If a runtime cannot safely support Argon2id, use a clearly documented adapter and keep the interface swappable. Always rate-limit login attempts, require email verification, and avoid leaking whether an email exists.

---

## Abuse prevention and backend analytics

Abuse prevention belongs in OSS because it protects the core product loop. Hosts should be able to leave a session in auto-queue mode without constantly moderating spam, duplicate requests, vote manipulation, or scripted search traffic.

### Signals to collect

Collect privacy-minimized action signals in `action_events` and maintain current enforcement state in `abuse_subjects`.

Useful signals:

- request velocity per fingerprint/session/user/IP hash
- repeated rejected tracks or duplicate track attempts
- skip-vote velocity and vote clustering
- search velocity and query entropy
- many fingerprints from one IP hash or user agent hash
- frequent slot churn or heartbeat anomalies
- guest name changes and offensive-name moderation hits
- provider command failures caused by guest-triggered queue spam

Never store raw IP addresses or raw fingerprint signals. Store salted hashes with session/account scope where possible.

### Enforcement modes

```typescript
export type AbuseDecision =
  | { action: 'allow' }
  | { action: 'throttle'; retryAfterMs: number; reason: string }
  | { action: 'shadow_limit'; reason: string }
  | { action: 'require_host_review'; reason: string }
  | { action: 'block'; reason: string };
```

Apply decisions inside the realtime room before expensive provider calls or durable queue mutations. For hosted, `SessionRoom` should keep a small in-memory rolling window for immediate decisions and persist compact events asynchronously. For OSS, use the same service with in-process memory plus Postgres fallback.

### Host controls

Host settings should expose simple controls, not a giant rules engine:

- Auto-pilot mode: `relaxed | standard | strict`
- Explicit song review: off/on
- Block duplicate requests: off/on
- Cooldown between requests
- Max skip votes per guest per track
- Manual block/unblock guest action

The underlying abuse package should remain extensible so `opendj-live` can add paid dashboards, richer analytics, or venue-wide reputation without changing the OSS contracts.

---

## Core business logic (`packages/core/`)

### OAuth utilities — generic pure functions (inject `fetch`, no SDK)

OAuth implementation should be provider-config driven. Login providers and music providers both use configs. Spotify is the first music provider, not a schema special case.

```typescript
export interface OAuthProviderConfig {
  providerId: string;
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  usesPkce?: boolean;
}

buildAuthorizeUrl(config: OAuthProviderConfig, clientId: string, redirectUri: string, state: string, scopes?: string[]): string
exchangeCode(config: OAuthProviderConfig, clientId: string, clientSecret: string | undefined, code: string, redirectUri: string, fetch: typeof globalThis.fetch): Promise<Tokens>
refreshTokens(config: OAuthProviderConfig, clientId: string, clientSecret: string | undefined, refreshToken: string, fetch: typeof globalThis.fetch): Promise<Tokens>
shouldRefresh(tokens: Tokens, now: Date): boolean
```

OAuth state nonce storage: Workers KV (hosted), in-memory Map (OSS single-node), or `oauth_states` table fallback. Store resulting credentials in `provider_connections`.

### Auth / claims domain

```typescript
resolveAuthContext(request: Request): Promise<AuthContext>
issueSession(userId: string, currentAccountId?: string): Promise<AuthSession>
revokeSession(sessionId: string): Promise<void>
refreshClaims(userId: string, accountId: string): Promise<Claim[]>
assertClaim(ctx: AuthContext, claim: Claim): void
linkGuestToUser(guestId: string, userId: string): Promise<void>
```

### Abuse prevention domain

```typescript
recordActionEvent(event: ActionEventInput): Promise<void>
evaluateAbuseRisk(input: AbuseRiskInput): Promise<AbuseDecision>
applyRateLimit(scope: RateLimitScope, key: string): Promise<{ ok: true } | { ok: false; retryAfterMs: number }>
updateAbuseSubject(subjectHash: string, decision: AbuseDecision): Promise<void>
```

### Queue domain

```typescript
canEnqueue(session: Session, guest: Guest, existingItems: QueueItem[], now: Date): { ok: true } | { ok: false; reason: string }
enforcePerGuestCap(items: QueueItem[], guestId: string, cap: number): boolean
dedupeQueue(items: QueueItem[]): QueueItem[]
applyModerationDecision(item: QueueItem, decision: 'approved' | 'rejected'): QueueItem
canSkip(session: Session, skipVotes: number, totalActiveGuests: number): boolean
```

### Plan / feature gates

```typescript
canStartSession(account: Account): boolean               // always true on OSS
effectiveGuestCap(account: Account, session: Session): number  // 12 on hosted free; Infinity on OSS
canUseCustomDomain(account: Account): boolean            // paid only
canDisableBranding(account: Account): boolean            // paid only
canUseZones(account: Account): boolean                   // paid only
canUseAnalytics(account: Account): boolean               // paid only
```

### Constants

```typescript
export const HOSTED_FREE_TIER_GUEST_CAP = 12;
export const DEFAULT_SONGS_PER_GUEST_CAP = 3;
export const SLOT_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min
export const SLOT_EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;    // 60s
export const SPOTIFY_SCOPES = ['user-read-playback-state', 'user-modify-playback-state'];
```

---

## Guest Identity & Slot System

### Client-side fingerprint (browser only — hash is all that reaches the server)

```typescript
async function buildFingerprintHash(): Promise<string> {
  const signals = [
    navigator.userAgent,
    `${screen.width}x${screen.height}`,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.language,
    navigator.hardwareConcurrency,
    await getCanvasFingerprint(),
    getWebGLRenderer(),
  ].join('|');

  const encoded = new TextEncoder().encode(signals);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

Server applies event-scoped salt before storing:
`storedHash = SHA-256(eventSlug + isoDate + clientHash)`

Raw signals never stored. Cannot track guests across events unless they explicitly log in and the application links `guests.user_id` for the current session. Even then, slot/cap enforcement should still use the session-scoped fingerprint hash to reduce account-switch abuse.

### Guest slot API

```
POST /api/v1/guest/identity
  Body:    { fingerprintHash: string, eventSlug: string }
  Returns: { slotToken: string, status: 'active' | 'queued' | 'priority_queued', queuePosition?: number }

  Logic:
    1. Compute storedHash = SHA-256(eventSlug + today + fingerprintHash)
    2. If storedHash exists in guest_slots → refresh heartbeat, return existing slot
    3. Check fingerprint_priority → if found, status = 'priority_queued'
    4. Count active slots vs guest_cap
       → Under cap: status = 'active', issue slotToken
       → At cap: status = 'queued', assign queue position

POST /api/v1/guest/heartbeat
  Headers: Authorization: Bearer {slotToken}
  Returns: { status: string, queuePosition?: number }
  Logic: Update last_heartbeat = NOW(); promote from queue if slots freed

GET /api/v1/guest/slot
  Headers: Authorization: Bearer {slotToken}
  Returns: { status, queuePosition, songs: QueueItem[] }
```

### Slot expiry background job

Hosted: run inside the `SessionRoom` Durable Object using alarms/timers while the session is active, with scheduled Worker fallback for recovery. OSS: run from the Node process every 60s.

```
FOR each guest_slot WHERE status = 'active' AND last_heartbeat < NOW() - 5 minutes:
  has_active_songs = EXISTS(
    SELECT 1 FROM queue_items
    WHERE session_id = slot.session_id
      AND guest_id = (guest linked to this slot)
      AND status IN ('pending', 'queued')
  )

  IF has_active_songs → SKIP (slot protected by active request)
  ELSE:
    INSERT INTO fingerprint_priority (fingerprint_hash, session_id)
    DELETE FROM guest_slots WHERE id = slot.id
    Promote next queued slot → active
```

---

## API Routes

All public HTTP routes must be versioned under `/api/v1`. Future breaking changes use `/api/v2` rather than changing existing contracts in place.

```
# Auth + claims
GET  /api/v1/auth/:provider/start         → redirect to login provider OAuth/OIDC
GET  /api/v1/auth/:provider/callback      → exchange code, upsert user/auth identity, set session cookie, redirect to app
POST /api/v1/auth/email/register          → create email/password account, send verification
POST /api/v1/auth/email/login             → login with email/password fallback
POST /api/v1/auth/email/verify            → verify email token
POST /api/v1/auth/password/reset/start    → start password reset without leaking account existence
POST /api/v1/auth/password/reset/finish   → finish password reset
GET  /api/v1/auth/me                      → current user, active account, claims, optional guest context
POST /api/v1/auth/switch-account          → switch active account and refresh claims
POST /api/v1/auth/logout                  → revoke current session

# Account membership / claims
GET  /api/v1/accounts                     → accounts for current user
GET  /api/v1/accounts/:accountId/members  → require account:manage_members
POST /api/v1/accounts/:accountId/members  → require account:manage_members
PATCH /api/v1/accounts/:accountId/members/:userId → update role/claims; require account:manage_members

# Sessions
POST   /api/v1/sessions                   → create session (host)
GET    /api/v1/sessions/:id               → session state + queue summary
PATCH  /api/v1/sessions/:id               → update settings (moderation, cap, vote-skip)
DELETE /api/v1/sessions/:id               → end session

# Queue
GET    /api/v1/sessions/:id/queue         → full queue (guest + host)
POST   /api/v1/sessions/:id/queue         → request a song (guest)
PATCH  /api/v1/sessions/:id/queue/:itemId → approve / reject / mark playing (host)
DELETE /api/v1/sessions/:id/queue/:itemId → remove own request (guest)

# Skip votes
POST /api/v1/sessions/:id/queue/:itemId/skip-vote   → cast skip vote (guest)

# Guest identity
POST /api/v1/guest/identity
POST /api/v1/guest/heartbeat
GET  /api/v1/guest/slot
POST /api/v1/guest/link-account           → link current logged-in user to current guest slot

# Logged-in guest account endpoints
GET  /api/v1/guest/me                     → requireAuth; request history/profile for logged-in guest
GET  /api/v1/guest/request-history        → requireAuth

# Provider / music-service connections
GET  /api/v1/provider/available                         → list available music providers
GET  /api/v1/provider/connections/:provider/start        → require provider:connect; redirect to music-provider OAuth
GET  /api/v1/provider/connections/:provider/callback     → complete music-provider OAuth and store provider_connections
POST /api/v1/provider/disconnect                         → require provider:connect
GET  /api/v1/provider/now-playing                        → current track + progress
GET  /api/v1/provider/search?q=...                       → track search (guest-facing; rate/risk limited)
GET  /api/v1/provider/zones                              → list zones (Soundtrack)

# Host settings + QR
GET  /api/v1/settings
PATCH /api/v1/settings
POST /api/v1/sessions/:id/qr              → generate QR → returns PNG or PDF

# Lyrics / karaoke
GET  /api/v1/lyrics/lookup                         → lookup lyrics for a track; rate limited and cache-backed
GET  /api/v1/sessions/:id/lyrics/current           → current track lyrics + active window
POST /api/v1/sessions/:id/lyrics/feedback          → record wrong lyrics / bad timing / missing lyrics feedback

# Realtime
GET  /api/v1/sessions/:id/realtime        → WebSocket upgrade; hosted routes to SessionRoom

# Abuse / safety
GET   /api/v1/sessions/:id/abuse/summary        → host; require queue:moderate
POST  /api/v1/sessions/:id/abuse/block-guest    → host; require queue:moderate
POST  /api/v1/sessions/:id/abuse/unblock-guest  → host; require queue:moderate

# Health
GET  /api/v1/health
```

---

## Routing and domains

Use subdomains for the hosted product. Do not mount the SPA and API under the marketing domain.

```
# Hosted
https://opendj.live/                 → Landing page / marketing site
https://app.opendj.live/             → Host dashboard SPA root
https://app.opendj.live/u/<slug>     → Guest request page
https://app.opendj.live/tv/<slug>    → TV display view
https://api.opendj.live/api/v1/*        → Cloudflare Worker API
https://api.opendj.live/api/v1/sessions/:id/realtime → WebSocket upgrade; hosted routes to SessionRoom

# Hosted OAuth callbacks
https://api.opendj.live/api/v1/auth/:provider/callback                    → login providers: google/apple/facebook
https://api.opendj.live/api/v1/provider/connections/:provider/callback    → music/service providers: spotify/soundtrack/etc.

# OSS
http://localhost:8888/               → Host dashboard from frontend template
http://localhost:8888/queue          → Guest request page
http://localhost:8888/api/v1/*          → Node server
http://localhost:8888/api/v1/sessions/:id/realtime → WebSocket upgrade
```

CORS/cookie rules:

- Hosted API should allow `https://app.opendj.live` as the first-class browser origin.
- Use secure, httpOnly cookies scoped so `app.opendj.live` can authenticate against `api.opendj.live`; set SameSite intentionally for the subdomain flow and never expose session tokens to JavaScript.
- Keep the marketing site independent from authenticated app state.
- The OSS app can use same-origin cookies on `localhost:8888`.
- Treat `/api/v1` as the stable public API prefix for the first release. Internal Worker/admin routes may live outside `/api/v1`, but browser/product routes must be versioned.
- Native Capacitor apps should call `https://api.opendj.live/api/v1/*` directly and handle auth through a platform auth adapter; do not rely on browser-only cookie behavior inside WebViews for privileged native flows.

---

## Feature set — complete list

### Guest experience
- Provider-agnostic language throughout (no "Spotify" in search bars or UI copy)
- Song search by name / artist
- Vibe chips for quick genre browsing
- Compact / comfortable density mode toggle
- Per-guest song cap enforced server-side (default 3, configurable by host)
- Post-request toast: "Added to queue" or "Submitted for review"
- **My Requests panel** (bottom sheet): queue position, ETA (cumulative song durations), per-request quota bar, remove own request CTA
- **Full queue overlay**: up to 10 upcoming songs + recently played section
- **Track detail sheet**: album art, title, artist, duration, "Open in Spotify / Apple Music / Tidal / YouTube" links, vote-to-skip CTA, remove own request
- **Now Playing widget**: live progress bar, vote-to-skip button with count display
- **Lyrics panel**: when available, show synced lyrics/current line; fallback to unsynced lyrics or no-lyrics state without blocking requests
- **Vote to skip**: per-song pill `>| 2 / 5`; host configures mode (Fixed count / % of guests / Host approval)
- Guest name capture: optional, presented on first scan, skipped on return visits
- Session states: Empty / Live / Cap reached / Session ended

### Guest accounts
- Welcome + connect screen: Spotify (prominent), Apple Music, Tidal, YouTube Music, Amazon Music, Google, Apple, Email/handle — plus "Continue as guest" at equal visual weight, always visible
- OAuth in-progress screen with provider branding
- Name picker post-connect: pre-filled from provider, optional emoji avatar
- Logged-in home: hamburger drawer with account card, current venue pill, nav (Home / Venues / Playlists / Liked Songs / Request History / Settings)
- Venues page: "Active now," "Open nearby" with guest count + join CTA, "Recently visited," "Join with code" entry
- Provider-grouped playlist browser: one tab per connected service
- Playlist detail: bulk "Add N to queue," per-track "+ Queue" toggle, overflow menu
- Add-to-playlist sheet: song preview, playlist search, "New playlist" row, multi-select checkboxes
- **Closeable ad** bottom sheet after each request (free tier only): request confirmation bar above it, ad unit with 3-second countdown, "Hosts on Pro hide ads" footnote

### Host experience

**Onboarding flow**
- Welcome screen with 4-step progress indicator
- Music service picker: Spotify (recommended), Apple Music, Tidal, SoundCloud (beta)
- OAuth in-progress with animated progress bar
- Connected confirmation + playback device selection list
- Error state: OAuth failed with retry CTA
- No-device warning: clear actionable error if host has no active playback device

**Dashboard — Desktop**
- Empty state with "+ New Session" CTA and connected service indicator
- Active state: split view — queue management left, pending review right
- Moderation chips (pill / banner / inline variants)
- Notifications bell: fly-out panel with filter chips (All / Unread / Skip votes), notification rows
- Now playing focus panel: enlarged album art, skip controls, live stats

**Dashboard — Mobile**
- Tabs: Now Playing / Pending Review / Settings
- Recently played strip on Now Playing tab

**Moderation**
- Auto-queue mode vs review mode toggle
- Per-request approve / reject controls
- Activity feed: "Song skipped by the room," approval history

**Host Settings (all sections)**
- Show requester name to guests (free) vs on TV display (PRO — separate toggles)
- Allow anonymous guests (toggle, default ON)
- Request cap + cooldown between requests
- Vote-to-skip mode + threshold config (free)
- Explicit mode radio: Fixed / Percentage / Host approval
- Danger zone (end session, clear queue)

**Session management**
- New session wizard: name the event, set zone count (if PRO), configure moderation before going live
- QR code download: PNG + PDF for printing
- QR share URL copy
- Session ended / recap state with "Start new session" CTA

**Lyrics / Karaoke**
- Live/TV view shows synced lyrics when available
- Host setting: show lyrics on TV view on/off
- Host can report wrong lyrics, bad timing, missing lyrics, or offensive/bad content
- Lyrics lookup/cache should run in the background after now-playing changes and should never block queue operations

**Host Library — PRO**
- Dedicated "Library" nav item
- Browse / search playlists by provider
- Playlist detail with per-track queue injection
- Play playlist modal: Play now / Replace queue (confirm) / Append / Auto-DJ seed when queue empty / Schedule by time (e.g. dinner playlist 6–8pm)
- Schedule picker: time window assignment

**Host Account + Billing**
- Profile page: connected service details, display name, logout
- Billing page: current plan, zone count, billing history
- Upgrade flow: zone count selector, price preview, payment step

**Branding Studio — PRO**
- Appearance tab: color pickers, logo upload, font picker, background style
- Templates tab: 6 presets (House Default / Wedding / Late Night / Cafe & Bistro / Sports Bar / Corporate) with mini phone previews
- Imagery tab: hero background, QR poster banner, TV backdrop
- Copy tab: venue name, headline prompt, vibe chip editor, welcome message
- Live phone preview pane (updates in real time)

**Zone Management — PRO**
- Zone overview grid (1 / 2 / 4 zone layouts)
- Per-zone card: listener count, queue depth, settings
- "Sync all zones" with confirmation dialog
- Zone detail: its own queue, per-zone settings (device, moderation mode, name, accent color)
- Billing row: 1 zone free; $35/zone/month after

**Analytics — PRO**
- Top requested tracks
- Request volume over time
- Skip rate
- Peak hours heatmap
- Free → paid funnel metrics (cap-hit events, conversion)

### Cross-platform app surfaces

**P0 web**
- Hosted SPA at `app.opendj.live`
- OSS demo frontend at `localhost:8888`
- Mobile-responsive guest and host flows
- Browser QR scan flow remains first-class; no app install required

**P2 native mobile via Capacitor**
- iOS and Android wrappers around the same Angular app shell
- Native share sheet for session links/QR codes
- Push notifications for host-only events such as re-auth needed, no active device, abuse protection interventions, or queue review backlog
- Deep links for joining sessions and completing OAuth/provider connection flows
- Optional QR scanning helper for hosts
- Secure native storage adapter for native auth tokens/session exchange
- Resume/focus snapshot refresh after app backgrounding

**P2/P3 desktop shell**
- Optional host/power-user shell only if it provides real value beyond the browser
- Must reuse the same Angular app shell and `/api/v1` backend
- Do not let desktop packaging delay the SaaS/web launch

### TV view (fullscreen 1920×1080)
- Large album art with color bloom effect
- Track name + artist
- "Requested by" attribution (respects host setting — free hides this, PRO shows it)
- Animated progress bar with elapsed / remaining time
- Lyrics/karaoke panel: active lyric line, previous/next context, unsynced fallback, and clean no-lyrics fallback
- Up next: 5 tracks with ETA
- QR card with join URL
- LIVE indicator + listener count + session duration + live clock
- Accent gradient from host's branding settings

---

## Music provider OAuth flow (server-side only)

Use one generic OAuth flow keyed by `provider_id` for music/service provider connections. Spotify is the first concrete music provider. This flow requires an authenticated user with `provider:connect` on the target account; login providers use the separate `/api/v1/auth/:provider/*` flow.

```
1. GET /api/v1/provider/connections/:provider/start
   → Require authenticated user with `provider:connect` for the selected account
   → Resolve OAuthProviderConfig for provider
   → Generate state nonce; store in Workers KV, in-memory OSS map, or oauth_states table with `flow_kind = 'connect-provider'`
   → Build authorize URL with provider scopes
   → 302 redirect to provider authorize URL

2. GET /api/v1/provider/connections/:provider/callback?code=...&state=...
   → Verify state nonce matches stored value
   → Re-load authenticated user/account context from state
   → Exchange code for access_token + refresh_token using fetch (no SDK)
   → Fetch provider profile/account identity when available
   → Upsert provider_connections row using (account_id, provider_id)
   → Redirect to https://app.opendj.live/settings/providers for hosted, or /settings/providers for OSS
```

Token refresh: hosted uses Queues + scheduled Workers; OSS uses a Node interval. Refresh jobs read from `provider_connections` by `provider_id` and `expires_at`.

**Critical:** If host has no active Spotify playback device, return `{ error: 'no_active_device' }` with a 400 — never silently accept a queue request that can't play. Surface this to the host immediately.

---

## OSS deploy story

The self-host experience must work exactly like this:

```bash
git clone https://github.com/viscoci/opendj
cd opendj/apps/oss-demo
cp .env.example .env    # fill SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, REDIRECT_URI
docker compose up
# → app on :8888, postgres on :5432, optional valkey on :6379
# Visit http://localhost:8888, log in with Spotify, share /queue URL with guests
```

### Required env vars

```
SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET
SPOTIFY_REDIRECT_URI          # default: http://localhost:8888/api/v1/provider/connections/spotify/callback
DATABASE_URL                  # default: postgres://postgres:postgres@localhost:5432/opendj
VALKEY_URL                    # optional; only needed for multi-container OSS realtime fan-out
MAX_SONGS_PER_GUEST           # default: 3
MAX_GUESTS_PER_SESSION        # default: unlimited
BASE_URL                      # default: http://localhost:8888
MODERATION_ENABLED_DEFAULT    # default: false
```

`ONBOARDING.md` must walk through the Spotify Developer Dashboard setup step by step — this is the only manual step for self-hosters. The public README should also explain that `opendj.live` is a commercial hosted implementation built on these packages, not the same application source code.

---

## Monetization tiers

**Free**
- 1 zone
- Vote-to-skip (all modes)
- Basic moderation
- Guest name capture
- Closeable ads shown to guests after each request

**OpenDJ Pro — $35/zone/month**
- Multi-zone
- Branding Studio (logo, colors, fonts, templates)
- Custom URL slug
- TV display requester attribution
- Advanced analytics
- Capacity > 50 guests
- White-label (no OpenDJ branding)
- Ads suppressed for guests
- Host library + playlist scheduling

**Paywall enforcement:** `effectiveGuestCap()` returns 12 for free plan. At the 13th unique fingerprint: return 402 with `{ error: 'guest_cap_reached', upgradeUrl: '...' }`. Log `action_events.event_kind = 'cap_hit'` in OSS; opendj-live may mirror this into private funnel analytics. Guests cannot tell whether the host is on free or paid.

---

## Brand system

- Name: **OpenDJ** (wordmark: lowercase `opendj`)
- Logo: audio-meter bars forming a W silhouette
- Fonts: **Syne** (display) + **Inter** (body) + **JetBrains Mono** (codes, session IDs)
- Colors: dark mode; accent gradient `#A855F7 → #EC4899`; 5 presets + custom picker
- Language rule: provider-agnostic everywhere — no "Spotify" in any guest-facing copy

---

## AGENTS.md to create inside `docs/` and package folders

Create `docs/AGENTS.md` in the public repo, plus smaller package-local `AGENTS.md` files where useful. Include these sections:
1. Explicit dependency graph overview — how `deps.ts`, provider registry, app factory, and runtime adapters fit together
2. Step-by-step: how to add a new streaming provider
3. Provider capability matrix (granular feature IDs, modular feature interfaces, and current provider support)
4. Provider API reference links:
   - Spotify Web API: https://developer.spotify.com/documentation/web-api
   - Soundtrack Your Brand GraphQL: https://api.soundtrackyourbrand.com/v2/docs
   - Apple MusicKit JS: https://developer.apple.com/documentation/musickitjs
5. Guest identity system: fingerprint construction, slot lifecycle, heartbeat, expiry sweep
6. Realtime room architecture: `RealtimeRoom`, `SessionRoom`, snapshots, events, and replay rules
7. Lyrics/karaoke architecture: LRCLIB adapter, cache rules, LRC parsing, feedback, and TV/live display fallback behavior
8. MCP/dev-agent guide: allowed tools, forbidden tools, and how to update OpenAPI/event contracts
8. Local dev setup: pointer to `ONBOARDING.md`

---

## What NOT to include in the OSS repo

The public `github.com/viscoci/opendj` repo must not include the private hosted product implementation. Keep these only in `github.com/viscoci/opendj-live`:

- Hosted Cloudflare deployment configuration for `opendj.live`, `app.opendj.live`, and `api.opendj.live`
- Billing webhook handlers and subscription provider secrets
- `subscriptions` and private hosted funnel/product analytics migrations
- Paid feature implementations: Branding Studio, hosted product analytics dashboards, white-label, paid zone management, ad suppression, billing UI
- Production dashboards, incident docs, internal board documents, escalations, standups
- Any `.env` files (`.env.example` only in public)
- MCP config files that expose local absolute paths, private tokens, or machine-specific commands

The public repo may include extension interfaces, feature-gate contracts, placeholder docs, and examples showing how a commercial implementation can extend the foundation. Do not include the full commercial implementation.

---

## Implementation priorities

| Priority | Work |
|---|---|
| P0 | `IStreamingProvider` base interface + modular provider feature interfaces + granular capability descriptors |
| P0 | `SpotifyProvider` implementing the interface using fetch (no SDK) |
| P0 | `StreamingRouter` + explicit provider registry wiring |
| P0 | Public package boundaries: `@opendj/core`, `@opendj/db`, `@opendj/auth`, `@opendj/backend`, `@opendj/realtime`, `@opendj/abuse`, `@opendj/sync`, `@opendj/lyrics`, `@opendj/frontend`, `@opendj/frontend-template`, `@opendj/app-shell` |
| P0 | Database schema + Drizzle setup + migrations, including `users`, `auth_identities`, `auth_sessions`, `account_memberships`, generic `provider_connections`, `oauth_states`, `action_events`, and `abuse_subjects` |
| P0 | Realtime room abstraction: `RealtimeRoom`, `SessionSnapshot`, `SessionEvent`, `SessionCommand` |
| P0 | Song synchronization primitives: `@opendj/sync`, `PlaybackClockSample`, normalized progress helpers, and `SongSyncAdapter` contracts |
| P0 | Lyrics/karaoke foundation: `@opendj/lyrics`, LRCLIB fetch adapter, LRC parser, lyrics cache, current-lyrics snapshot/event wiring, and feedback capture |
| P0 | Hosted layer baseline in private `opendj-live`: Workers + Hyperdrive + Durable Objects + Queues |
| P0 | Hosted subdomain routing and API versioning: `opendj.live`, `app.opendj.live`, `api.opendj.live/api/v1/*` |
| P0 | Hosted Durable Object `SessionRoom` for per-session WebSocket fan-out, hot snapshots, guest slots, and serialized queue mutations |
| P0 | OSS `NodeSessionRoom` in-process realtime implementation |
| P0 | Auth and claims layer: OAuth/OIDC login providers, email/password fallback, session cookies, claim middleware, account membership, logged-in guest support |
| P0 | Abuse prevention foundation: action signal capture, rolling-window rate limits, risk scoring, host block/unblock, and realtime room enforcement |
| P0 | Core queue logic: `canEnqueue`, `enforcePerGuestCap`, `dedupeQueue`, `canSkip` |
| P0 | Generic music-provider OAuth routes with Spotify as first implementation |
| P0 | Guest identity API + slot schema + expiry job |
| P0 | Angular 21 OSS frontend template guest request page, built with Capacitor-compatible routing/layout assumptions but shipped as web first (all free-tier states: empty, results, requested, my-requests, queue, track-detail, cap, expired) |
| P0 | Angular 21 OSS frontend template host dashboard, built with responsive/mobile-first patterns but shipped as web first (desktop + mobile, free-tier/basic functionality) |
| P0 | Docker Compose OSS demo deploy + smoke test in CI |
| P1 | Vote-to-skip (all three modes) |
| P1 | Host onboarding flow (including no-device warning + OAuth error states) |
| P1 | Soundtrack provider |
| P1 | QR code generation (PNG + PDF) |
| P1 | TV fullscreen view with lyrics/karaoke display when synced lyrics are available |
| P1 | Host settings (all sections) |
| P1 | Session creation wizard |
| P1 | Host account + billing pages |
| P1 | Upgrade flow |
| P1 | Logged-in guest account UX: account link, profile, request history, provider connections; playlist browser/venues can remain incremental |
| P2 | Branding Studio |
| P2 | Zone management |
| P2 | Host library + playlist scheduling |
| P2 | Analytics dashboard |
| P2 | Capacitor iOS/Android app shell in `opendj-live/apps/mobile`, consuming the same Angular app shell and `/api/v1` backend |
| P2 | Desktop shell experiment only if native mobile proves useful; prefer Capacitor community Electron or a separate Tauri wrapper after evaluating maintenance cost |
| P2 | `packages/agent-tools` MCP server and repo map tools; dev-only and non-blocking |

---

## Model recommendation

Use a top-tier reasoning/code model for the provider abstraction layer, explicit dependency graph, realtime room abstraction, Durable Object `SessionRoom`, and guest slot system. A cheaper/faster coding model is appropriate for route handlers, Angular components, tests, and boilerplate. Always provide the agent with `AGENTS.md`, OpenAPI output, database schema, and event contracts before asking it to generate code.
