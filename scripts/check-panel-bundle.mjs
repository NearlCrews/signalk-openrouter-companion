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

// The policy, named where a reader looks for it: any React or React DOM module
// in the graph is a failure except the JSX runtime, in either of the two
// spellings webpack records it under.
const REACT_MODULE = /node_modules[\\/]react(?:-dom)?[\\/]/;
const JSX_RUNTIME = /[\\/]react[\\/]jsx-runtime\.js$/;
const JSX_RUNTIME_CJS = /[\\/]react[\\/]cjs[\\/]react-jsx-runtime\.production\.js$/;

// One accumulator down the whole tree: module concatenation nests records under
// a parent, and building an array per node and per level would copy the graph
// once for every level of nesting to end up with the same flat list.
function collectModuleNames(modules = [], out = []) {
  for (const module of modules) {
    if (typeof module.name === 'string') out.push(module.name);
    collectModuleNames(module.modules ?? [], out);
    collectModuleNames(module.children ?? [], out);
  }
  return out;
}

const unexpectedReactModules = collectModuleNames(stats.modules).filter(
  (name) => REACT_MODULE.test(name) && !JSX_RUNTIME.test(name) && !JSX_RUNTIME_CJS.test(name),
);
if (unexpectedReactModules.length > 0) {
  throw new Error(
    `The panel bundled unexpected React modules: ${unexpectedReactModules.join(', ')}.`,
  );
}

console.log('Panel bundle passed: ESM container, React limited to the JSX runtime.');
