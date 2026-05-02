---
'@opendj/frontend-template': minor
---

Replace the Angular CLI placeholder with a real OpenDJ guest experience.

**Routes**

- `/` — landing card with the brand gradient + GitHub link
- `/u/:slug` — the **guest request page**: resolves the session by `qrSlug`, fingerprints the device, acquires a slot token via `/sessions/:id/guest/identity`, lists the live queue, and posts new requests via `x-slot-token`. Subscribes to `/sessions/:id/realtime` so the queue refreshes when other guests request, hosts moderate, or playback advances.

**MVP scope**: the request form takes a Spotify URI + track name + artist by hand. A real search picker layers on once the backend exposes a `/sessions/:id/search` proxy route — punted to a follow-up commit so this slice ships behind a working API.

**Building blocks**

- `OpenDjClientService` (`services/opendj-client.service.ts`) — singleton wrapping `OpenDjClient`. Exposes `client` + a reactive `unauthorized` signal flipped on the first 401. `API_BASE_URL` `InjectionToken` lets tests / Storybook / Capacitor builds override the origin (default `''` → relative paths, which is what the dev server proxy expects).
- `getOrCreateGuestFingerprint` (`services/guest-fingerprint.ts`) — `localStorage`-backed 128-bit hex string. SSR-safe (placeholder when `localStorage` is unreachable). Backend salts + hashes server-side; we never send anything PII.
- Two route components: `LandingPage`, `GuestRequestPage`. Standalone, OnPush, signals only — no Zone.js (`provideZonelessChangeDetection` already wired).

**Build verified**: `ng build` produces a 256 kB raw / 68 kB gzip initial bundle. Workspace `@opendj/frontend` resolves through esbuild's pnpm symlink walk — no extra `paths` aliasing needed.

**Out of scope here**

- Search picker (waits on backend `/search` route)
- Host dashboard (next slice)
- Capacitor build target wiring (template is Capacitor-ready but `npx cap add ios|android` lives in private `opendj-live`)
- Login UI for the host flow
