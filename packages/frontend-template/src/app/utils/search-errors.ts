import { ApiError } from '@opendj/frontend';

/** "12 seconds", "1 second", "2 minutes" — rounded up so we never undersell the wait. */
function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * A readable message for the search rate-limit errors (`search_too_fast`,
 * `search_busy`, `provider_rate_limited`), using `payload.retryAfterSec` when
 * present. Null for any other error.
 */
export function searchRateLimitMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const raw = err.payload['retryAfterSec'];
  const retryAfterSec = typeof raw === 'number' && raw > 0 ? Math.ceil(raw) : null;
  const when = retryAfterSec !== null ? `in ${formatWait(retryAfterSec)}` : 'shortly';
  switch (err.code) {
    case 'search_too_fast':
      return `You're searching a little fast. Try again ${when}.`;
    case 'search_busy':
      return `Search is busy right now. Try again ${when}.`;
    case 'provider_rate_limited':
      return `The music service is limiting searches. Try again ${when}.`;
    default:
      return null;
  }
}
