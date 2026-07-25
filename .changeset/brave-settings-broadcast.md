---
'@opendj/realtime': minor
'@opendj/backend': minor
---

Live session-settings propagation: new `session.settings_updated` realtime event (with `SessionSettingsSummary` payload) broadcast by `PATCH /api/v1/sessions/:id` when the room is live, so guest/TV/host views pick up karaoke mode, caps, and moderation changes without a reload. The snapshot reducer passes it through unchanged — pages own their session state.
