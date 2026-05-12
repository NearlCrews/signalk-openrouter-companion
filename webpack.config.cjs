// Builds the Signal K admin UI panel exposed via Module Federation.
// Output goes to public/, which the SK server mounts at
// /<package>/ when the package has the `signalk-plugin-configurator` keyword.
// React 19 is shared as a singleton so we reuse the admin UI's React runtime.
const path = require('node:path');
const { ModuleFederationPlugin } = require('webpack').container;
const pkg = require('./package.json');

const containerName = pkg.name.replace(/[-@/]/g, '_');

module.exports = {
  entry: './src/configpanel/index.js',
  mode: 'production',
  // Output an ES module so the SK admin's `<script type="module">` tag
  // (auto-applied because this package's `package.json` has
  // `"type": "module"`) can `import()` our container and read its
  // `.get` / `.init` exports. The legacy `library: { type: 'var' }`
  // path requires a classic script tag so the federation container var
  // lands on `window`, which never happens for ESM packages.
  experiments: { outputModule: true },
  output: {
    path: path.resolve(__dirname, 'public'),
    clean: true,
    module: true,
    chunkFormat: 'module',
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        loader: 'esbuild-loader',
        // jsx: 'automatic' uses the React 19 default runtime that imports
        // `react/jsx-runtime` as a normal module, so the JSX-compiled output
        // does not depend on a bare `React` identifier being in scope. The
        // legacy `transform` (classic) runtime emits React.createElement(...)
        // which breaks under Module Federation: the singleton-shared `react`
        // module is fetched lazily, so `React` is undefined at the moment
        // JSX runs and the panel fails to mount.
        options: { loader: 'jsx', target: 'es2022', jsx: 'automatic' },
      },
    ],
  },
  resolve: { extensions: ['.js', '.jsx'] },
  plugins: [
    new ModuleFederationPlugin({
      name: containerName,
      library: { type: 'module' },
      filename: 'remoteEntry.js',
      exposes: {
        './PluginConfigurationPanel': './src/configpanel/PluginConfigurationPanel',
      },
      // Match the minimal share set used by signalk-virtual-weather-sensors:
      // share only `react` as a singleton. The panel never imports
      // `react-dom` directly (the host owns the root render), and
      // `react/jsx-runtime` is small and stateless so a bundled copy is
      // fine. Sharing more than necessary just bloats the federation
      // negotiation without payoff.
      shared: {
        react: { singleton: true, requiredVersion: pkg.devDependencies.react },
      },
    }),
  ],
};
