import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const { stdout } = await execFileAsync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { maxBuffer: 10 * 1024 * 1024 },
);
const [packResult] = JSON.parse(stdout);
const files = new Set(packResult.files.map((file) => file.path));

for (const requiredPath of [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'dist/index.js',
  'docs/DEVELOPMENT.md',
  'package.json',
  'public/remoteEntry.js',
]) {
  if (!files.has(requiredPath)) {
    throw new Error(`Packed package is missing ${requiredPath}.`);
  }
}

const normalizeDeclaredPath = (declaredPath) => declaredPath.replace(/^\.\//, '');
const declaredAssets = [
  ['signalk.appIcon', packageJson.signalk?.appIcon],
  ...(packageJson.signalk?.screenshots ?? []).map((declaredPath, index) => [
    `signalk.screenshots[${index}]`,
    declaredPath,
  ]),
];
for (const [field, declaredPath] of declaredAssets) {
  if (typeof declaredPath !== 'string' || !declaredPath.trim()) {
    throw new Error(`${field} must declare a non-empty package-relative asset path.`);
  }
  const packedPath = normalizeDeclaredPath(declaredPath.trim());
  if (packedPath.startsWith('../') || !files.has(packedPath)) {
    throw new Error(`${field} does not resolve to packed file ${packedPath}.`);
  }
}

for (const file of files) {
  if (
    file.startsWith('src/') ||
    file.startsWith('tests/') ||
    file.startsWith('docs/superpowers/') ||
    file.startsWith('.tmp/') ||
    file.endsWith('.map')
  ) {
    throw new Error(`Packed package contains development-only file ${file}.`);
  }
}

if (packageJson.main !== 'dist/index.js') {
  throw new Error(`Expected package main to be dist/index.js, received ${packageJson.main}.`);
}
if (packageJson.exports?.['.'] !== './dist/index.js') {
  throw new Error('Expected the package root export to resolve to ./dist/index.js.');
}
if (packageJson.dependencies?.['signalk-nearlcrews-ui']) {
  throw new Error('signalk-nearlcrews-ui must be a bundled development dependency.');
}
if (packageJson.devDependencies?.['signalk-nearlcrews-ui'] !== '0.3.0') {
  throw new Error('The UI package must be pinned to exact version 0.3.0 during its 0.x series.');
}

console.log(`Packed package passed: ${files.size} files in ${packResult.filename}.`);
