# @opendj/frontend

Reusable Angular components and services for OpenDJ. Consumed by `@opendj/frontend-template` and any downstream Angular SPA built on the same `/api/v1` contract.

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"Cross-platform app shell"):

- Standalone, signal-based Angular components for guest, host, and TV flows
- API client services (typed against `/api/v1` OpenAPI)
- Realtime client (WebSocket + snapshot reconciliation)
- Lyrics/karaoke display widgets
- Vibe chips, search, queue list, now-playing, vote-to-skip, my-requests components

Depends on `@opendj/app-shell` for platform-neutral behavior (browser vs Capacitor WebView).

Components are compatible with both browser and WebView environments. Ionic UI is **not** the design system — the OpenDJ design system stays authoritative.
