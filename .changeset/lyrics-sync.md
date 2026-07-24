---
'@opendj/backend': minor
'@opendj/frontend': minor
'@opendj/realtime': patch
'@opendj/frontend-template': minor
---

Lyrics sync end-to-end: the now-playing poller broadcasts `playback.clock_sampled` each tick and `lyrics.loaded` on track change (cache-fronted LRCLIB lookup, null on miss, stale-result guard); new framework-free `LyricsEngine` in @opendj/frontend computes karaoke display state client-side via `predictPlaybackPosition`; TV view gains a karaoke panel and the guest page a collapsible live-lyrics card; `LyricsApi` fixed to the real lookup contract.
