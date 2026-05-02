---
'@opendj/db': patch
---

Bump `drizzle-kit` to ^0.30 and switch `drizzle.config.ts` to an explicit per-table schema array.

`drizzle-kit generate` still fails with `Cannot find module './users.js'` — drizzle-kit's bundled CJS loader can't resolve our ESM `.js` extensions in schema imports (verbatimModuleSyntax requires them; CJS resolution can't strip them to `.ts` source). This is a known incompatibility between drizzle-kit and ESM-with-explicit-extensions and isn't fixed by the version bump or the glob change.

The first migration generation needs one of these workarounds (TBD in a follow-up commit):

- Run drizzle-kit through a custom `tsx` wrapper that handles `.js` → `.ts` resolution
- Generate from compiled `dist/` JS instead of TS source
- Drop `verbatimModuleSyntax` for the db package and remove `.js` extensions

Schema itself + the Drizzle runtime client (`createDb`) work correctly — only the kit's migration generator is affected. The boot wiring in `apps/oss-demo` is fully composable today.
