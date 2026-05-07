/**
 * /host/dashboard — list current account's sessions + create button.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  ApiError,
  type ProviderConnectionWire,
  type PublicConfig,
  type SessionWire,
} from '@opendj/frontend';
import { AuthService } from '../../services/auth.service.js';
import { OpenDjClientService } from '../../services/opendj-client.service.js';

@Component({
  selector: 'app-host-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <header>
        <h1>Your sessions</h1>
        <div class="user">
          @if (auth.currentUser(); as me) {
            <span class="email">{{ me.user.primaryEmail || 'host' }}</span>
          }
          <button type="button" class="ghost" (click)="logout()">Sign out</button>
        </div>
      </header>

      @if (loading()) {
        <p class="loading">Loading…</p>
      } @else if (loadError()) {
        <p class="error">{{ loadError() }}</p>
      } @else {
        <section class="provider-card">
          <h2>Music providers</h2>
          @if (spotifyConnection(); as conn) {
            <div class="provider-row connected">
              <div class="provider-meta">
                <span class="provider-name">Spotify</span>
                <span class="provider-detail"
                  >Connected{{ conn.displayName ? ' as ' + conn.displayName : '' }}</span
                >
              </div>
              <a class="ghost" [href]="spotifyConnectUrl()">Reconnect</a>
            </div>
          } @else if (spotifyConfigured()) {
            <div class="provider-row">
              <div class="provider-meta">
                <span class="provider-name">Spotify</span>
                <span class="provider-detail"
                  >Connect to enable song search + playback in your sessions.</span
                >
              </div>
              <a class="primary" [href]="spotifyConnectUrl()">Connect Spotify</a>
            </div>
          } @else {
            <div class="provider-row disabled">
              <div class="provider-meta">
                <span class="provider-name">Spotify</span>
                <span class="provider-detail"
                  >Not configured on this server. Set <code>SPOTIFY_CLIENT_ID</code> and
                  <code>SPOTIFY_CLIENT_SECRET</code> in <code>apps/oss-demo/.env</code> and restart,
                  then come back to connect.</span
                >
              </div>
              <span class="ghost disabled" aria-disabled="true">Connect Spotify</span>
            </div>
          }
        </section>

        <section class="create-card">
          <h2>Start a new session</h2>
          <form (ngSubmit)="createSession()">
            <label>
              <span>Session name</span>
              <input
                type="text"
                name="name"
                [(ngModel)]="newSession.name"
                placeholder="e.g. Friday Night Karaoke"
                required
              />
            </label>
            <label>
              <span>QR slug (optional, auto-generated if blank)</span>
              <input
                type="text"
                name="qrSlug"
                [(ngModel)]="newSession.qrSlug"
                placeholder="friday-karaoke"
              />
            </label>
            <button type="submit" [disabled]="creating()">
              {{ creating() ? 'Creating…' : 'Create session' }}
            </button>
            @if (createError()) {
              <p class="error">{{ createError() }}</p>
            }
          </form>
        </section>

        <section class="session-list">
          @if (sessions().length === 0) {
            <p class="empty">No sessions yet — create one above.</p>
          } @else {
            @for (s of sessions(); track s.id) {
              <div class="session-row">
                <a class="session-row-main" [routerLink]="['/host/sessions', s.id]">
                  <div class="meta">
                    <span class="name">{{ s.name }}</span>
                    <span class="slug">/u/{{ s.qrSlug }}</span>
                  </div>
                  <span class="status" [attr.data-status]="s.endedAt ? 'ended' : 'live'">
                    {{ s.endedAt ? 'Ended' : 'Live' }}
                  </span>
                </a>
                @if (!s.endedAt) {
                  <a
                    class="tv-link"
                    [routerLink]="['/tv', s.qrSlug]"
                    target="_blank"
                    rel="noopener"
                    title="Open the public TV view in a new tab"
                  >
                    TV view ↗
                  </a>
                }
              </div>
            }
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
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
      }
      h1 {
        font-family: 'Syne', 'Inter', sans-serif;
        font-size: 24px;
        margin: 0;
        background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .user {
        display: flex;
        gap: 12px;
        align-items: center;
      }
      .email {
        font-size: 13px;
        color: #a294c5;
      }
      .ghost {
        background: transparent;
        border: 1px solid #2c2440;
        color: #c8b8e9;
        padding: 6px 12px;
        border-radius: 8px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
      }
      .create-card,
      .provider-card {
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 14px;
        padding: 20px;
        margin-bottom: 16px;
      }
      .provider-card .provider-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .provider-row.connected .provider-name::before {
        content: '● ';
        color: #34d399;
        margin-right: 4px;
      }
      .provider-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .provider-name {
        font-weight: 600;
        font-size: 14px;
      }
      .provider-detail {
        font-size: 12px;
        color: #a294c5;
      }
      a.primary {
        background: #1db954;
        color: #062013;
        text-decoration: none;
        padding: 8px 14px;
        border-radius: 999px;
        font-weight: 600;
        font-size: 13px;
        white-space: nowrap;
      }
      a.ghost {
        background: transparent;
        border: 1px solid #2c2440;
        color: #c8b8e9;
        text-decoration: none;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        white-space: nowrap;
      }
      .provider-row.disabled .provider-detail {
        color: #6e5e8a;
      }
      .provider-row.disabled code {
        background: #0c0a14;
        border: 1px solid #2c2440;
        padding: 1px 5px;
        border-radius: 4px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 11px;
        color: #c8b8e9;
      }
      .ghost.disabled {
        background: transparent;
        border: 1px solid #2c2440;
        color: #6e5e8a;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        white-space: nowrap;
        cursor: not-allowed;
        user-select: none;
      }
      h2 {
        font-family: 'Syne', 'Inter', sans-serif;
        font-size: 16px;
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
        font: inherit;
        font-size: 14px;
      }
      input:focus {
        outline: 2px solid #a855f7;
        outline-offset: 1px;
      }
      button[type='submit'] {
        padding: 10px;
        border-radius: 10px;
        border: 0;
        background: linear-gradient(135deg, #a855f7, #ec4899);
        color: white;
        font-weight: 600;
        cursor: pointer;
      }
      button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .error {
        color: #fda4af;
        font-size: 13px;
        margin: 0;
      }
      .loading {
        color: #a294c5;
      }
      .session-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .session-row {
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 12px;
        display: flex;
        align-items: stretch;
        gap: 0;
        overflow: hidden;
      }
      .session-row:hover {
        border-color: #a855f7;
      }
      .session-row-main {
        flex: 1;
        padding: 14px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        text-decoration: none;
        color: inherit;
        min-width: 0;
      }
      .tv-link {
        display: flex;
        align-items: center;
        padding: 0 16px;
        text-decoration: none;
        color: #c8b8e9;
        font-size: 12px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        letter-spacing: 0.04em;
        border-left: 1px solid #2c2440;
        background: rgba(168, 85, 247, 0.06);
        white-space: nowrap;
      }
      .tv-link:hover {
        background: rgba(168, 85, 247, 0.16);
        color: #fff;
      }
      .meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .name {
        font-weight: 600;
      }
      .slug {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 12px;
        color: #a294c5;
      }
      .status {
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 999px;
        background: #2c2440;
        color: #c8b8e9;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .status[data-status='live'] {
        background: linear-gradient(135deg, #34d399, #10b981);
        color: #042f2e;
      }
      .empty {
        color: #a294c5;
        font-style: italic;
      }
    `,
  ],
})
export class HostDashboardPage {
  readonly auth = inject(AuthService);
  private readonly client = inject(OpenDjClientService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly sessions: WritableSignal<ReadonlyArray<SessionWire>> = signal([]);
  readonly connections: WritableSignal<ReadonlyArray<ProviderConnectionWire>> = signal([]);
  readonly publicConfig: WritableSignal<PublicConfig | null> = signal(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly creating = signal(false);
  readonly createError = signal<string | null>(null);

  newSession = { name: '', qrSlug: '' };

  spotifyConnection(): ProviderConnectionWire | null {
    return this.connections().find((c) => c.providerId === 'spotify') ?? null;
  }

  spotifyConfigured(): boolean {
    return this.publicConfig()?.musicProviders.spotify ?? false;
  }

  spotifyConnectUrl(): string {
    return this.client.client.providerConnections.startConnectUrl('spotify');
  }

  constructor() {
    void this.refresh();
    this.destroyRef.onDestroy(() => undefined);
  }

  async logout(): Promise<void> {
    await this.auth.logout();
  }

  async createSession(): Promise<void> {
    this.creating.set(true);
    this.createError.set(null);
    try {
      const created = await this.client.client.sessions.create({
        name: this.newSession.name.trim(),
        ...(this.newSession.qrSlug.trim() && { qrSlug: this.newSession.qrSlug.trim() }),
      });
      this.newSession = { name: '', qrSlug: '' };
      await this.router.navigate(['/host/sessions', created.id]);
    } catch (err) {
      if (err instanceof ApiError) {
        this.createError.set(this.errorFor(err.code));
      } else {
        this.createError.set('Could not create the session.');
      }
    } finally {
      this.creating.set(false);
    }
  }

  private async refresh(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      // Fetch sessions and provider connections in parallel — they're
      // independent and the dashboard renders both before user can interact.
      const [sessions, connections, publicConfig] = await Promise.all([
        this.client.client.sessions.listForCurrentAccount(),
        this.client.client.providerConnections.me().catch(() => [] as ProviderConnectionWire[]),
        this.client.client.publicConfig.get().catch(() => null),
      ]);
      this.sessions.set(sessions);
      this.connections.set(connections);
      this.publicConfig.set(publicConfig);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'no_active_account') {
        this.loadError.set('No account context — try signing out and back in.');
      } else {
        this.loadError.set('Could not load sessions.');
      }
    } finally {
      this.loading.set(false);
    }
  }

  private errorFor(code: string): string {
    switch (code) {
      case 'qr_slug_taken':
        return 'That QR slug is already in use. Pick a different one.';
      case 'no_active_account':
        return 'No account selected.';
      default:
        return `Could not create the session (${code}).`;
    }
  }
}
