---
'@opendj/backend': minor
'@opendj/frontend': minor
---

Add `/api/v1/sessions/:id/search?q=...&limit=...` — track search proxied through the session's connected streaming provider.

**Why**

The guest request page currently makes guests type a Spotify URI by hand. That's MVP-acceptable for proving the round-trip but a non-starter for real users. The search proxy is the missing piece between "host connected Spotify" and "guest picks a track."

**Backend (`@opendj/backend`)**

- New route mounted at `/api/v1/sessions/:id/search`. Public — no auth or slot token required (guests need to search to make requests).
- Resolves the session, picks the first connected provider on its account, type-guards for `supportsSearch`, and forwards the query.
- Status code matrix:
  - 200 — `{ results: [{ trackUri, trackName, artistName, albumArtUrl, durationMs }], providerId }`
  - 400 `invalid_query` — missing/blank `q`, or `limit` outside 1..50
  - 404 `session_not_found` / `session_ended`
  - 501 `search_not_supported` — provider connected but doesn't implement search (e.g. AppleMusic stub). Type guard prevents the call from happening.
  - 502 `provider_error` — search failed at the provider edge
  - 503 `no_provider_connected` — account has no streaming provider linked

**Frontend (`@opendj/frontend`)**

- `client.queue.search(sessionId, query, limit?)` returns `SearchResponse`.

**Tests**

- 6 new backend tests using a hand-rolled `MockSearchProvider` (implements `IStreamingProvider + ISupportsSearch`) plus a `NoSearchProvider` for the 501 path. No real Spotify calls, no fixtures from real APIs.
