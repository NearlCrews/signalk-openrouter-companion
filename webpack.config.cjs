// Builds the Signal K admin UI panel exposed via Module Federation.
// Output goes to public/, which the SK server mounts at
// /<package>/ when the package has the `signalk-plugin-configurator` keyword.
// React 19 and React DOM are shared as singletons so the panel reuses the
// runtimes supplied by Signal K Admin.
const path = require('node:path');
const { ModuleFederationPlugin } = require('webpack').container;
// The share map ships with the shared UI release the panel bundles, so this
// file cannot drift from it. `hostNotes` on the same entry records why the
// shares are non-strict singletons.
const { shared } = require('signalk-nearlcrews-ui/federation');
const pkg = require('./package.json');

const containerName = pkg.name.replace(/[-@/]/g, '_');

module.exports = {
  entry: {},
  mode: 'production',
  devtool: false,
  // Output an ES module so the SK admin's `<script type="module">` tag
  // (auto-applied because this package's `package.json` has
  // `"type": "module"`) can `import()` our container and read its
  // `.get` / `.init` exports. The legacy `library: { type: 'var' }`
  // path requires a classic script tag so the federation container var
  // lands on `window`, which never happens for ESM packages.
  // Native CSS support emits the CSS Modules as a stylesheet asset the
  // remote links at runtime, instead of a style tag injected by a loader.
  experiments: { css: true, outputModule: true },
  output: {
    path: path.resolve(__dirname, 'public'),
    clean: true,
    filename: '[name].js',
    chunkFilename: '[name].[contenthash].mjs',
    cssChunkFilename: '[name].[contenthash].css',
    module: true,
    chunkFormat: 'module',
    uniqueName: containerName,
  },
  optimization: {
    // Keep the exposed panel and the bundled shared UI in one async chunk. The
    // remote still loads lazily, and one chunk avoids a second compression
    // dictionary and module wrapper across panel and library code.
    splitChunks: false,
  },
  module: {
    rules: [
      {
        // One rule covers the panel's `.tsx` components and the non-JSX `.ts`
        // modules shared with the backend (e.g. src/cronPresets.ts, the single
        // source of truth for the schedule presets). esbuild-loader strips the
        // types and compiles the JSX; no separate tsc pass runs for the panel
        // (it is excluded from tsconfig). The `loader` option is intentionally
        // omitted: esbuild-loader v3+ picks the right esbuild loader per file
        // extension, so `.ts` files keep angle-bracket type assertions (never
        // parsed as JSX) while `.tsx` files get JSX compilation.
        // jsx: 'automatic' uses the React 19 default runtime that imports
        // `react/jsx-runtime` as a normal module, so the compiled output does
        // not depend on a bare `React` identifier being in scope. The legacy
        // `transform` (classic) runtime emits React.createElement(...) which
        // breaks under Module Federation: the singleton-shared `react` module
        // is fetched lazily, so `React` is undefined at the moment JSX runs and
        // the panel fails to mount.
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        loader: 'esbuild-loader',
        options: { target: 'es2022', jsx: 'automatic' },
      },
      {
        test: /\.module\.css$/,
        type: 'css/module',
        parser: {
          container: false,
          dashedIdents: false,
          namedExports: false,
        },
        generator: {
          localIdentName: 'orc_[local]--[hash:base64:5]',
        },
      },
    ],
  },
  // extensionAlias lets a `.js` import specifier resolve to a `.ts`/`.tsx`
  // source. The panel imports its own modules and the shared backend modules
  // with the `.js` specifier the backend also uses, while the files on disk are
  // TypeScript.
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  plugins: [
    new ModuleFederationPlugin({
      name: containerName,
      library: { type: 'module' },
      filename: 'remoteEntry.js',
      exposes: {
        './PluginConfigurationPanel': './src/configpanel/PluginConfigurationPanel',
      },
      shared,
    }),
  ],
};
