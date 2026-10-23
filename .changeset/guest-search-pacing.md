---
'@opendj/backend': minor
'@opendj/frontend': minor
'@opendj/db': minor
---

Pace guest search so it can't exhaust the Spotify quota, and keep Spotify cooldowns across restarts.

- Search now runs against a per-provider search budget (`SEARCH_BUDGET_LIMIT` per `SEARCH_BUDGET_WINDOW_MS`, default 3 per 30s) plus a per-guest limit (`SEARCH_GUEST_LIMIT`) and a shared anonymous limit (`SEARCH_ANON_LIMIT`) for tokenless callers. Cached and in-flight-shared searches are always served and never count.
- New refusals: 429 `search_too_fast` and 503 `search_busy`, each with `retryAfterSec` and a `Retry-After` header. An open provider cooldown still returns 503 `provider_rate_limited` without spending budget.
- A client that retries before the wait it was given is refused and charged against its own limit, so clients ignoring `Retry-After` stop winning freed search slots from guests who wait.
- Successful searches carry `slowDown: { debounceMs, ttlSec }` when the budget is nearly spent (`SEARCH_SLOWDOWN_*`).
- Search accepts optional guest auth (`Authorization: Bearer <slotToken>`); `QueueApi.search` takes `{ slotToken, signal }`.
- Provider cooldowns are kept per quota group (`search` for `/v1/search`, `player` for everything else), so a search quota no longer pauses now-playing or queue pushes, and only player cooldowns are announced to the party. They persist in `provider_connections.rate_limited_until` / `search_rate_limited_until` (migrations 0008, 0009), clamped to `PROVIDER_COOLDOWN_MAX_SEC` (default 24h), and `StreamingRouter` seeds them back on load so a restart never calls the provider inside a cooldown. Each stored cooldown records the Spotify client id (`rate_limited_client_id`); one from a different or unknown client id is ignored.
- Provider 429s log their `reason` and `Retry-After`, and per-endpoint provider call counts log every 30s.
