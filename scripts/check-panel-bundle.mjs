import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const outputDirectory = 'public';
const names = await readdir(outputDirectory);
const javascriptNames = names.filter((name) => name.endsWith('.js') || name.endsWith('.mjs'));
const files = await Promise.all(
  javascriptNames.map(async (name) => ({
    name,
    source: await readFile(join(outputDirectory, name), 'utf8'),
  })),
);
const stats = JSON.parse(await readFile('.tmp/panel-stats.json', 'utf8'));

if (stats.errorsCount !== 0 || stats.warningsCount !== 0) {
  throw new Error(
    `Panel build reported ${stats.errorsCount} errors and ${stats.warningsCount} warnings.`,
  );
}

const remoteEntry = files.find((file) => file.name === 'remoteEntry.js');
if (!remoteEntry?.source.includes('export')) {
  throw new Error('The ESM Module Federation remote does not export its container.');
}

const combined = files.map((file) => file.source).join('\n');
if (!combined.includes('data-snui-version')) {
  throw new Error('The configuration panel did not bundle signalk-nearlcrews-ui.');
}

for (const marker of [
  '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
  'react.production.min',
  'react-dom.production.min',
]) {
  if (combined.includes(marker)) {
    throw new Error(`The configuration panel bundled a React implementation marker: ${marker}.`);
  }
}

function collectModuleNames(modules = []) {
  return modules.flatMap((module) => [
    module.name,
    ...collectModuleNames(module.modules ?? []),
    ...collectModuleNames(module.children ?? []),
  ]);
}

const moduleNames = collectModuleNames(stats.modules).filter((name) => typeof name === 'string');
if (!moduleNames.some((name) => name.includes('signalk-nearlcrews-ui'))) {
  throw new Error('Webpack statistics do not show the shared UI package in the panel bundle.');
}
if (!moduleNames.some((name) => name.startsWith('consume shared module (default) react@'))) {
  throw new Error('The panel is not consuming React from the Module Federation host share scope.');
}

const bundledReactModules = moduleNames.filter((name) =>
  /node_modules[\\/]react(?:-dom)?[\\/]/.test(name),
);
const unexpectedReactModules = bundledReactModules.filter(
  (name) =>
    !/[\\/]react[\\/]jsx-runtime\.js$/.test(name) &&
    !/[\\/]react[\\/]cjs[\\/]react-jsx-runtime\.production\.js$/.test(name),
);
if (unexpectedReactModules.length > 0) {
  throw new Error(
    `The panel bundled unexpected React modules: ${unexpectedReactModules.join(', ')}.`,
  );
}

console.log(`Panel bundle passed: ${javascriptNames.length} JavaScript files, host-shared React.`);
