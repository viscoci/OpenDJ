/**
 * Postgres client factory. Uses postgres.js (Workers + Node compatible) — do
 * NOT use node-postgres in code that must run in Cloudflare Workers.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface CreateDbOptions {
  /** Override the underlying postgres.js client options. */
  postgres?: postgres.Options<Record<string, postgres.PostgresType>>;
}

/**
 * Create a Drizzle database client backed by postgres.js.
 *
 * Hosted (Workers + Hyperdrive): pass the Hyperdrive connection string.
 * OSS (Node): pass DATABASE_URL.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): Database {
  const sql: Sql = postgres(connectionString, options.postgres);
  return drizzle(sql, { schema });
}

export { schema };
