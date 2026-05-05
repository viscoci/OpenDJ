/**
 * Guest request page — the main flow for the public OSS template.
 *
 * URL: `/u/:slug`. The user lands here from the host's QR code.
 *
 * Flow:
 * 1. Resolve session by `qrSlug` (public read, no auth)
 * 2. Get-or-create local fingerprint, call `/guest/identity` to acquire a
 *    session-scoped slot token
 * 3. Subscribe to `/sessions/:id/realtime` — seeds nowPlaying + queue +
 *    recentlyPlayed from the connect-time snapshot, then keeps state in
 *    sync via deltas
 * 4. Type into the search box → debounced fetch via the search proxy →
 *    click a result → request the track
 *
 * The hand-rolled "paste a Spotify URI" form is gone — guests get the same
 * UX as opendj.live's design canvas without any of the polish work.
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
  type SearchResultWire,
  type SessionWire,
} from '@opendj/frontend';
import type { NowPlayingTrack, Track } from '@opendj/core';
import type { SessionEvent, SessionSnapshot } from '@opendj/realtime';
import { NowPlayingCardComponent } from '../components/now-playing-card.component.js';
import { QueueListComponent, type QueueListItem } from '../components/queue-list.component.js';
import { RecentlyPlayedListComponent } from '../components/recently-played-list.component.js';
import {
  SearchResultListComponent,
  type SearchStatus,
} from '../components/search-result-list.component.js';
import { getOrCreateGuestFingerprintHash } from '../services/guest-fingerprint.js';
import { OpenDjClientService } from '../services/opendj-client.service.js';

@Component({
  selector: 'app-guest-request',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NowPlayingCardComponent,
    QueueListComponent,
    RecentlyPlayedListComponent,
    SearchResultListComponent,
  ],
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
      } @else if (sessionEnded()) {
        <section class="card session-ended">
          <h1>This session has ended</h1>
          <p>Thanks for coming. The host has closed the queue.</p>
        </section>
      } @else {
        <header class="card session-header">
          <p class="eyebrow">You're at</p>
          <h1>{{ session()!.name }}</h1>
          @if (slot(); as s) {
            @if (s.status === 'active') {
              <p class="status active">You're in!</p>
            } @else {
              <p class="status">You're in line — position {{ s.queuePosition ?? '—' }}.</p>
            }
          }
        </header>

        <section class="card now-playing-section">
          <app-now-playing-card [track]="nowPlaying()" [lastUpdatedAtMs]="nowPlayingAt()" />
        </section>

        <section class="card request-form">
          <h2>Request a song</h2>
          <app-search-result-list
            [results]="searchResults()"
            [status]="searchStatus()"
            [errorMessage]="searchError()"
            [disabledReason]="searchDisabledReason()"
            [busy]="submitting()"
            placeholder="Song, artist, or album…"
            idleHint="Search the host's library — pick a track to add it to the queue."
            (query)="onQueryChange($event)"
            (pick)="onPick($event)"
          />
          @if (submitToast(); as toast) {
            <p class="toast" [class.error]="toast.kind === 'error'">{{ toast.message }}</p>
          }
        </section>

        @if (providerQueue().length > 0) {
          <section class="card queue-section">
            <h2>Up next</h2>
            <ul class="provider-queue">
              @for (track of providerQueue().slice(0, 6); track track.uri) {
                <li class="provider-queue-row">
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
          </section>
        }

        @if (visibleQueue().length > 0) {
          <section class="card queue-section">
            <h2>Guest requests</h2>
            <app-queue-list
              [items]="visibleQueue()"
              mode="guest"
              [voteThreshold]="session()!.voteSkipThreshold ?? 5"
              [votedItemIds]="votedItemIds()"
              (voteSkip)="onVoteSkip($event)"
              emptyText="Nothing queued yet — be the first."
            />
          </section>
        }

        @if (recentlyPlayed().length > 0) {
          <section class="card recently-played-section">
            <h2>Recently played</h2>
            <app-recently-played-list [tracks]="recentlyPlayed()" [max]="6" />
          </section>
        }
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
      .card.error,
      .card.session-ended {
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
      .now-playing-section {
        padding: 16px;
      }
      .toast {
        margin: 12px 0 0;
        font-size: 13px;
        color: #34d399;
      }
      .toast.error {
        color: #fda4af;
      }
      .provider-queue {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .provider-queue-row {
        display: grid;
        grid-template-columns: 36px 1fr;
        gap: 10px;
        align-items: center;
      }
      .provider-queue-row .art {
        width: 36px;
        height: 36px;
        border-radius: 4px;
        object-fit: cover;
        background: #0c0a14;
      }
      .provider-queue-row .art.empty {
        display: grid;
        place-items: center;
        color: #6e5e8a;
      }
      .provider-queue-row .meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .provider-queue-row .name {
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .provider-queue-row .artist {
        font-size: 11px;
        color: #a294c5;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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
  readonly queue: WritableSignal<ReadonlyArray<QueueListItem>> = signal([]);
  readonly nowPlaying: WritableSignal<NowPlayingTrack | null> = signal(null);
  readonly nowPlayingAt = signal(0);
  readonly recentlyPlayed: WritableSignal<ReadonlyArray<NowPlayingTrack>> = signal([]);
  readonly providerQueue: WritableSignal<ReadonlyArray<Track>> = signal([]);
  readonly loadError = signal<string | null>(null);
  readonly searchResults: WritableSignal<ReadonlyArray<SearchResultWire>> = signal([]);
  readonly searchStatus: WritableSignal<SearchStatus> = signal('idle');
  readonly searchError = signal<string | null>(null);
  readonly searchDisabledReason = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly submitToast: WritableSignal<{ kind: 'ok' | 'error'; message: string } | null> =
    signal(null);
  readonly votedItemIds = signal<ReadonlySet<string>>(new Set());

  readonly visibleQueue = computed(() =>
    this.queue().filter((i) => i.status !== 'rejected' && i.status !== 'pending'),
  );

  readonly sessionEnded = computed(() => {
    const s = this.session();
    return s !== null && s.endedAt !== null;
  });

  private realtime: RealtimeClient | null = null;
  private latestQuery = '';

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

  // ─── Search wiring (debounced via SearchResultListComponent) ───────────

  async onQueryChange(query: string): Promise<void> {
    this.latestQuery = query;
    if (!query) {
      this.searchResults.set([]);
      this.searchStatus.set('idle');
      this.searchError.set(null);
      return;
    }
    const session = this.session();
    if (!session) return;
    this.searchStatus.set('searching');
    this.searchError.set(null);
    try {
      const res = await this.clientService.client.queue.search(session.id, query, 20);
      // Drop stale responses if the user kept typing.
      if (this.latestQuery !== query) return;
      this.searchResults.set(res.results);
      this.searchStatus.set(res.results.length === 0 ? 'empty' : 'idle');
    } catch (err) {
      if (this.latestQuery !== query) return;
      const code = err instanceof ApiError ? err.code : 'error';
      if (code === 'no_provider_connected') {
        this.searchDisabledReason.set("The host hasn't connected a streaming service yet.");
        this.searchStatus.set('idle');
      } else if (code === 'search_not_supported') {
        this.searchDisabledReason.set("Search isn't available for this host's provider.");
        this.searchStatus.set('idle');
      } else {
        this.searchError.set('Search failed — try again.');
        this.searchStatus.set('error');
      }
    }
  }

  async onPick(result: SearchResultWire): Promise<void> {
    const session = this.session();
    const slot = this.slot();
    if (!session || !slot || slot.status !== 'active') return;
    this.submitting.set(true);
    this.submitToast.set(null);
    try {
      await this.clientService.client.queue.request(session.id, slot.slotToken, {
        uri: result.trackUri,
        name: result.trackName,
        artist: result.artistName,
        albumArt: result.albumArtUrl,
        durationMs: result.durationMs ?? 0,
      });
      this.submitToast.set({
        kind: 'ok',
        message: session.moderationEnabled
          ? 'Submitted for review.'
          : `Added "${result.trackName}" to the queue.`,
      });
      this.searchResults.set([]);
      this.latestQuery = '';
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'error';
      this.submitToast.set({
        kind: 'error',
        message: this.errorMessageForCode(code),
      });
    } finally {
      this.submitting.set(false);
    }
  }

  // ─── Skip-vote ─────────────────────────────────────────────────────────

  async onVoteSkip(itemId: string): Promise<void> {
    const session = this.session();
    const slot = this.slot();
    if (!session || !slot || slot.status !== 'active') return;
    try {
      await this.clientService.client.queue.voteSkip(session.id, itemId, slot.slotToken);
      this.votedItemIds.update((set) => new Set(set).add(itemId));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'error';
      if (code === 'already_voted') {
        // Treat as success on the client — the server already counted us.
        this.votedItemIds.update((set) => new Set(set).add(itemId));
      }
    }
  }

  // ─── Bootstrap + realtime ──────────────────────────────────────────────

  private async bootstrap(slug: string): Promise<void> {
    try {
      const session = await this.clientService.client.sessions.getBySlug(slug);
      this.session.set(session);
      if (session.endedAt) return; // skip slot acquisition for closed sessions
      const fingerprintHash = await getOrCreateGuestFingerprintHash();
      const slot = await this.clientService.client.guest.identity({
        eventSlug: slug,
        fingerprintHash,
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
      // non-fatal
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
      this.recentlyPlayed.set(snapshot.recentlyPlayed);
      this.providerQueue.set(snapshot.providerQueue);
      this.queue.set(snapshot.queue);
    });
    this.realtime.on('now_playing.updated', (event) => {
      this.nowPlaying.set(event.track);
      this.nowPlayingAt.set(Date.now());
    });
    this.realtime.on('provider_queue.updated', (event) => {
      this.providerQueue.set(event.tracks);
    });
    this.realtime.onEvent((event: SessionEvent) => {
      if (event.type === 'session.ended') {
        this.session.update((s) => (s ? { ...s, endedAt: new Date().toISOString() } : s));
        return;
      }
      // Queue events get refreshed via list; cheap + deterministic.
      if (
        event.type === 'queue.item_requested' ||
        event.type === 'queue.item_approved' ||
        event.type === 'queue.item_rejected' ||
        event.type === 'queue.item_removed' ||
        event.type === 'skip_vote.updated'
      ) {
        void this.refreshQueue();
      }
    });
    this.realtime.connect();
  }

  private errorMessageForCode(code: string): string {
    switch (code) {
      case 'cap_reached':
        return "You've hit the limit — wait for one to play before requesting another.";
      case 'session_ended':
        return 'This session has ended.';
      case 'unknown_slot_token':
      case 'slot_not_active':
        return 'Your guest slot expired. Refresh the page.';
      default:
        return 'Could not submit request.';
    }
  }

  private errorMessage(err: unknown, fallback: string): string {
    if (err instanceof ApiError) return `${fallback} (${err.code})`;
    return fallback;
  }
}
