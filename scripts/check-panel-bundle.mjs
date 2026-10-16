import { createRequire } from 'node:module';
import { strictShares } from './guards.mjs';

// `snui-check-consumer`, which `check:panel` runs first, owns the exact pin,
// the shared UI version stamp, the host loading contract, the React module
// graph, the doubled CSS overrides, the published share map, the rendered
// panel, and the size baseline. What stays here is specific to this package.

// The consumer check proves the configured shares equal the published map,
// not that the map is safe. Signal K 2.24 Admin registers React as 19.0.0, so
// a strict share refuses a compatible host and the panel never mounts.
const webpackConfig = createRequire(import.meta.url)('../webpack.config.cjs');
const federation = webpackConfig.plugins.find(
  (plugin) => plugin?.constructor?.name === 'ModuleFederationPlugin',
);
if (federation === undefined) {
  throw new Error('webpack.config.cjs must configure the ModuleFederationPlugin.');
}
const strict = strictShares(federation.options.shared);
if (strict.length > 0) {
  throw new Error(`Module Federation shares must not be strict: ${strict.join(', ')}.`);
}

console.log('Panel bundle passed: Module Federation shares are non-strict.');
