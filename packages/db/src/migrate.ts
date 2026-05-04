/**
 * Migration runner — applies all generated migrations from `migrations/` to a
 * Postgres database. Wraps `drizzle-orm/postgres-js/migrator`.
 *
 * Used by oss-demo at boot, and by the `db:migrate` package script for local
 * development.
 *
 * Migrations are generated via `pnpm --filter @opendj/db db:generate`.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export interface RunMigrationsOptions {
  /** Connection string. Defaults to `process.env.DATABASE_URL`. */
  databaseUrl?: string;
  /** Filesystem path to the migrations folder. Defaults to the bundled `packages/db/migrations`. */
  migrationsFolder?: string;
}

/**
 * Apply all pending migrations. Opens its own short-lived connection so the
 * caller doesn't share a pool with the long-lived app client.
 */
export async function runMigrations(options: RunMigrationsOptions = {}): Promise<void> {
  const connectionString = options.databaseUrl ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('runMigrations: DATABASE_URL not set and no databaseUrl option provided');
  }

  // Default folder: packages/db/migrations relative to this file.
  // src/migrate.ts → ../migrations
  const here = fileURLToPath(import.meta.url);
  const defaultFolder = resolve(here, '..', '..', 'migrations');
  const migrationsFolder = options.migrationsFolder ?? defaultFolder;

  // `max: 1` keeps migration safe even if pgbouncer-style poolers are in front.
  const sql = postgres(connectionString, { max: 1 });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
