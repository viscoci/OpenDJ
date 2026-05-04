#!/usr/bin/env tsx
/**
 * CLI entrypoint: `pnpm --filter @opendj/db db:migrate`.
 *
 * Reads DATABASE_URL from the environment. Exits 1 on failure so CI/Docker
 * health checks fail fast.
 */

import { runMigrations } from '../migrate.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('[opendj/db] DATABASE_URL not set');
    process.exit(1);
  }
  console.log('[opendj/db] applying migrations…');
  await runMigrations({ databaseUrl: url });
  console.log('[opendj/db] migrations up to date');
}

main().catch((err) => {
  console.error('[opendj/db] migration failed:', err);
  process.exit(1);
});
