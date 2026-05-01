# Example: custom streaming provider

> **Status:** placeholder. Filled in once `@opendj/core`'s `IStreamingProvider` and modular `ISupports*` interfaces are stable.

This example will show how to:

1. Implement `IStreamingProvider` for a hypothetical music service
2. Pick which `ISupports*` feature interfaces apply (search, queue, skip, volume, playlists, etc.)
3. Declare granular capabilities via `getCapabilities()` — including `reliability` markers (`native`, `emulated`, `best_effort`, `unsupported`)
4. Register the provider via `providerRegistry` in `@opendj/backend`
5. Add a capability-gated route + UI control

Useful for adding internal/private music services, hardware integrations, or test providers.

See [`docs/PROVIDERS.md`](../../docs/PROVIDERS.md) and [`docs/agent-brief.md`](../../docs/agent-brief.md) §"Provider Architecture" for the full contract.
