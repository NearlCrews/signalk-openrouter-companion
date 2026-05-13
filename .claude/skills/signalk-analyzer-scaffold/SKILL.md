---
name: signalk-analyzer-scaffold
description: Use this skill when the user wants to add a new analyzer to signalk-openrouter-companion. Triggers on: "add an analyzer for X", "/signalk-analyzer-scaffold <name>", "scaffold a new analyzer", "extend the plugin with a new monitor". Generates source + tests + types + schema + lifecycle wiring conforming to the existing modular framework.
---

# Scaffold a new analyzer

`signalk-openrouter-companion` is **one** npm package. Each monitoring domain is an `Analyzer` module under `src/analyzers/`. Never create a sibling package; always add a new analyzer.

This skill walks you through producing every file and patch needed for a new analyzer that conforms to the framework. Five analyzers already ship and serve as worked examples:

- `src/analyzers/maintenance.ts`: engine sessions, fires on `engine-stop`.
- `src/analyzers/health.ts`: daily battery summary, fires on cron.
- `src/analyzers/alerts.ts`: battery threshold notifications, fires on battery events.
- `src/analyzers/aging.ts`: monthly capacity-loss trend per bank from QuestDB.
- `src/analyzers/drift.ts`: weekly engine fuel-economy drift per RPM bin from QuestDB.

Their tests (`tests/maintenance.test.ts`, `tests/health.test.ts`, `tests/alerts.test.ts`, `tests/aging.test.ts`, `tests/drift.test.ts`) are the patterns for the test scaffold below.

The `Analyzer` interface lives in `src/analyzers/Analyzer.ts`. The standardized triggers contract (`{ cron, put, events }`) is documented in the project memory file `~/.claude/projects/-home-dietpi-src-signalk-openrouter-companion/memory/triggers_contract.md`. Read it before adding a new analyzer.

## Inputs

Take a short kebab-case `<name>` (e.g. `tankLevels`, `bilge`, `solar`). Derive:

- `<name>`: lowercase id used in config and file path (e.g. `bilge`).
- `<Name>`: PascalCase class prefix (e.g. `Bilge`).
- `<NAME>`: SCREAMING_SNAKE for the `*_SUPPORTED_EVENTS` constant.
- `<title>`: human-readable, used in admin UI (e.g. `Bilge Monitor`).

Confirm these with the user before generating files.

## Steps

1. Re-read the existing analyzers and their tests to lift any helper patterns relevant to the new domain (buffer summaries, `getSelfPath` snapshots, `readBankSnapshot`, QuestDB baselines).
2. Patch `src/analyzers/ids.ts`: append the new id to `ANALYZER_IDS` and the title to `ANALYZER_TITLES`. This is the single source of truth; api.ts, the registry, and the panel all read it.
3. Create `src/analyzers/<name>.ts` from the template below. Export a `<NAME>_DEFAULT_SYSTEM_PROMPT` constant; use `resolveSystemPrompt(cfg.customSystemPrompt, DEFAULT)` in the constructor.
4. Patch `src/analyzers/registry.ts::ANALYZER_FACTORIES`: add an entry mapping the new id to a factory closure that constructs the analyzer from its cfg sub-object. This is what `index.ts` iterates to instantiate enabled analyzers.
5. Patch `src/core/api.ts::DEFAULT_SYSTEM_PROMPTS`: add an entry mapping the new id to the default constant so `GET /api/analyzers/:id/prompt` can serve it.
6. Create `tests/<name>.test.ts` from the test scaffold below.
7. Patch `src/types.ts`: add the `*_SUPPORTED_EVENTS` constant, the config block under `PluginOptions.analyzers` (including `customSystemPrompt?: string`), the `DEFAULT_OPTIONS.analyzers.<name>` entry, and the `mergeWithDefaults` wiring.
8. Patch `src/schema.ts`: import the new constant, add the `analyzers.properties.<name>` schema entry using `enabledGate` + `triggerSchema`, and add the matching `analyzers.<name>` entry in `buildUiSchemaInner`.
9. Only patch `src/index.ts` if the analyzer needs a brand-new event source (similar to `EngineDetector` or `BatteryMonitor`). Standard cron + PUT + existing event subkinds need no `index.ts` change.
10. Run the verification commands at the bottom of this file.

