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
import { SnackbarService } from '../services/snackbar.service.js';
import { buildQueueEtaMs, formatEta } from '../utils/queue-eta.js';

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
          <app-now-playing-card
            [track]="nowPlaying()"
            [lastUpdatedAtMs]="nowPlayingAt()"
            [showVoteSkip]="!!nowPlaying() && slot()?.status === 'active'"
            [voteCount]="nowPlayingVoteCount()"
            [voteThreshold]="nowPlayingVoteThreshold()"
            [alreadyVoted]="hasVotedNowPlaying()"
            [voteBusy]="nowPlayingVoteBusy()"
            (voteSkip)="onVoteSkipNowPlaying()"
          />
        </section>

        @if (myPendingItems().length > 0) {
          <section class="card pending-section">
            <h2>Your requests</h2>
            <p class="pending-hint">
              These count against your limit until they play (or you remove them).
            </p>
            <ul class="pending-list">
              @for (item of myPendingItems(); track item.id) {
                <li class="pending-row">
                  @if (item.albumArtUrl) {
                    <img class="art" [src]="item.albumArtUrl" alt="" />
                  } @else {
                    <span class="art empty" aria-hidden="true">♪</span>
                  }
                  <span class="meta">
                    <span class="name">{{ item.trackName }}</span>
                    <span class="artist">{{ item.artistName }}</span>
                  </span>
                  @switch (item.status) {
                    @case ('pending') {
                      <span class="badge pending">Pending review</span>
                    }
                    @default {
                      <span class="badge queueing">Queueing…</span>
                    }
                  }
                  <button
                    type="button"
                    class="row-remove"
                    [disabled]="removingMyItemIds().has(item.id)"
                    (click)="onRemoveOwn(item.id)"
                    aria-label="Remove from queue"
                    title="Remove from queue"
                  >
                    ×
                  </button>
                </li>
              }
            </ul>
          </section>
        }

        <section class="card request-form">
          <h2>Request a song</h2>
          <app-search-result-list
            [results]="searchResults()"
            [status]="searchStatus()"
            [errorMessage]="searchError()"
            [disabledReason]="searchDisabledReason()"
            [busy]="submitting()"
            [queueLookup]="searchQueueLookup"
            placeholder="Song, artist, or album…"
            idleHint="Search the host's library — pick a track to add it to the queue."
            (query)="onQueryChange($event)"
            (pick)="onPick($event)"
          />
        </section>

        <section class="card queue-section">
          <h2>Up next</h2>
          @if (mergedQueue().length === 0) {
            <p class="empty">Nothing queued yet — be the first.</p>
          } @else {
            <ul class="merged-queue">
              @for (entry of mergedQueue(); track entry.key) {
                <li
                  class="merged-row"
                  [class.requested]="entry.openDjItem"
                  [class.mine]="entry.isMine"
                >
                  @if (entry.track.albumArt) {
                    <img class="art" [src]="entry.track.albumArt" alt="" />
                  } @else {
                    <span class="art empty" aria-hidden="true">♪</span>
                  }
                  <span class="meta">
                    <span class="name">
                      <span class="title">{{ entry.track.name }}</span>
                      @if (entry.isMine) {
                        <span class="badge mine">Yours</span>
                      } @else if (entry.openDjItem) {
                        <span class="badge requested">Requested</span>
                      }
                    </span>
                    <span class="artist">
                      <span>{{ entry.track.artist }}</span>
                      @if (formatEntryEta(entry.track.uri); as eta) {
                        <span class="eta">· {{ eta }}</span>
                      }
                    </span>
                  </span>
                  @if (slot()?.status === 'active') {
                    @if (entry.openDjItem) {
                      <button
                        type="button"
                        class="vote-pill"
                        [class.voted]="hasVotedItem(entry.openDjItem.id)"
                        [disabled]="hasVotedItem(entry.openDjItem.id)"
                        (click)="onVoteSkip(entry.openDjItem.id)"
                        [attr.title]="
                          hasVotedItem(entry.openDjItem.id)
                            ? 'You voted to skip this'
                            : 'Vote to skip this track'
                        "
                      >
                        ▶|
                        {{ entry.openDjItem.skipVotes }}<span class="sep">/</span
                        >{{ session()!.voteSkipThreshold }}
                      </button>
                    } @else {
                      <button
                        type="button"
                        class="vote-pill"
                        [class.voted]="hasVotedProviderUri(entry.track.uri)"
                        [disabled]="hasVotedProviderUri(entry.track.uri)"
                        (click)="onVoteSkipProvider(entry.track.uri)"
                        [attr.title]="
                          hasVotedProviderUri(entry.track.uri)
                            ? 'You voted to skip this'
                            : 'Vote to skip this track'
                        "
                      >
                        ▶|
                        {{ providerVoteCount(entry.track.uri) }}<span class="sep">/</span
                        >{{ session()!.voteSkipThreshold }}
                      </button>
                    }
                  }
                </li>
              }
            </ul>
          }
        </section>

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
      .merged-queue {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .merged-row {
        display: grid;
        grid-template-columns: 40px 1fr auto;
        gap: 10px;
        align-items: center;
        padding: 8px 12px;
        background: #0c0a14;
        border: 1px solid #2c2440;
        border-radius: 8px;
      }
      .merged-row .vote-pill {
        appearance: none;
        background: rgba(236, 72, 153, 0.12);
        border: 1px solid rgba(236, 72, 153, 0.35);
        color: #fda4af;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 11px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        letter-spacing: 0.04em;
        cursor: pointer;
        white-space: nowrap;
      }
      .merged-row .vote-pill:hover:not(:disabled) {
        background: rgba(236, 72, 153, 0.2);
        border-color: rgba(236, 72, 153, 0.55);
      }
      .merged-row .vote-pill:disabled,
      .merged-row .vote-pill.voted {
        background: rgba(236, 72, 153, 0.25);
        color: #fff;
        cursor: default;
      }
      .merged-row .vote-pill .sep {
        opacity: 0.5;
        margin: 0 1px;
      }
      .merged-row.requested {
        border-color: rgba(168, 85, 247, 0.3);
      }
      .merged-row.mine {
        border-color: rgba(168, 85, 247, 0.6);
      }
      .merged-row .art {
        width: 40px;
        height: 40px;
        border-radius: 4px;
        object-fit: cover;
        background: #0c0a14;
      }
      .merged-row .art.empty {
        display: grid;
        place-items: center;
        color: #6e5e8a;
      }
      .merged-row .meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .merged-row .name {
        font-size: 13px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .merged-row .title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        flex: 0 1 auto;
      }
      .merged-row .badge {
        margin-right: 0;
        flex: 0 0 auto;
      }
      .merged-row .artist {
        font-size: 11px;
        color: #a294c5;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .merged-row .artist .eta {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        color: #6e5e8a;
        flex: 0 0 auto;
      }
      .badge {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 999px;
        font-size: 9px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-right: 6px;
      }
      .badge.requested {
        background: rgba(168, 85, 247, 0.15);
        border: 1px solid rgba(168, 85, 247, 0.35);
        color: #d8b4fe;
      }
      .badge.mine {
        background: linear-gradient(135deg, rgba(168, 85, 247, 0.3), rgba(236, 72, 153, 0.3));
        border: 1px solid rgba(168, 85, 247, 0.5);
        color: #fff;
      }
      .empty {
        margin: 0;
        font-size: 13px;
        color: #a294c5;
        font-style: italic;
        text-align: center;
        padding: 16px 0;
      }
      .pending-section {
        border-color: rgba(250, 204, 21, 0.35);
      }
      .pending-hint {
        margin: 0 0 12px;
        font-size: 12px;
        color: #a294c5;
      }
      .pending-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .pending-row {
        display: grid;
        grid-template-columns: 40px 1fr auto auto;
        gap: 10px;
        align-items: center;
        padding: 8px 12px;
        background: #0c0a14;
        border: 1px solid rgba(250, 204, 21, 0.25);
        border-radius: 8px;
      }
      .badge.queueing {
        background: rgba(168, 85, 247, 0.15);
        border: 1px solid rgba(168, 85, 247, 0.4);
        color: #d8b4fe;
      }
      .row-remove {
        appearance: none;
        background: transparent;
        border: 1px solid #2c2440;
        color: #fda4af;
        border-radius: 999px;
        width: 24px;
        height: 24px;
        display: grid;
        place-items: center;
        font: inherit;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        padding: 0;
      }
      .row-remove:hover:not(:disabled) {
        background: rgba(253, 164, 175, 0.1);
        border-color: #fda4af;
      }
      .row-remove:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .pending-row .art {
        width: 40px;
        height: 40px;
        border-radius: 4px;
        object-fit: cover;
        background: #0c0a14;
      }
      .pending-row .art.empty {
        display: grid;
        place-items: center;
        color: #6e5e8a;
      }
      .pending-row .meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .pending-row .name {
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pending-row .artist {
        font-size: 11px;
        color: #a294c5;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .badge.pending {
        background: rgba(250, 204, 21, 0.15);
        border: 1px solid rgba(250, 204, 21, 0.4);
        color: #fde68a;
      }
    `,
  ],
})
export class GuestRequestPage {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clientService = inject(OpenDjClientService);
  private readonly snackbar = inject(SnackbarService);

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
  readonly votedItemIds = signal<ReadonlySet<string>>(new Set());
  /**
   * Track URIs the guest has already voted to skip. Optimistically updated
   * on click + cleared whenever now-playing transitions to a new URI.
   */
  readonly votedNowPlayingUris: WritableSignal<ReadonlySet<string>> = signal(new Set());
  readonly nowPlayingVoteBusy = signal(false);
  /**
   * Provider-queue trackUris this guest has already voted to skip. Used for
   * tracks that have no OpenDJ counterpart (host queued via Spotify).
   */
  readonly votedProviderUris: WritableSignal<ReadonlySet<string>> = signal(new Set());
  /**
   * Live skip-vote counts for provider-only tracks, mirrored from the
   * realtime snapshot + `provider_queue_skip_vote.updated` events.
   */
  readonly providerSkipVotes: WritableSignal<
    ReadonlyMap<string, { count: number; threshold: number }>
  > = signal(new Map());

  /**
   * Live skip-vote tally for the currently-playing track, mirrored from
   * the realtime snapshot + `now_playing_skip_vote.updated` events.
   */
  readonly nowPlayingSkipVoteState: WritableSignal<{
    trackUri: string;
    count: number;
    threshold: number;
  } | null> = signal(null);

  readonly nowPlayingVoteCount = computed<number>(() => this.nowPlayingSkipVoteState()?.count ?? 0);

  readonly nowPlayingVoteThreshold = computed<number>(
    () => this.nowPlayingSkipVoteState()?.threshold ?? this.session()?.voteSkipThreshold ?? 5,
  );

  readonly hasVotedNowPlaying = computed<boolean>(() => {
    const uri = this.nowPlaying()?.uri;
    return uri ? this.votedNowPlayingUris().has(uri) : false;
  });

  readonly visibleQueue = computed(() =>
    this.queue().filter(
      (i) => i.status === 'approved' || i.status === 'queued' || i.status === 'playing',
    ),
  );

  /**
   * Every active item the guest has submitted that isn't already
   * visible as a merged-queue row (i.e. not yet on Spotify's queue).
   * Covers two cases that otherwise hide the request from the guest:
   *
   * - Moderation on: status='pending', host hasn't approved yet.
   * - Moderation off: status='approved' but the push to Spotify failed
   *   or hasn't been confirmed by the next provider-queue poll.
   *
   * Shown as a strip with a remove (×) button so the guest can clear
   * stuck items themselves rather than burning their per-guest cap.
   */
  readonly myPendingItems = computed(() => {
    const myGuestId = this.slot()?.guestId ?? null;
    if (!myGuestId) return [];
    const inProvider = new Set(this.providerQueue().map((t) => t.uri));
    return this.queue().filter(
      (i) =>
        i.guestId === myGuestId &&
        (i.status === 'pending' ||
          i.status === 'approved' ||
          i.status === 'queued' ||
          i.status === 'playing') &&
        !inProvider.has(i.trackUri),
    );
  });
  readonly removingMyItemIds = signal<ReadonlySet<string>>(new Set());

  /**
   * Map of trackUri → ms until that track plays. Indexed against the
   * provider queue + now-playing remaining time. Backs the search-result
   * "in queue · ~5 min" pill and the future host ETA badges.
   */
  readonly etaMap = computed(() =>
    buildQueueEtaMs(this.nowPlaying(), this.providerQueue(), this.nowPlayingAt()),
  );

  /**
   * Closure for SearchResultListComponent — returns null when the track
   * isn't in the active queue, otherwise a `{label, tooltip}` for the
   * pill. Distinguishes pending (host hasn't approved yet, moderation
   * sessions only) from queued (approved, on its way to Spotify) so
   * guests don't double-click a track that's already awaiting review.
   * `played`/`rejected` items are intentionally ignored — the guest may
   * legitimately re-request them.
   */
  readonly searchQueueLookup = (trackUri: string): { label: string; tooltip: string } | null => {
    const eta = this.etaMap().get(trackUri);
    if (eta !== undefined) {
      return {
        label: formatEta(eta),
        tooltip: 'Already in the queue.',
      };
    }
    const items = this.queue();
    if (items.some((i) => i.trackUri === trackUri && i.status === 'pending')) {
      return {
        label: 'awaiting approval',
        tooltip: 'You already requested this — waiting for the host to approve.',
      };
    }
    if (
      items.some(
        (i) =>
          i.trackUri === trackUri &&
          (i.status === 'approved' || i.status === 'queued' || i.status === 'playing'),
      )
    ) {
      return {
        label: 'queued',
        tooltip: 'Already requested — waiting for the host to make space.',
      };
    }
    return null;
  };

  /**
   * Unified Up-Next list. The provider's queue (Spotify) is the SOLE
   * source of truth — we never display OpenDJ items that aren't in
   * Spotify's queue, because that lies to the guest. The backend's
   * NowPlayingPoller retries pushing unsynced approved items each tick
   * and marks them played/rejected if they stay stuck past the grace
   * window. Guest-requested rows still get annotated for "Yours" /
   * "Requested" badging by matching trackUri.
   */
  readonly mergedQueue = computed(() => {
    const provider = this.providerQueue();
    const opendj = this.visibleQueue();
    const myGuestId = this.slot()?.guestId ?? null;
    const used = new Set<string>();
    return provider.map((t, i) => {
      const match = opendj.find((q) => q.trackUri === t.uri && !used.has(q.id));
      if (match) used.add(match.id);
      return {
        key: `p-${i}-${t.uri}`,
        track: { uri: t.uri, name: t.name, artist: t.artist, albumArt: t.albumArt },
        openDjItem: match ?? null,
        isMine: !!match && myGuestId !== null && match.guestId === myGuestId,
      };
    });
  });

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
    try {
      const created = await this.clientService.client.queue.request(session.id, slot.slotToken, {
        uri: result.trackUri,
        name: result.trackName,
        artist: result.artistName,
        albumArt: result.albumArtUrl,
        durationMs: result.durationMs ?? 0,
      });
      this.snackbar.success(
        session.moderationEnabled
          ? 'Submitted for review.'
          : `Added "${result.trackName}" to the queue.`,
      );
      // Optimistic: the realtime fanout + Spotify queue poll can take a
      // few seconds; in the meantime fold the new item into local state
      // so the search row's pill flips to "queued" and the merged Up
      // Next list shows it immediately. Server snapshot will reconcile.
      this.queue.update((items) => [...items, created]);
      if (!session.moderationEnabled) {
        this.providerQueue.update((curr) =>
          curr.some((t) => t.uri === result.trackUri)
            ? curr
            : [
                ...curr,
                {
                  uri: result.trackUri,
                  name: result.trackName,
                  artist: result.artistName,
                  albumArt: result.albumArtUrl,
                  durationMs: result.durationMs ?? 0,
                },
              ],
        );
      }
      // Keep the search results visible — guests often want to add more
      // tracks from the same search without retyping.
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'error';
      this.snackbar.error(this.errorMessageForCode(code), 6000);
    } finally {
      this.submitting.set(false);
    }
  }

  // ─── Skip-vote ─────────────────────────────────────────────────────────

  hasVotedItem(itemId: string): boolean {
    return this.votedItemIds().has(itemId);
  }

  /** Wait-time string for an Up Next row, or null if we don't have one. */
  formatEntryEta(trackUri: string): string | null {
    const ms = this.etaMap().get(trackUri);
    return ms === undefined ? null : formatEta(ms);
  }

  /**
   * Remove one of the guest's own queue items. Backed by the existing
   * DELETE /queue/:itemId route (slot-token auth, owner-only, blocks
   * removal of an item that's currently playing). Optimistically drops
   * it from local state so the cap pressure releases immediately.
   */
  async onRemoveOwn(itemId: string): Promise<void> {
    const session = this.session();
    const slot = this.slot();
    if (!session || !slot) return;
    if (this.removingMyItemIds().has(itemId)) return;
    this.removingMyItemIds.update((s) => new Set(s).add(itemId));
    try {
      await this.clientService.client.queue.remove(session.id, itemId, slot.slotToken);
      this.queue.update((items) => items.filter((i) => i.id !== itemId));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'error';
      if (code === 'item_playing') {
        this.snackbar.error("Can't remove a track that's currently playing.", 4000);
      } else {
        this.snackbar.error("Couldn't remove that one. Try again.", 4000);
      }
    } finally {
      this.removingMyItemIds.update((s) => {
        const next = new Set(s);
        next.delete(itemId);
        return next;
      });
    }
  }

  hasVotedProviderUri(trackUri: string): boolean {
    return this.votedProviderUris().has(trackUri);
  }

  providerVoteCount(trackUri: string): number {
    return this.providerSkipVotes().get(trackUri)?.count ?? 0;
  }

  async onVoteSkipProvider(trackUri: string): Promise<void> {
    const session = this.session();
    const slot = this.slot();
    if (!session || !slot || slot.status !== 'active') return;
    if (this.hasVotedProviderUri(trackUri)) return;
    try {
      await this.clientService.client.queue.voteSkipProviderTrack(
        session.id,
        trackUri,
        slot.slotToken,
      );
      this.votedProviderUris.update((s) => new Set(s).add(trackUri));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'error';
      if (code === 'already_voted') {
        this.votedProviderUris.update((s) => new Set(s).add(trackUri));
      } else {
        this.snackbar.error("Couldn't record your vote.", 4000);
      }
    }
  }

  async onVoteSkipNowPlaying(): Promise<void> {
    const session = this.session();
    const slot = this.slot();
    const np = this.nowPlaying();
    if (!session || !slot || slot.status !== 'active' || !np) return;
    if (this.hasVotedNowPlaying()) return;
    this.nowPlayingVoteBusy.set(true);
    try {
      await this.clientService.client.playback.voteSkip(session.id, slot.slotToken);
      this.votedNowPlayingUris.update((s) => new Set(s).add(np.uri));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'error';
      if (code === 'already_voted') {
        // Server already counted us — match the client state.
        this.votedNowPlayingUris.update((s) => new Set(s).add(np.uri));
      } else {
        this.snackbar.error("Couldn't record your vote.", 4000);
      }
    } finally {
      this.nowPlayingVoteBusy.set(false);
    }
  }

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
      // Don't override the queue from the snapshot — the room is in-memory
      // and only reflects events fired since it materialized, so anything
      // submitted before this server boot is missing from snapshot.queue.
      // /queue (already fetched during bootstrap) is authoritative; live
      // events keep it in sync.
      this.nowPlayingSkipVoteState.set(snapshot.nowPlayingSkipVote);
      this.providerSkipVotes.set(new Map(Object.entries(snapshot.providerQueueSkipVotes)));
    });
    this.realtime.on('now_playing.updated', (event) => {
      const prevUri = this.nowPlaying()?.uri ?? null;
      const nextUri = event.track?.uri ?? null;
      this.nowPlaying.set(event.track);
      this.nowPlayingAt.set(Date.now());
      if (prevUri !== nextUri) {
        // Track changed → reset client-side "I voted" memory + tally.
        this.votedNowPlayingUris.set(new Set());
        this.nowPlayingSkipVoteState.set(null);
      }
    });
    this.realtime.on('now_playing_skip_vote.updated', (event) => {
      this.nowPlayingSkipVoteState.set({
        trackUri: event.trackUri,
        count: event.count,
        threshold: event.threshold,
      });
      // If the threshold landed via someone else's vote, surface it.
      if (event.count >= event.threshold) {
        this.snackbar.info('Track skipped by votes.', 4000);
      }
    });
    this.realtime.on('provider_queue.updated', (event) => {
      this.providerQueue.set(event.tracks);
      // Drop client-side voted memory for URIs that left the queue, mirror
      // the server-side cleanup in applyEvent.
      const remaining = new Set(event.tracks.map((t) => t.uri));
      const voted = this.votedProviderUris();
      let changed = false;
      const next = new Set<string>();
      for (const uri of voted) {
        if (remaining.has(uri)) next.add(uri);
        else changed = true;
      }
      if (changed) this.votedProviderUris.set(next);
    });
    this.realtime.on('provider_queue_skip_vote.updated', (event) => {
      this.providerSkipVotes.update((m) => {
        const next = new Map(m);
        next.set(event.trackUri, { count: event.count, threshold: event.threshold });
        return next;
      });
      if (event.count >= event.threshold) {
        this.snackbar.info('Track skipped by votes.', 4000);
      }
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
      case 'duplicate_request':
        return "That track's already in the queue. Pick something else.";
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
