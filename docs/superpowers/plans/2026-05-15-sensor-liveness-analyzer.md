# Sensor-Liveness Analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth analyzer, `liveness`, that reports which watched SignalK paths have gone stale or are served by multiple sources.

**Architecture:** A state analyzer that reads `deps.buffer` (the `RollingBuffer`) only: `pathKeys()` enumerates watched paths, `slice(path, 0, firedAt)` per path yields the newest timestamp (freshness) and the distinct source set (flapping). No new subscriptions, no `RollingBuffer` changes, no QuestDB. It publishes via the default `publishReport` path with `state: nominal`.

**Tech Stack:** TypeScript 6 (ESM), vitest, biome. The analyzer plugs into the existing modular framework: `ids.ts` (id + title), `registry.ts` (factory), `types.ts` (config shape + defaults), `schema.ts` (rjsf form), `core/api.ts` (default-prompt registry).

**Spec:** `docs/superpowers/specs/2026-05-15-sensor-liveness-analyzer-design.md`

---

## File Structure

- **Create** `src/analyzers/liveness.ts` - the `LivenessAnalyzer` class, its config interface, input types, and default system prompt.
- **Create** `tests/liveness.test.ts` - unit tests for the analyzer.
- **Modify** `src/analyzers/ids.ts` - register the `liveness` id and title.
- **Modify** `src/types.ts` - add the `liveness` config shape, defaults, merge wiring, and two exported constants.
- **Modify** `src/analyzers/registry.ts` - add the `liveness` factory.
- **Modify** `src/core/api.ts` - add the liveness default prompt to `DEFAULT_SYSTEM_PROMPTS`.
- **Modify** `src/schema.ts` - add the rjsf schema + uiSchema block for `liveness`.
- **Modify** `tests/schema.test.ts` - assert the liveness schema block exists.

Adding an analyzer is type-coupled: `ANALYZER_FACTORIES` and `DEFAULT_SYSTEM_PROMPTS` are mapped over `AnalyzerId`, so `tsc` fails until every registry has a `liveness` entry. Task 1 lands all of that together so the build is green at its commit. Task 2 (schema) is independent and commits separately.

---

## Task 1: Liveness analyzer module and framework wiring

