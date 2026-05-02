import { Injectable, InjectionToken, inject, signal, type Signal } from '@angular/core';
import { OpenDjClient } from '@opendj/frontend';

/**
 * DI token for the API base URL. Set via `provideOpenDj({ apiBaseUrl })` in
 * `app.config.ts`. Lets tests / Storybook / Capacitor builds override it.
 *
 * For dev, the dev-server proxies `/api` to the backend on :8888 — leaving
 * this empty makes requests relative-path which is fine in the browser.
 */
export const API_BASE_URL = new InjectionToken<string>('OPENDJ_API_BASE_URL');

/**
 * Thin Angular wrapper around `OpenDjClient` from `@opendj/frontend`.
 *
 * Owns:
 * - Construction of the client (one per app)
 * - A reactive `unauthorized` signal flipped on the first 401, so route
 *   guards / shells can redirect to login
 *
 * Component code uses `client.client.queue.list(...)` etc. directly. The
 * service intentionally doesn't wrap each method — the underlying API is
 * already typed and stable.
 */
@Injectable({ providedIn: 'root' })
export class OpenDjClientService {
  private readonly _unauthorized = signal(false);
  readonly client: OpenDjClient;

  constructor() {
    const baseUrl = inject(API_BASE_URL, { optional: true }) ?? '';
    this.client = new OpenDjClient({
      baseUrl,
      onUnauthorized: () => this._unauthorized.set(true),
    });
  }

  /** Reactive flag — flips true on first 401. Reset via `clearUnauthorized()`. */
  get unauthorized(): Signal<boolean> {
    return this._unauthorized.asReadonly();
  }

  clearUnauthorized(): void {
    this._unauthorized.set(false);
  }
}
