---
'@opendj/backend': patch
---

Fix NowPlayingPoller skip storms that ate innocent tracks. Two compounding bugs: (1) `start()` landing while a tick was executing forked concurrent tick chains (the in-flight tick has no timer set), multiplying poll rate and racing the auto-skip paths — observed live as 3 skips for one rejected URI within 155ms; (2) no settle guard — Spotify keeps reporting the just-skipped track for ~500ms, so any tick in that window re-matched the rejected URI and skipped again, advancing past songs that were never removed. Ticks now carry an in-flight flag, `scheduleNext` clears superseded timers, and all auto-skip paths are suppressed for 1.5s after a dispatched skip.