**Files:**
- Create: `src/analyzers/liveness.ts`
- Create: `tests/liveness.test.ts`
- Modify: `src/analyzers/ids.ts`
- Modify: `src/types.ts`
- Modify: `src/analyzers/registry.ts`
- Modify: `src/core/api.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/liveness.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import { LivenessAnalyzer } from '../src/analyzers/liveness.js';
import { RollingBuffer } from '../src/core/buffer.js';
import {
  cleanupTmpDir,
  type MockApp,
  makeAnalyzerDeps as makeDeps,
  makeMockApp,
  makeTmpDir,
} from './_mocks.js';

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 8 * * *', timezone: '' },
      put: { enabled: true, path: 'plugins.openrouter-companion.liveness.run' },
      events: [],
    },
    stalenessThresholdSec: 300,
    ...overrides,
  };
}

const FIRED = new Date('2026-05-15T08:00:00Z');
const FIRED_MS = FIRED.getTime();

function freshBuffer(): RollingBuffer {
  return new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
}

describe('LivenessAnalyzer', () => {
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
    const a = new LivenessAnalyzer(makeCfg());
    const kinds = a.triggers.map((t) => t.kind).sort();
    expect(kinds).toEqual(['cron', 'put']);
  });

  it('collectContext returns null when the buffer is empty', async () => {
    const a = new LivenessAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: FIRED };
    const r = await a.collectContext(ctx, makeDeps(app, freshBuffer()));
    expect(r).toBeNull();
  });

  it('marks a recently-updated path as not stale', async () => {
    const buf = freshBuffer();
    buf.record('electrical.batteries.house.voltage', 12.6, FIRED_MS - 1000, 'bms');
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    expect(r?.paths).toHaveLength(1);
    expect(r?.paths[0]?.stale).toBe(false);
    expect(r?.paths[0]?.lastSeenAgeSec).toBe(1);
  });

  it('marks a path with an old newest sample as stale', async () => {
    const buf = freshBuffer();
    buf.record('propulsion.port.revolutions', 25, FIRED_MS - 600_000, 'n2k');
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    expect(r?.paths[0]?.stale).toBe(true);
    expect(r?.paths[0]?.lastSeenAgeSec).toBe(600);
  });

  it('treats a path with no sample in [0, firedAt] as stale with null age', async () => {
    const buf = freshBuffer();
    // Only sample is timestamped after firedAt, so the [0, firedMs] slice is empty.
    buf.record('environment.depth.belowTransducer', 3.1, FIRED_MS + 5000, 'sounder');
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    expect(r?.paths[0]?.lastSeenAgeSec).toBeNull();
    expect(r?.paths[0]?.stale).toBe(true);
  });

  it('flags a path served by two sources as flapping', async () => {
    const buf = freshBuffer();
    buf.record('propulsion.port.temperature', 350, FIRED_MS - 2000, 'nmea2000_feed');
    buf.record('propulsion.port.temperature', 351, FIRED_MS - 1000, 'notificationApi');
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    expect(r?.paths[0]?.flapping).toBe(true);
    expect(r?.paths[0]?.sources).toEqual(['nmea2000_feed', 'notificationApi']);
  });

  it('treats a sample exactly at the threshold as not stale, just over as stale', async () => {
    const buf = freshBuffer();
    buf.record('at.threshold', 1, FIRED_MS - 300_000, 's'); // age 300s == threshold
    buf.record('over.threshold', 1, FIRED_MS - 301_000, 's'); // age 301s > threshold
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    const byPath = Object.fromEntries((r?.paths ?? []).map((p) => [p.path, p.stale]));
    expect(byPath['at.threshold']).toBe(false);
    expect(byPath['over.threshold']).toBe(true);
  });

  it('buildPrompt includes path names, the threshold, and stale/flapping flags', () => {
    const a = new LivenessAnalyzer(makeCfg());
    const out = a.buildPrompt({
      generatedAt: '2026-05-15T08:00:00.000Z',
      stalenessThresholdSec: 300,
      paths: [
        {
          path: 'propulsion.port.revolutions',
          lastSeenAgeSec: 600,
          stale: true,
          sampleCount: 3,
          sources: ['n2k'],
          flapping: false,
        },
      ],
    });
    expect(out.system).toContain('Signal K');
    expect(out.user).toContain('propulsion.port.revolutions');
    expect(out.user).toContain('300');
    expect(out.user).toContain('STALE');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/liveness.test.ts`
Expected: FAIL - cannot resolve `../src/analyzers/liveness.js` (module does not exist yet).

- [ ] **Step 3: Register the id and title in `src/analyzers/ids.ts`**

Change the `ANALYZER_IDS` array (line 5) to append `'liveness'`:

```ts
export const ANALYZER_IDS = ['maintenance', 'health', 'aging', 'drift', 'alerts', 'liveness'] as const;
```

Add the title to `ANALYZER_TITLES` (the object literal ending at line 16) - add this entry after `alerts`:

```ts
  liveness: 'Sensor Liveness Monitor',
```

- [ ] **Step 4: Add the config shape, constants, and merge wiring in `src/types.ts`**

After the `DRIFT_DEFAULT_BASELINE_DAYS` line (line 30), add:

```ts
// Liveness-analyzer default: a watched path with no sample newer than this
// many seconds is reported stale. Source-of-truth for the schema default and
// the analyzer constructor's clamp fallback.
export const LIVENESS_DEFAULT_STALENESS_SEC = 300;
```

After the `DRIFT_SUPPORTED_EVENTS` line (line 16), add:

```ts
export const LIVENESS_SUPPORTED_EVENTS = [] as const;
```

In `PluginOptions['analyzers']`, after the `alerts` block (closes at line 88) add:

```ts
    liveness: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
      stalenessThresholdSec: number;
      customSystemPrompt?: string;
    };
```

In `DEFAULT_OPTIONS.analyzers`, after the `alerts` block (closes at line 164) add:

```ts
    liveness: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 * * *', timezone: '' },
        put: { enabled: true, path: pluginPutPath('liveness') },
        events: [],
      },
      stalenessThresholdSec: LIVENESS_DEFAULT_STALENESS_SEC,
    },
```

In `mergeWithDefaults`, extend the `inputAnalyzers` type union (the object type spanning lines 201-207) by adding this line after `alerts?:`:

