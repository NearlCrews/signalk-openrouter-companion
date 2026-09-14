module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies make lifecycle and configuration behavior hard to reason about.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'server-does-not-import-panel',
      severity: 'error',
      comment: 'The Node plugin bundle must not depend on browser-only configuration panel code.',
      from: { path: '^src/(analyzers|core)/|^src/(index|schema|types)\\.ts$' },
      to: { path: '^src/configpanel/' },
    },
    {
      name: 'panel-does-not-import-server-internals',
      severity: 'error',
      comment:
        'The panel may share pure contracts, but must not pull Node-only analyzer or core modules into the browser.',
      from: { path: '^src/configpanel/' },
      to: { path: '^src/(?:index\\.ts$|(?:analyzers|core)/)' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    // Follow `import type` and inline `import('...')` type references too.
    // They erase at compile time, so the default drops them, and here that hid
    // roughly 30 percent of the graph: the boundary rules below saw only value
    // imports, and a type-only cycle between the analyzer contract and the
    // publisher went unreported until this was turned on.
    tsPreCompilationDeps: true,
  },
};
