/**
 * /tv/:slug — public, fullscreen "cast to a room screen" view.
 *
 * Pulls a one-shot snapshot via `client.sessions.tvSnapshot(slug)` so the
 * page paints immediately without a WS handshake, then opens the realtime
 * stream for delta events. Read-only — no controls, no auth.
 *
 * Intentionally minimal — a working "cast to TV" page covering the
 * essentials (now-playing, QR to join, Up Next). Polished layouts
 * (overlay/centered/split lyrics, custom backdrops, branding) are out of
 * scope here and left to downstream consumers.
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
import { ActivatedRoute } from '@angular/router';
import {
  LyricsEngine,
  RealtimeClient,
  type LyricsEngineState,
  type SessionWire,
} from '@opendj/frontend';
import type { NowPlayingTrack, Track } from '@opendj/core';
import type { SessionEvent, SessionSnapshot } from '@opendj/realtime';
import { LyricsPanelComponent } from '../components/lyrics-panel.component.js';
import { NowPlayingCardComponent } from '../components/now-playing-card.component.js';
import { QrCodeComponent } from '../components/qr-code.component.js';
import { QueueListComponent, type QueueListItem } from '../components/queue-list.component.js';
import { OpenDjClientService } from '../services/opendj-client.service.js';

@Component({
  selector: 'app-tv',
  standalone: true,
  imports: [
    CommonModule,
    LyricsPanelComponent,
    NowPlayingCardComponent,
    QrCodeComponent,
    QueueListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loadError()) {
      <main class="tv error">
        <h1>Couldn't load this session</h1>
        <p>{{ loadError() }}</p>
      </main>
    } @else if (!session()) {
      <main class="tv loading"><p>Loading…</p></main>
    } @else {
      <main class="tv">
        <header class="tv-header">
          <p class="brand">OpenDJ</p>
          <p class="event">{{ session()!.name }}</p>
          <p class="clock">{{ clockText() }}</p>
        </header>
        <section class="tv-main">
          <div class="now-playing">
            <app-now-playing-card [track]="nowPlaying()" [lastUpdatedAtMs]="nowPlayingAt()" />
            <app-lyrics-panel [state]="lyricsState()" variant="tv" />
          </div>
          <aside class="sidebar">
            <div class="qr-card">
              <p class="qr-eyebrow">Scan to request</p>
              <app-qr-code [value]="guestUrl()" [size]="220" />
              <p class="qr-url">{{ guestUrl() }}</p>
            </div>
            <div class="queue">
              <p class="queue-eyebrow">Up next</p>
              @if (providerQueue().length > 0) {
                <ul class="up-next-list">
                  @for (track of providerQueue().slice(0, 8); track track.uri) {
                    <li class="up-next-row">
                      @if (track.albumArt) {
                        <img class="art" [src]="track.albumArt" alt="" />
                      } @else {
                        <span class="art empty" aria-hidden="true">♪</span>
                      }
                      <span class="meta">
                        <span class="name">{{ track.name }}</span>
                        <span class="artist">{{ track.artist }}</span>
                      </span>
                    </li>
                  }
                </ul>
              } @else {
                <app-queue-list
                  [items]="upcoming()"
                  mode="guest"
                  [showSkipVote]="false"
                  emptyText="No tracks queued yet."
                />
              }
            </div>
          </aside>
        </section>
        <footer class="tv-footer">
          <span>{{ activeGuestCount() }} listening</span>
          <span class="separator">·</span>
          <span>{{ queueCount() }} queued</span>
          <span class="separator">·</span>
          <span class="brand-mark">opendj</span>
        </footer>
      </main>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        background: #05050b;
        color: #f0efff;
        min-height: 100vh;
        font-family: 'Inter', sans-serif;
      }
      .tv {
        display: grid;
        grid-template-rows: 64px 1fr 56px;
        height: 100vh;
        max-width: 100vw;
        padding: 0;
        gap: 0;
        background:
          radial-gradient(60% 80% at 20% 0%, rgba(168, 85, 247, 0.18), transparent 70%),
          radial-gradient(60% 80% at 80% 100%, rgba(236, 72, 153, 0.16), transparent 70%);
      }
      .tv.loading,
      .tv.error {
        display: grid;
        place-items: center;
        text-align: center;
        padding: 32px;
      }
      .tv-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 32px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .brand {
        margin: 0;
        font-family: 'Syne', 'Inter', sans-serif;
        font-weight: 700;
        font-size: 22px;
        background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .event {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: #fff;
      }
      .clock {
        margin: 0;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 18px;
        color: #c8b8e9;
      }
      .tv-main {
        display: grid;
        grid-template-columns: 1fr 380px;
        gap: 32px;
        padding: 32px;
        min-height: 0;
      }
      .now-playing {
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 24px;
        padding: 32px;
        display: grid;
        place-items: center;
      }
      .now-playing app-now-playing-card {
        width: 100%;
        font-size: 1.4em;
      }
      .sidebar {
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-height: 0;
      }
      .qr-card {
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 16px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      }
      .qr-eyebrow {
        margin: 0;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: #a294c5;
      }
      .qr-url {
        margin: 0;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 11px;
        color: #c8b8e9;
        word-break: break-all;
        text-align: center;
      }
      .queue {
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 16px;
        padding: 16px;
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      .queue-eyebrow {
        margin: 0 0 12px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: #a294c5;
      }
      .tv-footer {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 32px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        font-size: 13px;
        color: #c8b8e9;
      }
      .separator {
        color: rgba(200, 184, 233, 0.4);
      }
      .brand-mark {
        margin-left: auto;
        font-family: 'Syne', 'Inter', sans-serif;
        font-weight: 600;
        background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .up-next-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .up-next-row {
        display: grid;
        grid-template-columns: 36px 1fr;
        gap: 10px;
        align-items: center;
      }
      .up-next-row .art {
        width: 36px;
        height: 36px;
        border-radius: 4px;
        object-fit: cover;
        background: #0c0a14;
      }
      .up-next-row .art.empty {
        display: grid;
        place-items: center;
        color: #6e5e8a;
      }
      .up-next-row .meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .up-next-row .name {
        font-size: 14px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .up-next-row .artist {
        font-size: 12px;
        color: #c8b8e9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `,
  ],
})
export class TvPage {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clientService = inject(OpenDjClientService);

  readonly session: WritableSignal<SessionWire | null> = signal(null);
  readonly nowPlaying: WritableSignal<NowPlayingTrack | null> = signal(null);
  readonly nowPlayingAt = signal(0);
  readonly upcoming: WritableSignal<ReadonlyArray<QueueListItem>> = signal([]);
  readonly providerQueue: WritableSignal<ReadonlyArray<Track>> = signal([]);
  readonly activeGuestCount = signal(0);
  readonly loadError = signal<string | null>(null);
  readonly clockText = signal(formatClock(new Date()));

  readonly queueCount = computed(() => this.upcoming().length);

  readonly guestUrl = computed(() => {
    const s = this.session();
    if (!s) return '';
    if (typeof globalThis.location === 'undefined') return `/u/${s.qrSlug}`;
    return `${globalThis.location.origin}/u/${s.qrSlug}`;
  });

  private realtime: RealtimeClient | null = null;
  private clockInterval: ReturnType<typeof setInterval> | null = null;
  private readonly lyricsEngine = new LyricsEngine({ prevCount: 1, nextCount: 2 });
  readonly lyricsState = signal<LyricsEngineState | null>(null);
  private lyricsInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      const slug = p.get('slug');
      if (slug) void this.bootstrap(slug);
    });
    this.clockInterval = setInterval(() => {
      this.clockText.set(formatClock(new Date()));
    }, 30_000);
    this.lyricsInterval = setInterval(() => {
      this.lyricsState.set(this.lyricsEngine.computeState());
    }, 250);
    this.destroyRef.onDestroy(() => {
      this.realtime?.close();
      if (this.clockInterval) clearInterval(this.clockInterval);
      if (this.lyricsInterval) clearInterval(this.lyricsInterval);
    });
  }

  private async bootstrap(slug: string): Promise<void> {
    try {
      const snap = await this.clientService.client.sessions.tvSnapshot(slug);
      this.session.set(snap.session);
      this.nowPlaying.set(snap.nowPlaying);
      this.nowPlayingAt.set(Date.now());
      this.upcoming.set(snap.queue);
      this.activeGuestCount.set(snap.activeGuestCount);
      this.openRealtime(snap.session.id);
    } catch {
      this.loadError.set('Session not found, or not yet live.');
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
    this.realtime.onSnapshot((snapshot: SessionSnapshot) => {
      this.nowPlaying.set(snapshot.nowPlaying);
      this.nowPlayingAt.set(Date.now());
      this.upcoming.set(snapshot.queue);
      this.providerQueue.set(snapshot.providerQueue);
      this.activeGuestCount.set(snapshot.activeGuestCount);
      this.lyricsEngine.applySnapshot(snapshot);
    });
    this.realtime.on('now_playing.updated', (event) => {
      this.nowPlaying.set(event.track);
      this.nowPlayingAt.set(Date.now());
    });
    this.realtime.on('provider_queue.updated', (event) => {
      this.providerQueue.set(event.tracks);
    });
    this.realtime.on('guest_slots.updated', (event) => {
      this.activeGuestCount.set(event.activeCount);
    });
    this.realtime.onEvent((event: SessionEvent) => {
      this.lyricsEngine.applyEvent(event);
      // Refresh the queue on any queue mutation. The polished hosted
      // version applies the delta directly; OSS keeps it simple.
      if (
        event.type === 'queue.item_requested' ||
        event.type === 'queue.item_approved' ||
        event.type === 'queue.item_rejected' ||
        event.type === 'queue.item_removed'
      ) {
        void this.refreshQueue();
      }
    });
    this.realtime.connect();
  }

  private async refreshQueue(): Promise<void> {
    const s = this.session();
    if (!s) return;
    try {
      const items = await this.clientService.client.queue.list(s.id);
      // Filter to publicly-visible queued/playing items for the cast view.
      this.upcoming.set(
        items.filter(
          (i) => i.status === 'approved' || i.status === 'queued' || i.status === 'playing',
        ),
      );
    } catch {
      // non-fatal
    }
  }
}

function formatClock(date: Date): string {
  const h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
