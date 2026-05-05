/**
 * Compact "recently played" strip — read-only list of the last few tracks
 * that actually played, most recent first. Backed by `SessionSnapshot.recentlyPlayed`
 * which the backend rolls on each `now_playing.updated` event.
 *
 * Used by the guest page (small list under the queue) and the TV view.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import type { NowPlayingTrack } from '@opendj/core';

@Component({
  selector: 'app-recently-played-list',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tracks.length === 0) {
      @if (showEmptyHint) {
        <p class="empty">{{ emptyText }}</p>
      }
    } @else {
      <ul class="list">
        @for (t of displayed(); track t.uri) {
          <li class="row">
            @if (t.albumArt) {
              <img class="art" [src]="t.albumArt" alt="" />
            } @else {
              <span class="art empty" aria-hidden="true">♪</span>
            }
            <span class="meta">
              <span class="name">{{ t.name }}</span>
              <span class="artist">{{ t.artist }}</span>
            </span>
          </li>
        }
      </ul>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      ul.list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .row {
        display: grid;
        grid-template-columns: 32px 1fr;
        gap: 10px;
        align-items: center;
        padding: 6px 0;
      }
      .art {
        width: 32px;
        height: 32px;
        border-radius: 4px;
        object-fit: cover;
        background: #0c0a14;
      }
      .art.empty {
        display: grid;
        place-items: center;
        color: #6e5e8a;
        font-size: 14px;
      }
      .meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .name {
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .artist {
        font-size: 11px;
        color: #a294c5;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .empty {
        margin: 0;
        font-size: 12px;
        color: #6e5e8a;
        font-style: italic;
      }
    `,
  ],
})
export class RecentlyPlayedListComponent {
  @Input() tracks: ReadonlyArray<NowPlayingTrack> = [];
  /** Cap visible rows (the snapshot already caps at 10 — this is for compact spots). */
  @Input() max = 5;
  @Input() showEmptyHint = false;
  @Input() emptyText = 'Nothing played yet.';

  protected displayed(): ReadonlyArray<NowPlayingTrack> {
    return this.tracks.slice(0, this.max);
  }
}
