# TV Design Pass Implementation Plan (Plan C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Product-grade TV view in `opendj-live/apps/web` matching the design canvas: three switchable layouts, album-art-derived theming, in-browser settings (layout / font scale / lyrics offset), per-word karaoke rendering with bouncing dot, rAF-driven.

**Architecture:** `tv.page.ts` stays the data container (snapshot + realtime + LyricsEngine) and delegates all presentation to three layout components that share small presentational pieces (karaoke stack, corner QR, settings panel). Pure logic (settings persistence, palette math) lives in plain TS modules with vitest tests. Spec: foundation repo `docs/superpowers/specs/2026-07-24-tv-design-pass-design.md` §2.

**Tech Stack:** Angular 21 standalone components (signals, OnPush), `@opendj/frontend@0.2.0` LyricsEngine (`setOffsetMs`, `wordProgress`), vitest (via `ng test`), canvas API for palette extraction.

## Global Constraints

- Working dir: `d:\Repositories\opendj-live\apps\web` (exists after Plan B Task B3). Foundation repo `d:\Repositories\opendj` is READ-ONLY reference (design files, template source).
- Design reference files: `d:\Repositories\opendj\docs\designs\OpenDJ.live\wedj-lyrics.jsx` (TV layouts, lines 696–1309), `wedj-tv.jsx`, `wedj-tokens.css`.
- Brand fallback gradient EXACTLY `#A855F7 → #EC4899`. Design tokens: bg `#05050B`, text `#F0EFFF`.
- localStorage key EXACTLY `opendj.tv.settings.v1`. Font scale range 0.75–1.5 (step 0.05, default 1). Offset range −2000…+2000 ms (step 50, default 0; positive = lyrics later). Default layout `overlay`.
- Fonts: Syne (display), Inter (body), JetBrains Mono — add Google Fonts links to `src/index.html` (they are referenced but never loaded today).
- TV page only. Guest page untouched (keeps its 250 ms interval).
- Engine facts (from `@opendj/frontend`): `LyricsEngineState = { mode: 'loading'|'synced'|'unsynced'|'none'|'paused', trackUri, activeLine, prevLines, nextLines, plainText, normalizedProgress, wordProgress }`; `wordProgress = { words: string[], activeWordIndex: number, activeWordFraction: number } | null` (non-null only in synced/paused with an active timed line); `engine.setOffsetMs(ms)`.
- `NowPlayingTrack` (from `@opendj/core`): `{ uri, name, artist, albumArt: string | null, durationMs, progressMs, isPlaying, zoneId }`.
- Verify per task: `pnpm --filter @opendj-live/web build` green; pure-TS tasks also `pnpm --filter @opendj-live/web test` (Angular vitest builder — no spec files exist today, so the first test task establishes the suite).
- Conventional Commits, one commit per task.

---

### Task C1: TV settings store (pure TS + tests)

**Files:**

- Create: `apps/web/src/app/tv/tv-settings.ts`
- Test: `apps/web/src/app/tv/tv-settings.spec.ts`

**Interfaces:**

- Produces: `type TvLayout = 'overlay' | 'centered' | 'split'`; `interface TvSettings { layout: TvLayout; fontScale: number; offsetMs: number }`; `DEFAULT_TV_SETTINGS: TvSettings`; `clampTvSettings(s: unknown): TvSettings`; `loadTvSettings(storage: Pick<Storage,'getItem'>): TvSettings`; `saveTvSettings(storage: Pick<Storage,'setItem'>, s: TvSettings): void`; `TV_SETTINGS_KEY = 'opendj.tv.settings.v1'`.

