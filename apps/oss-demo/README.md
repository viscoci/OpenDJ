# OpenDJ OSS demo

Reference self-host deployment of OpenDJ. Single Node 22 container + Postgres 16, wired via Docker Compose.

> **Status:** scaffold only. The Node entrypoint is a placeholder — full boot logic lands when `@opendj/backend` ships.

## Quickstart (when backend lands)

```bash
cp .env.example .env
# Fill SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET (and adjust SPOTIFY_REDIRECT_URI if needed)

docker compose up
# → app on http://localhost:8888
# → postgres on :5432
```

Visit `http://localhost:8888`, log in with Spotify, and share `/queue` with guests.

## Today

```bash
docker compose config       # validates the compose file
```

That's the only thing wired right now. CI runs the same check on every PR.

## Spotify setup

Walk through [`docs/ONBOARDING.md`](../../docs/ONBOARDING.md) (placeholder for now). The short version:

1. Create an app at https://developer.spotify.com/dashboard
2. Add `http://localhost:8888/api/v1/provider/connections/spotify/callback` to the app's Redirect URIs
3. Copy the Client ID + Secret into `.env`

## Configuration reference

See `.env.example` for every supported variable. Defaults are tuned for local single-container use.

## Scaling beyond one container

If you run multiple app containers behind a load balancer, uncomment the `valkey` service in `docker-compose.yml` and set `VALKEY_URL` in `.env`. Without Valkey, realtime fan-out only works within a single Node process.
