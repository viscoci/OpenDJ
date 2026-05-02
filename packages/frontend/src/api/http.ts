/**
 * Low-level HTTP transport used by every resource module.
 *
 * Owns:
 * - Building absolute URLs from a base URL + path + query
 * - JSON encoding the body and decoding the response
 * - Mapping non-2xx responses to `ApiError`
 * - Forwarding session cookies (browser default `credentials: 'include'`)
 *
 * Slot-token-authenticated guest endpoints take an `x-slot-token` header.
 * The transport accepts a `slotToken` option to set it without leaking the
 * header into every method signature.
 */

import { ApiError, NetworkError, type ApiErrorPayload } from './errors.js';

export interface HttpClientOptions {
  /** Base URL — typically the API origin, e.g. `https://app.opendj.live`. No trailing slash. */
  baseUrl: string;
  /** fetch impl. Defaults to `globalThis.fetch`. SSR/tests can pass their own. */
  fetchImpl?: typeof fetch;
  /**
   * Whether to send cookies cross-origin. Browser default is 'same-origin' but
   * OpenDJ's session cookie is `__Host-` scoped so cross-origin cookie sending
   * is moot — `'include'` is set so embedded scenarios (e.g. an iframe under a
   * different origin) still send the cookie when the browser allows it.
   */
  credentials?: RequestCredentials;
  /** Default headers attached to every request. Useful for `Accept-Language`. */
  defaultHeaders?: Readonly<Record<string, string>>;
  /**
   * Hook fired the first time a 401 is observed. Useful for triggering a
   * client-side redirect to login. Synchronous — keep it cheap.
   */
  onUnauthorized?: () => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  /** Query string params. Values are URL-encoded; nullish entries are dropped. */
  query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  /** JSON body. Stringified before send. */
  body?: unknown;
  /** Extra request headers — merged on top of `defaultHeaders`. */
  headers?: Readonly<Record<string, string>>;
  /** Sets `x-slot-token` for guest-authenticated endpoints. */
  slotToken?: string | undefined;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly credentials: RequestCredentials;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly onUnauthorized: (() => void) | undefined;
  private notifiedUnauthorized = false;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.credentials = options.credentials ?? 'include';
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.onUnauthorized = options.onUnauthorized;
  }

  /**
   * Perform a request and return the parsed JSON body. Throws `ApiError` on
   * non-2xx, `NetworkError` when fetch itself fails (DNS, offline, abort).
   *
   * The 204 No Content path returns `undefined as unknown as T` — callers
   * that hit DELETE/end-style endpoints should type the response as `void`.
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.defaultHeaders,
      ...options.headers,
    };
    if (options.slotToken) headers['x-slot-token'] = options.slotToken;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      credentials: this.credentials,
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (options.signal) init.signal = options.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new NetworkError(`OpenDJ API request to ${url} failed`, err);
    }

    if (response.status === 204) return undefined as unknown as T;

    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const payload: unknown = isJson
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => '');

    if (!response.ok) {
      if (response.status === 401 && !this.notifiedUnauthorized) {
        this.notifiedUnauthorized = true;
        try {
          this.onUnauthorized?.();
        } catch {
          // The hook errored — don't mask the API error.
        }
      }
      const errorPayload: ApiErrorPayload =
        isJson && typeof payload === 'object' && payload !== null
          ? (payload as ApiErrorPayload)
          : { error: typeof payload === 'string' ? payload : `http_${response.status}` };
      throw new ApiError(response.status, errorPayload);
    }
    return payload as T;
  }

  private buildUrl(
    path: string,
    query?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${normalized}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }
}
