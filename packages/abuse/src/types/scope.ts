/**
 * Rate limit scope. Same key value can be limited differently per scope —
 * a fingerprint hash gets one budget for `search`, another for `song_requested`.
 *
 * The string-and-template type lets adapters mint custom scopes without
 * widening to `string` and losing autocomplete.
 */
export type RateLimitScope =
  | 'search'
  | 'song_requested'
  | 'skip_vote'
  | 'guest_joined'
  | 'auth_login'
  | 'auth_register'
  | (string & {});

export interface RateLimitDecision {
  ok: boolean;
  /** When `ok === false`, how long until the client can retry (ms). Always present on rejections. */
  retryAfterMs: number;
  /** Remaining budget in the current window. */
  remaining: number;
  /** Maximum budget per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}
