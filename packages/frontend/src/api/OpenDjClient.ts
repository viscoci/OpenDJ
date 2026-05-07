/**
 * Top-level API client. Aggregates per-resource modules behind one constructor.
 *
 * Usage:
 *
 * ```ts
 * const client = new OpenDjClient({ baseUrl: 'https://your-app.example' });
 * const me = await client.auth.me();
 * const queue = await client.queue.list(sessionId);
 * ```
 *
 * Designed for both Angular (consumed via DI provider) and plain browser
 * scripts (constructed directly). Zero Angular dependency in this layer.
 */

import { AuthApi } from './auth.js';
import { DevicesApi } from './devices.js';
import { GuestApi } from './guest.js';
import { HttpClient, type HttpClientOptions } from './http.js';
import { LyricsApi } from './lyrics.js';
import { PlaybackApi } from './playback.js';
import { ProviderConnectionsApi } from './providerConnections.js';
import { PublicConfigApi } from './publicConfig.js';
import { QueueApi } from './queue.js';
import { SessionsApi } from './sessions.js';

export class OpenDjClient {
  readonly http: HttpClient;
  readonly auth: AuthApi;
  readonly sessions: SessionsApi;
  readonly queue: QueueApi;
  readonly guest: GuestApi;
  readonly lyrics: LyricsApi;
  readonly providerConnections: ProviderConnectionsApi;
  readonly publicConfig: PublicConfigApi;
  readonly playback: PlaybackApi;
  readonly devices: DevicesApi;

  constructor(options: HttpClientOptions) {
    this.http = new HttpClient(options);
    this.auth = new AuthApi(this.http);
    this.sessions = new SessionsApi(this.http);
    this.queue = new QueueApi(this.http);
    this.guest = new GuestApi(this.http);
    this.lyrics = new LyricsApi(this.http);
    this.providerConnections = new ProviderConnectionsApi(this.http);
    this.publicConfig = new PublicConfigApi(this.http);
    this.playback = new PlaybackApi(this.http);
    this.devices = new DevicesApi(this.http);
  }
}
