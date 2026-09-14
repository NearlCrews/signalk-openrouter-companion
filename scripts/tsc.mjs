// Runs a TypeScript compiler by path.
//
// Two TypeScript packages are installed through npm aliases (see
// docs/DEVELOPMENT.md, "TypeScript toolchain"): `@typescript/native` is
// TypeScript 7 and does the build and the type check, and the bare `typescript`
// specifier is aliased to `@typescript/typescript6`, which gives
// typescript-eslint, Knip, and dependency-cruiser the 6.x compiler API they
// still need. Both declare a compiler binary, and npm links
// `node_modules/.bin/tsc` to whichever package it installed last, so a bare
// `tsc` can silently resolve to the wrong compiler after a fresh install.
// Resolving the package by name removes that dependence on install order.
//
// Flags:
//   --ts6   run TypeScript 6 instead of TypeScript 7.
//   --all   run every type-check project below, in order, with --noEmit,
//           instead of passing the remaining arguments straight through.
// Anything else is forwarded to the compiler unchanged, which is how
// `build:types` emits declarations.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Every project the repository type-checks, named once so a fifth one is a
// single edit rather than two script chains kept in step by eye.
const TYPE_CHECK_PROJECTS = [
  'tsconfig.json',
  'tsconfig.tests.json',
  'tsconfig.panel.json',
  'tsconfig.tools.json',
];

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const useTs6 = argv.includes('--ts6');
const allProjects = argv.includes('--all');
const passthrough = argv.filter((arg) => arg !== '--ts6' && arg !== '--all');

// Resolved from literal specifiers so the dependency on each compiler package
// stays visible to the dead-code check.
const manifestPath = useTs6
  ? require.resolve('typescript/package.json')
  : require.resolve('@typescript/native/package.json');
const binName = useTs6 ? 'tsc6' : 'tsc';
const manifest = require(manifestPath);
const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
if (typeof bin !== 'string') {
  throw new Error(`${manifestPath} does not declare bin.${binName}.`);
}
const compiler = join(dirname(manifestPath), bin);

function run(args) {
  const result = spawnSync(process.execPath, [compiler, ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

if (allProjects) {
  for (const project of TYPE_CHECK_PROJECTS) {
    const status = run(['-p', project, '--noEmit', ...passthrough]);
    if (status !== 0) process.exit(status);
  }
  process.exit(0);
}

process.exit(run(passthrough));
