# TV Design Pass + Karaoke Polish — Design

**Date:** 2026-07-24 (evening)
**Status:** Approved by Ethan
**Extends:** `2026-07-24-lyrics-sync-and-demo-deploy-design.md` — all of it still stands; this adds the product-grade TV experience for tomorrow's demo, all approved to land tonight.

## 1. Scope split

**Foundation (`@opendj/frontend` LyricsEngine — added to the unmerged `feat/lyrics-sync` branch so it ships in the same 0.2.0):**

- `setOffsetMs(ms: number)`: user-tunable lyrics offset, applied to the predicted position before line/word selection. Positive = lyrics render later (use when highlights run ahead).
- Per-word interpolation in `computeState()`: state gains
  `wordProgress: { words: string[]; activeWordIndex: number; activeWordFraction: number } | null`
  — populated in `synced` mode for the active line. Word timing is estimated by weighting each word's share of the line window `[startsAtMs, endsAtMs ?? nextLineStart ?? +4s]` by its character length (LRCLIB is line-level; this is classic karaoke interpolation, honest-by-design). `null` when no active line.

**Product (`opendj-live/apps/web`, after the scaffold):** all presentation — layouts, theming, settings, karaoke rendering. No further foundation releases required tonight.

## 2. TV features (opendj-live)

- **Three switchable layouts** per the design canvas (`docs/designs/OpenDJ.live/wedj-tv.jsx`, `wedj-lyrics.jsx`): **overlay** (full-bleed art-derived gradient, big display type, karaoke block low-center — the reference mock), **centered** (karaoke focus), **split** (lyrics left, now-playing right). Default: overlay.
- **Album-art color theming:** on track change, sample the album art client-side (downscaled canvas), extract dominant hue, build gradient stops from dominant + complement (HSL rotate ~180°, darkened). If the CDN blocks CORS (tainted canvas), fall back automatically to the brand `#A855F7 → #EC4899` gradient — the demo never breaks on theming.
- **TV settings panel:** gear button (fades unless hovered) → panel with: layout picker (3), font scale slider (0.75×–1.5×, applied as a root `em` multiplier on the lyrics block), lyrics offset slider (−2000…+2000 ms, 50 ms steps, live `engine.setOffsetMs`). Persisted per device in `localStorage` (`opendj.tv.settings.v1`). TV-only; guest page untouched.
- **Karaoke word rendering:** active line renders per-word; words up to `activeWordIndex` filled, the active word fills progressively via `activeWordFraction` (gradient sweep), plus a bouncing dot positioned over the active word. TV page drives the engine with `requestAnimationFrame` (instead of the 250 ms interval) so the sweep/dot are smooth; guest page stays at 250 ms.

## 3. Sequencing (tonight)

1. Engine additions on `feat/lyrics-sync` (TDD) → re-verify → Ethan finishes the manual smoke (incl. track replay) → merge → version PR → **0.2.0 publishes**.
2. Scaffold `viscoci/opendj-live` (private): `apps/server` (oss-demo pattern, pinned `@opendj/*@0.2.0` from npm), `apps/web` (vendored `frontend-template`), `deploy/` (compose: app + postgres + cloudflared).
3. TV design pass in `opendj-live/apps/web` (this spec §2).
4. Deploy: basement box compose, named tunnel → opendj.com DNS, Spotify redirect URI `https://opendj.com/api/v1/provider/connections/spotify/callback`, `BASE_URL=https://opendj.com`. Pre-warm lyrics cache with the demo setlist.

## 4. Risks

| Risk                                                    | Mitigation                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Album-art CORS taint                                    | Automatic brand-gradient fallback; theming is progressive enhancement                                                            |
| Interpolated word timing feels off on sparse/slow lines | Offset slider + honest interpolation; fraction easing tuned in review                                                            |
| Large surface pre-demo                                  | Subagent pipeline (2 plans already shipped today); layouts share one karaoke component — switcher is CSS/structure, not 3× logic |
| rAF loop battery/perf on TV                             | TV is mains-powered; guest page keeps 250 ms interval                                                                            |
