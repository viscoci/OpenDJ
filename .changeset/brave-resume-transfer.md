---
'@opendj/backend': patch
---

SpotifyProvider.resume recovers from NO_ACTIVE_DEVICE: after a pause (karaoke hold, host pause) Spotify often drops the playback device from its active set, so a bare `play` call 404s and playback stays stuck until someone taps play inside Spotify. Resume now falls back to `transferPlayback(deviceId, { play: true })` targeting the active device if any, else the first unrestricted one — fixing guest Ready, the auto-resume deadline, and the host Resume-now button in one place.
