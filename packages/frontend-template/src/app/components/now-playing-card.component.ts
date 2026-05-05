/**
 * Reusable now-playing card. Shows album art, track + artist, an optional
 * progress bar (locally interpolated between server ticks), and optional
 * Skip / Pause / Resume buttons for the host.
 *
 * Inputs:
 *  - `track`            current `NowPlayingTrack` from the realtime snapshot
 *  - `lastUpdatedAtMs`  wall-clock ms when the parent received `track` —
 *                       used to interpolate progress between events
 *  - `showControls`     when true, renders the host control row (parent
 *                       wires Skip/Pause/Resume via the @Output emitters)
 *  - `controlsBusy`     disables buttons while a control call is in flight
 *
 * Outputs:
 *  - `skip` / `togglePlay` — fired on button click. Parent decides whether
 *    `togglePlay` calls `client.playback.pause` or `resume` based on the
 *    current `isPlaying` flag.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  EventEmitter,
  inject,
  Input,
  Output,
  signal,
} from '@angular/core';
import type { NowPlayingTrack } from '@opendj/core';

@Component({
  selector: 'app-now-playing-card',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (track) {
      <article
        class="card"
        [class.paused]="!track.isPlaying"
        [attr.data-testid]="'now-playing-card'"
      >
        <div class="art">
          @if (track.albumArt) {
            <img [src]="track.albumArt" [alt]="track.name" />
          } @else {
            <div class="art-placeholder" aria-hidden="true">♪</div>
          }
        </div>
        <div class="meta">
          <p class="eyebrow">{{ track.isPlaying ? 'Now playing' : 'Paused' }}</p>
          <h3 class="title">{{ track.name }}</h3>
          <p class="artist">{{ track.artist }}</p>
          <div class="progress">
            <div class="progress-bar">
              <div class="progress-fill" [style.width.%]="progressPercent()"></div>
            </div>
            <span class="time">
              {{ fmt(displayProgressMs()) }} <span class="time-sep">/</span>
              {{ fmt(track.durationMs) }}
            </span>
          </div>
        </div>
        @if (showControls) {
          <div class="controls">
            <button
              type="button"
              class="ghost"
              (click)="togglePlay.emit()"
              [disabled]="controlsBusy"
              [attr.aria-label]="track.isPlaying ? 'Pause playback' : 'Resume playback'"
            >
              {{ track.isPlaying ? 'Pause' : 'Play' }}
            </button>
            <button
              type="button"
              class="ghost"
              (click)="skip.emit()"
              [disabled]="controlsBusy"
              aria-label="Skip to next"
            >
              Skip
            </button>
          </div>
        }
      </article>
    } @else {
      <article class="card empty" [attr.data-testid]="'now-playing-empty'">
        <div class="empty-mark" aria-hidden="true">♫</div>
        <p>Nothing playing yet — connect a device + start a track.</p>
      </article>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        display: grid;
        grid-template-columns: 64px 1fr;
        gap: 16px;
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 14px;
        padding: 16px;
        align-items: center;
      }
      .card.paused {
        opacity: 0.7;
      }
      .card.empty {
        grid-template-columns: 1fr;
        text-align: center;
        color: #a294c5;
        font-size: 13px;
        padding: 24px;
      }
      .empty-mark {
        font-size: 28px;
        opacity: 0.5;
        margin-bottom: 4px;
      }
      .art {
        width: 64px;
        height: 64px;
        border-radius: 8px;
        overflow: hidden;
        background: #0c0a14;
      }
      .art img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .art-placeholder {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        color: #6e5e8a;
        font-size: 24px;
      }
      .meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .eyebrow {
        margin: 0;
        font-size: 10px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #a294c5;
      }
      .title {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .artist {
        margin: 0;
        font-size: 12px;
        color: #c8b8e9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .progress {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 4px;
      }
      .progress-bar {
        flex: 1;
        height: 4px;
        background: #2c2440;
        border-radius: 2px;
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #a855f7, #ec4899);
        transition: width 250ms linear;
      }
      .time {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 10px;
        color: #a294c5;
        white-space: nowrap;
      }
      .time-sep {
        opacity: 0.4;
      }
      .controls {
        grid-column: 1 / -1;
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 4px;
      }
      .ghost {
        background: transparent;
        border: 1px solid #2c2440;
        color: #c8b8e9;
        padding: 6px 14px;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
      }
      .ghost:hover:not(:disabled) {
        border-color: #a855f7;
      }
      .ghost:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ],
})
export class NowPlayingCardComponent {
  private readonly destroyRef = inject(DestroyRef);

  @Input() track: NowPlayingTrack | null = null;
  /** Wall clock when the parent received `track`. Used for local interpolation. */
  @Input() lastUpdatedAtMs = 0;
  @Input() showControls = false;
  @Input() controlsBusy = false;

  @Output() readonly skip = new EventEmitter<void>();
  @Output() readonly togglePlay = new EventEmitter<void>();

  /** Tick driven by setInterval — bumps every 250ms while a track is playing. */
  private readonly tick = signal(0);
  private intervalId: ReturnType<typeof setInterval> | null = null;

  readonly displayProgressMs = computed<number>(() => {
    // Subscribe to tick so the computed re-evaluates every frame.
    void this.tick();
    const t = this.track;
    if (!t) return 0;
    if (!t.isPlaying || this.lastUpdatedAtMs === 0) return t.progressMs;
    const elapsed = Date.now() - this.lastUpdatedAtMs;
    return Math.min(t.durationMs, t.progressMs + Math.max(0, elapsed));
  });

  readonly progressPercent = computed<number>(() => {
    const t = this.track;
    if (!t || !t.durationMs) return 0;
    return Math.min(100, Math.max(0, (this.displayProgressMs() / t.durationMs) * 100));
  });

  constructor() {
    // Start/stop the local 250ms ticker based on whether a playing track is
    // bound. Effect re-runs whenever the inputs change.
    effect(() => {
      const t = this.track;
      const shouldTick = !!t && t.isPlaying;
      if (shouldTick && !this.intervalId) {
        this.intervalId = setInterval(() => this.tick.set(this.tick() + 1), 250);
      } else if (!shouldTick && this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    });
    this.destroyRef.onDestroy(() => {
      if (this.intervalId) clearInterval(this.intervalId);
    });
  }

  protected fmt(ms: number): string {
    if (ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }
}
