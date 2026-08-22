import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The configuration panel is a Module Federation remote whose dependency tree
 * is bundled into public/*.mjs, and the backend bundle inlines every runtime
 * dependency into dist/index.js, so the published package redistributes both.
 * MIT requires the copyright and permission notice to travel with a copy, and
 * Apache-2.0 section 4(a) requires giving recipients the license. Terser only
 * extracts comments carrying an @license or @preserve marker, and nearly every
 * package here ships none (the emitted sidecar covers the React JSX runtime
 * alone), so the sidecar discharges neither obligation.
 *
 * Run `npm run licenses` to regenerate after any change to either bundle's
 * dependency tree. `--check` re-verifies the committed file against the
 * installed tree without paying for a rebuild, and runs inside `package:check`.
 */

const repositoryDir = new URL('../', import.meta.url);
const noticesUrl = new URL('THIRD_PARTY_NOTICES.md', repositoryDir);
const statsUrl = new URL('.tmp/panel-stats.json', repositoryDir);
const checkOnly = process.argv.includes('--check');

const HEADER_MARKER = '<!-- generated-for-signalk-nearlcrews-ui:';

const packageJson = JSON.parse(readFileSync(new URL('package.json', repositoryDir), 'utf8'));
const sharedUiVersion = packageJson.devDependencies?.['signalk-nearlcrews-ui'];
if (!sharedUiVersion) throw new Error('signalk-nearlcrews-ui is not a development dependency.');

/**
 * Packages webpack actually pulled into the panel chunks, read from the stats
 * the panel build already writes. The walk must recurse: module concatenation
 * nests the interesting records under a parent module, and a shallow read
 * reports neither react-aria nor anything else reached through the shared UI.
 * Chunk membership is NOT a filter here, because a concatenated module reports
 * an empty chunk list while its code is emitted all the same.
 */
function bundledPanelPackages() {
  if (!existsSync(statsUrl)) {
    throw new Error('.tmp/panel-stats.json is missing; run npm run build first.');
  }
  const stats = JSON.parse(readFileSync(statsUrl, 'utf8'));
  const names = [];
  const walk = (modules) => {
    for (const module of modules ?? []) {
      if (typeof module.name === 'string') names.push(module.name);
      walk(module.modules);
      walk(module.children);
    }
  };
  walk(stats.modules);
  const packages = new Set();
  for (const name of names) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(name);
    if (match?.[1]) packages.add(match[1]);
  }
  // Webpack's own loader and share-scope runtime is inlined into the emitted
  // chunks rather than imported, so it appears in the output without appearing
  // in the module list. Confirmed present: remoteEntry.js carries it.
  packages.add('webpack');
  return packages;
}

/** esbuild inlines every non-external runtime dependency into dist/index.js. */
function bundledBackendPackages() {
  return new Set(Object.keys(packageJson.dependencies ?? {}));
}

function licenseTextFor(name) {
  for (const candidate of ['LICENSE', 'license', 'LICENSE.md', 'LICENSE.txt']) {
    const url = new URL(`node_modules/${name}/${candidate}`, repositoryDir);
    if (existsSync(url)) return readFileSync(url, 'utf8').trim();
  }
  return null;
}

function licenseIdFor(name) {
  const manifest = JSON.parse(
    readFileSync(new URL(`node_modules/${name}/package.json`, repositoryDir), 'utf8'),
  );
  return typeof manifest.license === 'string' ? manifest.license : 'see below';
}

function render(names) {
  const sections = names.map((name) => {
    const id = licenseIdFor(name);
    const text = licenseTextFor(name);
    const body =
      text === null
        ? `This package ships no license file. Its manifest declares ${id}.`
        : `\`\`\`text\n${text}\n\`\`\``;
    return `## ${name}\n\nLicense: ${id}\n\n${body}`;
  });
  // Each entry below is one rendered paragraph. A wrapped paragraph stays a
  // single string: splitting it across entries would render every line as its
  // own paragraph.
  return [
    '# Third-party notices',
    `${HEADER_MARKER}${sharedUiVersion} -->`,
    [
      'This file is generated. Run `npm run licenses` to regenerate it after any',
      "change to either bundle's dependency tree, and `npm run package:check` to",
      'verify the committed copy still matches the installed tree.',
    ].join('\n'),
    [
      'The configuration panel is a Module Federation remote, so the packages below',
      'are bundled into `public/*.mjs` and redistributed with this plugin, and the',
      'backend bundle `dist/index.js` inlines its runtime dependencies the same way.',
      'Their licenses follow.',
    ].join('\n'),
    [
      'React and React DOM are supplied by the Signal K admin host as singletons and',
      'are not bundled here; the React entry that does appear is the JSX runtime.',
      'React Aria arrives through the shared UI package: `PanelRoot` installs React',
      "Aria's portal provider, so every panel carries it whether or not it imports a",
      'focused entry point.',
    ].join('\n'),
    ...sections,
  ].join('\n\n');
}

if (checkOnly) {
  if (!existsSync(noticesUrl)) {
    throw new Error('THIRD_PARTY_NOTICES.md is missing; run npm run licenses.');
  }
  const current = readFileSync(noticesUrl, 'utf8');
  if (!current.includes(`${HEADER_MARKER}${sharedUiVersion} -->`)) {
    throw new Error(
      `THIRD_PARTY_NOTICES.md was generated for a different signalk-nearlcrews-ui than ${sharedUiVersion}; run npm run licenses.`,
    );
  }
  // Every package the file names must still resolve with the license it claims,
  // which catches a removal or a relicense without paying for a rebuild.
  const listed = [...current.matchAll(/^## (\S+)$/gm)].map((match) => match[1]);
  if (listed.length === 0) throw new Error('THIRD_PARTY_NOTICES.md lists no packages.');
  for (const name of listed) {
    if (!existsSync(new URL(`node_modules/${name}/package.json`, repositoryDir))) {
      throw new Error(`THIRD_PARTY_NOTICES.md names ${name}, which is no longer installed.`);
    }
    const declared = licenseIdFor(name);
    if (!current.includes(`## ${name}\n\nLicense: ${declared}\n`)) {
      throw new Error(`${name} now declares ${declared}; run npm run licenses.`);
    }
  }
  // Every runtime dependency reaches dist/index.js, so a new one must appear
  // here even when the panel tree is unchanged.
  for (const name of bundledBackendPackages()) {
    if (!listed.includes(name)) {
      throw new Error(`${name} is bundled into dist/index.js but is not in the notices.`);
    }
  }
  process.stdout.write(`Third-party notices cover ${listed.length} bundled packages.\n`);
} else {
  const names = [...new Set([...bundledPanelPackages(), ...bundledBackendPackages()])].sort();
  if (names.length === 0) throw new Error('No bundled packages were found.');
  writeFileSync(noticesUrl, `${render(names)}\n`);
  process.stdout.write(`Wrote THIRD_PARTY_NOTICES.md for ${names.length} bundled packages.\n`);
}
