---
'@opendj/core': minor
'@opendj/db': minor
'@opendj/backend': minor
'@opendj/realtime': minor
'@opendj/frontend': minor
---

Karaoke mic queue: hosts configure karaoke mode (off/optional/required), mic count, and pause behavior per session; guests claim mics on queued songs (open to any guest, atomic request+claim, `required` mode enforces a claim); the now-playing poller spotlights the earliest claimed matching item and drives auto/manual pause with a wall-clock auto-resume deadline; new `karaoke.*` realtime events plus `karaokeClaims` on queue item summaries and a `karaoke` snapshot slice; `KaraokeApi` client (claim/removeClaim/pause/ready).
