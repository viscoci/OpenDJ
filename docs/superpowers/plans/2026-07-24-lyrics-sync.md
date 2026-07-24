# Lyrics Sync End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guest phones and the TV view show karaoke-style synced lyrics for the currently playing track — active line highlighted in time — implementing sub-project 1 of `docs/superpowers/specs/2026-07-24-lyrics-sync-and-demo-deploy-design.md`, released as `@opendj/*@0.2.0`.

**Architecture:** Backend broadcasts state, clients compute presentation. `NowPlayingPoller` (existing 2.5s Spotify poll) gains two publishes: `playback.clock_sampled` each tick and `lyrics.loaded` on track change (via the existing cache-fronted `LyricsLookupService`). A new framework-free `LyricsEngine` in `@opendj/frontend` consumes those events plus the initial snapshot, runs a local prediction loop (`predictPlaybackPosition`), and emits display state. Angular components in `frontend-template` render it (TV karaoke panel + guest live card). `SessionSnapshot.activeLyricsWindow` stays server-side empty by design.

**Tech Stack:** TypeScript strict ESM, Vitest, Angular 21 signals (template package only — `@opendj/frontend` stays Angular-free), existing `@opendj/sync` + `@opendj/lyrics` primitives.

## Global Constraints

- Commits: Conventional Commits + DCO — always `git commit -s`. Prettier pre-commit; run `pnpm exec prettier --write <files>` before committing. Never `--no-verify`.
- Any change under `packages/*` needs changeset coverage by PR time (Task 8 adds one changeset covering all touched packages — individual tasks do NOT add changesets).
- `@opendj/frontend` must remain framework-free (no `@angular/*` imports). Angular code goes in `packages/frontend-template` only.
- Cross-package type imports resolve against built `dist/` — after adding the new deps in Task 5, run `pnpm turbo run build --filter=@opendj/sync --filter=@opendj/lyrics` before typechecking/testing `@opendj/frontend` directly (turbo-driven runs order this automatically via `dependsOn: ^build`).
- Lyrics failures must NEVER affect playback/queue behavior (spec §4).
- No high-frequency progress broadcast: clock samples at poll cadence only; highlighting interpolated client-side (spec §3).
- Existing signatures you consume (do not re-implement): `createPlaybackClockSample(track: NowPlayingTrack, sampledAtEpochMs: number): PlaybackClockSample` and `predictPlaybackPosition(sample: PlaybackClockSample, nowEpochMs: number): PredictedPlaybackPosition` from `@opendj/sync`; `LyricsDocument` (fields incl. `isSynced`, `lines: LyricsLine[]` with `startsAtMs?`/`endsAtMs?`, `plainText?`) and `LyricsLine` from `@opendj/lyrics`; `SessionEvent` variants `{ type: 'playback.clock_sampled'; sample }` and `{ type: 'lyrics.loaded'; trackUri; lyrics }` from `@opendj/realtime` (already defined, already reduced into snapshots by `applyEvent`).
- Work on branch `feat/lyrics-sync` cut from up-to-date `main`; merge via PR.

---

### Task 1: Poller publishes `playback.clock_sampled`

**Files:**

- Modify: `packages/backend/src/realtime/NowPlayingPoller.ts`
- Test: `packages/backend/tests/realtime/NowPlayingPoller.lyrics.test.ts` (new file; REUSE the fake/harness setup from the existing `packages/backend/tests/realtime/NowPlayingPoller.test.ts` — read it first and mirror how it constructs the poller, fake repos, fake provider, and fake room manager)

**Interfaces:**

- Consumes: `createPlaybackClockSample` from `@opendj/sync` (already a backend dependency).
- Produces: `NowPlayingPollerOptions.nowEpochMs?: () => number` (default `Date.now`); each successful tick with a non-null now-playing publishes `{ type: 'playback.clock_sampled', sample }` where `sample = createPlaybackClockSample(next, nowEpochMs())`. Task 2 builds on the same file.

- [ ] **Step 1: Write the failing test**

In the new test file (adapt fake construction to the existing harness — the assertions below are the contract):

```ts
import { describe, expect, it } from 'vitest';
// ...same harness imports as NowPlayingPoller.test.ts...

describe('NowPlayingPoller clock sampling', () => {
  it('publishes playback.clock_sampled with a sample built from now-playing on each tick', async () => {
    // harness: fake provider returns a NowPlayingTrack
    //   { uri: 'spotify:track:aaa', name: 'A', artist: 'B', albumArt: null,
    //     durationMs: 200_000, progressMs: 10_000, isPlaying: true, zoneId: 'default' }
    // poller options: { nowEpochMs: () => 1_000_000 }
    // run one tick (however the existing tests trigger ticks)
    const clockEvents = publishedEvents.filter((e) => e.type === 'playback.clock_sampled');
    expect(clockEvents).toHaveLength(1);
    const sample = (clockEvents[0] as { sample: PlaybackClockSample }).sample;
    expect(sample.trackUri).toBe('spotify:track:aaa');
    expect(sample.progressMs).toBe(10_000);
    expect(sample.isPlaying).toBe(true);
    expect(sample.sampledAtEpochMs).toBe(1_000_000);
  });

  it('does not publish a clock sample when nothing is playing', async () => {
    // fake provider returns null from getNowPlaying()
    const clockEvents = publishedEvents.filter((e) => e.type === 'playback.clock_sampled');
    expect(clockEvents).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @opendj/backend exec vitest run tests/realtime/NowPlayingPoller.lyrics.test.ts`
