---
'@opendj/backend': minor
---

Land the full `SpotifyProvider` implementation. fetch-based, Workers-safe (no Node-only `spotify-web-api-node` dep).

**Capabilities** (declared via `defineCapabilities`):

- Search · QueueTrack · NowPlayingRead · PlaybackProgressRead · SkipTrack · Pause · Resume · VolumeRead · VolumeSetAbsolute → all `native`
- ZonesRead → unsupported with note explaining Spotify uses devices, not OpenDJ zones; provider exposes a synthetic `default` zone

**Implemented `ISupports*` methods:**

- `search(query, limit?)` — `/v1/search?type=track`; maps Spotify's nested artist/album/image shape into OpenDJ's flat `Track` (artist names joined with `, `; album art picked closest to 300px wide)
- `queueTrack(track)` — `POST /v1/me/player/queue?uri=` (URI properly encoded for tokens with `:` / spaces)
- `getNowPlaying()` — `GET /v1/me/player/currently-playing`; returns null on 204 / null item; falls back to synthetic `'default'` zoneId when device is null
- `skipTrack` / `pause` / `resume` — POST/PUT to the standard endpoints
- `getVolume()` — reads `device.volume_percent` from `/v1/me/player`; returns 0 on 204 (no active device) or null volume
- `setVolume(percent)` — clamps to `[0, 100]` and rounds before sending

**Error handling:**

- `SpotifyClient.request` translates 401 → `InvalidProviderCredentialsError`, 404 with `error.reason='NO_ACTIVE_DEVICE'` → new `NoActiveDeviceError` class (per brief: routes map this to a 400 `{ error: 'no_active_device' }`), other 4xx/5xx → `SpotifyApiError` carrying status + raw body
- All errors extend `OpenDjError` so the route layer can map uniformly

**File layout:**

- `src/providers/streaming/spotify/SpotifyProvider.ts` — the provider class
- `src/providers/streaming/spotify/client.ts` — thin SpotifyClient (where future refresh-on-401 retry will land)
- `src/providers/streaming/spotify/errors.ts` — `NoActiveDeviceError`, `SpotifyApiError`

**21 new tests** (120 total in backend) covering capability declaration, connect/disconnect/duck-type guards, search request shape + result mapping (multi-artist join, album-art selection), queueTrack URI encoding + the three error-translation paths (401 / 404 NO_ACTIVE_DEVICE / 5xx), getNowPlaying happy + null-item + null-device paths, playback-control endpoints, and volume read/set including clamp+round.
