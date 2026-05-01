# @opendj/core

Pure TypeScript domain logic for OpenDJ. Zero runtime imports beyond standard library.

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md)):

- `providers/` — `IStreamingProvider`, modular `ISupports*` feature interfaces, capability descriptors, type guards
- `queue/` — `canEnqueue`, `enforcePerGuestCap`, `dedupeQueue`, `applyModerationDecision`, `canSkip`
- `plan/` — feature-gate functions for free vs paid (`canStartSession`, `effectiveGuestCap`, `canUseAnalytics`, etc.)
- `types/` — shared public types

Used by `@opendj/backend`, `@opendj/realtime`, `@opendj/frontend`, and any third-party extension.
