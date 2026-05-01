---
'@opendj/lyrics': minor
'@opendj/core': patch
'@opendj/sync': patch
---

Land `@opendj/lyrics` foundation: types, LRC parser, LRCLIB adapter, lookup-key normalization, sync-cue conversion, and lyric-window helper.

**Types** (mirrors `lyrics_cache` + `lyrics_feedback` schema):

- `LyricsProvider`, `LyricsLookupInput`, `LyricsLine`, `LyricsDocument`, `LyricsMatchConfidence`, `LyricsProviderId`
- `LyricsFeedbackKind` (`wrong_song` | `bad_timing` | `wrong_line` | `missing_lyrics` | `offensive_or_bad_content` | `other`) + `LyricsFeedbackInput`

**Lookup-key normalization:**

- `normalizeLookup(input)` lowercases, collapses whitespace/underscores, strips `(feat. X)` / `(Remastered 2011)` / `[Live]` / `(Remix)` noise, ASCII-fies curly quotes, rounds duration to seconds, uppercases ISRC
- `lookupCacheKey(normalized)` produces stable cross-provider cache keys (omits `providerTrackUri` so the same track from Spotify or Apple Music hits the same entry)

**LRC parser:**

- `parseLrc(raw)` handles `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss.xxx]` timestamps; multiple timestamps per line; left-aligns 1-digit fractions; sorts ascending; chains `endsAtMs` to next line; recognizes and skips LRC metadata tags (`ar`, `ti`, `al`, `length`, `offset`, etc.); preserves empty silence beats

**LRCLIB adapter** (`@opendj/lyrics/providers`):

- `LrclibAdapter implements LyricsProvider` — fetch-based (works in Node + Workers + browsers); never throws; returns `null`/`[]` on network errors / non-OK responses / parse failures so playback never blocks on lyrics
- `getBestMatch` calls `/api/get` (high confidence), `search` calls `/api/search` (medium); duration sent in seconds; `albumName` optional; sends descriptive `User-Agent`; configurable `baseUrl` (trailing-slash-tolerant); preserves attribution on every document

**Sync integration:**

- `lyricsDocumentToSyncCues(doc)` converts synced lines to `SyncCue<LyricsLine>` with `kind: 'lyric'`; drops lines without `startsAtMs`; preserves `endsAtMs` when present
- `getActiveLyricWindow(position, doc, prevCount=1, nextCount=2)` returns chronological lines around the active position; clamps cleanly at start/end; before-first-line returns upcoming context

**49 unit tests** covering normalization edge cases, LRC parsing variants, LRCLIB adapter happy/error paths with mocked fetch, sync-cue conversion, and active-window clamping.
