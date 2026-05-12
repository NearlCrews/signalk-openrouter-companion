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
  output: {
    path: path.resolve(__dirname, 'public'),
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        loader: 'esbuild-loader',
        options: { loader: 'jsx', target: 'es2022' },
      },
    ],
  },
  resolve: { extensions: ['.js', '.jsx'] },
  plugins: [
    new ModuleFederationPlugin({
      name: containerName,
      library: { type: 'var', name: containerName },
      filename: 'remoteEntry.js',
      exposes: {
        './PluginConfigurationPanel': './src/configpanel/PluginConfigurationPanel',
      },
      shared: {
        react: { singleton: true, requiredVersion: pkg.devDependencies.react },
        'react-dom': { singleton: true, requiredVersion: pkg.devDependencies['react-dom'] },
      },
    }),
  ],
};