Expected: FAIL — 0 clock events published.

- [ ] **Step 3: Implement**

In `NowPlayingPoller.ts`:

- Add to `NowPlayingPollerOptions`: `/** Injectable clock for tests. Default Date.now. */ nowEpochMs?: () => number;` and store `private readonly nowEpochMs: () => number` (constructor: `options.nowEpochMs ?? Date.now`).
- Add import: `import { createPlaybackClockSample } from '@opendj/sync';`
- In `tick()`, immediately after the `shouldPublish` block (after line `await room.publish({ type: 'now_playing.updated', track: next });` and its closing brace), add:

```ts
// Sync layer: broadcast a clock sample each tick so clients can
// interpolate playback position locally (spec: no high-frequency
// progress broadcasts — samples at poll cadence only).
if (next) {
  await room.publish({
    type: 'playback.clock_sampled',
    sample: createPlaybackClockSample(next, this.nowEpochMs()),
  });
}
```

- Replace the two `Date.now()` calls inside `reconcileQueue`/tick paths ONLY if trivial — otherwise leave them; the injected clock is required only for the new publishes.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @opendj/backend exec vitest run tests/realtime/NowPlayingPoller.lyrics.test.ts tests/realtime/NowPlayingPoller.test.ts`
Expected: new tests PASS, existing poller tests still PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/backend/src/realtime/NowPlayingPoller.ts packages/backend/tests/realtime/NowPlayingPoller.lyrics.test.ts
git add packages/backend/src/realtime/NowPlayingPoller.ts packages/backend/tests/realtime/NowPlayingPoller.lyrics.test.ts
git commit -s -m "feat(backend): broadcast playback clock samples from now-playing poller"
```

---

### Task 2: Poller triggers lyrics lookup on track change

**Files:**

- Modify: `packages/backend/src/realtime/NowPlayingPoller.ts`
- Modify: `packages/backend/src/app.ts` (wire the dep — `LyricsLookupService` is already constructed there for the lyrics routes; find where `NowPlayingPoller` is constructed and pass the same instance)
- Test: `packages/backend/tests/realtime/NowPlayingPoller.lyrics.test.ts` (extend)

**Interfaces:**

- Consumes: Task 1's file state; `LyricsLookupService.lookup(input: { trackName; artistName; albumName?; durationMs?; providerTrackUri?; isrc? }): Promise<LyricsDocument | null>`.
- Produces: `NowPlayingPollerDeps.lyricsLookup?: { lookup(input: { trackName: string; artistName: string; durationMs?: number | null; providerTrackUri?: string }): Promise<LyricsDocument | null> }` (narrow structural type — tests pass a plain object). On track-URI change the poller fires a non-blocking lookup and publishes `{ type: 'lyrics.loaded', trackUri, lyrics }` (lyrics `null` on no-match/failure), guarded against out-of-order completion.

- [ ] **Step 1: Write the failing tests** (append to the Task 1 test file)

```ts
describe('NowPlayingPoller lyrics wiring', () => {
  it('looks up lyrics on track change and publishes lyrics.loaded', async () => {
    // fake lyricsLookup: records calls, resolves a LyricsDocument
    // tick once with track aaa → flush microtasks (await vi.waitFor or setTimeout(0))
    expect(lookupCalls).toEqual([
      {
        trackName: 'A',
        artistName: 'B',
        durationMs: 200_000,
        providerTrackUri: 'spotify:track:aaa',
      },
    ]);
    const loaded = publishedEvents.filter((e) => e.type === 'lyrics.loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ trackUri: 'spotify:track:aaa' });
    expect((loaded[0] as { lyrics: unknown }).lyrics).not.toBeNull();
  });

  it('does not re-lookup for the same track on subsequent ticks', async () => {
    // two ticks, same track uri → exactly one lookup call, one lyrics.loaded
  });

  it('publishes lyrics.loaded with null lyrics when lookup rejects', async () => {
    // fake lyricsLookup rejects → lyrics.loaded fires with lyrics: null; tick does not throw
  });

  it('suppresses a stale lookup result after the track changed again', async () => {
    // lookup for aaa resolves only AFTER a tick moved now-playing to bbb;
    // room snapshot now reports bbb → no lyrics.loaded for aaa is published
    // (only bbb's, when its lookup resolves)
  });
});
```

