// Runs the TypeScript 7 compiler by path.
//
// Two TypeScript packages are installed through npm aliases (see
// docs/DEVELOPMENT.md, "TypeScript toolchain"), and both declare a `tsc`
// binary. npm links `node_modules/.bin/tsc` to whichever package it installed
// last, so a bare `tsc` can silently resolve to TypeScript 6 after a fresh
// install. Resolving `@typescript/native` by name removes that dependence on
// install order for the build and the type check.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const manifestPath = require.resolve('@typescript/native/package.json');
const manifest = require(manifestPath);
const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsc;
if (typeof bin !== 'string') {
  throw new Error('@typescript/native package.json does not declare bin.tsc.');
}

const result = spawnSync(
  process.execPath,
  [join(dirname(manifestPath), bin), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
  },
);
process.exit(result.status ?? 1);