Keep `src/index.ts` thin: the analyzer's constructor builds `this.triggers` from config, the registry instantiates it, and the lifecycle hands declared triggers to the scheduler / put-handler / domain emitter. Don't add domain-specific dispatch logic to `index.ts` beyond what the existing engine and battery sections already do.

## Analyzer source template

Path: `src/analyzers/<name>.ts`. Copy verbatim and replace `Foo` / `foo` / `FOO`:

```ts
import { resolveSystemPrompt } from '../core/cfg.js';
import { buildTriggers } from '../core/triggers.js';
import type { AnalyzerTriggerCfg } from '../types.js';
import type {
  AnalysisInput,
  Analyzer,
  AnalyzerDeps,
  TriggerCtx,
  TriggerSpec,
} from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

export interface FooCfg {
  triggers: AnalyzerTriggerCfg;
  customSystemPrompt?: string;
  // additional analyzer-specific tunables go here
}

export const FOO_DEFAULT_SYSTEM_PROMPT = [
  'You are a marine specialist reading Signal K telemetry.',
  'All numeric values are in Signal K SI base units except where the SK spec dictates otherwise: voltage in V, current in A, temperature in K, capacity in J, SoC as a 0-1 ratio. propulsion.*.revolutions is in Hz (rev/s, the documented Signal K unit for that path: do not convert to rad/s).',
  'Stick to facts present in the data. If a cause is unclear from the fields, say so.',
  'Stay under 350 words.',
].join(' ');

export interface FooInput extends AnalysisInput {
  generatedAt: string;
  // shape of context handed to buildPrompt
}

export class FooAnalyzer implements Analyzer<FooInput> {
  readonly id = 'foo';
  readonly title = ANALYZER_TITLES.foo;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  private readonly systemPrompt: string;

  constructor(cfg: FooCfg) {
    this.triggers = buildTriggers(cfg.triggers);
    this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, FOO_DEFAULT_SYSTEM_PROMPT);
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<FooInput | null> {
    // Gather data from deps.buffer (summarize windows), deps.app.getSelfPath (snapshots),
    // and optionally deps.questdb.query for QuestDB-backed trends. Return null to skip.
    const _ = ctx;
    const _deps = deps;
    return null;
  }

  buildPrompt(input: FooInput): { system: string; user: string } {
    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    // serialize each field of `input` into deterministic lines
    return { system: this.systemPrompt, user: lines.join('\n') };
  }

  // Optional: override `publishOutput` only when the analyzer needs a path or
  // state different from the default. The default (when omitted) publishes
  // via `deps.publisher.publishReport(this.id, ctx, text)` on the canonical
  // `notifications.openrouter-companion.<id>.report` path with
  // `state: 'nominal'` (informational; no NMEA 2000 alert PGN). Override
  // when you need an alert path or a non-default state, e.g. alerts.ts uses
  // `deps.publisher.publishOnPath(...)` with a per-event canonical path,
  // explicit alert state, and a stable `alertId` from `alertIdFor(path)`.
  // async publishOutput(text, ctx, deps): Promise<void> { ... }
}
```

## Test scaffold

Path: `tests/<name>.test.ts`. This is the minimum a TDD-style PR should ship with: trigger-derivation cases, a null-path test for `collectContext`, a happy-path `collectContext`, and a `buildPrompt` snapshot.

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import { FooAnalyzer } from '../src/analyzers/foo.js';
import { RollingBuffer } from '../src/core/buffer.js';
import {
  cleanupTmpDir,
  makeAnalyzerDeps,
  type MockApp,
  makeMockApp,
  makeTmpDir,
} from './_mocks.js';

