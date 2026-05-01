# Streaming providers

> **Status:** placeholder. Filled in alongside the `@opendj/core` provider contract work.

This doc will cover:

- The `IStreamingProvider` base contract (lifecycle, identity, capability discovery)
- Modular feature interfaces (`ISupportsSearch`, `ISupportsQueueTrack`, `ISupportsSkipTrack`, `ISupportsVolume*`, `ISupportsPlaylist*`, etc.)
- Granular capability descriptors (`supported`, `access`, `reliability`, `notes`)
- Type guards for capability-gated calls
- The provider matrix (Spotify, Soundtrack Your Brand, Apple Music — what each supports today)
- Step-by-step: how to add a new provider

Until then, see [`docs/agent-brief.md`](./agent-brief.md) §"Provider Architecture".

## Reference docs

- Spotify Web API — https://developer.spotify.com/documentation/web-api
- Soundtrack Your Brand GraphQL — https://api.soundtrackyourbrand.com/v2/docs
- Apple MusicKit JS — https://developer.apple.com/documentation/musickitjs
