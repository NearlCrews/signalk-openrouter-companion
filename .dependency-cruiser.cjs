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
        'The panel may share pure contracts, but must not pull Node-only analyzer or core modules into the browser. core/triggerContext.ts (the run vocabulary) and core/paths.ts (the plugin id and its HTTP prefix) are the exceptions: each imports nothing of its own (the rule below keeps it that way), so neither can carry Node code into the panel bundle.',
      from: { path: '^src/configpanel/' },
      to: {
        path: '^src/(?:index\\.ts$|(?:analyzers|core)/)',
        pathNot: '^src/core/(?:triggerContext|paths)\\.ts$',
      },
    },
    {
      name: 'shared-core-leaves-stay-leaves',
      severity: 'error',
      comment:
        'core/triggerContext.ts and core/paths.ts are shared with the browser panel, and triggerContext.ts is read by core services that must not import the analyzer layer. Both stay leaves: no imports of their own, so neither can carry one layer into another.',
      from: { path: '^src/core/(?:triggerContext|paths)\\.ts$' },
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