function makeCfg() {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 9 * * *', timezone: '' },
      put: { enabled: true, path: 'plugins.openrouter-companion.foo.run' },
      events: [] as string[],
    },
  };
}

// makeAnalyzerDeps from tests/_mocks.ts is the canonical factory; use it
// rather than re-rolling the AnalyzerDeps literal. Pass {questdb} / {publisher}
// only when the test cares about them.

describe('FooAnalyzer', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
  });
  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it('declares triggers built from the triggers config', () => {
    const a = new FooAnalyzer(makeCfg());
    const kinds = a.triggers.map((t) => t.kind).sort();
    expect(kinds).toEqual(['cron', 'put']);
  });

  it('omits cron trigger when cron disabled', () => {
    const cfg = makeCfg();
    cfg.triggers.cron.enabled = false;
    const a = new FooAnalyzer(cfg);
    expect(a.triggers.map((t) => t.kind)).toEqual(['put']);
  });

  it('collectContext returns null when there is nothing to summarize', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const a = new FooAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T09:00:00Z') };
    const r = await a.collectContext(ctx, makeAnalyzerDeps(app, buf));
    expect(r).toBeNull();
  });

  it('buildPrompt produces deterministic system + user content', () => {
    const a = new FooAnalyzer(makeCfg());
    const out = a.buildPrompt({ generatedAt: '2026-05-11T09:00:00.000Z' });
    expect(out.system).toContain('marine');
    expect(out.user).toContain('2026-05-11');
  });
});
```

## `src/types.ts` patch

Add next to the existing `*_SUPPORTED_EVENTS` constants:

```ts
export const FOO_SUPPORTED_EVENTS = [] as const;
// If the analyzer subscribes to event subkinds, list them here and export the
// corresponding string-literal union, e.g.
// export const FOO_SUPPORTED_EVENTS = ['some-event'] as const;
// export type FooEventKind = (typeof FOO_SUPPORTED_EVENTS)[number];
```

Add to `PluginOptions.analyzers`:

```ts
foo: {
  enabled: boolean;
  triggers: AnalyzerTriggerCfg;
  customSystemPrompt?: string;
  // analyzer-specific tunables here, matching FooCfg
};
```

Add to `DEFAULT_OPTIONS.analyzers`:

```ts
foo: {
  enabled: true,
  triggers: {
    cron: { enabled: false, pattern: '', timezone: '' },
    put: { enabled: true, path: 'plugins.openrouter-companion.foo.run' },
    events: [],
  },
},
```

Extend `mergeWithDefaults`. Both the `inputAnalyzers` cast and the returned `analyzers` object need a `foo` entry:

```ts
const inputAnalyzers = input.analyzers as
  | {
      maintenance?: WithPartialTriggers<PluginOptions['analyzers']['maintenance']>;
      health?: WithPartialTriggers<PluginOptions['analyzers']['health']>;
      alerts?: WithPartialTriggers<PluginOptions['analyzers']['alerts']>;
      foo?: WithPartialTriggers<PluginOptions['analyzers']['foo']>;
    }
  | undefined;
