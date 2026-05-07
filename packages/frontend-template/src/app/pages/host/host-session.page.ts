/**
 * /host/sessions/:id — host session control surface.
 *
 * Now-playing card with skip / pause / resume controls, the QR code +
 * copyable join URL, a Spotify Connect device picker (so the host can
 * pick which speaker plays audio), the moderation queue, recently
 * played, and end-session.
 *
 * Pulls initial state from `/api/v1/sessions/:id` + WS `_snapshot` frame
 * and keeps in sync via realtime events.
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
  type AuditEventWire,
  type PlaybackDeviceWire,
  type SessionWire,
} from '@opendj/frontend';
import type { NowPlayingTrack, Track } from '@opendj/core';
import type { SessionEvent, SessionSnapshot } from '@opendj/realtime';
import { DevicePickerComponent } from '../../components/device-picker.component.js';
import { NowPlayingCardComponent } from '../../components/now-playing-card.component.js';
import { QrCodeComponent } from '../../components/qr-code.component.js';
import { QueueListComponent, type QueueListItem } from '../../components/queue-list.component.js';
import { RecentlyPlayedListComponent } from '../../components/recently-played-list.component.js';
import { OpenDjClientService } from '../../services/opendj-client.service.js';
import { buildQueueEtaMs, formatEta } from '../../utils/queue-eta.js';
import QRCode from 'qrcode';

@Component({
  selector: 'app-host-session',
  standalone: true,
  imports: [
    CommonModule,
    DevicePickerComponent,
    NowPlayingCardComponent,
    QrCodeComponent,
    QueueListComponent,
    RecentlyPlayedListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      @if (loadError()) {
        <p class="error">{{ loadError() }}</p>
      } @else if (!session()) {
        <p class="loading">Loading…</p>
      } @else {
        <header class="header card">
          <div class="header-left">
            <p class="eyebrow">Session</p>
            <h1>{{ session()!.name }}</h1>
            <div class="qr-row">
              <button
                type="button"
                class="qr-button"
                (click)="openQrFullscreen()"
                aria-label="Open QR code fullscreen"
                title="Tap to enlarge"
              >
                <app-qr-code [value]="guestUrl()" [size]="120" />
              </button>
              <div class="qr-meta">
                <p class="qr-eyebrow">Scan to join</p>
                <code class="qr-url">{{ guestUrl() }}</code>
                <div class="qr-actions">
                  @if (canShare()) {
                    <button type="button" class="action" (click)="shareUrl()">Share</button>
                  }
                  <button type="button" class="action" (click)="copyUrl()">
                    {{ urlCopied() ? 'Copied ✓' : 'Copy' }}
                  </button>
                  <button type="button" class="action" (click)="downloadQr()">Download</button>
                  <button type="button" class="action" (click)="openPrintView()">Print</button>
                  <a
                    class="action"
                    [href]="tvUrl()"
                    target="_blank"
                    rel="noopener"
                    title="Open the public TV view in a new tab"
                  >
                    TV view ↗
                  </a>
                </div>
              </div>
            </div>
          </div>
          <button
            type="button"
            class="end"
            [disabled]="ending() || !!session()!.endedAt"
            (click)="endSession()"
          >
            {{ session()!.endedAt ? 'Ended' : ending() ? 'Ending…' : 'End session' }}
          </button>
        </header>

        <section class="card settings">
          <h2>Session settings</h2>
          <label class="toggle">
            <input
              type="checkbox"
              [checked]="!!session()!.moderationEnabled"
              [disabled]="settingsBusy()"
              (change)="toggleModerationEnabled($any($event.target).checked)"
            />
            <span class="toggle-label">
              Approve guest requests before they hit the queue
              <span class="toggle-hint"
                >Default: off. Turn on to review every guest pick — they go to "Pending review"
                until you approve.</span
              >
            </span>
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              [checked]="!!session()!.allowDuplicates"
              [disabled]="settingsBusy()"
              (change)="toggleAllowDuplicates($any($event.target).checked)"
            />
            <span class="toggle-label">
              Allow the same track to be requested more than once
              <span class="toggle-hint"
                >Default: off. Turn on for sing-along nights where a hit can hit twice.</span
              >
            </span>
          </label>
          @if (settingsError(); as err) {
            <p class="form-error">{{ err }}</p>
          }
        </section>

        <section class="now-playing card">
          <h2>Now playing</h2>
          <app-now-playing-card
            [track]="nowPlaying()"
            [lastUpdatedAtMs]="nowPlayingAt()"
            [showControls]="true"
            [controlsBusy]="playbackBusy()"
            (skip)="onSkip()"
            (togglePlay)="onTogglePlay()"
          />
          @if (playbackError(); as err) {
            <p class="form-error">{{ err }}</p>
          }
          <div class="device-picker">
            <app-device-picker
              [devices]="devices()"
              [busy]="devicesBusy()"
              (refresh)="loadDevices()"
              (activate)="onActivateDevice($event)"
            />
          </div>
        </section>

        @if (pendingItems().length > 0) {
          <section class="card pending">
            <h2>Pending review</h2>
            <p class="hint">Approve to send to Spotify.</p>
            <app-queue-list
              [items]="pendingItems()"
              mode="host"
              (approve)="moderate($event, 'approved')"
              (reject)="moderate($event, 'rejected')"
            />
          </section>
        }

        <section class="card up-next">
          <h2>Up next</h2>
          @if (providerQueue().length === 0) {
            <p class="empty">
              Queue is empty. Send guests to the URL above to start filling it up.
            </p>
          } @else {
            <ul class="up-next-list">
              @for (entry of mergedQueue(); track entry.key) {
                <li class="row" [class.requested]="entry.openDjItem">
                  @if (entry.track.albumArt) {
                    <img class="art" [src]="entry.track.albumArt" alt="" />
                  } @else {
                    <span class="art empty" aria-hidden="true">♪</span>
                  }
                  <span class="meta">
                    <span class="name">{{ entry.track.name }}</span>
                    <span class="artist">
                      <span>{{ entry.track.artist }}</span>
                      @if (formatEntryEta(entry.track.uri); as eta) {
                        <span class="eta">· {{ eta }}</span>
                      }
                    </span>
                  </span>
                  <span class="row-actions">
                    @if (entry.openDjItem) {
                      <span class="badge requested">Requested</span>
                    }
                    <button
                      type="button"
                      class="remove"
                      [disabled]="removingUris().has(entry.track.uri)"
                      (click)="onRemoveRow(entry)"
                      title="Remove from queue"
                    >
                      Remove
                    </button>
                  </span>
                </li>
              }
            </ul>
          }
        </section>

        @if (recentlyPlayed().length > 0) {
          <section class="card recently">
            <h2>Recently played</h2>
            <app-recently-played-list [tracks]="recentlyPlayed()" [max]="6" />
          </section>
        }

        <section class="card audit">
          <button
            type="button"
            class="audit-toggle"
            (click)="toggleAuditLog()"
            [attr.aria-expanded]="auditOpen()"
          >
            <h2>Activity log</h2>
            <span class="audit-caret">{{ auditOpen() ? '▾' : '▸' }}</span>
          </button>
          @if (auditOpen()) {
            @if (auditLoading()) {
              <p class="hint">Loading…</p>
            } @else if (auditLog().length === 0) {
              <p class="empty">Nothing logged yet.</p>
            } @else {
              <ul class="audit-list">
                @for (e of auditLog(); track e.id) {
                  <li class="audit-row" [attr.data-actor]="e.actorKind">
                    <span class="audit-time">{{ formatAuditTime(e.createdAtEpochMs) }}</span>
                    <span class="audit-actor">{{ e.actorLabel ?? e.actorKind }}</span>
                    <span class="audit-action">{{ formatAuditAction(e.action) }}</span>
                    <span class="audit-detail">{{ formatAuditDetail(e) }}</span>
                  </li>
                }
              </ul>
              <button
                type="button"
                class="audit-refresh"
                (click)="loadAuditLog()"
                [disabled]="auditLoading()"
              >
                Refresh
              </button>
            }
          }
        </section>
      }

      @if (qrFullscreen()) {
        <div
          class="qr-fullscreen"
          role="dialog"
          aria-label="QR code"
          (click)="closeQrFullscreen()"
          (keydown.escape)="closeQrFullscreen()"
          tabindex="0"
        >
          <div class="qr-fullscreen-inner" (click)="$event.stopPropagation()">
            <button
              type="button"
              class="qr-fullscreen-close"
              (click)="closeQrFullscreen()"
              aria-label="Close"
            >
              ×
            </button>
            <h2 class="qr-fullscreen-name">{{ session()?.name }}</h2>
            <app-qr-code [value]="guestUrl()" [size]="480" />
            <code class="qr-fullscreen-url">{{ guestUrl() }}</code>
          </div>
        </div>
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
        max-width: 760px;
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
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }
      .header-left {
        flex: 1;
        min-width: 0;
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
        margin: 0 0 16px;
        font-size: 24px;
        background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .qr-row {
        display: flex;
        gap: 16px;
        align-items: center;
      }
      .qr-meta {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }
      .qr-eyebrow {
        font-size: 10px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: #a294c5;
        margin: 0;
      }
      .qr-url {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        background: #0c0a14;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        word-break: break-all;
      }
      .qr-button {
        all: unset;
        cursor: pointer;
        border-radius: 8px;
      }
      .qr-button:focus-visible {
        outline: 2px solid #a855f7;
        outline-offset: 2px;
      }
      .qr-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .qr-actions .action {
        background: transparent;
        border: 1px solid #2c2440;
        color: #c8b8e9;
        padding: 4px 10px;
        border-radius: 999px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
      }
      .qr-actions .action:hover {
        border-color: #a855f7;
      }
      .qr-fullscreen {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(8px);
        display: grid;
        place-items: center;
        z-index: 1000;
        padding: 24px;
      }
      .qr-fullscreen-inner {
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 14px;
        padding: 32px 24px 24px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        position: relative;
        max-width: min(560px, calc(100vw - 48px));
      }
      .qr-fullscreen-close {
        position: absolute;
        top: 12px;
        right: 12px;
        background: transparent;
        border: 1px solid #2c2440;
        color: #c8b8e9;
        width: 32px;
        height: 32px;
        border-radius: 999px;
        font: inherit;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        display: grid;
        place-items: center;
      }
      .qr-fullscreen-close:hover {
        border-color: #a855f7;
      }
      .qr-fullscreen-name {
        font-family: 'Syne', 'Inter', sans-serif;
        margin: 0;
        font-size: 22px;
        background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        text-align: center;
      }
      .qr-fullscreen-url {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 13px;
        color: #c8b8e9;
        word-break: break-all;
        text-align: center;
      }
      h2 {
        font-family: 'Syne', 'Inter', sans-serif;
        font-size: 16px;
        margin: 0 0 12px;
      }
      .device-picker {
        margin-top: 12px;
      }
      .form-error {
        color: #fda4af;
        font-size: 13px;
        margin: 8px 0 0;
      }
      .end {
        font: inherit;
        cursor: pointer;
        border-radius: 8px;
        padding: 10px 16px;
        font-size: 13px;
        background: #2c2440;
        color: #fda4af;
        border: 1px solid #fda4af;
      }
      .end:hover:not([disabled]) {
        background: #fda4af;
        color: #1a0a14;
      }
      .end:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .error {
        color: #fda4af;
      }
      .loading {
        color: #a294c5;
      }
      .pending .hint,
      .up-next .hint {
        margin: 0 0 12px;
        font-size: 12px;
        color: #a294c5;
      }
      .up-next-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .up-next-list .row {
        display: grid;
        grid-template-columns: 36px 1fr auto;
        gap: 10px;
        align-items: center;
        padding: 8px 12px;
        background: #0c0a14;
        border: 1px solid #2c2440;
        border-radius: 8px;
      }
      .up-next-list .row.requested {
        border-color: rgba(168, 85, 247, 0.4);
      }
      .up-next-list .art {
        width: 36px;
        height: 36px;
        border-radius: 4px;
        object-fit: cover;
        background: #0c0a14;
      }
      .up-next-list .art.empty {
        display: grid;
        place-items: center;
        color: #6e5e8a;
      }
      .up-next-list .meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .up-next-list .name {
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .up-next-list .artist {
        font-size: 11px;
        color: #a294c5;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .up-next-list .artist .eta {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        color: #6e5e8a;
        flex: 0 0 auto;
      }
      .badge.requested {
        background: linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(236, 72, 153, 0.2));
        border: 1px solid rgba(168, 85, 247, 0.4);
        color: #fff;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .row-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .remove {
        appearance: none;
        background: transparent;
        border: 1px solid #2c2440;
        color: #fda4af;
        border-radius: 999px;
        padding: 4px 10px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .remove:hover:not(:disabled) {
        background: rgba(253, 164, 175, 0.1);
        border-color: #fda4af;
      }
      .remove:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .audit-toggle {
        all: unset;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        cursor: pointer;
        width: 100%;
      }
      .audit-toggle:focus-visible {
        outline: 2px solid #a855f7;
        outline-offset: 2px;
        border-radius: 4px;
      }
      .audit-toggle h2 {
        margin: 0;
      }
      .audit-caret {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 14px;
        color: #a294c5;
      }
      .audit-list {
        list-style: none;
        margin: 12px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 360px;
        overflow-y: auto;
      }
      .audit-row {
        display: grid;
        grid-template-columns: auto auto auto 1fr;
        gap: 8px;
        font-size: 12px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        padding: 4px 6px;
        border-radius: 4px;
        background: #0c0a14;
        border: 1px solid transparent;
      }
      .audit-row[data-actor='host'] {
        border-color: rgba(168, 85, 247, 0.25);
      }
      .audit-row[data-actor='guest'] {
        border-color: rgba(52, 211, 153, 0.25);
      }
      .audit-row[data-actor='system'] {
        border-color: rgba(250, 204, 21, 0.25);
      }
      .audit-time {
        color: #6e5e8a;
        white-space: nowrap;
      }
      .audit-actor {
        color: #c8b8e9;
        white-space: nowrap;
      }
      .audit-action {
        color: #f3eef9;
        white-space: nowrap;
      }
      .audit-detail {
        color: #a294c5;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .audit-refresh {
        margin-top: 8px;
        font: inherit;
        font-size: 11px;
        background: transparent;
        border: 1px solid #2c2440;
        color: #c8b8e9;
        padding: 4px 12px;
        border-radius: 999px;
        cursor: pointer;
      }
      .audit-refresh:hover:not(:disabled) {
        border-color: #a855f7;
      }
      .audit-refresh:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .empty {
        margin: 0;
        font-size: 13px;
        color: #a294c5;
        font-style: italic;
        padding: 16px 0;
        text-align: center;
      }
      .toggle {
        display: flex;
        gap: 12px;
        align-items: flex-start;
        cursor: pointer;
        font-size: 13px;
      }
      .toggle input[type='checkbox'] {
        margin-top: 2px;
        accent-color: #a855f7;
        width: 16px;
        height: 16px;
      }
      .toggle-label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .toggle-hint {
        font-size: 12px;
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
  readonly queue: WritableSignal<ReadonlyArray<QueueListItem>> = signal([]);
  readonly nowPlaying: WritableSignal<NowPlayingTrack | null> = signal(null);
  readonly nowPlayingAt = signal(0);
  readonly recentlyPlayed: WritableSignal<ReadonlyArray<NowPlayingTrack>> = signal([]);
  readonly providerQueue: WritableSignal<ReadonlyArray<Track>> = signal([]);
  readonly devices: WritableSignal<ReadonlyArray<PlaybackDeviceWire>> = signal([]);
  readonly devicesBusy = signal(false);
  readonly playbackBusy = signal(false);
  readonly playbackError = signal<string | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly ending = signal(false);
  readonly urlCopied = signal(false);
  readonly settingsBusy = signal(false);
  readonly settingsError = signal<string | null>(null);
  readonly qrFullscreen = signal(false);
  /** URIs currently being removed — used to disable the row's button. */
  readonly removingUris: WritableSignal<ReadonlySet<string>> = signal(new Set());
  readonly auditLog: WritableSignal<ReadonlyArray<AuditEventWire>> = signal([]);
  readonly auditOpen = signal(false);
  readonly auditLoading = signal(false);
  /**
   * Polling timer for the audit panel. Only runs while the panel is
   * open — torn down on close or page destroy. 5s cadence is plenty
   * given audit writes are best-effort and the host is reading, not
   * acting, when this is open.
   */
  private auditPollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * URIs the host has removed but Spotify still surfaces in its queue
   * (Spotify has no "remove from queue" API — only "skip when playing").
   * The row is optimistically hidden until the URI rolls out of the
   * provider queue (usually because the auto-skip-on-rejected logic
   * fires when it reaches the now-playing slot).
   */
  readonly removedUris: WritableSignal<ReadonlySet<string>> = signal(new Set());

  readonly guestUrl = computed(() => {
    const s = this.session();
    if (!s) return '';
    if (typeof globalThis.location === 'undefined') return `/u/${s.qrSlug}`;
    return `${globalThis.location.origin}/u/${s.qrSlug}`;
  });

  readonly tvUrl = computed(() => {
    const s = this.session();
    if (!s) return '';
    if (typeof globalThis.location === 'undefined') return `/tv/${s.qrSlug}`;
    return `${globalThis.location.origin}/tv/${s.qrSlug}`;
  });

  /** Queue items still awaiting moderation. Drives the "Pending review" tray. */
  readonly pendingItems = computed(() => this.queue().filter((i) => i.status === 'pending'));

  /** OpenDJ-mediated requests that have been approved (moderation on or off). */
  readonly approvedItems = computed(() =>
    this.queue().filter((i) => i.status === 'approved' || i.status === 'queued'),
  );

  /**
   * Wait-time per provider-queue trackUri. Same model as guest-side
   * `etaMap`: now-playing remaining + sum of preceding durations.
   */
  readonly etaMap = computed(() =>
    buildQueueEtaMs(this.nowPlaying(), this.providerQueue(), this.nowPlayingAt()),
  );

  /**
   * One unified Up-Next list. Spotify's queue is the SOLE source of
   * truth — we never display OpenDJ items that aren't in Spotify's
   * queue, because that lies to the host. The backend's
   * NowPlayingPoller retries pushing unsynced approved items each tick
   * and marks them played/rejected if they stay stuck past the grace
   * window. Each entry annotates whether it came from an OpenDJ guest
   * request (matched by trackUri against the approved queue) so the UI
   * can badge it.
   */
  readonly mergedQueue = computed(() => {
    const provider = this.providerQueue();
    const approved = this.approvedItems();
    const removed = this.removedUris();
    const used = new Set<string>();
    return provider
      .filter((t) => !removed.has(t.uri))
      .map((t, i) => {
        const match = approved.find((q) => q.trackUri === t.uri && !used.has(q.id));
        if (match) used.add(match.id);
        const entry: {
          key: string;
          track: { uri: string; name: string; artist: string; albumArt: string | null };
          openDjItem: QueueListItem | null;
        } = {
          key: `p-${i}-${t.uri}`,
          track: { uri: t.uri, name: t.name, artist: t.artist, albumArt: t.albumArt },
          openDjItem: match ?? null,
        };
        return entry;
      });
  });

  private realtime: RealtimeClient | null = null;

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      const id = p.get('id');
      if (id) void this.bootstrap(id);
    });
    this.destroyRef.onDestroy(() => {
      this.realtime?.close();
      this.stopAuditPolling();
    });
  }

  // ─── Session settings ──────────────────────────────────────────────────

  async toggleModerationEnabled(checked: boolean): Promise<void> {
    const session = this.session();
    if (!session) return;
    this.settingsBusy.set(true);
    this.settingsError.set(null);
    try {
      const updated = await this.client.client.sessions.update(session.id, {
        moderationEnabled: checked,
      });
      this.session.set(updated);
    } catch (err) {
      this.settingsError.set(
        err instanceof ApiError ? `Couldn't save (${err.code}).` : "Couldn't save the setting.",
      );
      this.session.update((s) => (s ? { ...s, moderationEnabled: !checked } : s));
    } finally {
      this.settingsBusy.set(false);
    }
  }

  async toggleAllowDuplicates(checked: boolean): Promise<void> {
    const session = this.session();
    if (!session) return;
    this.settingsBusy.set(true);
    this.settingsError.set(null);
    try {
      const updated = await this.client.client.sessions.update(session.id, {
        allowDuplicates: checked,
      });
      this.session.set(updated);
    } catch (err) {
      this.settingsError.set(
        err instanceof ApiError ? `Couldn't save (${err.code}).` : "Couldn't save the setting.",
      );
      // Revert the snapshot so the checkbox stops looking flipped.
      this.session.update((s) => (s ? { ...s, allowDuplicates: !checked } : s));
    } finally {
      this.settingsBusy.set(false);
    }
  }

  // ─── Moderation ────────────────────────────────────────────────────────

  async moderate(itemId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.client.client.queue.moderate(session.id, itemId, { decision });
      await this.refreshQueue();
    } catch {
      // realtime will catch us up; surfacing a banner is hosted-only polish
    }
  }

  async onRemove(itemId: string): Promise<void> {
    // Host has no separate "remove" route in this slice — moderate as
    // rejected which removes from the visible queue.
    await this.moderate(itemId, 'rejected');
  }

  /**
   * Remove a row from the merged Up Next list. OpenDJ-mediated rows go
   * through the moderation route (PATCH → rejected). Provider-only rows
   * (host queued via Spotify directly) hit the host-reject route which
   * stages the URI for the next now-playing tick to skip.
   */
  async onRemoveRow(entry: {
    track: { uri: string };
    openDjItem: QueueListItem | null;
  }): Promise<void> {
    const session = this.session();
    if (!session) return;
    const uri = entry.track.uri;
    if (this.removingUris().has(uri)) return;
    this.removingUris.update((s) => new Set(s).add(uri));
    // Optimistic — hide the row right away. Spotify won't actually drop
    // the URI from its queue until auto-skip-on-rejected fires when it
    // reaches the now-playing slot, which can be many minutes away.
    this.removedUris.update((s) => new Set(s).add(uri));
    try {
      if (entry.openDjItem) {
        await this.client.client.queue.moderate(session.id, entry.openDjItem.id, {
          decision: 'rejected',
        });
        await this.refreshQueue();
      } else {
        await this.client.client.queue.hostRejectProviderTrack(session.id, uri);
      }
    } catch {
      // Couldn't talk to the server — restore the row so the host can retry.
      this.removedUris.update((s) => {
        const next = new Set(s);
        next.delete(uri);
        return next;
      });
    } finally {
      this.removingUris.update((s) => {
        const next = new Set(s);
        next.delete(uri);
        return next;
      });
    }
  }

  // ─── Playback control ─────────────────────────────────────────────────

  async onSkip(): Promise<void> {
    const session = this.session();
    if (!session || this.playbackBusy()) return;
    this.playbackBusy.set(true);
    this.playbackError.set(null);
    try {
      await this.client.client.playback.skip(session.id);
    } catch (err) {
      this.playbackError.set(this.playbackErrorFor(err));
    } finally {
      this.playbackBusy.set(false);
    }
  }

  async onTogglePlay(): Promise<void> {
    const session = this.session();
    const np = this.nowPlaying();
    if (!session || this.playbackBusy()) return;
    this.playbackBusy.set(true);
    this.playbackError.set(null);
    try {
      if (np?.isPlaying) {
        await this.client.client.playback.pause(session.id);
      } else {
        await this.client.client.playback.resume(session.id);
      }
    } catch (err) {
      this.playbackError.set(this.playbackErrorFor(err));
    } finally {
      this.playbackBusy.set(false);
    }
  }

  // ─── Devices ──────────────────────────────────────────────────────────

  async loadDevices(): Promise<void> {
    const session = this.session();
    if (!session) return;
    this.devicesBusy.set(true);
    try {
      const res = await this.client.client.devices.list(session.id);
      this.devices.set(res.devices);
    } catch {
      this.devices.set([]);
    } finally {
      this.devicesBusy.set(false);
    }
  }

  async onActivateDevice(deviceId: string): Promise<void> {
    const session = this.session();
    if (!session) return;
    this.devicesBusy.set(true);
    try {
      await this.client.client.devices.activate(session.id, deviceId);
      await this.loadDevices();
    } catch {
      // realtime will resync
    } finally {
      this.devicesBusy.set(false);
    }
  }

  // ─── Audit log ────────────────────────────────────────────────────────

  async toggleAuditLog(): Promise<void> {
    const next = !this.auditOpen();
    this.auditOpen.set(next);
    if (next) {
      await this.loadAuditLog();
      this.startAuditPolling();
    } else {
      this.stopAuditPolling();
    }
  }

  private startAuditPolling(): void {
    this.stopAuditPolling();
    this.auditPollTimer = setInterval(() => {
      void this.loadAuditLog();
    }, 5000);
  }

  private stopAuditPolling(): void {
    if (this.auditPollTimer) {
      clearInterval(this.auditPollTimer);
      this.auditPollTimer = null;
    }
  }

  async loadAuditLog(): Promise<void> {
    const session = this.session();
    if (!session) return;
    this.auditLoading.set(true);
    try {
      const events = await this.client.client.sessions.auditLog(session.id, { limit: 200 });
      this.auditLog.set(events);
    } catch {
      this.auditLog.set([]);
    } finally {
      this.auditLoading.set(false);
    }
  }

  formatEntryEta(trackUri: string): string | null {
    const ms = this.etaMap().get(trackUri);
    return ms === undefined ? null : formatEta(ms);
  }

  formatAuditTime(epochMs: number): string {
    const d = new Date(epochMs);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  formatAuditAction(action: string): string {
    const labels: Record<string, string> = {
      'queue.requested': 'requested',
      'queue.approved': 'approved',
      'queue.rejected': 'rejected',
      'queue.removed': 'removed',
      'queue.host_provider_rejected': 'removed Spotify track',
      'skip_vote.cast': 'voted to skip',
      'skip_vote.now_playing_cast': 'voted to skip (now playing)',
      'skip_vote.provider_track_cast': 'voted to skip (Spotify track)',
      'skip_vote.threshold_reached': 'skip threshold reached',
      'playback.skip': 'skipped',
      'playback.pause': 'paused',
      'playback.resume': 'resumed',
      'playback.device_activated': 'activated device',
      'session.created': 'created session',
      'session.ended': 'ended session',
      'session.settings_updated': 'updated settings',
      'system.auto_skip_rejected': 'auto-skipped rejected track',
      'system.item_marked_played': 'marked played',
    };
    return labels[action] ?? action;
  }

  formatAuditDetail(event: AuditEventWire): string {
    const d = event.details;
    if (!d || typeof d !== 'object') return '';
    const trackName = typeof d['trackName'] === 'string' ? d['trackName'] : null;
    if (trackName) {
      const artist = typeof d['artistName'] === 'string' ? d['artistName'] : null;
      return artist ? `${trackName} — ${artist}` : trackName;
    }
    if (event.action === 'session.settings_updated' && typeof d['changes'] === 'object') {
      const keys = Object.keys(d['changes'] as object);
      return keys.join(', ');
    }
    if (event.action === 'playback.device_activated' && typeof d['deviceId'] === 'string') {
      return `device ${(d['deviceId'] as string).slice(0, 8)}`;
    }
    return '';
  }

  // ─── End session ──────────────────────────────────────────────────────

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

  // ─── Misc UI ──────────────────────────────────────────────────────────

  copyUrl(): void {
    const url = this.guestUrl();
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(() => {
      this.urlCopied.set(true);
      setTimeout(() => this.urlCopied.set(false), 2000);
    });
  }

  /** Web Share API availability — `false` on desktop browsers without it. */
  canShare(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  }

  async shareUrl(): Promise<void> {
    const session = this.session();
    const url = this.guestUrl();
    if (!session || !url) return;
    if (!this.canShare()) {
      this.copyUrl();
      return;
    }
    try {
      await navigator.share({
        title: `Join ${session.name} on OpenDJ`,
        text: `Add songs to the queue at ${session.name}.`,
        url,
      });
    } catch {
      // User canceled or share failed — silent.
    }
  }

  openQrFullscreen(): void {
    this.qrFullscreen.set(true);
  }

  closeQrFullscreen(): void {
    this.qrFullscreen.set(false);
  }

  /**
   * Save the QR code as an SVG file. SVG so it stays sharp at any
   * print size — the host can drop it into a printer-ready flyer
   * without re-rasterizing.
   */
  async downloadQr(): Promise<void> {
    const session = this.session();
    const url = this.guestUrl();
    if (!session || !url) return;
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 2,
        width: 1024,
        color: { dark: '#0a0a12', light: '#ffffff' },
      });
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `opendj-${session.qrSlug}.svg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch {
      // best-effort — silent on failure.
    }
  }

  /**
   * Open a printable poster in a new window: session name, OpenDJ
   * branding, the join URL, the QR code, and a short hint. Auto-
   * triggers print() once the document loads so the host can hit
   * "Save as PDF" or send straight to a printer.
   */
  async openPrintView(): Promise<void> {
    const session = this.session();
    const url = this.guestUrl();
    if (!session || !url) return;
    let qrSvg = '';
    try {
      qrSvg = await QRCode.toString(url, {
        type: 'svg',
        margin: 2,
        width: 600,
        color: { dark: '#0a0a12', light: '#ffffff' },
      });
    } catch {
      return;
    }
    // Use a Blob URL — opening about:blank with `noopener` returns null,
    // and `document.write` against a popup is blocked by some browsers
    // anyway. The Blob URL gets loaded as a real document by the new tab.
    // Revoked after a generous delay so the tab has time to fetch it.
    const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escape(session.name)} — OpenDJ join code</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    /* margin:0 on @page tells the browser there's no header/footer
       region — Chrome, Edge and Firefox suppress the URL / date /
       page-number lines when the page margin is zero. The poster
       carries its own internal padding so content still breathes. */
    @page { size: auto; margin: 0; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      margin: 0;
      padding: 16mm 12mm;
      color: #1a0a14;
      background: #fff;
      display: flex;
      justify-content: center;
    }
    .poster {
      max-width: 720px;
      width: 100%;
      text-align: center;
      display: flex;
      flex-direction: column;
      gap: 24px;
      align-items: center;
    }
    .brand {
      font-size: 13px;
      letter-spacing: 0.4em;
      text-transform: uppercase;
      color: #6e5e8a;
      margin: 0;
    }
    h1 {
      font-size: clamp(32px, 6vw, 56px);
      font-family: 'Syne', 'Helvetica Neue', sans-serif;
      margin: 0;
      line-height: 1.1;
    }
    .lead {
      font-size: 18px;
      color: #4a3d5e;
      margin: 0;
    }
    .qr-wrap {
      padding: 24px;
      background: #fff;
      border: 2px solid #0a0a12;
      border-radius: 16px;
      width: clamp(260px, 60vw, 480px);
      aspect-ratio: 1 / 1;
      display: grid;
      place-items: center;
    }
    .qr-wrap svg { width: 100%; height: 100%; display: block; }
    .url {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 16px;
      word-break: break-all;
      padding: 12px 16px;
      background: #f4ecff;
      border: 1px dashed #a855f7;
      border-radius: 8px;
      max-width: 100%;
    }
    .footer {
      margin-top: 8px;
      color: #6e5e8a;
      font-size: 13px;
    }
    .footer strong { color: #1a0a14; }
    @media print {
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="poster">
    <p class="brand">OpenDJ • Live request queue</p>
    <h1>${escape(session.name)}</h1>
    <p class="lead">Scan the code or visit the link to add songs to the queue.</p>
    <div class="qr-wrap">${qrSvg}</div>
    <div class="url">${escape(url)}</div>
    <p class="footer">
      Powered by <strong>OpenDJ</strong> — open-source crowd-sourced jukebox for live events.
    </p>
  </div>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));<\/script>
</body>
</html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    const win = globalThis.open(blobUrl, '_blank');
    if (!win) {
      // Popup blocked — drop the URL right away.
      URL.revokeObjectURL(blobUrl);
      return;
    }
    // Give the new tab plenty of time to load + run window.print() before
    // we revoke. 60s is generous and harmless — the URL is unique to this
    // page load.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }

  // ─── Bootstrap + realtime ─────────────────────────────────────────────

  private async bootstrap(sessionId: string): Promise<void> {
    try {
      const session = await this.client.client.sessions.getById(sessionId);
      this.session.set(session);
      await this.refreshQueue();
      this.openRealtime(session.id);
      // Eager-load devices so the picker label reads "Playing on …" the
      // first frame instead of "No active device" until the user clicks.
      // Failure is non-fatal — the picker re-fetches on expand anyway.
      void this.loadDevices();
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
      // Don't override the queue from the snapshot. The room is in-memory
      // and only reflects events fired since it materialized — anything
      // requested before this server boot (or before the first WS subscriber)
      // is in the DB but missing from snapshot.pending/queue. The /queue
      // endpoint is authoritative; refreshQueue() ran during bootstrap.
    });
    this.realtime.on('now_playing.updated', (event) => {
      const prevZone = this.nowPlaying()?.zoneId;
      this.nowPlaying.set(event.track);
      this.nowPlayingAt.set(Date.now());
      // The host may have switched devices (e.g. AirPods → Sonos) outside
      // OpenDJ. zoneId carries the Spotify device id — when it changes,
      // re-load the device list so the picker reflects reality.
      if (event.track && event.track.zoneId !== prevZone) {
        void this.loadDevices();
      }
    });
    this.realtime.on('provider_queue.updated', (event) => {
      this.providerQueue.set(event.tracks);
      // Drop optimistic-removal entries for URIs Spotify itself dropped;
      // keep entries that are still surfaced (track hasn't been auto-
      // skipped yet) so the row stays hidden.
      const stillThere = new Set(event.tracks.map((t) => t.uri));
      this.removedUris.update((s) => {
        const next = new Set<string>();
        for (const uri of s) if (stillThere.has(uri)) next.add(uri);
        return next;
      });
    });
    this.realtime.onEvent((event: SessionEvent) => {
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

  private playbackErrorFor(err: unknown): string {
    if (!(err instanceof ApiError)) return 'Playback control failed.';
    switch (err.code) {
      case 'no_provider_connected':
        return 'Connect Spotify on the dashboard first.';
      case 'playback_skip_not_supported':
      case 'playback_pause_not_supported':
      case 'playback_resume_not_supported':
        return "Your provider doesn't support that action.";
      default:
        return `Playback control failed (${err.code}).`;
    }
  }
}
