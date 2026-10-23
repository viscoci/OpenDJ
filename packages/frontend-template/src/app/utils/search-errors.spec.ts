import { ApiError } from '@opendj/frontend';
import { searchRateLimitMessage } from './search-errors.js';

describe('searchRateLimitMessage', () => {
  it('asks a too-fast guest to wait the server-given seconds', () => {
    const err = new ApiError(429, { error: 'search_too_fast', retryAfterSec: 12 });
    expect(searchRateLimitMessage(err)).toBe(
      "You're searching a little fast. Try again in 12 seconds.",
    );
  });

  it('explains a busy search budget with the wait', () => {
    const err = new ApiError(503, { error: 'search_busy', retryAfterSec: 1 });
    expect(searchRateLimitMessage(err)).toBe('Search is busy right now. Try again in 1 second.');
  });

  it('explains a provider rate limit, even without a wait', () => {
    expect(
      searchRateLimitMessage(
        new ApiError(503, { error: 'provider_rate_limited', retryAfterSec: 90 }),
      ),
    ).toBe('The music service is limiting searches. Try again in 2 minutes.');
    expect(
      searchRateLimitMessage(
        new ApiError(503, { error: 'provider_rate_limited', retryAfterSec: null }),
      ),
    ).toBe('The music service is limiting searches. Try again shortly.');
  });

  it('returns null for anything else', () => {
    expect(searchRateLimitMessage(new ApiError(502, { error: 'provider_error' }))).toBeNull();
    expect(searchRateLimitMessage(new Error('boom'))).toBeNull();
  });
});
