---
name: signalk-analyzer-scaffold
description: Use this skill when the user wants to add a new analyzer to signalk-openrouter-companion. Triggers on: "add an analyzer for X", "/signalk-analyzer-scaffold <name>", "scaffold a new analyzer", "extend the plugin with a new monitor". Generates source + tests + types + schema + lifecycle wiring conforming to the existing modular framework.
---

# Scaffold a new analyzer

`signalk-openrouter-companion` is **one** npm package. Each monitoring domain is an `Analyzer` module under `src/analyzers/`. Never create a sibling package; always add a new analyzer.

This skill walks you through producing every file and patch needed for a new analyzer that conforms to the framework. Three analyzers already ship and serve as worked examples:

- `src/analyzers/maintenance.ts`: engine sessions, fires on `engine-stop`.
- `src/analyzers/health.ts`: daily battery summary, fires on cron.
- `src/analyzers/alerts.ts`: battery threshold notifications, fires on battery events.

Their tests (`tests/maintenance.test.ts`, `tests/health.test.ts`, `tests/alerts.test.ts`) are the patterns for the test scaffold below.

The `Analyzer` interface lives in `src/analyzers/Analyzer.ts`. The standardized triggers contract (`{ cron, put, events }`) is documented in the project memory file `~/.claude/projects/-home-dietpi-src-signalk-openrouter-companion/memory/triggers_contract.md`. Read it before adding a new analyzer.

## Inputs

Take a short kebab-case `<name>` (e.g. `tankLevels`, `bilge`, `solar`). Derive:

- `<name>`: lowercase id used in config and file path (e.g. `bilge`).
- `<Name>`: PascalCase class prefix (e.g. `Bilge`).
- `<NAME>`: SCREAMING_SNAKE for the `*_SUPPORTED_EVENTS` constant.
- `<title>`: human-readable, used in admin UI (e.g. `Bilge Monitor`).

Confirm these with the user before generating files.

## Steps

1. Re-read the three existing analyzers and their tests to lift any helper patterns relevant to the new domain (buffer summaries, `getSelfPath` snapshots, QuestDB baselines).
2. Create `src/analyzers/<name>.ts` from the template below.
3. Create `tests/<name>.test.ts` from the test scaffold below.
4. Patch `src/types.ts`: add the `*_SUPPORTED_EVENTS` constant, the config block under `PluginOptions.analyzers`, the `DEFAULT_OPTIONS.analyzers.<name>` entry, and the `mergeWithDefaults` wiring.
5. Patch `src/schema.ts`: import the new constant, add the `analyzers.properties.<name>` schema entry using `enabledGate` + `triggerSchema`, and add the matching `analyzers.<name>` entry in `buildUiSchemaInner`.
6. Patch `src/index.ts`: import the new analyzer class, push it onto the `analyzers` array when enabled, and register any non-cron/non-put event source (e.g. a new emitter alongside `EngineDetector` or `BatteryMonitor`).
7. Run the verification commands at the bottom of this file.

Keep `src/index.ts` thin: the analyzer's constructor builds `this.triggers` from config. The lifecycle just hands declared triggers to the scheduler / put-handler / domain emitter. Don't add domain-specific dispatch logic to `index.ts` beyond what the existing engine and battery sections already do.

## Analyzer source template

Path: `src/analyzers/<name>.ts`. Copy verbatim and replace `Foo` / `foo` / `FOO`:

```ts
import type { AnalyzerTriggerCfg } from '../types.js';
import type {
  AnalysisInput,
  Analyzer,
  AnalyzerDeps,
  TriggerCtx,
  TriggerSpec,
} from './Analyzer.js';

export interface FooCfg {
  triggers: AnalyzerTriggerCfg;
  // additional analyzer-specific tunables go here
}

export interface FooInput extends AnalysisInput {
  generatedAt: string;
  // shape of context handed to buildPrompt
}

export class FooAnalyzer implements Analyzer<FooInput> {
  readonly id = 'foo';
  readonly title = 'Foo Analyzer';
  readonly triggers: ReadonlyArray<TriggerSpec>;

  constructor(private cfg: FooCfg) {
    const triggers: TriggerSpec[] = [];
    if (cfg.triggers.cron.enabled && cfg.triggers.cron.pattern) {
      triggers.push({ kind: 'cron', pattern: cfg.triggers.cron.pattern });
    }
    if (cfg.triggers.put.enabled && cfg.triggers.put.path) {
      triggers.push({ kind: 'put', path: cfg.triggers.put.path });
    }
    // If this analyzer subscribes to domain events, push them here.
    // Read cfg.triggers.events and translate each string into a TriggerSpec.
    this.triggers = triggers;
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<FooInput | null> {
    // Gather data from deps.buffer (summarize windows), deps.app.getSelfPath (snapshots),
    // and optionally deps.questdb.baselineFor for 30-day baselines. Return null to skip.
    const _ = ctx; // discard unused for now
    const _deps = deps;
    return null;
  }

  buildPrompt(input: FooInput): { system: string; user: string } {
    const system = [
      'You are a marine specialist reading Signal K telemetry.',
      'All numeric values are in Signal K SI base units except where the SK spec dictates otherwise: voltage in V, current in A, temperature in K, capacity in J, SoC as a 0-1 ratio. propulsion.*.revolutions is in Hz (rev/s, the documented Signal K unit for that path: do not convert to rad/s).',
      'Stick to facts present in the data. If a cause is unclear from the fields, say so.',
      'Stay under 350 words.',
    ].join(' ');

    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    // serialize each field of `input` into deterministic lines
    return { system, user: lines.join('\n') };
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzerDeps, TriggerCtx } from '../src/analyzers/Analyzer.js';
import { FooAnalyzer } from '../src/analyzers/foo.js';
import { RollingBuffer } from '../src/core/buffer.js';
import { Logger } from '../src/core/logger.js';
import { cleanupTmpDir, type MockApp, makeMockApp, makeTmpDir } from './_mocks.js';

function makeCfg() {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 9 * * *', timezone: '' },
      put: { enabled: true, path: 'plugins.openrouter-companion.foo.run' },
      events: [] as string[],
    },
  };
}

function makeDeps(app: MockApp, buffer: RollingBuffer): AnalyzerDeps {
  return {
    app: { getSelfPath: (p) => app.getSelfPath(p), selfContext: app.selfContext },
    buffer,
    questdb: null,
    publisher: {} as never,
    budget: {} as never,
    llm: {} as never,
    logger: new Logger({ debug: vi.fn(), error: vi.fn() }),
  };
}

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
    const r = await a.collectContext(ctx, makeDeps(app, buf));
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

## `src/index.ts` patch

Import and register:

```ts
import { FooAnalyzer } from './analyzers/foo.js';

// inside start(), alongside the existing analyzers.push(...) block:
if (cfg.analyzers.foo.enabled) {
  analyzers.push(new FooAnalyzer({ triggers: cfg.analyzers.foo.triggers }));
}

// and alongside the existing registerAnalyzerPut(...) calls:
registerAnalyzerPut(app, cfg.analyzers.foo, () => router, PLUGIN_ID);
```

If the analyzer needs a brand-new event source (similar to `EngineDetector` or `BatteryMonitor`), build it under `src/core/` and wire it up the same way: subscribe its events and call `router.dispatch(...)` with a `TriggerCtx` carrying the kind your analyzer's constructor pushed into `this.triggers`.

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
- Reuse `src/core/skNode.ts` `readNumberAt` helper rather than reimplementing node-walking.