// ...
analyzers: {
  // ...existing...
  foo: mergeAnalyzerCfg(DEFAULT_OPTIONS.analyzers.foo, inputAnalyzers?.foo),
},
```

## `src/schema.ts` patch

Import the new constant:

```ts
import { ..., FOO_SUPPORTED_EVENTS } from './types.js';
```

Add a sibling entry to the existing `maintenance` / `health` / `alerts` blocks inside `buildSchemaInner().properties.analyzers.properties`. The `enabledGate` and `triggerSchema` helpers do all the heavy lifting:

```ts
foo: {
  type: 'object',
  title: 'Foo Analyzer',
  description: 'Plain-English description of what this analyzer does.',
  properties: {
    enabled: {
      type: 'boolean',
      title: 'Enable foo analyzer',
      default: DEFAULT_OPTIONS.analyzers.foo.enabled,
    },
  },
  ...enabledGate({
    whenEnabled: {
      triggers: triggerSchema(DEFAULT_OPTIONS.analyzers.foo.triggers, FOO_SUPPORTED_EVENTS),
      // additional analyzer-specific tunables here
    },
  }),
},
```

And the matching `buildUiSchemaInner().analyzers` entry:

```ts
foo: {
  'ui:order': ['enabled', 'triggers'],
  triggers: triggerUiSchema(FOO_SUPPORTED_EVENTS),
},
```

If the analyzer adds event subkinds, also extend `EVENT_TITLES` so the admin UI renders human-readable labels for each checkbox.

## `src/analyzers/ids.ts` patch

Add the new id and title (single source of truth used by api.ts and the panel):

```ts
export const ANALYZER_IDS = ['maintenance', 'health', 'aging', 'drift', 'alerts', 'foo'] as const;

export const ANALYZER_TITLES: Record<AnalyzerId, string> = {
  // ...existing...
  foo: 'Foo Analyzer',
};
```

## `src/core/api.ts` patch

Register the default prompt so `GET /api/analyzers/:id/prompt` can serve it:

```ts
import { FOO_DEFAULT_SYSTEM_PROMPT } from '../analyzers/foo.js';

export const DEFAULT_SYSTEM_PROMPTS: Record<AnalyzerId, string> = {
  // ...existing...
  foo: FOO_DEFAULT_SYSTEM_PROMPT,
};
```

## `src/analyzers/registry.ts` patch

Add the factory closure that wires the cfg sub-object to the constructor. `index.ts` iterates `ANALYZER_IDS` and instantiates each enabled analyzer via this map; no further wiring is needed for cron + PUT + standard event triggers.

```ts
import { FooAnalyzer } from './foo.js';

export const ANALYZER_FACTORIES: AnalyzerFactories = {
  // ...existing...
  foo: (c) =>
    new FooAnalyzer({
      triggers: c.triggers,
      customSystemPrompt: c.customSystemPrompt,
      // forward any analyzer-specific cfg fields too
    }),
};
```

`registerAnalyzerPut` is called by `index.ts` for every section via `Object.values(cfg.analyzers)`, so no PUT-specific wiring is needed.

If the analyzer needs a brand-new event source (similar to `EngineDetector` or `BatteryMonitor`), build it under `src/core/` (extending `TypedEmitter<Kind, Event>` from `core/emitter.ts`) and subscribe its events in `index.ts`. Call `router.dispatch(...)` with a `TriggerCtx` carrying the kind your analyzer's constructor pushed into `this.triggers`.

## Verification

After all patches are in place, run from the repo root:

```
npm run type-check
npm test
npm run lint
npm run build
```

All four must pass before committing. `npm run prepublishOnly` chains the same four.

Confirm the new analyzer is exposed in the served schema:

```
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/skServer/plugins \
  | jq '.[] | select(.id == "signalk-openrouter-companion") | .schema.properties.analyzers.properties'
```

The result should include a `foo` key with the title and description you set.

## Style guardrails

- No em dashes anywhere in generated code, tests, comments, commit messages, or docs. Prefer colons or split sentences.
- Notification paths use `notifications.openrouter-companion.<id>.<...>`.
- PUT paths use `plugins.openrouter-companion.<id>.<verb>`.
- Stick to Signal K SI base units in prompts: V, A, K, J, ratios. Note that `propulsion.*.revolutions` is documented in Hz (rev/s), not rad/s, even though rad/s is the SI base unit for angular velocity. Don't have the prompt tell the LLM to interpret revolutions as rad/s.
- Reuse `src/core/skNode.ts` helpers: `readNumberAt` for a single numeric leaf, `readValueAt` for raw value reads, `asTreeMap` to unwrap a subtree, and `readBankSnapshot` for the canonical battery snapshot fields. Don't reimplement node-walking.
