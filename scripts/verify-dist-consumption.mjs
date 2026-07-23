// scripts/verify-dist-consumption.mjs
// Installs the packed tarballs into a scratch npm project (npm overrides pin
// inter-package deps to the local tarballs since nothing is on the registry
// yet) and imports them from compiled dist output.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve repo root from this script's location
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const PACKAGES = [
  ['@opendj/core', 'packages/core'],
  ['@opendj/db', 'packages/db'],
  ['@opendj/auth', 'packages/auth'],
  ['@opendj/backend', 'packages/backend'],
  ['@opendj/realtime', 'packages/realtime'],
  ['@opendj/abuse', 'packages/abuse'],
  ['@opendj/sync', 'packages/sync'],
  ['@opendj/lyrics', 'packages/lyrics'],
  ['@opendj/app-shell', 'packages/app-shell'],
  ['@opendj/frontend', 'packages/frontend'],
];
// Imported at runtime in the scratch project. db/backend/auth are installed
// (their deps resolve) but not runtime-imported here: db opens no connection at
// import but depends on the postgres driver's platform bits, and auth's argon2
// is an optionalDependency — keep the smoke deterministic. app-shell is a
// placeholder with no exports.
const RUNTIME_IMPORTS = [
  '@opendj/core',
  '@opendj/sync',
  '@opendj/lyrics',
  '@opendj/realtime',
  '@opendj/frontend',
  '@opendj/abuse',
];

const shell = process.platform === 'win32';
const scratch = mkdtempSync(join(tmpdir(), 'opendj-consume-'));

try {
  const tarballs = {};
  for (const [name, dir] of PACKAGES) {
    const pkgDir = resolve(repoRoot, dir);
    try {
      const out = execFileSync('pnpm', ['pack', '--pack-destination', scratch], {
        encoding: 'utf8',
        cwd: pkgDir,
        shell,
      });
      tarballs[name] = out.trim().split('\n').at(-1).trim();
    } catch (err) {
      console.error(`Failed to pack ${name}: ${err.message}`);
      throw err;
    }
  }

  const dependencies = {},
    overrides = {};
  for (const name of Object.keys(tarballs)) {
    const fileRef = 'file:' + tarballs[name]; // absolute path; npm normalizes on all platforms
    dependencies[name] = fileRef;
    overrides[name] = fileRef;
  }
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify(
      { name: 'consume-smoke', private: true, type: 'module', dependencies, overrides },
      null,
      2,
    ),
  );

  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: scratch,
      stdio: 'inherit',
      shell,
    });
  } catch (err) {
    console.error(`Failed to npm install: ${err.message}`);
    throw err;
  }

  writeFileSync(
    join(scratch, 'smoke.mjs'),
    [
      ...RUNTIME_IMPORTS.map((n, i) => `import * as m${i} from '${n}';`),
      `const mods = [${RUNTIME_IMPORTS.map((_, i) => `m${i}`).join(', ')}];`,
      `for (const [i, m] of mods.entries()) {`,
      `  if (Object.keys(m).length === 0) { console.error('empty module: ' + ${JSON.stringify(RUNTIME_IMPORTS)}[i]); process.exit(1); }`,
      `}`,
      `import { PROVIDER_FEATURES } from '@opendj/core';`,
      `import { predictPlaybackPosition } from '@opendj/sync';`,
      `if (typeof PROVIDER_FEATURES !== 'object') process.exit(1);`,
      `if (typeof predictPlaybackPosition !== 'function') process.exit(1);`,
      `console.log('dist consumption OK: ' + mods.length + ' modules imported from dist');`,
    ].join('\n'),
  );

  try {
    execFileSync('node', ['smoke.mjs'], { cwd: scratch, stdio: 'inherit', shell });
  } catch (err) {
    console.error(`Failed to run smoke test: ${err.message}`);
    throw err;
  }

  console.log('verify-dist-consumption OK');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
