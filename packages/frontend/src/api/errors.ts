/**
 * Error type the API client throws on non-2xx responses.
 *
 * The backend's error envelope is `{ error: string, issues?: string[] }`. The
 * client surfaces the code + raw payload so callers can branch on `code`.
 */

export interface ApiErrorPayload {
  error?: string;
  issues?: ReadonlyArray<string>;
  [k: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ReadonlyArray<string>;
  readonly payload: ApiErrorPayload;

  constructor(status: number, payload: ApiErrorPayload) {
    const code = typeof payload.error === 'string' ? payload.error : `http_${status}`;
    super(`OpenDJ API error: ${code} (HTTP ${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = payload.issues ?? [];
    this.payload = payload;
  }

  /** True when the error code matches one of the supplied values. */
  is(...codes: ReadonlyArray<string>): boolean {
    return codes.includes(this.code);
  }
}

export class NetworkError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}
