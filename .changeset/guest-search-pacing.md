---
'@opendj/backend': minor
'@opendj/frontend': minor
'@opendj/db': minor
---

Pace guest search so it can't exhaust the Spotify quota, and keep Spotify cooldowns across restarts.

- Search now runs against a per-provider search budget (`SEARCH_BUDGET_LIMIT` per `SEARCH_BUDGET_WINDOW_MS`, default 3 per 30s) plus a per-guest limit (`SEARCH_GUEST_LIMIT`) and a shared anonymous limit (`SEARCH_ANON_LIMIT`) for tokenless callers. Cached and in-flight-shared searches are always served and never count.
- New refusals: 429 `search_too_fast` and 503 `search_busy`, each with `retryAfterSec` and a `Retry-After` header. An open provider cooldown still returns 503 `provider_rate_limited` without spending budget.
- Successful searches carry `slowDown: { debounceMs, ttlSec }` when the budget is nearly spent (`SEARCH_SLOWDOWN_*`).
- Search accepts optional guest auth (`Authorization: Bearer <slotToken>`); `QueueApi.search` takes `{ slotToken, signal }`.
- `provider_connections.rate_limited_until` (migration 0008) persists provider cooldowns, clamped to `PROVIDER_COOLDOWN_MAX_SEC` (default 24h), and `StreamingRouter` seeds them back on load so a restart never calls the provider inside a cooldown.
- Provider 429s log their `reason` and `Retry-After`, and per-endpoint provider call counts log every 30s.
