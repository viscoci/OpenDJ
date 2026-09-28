---
'@opendj/backend': minor
'@opendj/realtime': minor
---

Stop exhausting the Spotify quota and stop failing silently when it's hit.

- `ProviderCooldowns`: one per-account rate-limit window shared by every caller. Any 429 opens it (from `Retry-After`); calls inside it fail fast with `ProviderRateLimitedError` instead of reaching Spotify.
- `NowPlayingPoller` makes ~3–6× fewer Spotify calls: 5s base cadence, 15s while nothing plays, and the provider queue is re-read only on track change, every 30s, or while a fresh request is syncing.
- New realtime event `provider.status_updated` and `snapshot.providerStatus` (`ok` | `rate_limited` with `untilEpochMs`) so clients can show the outage.
- Guest requests and host approvals during a cooldown return `503 provider_rate_limited` with `retryAfterSec` (the request is not silently accepted); search does the same and caches results per query for 60s.
