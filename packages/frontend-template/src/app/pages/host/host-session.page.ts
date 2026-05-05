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
  type PlaybackDeviceWire,
  type SessionWire,
} from '@opendj/frontend';
import type { NowPlayingTrack } from '@opendj/core';
import type { SessionEvent, SessionSnapshot } from '@opendj/realtime';
import { DevicePickerComponent } from '../../components/device-picker.component.js';
import { NowPlayingCardComponent } from '../../components/now-playing-card.component.js';
import { QrCodeComponent } from '../../components/qr-code.component.js';
import { QueueListComponent, type QueueListItem } from '../../components/queue-list.component.js';
import { RecentlyPlayedListComponent } from '../../components/recently-played-list.component.js';
import { OpenDjClientService } from '../../services/opendj-client.service.js';

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
              <app-qr-code [value]="guestUrl()" [size]="120" />
              <div class="qr-meta">
                <p class="qr-eyebrow">Scan to join</p>
                <code class="qr-url">{{ guestUrl() }}</code>
                <button type="button" class="copy" (click)="copyUrl()">
                  {{ urlCopied() ? 'Copied ✓' : 'Copy URL' }}
                </button>
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

        <section class="queue card">
          <h2>Queue</h2>
          <app-queue-list
            [items]="queue()"
            mode="host"
            (approve)="moderate($event, 'approved')"
            (reject)="moderate($event, 'rejected')"
            (remove)="onRemove($event)"
            emptyText="Queue is empty. Send guests to the URL above."
          />
        </section>

        @if (recentlyPlayed().length > 0) {
          <section class="card recently">
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
      .copy {
        align-self: flex-start;
        background: transparent;
        border: 1px solid #2c2440;
        color: #c8b8e9;
        padding: 4px 12px;
        border-radius: 999px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .copy:hover {
        border-color: #a855f7;
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
  readonly devices: WritableSignal<ReadonlyArray<PlaybackDeviceWire>> = signal([]);
  readonly devicesBusy = signal(false);
  readonly playbackBusy = signal(false);
  readonly playbackError = signal<string | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly ending = signal(false);
  readonly urlCopied = signal(false);

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

  // ─── Bootstrap + realtime ─────────────────────────────────────────────

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
      // Hosts see pending items too, so use the merged view from the snapshot.
      this.queue.set([...snapshot.pending, ...snapshot.queue]);
    });
    this.realtime.on('now_playing.updated', (event) => {
      this.nowPlaying.set(event.track);
      this.nowPlayingAt.set(Date.now());
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
