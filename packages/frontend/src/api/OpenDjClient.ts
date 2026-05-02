/**
 * Top-level API client. Aggregates per-resource modules behind one constructor.
 *
 * Usage:
 *
 * ```ts
 * const client = new OpenDjClient({ baseUrl: 'https://app.opendj.live' });
 * const me = await client.auth.me();
 * const queue = await client.queue.list(sessionId);
 * ```
 *
 * Designed for both Angular (consumed via DI provider) and plain browser
 * scripts (constructed directly). Zero Angular dependency in this layer.
 */

import { AuthApi } from './auth.js';
import { GuestApi } from './guest.js';
import { HttpClient, type HttpClientOptions } from './http.js';
import { LyricsApi } from './lyrics.js';
import { QueueApi } from './queue.js';
import { SessionsApi } from './sessions.js';

export class OpenDjClient {
  readonly http: HttpClient;
  readonly auth: AuthApi;
  readonly sessions: SessionsApi;
  readonly queue: QueueApi;
  readonly guest: GuestApi;
  readonly lyrics: LyricsApi;

  constructor(options: HttpClientOptions) {
    this.http = new HttpClient(options);
    this.auth = new AuthApi(this.http);
    this.sessions = new SessionsApi(this.http);
    this.queue = new QueueApi(this.http);
    this.guest = new GuestApi(this.http);
    this.lyrics = new LyricsApi(this.http);
  }
}
