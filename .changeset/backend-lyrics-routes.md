---
'@opendj/backend': minor
---

Add `LyricsLookupService` + lyrics routes — public lookup, session-scoped current/feedback.

**`LyricsCacheRepository` + `LyricsFeedbackRepository`** (interface + InMemory + Drizzle):

- `LyricsCacheRepository.upsert` keyed on `(source, lookupKeyHash)` via `onConflictDoUpdate`; `recordHit` / `suppress`
- `LyricsFeedbackRepository.create` + `countForCacheEntry(cacheId, kind?)` for the auto-suppression sweep

**`LyricsLookupService`** (`@opendj/backend/lyrics/LyricsLookupService.ts`):

- `lookup({ trackName, artistName, ... })` — normalizes via `@opendj/lyrics`'s `normalizeLookup`, hashes the cache key, tries the cache first, falls through to the provider on miss
- Persists positive **and negative** results (negative = `isSynced=false, syncedLrc=null, plainLyrics=null, matchConfidence='low'`) so repeated lookups for known-misses don't re-hit the provider
- Provider exceptions are swallowed silently (per brief: "never make provider playback fail because lyrics lookup fails")
- Suppressed cache entries return `null` even when the data is still in the row
- `recordFeedback` — persists + auto-suppresses the cache entry after **3 reports of the same kind** for `wrong_song` / `bad_timing` / `offensive_or_bad_content` (other kinds are tracked but don't auto-suppress)

**Routes** (`@opendj/backend/routes/lyrics.ts`):

- `GET /api/v1/lyrics/lookup?trackName=...&artistName=...&albumName?&durationMs?&providerTrackUri?` — public; always returns 200 with `{ match: LyricsDocument | null }`
- `GET /api/v1/sessions/:id/lyrics/current?trackName=&artistName=` — thin pass-through to `lookup` until the WS slice wires room introspection
- `POST /api/v1/sessions/:id/lyrics/feedback` — open to anyone (logged-in guests + hosts get richer attribution via slot-token bearer); 400 on bad body or unknown kind

**Wired into `createApp`** at `/api/v1/lyrics` and `/api/v1/sessions/:id/lyrics`. `createDeps` instantiates `LrclibAdapter` by default; tests override via `lyricsProvider`.

**10 new tests** (205 total in backend) covering miss → fetch → persist (positive + negative + provider error), hit → no-fetch (including normalization-equivalent inputs), suppression read-through, feedback insert, and the auto-suppression threshold (per-kind counting, only the configured kinds, no premature suppression).