```ts
        liveness?: WithPartialTriggers<PluginOptions['analyzers']['liveness']>;
```

And in the returned `analyzers` object (lines 213-220) add after the `alerts:` line:

```ts
      liveness: mergeAnalyzerCfg(DEFAULT_OPTIONS.analyzers.liveness, inputAnalyzers?.liveness),
```

- [ ] **Step 5: Create `src/analyzers/liveness.ts`**

```ts
import { clampPositiveInt, resolveSystemPrompt } from '../core/cfg.js';
import { buildTriggers } from '../core/triggers.js';
import { type AnalyzerTriggerCfg, LIVENESS_DEFAULT_STALENESS_SEC } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

export interface LivenessCfg {
  triggers: AnalyzerTriggerCfg;
  stalenessThresholdSec: number;
  customSystemPrompt?: string;
}

export const LIVENESS_DEFAULT_SYSTEM_PROMPT = [
  'You are a marine systems engineer reviewing the health of a Signal K data pipeline.',
  'You are given a list of Signal K paths, each with the age of its most recent sample, a sample count, and the data sources serving it.',
  'A path marked STALE has produced no sample within the configured staleness window; a path marked FLAPPING is served by more than one source.',
  'Treat intermittently-powered equipment as expected: engine and propulsion paths (propulsion.*) go silent whenever the engine is off, so their staleness is normal and not a fault unless other data shows the engine running.',
  'Lead with the headline (overall pipeline state). Then name any genuinely stale path and any flapping path, and briefly say why it matters.',
  'If everything is reporting normally, say so plainly.',
  'Stick to the facts in the data; do not speculate about causes you cannot see.',
  'Output is rendered in the Signal K data browser as a single string. Produce one short paragraph of plain prose (80-150 words). Do not use markdown: no headers, no bullets, no horizontal rules. Use semicolons and commas to separate points.',
].join(' ');

interface PathLiveness {
  path: string;
  lastSeenAgeSec: number | null;
  stale: boolean;
  sampleCount: number;
  sources: string[];
  flapping: boolean;
}

export interface LivenessInput extends AnalysisInput {
  generatedAt: string;
  stalenessThresholdSec: number;
  paths: PathLiveness[];
}

export class LivenessAnalyzer implements Analyzer<LivenessInput> {
  readonly id = 'liveness';
  readonly title = ANALYZER_TITLES.liveness;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  private readonly systemPrompt: string;
  private readonly stalenessThresholdSec: number;

  constructor(cfg: LivenessCfg) {
    this.triggers = buildTriggers(cfg.triggers);
    this.stalenessThresholdSec = clampPositiveInt(
      cfg.stalenessThresholdSec,
      LIVENESS_DEFAULT_STALENESS_SEC,
    );
    this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, LIVENESS_DEFAULT_SYSTEM_PROMPT);
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<LivenessInput | null> {
    const firedMs = ctx.firedAt.getTime();
    const paths: PathLiveness[] = [];
    for (const path of deps.buffer.pathKeys()) {
      const entries = deps.buffer.slice(path, 0, firedMs);
      let newestTs: number | null = null;
      const sources = new Set<string>();
      for (const e of entries) {
        if (newestTs == null || e.ts > newestTs) newestTs = e.ts;
        sources.add(e.source);
      }
      const lastSeenAgeSec = newestTs == null ? null : (firedMs - newestTs) / 1000;
      const sortedSources = Array.from(sources).sort();
      paths.push({
        path,
        lastSeenAgeSec,
        stale: lastSeenAgeSec == null || lastSeenAgeSec > this.stalenessThresholdSec,
        sampleCount: entries.length,
        sources: sortedSources,
        flapping: sortedSources.length > 1,
      });
    }
    if (paths.length === 0) return null;
    paths.sort((a, b) => a.path.localeCompare(b.path));
    return {
      generatedAt: new Date(firedMs).toISOString(),
      stalenessThresholdSec: this.stalenessThresholdSec,
      paths,
    };
  }

  buildPrompt(input: LivenessInput): { system: string; user: string } {
    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    lines.push(`## Staleness threshold: ${input.stalenessThresholdSec}s`);
    lines.push('');
    for (const p of input.paths) {
      const age =
        p.lastSeenAgeSec == null ? 'no samples retained' : `${p.lastSeenAgeSec.toFixed(0)}s ago`;
      const flags = [p.stale ? 'STALE' : null, p.flapping ? 'FLAPPING' : null]
        .filter((f) => f != null)
        .join(' ');
      lines.push(
        `- ${p.path}: last sample ${age}; ${p.sampleCount} samples; sources=[${p.sources.join(', ')}]${
          flags ? ` ${flags}` : ''
        }`,
      );
    }
    return { system: this.systemPrompt, user: lines.join('\n') };
  }
}
```

- [ ] **Step 6: Wire the factory in `src/analyzers/registry.ts`**

Add the import alongside the other analyzer imports (after the `HealthAnalyzer` import line):

```ts
import { LivenessAnalyzer } from './liveness.js';
```

Add this entry to the `ANALYZER_FACTORIES` object, after the `alerts` entry:

```ts
  liveness: (c) =>
    new LivenessAnalyzer({
      triggers: c.triggers,
      stalenessThresholdSec: c.stalenessThresholdSec,
      customSystemPrompt: c.customSystemPrompt,
    }),
