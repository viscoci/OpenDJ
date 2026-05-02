# OpenDJ OSS demo

Reference self-host deployment of OpenDJ. Single Node 22 container + Postgres 16, wired via Docker Compose.

The Node entrypoint composes the full backend via `createApp({ deps: createDeps({ config, db }) })` from `@opendj/backend`. Every API surface mounted in `createApp` is exposed: auth, sessions, queue, guest identity, lyrics, abuse, provider OAuth, health.

## Quickstart

```bash
cp .env.example .env
# (Optional) Fill SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET to enable Spotify connect.
docker compose up
# → app on http://localhost:8888
# → postgres on :5432
```

Visit `http://localhost:8888/api/v1/health` to confirm the server is up. Open `app.opendj.live`-style routing comes from the frontend template (P0 still in flight) — the API is independently usable today via curl/Postman.

## Local development without Docker

```bash
pnpm --filter @opendj/db db:generate          # one-time: writes SQL migrations to packages/db/migrations
psql $DATABASE_URL -f packages/db/migrations/0000_*.sql
pnpm --filter opendj-oss-demo start
```

`start` uses Node's `--experimental-strip-types` so TypeScript runs directly without a build step.

## Verifying without a running app

```bash
docker compose config       # validates the compose file
pnpm --filter opendj-oss-demo typecheck
```

CI runs both on every PR.

## Spotify setup

The OAuth flow needs a Spotify Developer Dashboard application:

1. Create an app at https://developer.spotify.com/dashboard
2. Add `http://localhost:8888/api/v1/provider/connections/spotify/callback` to the app's Redirect URIs
3. Copy the Client ID + Secret into `.env`

Without these set, the server boots with a warning and the `/api/v1/provider/connections/spotify/start` route returns 503 `provider_oauth_not_configured`.

## Configuration reference

See `.env.example` for every supported variable. Defaults are tuned for local single-container use.

## What's NOT in this demo yet

- WebSocket realtime (P0 in flight) — guest UI today polls REST instead of subscribing
- Login OAuth (Google / Apple / Facebook) — only Spotify-music-provider OAuth is wired today
- Email/password fallback — needs concrete Argon2id hasher

## Scaling beyond one container

If you run multiple app containers behind a load balancer, uncomment the `valkey` service in `docker-compose.yml` and set `VALKEY_URL` in `.env`. Without Valkey, realtime fan-out only works within a single Node process.