- [ ] **Step 2: Run to verify failure** (same vitest command as Task 1) — FAIL: no `lyricsLookup` dep exists.

- [ ] **Step 3: Implement**

In `NowPlayingPoller.ts`:

- Add to `NowPlayingPollerDeps`:

```ts
  /**
   * When supplied, the poller fires a cache-fronted lyrics lookup on every
   * track change and publishes `lyrics.loaded` (null lyrics on miss/failure).
   * Failures never affect playback or queue behavior.
   */
  lyricsLookup?: {
    lookup(input: {
      trackName: string;
      artistName: string;
      durationMs?: number | null;
      providerTrackUri?: string;
    }): Promise<LyricsDocument | null>;
  };
```

with `import type { LyricsDocument } from '@opendj/lyrics';`

- Add `lastLyricsUri: string | null` to `PerSession` (init `null` in `start()`, no cleanup needed beyond `tearDown`'s delete).
- In `tick()`, after the clock-sample publish from Task 1, add:

```ts
// Lyrics: on track change, fire a non-blocking lookup and publish the
// result. Guard against out-of-order completion by re-checking the
// room's CURRENT now-playing before publishing.
if (this.deps.lyricsLookup && next && next.uri !== entry.lastLyricsUri) {
  entry.lastLyricsUri = next.uri;
  const lookupUri = next.uri;
  void this.deps.lyricsLookup
    .lookup({
      trackName: next.name,
      artistName: next.artist,
      durationMs: next.durationMs,
      providerTrackUri: next.uri,
    })
    .catch(() => null)
    .then(async (lyrics) => {
      const currentRoom = this.deps.roomManager.forSession(sessionId);
      if (!currentRoom) return;
      const current = await currentRoom.getSnapshot();
      if (current.nowPlaying?.uri !== lookupUri) return; // stale result
      await currentRoom.publish({ type: 'lyrics.loaded', trackUri: lookupUri, lyrics });
    })
    .catch(() => {
      /* publish failed (room torn down) — lyrics never block playback */
    });
}
```

In `app.ts`: locate where `LyricsLookupService` is instantiated for the lyrics routes and where `new NowPlayingPoller({...})` is constructed; pass `lyricsLookup: <that instance>` into the poller deps. If the poller is constructed before the service, reorder the construction — both are plain objects with no circular deps.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @opendj/backend exec vitest run tests/realtime/` then the full backend suite `pnpm turbo run test --filter=@opendj/backend`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/backend/src/realtime/NowPlayingPoller.ts packages/backend/src/app.ts packages/backend/tests/realtime/NowPlayingPoller.lyrics.test.ts
git add packages/backend/src/realtime/NowPlayingPoller.ts packages/backend/src/app.ts packages/backend/tests/realtime/NowPlayingPoller.lyrics.test.ts
git commit -s -m "feat(backend): publish lyrics.loaded on track change via cached lookup"
```

---

### Task 3: Snapshot doc comment — `activeLyricsWindow` is client-computed

**Files:**

- Modify: `packages/realtime/src/types/snapshot.ts` (doc comment only)

**Interfaces:** none — documentation task folded in ahead of the frontend work.

- [ ] **Step 1: Edit the doc comment** on the `activeLyricsWindow` field to:

```ts
/**
 * Client-computed; the server never populates this (kept empty by design).
 * Clients derive the active window from `lyrics` + `playbackClock` using
 * `predictPlaybackPosition` locally — see the LyricsEngine in @opendj/frontend.
 */
```

- [ ] **Step 2: Verify + commit**

Run: `pnpm turbo run typecheck test --filter=@opendj/realtime` → green.

```bash
pnpm exec prettier --write packages/realtime/src/types/snapshot.ts
git add packages/realtime/src/types/snapshot.ts
git commit -s -m "docs(realtime): mark activeLyricsWindow as client-computed"
```

---

### Task 4: Fix the `LyricsApi` client to the real backend contract

**Files:**

- Modify: `packages/frontend/src/api/lyrics.ts`
- Modify: `packages/frontend/src/api/types.ts` (replace the stale `LyricsResponse` shape)
- Test: `packages/frontend/tests/api/lyrics.test.ts` (new; mirror the fake-HttpClient pattern used by the other `packages/frontend/tests/api/*.test.ts` files)

**Interfaces:**

- Consumes: backend route `GET /api/v1/lyrics/lookup` — validated query requires `trackName` + `artistName`, optional `albumName`, `durationMs`, `trackUri`; responds `{ match: LyricsDocument | null }` (verify exact optional-param names against `packages/backend/src/routes/lyrics.ts:22-28` while implementing; the required pair and response shape are confirmed).
- Produces: `LyricsApi.lookup(input: { trackName: string; artistName: string; albumName?: string; durationMs?: number; trackUri?: string }): Promise<LyricsDocument | null>`; `feedback(...)` unchanged. Task 7 uses `lookup` for guest first-paint.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { LyricsApi } from '../../src/api/lyrics.js';

describe('LyricsApi.lookup', () => {
  it('queries by trackName/artistName and unwraps the match field', async () => {
    const calls: Array<{ path: string; query: unknown }> = [];
    const doc = { id: 'x', source: 'lrclib', isSynced: true, lines: [] };
    const http = {
      request: (path: string, opts: { query?: unknown }) => {
        calls.push({ path, query: opts?.query });
        return Promise.resolve({ match: doc });
      },
    };
    const api = new LyricsApi(http as never);
    const res = await api.lookup({ trackName: 'A', artistName: 'B', durationMs: 200000 });
    expect(calls[0]!.path).toBe('/api/v1/lyrics/lookup');
    expect(calls[0]!.query).toMatchObject({ trackName: 'A', artistName: 'B', durationMs: 200000 });
    expect(res).toBe(doc);
  });

  it('returns null when the backend reports no match', async () => {
    const http = { request: () => Promise.resolve({ match: null }) };
    const api = new LyricsApi(http as never);
    expect(await api.lookup({ trackName: 'A', artistName: 'B' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @opendj/frontend exec vitest run tests/api/lyrics.test.ts`
Expected: FAIL — `lookup` doesn't exist (only stale `lookupByTrackUri`).

- [ ] **Step 3: Implement**

Replace `lookupByTrackUri` in `lyrics.ts` with:

```ts
  /** Cache-fronted lookup. Mirrors GET /api/v1/lyrics/lookup. */
  lookup(input: {
    trackName: string;
    artistName: string;
    albumName?: string;
    durationMs?: number;
    trackUri?: string;
  }): Promise<LyricsDocument | null> {
    return this.http
      .request<{ match: LyricsDocument | null }>('/api/v1/lyrics/lookup', { query: { ...input } })
      .then((r) => r.match);
  }
```

with `import type { LyricsDocument } from '@opendj/lyrics';` — and delete the stale `LyricsResponse` from `types.ts` (grep for other usages first; update or delete them). Add `@opendj/lyrics: workspace:*` to `packages/frontend/package.json` dependencies (part of this task since the type import needs it) and run `pnpm install`.

- [ ] **Step 4: Run tests**

Run: `pnpm turbo run typecheck test --filter=@opendj/frontend`
Expected: PASS (turbo builds `@opendj/lyrics` first).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/frontend/src/api/lyrics.ts packages/frontend/src/api/types.ts packages/frontend/tests/api/lyrics.test.ts packages/frontend/package.json
git add packages/frontend/src/api/lyrics.ts packages/frontend/src/api/types.ts packages/frontend/tests/api/lyrics.test.ts packages/frontend/package.json pnpm-lock.yaml
git commit -s -m "fix(frontend): align LyricsApi with the real lookup contract"
```

---

### Task 5: `LyricsEngine` in `@opendj/frontend`

**Files:**

- Create: `packages/frontend/src/lyrics/LyricsEngine.ts`
- Modify: `packages/frontend/src/index.ts` (export it), `packages/frontend/package.json` (add `@opendj/sync: workspace:*`)
- Test: `packages/frontend/tests/lyrics/LyricsEngine.test.ts`

**Interfaces:**

- Consumes: `predictPlaybackPosition`, `PlaybackClockSample` from `@opendj/sync`; `LyricsDocument`, `LyricsLine` from `@opendj/lyrics`; `SessionEvent`, `SessionSnapshot` from `@opendj/realtime`.
- Produces (Tasks 6-7 depend on these exact names):

```ts
export type LyricsMode = 'loading' | 'synced' | 'unsynced' | 'none' | 'paused';
export interface LyricsEngineState {
  mode: LyricsMode;
  trackUri: string | null;
  activeLine: LyricsLine | null;
  prevLines: LyricsLine[]; // up to prevCount, oldest first
  nextLines: LyricsLine[]; // up to nextCount, soonest first
  plainText: string | null; // set in 'unsynced' mode
  normalizedProgress: number; // 0..1
}
export class LyricsEngine {
  constructor(opts?: { nowEpochMs?: () => number; prevCount?: number; nextCount?: number }); // defaults: Date.now, 2, 2
  applySnapshot(snapshot: Pick<SessionSnapshot, 'lyrics' | 'playbackClock' | 'nowPlaying'>): void;
  applyEvent(event: SessionEvent): void; // handles lyrics.loaded, playback.clock_sampled, now_playing.updated; ignores others
  computeState(): LyricsEngineState; // pure w.r.t. injected clock — call on your own cadence (rAF/interval)
}
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { LyricsEngine } from '../../src/lyrics/LyricsEngine.js';
import type { LyricsDocument } from '@opendj/lyrics';

const doc = (over: Partial<LyricsDocument> = {}): LyricsDocument => ({
  id: 'd1',
  source: 'lrclib',
  trackName: 'A',
  artistName: 'B',
  isSynced: true,
  matchConfidence: 'high',
  lines: [
    { id: 'l1', text: 'line one', startsAtMs: 0, endsAtMs: 5000 },
    { id: 'l2', text: 'line two', startsAtMs: 5000, endsAtMs: 10000 },
    { id: 'l3', text: 'line three', startsAtMs: 10000, endsAtMs: 15000 },
    { id: 'l4', text: 'line four', startsAtMs: 15000 },
  ],
  ...over,
});
const sample = (progressMs: number, isPlaying = true, sampledAtEpochMs = 1_000_000) => ({
  providerId: 'spotify',
  trackUri: 'spotify:track:aaa',
  durationMs: 200_000,
  progressMs,
  isPlaying,
  sampledAtEpochMs,
  confidence: 'high' as const,
});

function engineAt(nowMs: number) {
  return new LyricsEngine({ nowEpochMs: () => nowMs });
}

describe('LyricsEngine', () => {
  it('is loading before lyrics arrive for the playing track', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    expect(e.computeState().mode).toBe('loading');
  });

  it('highlights the active line and windows prev/next in synced mode', () => {
    const e = engineAt(1_002_000); // sample: progress 6000 at t=1_000_000; now +2s => predicted 8000
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(6000) });
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:aaa', lyrics: doc() });
    const s = e.computeState();
    expect(s.mode).toBe('synced');
    expect(s.activeLine?.id).toBe('l2'); // predicted 8000ms ∈ [5000,10000)
    expect(s.prevLines.map((l) => l.id)).toEqual(['l1']);
    expect(s.nextLines.map((l) => l.id)).toEqual(['l3', 'l4']);
  });

  it('does not advance while paused and reports paused mode', () => {
    const e = engineAt(1_050_000); // 50s later — but paused
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(6000, false) });
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:aaa', lyrics: doc() });
    const s = e.computeState();
    expect(s.mode).toBe('paused');
    expect(s.activeLine?.id).toBe('l2'); // frozen at 6000ms
  });

  it('reports unsynced mode with plainText when the doc is not synced', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    e.applyEvent({
      type: 'lyrics.loaded',
      trackUri: 'spotify:track:aaa',
      lyrics: doc({ isSynced: false, lines: [], plainText: 'all the words' }),
    });
    const s = e.computeState();
    expect(s.mode).toBe('unsynced');
    expect(s.plainText).toBe('all the words');
  });

  it('reports none when lyrics.loaded carried null', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:aaa', lyrics: null });
    expect(e.computeState().mode).toBe('none');
  });

  it('drops lyrics for a different track and returns to loading on track change', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:zzz', lyrics: doc() });
    expect(e.computeState().mode).toBe('loading'); // zzz lyrics ignored for aaa
  });

  it('seeds from an initial snapshot', () => {
    const e = engineAt(1_001_000);
    e.applySnapshot({
      nowPlaying: {
        uri: 'spotify:track:aaa',
        name: 'A',
        artist: 'B',
        albumArt: null,
        durationMs: 200_000,
        progressMs: 6000,
        isPlaying: true,
        zoneId: 'z',
      },
      playbackClock: sample(6000),
      lyrics: doc(),
    });
    expect(e.computeState().mode).toBe('synced');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @opendj/frontend exec vitest run tests/lyrics/LyricsEngine.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `LyricsEngine.ts`**

```ts
/**
 * LyricsEngine — framework-free lyric display state.
 *
 * Feed it realtime events (or the initial snapshot); poll `computeState()` on
 * your own cadence (rAF / interval). It interpolates playback position locally
 * from the latest `playback.clock_sampled` via `predictPlaybackPosition` —
 * the server intentionally never streams per-line ticks.
 */
import { predictPlaybackPosition, type PlaybackClockSample } from '@opendj/sync';
import type { LyricsDocument, LyricsLine } from '@opendj/lyrics';
import type { SessionEvent, SessionSnapshot } from '@opendj/realtime';

export type LyricsMode = 'loading' | 'synced' | 'unsynced' | 'none' | 'paused';

export interface LyricsEngineState {
  mode: LyricsMode;
  trackUri: string | null;
  activeLine: LyricsLine | null;
  prevLines: LyricsLine[];
  nextLines: LyricsLine[];
  plainText: string | null;
  normalizedProgress: number;
}

const EMPTY: LyricsEngineState = {
  mode: 'loading',
  trackUri: null,
  activeLine: null,
  prevLines: [],
  nextLines: [],
  plainText: null,
  normalizedProgress: 0,
};

export class LyricsEngine {
  private readonly nowEpochMs: () => number;
  private readonly prevCount: number;
  private readonly nextCount: number;
  private sample: PlaybackClockSample | null = null;
  /** undefined = not looked up yet (loading); null = looked up, no match. */
  private lyricsByUri: { uri: string; doc: LyricsDocument | null } | undefined;

  constructor(opts: { nowEpochMs?: () => number; prevCount?: number; nextCount?: number } = {}) {
    this.nowEpochMs = opts.nowEpochMs ?? Date.now;
    this.prevCount = opts.prevCount ?? 2;
    this.nextCount = opts.nextCount ?? 2;
  }

  applySnapshot(s: Pick<SessionSnapshot, 'lyrics' | 'playbackClock' | 'nowPlaying'>): void {
    if (s.playbackClock) this.sample = s.playbackClock;
    if (s.nowPlaying && s.lyrics !== undefined && s.lyrics !== null) {
      this.lyricsByUri = { uri: s.nowPlaying.uri, doc: s.lyrics };
    }
  }

  applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'playback.clock_sampled': {
        const prevUri = this.sample?.trackUri;
        this.sample = event.sample;
        // Track changed: stale lyrics no longer apply.
        if (prevUri && prevUri !== event.sample.trackUri) {
          if (this.lyricsByUri && this.lyricsByUri.uri !== event.sample.trackUri) {
            this.lyricsByUri = undefined;
          }
        }
        break;
      }
      case 'lyrics.loaded':
        // Only adopt lyrics for the track we're currently clocking (or if we
        // have no clock yet, adopt optimistically — the next sample confirms).
        if (!this.sample || this.sample.trackUri === event.trackUri) {
          this.lyricsByUri = { uri: event.trackUri, doc: event.lyrics };
        }
        break;
      case 'now_playing.updated':
        if (event.track === null) {
          this.sample = null;
          this.lyricsByUri = undefined;
        }
        break;
      default:
        break;
    }
  }

  computeState(): LyricsEngineState {
    if (!this.sample) return EMPTY;
    const pos = predictPlaybackPosition(this.sample, this.nowEpochMs());
    const base: Omit<
      LyricsEngineState,
      'mode' | 'activeLine' | 'prevLines' | 'nextLines' | 'plainText'
    > = {
      trackUri: this.sample.trackUri,
      normalizedProgress: pos.normalizedProgress,
    };
    const lyricsEntry =
      this.lyricsByUri && this.lyricsByUri.uri === this.sample.trackUri
        ? this.lyricsByUri
        : undefined;

    if (lyricsEntry === undefined) {
      return { ...EMPTY, ...base, mode: 'loading' };
    }
    if (lyricsEntry.doc === null) {
      return { ...EMPTY, ...base, mode: 'none' };
    }
    const doc = lyricsEntry.doc;
    const timed = doc.lines.filter(
      (l): l is LyricsLine & { startsAtMs: number } => typeof l.startsAtMs === 'number',
    );
    if (!doc.isSynced || timed.length === 0) {
      return {
        ...EMPTY,
        ...base,
        mode: this.sample.isPlaying ? 'unsynced' : 'paused',
        plainText: doc.plainText ?? doc.lines.map((l) => l.text).join('\n'),
      };
    }
    // Active = last timed line whose start is <= predicted progress.
    let activeIdx = -1;
    for (let i = 0; i < timed.length; i += 1) {
      if (timed[i]!.startsAtMs <= pos.progressMs) activeIdx = i;
      else break;
    }
    const activeLine = activeIdx >= 0 ? timed[activeIdx]! : null;
    const prevLines =
      activeIdx > 0 ? timed.slice(Math.max(0, activeIdx - this.prevCount), activeIdx) : [];
    const nextLines = timed.slice(activeIdx + 1, activeIdx + 1 + this.nextCount);
    return {
      ...base,
      mode: this.sample.isPlaying ? 'synced' : 'paused',
      activeLine,
      prevLines,
      nextLines,
      plainText: null,
    };
  }
}
```

Add `@opendj/sync: workspace:*` to `packages/frontend/package.json` dependencies, `pnpm install`, and export from `packages/frontend/src/index.ts`: `export { LyricsEngine, type LyricsEngineState, type LyricsMode } from './lyrics/LyricsEngine.js';`

- [ ] **Step 4: Run tests**

Run: `pnpm turbo run typecheck test --filter=@opendj/frontend`
Expected: all PASS. Note the paused test expects `mode: 'paused'` for a synced doc while `isPlaying === false` — verify the implementation returns 'paused' in both synced and unsynced branches when not playing (it does: synced branch uses the ternary; unsynced branch too).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/frontend/src/lyrics/LyricsEngine.ts packages/frontend/src/index.ts packages/frontend/package.json packages/frontend/tests/lyrics/LyricsEngine.test.ts
git add packages/frontend/src packages/frontend/tests packages/frontend/package.json pnpm-lock.yaml
git commit -s -m "feat(frontend): add framework-free LyricsEngine for karaoke display state"
```

---

### Task 6: TV karaoke panel

**Files:**

- Create: `packages/frontend-template/src/app/components/lyrics-panel.component.ts`
- Modify: `packages/frontend-template/src/app/pages/tv.page.ts`
- Modify: `packages/frontend-template/package.json` (add `@opendj/lyrics: workspace:*`, `@opendj/sync: workspace:*` — needed for types)

**Interfaces:**

- Consumes: `LyricsEngine`/`LyricsEngineState` from `@opendj/frontend` (Task 5); `RealtimeClient.onEvent`/`onSnapshot` (existing); TV page structure at `packages/frontend-template/src/app/pages/tv.page.ts` (snapshot + event wiring already in `openRealtime()`).
- Produces: `<app-lyrics-panel [state]="lyricsState()" variant="tv" />` — a presentational component; the page owns the engine + 250ms recompute interval.

- [ ] **Step 1: Create the component** (presentational only — trivial logic, no unit test; the engine carries the tested logic):

```ts
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import type { LyricsEngineState } from '@opendj/frontend';

/** Karaoke lyric display. Pure presentation of a LyricsEngineState. */
@Component({
  selector: 'app-lyrics-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state; as s) {
      @switch (s.mode) {
        @case ('synced') {
          <div class="lyrics" [class.tv]="variant === 'tv'">
            @for (line of s.prevLines; track line.id) {
              <p class="line prev">{{ line.text }}</p>
            }
            @if (s.activeLine) {
              <p class="line active">{{ s.activeLine.text }}</p>
            } @else {
              <p class="line active dim">♪</p>
            }
            @for (line of s.nextLines; track line.id) {
              <p class="line next">{{ line.text }}</p>
            }
          </div>
        }
        @case ('paused') {
          <div class="lyrics" [class.tv]="variant === 'tv'">
            @if (s.activeLine) {
              <p class="line active paused">{{ s.activeLine.text }}</p>
            }
            <p class="line hint">Paused</p>
          </div>
        }
        @case ('unsynced') {
          <div class="lyrics unsynced" [class.tv]="variant === 'tv'">
            <p class="hint">Lyrics (not synced)</p>
            <pre class="plain">{{ s.plainText }}</pre>
          </div>
        }
        @default {}
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .lyrics {
        display: flex;
        flex-direction: column;
        gap: 6px;
        text-align: center;
      }
      .line {
        margin: 0;
        transition:
          opacity 0.3s ease,
          transform 0.3s ease;
      }
      .line.prev,
      .line.next {
        opacity: 0.45;
        font-size: 0.85em;
      }
      .line.active {
        font-weight: 700;
        font-size: 1.15em;
      }
      .line.active.dim,
      .line.hint {
        opacity: 0.5;
      }
      .lyrics.tv .line.active {
        font-size: 1.6em;
      }
      .lyrics.tv .line.prev,
      .lyrics.tv .line.next {
        font-size: 1em;
      }
      .hint {
        margin: 0;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        opacity: 0.6;
      }
      .plain {
        margin: 0;
        max-height: 8em;
        overflow: hidden;
        white-space: pre-wrap;
        font: inherit;
        opacity: 0.8;
      }
    `,
  ],
})
export class LyricsPanelComponent {
  @Input({ required: true }) state: LyricsEngineState | null = null;
  @Input() variant: 'tv' | 'guest' = 'guest';
}
```

- [ ] **Step 2: Integrate into `tv.page.ts`**

- Imports: add `LyricsEngine, type LyricsEngineState` to the `@opendj/frontend` import; add `import { LyricsPanelComponent } from '../components/lyrics-panel.component.js';` and add `LyricsPanelComponent` to the component's `imports` array.
- Fields:

```ts
  private readonly lyricsEngine = new LyricsEngine({ prevCount: 1, nextCount: 2 });
  readonly lyricsState = signal<LyricsEngineState | null>(null);
  private lyricsInterval: ReturnType<typeof setInterval> | null = null;
```

- In the constructor next to the clock interval: `this.lyricsInterval = setInterval(() => this.lyricsState.set(this.lyricsEngine.computeState()), 250);` and clear it in the existing `onDestroy` alongside `clockInterval`.
- In `openRealtime()`: inside the existing `onSnapshot` callback add `this.lyricsEngine.applySnapshot(snapshot);` and in the existing `onEvent` callback add `this.lyricsEngine.applyEvent(event);` (first line, before the queue-refresh switch).
- Template: inside the `.now-playing` div, under `<app-now-playing-card ...>`, add:

```html
<app-lyrics-panel [state]="lyricsState()" variant="tv" />
```

- [ ] **Step 3: Verify**

Run: `pnpm turbo run build typecheck test --filter=@opendj/frontend-template`
Expected: green (`ng build` compiles the new component; template package has no unit tests for pages — build + typecheck is the gate).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write packages/frontend-template/src/app/components/lyrics-panel.component.ts packages/frontend-template/src/app/pages/tv.page.ts packages/frontend-template/package.json
git add packages/frontend-template/src packages/frontend-template/package.json pnpm-lock.yaml
git commit -s -m "feat(frontend-template): karaoke lyrics panel on the TV view"
```

---

### Task 7: Guest live-lyrics card

**Files:**

- Modify: `packages/frontend-template/src/app/pages/guest-request.page.ts` (realtime wiring at ~line 968 `new RealtimeClient`, mirrors the TV page's pattern)

**Interfaces:**

- Consumes: `LyricsEngine`, `LyricsPanelComponent` (Tasks 5-6); the guest page's existing `RealtimeClient` handlers.
- Produces: collapsible live-lyrics card on the guest page; never blocks the request flow.

- [ ] **Step 1: Integrate** (same recipe as the TV page):

- Add `LyricsPanelComponent` to imports; create `lyricsEngine` (defaults), `lyricsState` signal, 250ms interval cleared on destroy; wire `applySnapshot` into the page's existing `onSnapshot` handler and `applyEvent` into its `onEvent` (or add `this.realtime.onEvent((e) => this.lyricsEngine.applyEvent(e))` if the page only uses typed listeners).
- Add a collapsed-by-default card near the page's now-playing widget (locate the now-playing section in the template):

```html
@if (lyricsState()?.mode === 'synced' || lyricsState()?.mode === 'unsynced' || lyricsState()?.mode
=== 'paused') {
<details class="lyrics-card">
  <summary>Live lyrics</summary>
  <app-lyrics-panel [state]="lyricsState()" variant="guest" />
</details>
}
```

with styles consistent with the page's existing cards (reuse its card class if one exists; otherwise minimal `details { border-radius: 12px; padding: 8px 12px; }` matching surrounding values).

- [ ] **Step 2: Verify**

Run: `pnpm turbo run build typecheck test --filter=@opendj/frontend-template`
Expected: green.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write packages/frontend-template/src/app/pages/guest-request.page.ts
git add packages/frontend-template/src
git commit -s -m "feat(frontend-template): live lyrics card on the guest page"
```

---

### Task 8: Changeset, full verification, PR

**Files:**

- Create: `.changeset/lyrics-sync.md`

- [ ] **Step 1: Changeset**

```markdown
---
'@opendj/backend': minor
'@opendj/frontend': minor
'@opendj/realtime': patch
'@opendj/frontend-template': minor
---

Lyrics sync end-to-end: the now-playing poller broadcasts `playback.clock_sampled` each tick and `lyrics.loaded` on track change (cache-fronted LRCLIB lookup, null on miss, stale-result guard); new framework-free `LyricsEngine` in @opendj/frontend computes karaoke display state client-side via `predictPlaybackPosition`; TV view gains a karaoke panel and the guest page a collapsible live-lyrics card; `LyricsApi` fixed to the real lookup contract.
```

- [ ] **Step 2: Full verification**

Run: `pnpm turbo run build lint typecheck test --filter='./packages/*' --filter='!@opendj/frontend-template' --filter='!@opendj/agent-tools'` then `pnpm turbo run build typecheck --filter=@opendj/frontend-template` then `node scripts/verify-publish.mjs` (PowerShell, not Git Bash — MSYS tar breaks it)
Expected: all green; `verify-publish OK — 10 packages point at dist/`.

- [ ] **Step 3: Manual smoke (MANDATORY before merge — spec §4 testing gate)**

Boot the oss-demo compose (`Skill: running-the-stack`, or `cd apps/oss-demo && docker compose up --build`), connect the real Spotify account, play: (a) a popular track with synced lyrics, (b) something matched unsynced-only, (c) an instrumental. Confirm on `/tv/<slug>`: active line advances in time (a), plain panel (b), clean fallback (c); guest page card matches. Record results in the PR description.

- [ ] **Step 4: Commit, push, PR**

```bash
pnpm exec prettier --write .changeset/lyrics-sync.md
git add .changeset/lyrics-sync.md
git commit -s -m "chore: changeset for lyrics sync release"
git push -u origin feat/lyrics-sync
# PR via https://github.com/viscoci/OpenDJ/compare/main...feat/lyrics-sync (gh not installed)
```

After merge: the Release workflow opens the version PR (expect backend/frontend/frontend-template minor → 0.2.0, realtime 0.1.1); merge it; verify `npm view @opendj/backend version` → `0.2.0`.
