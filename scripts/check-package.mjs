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

const requiredKeywords = [
  'signalk-node-server-plugin',
  'signalk-plugin-configurator',
  'signalk-category-cloud',
  'signalk-category-notifications',
  'signalk-category-utility',
];
for (const keyword of requiredKeywords) {
  if (!packageJson.keywords?.includes(keyword)) {
    throw new Error(`Package metadata must include the ${keyword} keyword.`);
  }
}

if (packageJson.signalk?.displayName !== 'OpenRouter Companion') {
  throw new Error('signalk.displayName must remain OpenRouter Companion.');
}
for (const recommendation of [
  'signalk-binnacle',
  'signalk-nmea2000-emitter-cannon',
  'signalk-questdb',
  'signalk-to-influxdb',
  'signalk-to-influxdb2',
  'signalk-virtual-weather-sensors',
]) {
  if (!packageJson.signalk?.recommends?.includes(recommendation)) {
    throw new Error(`signalk.recommends must include ${recommendation}.`);
  }
}
if (packageJson.author?.name !== 'Nearl Crews') {
  throw new Error('Package author metadata must identify Nearl Crews.');
}
if (
  packageJson.repository?.type !== 'git' ||
  packageJson.repository?.url !==
    'git+https://github.com/NearlCrews/signalk-openrouter-companion.git'
) {
  throw new Error('Package repository metadata must identify the canonical GitHub repository.');
}
if (packageJson.license !== 'Apache-2.0') {
  throw new Error('Package license must remain Apache-2.0.');
}
if (packageJson.engines?.node !== '>=22.18') {
  throw new Error('The bundled plugin runtime must retain its Node >=22.18 compatibility floor.');
}
if (
  packageJson.publishConfig?.access !== 'public' ||
  packageJson.publishConfig?.provenance !== true ||
  packageJson.publishConfig?.registry !== 'https://registry.npmjs.org/'
) {
  throw new Error('publishConfig must require public npm publication with provenance.');
}

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

const readPngDimensions = async (path) => {
  const source = await readFile(path);
  if (source.length < 24 || source.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    throw new Error(`${path} must be a valid PNG file.`);
  }
  return { width: source.readUInt32BE(16), height: source.readUInt32BE(20) };
};

const appIconPath = normalizeDeclaredPath(packageJson.signalk.appIcon);
const appIconDimensions = await readPngDimensions(appIconPath);
if (appIconDimensions.width !== 192 || appIconDimensions.height !== 192) {
  throw new Error(`${appIconPath} must be a 192 by 192 pixel PNG.`);
}
for (const declaredPath of packageJson.signalk.screenshots) {
  const screenshotPath = normalizeDeclaredPath(declaredPath);
  const dimensions = await readPngDimensions(screenshotPath);
  if (dimensions.width !== 1280 || dimensions.height !== 800) {
    throw new Error(`${screenshotPath} must be a 1280 by 800 pixel PNG.`);
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
// `prepare` alone corrupts the Signal K plugin-ci pack capture: npm prints its
// lifecycle banner into `npm pack --ignore-scripts` stdout, which the workflow
// reads as the tarball path. Measured on npm 10.9 and 11.18, a `prepack` script
// prints only the tarball name, so it is permitted family-wide. The install
// hooks stay forbidden because they run on a consumer's machine.
for (const lifecycleScript of ['prepare', 'preinstall', 'install', 'postinstall']) {
  if (packageJson.scripts?.[lifecycleScript]) {
    throw new Error(`Signal K plugins must not define an ${lifecycleScript} lifecycle script.`);
  }
}
if (packageJson.gitHead !== undefined && !/^[0-9a-f]{40}$/.test(packageJson.gitHead)) {
  throw new Error('gitHead must be a full lowercase Git commit SHA when it is present.');
}
// Two invariants with different lifetimes, so they get two checks. The shape is
// permanent: any range prefix would admit a minor bump, and this library ships
// breaking changes in minor releases. The version is the deliberate-bump
// tripwire, so a bump has to be reviewed here rather than arriving with an
// install. Asserting only the version leaves the shape enforced by coincidence,
// and pasting a failing `^0.9.0` into the literal would satisfy it.
const UI_PIN = '0.8.2';
const uiSpec = packageJson.devDependencies?.['signalk-nearlcrews-ui'];
if (typeof uiSpec !== 'string' || !/^0\.\d+\.\d+$/.test(uiSpec)) {
  throw new Error(
    `The UI package must be pinned to an exact 0.x version during its 0.x series. Received ${String(uiSpec)}.`,
  );
}
if (uiSpec !== UI_PIN) {
  throw new Error(`The UI package must be pinned to exact version ${UI_PIN}. Received ${uiSpec}.`);
}

// D2: @types/node must track the advertised runtime floor. Typing against a
// newer Node than `engines.node` admits lets a later-Node API type-check here
// and then fail on the oldest lane the plugin advertises.
const enginesMajor = /(\d+)/.exec(packageJson.engines?.node ?? '')?.[1];
const typesNodeMajor = /(\d+)/.exec(packageJson.devDependencies?.['@types/node'] ?? '')?.[1];
if (!enginesMajor || !typesNodeMajor) {
  throw new Error('Both engines.node and @types/node must declare a major version.');
}
if (enginesMajor !== typesNodeMajor) {
  throw new Error(
    `@types/node ${typesNodeMajor}.x does not match the engines.node ${enginesMajor}.x runtime floor.`,
  );
}

console.log(`Packed package passed: ${files.size} files in ${packResult.filename}.`);
