# @opendj/lyrics

Lyrics + karaoke primitives for OpenDJ. Day-one feature, not a future extension. Depends on `@opendj/sync` for timing/cue conversion.

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"Lyrics and karaoke"):

- `LyricsProvider` interface + `LyricsLookupInput` / `LyricsDocument` / `LyricsLine` types
- LRC format parser (synchronized timestamps + plain-text fallback)
- LRCLIB adapter (HTTP via `fetch`; works in Node + Workers)
- Lyrics cache contracts (positive + negative lookups, attribution, suppression)
- Feedback hooks (`wrong_song`, `bad_timing`, `wrong_line`, `missing_lyrics`, `offensive_or_bad_content`)
- `lyricsDocumentToSyncCues` + `getActiveLyricWindow` helpers (used by TV/live view)

Lyrics enrich the experience but **never block queue operations**. Lookup runs in the background after now-playing changes.
