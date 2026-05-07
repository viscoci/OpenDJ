/**
 * @opendj/db — Drizzle schema + Postgres-js client factory for OpenDJ.
 *
 * Includes the foundation tables. Commercial extensions like `subscriptions`
 * or product/funnel analytics belong in downstream consumer migrations, not
 * here.
 *
 * See docs/agent-brief.md §"Database schema".
 */

export * from './client.js';
export * as schema from './schema/index.js';
// Migration runner uses node:* APIs and is intentionally NOT re-exported here.
// Import from `@opendj/db/migrate` in Node entrypoints (e.g. apps/oss-demo).
