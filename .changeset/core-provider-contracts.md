---
'@opendj/core': minor
---

Add provider contracts foundation:

- `IStreamingProvider` base interface (lifecycle + capability discovery)
- `PROVIDER_FEATURES` constant — stable feature ID vocabulary shared across backend, frontend, docs, tests
- `ProviderFeatureDescriptor` + `ProviderCapabilities` with granular `access` and `reliability` markers
- `defineCapabilities(...)` builder that catches descriptor/key mismatches at construction
- Modular `ISupports*` feature interfaces: search, zones, now-playing, queue, playlist switch, skip, pause, resume, volume read/set/step, playlists, playlist tracks read/add
- Runtime type guards (`supportsSearch`, `supportsQueueTrack`, `supportsVolumeStep`, ...) that check both the capability descriptor AND that the matching method exists on the instance
- Shared types: `Track`, `Zone`, `NowPlayingTrack`, `ProviderCredentials`, `QueueResult`, `PlaylistSummary`
- Error classes: `OpenDjError`, `NotImplementedError`, `NotSupportedByProviderError`, `InvalidProviderCredentialsError`
- 58 unit tests covering capability declaration, feature gating, and the full type-guard matrix
