// scripts/verify-publish.mjs
// Packs each publishable package and asserts the published package.json
// points at dist/ and that every referenced file is inside the tarball.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGES = [
  { name: '@opendj/core', dir: 'packages/core' },
  { name: '@opendj/db', dir: 'packages/db', extra: assertDbMigrations },
  { name: '@opendj/auth', dir: 'packages/auth' },
  { name: '@opendj/backend', dir: 'packages/backend' },
  { name: '@opendj/realtime', dir: 'packages/realtime' },
  { name: '@opendj/abuse', dir: 'packages/abuse' },
  { name: '@opendj/sync', dir: 'packages/sync' },
  { name: '@opendj/lyrics', dir: 'packages/lyrics' },
  { name: '@opendj/app-shell', dir: 'packages/app-shell' },
  { name: '@opendj/frontend', dir: 'packages/frontend' },
];

const failures = [];
const work = mkdtempSync(join(tmpdir(), 'opendj-publish-'));

function stringLeaves(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object')
    Object.values(node).forEach((v) => stringLeaves(v, out));
  return out;
}

function assertDbMigrations(pkgRoot, fail) {
  const dir = join(pkgRoot, 'migrations');
  const sql = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')) : [];
  if (sql.length === 0) fail('tarball is missing migrations/*.sql');
}

for (const { name, dir, extra } of PACKAGES) {
  const fail = (msg) => failures.push(`${name}: ${msg}`);
  const dest = join(work, name.replace(/[@/]/g, '_'));
  const out = execFileSync('pnpm', ['pack', '--pack-destination', dest], {
    encoding: 'utf8',
    cwd: dir,
    shell: process.platform === 'win32',
  });
  const tarball = out.trim().split('\n').at(-1).trim();
  execFileSync('tar', ['-xzf', tarball, '-C', dest]);
  const pkgRoot = join(dest, 'package');
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

  for (const field of ['main', 'types']) {
    if (!pkg[field]?.startsWith('./dist/'))
      fail(`${field} is "${pkg[field]}" — must point into ./dist/`);
  }
  const leaves = stringLeaves(pkg.exports);
  if (leaves.length === 0) fail('exports has no entries');
  for (const leaf of leaves) {
    if (!leaf.startsWith('./dist/')) fail(`exports leaf "${leaf}" — must point into ./dist/`);
    else if (!existsSync(resolve(pkgRoot, leaf)))
      fail(`exports leaf "${leaf}" not present in tarball`);
  }
  for (const field of ['main', 'types']) {
    if (pkg[field]?.startsWith('./dist/') && !existsSync(resolve(pkgRoot, pkg[field])))
      fail(`${field} "${pkg[field]}" not present in tarball`);
  }
  extra?.(pkgRoot, fail);
}

rmSync(work, { recursive: true, force: true });
if (failures.length) {
  console.error('verify-publish FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`verify-publish OK — ${PACKAGES.length} packages point at dist/`);
