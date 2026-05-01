# Example: minimal Node integration

> **Status:** placeholder. Filled in once `@opendj/backend` and `@opendj/db` ship a stable surface.

This example will show the smallest possible Node.js program that:

1. Loads `@opendj/backend`'s `createApp` and `createDeps`
2. Wires Postgres via `@opendj/db`
3. Boots a Hono server on port 8888
4. Serves `/api/v1/health`

Useful as a starting point for self-hosting OpenDJ inside an existing Node service or for embedding the queue API in a custom platform.

For the production-shape reference, see [`apps/oss-demo`](../../apps/oss-demo/).
