/**
 * Guest request page — the main flow for the public OSS template.
 *
 * URL: `/u/:slug`. The user lands here from a QR code on the host's device.
 *
 * Flow:
 * 1. Resolve session by `qrSlug` (public read, no auth)
 * 2. Get-or-create local fingerprint, call `/sessions/:id/guest/identity`
 *    to acquire a slot token
 * 3. Show the live queue + a request form
 * 4. Subscribe to `/sessions/:id/realtime` for queue + now-playing updates
 *
 * MVP scope: track-URI input is manual (Spotify URI / track URL). A real
 * search picker layers in once the backend exposes a search proxy route.
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
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import {
  ApiError,
  RealtimeClient,
  type GuestIdentityResponse,
  type QueueItemSummaryWire,
  type SessionWire,
} from '@opendj/frontend';
import { getOrCreateGuestFingerprint } from '../services/guest-fingerprint.js';
import { OpenDjClientService } from '../services/opendj-client.service.js';

interface DraftRequest {
  trackUri: string;
  trackName: string;
  artistName: string;
}

@Component({
  selector: 'app-guest-request',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="guest">
      @if (loadError()) {
        <section class="card error">
          <h1>Something went wrong</h1>
          <p>{{ loadError() }}</p>
        </section>
      } @else if (!session()) {
        <section class="card loading"><p>Loading session…</p></section>
      } @else {
        <header class="card session-header">
          <p class="eyebrow">You're at</p>
          <h1>{{ session()!.name }}</h1>
          @if (slot(); as s) {
            @if (s.queued) {
              <p class="status">You're in line — position {{ s.queuePosition }}.</p>
            } @else {
              <p class="status active">You're in!</p>
            }
          }
        </header>

        <section class="card request-form">
          <h2>Request a track</h2>
          <form (ngSubmit)="submitRequest()" #f="ngForm">
            <label>
              <span>Spotify URI or URL</span>
              <input
                type="text"
                name="trackUri"
                [(ngModel)]="draft.trackUri"
                placeholder="spotify:track:…"
                autocomplete="off"
                required
              />
            </label>
            <label>
              <span>Track name</span>
              <input type="text" name="trackName" [(ngModel)]="draft.trackName" required />
            </label>
            <label>
              <span>Artist</span>
              <input type="text" name="artistName" [(ngModel)]="draft.artistName" required />
            </label>
            <button type="submit" [disabled]="submitting() || !slot() || slot()!.queued">
              {{ submitting() ? 'Submitting…' : 'Submit' }}
            </button>
            @if (submitError()) {
              <p class="form-error">{{ submitError() }}</p>
            }
          </form>
        </section>

        <section class="card queue-list">
          <h2>The queue</h2>
          @if (queue().length === 0) {
            <p class="empty">Nothing queued yet — be the first.</p>
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
                  <span class="status-pill">{{ statusLabel(item.status) }}</span>
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
        font-family:
          'Inter',
          -apple-system,
          BlinkMacSystemFont,
          'Segoe UI',
          Roboto,
          sans-serif;
      }
      .guest {
        max-width: 520px;
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
      .card.error {
        border-color: #ec4899;
      }
      .session-header .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
        color: #a294c5;
        margin: 0 0 4px;
      }
      .session-header h1 {
        font-family: 'Syne', 'Inter', sans-serif;
        font-size: 28px;
        margin: 0 0 8px;
        background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .session-header .status {
        margin: 0;
        font-size: 14px;
        color: #a294c5;
      }
      .session-header .status.active {
        color: #34d399;
      }
      h2 {
        font-family: 'Syne', 'Inter', sans-serif;
        font-size: 18px;
        margin: 0 0 12px;
      }
      form {
        display: grid;
        gap: 12px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 13px;
        color: #c8b8e9;
      }
      input {
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid #2c2440;
        background: #0c0a14;
        color: #f3eef9;
        font-family: inherit;
        font-size: 14px;
      }
      input:focus {
        outline: 2px solid #a855f7;
        outline-offset: 1px;
      }
      button[type='submit'] {
        margin-top: 4px;
        padding: 12px;
        border-radius: 10px;
        border: 0;
        background: linear-gradient(135deg, #a855f7, #ec4899);
        color: white;
        font-weight: 600;
        font-size: 15px;
        cursor: pointer;
      }
      button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .form-error {
        margin: 0;
        color: #fda4af;
        font-size: 13px;
      }
      .queue-list ul {
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
      .meta .title {
        font-weight: 600;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }
      .meta .artist {
        color: #a294c5;
        font-size: 13px;
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
    `,
  ],
})
export class GuestRequestPage {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clientService = inject(OpenDjClientService);

  readonly session: WritableSignal<SessionWire | null> = signal(null);
  readonly slot: WritableSignal<GuestIdentityResponse | null> = signal(null);
  readonly queue: WritableSignal<ReadonlyArray<QueueItemSummaryWire>> = signal([]);
  readonly loadError = signal<string | null>(null);
  readonly submitError = signal<string | null>(null);
  readonly submitting = signal(false);

  /** Hide rejected/removed items from the public list. */
  readonly visibleQueue = computed(() => this.queue().filter((i) => i.status !== 'rejected'));

  draft: DraftRequest = { trackUri: '', trackName: '', artistName: '' };

  private realtime: RealtimeClient | null = null;

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const slug = params.get('slug');
      if (!slug) {
        this.loadError.set('No session slug in URL.');
        return;
      }
      void this.bootstrap(slug);
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

  async submitRequest(): Promise<void> {
    const session = this.session();
    const slot = this.slot();
    if (!session || !slot) return;
    this.submitError.set(null);
    this.submitting.set(true);
    try {
      await this.clientService.client.queue.request(session.id, slot.slotToken, {
        trackUri: this.draft.trackUri.trim(),
        trackName: this.draft.trackName.trim(),
        artistName: this.draft.artistName.trim(),
      });
      this.draft = { trackUri: '', trackName: '', artistName: '' };
      await this.refreshQueue();
    } catch (err) {
      this.submitError.set(this.errorMessage(err, 'Could not submit request.'));
    } finally {
      this.submitting.set(false);
    }
  }

  private async bootstrap(slug: string): Promise<void> {
    try {
      const session = await this.clientService.client.sessions.getBySlug(slug);
      this.session.set(session);
      const slot = await this.clientService.client.guest.identity(session.id, {
        fingerprint: getOrCreateGuestFingerprint(),
      });
      this.slot.set(slot);
      await this.refreshQueue();
      this.openRealtime(session.id);
    } catch (err) {
      this.loadError.set(this.errorMessage(err, 'Could not load this session.'));
    }
  }

  private async refreshQueue(): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      const items = await this.clientService.client.queue.list(session.id);
      this.queue.set(items);
    } catch {
      // Queue list errors are non-fatal — keep what we have, the realtime
      // stream will catch us up on next event.
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

  private errorMessage(err: unknown, fallback: string): string {
    if (err instanceof ApiError) return `${fallback} (${err.code})`;
    return fallback;
  }
}
