import { readFile } from 'node:fs/promises';

// `snui-check-consumer`, which `check:panel` runs first, owns the exact pin,
// the shared UI version stamp, the React runtime markers, the published share
// map, and the size baseline. What stays here is specific to this package.

// The container must be a real ES module: this package's `"type": "module"`
// makes Signal K Admin load the remote with `import()` and read `get` and
// `init` off the module namespace.
const remoteEntry = await readFile('public/remoteEntry.js', 'utf8');
if (!remoteEntry.includes('export')) {
  throw new Error('The ESM Module Federation remote does not export its container.');
}

// The runtime-marker check reads the emitted text; this one reads the module
// graph, so a React copy that reached the bundle under a name the markers do
// not cover still fails. Only the JSX runtime may come from the react package.
const stats = JSON.parse(await readFile('.tmp/panel-stats.json', 'utf8'));

function collectModuleNames(modules = []) {
  return modules.flatMap((module) => [
    module.name,
    ...collectModuleNames(module.modules ?? []),
    ...collectModuleNames(module.children ?? []),
  ]);
}

const moduleNames = collectModuleNames(stats.modules).filter((name) => typeof name === 'string');
const unexpectedReactModules = moduleNames.filter(
  (name) =>
    /node_modules[\\/]react(?:-dom)?[\\/]/.test(name) &&
    !/[\\/]react[\\/]jsx-runtime\.js$/.test(name) &&
    !/[\\/]react[\\/]cjs[\\/]react-jsx-runtime\.production\.js$/.test(name),
);
if (unexpectedReactModules.length > 0) {
  throw new Error(
    `The panel bundled unexpected React modules: ${unexpectedReactModules.join(', ')}.`,
  );
}

console.log('Panel bundle passed: ESM container, React limited to the JSX runtime.');
