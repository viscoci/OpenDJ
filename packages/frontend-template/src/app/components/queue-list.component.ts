/**
 * Queue list — renders a flat list of queue items. Optional moderation
 * actions (approve / reject) for the host, optional remove + skip-vote
 * for guests. Used by both the guest page and the host session page.
 *
 * Inputs:
 *  - `items`              array of queue items to render
 *  - `mode`               'guest' (read-only + skip-vote) or
 *                         'host' (approve/reject/remove visible)
 *  - `currentGuestId`     when set, "remove" affordance shows on owned items
 *  - `voteThreshold`      threshold to display in the SkipVote pill
 *  - `votedItemIds`       set of item IDs the current guest has voted on
 *
 * Outputs: `approve`, `reject`, `remove`, `voteSkip` — all carry itemId.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import type { QueueItemStatus } from '@opendj/core';

/**
 * Loose view-model that satisfies both `QueueItemSummary` (realtime,
 * epoch-ms timestamps) and `QueueItemSummaryWire` (HTTP, ISO-string
 * timestamps). The component only renders the fields below — keeping a
 * structural type lets parent code feed it either shape without mapping.
 */
export interface QueueListItem {
  id: string;
  guestId: string;
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs: number | null;
  status: QueueItemStatus;
  skipVotes: number;
}

export type QueueListMode = 'guest' | 'host';

@Component({
  selector: 'app-queue-list',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (items.length === 0) {
      <p class="empty">{{ emptyText }}</p>
    } @else {
      <ul class="queue">
        @for (item of items; track item.id) {
          <li class="row" [attr.data-status]="item.status">
            <div class="meta">
              <span class="name">{{ item.trackName }}</span>
              <span class="artist">{{ item.artistName }}</span>
              @if (mode === 'host' && item.status === 'pending') {
                <span class="badge pending">Pending review</span>
              }
            </div>
            <div class="actions">
              @if (mode === 'host' && item.status === 'pending') {
                <button type="button" class="primary" (click)="approve.emit(item.id)">
                  Approve
                </button>
                <button type="button" class="danger" (click)="reject.emit(item.id)">Reject</button>
              }
              @if (mode === 'host' && item.status !== 'pending' && item.status !== 'rejected') {
                <button type="button" class="ghost" (click)="remove.emit(item.id)">Remove</button>
              }
              @if (mode === 'guest' && showSkipVote && item.status === 'queued') {
                <button
                  type="button"
                  class="vote-pill"
                  [class.voted]="hasVoted(item.id)"
                  (click)="voteSkip.emit(item.id)"
                  [disabled]="hasVoted(item.id)"
                >
                  ▶| {{ item.skipVotes ?? 0 }}<span class="sep">/</span>{{ voteThreshold }}
                </button>
              }
              @if (mode === 'guest' && currentGuestId && item.guestId === currentGuestId) {
                <button type="button" class="ghost" (click)="remove.emit(item.id)">Remove</button>
              }
            </div>
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
      ul.queue {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 12px;
        padding: 10px 14px;
      }
      .row[data-status='rejected'] {
        opacity: 0.5;
      }
      .meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .name {
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .artist {
        font-size: 12px;
        color: #c8b8e9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .badge {
        align-self: flex-start;
        margin-top: 4px;
        font-size: 10px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 2px 6px;
        border-radius: 999px;
      }
      .badge.pending {
        background: rgba(245, 158, 11, 0.12);
        color: #f59e0b;
      }
      .actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }
      button {
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        border-radius: 999px;
        padding: 6px 12px;
        white-space: nowrap;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .primary {
        background: linear-gradient(135deg, #34d399, #10b981);
        border: 0;
        color: #042f2e;
      }
      .danger {
        background: transparent;
        border: 1px solid rgba(239, 68, 68, 0.4);
        color: #fda4af;
      }
      .ghost {
        background: transparent;
        border: 1px solid #2c2440;
        color: #c8b8e9;
      }
      .vote-pill {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #c8b8e9;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 11px;
      }
      .vote-pill.voted {
        background: linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(236, 72, 153, 0.2));
        border-color: rgba(168, 85, 247, 0.4);
        color: #fff;
      }
      .vote-pill .sep {
        color: rgba(200, 184, 233, 0.5);
      }
      .empty {
        margin: 0;
        font-size: 13px;
        color: #a294c5;
        font-style: italic;
        text-align: center;
        padding: 24px 0;
      }
    `,
  ],
})
export class QueueListComponent {
  @Input() items: ReadonlyArray<QueueListItem> = [];
  @Input() mode: QueueListMode = 'guest';
  @Input() currentGuestId: string | null = null;
  @Input() voteThreshold = 5;
  @Input() votedItemIds: ReadonlySet<string> = new Set();
  @Input() showSkipVote = true;
  @Input() emptyText = 'No tracks queued yet — be the first.';

  @Output() readonly approve = new EventEmitter<string>();
  @Output() readonly reject = new EventEmitter<string>();
  @Output() readonly remove = new EventEmitter<string>();
  @Output() readonly voteSkip = new EventEmitter<string>();

  protected hasVoted(itemId: string): boolean {
    return this.votedItemIds.has(itemId);
  }
}
