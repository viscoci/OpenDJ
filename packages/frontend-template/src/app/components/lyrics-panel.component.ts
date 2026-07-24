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