```

- [ ] **Step 7: Add the default prompt in `src/core/api.ts`**

Add the import alongside the other `*_DEFAULT_SYSTEM_PROMPT` imports (after the `HEALTH_DEFAULT_SYSTEM_PROMPT` import line):

```ts
import { LIVENESS_DEFAULT_SYSTEM_PROMPT } from '../analyzers/liveness.js';
```

Add this entry to the `DEFAULT_SYSTEM_PROMPTS` object (currently lines 50-55), after `alerts`:

```ts
  liveness: LIVENESS_DEFAULT_SYSTEM_PROMPT,
```

- [ ] **Step 8: Run type-check and the analyzer tests**

Run: `npm run type-check && npx vitest run tests/liveness.test.ts`
Expected: type-check passes with no errors; all 8 tests in `tests/liveness.test.ts` PASS.

- [ ] **Step 9: Commit**

```bash
git add src/analyzers/liveness.ts tests/liveness.test.ts src/analyzers/ids.ts src/types.ts src/analyzers/registry.ts src/core/api.ts
git commit -m "$(cat <<'EOF'
feat: add sensor-liveness analyzer

A sixth state analyzer that reads the RollingBuffer and reports watched
SignalK paths that have gone stale or are served by multiple sources.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: rjsf schema for the liveness analyzer

**Files:**
- Modify: `tests/schema.test.ts`
- Modify: `src/schema.ts`

- [ ] **Step 1: Write the failing test**

In `tests/schema.test.ts`, inside the `describe('schema', ...)` block, add this test after the existing `it('exposes a triggers block on the maintenance analyzer ...')` test:

```ts
  it('exposes the liveness analyzer with a staleness threshold field', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: Record<string, EnabledGatedNode>;
    };
    expect(analyzers.properties.liveness).toBeDefined();
    const onBranch = enabledTrueBranch(analyzers.properties.liveness);
    expect(onBranch.triggers).toBeDefined();
    expect(onBranch.stalenessThresholdSec).toBeDefined();
  });
```

