/**
 * @opendj/db — Drizzle schema + Postgres-js client factory for OpenDJ.
 *
 * Includes all OSS tables (everything except hosted-only `subscriptions` and
 * private analytics, which live in `opendj-live`).
 *
 * See docs/agent-brief.md §"Database schema".
 */

export * from './client.js';
export * as schema from './schema/index.js';
