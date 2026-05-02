import { defineConfig } from 'drizzle-kit';

// drizzle-kit (CJS) can't resolve our ESM-style `.js` re-exports in
// schema/index.ts, so point it at the per-table files directly via a glob.
// Each table file is self-contained (relative imports within drizzle-orm only).
export default defineConfig({
  schema: [
    './src/schema/users.ts',
    './src/schema/accounts.ts',
    './src/schema/auth.ts',
    './src/schema/providers.ts',
    './src/schema/sessions.ts',
    './src/schema/lyrics.ts',
    './src/schema/abuse.ts',
  ],
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/opendj',
  },
  strict: true,
  verbose: true,
});
