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
        'The panel may share pure contracts, but must not pull Node-only analyzer or core modules into the browser. core/triggerContext.ts is the exception: it is the run vocabulary, it imports nothing (the rule below keeps it that way), and its types erase at compile time.',
      from: { path: '^src/configpanel/' },
      to: {
        path: '^src/(?:index\\.ts$|(?:analyzers|core)/)',
        pathNot: '^src/core/triggerContext\\.ts$',
      },
    },
    {
      name: 'trigger-vocabulary-stays-a-leaf',
      severity: 'error',
      comment:
        'core/triggerContext.ts is shared with the browser panel and read by core services that must not import the analyzer layer. It stays a leaf: no imports of its own, so it cannot carry either layer into the other.',
      from: { path: '^src/core/triggerContext\\.ts$' },
      to: { path: '^src/' },
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