(`buildSchema`, `EnabledGatedNode`, and `enabledTrueBranch` are already imported/defined at the top of `tests/schema.test.ts`; do not re-import them.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/schema.test.ts -t "liveness analyzer with a staleness"`
Expected: FAIL - `analyzers.properties.liveness` is `undefined`.

- [ ] **Step 3: Add the liveness schema block in `src/schema.ts`**

Add `LIVENESS_SUPPORTED_EVENTS` to the import from `./types.js` (the import block spanning lines 2-11), keeping the list alphabetically consistent with the existing `*_SUPPORTED_EVENTS` imports.

In `buildSchemaInner`, inside `analyzers.properties`, add this block after the `alerts` block (which closes near line 515):

```ts
          liveness: {
            type: 'object',
            title: 'Sensor Liveness Monitor',
            description:
              'Reports watched Signal K paths that have gone stale or are served by multiple sources.',
            properties: {
              enabled: {
                type: 'boolean',
                title: 'Enable sensor liveness monitoring',
                default: DEFAULT_OPTIONS.analyzers.liveness.enabled,
              },
            },
            ...enabledGate({
              whenEnabled: {
                triggers: triggerSchema({
                  defaults: DEFAULT_OPTIONS.analyzers.liveness.triggers,
                  supportedEvents: LIVENESS_SUPPORTED_EVENTS,
                }),
                stalenessThresholdSec: {
                  type: 'integer',
                  title: 'Staleness threshold (seconds)',
                  description:
                    'A watched path with no sample newer than this is reported as stale. Default 300.',
                  default: DEFAULT_OPTIONS.analyzers.liveness.stalenessThresholdSec,
                  minimum: 30,
                },
              },
            }),
          },
```

In `buildUiSchemaInner`, inside `analyzers`, add this entry after the `alerts` entry (closes near line 602):

```ts
      liveness: {
        'ui:order': ['enabled', 'triggers', 'stalenessThresholdSec'],
        triggers: triggerUiSchema({ supportedEvents: LIVENESS_SUPPORTED_EVENTS }),
      },
```

- [ ] **Step 4: Run the schema tests**

Run: `npx vitest run tests/schema.test.ts`
Expected: all tests PASS, including the new liveness test.

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts tests/schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add rjsf schema for the sensor-liveness analyzer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the full pre-push gate**

Run: `npm run prepublishOnly`
Expected: `type-check`, `lint`, `test`, and `build` all complete with no errors. The test count is 8 higher than before Task 1 (the new `tests/liveness.test.ts` cases) plus the one new `schema.test.ts` case. `dist/index.js` and `public/remoteEntry.js` rebuild successfully.

- [ ] **Step 2: If lint reports formatting**

Run: `npm run format` then re-run `npm run prepublishOnly`. Commit any formatting fix:

```bash
git add -A
git commit -m "$(cat <<'EOF'
style: biome format pass

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Post-plan decisions (not implemented by this plan)

- **CHANGELOG / version bump:** the spec deferred this. A new analyzer is a minor bump (`0.3.2` to `0.4.0`). Decide with the user whether to add a `CHANGELOG.md` entry and bump `package.json` in a final commit.
- **Pending resilience changes:** `src/core/openrouter.ts`, `src/core/api.ts`, and `tests/openrouter.test.ts` carry uncommitted LLM-path resilience work from an earlier session. That is a separate feature; commit it on its own before or after this plan, not bundled into the liveness commits.

---

## Self-Review

**Spec coverage:**
- Monitored set = watched paths only -> `collectContext` iterates `deps.buffer.pathKeys()` (Task 1, Step 5). Covered.
- Single global `stalenessThresholdSec`, default 300, via schema/config -> `LIVENESS_DEFAULT_STALENESS_SEC` in types.ts, clamped in the constructor, schema field in Task 2. Covered.
- Source flapping -> `flapping` field from the distinct source set (Task 1, Step 5), tested. Covered.
- Engine-off handled in the prompt, not code -> `LIVENESS_DEFAULT_SYSTEM_PROMPT` explicitly states propulsion.* silence is expected. Covered.
- State analyzer, default publish path, `state: nominal`, no QuestDB -> no `publishOutput` override on the class; `collectContext` never touches `deps.questdb`. Covered.
- Framework wiring (ids, registry, types, schema, api) -> Tasks 1 and 2. Covered.
- `index.ts` unchanged -> instantiation is the `ANALYZER_IDS` + `ANALYZER_FACTORIES` loop; no step modifies `index.ts`. Covered.
- Tests incl. threshold boundary, empty buffer, flapping, null age -> all present in `tests/liveness.test.ts`; schema presence test in `tests/schema.test.ts`. Covered.

**Placeholder scan:** no TBD/TODO; every code step shows complete code.

**Type consistency:** `LivenessCfg`, `LivenessInput`, `PathLiveness`, `LIVENESS_DEFAULT_STALENESS_SEC`, `LIVENESS_DEFAULT_SYSTEM_PROMPT`, and `LIVENESS_SUPPORTED_EVENTS` are named identically across the module, the registry factory, the schema, and `types.ts`. The factory passes exactly the three `LivenessCfg` fields. `RollingBuffer.slice(path, fromTs, toTs)` and `pathKeys()` match the signatures in `src/core/buffer.ts`.
