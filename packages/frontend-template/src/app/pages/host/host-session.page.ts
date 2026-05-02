/**
 * /host/sessions/:id — host queue moderation + end-session control.
 *
 * Pulls the queue from `/api/v1/sessions/:id/queue`, subscribes to realtime
 * updates, and exposes approve/reject buttons that call PATCH /:itemId
 * with `{ decision }`. End-session calls DELETE /:id.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
  ApiError,
  RealtimeClient,
  type QueueItemSummaryWire,
  type SessionWire,
} from '@opendj/frontend';
import { OpenDjClientService } from '../../services/opendj-client.service.js';

@Component({
  selector: 'app-host-session',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      @if (loadError()) {
        <p class="error">{{ loadError() }}</p>
      } @else if (!session()) {
        <p class="loading">Loading…</p>
      } @else {
        <header class="card">
          <div>
            <p class="eyebrow">Session</p>
            <h1>{{ session()!.name }}</h1>
            <p class="slug">
              Guest URL:
              <code>{{ guestUrl() }}</code>
            </p>
          </div>
          <button
            type="button"
            class="end"
            [disabled]="ending() || session()!.endedAt"
            (click)="endSession()"
          >
            {{ session()!.endedAt ? 'Ended' : ending() ? 'Ending…' : 'End session' }}
          </button>
        </header>

        <section class="queue card">
          <h2>Queue</h2>
          @if (visibleQueue().length === 0) {
            <p class="empty">Queue is empty. Send guests to the URL above.</p>
          } @else {
            <ul>
              @for (item of visibleQueue(); track item.id) {
                <li class="queue-item" [attr.data-status]="item.status">
                  @if (item.albumArtUrl) {
                    <img class="art" [src]="item.albumArtUrl" alt="" />
                  } @else {
                    <div class="art placeholder" aria-hidden="true"></div>
                  }
                  <div class="meta">
                    <span class="title">{{ item.trackName }}</span>
                    <span class="artist">{{ item.artistName }}</span>
                  </div>
                  <div class="actions">
                    <span class="status-pill">{{ statusLabel(item.status) }}</span>
                    @if (item.status === 'pending') {
                      <button type="button" class="approve" (click)="moderate(item.id, 'approved')">
                        Approve
                      </button>
                      <button type="button" class="reject" (click)="moderate(item.id, 'rejected')">
                        Reject
                      </button>
                    }
                  </div>
                </li>
              }
            </ul>
          }
        </section>
      }
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
        background: #0c0a14;
        color: #f3eef9;
        min-height: 100dvh;
        font-family: 'Inter', sans-serif;
      }
      main {
        max-width: 720px;
        margin: 0 auto;
        padding: 24px 16px 96px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .card {
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 14px;
        padding: 20px;
      }
      header.card {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
        color: #a294c5;
        margin: 0 0 4px;
      }
      h1 {
        font-family: 'Syne', 'Inter', sans-serif;
        margin: 0 0 8px;
        font-size: 24px;
        background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .slug {
        margin: 0;
        font-size: 13px;
        color: #a294c5;
      }
      code {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        background: #0c0a14;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 12px;
      }
      h2 {
        font-family: 'Syne', 'Inter', sans-serif;
        font-size: 18px;
        margin: 0 0 12px;
      }
      button {
        font: inherit;
        cursor: pointer;
        border-radius: 8px;
        padding: 6px 12px;
        border: 0;
        font-size: 13px;
      }
      button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .end {
        padding: 10px 16px;
        background: #2c2440;
        color: #fda4af;
        border: 1px solid #fda4af;
      }
      .end:hover:not([disabled]) {
        background: #fda4af;
        color: #1a0a14;
      }
      .approve {
        background: linear-gradient(135deg, #34d399, #10b981);
        color: #042f2e;
        font-weight: 600;
      }
      .reject {
        background: #2c2440;
        color: #fda4af;
        border: 1px solid #fda4af;
      }
      .queue ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .queue-item {
        display: grid;
        grid-template-columns: 48px 1fr auto;
        gap: 12px;
        align-items: center;
      }
      .art {
        width: 48px;
        height: 48px;
        border-radius: 6px;
        background: #2c2440;
        object-fit: cover;
      }
      .meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .title {
        font-weight: 600;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }
      .artist {
        color: #a294c5;
        font-size: 13px;
      }
      .actions {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .status-pill {
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 999px;
        background: #2c2440;
        color: #c8b8e9;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .queue-item[data-status='playing'] .status-pill {
        background: linear-gradient(135deg, #a855f7, #ec4899);
        color: white;
      }
      .empty {
        margin: 0;
        color: #a294c5;
        font-style: italic;
      }
      .error {
        color: #fda4af;
      }
      .loading {
        color: #a294c5;
      }
    `,
  ],
})
export class HostSessionPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly client = inject(OpenDjClientService);
  private readonly destroyRef = inject(DestroyRef);

  readonly session: WritableSignal<SessionWire | null> = signal(null);
  readonly queue: WritableSignal<ReadonlyArray<QueueItemSummaryWire>> = signal([]);
  readonly loadError = signal<string | null>(null);
  readonly ending = signal(false);

  readonly visibleQueue = computed(() => this.queue().filter((i) => i.status !== 'rejected'));
  readonly guestUrl = computed(() => {
    const s = this.session();
    if (!s) return '';
    if (typeof globalThis.location === 'undefined') return `/u/${s.qrSlug}`;
    return `${globalThis.location.origin}/u/${s.qrSlug}`;
  });

  private realtime: RealtimeClient | null = null;

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      const id = p.get('id');
      if (id) void this.bootstrap(id);
    });
    this.destroyRef.onDestroy(() => this.realtime?.close());
  }

  statusLabel(status: QueueItemSummaryWire['status']): string {
    switch (status) {
      case 'pending':
        return 'pending';
      case 'approved':
      case 'queued':
        return 'queued';
      case 'playing':
        return 'now playing';
      default:
        return status;
    }
  }

  async moderate(itemId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.client.client.queue.moderate(session.id, itemId, { decision });
      await this.refreshQueue();
    } catch {
      // Surface as a banner later — for now just no-op so a stale UI doesn't lie.
    }
  }

  async endSession(): Promise<void> {
    const session = this.session();
    if (!session) return;
    if (!confirm(`End "${session.name}"? Guests will see "session ended."`)) return;
    this.ending.set(true);
    try {
      const ended = await this.client.client.sessions.end(session.id);
      this.session.set(ended);
      await this.router.navigate(['/host/dashboard']);
    } catch (err) {
      if (err instanceof ApiError) {
        this.loadError.set(`Could not end session (${err.code}).`);
      }
    } finally {
      this.ending.set(false);
    }
  }

  private async bootstrap(sessionId: string): Promise<void> {
    try {
      const session = await this.client.client.sessions.getById(sessionId);
      this.session.set(session);
      await this.refreshQueue();
      this.openRealtime(session.id);
    } catch (err) {
      if (err instanceof ApiError && err.is('session_not_found')) {
        this.loadError.set('Session not found.');
      } else {
        this.loadError.set('Could not load session.');
      }
    }
  }

  private async refreshQueue(): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      const items = await this.client.client.queue.list(session.id);
      this.queue.set(items);
    } catch {
      // non-fatal — realtime stream will catch us up
    }
  }

  private openRealtime(sessionId: string): void {
    if (typeof globalThis.WebSocket === 'undefined') return;
    const protocol = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = globalThis.location?.host ?? '';
    if (!host) return;
    this.realtime = new RealtimeClient({
      url: `${protocol}//${host}/api/v1/sessions/${encodeURIComponent(sessionId)}/realtime`,
    });
    const off = this.realtime.onEvent(() => void this.refreshQueue());
    this.destroyRef.onDestroy(off);
    this.realtime.connect();
  }
}