- [ ] **Step 1: Write the failing tests** (`tv-settings.spec.ts`):

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TV_SETTINGS,
  TV_SETTINGS_KEY,
  clampTvSettings,
  loadTvSettings,
  saveTvSettings,
} from './tv-settings.js';

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe('tv-settings', () => {
  it('defaults: overlay, scale 1, offset 0', () => {
    expect(DEFAULT_TV_SETTINGS).toEqual({ layout: 'overlay', fontScale: 1, offsetMs: 0 });
  });

  it('load returns defaults on empty or garbage storage', () => {
    const s = mem();
    expect(loadTvSettings(s)).toEqual(DEFAULT_TV_SETTINGS);
    s.setItem(TV_SETTINGS_KEY, '{not json');
    expect(loadTvSettings(s)).toEqual(DEFAULT_TV_SETTINGS);
  });

  it('round-trips through storage', () => {
    const s = mem();
    saveTvSettings(s, { layout: 'split', fontScale: 1.25, offsetMs: -300 });
    expect(loadTvSettings(s)).toEqual({ layout: 'split', fontScale: 1.25, offsetMs: -300 });
  });

  it('clamps out-of-range and unknown values', () => {
    expect(clampTvSettings({ layout: 'diagonal', fontScale: 9, offsetMs: 99999 })).toEqual({
      layout: 'overlay',
      fontScale: 1.5,
      offsetMs: 2000,
    });
    expect(clampTvSettings({ layout: 'centered', fontScale: 0.1, offsetMs: -99999 })).toEqual({
      layout: 'centered',
      fontScale: 0.75,
      offsetMs: -2000,
    });
    expect(clampTvSettings(null)).toEqual(DEFAULT_TV_SETTINGS);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @opendj-live/web test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** (`tv-settings.ts`):

```ts
/** TV presentation settings, persisted per device in localStorage. */
export type TvLayout = 'overlay' | 'centered' | 'split';

export interface TvSettings {
  layout: TvLayout;
  /** Root multiplier applied to the lyrics block (em scale). */
  fontScale: number;
  /** Positive = lyrics render later. Passed to LyricsEngine.setOffsetMs. */
  offsetMs: number;
}

export const TV_SETTINGS_KEY = 'opendj.tv.settings.v1';

export const DEFAULT_TV_SETTINGS: TvSettings = { layout: 'overlay', fontScale: 1, offsetMs: 0 };

const LAYOUTS: readonly TvLayout[] = ['overlay', 'centered', 'split'];

const clampNum = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;

export function clampTvSettings(s: unknown): TvSettings {
  const o = (s ?? {}) as Record<string, unknown>;
  return {
    layout: LAYOUTS.includes(o['layout'] as TvLayout)
      ? (o['layout'] as TvLayout)
      : DEFAULT_TV_SETTINGS.layout,
    fontScale: clampNum(o['fontScale'], 0.75, 1.5, DEFAULT_TV_SETTINGS.fontScale),
    offsetMs: clampNum(o['offsetMs'], -2000, 2000, DEFAULT_TV_SETTINGS.offsetMs),
  };
}

export function loadTvSettings(storage: Pick<Storage, 'getItem'>): TvSettings {
  try {
    const raw = storage.getItem(TV_SETTINGS_KEY);
    return raw ? clampTvSettings(JSON.parse(raw)) : DEFAULT_TV_SETTINGS;
  } catch {
    return DEFAULT_TV_SETTINGS;
  }
}

export function saveTvSettings(storage: Pick<Storage, 'setItem'>, s: TvSettings): void {
  try {
    storage.setItem(TV_SETTINGS_KEY, JSON.stringify(clampTvSettings(s)));
  } catch {
    // Storage unavailable (private mode etc.) — settings just don't persist.
  }
}
```

- [ ] **Step 4: Tests pass** — `pnpm --filter @opendj-live/web test`. Expected: 4 passing. Also `pnpm --filter @opendj-live/web build` still green.
- [ ] **Step 5: Commit** — `feat(tv): settings model with localStorage persistence`

---

### Task C2: Album-art palette extraction (pure math + canvas, tests for the math)

**Files:**

- Create: `apps/web/src/app/tv/album-palette.ts`
- Test: `apps/web/src/app/tv/album-palette.spec.ts`

**Interfaces:**

- Produces: `interface TvPalette { a: string; b: string }` (hex colors, gradient = `linear-gradient(135deg, a, b)`); `BRAND_PALETTE: TvPalette`; `paletteFromRgb(r,g,b): TvPalette` (pure); `extractPalette(url: string | null): Promise<TvPalette>` (canvas; resolves BRAND_PALETTE on any failure — never rejects).

- [ ] **Step 1: Failing tests** (`album-palette.spec.ts`) — pure math only (canvas is untestable in node without a DOM; the async path is exercised in the browser):

```ts
import { describe, expect, it } from 'vitest';
import { BRAND_PALETTE, extractPalette, paletteFromRgb } from './album-palette.js';

describe('album-palette', () => {
  it('brand palette is the spec fallback', () => {
    expect(BRAND_PALETTE).toEqual({ a: '#A855F7', b: '#EC4899' });
  });

  it('derives complement rotated ~180deg, darkened', () => {
    // Pure red -> a stays reddish, b lands in the cyan half, darker than a.
    const p = paletteFromRgb(220, 40, 40);
    expect(p.a.toLowerCase()).not.toBe(p.b.toLowerCase());
    const hue = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) / 255,
        g = ((n >> 8) & 255) / 255,
        b = (n & 255) / 255;
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b),
        d = max - min;
      if (d === 0) return 0;
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const diff = Math.abs(hue(p.a) - hue(p.b));
    expect(Math.min(diff, 360 - diff)).toBeGreaterThan(120); // roughly complementary
  });

  it('boosts near-grey pixels into a usable accent instead of mud', () => {
    const p = paletteFromRgb(128, 128, 130);
    expect(p.a).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(p.b).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('extractPalette resolves brand fallback for null url', async () => {
    await expect(extractPalette(null)).resolves.toEqual(BRAND_PALETTE);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** (`album-palette.ts`):

```ts
/**
 * Album-art color theming. Samples the art on a small canvas, picks a
 * dominant vivid color, and pairs it with its darkened complement
 * (hue + 180). Any failure (no art, CORS-tainted canvas, decode error)
 * resolves to the brand gradient — theming is progressive enhancement
 * and must never break the TV.
 */
export interface TvPalette {
  a: string;
  b: string;
}

export const BRAND_PALETTE: TvPalette = { a: '#A855F7', b: '#EC4899' };

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to255 = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to255(f(0))}${to255(f(8))}${to255(f(4))}`.toUpperCase();
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, s, l];
}

/** Dominant sampled color -> {a: vivid dominant, b: darkened complement}. */
export function paletteFromRgb(r: number, g: number, b: number): TvPalette {
  const [h, s, l] = rgbToHsl(r, g, b);
  // Pull toward a display-friendly band: enough saturation to glow,
  // mid lightness so white text stays readable on both stops.
  const sa = Math.min(0.9, Math.max(0.55, s));
  const la = Math.min(0.62, Math.max(0.42, l));
  return {
    a: hslToHex(h, sa, la),
    b: hslToHex((h + 180) % 360, sa, Math.max(0.3, la - 0.12)),
  };
}

const SAMPLE = 24;

export function extractPalette(url: string | null): Promise<TvPalette> {
  if (!url || typeof document === 'undefined') return Promise.resolve(BRAND_PALETTE);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(BRAND_PALETTE);
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE); // throws if tainted
        // Weighted average favoring saturated, mid-lightness pixels.
        let r = 0,
          g = 0,
          b = 0,
          w = 0;
        for (let i = 0; i < data.length; i += 4) {
          const [, s, l] = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!);
          const weight = 0.05 + s * (1 - Math.abs(2 * l - 1));
          r += data[i]! * weight;
          g += data[i + 1]! * weight;
          b += data[i + 2]! * weight;
          w += weight;
        }
        if (w === 0) return resolve(BRAND_PALETTE);
        resolve(paletteFromRgb(r / w, g / w, b / w));
      } catch {
        resolve(BRAND_PALETTE); // CORS taint or decode failure
      }
    };
    img.onerror = () => resolve(BRAND_PALETTE);
    img.src = url;
  });
}
```

- [ ] **Step 4: Tests pass** (`pnpm --filter @opendj-live/web test`; build green).
- [ ] **Step 5: Commit** — `feat(tv): album-art palette extraction with brand fallback`

---

### Task C3: Karaoke line + TV lyrics stack components

**Files:**

- Create: `apps/web/src/app/tv/karaoke-line.component.ts`
- Create: `apps/web/src/app/tv/tv-lyrics-stack.component.ts`

**Interfaces:**

- Consumes: `LyricsEngineState`, `LyricsWordProgress` from `@opendj/frontend`; `TvPalette` (C2); `TvLayout` (C1).
- Produces: `<app-karaoke-line [text] [wordProgress] [palette] />` — active line with per-word fill + bouncing dot; `<app-tv-lyrics-stack [state] [layout] [palette] />` — full lyric area for any engine mode, sized per layout. Both OnPush, inputs only.

- [ ] **Step 1: `karaoke-line.component.ts`.** Rendering rules (spec §2): words before `activeWordIndex` fully gradient-filled; the active word fills left→right by `activeWordFraction` (gradient sweep via layered spans); later words dim (`rgba(240,239,255,0.4)`); bouncing dot rides the active word (`left: fraction*100%` of that word's span). When `wordProgress` is null (e.g. instrumental gap between lines), render the whole line filled, no dot.

```ts
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import type { LyricsWordProgress } from '@opendj/frontend';
import type { TvPalette } from './album-palette.js';

/**
 * One active karaoke line: words up to the active index are filled with the
 * accent gradient, the active word fills progressively, and a dot bounces
 * over the active word. Interpolated timing (LRCLIB is line-level) —
 * honest-by-design.
 */
@Component({
  selector: 'app-karaoke-line',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (wordProgress; as wp) {
      <span class="line">
        @for (word of wp.words; track $index; let i = $index) {
          <span
            class="word"
            [class.sung]="i < wp.activeWordIndex"
            [class.active]="i === wp.activeWordIndex"
            [class.pending]="i > wp.activeWordIndex"
            [style.--grad]="grad"
          >
            @if (i === wp.activeWordIndex) {
              <span class="fill" [style.width.%]="wp.activeWordFraction * 100">{{ word }}</span>
              <span
                class="dot"
                [style.left.%]="wp.activeWordFraction * 100"
                [style.background]="palette?.b ?? '#EC4899'"
              ></span>
            }
            {{ word }}</span
          >
        }
      </span>
    } @else {
      <span class="line"
        ><span class="word sung" [style.--grad]="grad">{{ text }}</span></span
      >
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .line {
        display: inline;
      }
      .word {
        position: relative;
        display: inline-block;
        margin-right: 0.28em;
        white-space: pre-wrap;
      }
      .word.sung {
        background: var(--grad);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .word.pending {
        color: rgba(240, 239, 255, 0.4);
      }
      .word.active {
        color: rgba(240, 239, 255, 0.4);
      }
      .word.active .fill {
        position: absolute;
        inset: 0 auto 0 0;
        overflow: hidden;
        white-space: pre;
        background: var(--grad);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .dot {
        position: absolute;
        top: -0.32em;
        width: 0.18em;
        height: 0.18em;
        border-radius: 999px;
        transform: translateX(-50%);
        animation: karaoke-bounce 0.45s ease-in-out infinite alternate;
        box-shadow: 0 0 0.4em currentColor;
      }
      @keyframes karaoke-bounce {
        from {
          transform: translateX(-50%) translateY(0);
        }
        to {
          transform: translateX(-50%) translateY(-0.14em);
        }
      }
    `,
  ],
})
export class KaraokeLineComponent {
  @Input({ required: true }) text = '';
  @Input() wordProgress: LyricsWordProgress | null = null;
  @Input() palette: TvPalette | null = null;

  get grad(): string {
    const a = this.palette?.a ?? '#A855F7';
    const b = this.palette?.b ?? '#EC4899';
    return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
  }
}
```

- [ ] **Step 2: `tv-lyrics-stack.component.ts`.** Port of `TVSyncedLines` / `TVUnsyncedRibbon` / `TVNoLyricsRibbon` (design `wedj-lyrics.jsx:1166–1280`) onto `LyricsEngineState` (engine already supplies prev/active/next windows and skips nothing — section headers don't exist in LRCLIB docs). Per-layout active-line sizes from the design: overlay 80px, centered 92px, split 64px; next 38/44/34; prev 32/36/28 (browser px at 1080p; use em-relative: base font-size on the host = size/16 em so `fontScale` multiplies cleanly — the page sets `style.fontSize` on the block). Structure:

```ts
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import type { LyricsEngineState } from '@opendj/frontend';
import type { TvPalette } from './album-palette.js';
import type { TvLayout } from './tv-settings.js';
import { KaraokeLineComponent } from './karaoke-line.component.js';

/** Lyric area for the TV: karaoke stack (synced/paused), read-along (unsynced), waveform card (none/loading). */
@Component({
  selector: 'app-tv-lyrics-stack',
  standalone: true,
  imports: [CommonModule, KaraokeLineComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state; as s) {
      @switch (s.mode) {
        @case ('synced') {
          <div class="stack" [class]="layout">
            @for (line of s.prevLines; track line.id) {
              <p class="prev">{{ line.text }}</p>
            }
            @if (s.activeLine) {
              <p class="active t-display">
                <app-karaoke-line
                  [text]="s.activeLine.text"
                  [wordProgress]="s.wordProgress"
                  [palette]="palette"
                />
              </p>
            } @else {
              <p class="active dim t-display">♪</p>
            }
            @for (line of s.nextLines; track line.id; let i = $index) {
              <p class="next" [class.next2]="i > 0">{{ line.text }}</p>
            }
          </div>
        }
        @case ('paused') {
          <div class="stack" [class]="layout">
            @if (s.activeLine) {
              <p class="active t-display">
                <app-karaoke-line
                  [text]="s.activeLine.text"
                  [wordProgress]="s.wordProgress"
                  [palette]="palette"
                />
              </p>
            }
            <p class="eyebrow">Paused</p>
          </div>
        }
        @case ('unsynced') {
          <div class="stack" [class]="layout">
            <p class="eyebrow">Lyrics — read along</p>
            <pre class="plain">{{ s.plainText }}</pre>
          </div>
        }
        @default {
          <div class="stack none" [class]="layout">
            <p class="eyebrow">No lyrics for this track</p>
            <div class="bars" aria-hidden="true">
              @for (h of BARS; track $index) {
                <span [style.height.%]="h" [style.background]="grad"></span>
              }
            </div>
          </div>
        }
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: 0.35em;
        min-width: 0;
      }
      p {
        margin: 0;
        text-wrap: pretty;
        line-height: 1.12;
      }
      .prev {
        font-size: 0.42em;
        font-weight: 500;
        color: rgba(240, 239, 255, 0.32);
      }
      .active {
        font-size: 1em;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .active.dim {
        opacity: 0.5;
      }
      .next {
        font-size: 0.5em;
        font-weight: 500;
        color: rgba(240, 239, 255, 0.62);
      }
      .next.next2 {
        color: rgba(240, 239, 255, 0.42);
      }
      /* per-layout size ratios tuned from the design canvas */
      .stack.centered .prev {
        font-size: 0.39em;
      }
      .stack.centered .next {
        font-size: 0.48em;
      }
      .stack.split .prev {
        font-size: 0.44em;
      }
      .stack.split .next {
        font-size: 0.53em;
      }
      .eyebrow {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.16em;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        color: rgba(255, 255, 255, 0.5);
      }
      .plain {
        margin: 0;
        font:
          500 0.35em/1.4 'Inter',
          sans-serif;
        color: rgba(255, 255, 255, 0.85);
        white-space: pre-wrap;
        max-height: 12em;
        overflow: hidden;
      }
      .bars {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        height: 1.4em;
      }
      .bars span {
        width: 5px;
        border-radius: 2px;
        opacity: 0.6;
      }
    `,
  ],
})
export class TvLyricsStackComponent {
  @Input({ required: true }) state: LyricsEngineState | null = null;
  @Input() layout: TvLayout = 'overlay';
  @Input() palette: TvPalette | null = null;

  /** Static pseudo-waveform heights for the no-lyrics card. */
  readonly BARS = Array.from({ length: 48 }, (_, i) => 20 + Math.abs(Math.sin(i * 0.6)) * 70);

  get grad(): string {
    const a = this.palette?.a ?? '#A855F7';
    const b = this.palette?.b ?? '#EC4899';
    return `linear-gradient(180deg, ${a}, ${b})`;
  }
}
```

Font sizing contract for later tasks: the _page_ sets the base `font-size` of this component's host per layout (overlay `80px`, centered `92px`, split `64px`, each `* fontScale`) — every internal size is em-relative to that.

- [ ] **Step 3: Verify** — `pnpm --filter @opendj-live/web build` green (components compile; not yet rendered anywhere).
- [ ] **Step 4: Commit** — `feat(tv): karaoke line and lyrics stack components`

---

### Task C4: Settings panel + corner QR components

**Files:**

- Create: `apps/web/src/app/tv/tv-settings-panel.component.ts`
- Create: `apps/web/src/app/tv/tv-corner-qr.component.ts`

**Interfaces:**

- Consumes: `TvSettings`, `TvLayout` (C1); existing `QrCodeComponent` (`../components/qr-code.component.js`, input `[value]`, `[size]`).
- Produces: `<app-tv-settings-panel [settings] (settingsChange)="..." />` — gear button (bottom-right, fades unless hovered) toggling a panel with layout picker, font-scale slider, offset slider; emits a complete `TvSettings` on every change. `<app-tv-corner-qr [guestUrl] [slug] [palette] />` — the design's QR card (`wedj-lyrics.jsx:1282–1309`).

- [ ] **Step 1: `tv-settings-panel.component.ts`:**

```ts
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  signal,
} from '@angular/core';
import { clampTvSettings, type TvLayout, type TvSettings } from './tv-settings.js';

/** Gear button + slide-in panel. TV-only; persistence is the page's job. */
@Component({
  selector: 'app-tv-settings-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button class="gear" type="button" aria-label="TV settings" (click)="open.set(!open())">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.6c.04-.3.06-.6.06-.9s-.02-.6-.06-.9l2-1.6a.5.5 0 0 0 .12-.64l-1.9-3.3a.5.5 0 0 0-.6-.22l-2.36.95a7.6 7.6 0 0 0-1.56-.9l-.36-2.5a.5.5 0 0 0-.5-.43h-3.8a.5.5 0 0 0-.5.42l-.36 2.51c-.56.23-1.08.54-1.56.9l-2.36-.95a.5.5 0 0 0-.6.22l-1.9 3.3a.5.5 0 0 0 .12.64l2 1.6c-.04.3-.06.6-.06.9s.02.6.06.9l-2 1.6a.5.5 0 0 0-.12.64l1.9 3.3c.13.22.39.31.6.22l2.36-.95c.48.36 1 .67 1.56.9l.36 2.5c.04.25.25.43.5.43h3.8c.25 0 .46-.18.5-.42l.36-2.51a7.6 7.6 0 0 0 1.56-.9l2.36.95c.21.09.47 0 .6-.22l1.9-3.3a.5.5 0 0 0-.12-.64l-2-1.6Z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    @if (open()) {
      <div class="panel">
        <p class="title">TV settings</p>

        <p class="label">Layout</p>
        <div class="layouts">
          @for (l of LAYOUTS; track l) {
            <button type="button" [class.on]="settings.layout === l" (click)="patch({ layout: l })">
              {{ l }}
            </button>
          }
        </div>

        <p class="label">
          Lyrics size <span class="value">{{ settings.fontScale | number: '1.2-2' }}×</span>
        </p>
        <input
          type="range"
          min="0.75"
          max="1.5"
          step="0.05"
          [value]="settings.fontScale"
          (input)="patch({ fontScale: num($event) })"
        />

        <p class="label">
          Lyrics offset <span class="value">{{ settings.offsetMs }} ms</span>
        </p>
        <input
          type="range"
          min="-2000"
          max="2000"
          step="50"
          [value]="settings.offsetMs"
          (input)="patch({ offsetMs: num($event) })"
        />
        <p class="hint">Positive = lyrics later. Use if highlights run ahead of the song.</p>
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 50;
        font-family: 'Inter', sans-serif;
      }
      .gear {
        width: 44px;
        height: 44px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(12px);
        color: #f0efff;
        cursor: pointer;
        opacity: 0.15;
        transition: opacity 0.25s ease;
        display: grid;
        place-items: center;
      }
      :host(:hover) .gear,
      .gear:focus-visible {
        opacity: 1;
      }
      .panel {
        position: absolute;
        right: 0;
        bottom: 56px;
        width: 280px;
        padding: 18px;
        border-radius: 16px;
        background: rgba(19, 19, 31, 0.92);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #f0efff;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .title {
        margin: 0 0 6px;
        font-family: 'Syne', 'Inter', sans-serif;
        font-weight: 600;
        font-size: 16px;
      }
      .label {
        margin: 8px 0 2px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(255, 255, 255, 0.55);
        display: flex;
        justify-content: space-between;
      }
      .value {
        color: #fff;
      }
      .layouts {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 6px;
      }
      .layouts button {
        padding: 8px 0;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: transparent;
        color: rgba(255, 255, 255, 0.7);
        font:
          600 12px 'Inter',
          sans-serif;
        text-transform: capitalize;
        cursor: pointer;
      }
      .layouts button.on {
        background: linear-gradient(135deg, #a855f7, #ec4899);
        border-color: transparent;
        color: #fff;
      }
      input[type='range'] {
        width: 100%;
        accent-color: #a855f7;
      }
      .hint {
        margin: 2px 0 0;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.45);
        line-height: 1.4;
      }
    `,
  ],
})
export class TvSettingsPanelComponent {
  @Input({ required: true }) settings: TvSettings = {
    layout: 'overlay',
    fontScale: 1,
    offsetMs: 0,
  };
  @Output() settingsChange = new EventEmitter<TvSettings>();

  readonly LAYOUTS: readonly TvLayout[] = ['overlay', 'centered', 'split'];
  readonly open = signal(false);

  num(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  patch(p: Partial<TvSettings>): void {
    this.settingsChange.emit(clampTvSettings({ ...this.settings, ...p }));
  }
}
```

(Requires `CommonModule`'s `DecimalPipe` — already imported via CommonModule.)

- [ ] **Step 2: `tv-corner-qr.component.ts`** — port of `TVCornerQR`:

```ts
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { QrCodeComponent } from '../components/qr-code.component.js';
import type { TvPalette } from './album-palette.js';

/** Compact QR card: white QR tile + "Request a song" copy, gradient border. */
@Component({
  selector: 'app-tv-corner-qr',
  standalone: true,
  imports: [CommonModule, QrCodeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card" [style.--grad]="grad">
      <div class="tile"><app-qr-code [value]="guestUrl" [size]="120" /></div>
      <div class="copy">
        <p class="eyebrow">Request a song</p>
        <p class="domain t-display">{{ host }}</p>
        <p class="slug">/u/{{ slug }}</p>
      </div>
    </div>
  `,
  styles: [
    `
      .card {
        padding: 18px;
        border-radius: 16px;
        background:
          linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.55)) padding-box,
          var(--grad) border-box;
        border: 1.5px solid transparent;
        backdrop-filter: blur(20px);
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .tile {
        padding: 6px;
        background: #fff;
        border-radius: 10px;
        line-height: 0;
      }
      .copy p {
        margin: 0;
      }
      .eyebrow {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: rgba(255, 255, 255, 0.6);
      }
      .domain {
        font-family: 'Syne', 'Inter', sans-serif;
        font-size: 18px;
        font-weight: 600;
        margin-top: 4px;
      }
      .slug {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 13px;
        color: rgba(255, 255, 255, 0.7);
        margin-top: 2px;
      }
    `,
  ],
})
export class TvCornerQrComponent {
  @Input({ required: true }) guestUrl = '';
  @Input({ required: true }) slug = '';
  @Input() palette: TvPalette | null = null;

  get host(): string {
    try {
      return new URL(this.guestUrl).host || 'opendj.com';
    } catch {
      return 'opendj.com';
    }
  }

  get grad(): string {
    const a = this.palette?.a ?? '#A855F7';
    const b = this.palette?.b ?? '#EC4899';
    return `linear-gradient(135deg, ${a}, ${b})`;
  }
}
```

- [ ] **Step 3: Verify** — build green.
- [ ] **Step 4: Commit** — `feat(tv): settings panel and corner QR components`

---

### Task C5: Three layout components

**Files:**

- Create: `apps/web/src/app/tv/tv-overlay-layout.component.ts`
- Create: `apps/web/src/app/tv/tv-centered-layout.component.ts`
- Create: `apps/web/src/app/tv/tv-split-layout.component.ts`

**Interfaces:**

- Consumes: everything above. Design source of truth: `d:\Repositories\opendj\docs\designs\OpenDJ.live\wedj-lyrics.jsx` — `TVOverlayLayout` (753–865), `TVCenteredLayout` (867–1024), `TVSplitLayout` (1026–1164); read those ranges and port the structure/values faithfully (spacing, sizes, rgba values, gradients) with real data substituted for mocks.
- Produces: three components with the IDENTICAL input contract (later, `tv.page` switches between them):

```ts
@Input({ required: true }) session!: SessionWire;              // session.name for the event title
@Input() nowPlaying: NowPlayingTrack | null = null;
@Input() lyricsState: LyricsEngineState | null = null;
@Input() palette: TvPalette = BRAND_PALETTE;
@Input() guestUrl = '';
@Input() upNext: ReadonlyArray<{ name: string; artist: string; albumArt: string | null }> = [];
@Input() activeGuestCount = 0;
@Input() clockText = '';
@Input() fontScale = 1;
```

Data mapping (mock → real), applies to all three:

| Design mock                      | Real source                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Maya & Theo's Wedding`          | `session.name`                                                                                                               |
| `np.name/artist/album`           | `nowPlaying.name` / `.artist` (no album field — omit the "from album" line)                                                  |
| album-art gradient square        | `<img [src]="nowPlaying.albumArt">` when set, palette-gradient div fallback                                                  |
| `47 listening`                   | `activeGuestCount`                                                                                                           |
| `2h 14m live` / requests tonight | omit (no data) — keep clock instead                                                                                          |
| palette `npA/npB`                | `palette.a` / `palette.b`                                                                                                    |
| progress `elapsedSec/totalSec`   | `elapsedMs = (lyricsState?.normalizedProgress ?? 0) * nowPlaying.durationMs`; total = `nowPlaying.durationMs`; format `m:ss` |
| queue rows (`Up next`)           | `upNext` (first 3 in centered rail, 5 in split rail; overlay has no queue)                                                   |
| `opendj.live/u/open-mic-42`      | corner QR component with real `guestUrl`                                                                                     |
| WedjMark logo SVG                | gradient-text "OpenDJ" wordmark (Syne, like the current template header)                                                     |

Shared behaviors:

- Lyrics block: wrap `<app-tv-lyrics-stack [state] [layout] [palette]>` in a container with `[style.fontSize.px]="baseSize * fontScale"` — baseSize 80 (overlay), 92 (centered), 64 (split).
- Overlay backdrop: full-bleed. If `nowPlaying.albumArt`, render `<img>` stretched `object-fit: cover` with `filter: blur(0px)` UNDER the design's three gradient overlay divs (dark scrim keeps text readable); else the palette linear-gradient exactly as the design.
- All backdrops/glows use `palette.a`/`palette.b` with the design's alpha suffixes (`55`, `44`, `28` hex alpha appended — palette colors are 6-digit hex so string-append works).
- Every layout is `position: fixed; inset: 0` fullscreen, `background: #05050B`, `color: #F0EFFF`, no scrollbars (`overflow: hidden`).

- [ ] **Step 1:** Read the three design functions in `wedj-lyrics.jsx` (lines above) and `TVCornerQR`; port `TVOverlayLayout` → `tv-overlay-layout.component.ts` (top bar: wordmark + session name left, `N listening · clock` right; track meta top-left with 88px display title; corner QR top-right; lyrics ribbon bottom with the stack; progress bar pinned bottom). Angular template + styles, OnPush, inputs per the contract.
- [ ] **Step 2:** Port `TVCenteredLayout` → `tv-centered-layout.component.ts` (giant centered lyrics; right rail: art badge + QR + up-next list; progress pinned bottom).
- [ ] **Step 3:** Port `TVSplitLayout` → `tv-split-layout.component.ts` (grid `1fr 720px`; lyrics left with ambient blooms; right: art 320px, track meta, progress, QR strip pinned near bottom).
- [ ] **Step 4: Verify** — build green.
- [ ] **Step 5: Commit** — `feat(tv): overlay, centered, and split layout components`

---

### Task C6: Rewire tv.page — rAF engine drive, palette, settings, layout switch, fonts

**Files:**

- Modify: `apps/web/src/app/pages/tv.page.ts`
- Modify: `apps/web/src/index.html`

**Interfaces:**

- Consumes: all of C1–C5. Current `tv.page.ts` (vendored from the template) already owns: `tvSnapshot` bootstrap, `RealtimeClient` wiring, `LyricsEngine({prevCount: 1, nextCount: 2})`, signals for session/nowPlaying/upcoming/providerQueue/activeGuestCount/clock, 250 ms lyrics interval.

- [ ] **Step 1: Fonts.** In `src/index.html` `<head>` add:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Syne:wght@600;700&display=swap"
  rel="stylesheet"
/>
```

Also set `<title>OpenDJ</title>`.

- [ ] **Step 2: Rewrite `tv.page.ts` presentation.** Keep ALL data logic (bootstrap, realtime handlers, refreshQueue) exactly as-is; replace the template/styles and the 250 ms interval:
  - New signals: `settings = signal<TvSettings>(loadTvSettings(globalThis.localStorage))`, `palette = signal<TvPalette>(BRAND_PALETTE)`.
  - Constructor: `this.lyricsEngine.setOffsetMs(this.settings().offsetMs)` once at start.
  - Replace the `setInterval(250)` with an rAF loop (falls back to interval when rAF is missing, e.g. vitest/jsdom):

```ts
private rafId: number | null = null;
private startLyricsLoop(): void {
  const raf = globalThis.requestAnimationFrame?.bind(globalThis);
  if (!raf) {
    this.lyricsInterval = setInterval(() => {
      this.lyricsState.set(this.lyricsEngine.computeState());
    }, 250);
    return;
  }
  const tick = () => {
    this.lyricsState.set(this.lyricsEngine.computeState());
    this.rafId = raf(tick);
  };
  this.rafId = raf(tick);
}
// onDestroy additionally: if (this.rafId !== null) cancelAnimationFrame(this.rafId);
```

- Palette on track change — extend the existing `now_playing.updated` handler and the snapshot handler with:

```ts
private lastArtUrl: string | null = null;
private refreshPalette(track: NowPlayingTrack | null): void {
  const url = track?.albumArt ?? null;
  if (url === this.lastArtUrl) return;
  this.lastArtUrl = url;
  void extractPalette(url).then((p) => this.palette.set(p));
}
```

- `onSettingsChange(s: TvSettings)`: `this.settings.set(s); saveTvSettings(globalThis.localStorage, s); this.lyricsEngine.setOffsetMs(s.offsetMs);`
- `upNext` computed: `providerQueue().length > 0 ? providerQueue().slice(0,5) : upcoming().slice(0,5).map(i => ({name: i.track.name, artist: i.track.artist, albumArt: i.track.albumArt}))` — match field shapes to the actual `QueueListItem` (check the vendored type; adjust the mapping so it compiles).
- Template becomes a `@switch (settings().layout)` over the three layout components (all receive the input contract from C5) + `<app-tv-settings-panel [settings]="settings()" (settingsChange)="onSettingsChange($event)" />` + keep the existing error/loading branches.

- [ ] **Step 3: Verify** — `pnpm --filter @opendj-live/web build` AND `pnpm --filter @opendj-live/web test` green. Then rebuild the compose stack from `d:\Repositories\opendj-live`: `docker compose -f deploy/docker-compose.yml up --build -d` and eyeball `http://127.0.0.1:8888/tv/<slug>`: layout switcher works, sliders live-update, gear fades, karaoke dot bounces.
- [ ] **Step 4: Commit** — `feat(tv): design-pass TV page with layouts, theming, settings, karaoke`

---

## Self-review notes

- Spec §2 coverage: layouts (C5+C6 switch), theming (C2+C6), settings panel (C1+C4+C6, persisted, TV-only), karaoke words + dot + rAF (C3+C6, guest untouched). Fonts gap discovered during planning → folded into C6.
- Engine field names verified against `packages/frontend/src/lyrics/LyricsEngine.ts` (state shape) and `packages/core/src/types/index.ts` (`albumArt`, `durationMs`).
- C5 intentionally references the design JSX by line range instead of inlining ~600 lines of ported template: the JSX is the canonical pixel spec and is available read-only to implementers; the data-mapping table + input contract are what the JSX cannot tell them.
