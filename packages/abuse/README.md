# @opendj/abuse

Abuse prevention primitives for OpenDJ. Hosts should be able to leave a session running with minimal moderation overhead.

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"Abuse prevention and backend analytics"):

- Action signal capture types (`action_events` row shape, privacy-minimized)
- `AbuseDecision` discriminated union (`allow` / `throttle` / `shadow_limit` / `require_host_review` / `block`)
- Rolling-window rate-limit contracts
- Risk scoring helpers
- Host-control surface (auto-pilot mode, cooldowns, duplicate-block, manual block/unblock)

Concrete enforcement happens inside the realtime room (`NodeSessionRoom` / `SessionRoom`); this package only provides the runtime-neutral types and pure functions.
