# signalk-openrouter-companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Signal K plugin defined in `docs/superpowers/specs/2026-05-10-openrouter-companion-design.md`: a modular framework that runs LLM analyzers over live vessel telemetry, with one concrete analyzer (engine maintenance reports) shipped in v0.1.

**Architecture:** Single SK plugin in TypeScript. Small core (rolling buffer, engine-stop detector, trigger router, OpenRouter client, optional QuestDB client, default publisher, budget tracker) plus an `Analyzer` interface. The first analyzer fires on engine-stop and on a Signal K PUT.

**Tech Stack:** TypeScript 6, esbuild, vitest, biome. Runtime deps: only `@signalk/server-api` v2.24.0 (peer). Native fetch for HTTP. ESM, Node 22+.

---

## File Map

```
signalk-openrouter-companion/
├── .gitignore
├── .npmignore
├── biome.json
├── CHANGELOG.md
├── esbuild.config.mjs
├── LICENSE                         # Apache-2.0
├── package.json
├── README.md
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # plugin factory, lifecycle
│   ├── types.ts                    # PluginOptions, shared types
│   ├── schema.ts                   # schema() and uiSchema() builders
│   ├── core/
│   │   ├── logger.ts               # thin wrapper over app.debug/app.error
│   │   ├── buffer.ts               # RollingBuffer
│   │   ├── budget.ts               # BudgetTracker
│   │   ├── engineDetector.ts       # per-engine state machine
│   │   ├── triggerRouter.ts        # dispatch
│   │   ├── openrouter.ts           # OpenRouterClient
│   │   ├── questdb.ts              # QuestDBClient
│   │   ├── publisher.ts            # ReportPublisher
│   │   └── discovery.ts            # path-discovery helpers
│   └── analyzers/
│       ├── Analyzer.ts             # interface + shared types
│       └── maintenance.ts          # MaintenanceAnalyzer
├── tests/
│   ├── _mocks.ts                   # MockServerAPI, fixtures
│   ├── buffer.test.ts
│   ├── budget.test.ts
│   ├── engineDetector.test.ts
│   ├── triggerRouter.test.ts
│   ├── openrouter.test.ts
│   ├── questdb.test.ts
│   ├── publisher.test.ts
│   ├── maintenance.test.ts
│   ├── schema.test.ts
│   ├── plugin.test.ts              # lifecycle
│   └── integration.test.ts         # end-to-end
└── docs/
    └── superpowers/
        ├── specs/2026-05-10-openrouter-companion-design.md
        └── plans/2026-05-10-openrouter-companion.md  (this file)
```

One file = one responsibility. Tests live alongside source by topic, not nested.

---

## Phase 1: Scaffolding

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `biome.json`, `esbuild.config.mjs`, `.gitignore`, `.npmignore`, `LICENSE`, `README.md` (skeleton), `CHANGELOG.md` (skeleton)
- Create: `src/index.ts` (one-line placeholder), `tests/_mocks.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "signalk-openrouter-companion",
  "version": "0.1.0",
  "description": "OpenRouter-powered analyzers for Signal K: engine maintenance reports and more.",
  "main": "dist/index.js",
  "type": "module",
  "files": ["dist/", "README.md", "LICENSE", "CHANGELOG.md"],
  "keywords": [
    "signalk-node-server-plugin",
    "signalk-category-utility",
    "signalk-category-cloud",
    "signalk-category-notifications",
    "openrouter",
    "llm",
    "ai",
    "marine",
    "maintenance"
  ],
  "signalk-plugin-enabled-by-default": false,
  "signalk": { "displayName": "OpenRouter Companion" },
  "engines": { "node": ">=22" },
  "license": "Apache-2.0",
  "author": {
    "name": "Nearl Crews",
    "email": "NearlCrews@users.noreply.github.com",
    "url": "https://github.com/NearlCrews"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/NearlCrews/signalk-openrouter-companion.git"
  },
  "homepage": "https://github.com/NearlCrews/signalk-openrouter-companion#readme",
  "bugs": { "url": "https://github.com/NearlCrews/signalk-openrouter-companion/issues" },
  "peerDependencies": { "@signalk/server-api": ">=2.24.0" },
  "devDependencies": {
    "@biomejs/biome": "^2.4.15",
    "@signalk/server-api": "^2.24.0",
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^4.0.0",
    "esbuild": "^0.28.0",
    "tsx": "^4.21.0",
    "typescript": "^6.0.3",
    "vitest": "^4.0.0"
  },
  "scripts": {
    "build": "npm run clean && npm run build:types && npm run build:bundle",
    "build:types": "tsc --emitDeclarationOnly --declaration --outDir dist",
    "build:bundle": "node esbuild.config.mjs",
    "clean": "rm -rf dist",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "type-check": "tsc --noEmit",
    "lint": "biome check src/ tests/",
    "lint:fix": "biome check --write src/ tests/",
    "format": "biome format --write src/ tests/",
    "prepack": "npm run build",
    "prepublishOnly": "npm run type-check && npm run lint && npm run test && npm run build"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true,
    "allowJs": false,
    "sourceMap": false,
    "isolatedModules": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
```

- [ ] **Step 4: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.15/schema.json",
  "files": { "ignoreUnknown": false },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "warn" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "all",
      "semicolons": "always",
      "arrowParentheses": "always"
    }
  }
}
```

- [ ] **Step 5: Create `esbuild.config.mjs`**

```js
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/index.js',
  external: ['@signalk/server-api'],
  sourcemap: false,
  logLevel: 'info',
});
```

- [ ] **Step 6: Create `.gitignore`**

```
node_modules/
dist/
coverage/
*.tsbuildinfo
.env
.env.local
.DS_Store
```

- [ ] **Step 7: Create `.npmignore`**

```
src/
tests/
docs/
.github/
biome.json
esbuild.config.mjs
tsconfig.json
vitest.config.ts
coverage/
.gitignore
*.tsbuildinfo
```

- [ ] **Step 8: Create `LICENSE`** (Apache-2.0)

Use the full Apache-2.0 license text. Standard boilerplate; the first line is `                                 Apache License` and the copyright line at the bottom is `Copyright 2026 Nearl Crews`.

Run: `curl -s https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE && tail -1 LICENSE`

- [ ] **Step 9: Create `README.md` skeleton**

```markdown
# signalk-openrouter-companion

OpenRouter-powered analyzers for Signal K. Ships with an engine maintenance reporter; designed to be extended.

Status: in development. See `docs/superpowers/specs/` for the design.
```

- [ ] **Step 10: Create `CHANGELOG.md` skeleton**

```markdown
# Changelog

All notable changes will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
```

- [ ] **Step 11: Create `src/index.ts` placeholder**

```ts
export default function createPlugin(_app: unknown) {
  return {
    id: 'signalk-openrouter-companion',
    name: 'OpenRouter Companion',
    schema: () => ({ type: 'object', properties: {} }),
    start: () => {},
    stop: () => {},
  };
}
```

- [ ] **Step 12: Create `tests/_mocks.ts`**

Shared test harness. Every later test imports from here.

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Listener<T> = (v: T) => void;

export interface MockBus<T> {
  push(v: T): void;
  onValue(cb: Listener<T>): () => void;
  listenerCount(): number;
}

export function makeBus<T>(): MockBus<T> {
  const subs = new Set<Listener<T>>();
  return {
    push: (v) => { for (const s of subs) s(v); },
    onValue: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    listenerCount: () => subs.size,
  };
}

export interface PublishedDelta { pluginId: string; delta: unknown; }
export interface RegisteredPut {
  context: string;
  path: string;
  handler: (...args: unknown[]) => unknown;
  source?: string;
}

export interface MockApp {
  published: PublishedDelta[];
  registeredPuts: RegisteredPut[];
  statusMessages: string[];
  errorMessages: string[];
  debugMessages: unknown[];
  appErrorMessages: string[];
  unsubscribes: Array<() => void>;
  availablePaths: string[];
  selfPaths: Map<string, unknown>;
  selfContext: string;
  buses: Map<string, MockBus<unknown>>;
  streambundle: {
    getSelfBus(path: string): MockBus<unknown>;
    getAvailablePaths(): string[];
  };
  subscriptionmanager: {
    subscribe(msg: unknown, unsubs: Array<() => void>, errCb: (err: unknown) => void, deltaCb: (delta: unknown) => void): void;
  };
  handleMessage(pluginId: string, delta: unknown): void;
  registerPutHandler(context: string, path: string, handler: (...args: unknown[]) => unknown, source?: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  debug(...args: unknown[]): void;
  error(msg: string): void;
  getDataDirPath(): string;
  getSelfPath(path: string): unknown;
  busFor<T = unknown>(path: string): MockBus<T>;
  setSelfPath(path: string, value: unknown): void;
}

export function makeMockApp(dataDir: string): MockApp {
  const app: MockApp = {
    published: [],
    registeredPuts: [],
    statusMessages: [],
    errorMessages: [],
    debugMessages: [],
    appErrorMessages: [],
    unsubscribes: [],
    availablePaths: [],
    selfPaths: new Map(),
    selfContext: 'vessels.urn:mrn:signalk:uuid:00000000-0000-0000-0000-000000000000',
    buses: new Map(),
    streambundle: {
      getSelfBus(path: string) {
        let bus = app.buses.get(path);
        if (!bus) { bus = makeBus<unknown>(); app.buses.set(path, bus); }
        return bus;
      },
      getAvailablePaths() { return app.availablePaths.slice(); },
    },
    subscriptionmanager: {
      subscribe(_msg, unsubs, _errCb, _deltaCb) {
        const noop = () => {};
        unsubs.push(noop);
        app.unsubscribes.push(noop);
      },
    },
    handleMessage(pluginId, delta) { app.published.push({ pluginId, delta }); },
    registerPutHandler(context, path, handler, source) {
      app.registeredPuts.push({ context, path, handler, source });
    },
    setPluginStatus(msg) { app.statusMessages.push(msg); },
    setPluginError(msg) { app.errorMessages.push(msg); },
    debug(...args) { app.debugMessages.push(args); },
    error(msg) { app.appErrorMessages.push(msg); },
    getDataDirPath() { return dataDir; },
    getSelfPath(path) { return app.selfPaths.get(path); },
    busFor<T = unknown>(path: string) { return app.streambundle.getSelfBus(path) as MockBus<T>; },
    setSelfPath(path, value) { app.selfPaths.set(path, value); },
  };
  return app;
}

export async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orc-test-'));
}

export async function cleanupTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 13: Install dependencies**

Run: `npm install`
Expected: dependencies resolve, `node_modules/` populated, no errors.

- [ ] **Step 14: Verify type-check and test runner work on the empty project**

Run: `npm run type-check && npm test -- --run`
Expected: `tsc` exits 0; vitest reports 0 tests, 0 failed.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "chore: scaffold project (package.json, tsconfig, vitest, biome, esbuild, mocks)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2: Core utilities

### Task 2: Logger wrapper

**Files:**
- Create: `src/core/logger.ts`
- Test: `tests/logger.test.ts`

The logger normalizes error stringification (the SK API's `app.error` takes a string, and passing an `Error` object produces `[object Object]`).

- [ ] **Step 1: Write the failing test**

`tests/logger.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '../src/core/logger.js';

describe('Logger', () => {
  it('forwards debug args to app.debug', () => {
    const app = { debug: vi.fn(), error: vi.fn() };
    const log = new Logger(app);
    log.debug('hello', 1, { a: 2 });
    expect(app.debug).toHaveBeenCalledWith('hello', 1, { a: 2 });
  });

  it('stringifies Error objects before app.error', () => {
    const app = { debug: vi.fn(), error: vi.fn() };
    const log = new Logger(app);
    log.error(new Error('boom'));
    expect(app.error).toHaveBeenCalledWith('boom');
  });

  it('stringifies non-Error values before app.error', () => {
    const app = { debug: vi.fn(), error: vi.fn() };
    const log = new Logger(app);
    log.error({ weird: true });
    expect(app.error).toHaveBeenCalledWith('[object Object]');
  });

  it('passes strings through to app.error unchanged', () => {
    const app = { debug: vi.fn(), error: vi.fn() };
    const log = new Logger(app);
    log.error('plain message');
    expect(app.error).toHaveBeenCalledWith('plain message');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/logger.test.ts`
Expected: FAIL with `Cannot find module '../src/core/logger.js'`.

- [ ] **Step 3: Implement `src/core/logger.ts`**

```ts
export interface LoggerHost {
  debug(...args: unknown[]): void;
  error(msg: string): void;
}

export function stringify(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

export class Logger {
  constructor(private host: LoggerHost) {}

  debug(...args: unknown[]): void {
    this.host.debug(...args);
  }

  error(err: unknown): void {
    this.host.error(stringify(err));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/logger.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add Logger wrapper with safe error stringification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: RollingBuffer

**Files:**
- Create: `src/core/buffer.ts`
- Test: `tests/buffer.test.ts`

Stores `{value, ts, source}` entries per path, evicts old or excess entries, and produces numeric summaries for time slices.

- [ ] **Step 1: Write the test for `record` + `slice`**

`tests/buffer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RollingBuffer } from '../src/core/buffer.js';

describe('RollingBuffer', () => {
  it('records and slices entries by time range', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 100 });
    buf.record('a.b', 1, 1000, 's1');
    buf.record('a.b', 2, 2000, 's1');
    buf.record('a.b', 3, 3000, 's2');
    expect(buf.slice('a.b', 1500, 2500)).toEqual([
      { value: 2, ts: 2000, source: 's1' },
    ]);
    expect(buf.slice('a.b', 0, 10_000)).toHaveLength(3);
    expect(buf.slice('a.b', 0, 1000)).toHaveLength(1);
    expect(buf.slice('missing', 0, 10_000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/buffer.test.ts`
Expected: FAIL with `Cannot find module '../src/core/buffer.js'`.

- [ ] **Step 3: Implement `record` + `slice`**

`src/core/buffer.ts`:

```ts
export interface BufferEntry {
  value: unknown;
  ts: number;
  source: string;
}

export interface BufferOptions {
  maxAgeMs: number;
  maxEntriesPerPath: number;
}

export class RollingBuffer {
  private store = new Map<string, BufferEntry[]>();

  constructor(private opts: BufferOptions) {}

  record(path: string, value: unknown, ts: number, source: string): void {
    let arr = this.store.get(path);
    if (!arr) {
      arr = [];
      this.store.set(path, arr);
    }
    arr.push({ value, ts, source });
    this.evict(arr, ts);
  }

  slice(path: string, fromTs: number, toTs: number): BufferEntry[] {
    const arr = this.store.get(path);
    if (!arr) return [];
    return arr.filter((e) => e.ts >= fromTs && e.ts <= toTs);
  }

  paths(): IterableIterator<[string, BufferEntry[]]> {
    return this.store.entries();
  }

  private evict(arr: BufferEntry[], now: number): void {
    const cutoff = now - this.opts.maxAgeMs;
    while (arr.length > 0 && arr[0]!.ts < cutoff) arr.shift();
    while (arr.length > this.opts.maxEntriesPerPath) arr.shift();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/buffer.test.ts`
Expected: 1 test passes.

- [ ] **Step 5: Add age-based eviction test**

Append to `tests/buffer.test.ts` inside the `describe`:

```ts
  it('evicts entries older than maxAgeMs', () => {
    const buf = new RollingBuffer({ maxAgeMs: 1000, maxEntriesPerPath: 100 });
    buf.record('a.b', 1, 0, 's1');
    buf.record('a.b', 2, 500, 's1');
    buf.record('a.b', 3, 2000, 's1');
    expect(buf.slice('a.b', 0, 10_000)).toEqual([
      { value: 3, ts: 2000, source: 's1' },
    ]);
  });
```

Run: `npm test -- --run tests/buffer.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Add count-based eviction test**

Append:

```ts
  it('evicts oldest entries when path exceeds maxEntriesPerPath', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 3 });
    buf.record('a.b', 1, 1000, 's1');
    buf.record('a.b', 2, 1100, 's1');
    buf.record('a.b', 3, 1200, 's1');
    buf.record('a.b', 4, 1300, 's1');
    expect(buf.slice('a.b', 0, 10_000).map((e) => e.value)).toEqual([2, 3, 4]);
  });
```

Run: `npm test -- --run tests/buffer.test.ts`
Expected: 3 tests pass.

- [ ] **Step 7: Add `summarize` test**

Append:

```ts
  it('summarizes numeric values in a time range', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 100 });
    buf.record('rpm', 100, 1000, 's1');
    buf.record('rpm', 200, 1500, 's1');
    buf.record('rpm', 300, 2000, 's2');
    const s = buf.summarize('rpm', 0, 10_000);
    expect(s).toEqual({
      min: 100, max: 300, mean: 200, count: 3, sources: ['s1', 's2'],
    });
  });

  it('returns null from summarize when no numeric data in range', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 100 });
    buf.record('s', 'on', 1000, 's1');
    expect(buf.summarize('s', 0, 10_000)).toBeNull();
    expect(buf.summarize('missing', 0, 10_000)).toBeNull();
  });
```

- [ ] **Step 8: Run test to verify summarize fails**

Run: `npm test -- --run tests/buffer.test.ts`
Expected: 2 new tests fail with `summarize is not a function`.

- [ ] **Step 9: Implement `summarize` in `src/core/buffer.ts`**

Add to `RollingBuffer`:

```ts
  summarize(
    path: string,
    fromTs: number,
    toTs: number,
  ): { min: number; max: number; mean: number; count: number; sources: string[] } | null {
    const arr = this.slice(path, fromTs, toTs);
    const sources = new Set<string>();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let count = 0;
    for (const e of arr) {
      sources.add(e.source);
      if (typeof e.value !== 'number' || !Number.isFinite(e.value)) continue;
      if (e.value < min) min = e.value;
      if (e.value > max) max = e.value;
      sum += e.value;
      count += 1;
    }
    if (count === 0) return null;
    return {
      min, max, mean: sum / count, count,
      sources: Array.from(sources).sort(),
    };
  }
```

- [ ] **Step 10: Run tests**

Run: `npm test -- --run tests/buffer.test.ts`
Expected: 5 tests pass.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(core): add RollingBuffer with age and count eviction, summarize

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: BudgetTracker

**Files:**
- Create: `src/core/budget.ts`
- Test: `tests/budget.test.ts`

Per-day call counter persisted to a small JSON file in the plugin's data directory. Resets automatically on UTC day change.

- [ ] **Step 1: Write the test**

`tests/budget.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BudgetTracker } from '../src/core/budget.js';
import { makeTmpDir, cleanupTmpDir } from './_mocks.js';

describe('BudgetTracker', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTmpDir(); });
  afterEach(async () => { await cleanupTmpDir(dir); });

  it('starts with canSpend = true when no state file exists', async () => {
    const path = join(dir, 'budget.json');
    const b = await BudgetTracker.load({ maxPerDay: 3, statePath: path, now: () => new Date('2026-05-10T00:00:00Z') });
    expect(b.canSpend()).toBe(true);
  });

  it('disallows spending after maxPerDay calls in the same UTC day', async () => {
    const path = join(dir, 'budget.json');
    const t0 = new Date('2026-05-10T01:00:00Z');
    const b = await BudgetTracker.load({ maxPerDay: 2, statePath: path, now: () => t0 });
    expect(b.canSpend()).toBe(true);
    await b.recordCall();
    expect(b.canSpend()).toBe(true);
    await b.recordCall();
    expect(b.canSpend()).toBe(false);
  });

  it('persists state across instances', async () => {
    const path = join(dir, 'budget.json');
    const t0 = new Date('2026-05-10T01:00:00Z');
    const b1 = await BudgetTracker.load({ maxPerDay: 5, statePath: path, now: () => t0 });
    await b1.recordCall();
    await b1.recordCall();
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    expect(raw.callsToday).toBe(2);
    const b2 = await BudgetTracker.load({ maxPerDay: 5, statePath: path, now: () => t0 });
    expect(b2.callsToday()).toBe(2);
  });

  it('resets count on UTC day rollover', async () => {
    const path = join(dir, 'budget.json');
    let now = new Date('2026-05-10T23:30:00Z');
    const b = await BudgetTracker.load({ maxPerDay: 2, statePath: path, now: () => now });
    await b.recordCall();
    await b.recordCall();
    expect(b.canSpend()).toBe(false);
    now = new Date('2026-05-11T00:30:00Z');
    expect(b.canSpend()).toBe(true);
    expect(b.callsToday()).toBe(0);
  });

  it('tolerates corrupted state file by resetting', async () => {
    const path = join(dir, 'budget.json');
    await writeFile(path, 'not json');
    const b = await BudgetTracker.load({ maxPerDay: 3, statePath: path, now: () => new Date('2026-05-10T00:00:00Z') });
    expect(b.canSpend()).toBe(true);
    expect(b.callsToday()).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- --run tests/budget.test.ts`
Expected: All 5 fail with module-not-found.

- [ ] **Step 3: Implement `src/core/budget.ts`**

```ts
import { readFile, writeFile } from 'node:fs/promises';

export interface BudgetOptions {
  maxPerDay: number;
  statePath: string;
  now?: () => Date;
}

interface PersistedState {
  day: string;
  callsToday: number;
  lastCallTs: string | null;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class BudgetTracker {
  private constructor(
    private opts: Required<BudgetOptions>,
    private state: PersistedState,
  ) {}

  static async load(opts: BudgetOptions): Promise<BudgetTracker> {
    const fullOpts = { now: () => new Date(), ...opts } as Required<BudgetOptions>;
    let state: PersistedState;
    try {
      const raw = await readFile(fullOpts.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (typeof parsed.day !== 'string' || typeof parsed.callsToday !== 'number') {
        throw new Error('invalid state shape');
      }
      state = parsed;
    } catch {
      state = { day: utcDay(fullOpts.now()), callsToday: 0, lastCallTs: null };
    }
    return new BudgetTracker(fullOpts, state);
  }

  private rolloverIfNeeded(): void {
    const today = utcDay(this.opts.now());
    if (this.state.day !== today) {
      this.state = { day: today, callsToday: 0, lastCallTs: null };
    }
  }

  canSpend(): boolean {
    this.rolloverIfNeeded();
    return this.state.callsToday < this.opts.maxPerDay;
  }

  callsToday(): number {
    this.rolloverIfNeeded();
    return this.state.callsToday;
  }

  async recordCall(): Promise<void> {
    this.rolloverIfNeeded();
    this.state = {
      day: this.state.day,
      callsToday: this.state.callsToday + 1,
      lastCallTs: this.opts.now().toISOString(),
    };
    await writeFile(this.opts.statePath, JSON.stringify(this.state));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run tests/budget.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add BudgetTracker with persistence and day rollover

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: EngineDetector

**Files:**
- Create: `src/core/engineDetector.ts`
- Test: `tests/engineDetector.test.ts`

Per-engine state machine. Aggregates RPM across `$source` labels in a 1-second window. Emits `engine-start`, `engine-stop`, `possible-stop` events.

- [ ] **Step 1: Write the test for clean start + stop**

`tests/engineDetector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EngineDetector, type EngineEvent } from '../src/core/engineDetector.js';

function makeDetector() {
  const events: EngineEvent[] = [];
  const det = new EngineDetector({
    stopRpmHz: 1.0,
    stopSettleSec: 10,
    startRpmHz: 5.0,
    startSettleSec: 5,
    watchdogSec: 30,
    sourceWindowMs: 1000,
  });
  det.on('engine-start', (e) => events.push(e));
  det.on('engine-stop', (e) => events.push(e));
  det.on('possible-stop', (e) => events.push(e));
  return { det, events };
}

describe('EngineDetector', () => {
  it('emits engine-start when RPM sustains above threshold', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_002_000);
    det.observe('port', 's1', 10, 1_004_000);
    expect(events).toEqual([]);
    det.observe('port', 's1', 10, 1_006_000);
    expect(events).toEqual([{ kind: 'engine-start', engineId: 'port', ts: 1_000_000 }]);
  });

  it('emits engine-stop after sustained low RPM, with session metadata', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    expect(events).toHaveLength(1);
    det.observe('port', 's1', 10, 1_010_000);
    det.observe('port', 's1', 0, 2_000_000);
    det.observe('port', 's1', 0, 2_011_000);
    expect(events).toHaveLength(2);
    const stop = events[1]!;
    expect(stop.kind).toBe('engine-stop');
    expect(stop.engineId).toBe('port');
    expect(stop.session?.sessionStart).toBe(1_000_000);
    expect(stop.session?.sessionEnd).toBe(2_000_000);
    expect(stop.session?.durationSec).toBe(1000);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- --run tests/engineDetector.test.ts`
Expected: All fail with module-not-found.

- [ ] **Step 3: Implement `src/core/engineDetector.ts`**

```ts
type EngineEventKind = 'engine-start' | 'engine-stop' | 'possible-stop';

export interface EngineSession {
  sessionStart: number;
  sessionEnd: number;
  durationSec: number;
}

export interface EngineEvent {
  kind: EngineEventKind;
  engineId: string;
  ts: number;
  session?: EngineSession;
}

export interface EngineDetectorOptions {
  stopRpmHz: number;
  stopSettleSec: number;
  startRpmHz: number;
  startSettleSec: number;
  watchdogSec: number;
  sourceWindowMs: number;
}

interface PerSourceReading { hz: number; ts: number; }

interface EngineState {
  engineId: string;
  running: boolean;
  belowSince: number | null;
  aboveSince: number | null;
  sessionStartTs: number | null;
  lastDeltaTs: number;
  recentBySource: Map<string, PerSourceReading>;
}

type Listener = (e: EngineEvent) => void;

export class EngineDetector {
  private states = new Map<string, EngineState>();
  private listeners = new Map<EngineEventKind, Set<Listener>>();

  constructor(private opts: EngineDetectorOptions) {}

  on(kind: EngineEventKind, cb: Listener): () => void {
    let set = this.listeners.get(kind);
    if (!set) { set = new Set(); this.listeners.set(kind, set); }
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(e: EngineEvent): void {
    const set = this.listeners.get(e.kind);
    if (!set) return;
    for (const cb of set) cb(e);
  }

  private getState(engineId: string): EngineState {
    let s = this.states.get(engineId);
    if (!s) {
      s = {
        engineId, running: false,
        belowSince: null, aboveSince: null,
        sessionStartTs: null, lastDeltaTs: 0,
        recentBySource: new Map(),
      };
      this.states.set(engineId, s);
    }
    return s;
  }

  observe(engineId: string, source: string, hz: number, ts: number): void {
    const s = this.getState(engineId);
    s.lastDeltaTs = ts;
    s.recentBySource.set(source, { hz, ts });
    const cutoff = ts - this.opts.sourceWindowMs;
    for (const [src, r] of s.recentBySource) {
      if (r.ts < cutoff) s.recentBySource.delete(src);
    }
    let effectiveHz = Number.NEGATIVE_INFINITY;
    for (const r of s.recentBySource.values()) if (r.hz > effectiveHz) effectiveHz = r.hz;

    if (!s.running) {
      if (effectiveHz >= this.opts.startRpmHz) {
        if (s.aboveSince === null) s.aboveSince = ts;
        if (ts - s.aboveSince >= this.opts.startSettleSec * 1000) {
          s.running = true;
          s.sessionStartTs = s.aboveSince;
          s.belowSince = null;
          this.emit({ kind: 'engine-start', engineId, ts: s.aboveSince });
        }
      } else {
        s.aboveSince = null;
      }
    } else {
      if (effectiveHz < this.opts.stopRpmHz) {
        if (s.belowSince === null) s.belowSince = ts;
        if (ts - s.belowSince >= this.opts.stopSettleSec * 1000) {
          const sessionStart = s.sessionStartTs ?? s.belowSince;
          const sessionEnd = s.belowSince;
          s.running = false;
          s.sessionStartTs = null;
          s.aboveSince = null;
          this.emit({
            kind: 'engine-stop', engineId, ts: sessionEnd,
            session: {
              sessionStart, sessionEnd,
              durationSec: Math.round((sessionEnd - sessionStart) / 1000),
            },
          });
        }
      } else {
        s.belowSince = null;
      }
    }
  }

  tickWatchdog(now: number): void {
    for (const s of this.states.values()) {
      if (s.running && now - s.lastDeltaTs > this.opts.watchdogSec * 1000) {
        this.emit({ kind: 'possible-stop', engineId: s.engineId, ts: now });
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run tests/engineDetector.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Add source-flapping test**

Append:

```ts
  it('aggregates RPM across multiple sources (max within window)', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 12, 1_000_000);
    det.observe('port', 's2', 11, 1_000_500);
    det.observe('port', 's1', 12, 1_001_000);
    det.observe('port', 's2', 0, 1_006_000);
    det.observe('port', 's1', 12, 1_006_500);
    expect(events).toEqual([{ kind: 'engine-start', engineId: 'port', ts: 1_000_000 }]);
  });
```

Run: `npm test -- --run tests/engineDetector.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Add cranking-dip test**

Append:

```ts
  it('does not stop on a momentary RPM dip below threshold', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    expect(events).toHaveLength(1);
    det.observe('port', 's1', 0, 1_010_000);
    det.observe('port', 's1', 10, 1_011_000);
    expect(events).toHaveLength(1);
  });
```

Run: `npm test -- --run tests/engineDetector.test.ts`
Expected: 4 tests pass.

- [ ] **Step 7: Add watchdog test**

Append:

```ts
  it('emits possible-stop on gateway dropout while running', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    events.length = 0;
    det.tickWatchdog(1_007_000);
    expect(events).toHaveLength(0);
    det.tickWatchdog(1_037_000);
    expect(events).toEqual([{ kind: 'possible-stop', engineId: 'port', ts: 1_037_000 }]);
  });
```

Run: `npm test -- --run tests/engineDetector.test.ts`
Expected: 5 tests pass.

- [ ] **Step 8: Add multi-engine independence test**

Append:

```ts
  it('tracks engines independently', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('starboard', 's1', 0, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    expect(events.filter((e) => e.engineId === 'port')).toHaveLength(1);
    expect(events.filter((e) => e.engineId === 'starboard')).toHaveLength(0);
  });
```

Run: `npm test -- --run tests/engineDetector.test.ts`
Expected: 6 tests pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): add EngineDetector with source aggregation and watchdog

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Analyzer interface and TriggerRouter

**Files:**
- Create: `src/analyzers/Analyzer.ts`, `src/core/triggerRouter.ts`
- Create placeholder stubs: `src/core/openrouter.ts`, `src/core/questdb.ts`, `src/core/publisher.ts` (filled in later tasks)
- Test: `tests/triggerRouter.test.ts`

- [ ] **Step 1: Create placeholder modules so the type-only imports resolve**

Create `src/core/questdb.ts`:

```ts
export class QuestDBClient {
  constructor(_cfg: { url: string }) {}
}
```

Create `src/core/publisher.ts`:

```ts
export class ReportPublisher {}
```

Create `src/core/openrouter.ts`:

```ts
export class OpenRouterClient {}
```

These placeholders get filled in later tasks. They exist now to satisfy `Analyzer`'s type-only references.

- [ ] **Step 2: Write `src/analyzers/Analyzer.ts`**

```ts
export type TriggerSpec =
  | { kind: 'engine-start' }
  | { kind: 'engine-stop' }
  | { kind: 'possible-stop' }
  | { kind: 'put'; path: string }
  | { kind: 'cron'; pattern: string }
  | { kind: 'sk-notification'; pathPattern: string };

export type TriggerKind = TriggerSpec['kind'];

export interface EngineSessionCtx {
  engineId: string;
  start: Date;
  end: Date;
  durationSec: number;
}

export interface TriggerCtx {
  kind: TriggerKind;
  firedAt: Date;
  engineSession?: EngineSessionCtx;
  put?: { value: unknown };
  notification?: { path: string; value: unknown };
}

export type AnalysisInput = Record<string, unknown>;

export interface AppForAnalyzer {
  getSelfPath(path: string): unknown;
  selfContext?: string;
}

export interface AnalyzerDeps {
  buffer: import('../core/buffer.js').RollingBuffer;
  questdb: import('../core/questdb.js').QuestDBClient | null;
  publisher: import('../core/publisher.js').ReportPublisher;
  budget: import('../core/budget.js').BudgetTracker;
  llm: import('../core/openrouter.js').OpenRouterClient;
  logger: import('../core/logger.js').Logger;
  app: AppForAnalyzer;
}

export interface Analyzer {
  readonly id: string;
  readonly title: string;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AnalysisInput | null>;
  buildPrompt(input: AnalysisInput): { system: string; user: string };
  publishOutput?(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void>;
}
```

- [ ] **Step 3: Write test for TriggerRouter dispatch**

`tests/triggerRouter.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { TriggerRouter } from '../src/core/triggerRouter.js';
import type { Analyzer, AnalyzerDeps, TriggerCtx } from '../src/analyzers/Analyzer.js';

function makeAnalyzer(overrides: Partial<Analyzer> & Pick<Analyzer, 'id' | 'triggers'>): Analyzer {
  return {
    title: overrides.id,
    collectContext: vi.fn(async () => ({ ok: true })),
    buildPrompt: vi.fn(() => ({ system: 's', user: 'u' })),
    ...overrides,
  } as Analyzer;
}

function makeDeps(): AnalyzerDeps {
  const budget = { canSpend: vi.fn(() => true), recordCall: vi.fn(async () => {}) };
  const llm = {
    complete: vi.fn(async () => ({
      text: 'report', model: 'm',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      raw: {},
    })),
  };
  const publisher = { publish: vi.fn(async () => {}), publishFailure: vi.fn(async () => {}) };
  const logger = { debug: vi.fn(), error: vi.fn() };
  return {
    buffer: {} as never,
    questdb: null,
    publisher: publisher as never,
    budget: budget as never,
    llm: llm as never,
    logger: logger as never,
    app: { getSelfPath: () => undefined },
  };
}

describe('TriggerRouter', () => {
  it('dispatches engine-stop to analyzers subscribed to it', async () => {
    const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'engine-stop' }] });
    const b = makeAnalyzer({ id: 'b', triggers: [{ kind: 'engine-start' }] });
    const deps = makeDeps();
    const router = new TriggerRouter([a, b], deps);
    const ctx: TriggerCtx = { kind: 'engine-stop', firedAt: new Date() };
    await router.dispatch('engine-stop', ctx);
    expect(a.collectContext).toHaveBeenCalled();
    expect(b.collectContext).not.toHaveBeenCalled();
  });

  it('skips LLM call when collectContext returns null', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'engine-stop' }],
      collectContext: vi.fn(async () => null),
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(deps.llm.complete).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  it('skips LLM call when budget is exhausted', async () => {
    const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'engine-stop' }] });
    const deps = makeDeps();
    (deps.budget.canSpend as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const router = new TriggerRouter([a], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(deps.llm.complete).not.toHaveBeenCalled();
  });

  it('isolates per-analyzer failures via Promise.allSettled', async () => {
    const bad = makeAnalyzer({
      id: 'bad',
      triggers: [{ kind: 'engine-stop' }],
      collectContext: vi.fn(async () => { throw new Error('boom'); }),
    });
    const good = makeAnalyzer({ id: 'good', triggers: [{ kind: 'engine-stop' }] });
    const deps = makeDeps();
    const router = new TriggerRouter([bad, good], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(good.collectContext).toHaveBeenCalled();
    expect(deps.publisher.publishFailure).toHaveBeenCalled();
  });

  it('matches put triggers by path', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'put', path: 'plugins.x.run' }],
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch('put', { kind: 'put', firedAt: new Date(), put: { value: 1 } }, { putPath: 'plugins.x.run' });
    expect(a.collectContext).toHaveBeenCalled();
  });

  it('does not match put triggers when path differs', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'put', path: 'plugins.x.run' }],
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch('put', { kind: 'put', firedAt: new Date(), put: { value: 1 } }, { putPath: 'other.path' });
    expect(a.collectContext).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run, expect failure**

Run: `npm test -- --run tests/triggerRouter.test.ts`
Expected: All fail with module-not-found.

- [ ] **Step 5: Implement `src/core/triggerRouter.ts`**

```ts
import type { Analyzer, AnalyzerDeps, TriggerCtx, TriggerKind, TriggerSpec } from '../analyzers/Analyzer.js';
import { stringify } from './logger.js';

export interface DispatchExtras {
  putPath?: string;
}

export class TriggerRouter {
  constructor(private analyzers: Analyzer[], private deps: AnalyzerDeps) {}

  async dispatch(kind: TriggerKind, ctx: TriggerCtx, extras: DispatchExtras = {}): Promise<void> {
    const matches = this.analyzers.filter((a) =>
      a.triggers.some((t) => triggerMatches(t, kind, extras)),
    );
    await Promise.allSettled(matches.map((a) => this.runOne(a, ctx)));
  }

  private async runOne(a: Analyzer, ctx: TriggerCtx): Promise<void> {
    try {
      const input = await a.collectContext(ctx, this.deps);
      if (input == null) return;
      if (!this.deps.budget.canSpend()) {
        this.deps.logger.debug(`${a.id}: budget exhausted, skipping`);
        return;
      }
      const { system, user } = a.buildPrompt(input);
      const { text } = await this.deps.llm.complete({ system, user });
      await this.deps.budget.recordCall();
      const publish = a.publishOutput
        ? a.publishOutput.bind(a)
        : async (t: string, c: TriggerCtx, d: AnalyzerDeps) =>
            d.publisher.publish(t, { analyzerId: a.id, ctx: c });
      await publish(text, ctx, this.deps);
    } catch (err) {
      this.deps.logger.error(`${a.id}: ${stringify(err)}`);
      await this.deps.publisher.publishFailure(a.id, ctx, err).catch(() => {});
    }
  }
}

function triggerMatches(t: TriggerSpec, kind: TriggerKind, extras: DispatchExtras): boolean {
  if (t.kind !== kind) return false;
  if (t.kind === 'put') return t.path === extras.putPath;
  return true;
}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- --run tests/triggerRouter.test.ts`
Expected: 6 tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add Analyzer interface and TriggerRouter dispatch

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3: HTTP clients

### Task 7: OpenRouterClient

**Files:**
- Modify: `src/core/openrouter.ts`
- Test: `tests/openrouter.test.ts`

Replace the placeholder. Real HTTP via native `fetch`. Retry policy per OpenRouter's documented error semantics.

- [ ] **Step 1: Write the happy-path test**

`tests/openrouter.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterClient } from '../src/core/openrouter.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('OpenRouterClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns text and usage on a 200', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'hello world' } }],
        model: 'anthropic/claude-haiku-4.5',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const c = new OpenRouterClient({
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-haiku-4.5',
      requestTimeoutMs: 5000,
      referer: 'https://example.test',
      title: 'test-plugin',
    });
    const r = await c.complete({ system: 'sys', user: 'usr' });
    expect(r.text).toBe('hello world');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBe('https://example.test');
    expect(headers['X-OpenRouter-Title']).toBe('test-plugin');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('anthropic/claude-haiku-4.5');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- --run tests/openrouter.test.ts`
Expected: FAIL with class-not-exported.

- [ ] **Step 3: Replace `src/core/openrouter.ts` with happy-path implementation**

```ts
export interface OpenRouterCfg {
  apiKey: string;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  referer: string;
  title: string;
}

export interface CompleteArgs {
  system: string;
  user: string;
  abortSignal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  raw: unknown;
}

export class OpenRouterError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly metadata?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

interface ApiResponse {
  choices: { message: { content?: string } }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface ApiErrorBody {
  error?: { code?: number; message?: string; metadata?: unknown };
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503]);
const TERMINAL_STATUSES = new Set([400, 401, 402, 403, 408, 413, 422]);

export class OpenRouterClient {
  constructor(private cfg: OpenRouterCfg) {}

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    return this.doCall(args, 0);
  }

  private async doCall(args: CompleteArgs, attempt: number): Promise<CompleteResult> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
    if (args.abortSignal) {
      if (args.abortSignal.aborted) ctrl.abort();
      else args.abortSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    try {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': this.cfg.referer,
          'X-OpenRouter-Title': this.cfg.title,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            { role: 'system', content: args.system },
            { role: 'user', content: args.user },
          ],
        }),
      });

      if (res.status === 200) {
        const body = (await res.json()) as ApiResponse;
        const text = body.choices?.[0]?.message?.content ?? '';
        const u = body.usage ?? {};
        return {
          text,
          model: body.model ?? this.cfg.model,
          usage: {
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            totalTokens: u.total_tokens ?? 0,
          },
          raw: body,
        };
      }

      const errBody = await safeJson(res);
      const message = errBody?.error?.message ?? `HTTP ${res.status}`;
      const metadata = errBody?.error?.metadata;

      if (TERMINAL_STATUSES.has(res.status)) {
        throw new OpenRouterError(res.status, message, metadata, false);
      }
      if (TRANSIENT_STATUSES.has(res.status)) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        if (attempt >= 3) {
          throw new OpenRouterError(res.status, message, metadata, true);
        }
        await delay(backoffMs(attempt, retryAfter));
        return this.doCall(args, attempt + 1);
      }
      throw new OpenRouterError(res.status, message, metadata, false);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function safeJson(res: Response): Promise<ApiErrorBody | null> {
  try { return (await res.json()) as ApiErrorBody; } catch { return null; }
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const sec = Number.parseInt(h, 10);
  return Number.isFinite(sec) ? sec * 1000 : null;
}

function backoffMs(attempt: number, retryAfterMs: number | null): number {
  const base = [500, 1500, 4500][attempt] ?? 4500;
  if (retryAfterMs == null) return base;
  return Math.max(base, retryAfterMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- --run tests/openrouter.test.ts`
Expected: 1 test passes.

- [ ] **Step 5: Add 429-with-Retry-After test**

Append:

```ts
  it('retries on 429 honoring Retry-After', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { code: 429, message: 'rate limit' } }, { 'retry-after': '1' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const c = new OpenRouterClient({
      apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', model: 'm',
      requestTimeoutMs: 5000, referer: 'r', title: 't',
    });
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(1500);
    const r = await p;
    expect(r.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
```

Run: `npm test -- --run tests/openrouter.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Add terminal 401 test**

Append:

```ts
  it('throws immediately on 401', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 401, message: 'bad key' } }),
    );
    const c = new OpenRouterClient({
      apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', model: 'm',
      requestTimeoutMs: 5000, referer: 'r', title: 't',
    });
    await expect(c.complete({ system: 's', user: 'u' })).rejects.toMatchObject({
      name: 'OpenRouterError', status: 401, retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
```

Run: `npm test -- --run tests/openrouter.test.ts`
Expected: 3 tests pass.

- [ ] **Step 7: Add abort-signal test**

Append:

```ts
  it('aborts in-flight request when caller signal aborts', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const c = new OpenRouterClient({
      apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', model: 'm',
      requestTimeoutMs: 60_000, referer: 'r', title: 't',
    });
    const ctrl = new AbortController();
    const p = c.complete({ system: 's', user: 'u', abortSignal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });
```

Run: `npm test -- --run tests/openrouter.test.ts`
Expected: 4 tests pass.

- [ ] **Step 8: Add gives-up-after-3-retries test**

Append:

```ts
  it('gives up after 3 retries on 503', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: { code: 503, message: 'down' } }),
    );
    const c = new OpenRouterClient({
      apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', model: 'm',
      requestTimeoutMs: 60_000, referer: 'r', title: 't',
    });
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).rejects.toMatchObject({ status: 503, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
```

Run: `npm test -- --run tests/openrouter.test.ts`
Expected: 5 tests pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): add OpenRouterClient with retry, abort, typed errors

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: QuestDBClient

**Files:**
- Modify: `src/core/questdb.ts`
- Test: `tests/questdb.test.ts`

REST against the `/exec` endpoint. Probe + query + baseline helper.

- [ ] **Step 1: Write the test**

`tests/questdb.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QuestDBClient } from '../src/core/questdb.js';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

describe('QuestDBClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('probe returns true on 200 with parseable JSON', async () => {
    fetchMock.mockResolvedValueOnce(ok({ dataset: [[1]], columns: [{ name: 'x', type: 'INT' }] }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    expect(await q.probe()).toBe(true);
  });

  it('probe returns false on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    expect(await q.probe()).toBe(false);
  });

  it('query passes through SQL urlencoded and parses response', async () => {
    fetchMock.mockResolvedValueOnce(ok({
      columns: [{ name: 'ts', type: 'TIMESTAMP' }, { name: 'value', type: 'DOUBLE' }],
      dataset: [['2026-05-10T00:00:00Z', 12.5]],
    }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    const r = await q.query("SELECT ts, value FROM signalk WHERE path = 'x'");
    expect(r.columns).toEqual([{ name: 'ts', type: 'TIMESTAMP' }, { name: 'value', type: 'DOUBLE' }]);
    expect(r.dataset).toEqual([['2026-05-10T00:00:00Z', 12.5]]);
    const [url] = fetchMock.mock.calls[0]!;
    expect(typeof url).toBe('string');
    expect(decodeURIComponent((url as string).split('query=')[1]!)).toContain(
      "SELECT ts, value FROM signalk WHERE path = 'x'",
    );
  });

  it('query throws on non-200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    await expect(q.query('SELECT 1')).rejects.toThrow(/HTTP 500/);
  });

  it('baselineFor returns null for empty dataset', async () => {
    fetchMock.mockResolvedValueOnce(ok({ columns: [], dataset: [] }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    const r = await q.baselineFor('propulsion.port.revolutions', 'vessels.self', 30);
    expect(r).toBeNull();
  });

  it('baselineFor returns aggregate stats from a single row', async () => {
    fetchMock.mockResolvedValueOnce(ok({
      columns: [
        { name: 'min', type: 'DOUBLE' },
        { name: 'max', type: 'DOUBLE' },
        { name: 'mean', type: 'DOUBLE' },
        { name: 'p10', type: 'DOUBLE' },
        { name: 'p50', type: 'DOUBLE' },
        { name: 'p90', type: 'DOUBLE' },
      ],
      dataset: [[1, 100, 50, 5, 50, 95]],
    }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    const r = await q.baselineFor('propulsion.port.revolutions', 'vessels.self', 30);
    expect(r).toEqual({ min: 1, max: 100, mean: 50, p10: 5, p50: 50, p90: 95 });
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- --run tests/questdb.test.ts`
Expected: All fail.

- [ ] **Step 3: Replace `src/core/questdb.ts`**

```ts
export interface QuestDBCfg { url: string; }

export interface QueryResult {
  columns: { name: string; type: string }[];
  dataset: unknown[][];
}

export class QuestDBClient {
  constructor(private cfg: QuestDBCfg) {}

  async probe(abortSignal?: AbortSignal): Promise<boolean> {
    try {
      const r = await fetch(`${this.cfg.url}/exec?query=SELECT%201`, { signal: abortSignal });
      if (!r.ok) return false;
      const j = (await r.json()) as Partial<QueryResult>;
      return Array.isArray(j.dataset);
    } catch {
      return false;
    }
  }

  async query(sql: string, abortSignal?: AbortSignal): Promise<QueryResult> {
    const r = await fetch(`${this.cfg.url}/exec?query=${encodeURIComponent(sql)}`, {
      signal: abortSignal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as QueryResult;
    return { columns: body.columns ?? [], dataset: body.dataset ?? [] };
  }

  async baselineFor(
    path: string,
    context: string,
    days: number,
    abortSignal?: AbortSignal,
  ): Promise<{ min: number; max: number; mean: number; p10: number; p50: number; p90: number } | null> {
    const escapedPath = path.replace(/'/g, "''");
    const escapedCtx = context.replace(/'/g, "''");
    const sql = `
      SELECT min(value) AS min, max(value) AS max, avg(value) AS mean,
             approx_percentile(value, 0.10) AS p10,
             approx_percentile(value, 0.50) AS p50,
             approx_percentile(value, 0.90) AS p90
      FROM signalk
      WHERE path = '${escapedPath}'
        AND context = '${escapedCtx}'
        AND ts > dateadd('d', -${days}, now())
    `.trim().replace(/\s+/g, ' ');
    const r = await this.query(sql, abortSignal);
    const row = r.dataset[0];
    if (!row || row.every((v) => v == null)) return null;
    const get = (name: string): number => {
      const idx = r.columns.findIndex((c) => c.name === name);
      const v = idx >= 0 ? row[idx] : null;
      return typeof v === 'number' ? v : Number.NaN;
    };
    const result = {
      min: get('min'), max: get('max'), mean: get('mean'),
      p10: get('p10'), p50: get('p50'), p90: get('p90'),
    };
    if (Object.values(result).some((n) => !Number.isFinite(n))) return null;
    return result;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run tests/questdb.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add QuestDBClient with probe, query, baselineFor

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4: Publisher

### Task 9: ReportPublisher

**Files:**
- Modify: `src/core/publisher.ts`
- Test: `tests/publisher.test.ts`

Emits a notification delta + appends a JSONL log entry. Failure path emits a `warn`-state notification.

- [ ] **Step 1: Write the test**

`tests/publisher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReportPublisher } from '../src/core/publisher.js';
import { makeMockApp, makeTmpDir, cleanupTmpDir, type MockApp } from './_mocks.js';

describe('ReportPublisher', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => { dir = await makeTmpDir(); app = makeMockApp(dir); });
  afterEach(async () => { await cleanupTmpDir(dir); });

  it('publishes a notification delta and writes a JSONL log line', async () => {
    const logPath = join(dir, 'reports.jsonl');
    const p = new ReportPublisher({
      app, pluginId: 'orc',
      notificationPath: 'notifications.x.report',
      notificationState: 'normal',
      logPath,
    });
    await p.publish('the report text', {
      analyzerId: 'maintenance',
      ctx: {
        kind: 'engine-stop',
        firedAt: new Date('2026-05-10T10:00:00Z'),
        engineSession: {
          engineId: 'port',
          start: new Date('2026-05-10T09:00:00Z'),
          end: new Date('2026-05-10T10:00:00Z'),
          durationSec: 3600,
        },
      },
    });
    expect(app.published).toHaveLength(1);
    const { pluginId, delta } = app.published[0]!;
    expect(pluginId).toBe('orc');
    const d = delta as { updates: { values: { path: string; value: { state: string; method: string[]; message: string } }[] }[] };
    expect(d.updates[0]!.values[0]!.path).toBe('notifications.x.report');
    expect(d.updates[0]!.values[0]!.value.state).toBe('normal');
    expect(d.updates[0]!.values[0]!.value.method).toEqual(['visual']);
    expect(d.updates[0]!.values[0]!.value.message).toBe('the report text');

    const line = (await readFile(logPath, 'utf-8')).trim();
    const entry = JSON.parse(line);
    expect(entry.analyzer).toBe('maintenance');
    expect(entry.trigger).toBe('engine-stop');
    expect(entry.engineId).toBe('port');
    expect(entry.durationSec).toBe(3600);
    expect(entry.report).toBe('the report text');
  });

  it('publishFailure emits a warn-state notification', async () => {
    const logPath = join(dir, 'reports.jsonl');
    const p = new ReportPublisher({
      app, pluginId: 'orc',
      notificationPath: 'notifications.x.report',
      notificationState: 'normal',
      logPath,
    });
    await p.publishFailure('maintenance', {
      kind: 'engine-stop', firedAt: new Date(),
    }, new Error('upstream 503'));
    expect(app.published).toHaveLength(1);
    const d = app.published[0]!.delta as { updates: { values: { value: { state: string; message: string } }[] }[] };
    expect(d.updates[0]!.values[0]!.value.state).toBe('warn');
    expect(d.updates[0]!.values[0]!.value.message).toContain('upstream 503');
  });
});
```

- [ ] **Step 2: Run, expect failures**

Run: `npm test -- --run tests/publisher.test.ts`
Expected: All fail.

- [ ] **Step 3: Replace `src/core/publisher.ts`**

```ts
import { appendFile } from 'node:fs/promises';
import type { TriggerCtx } from '../analyzers/Analyzer.js';
import { stringify } from './logger.js';

export type NotificationState = 'normal' | 'nominal' | 'warn';

export interface PublisherCfg {
  app: { handleMessage(pluginId: string, delta: unknown): void };
  pluginId: string;
  notificationPath: string;
  notificationState: NotificationState;
  logPath: string;
}

export interface PublishMeta {
  analyzerId: string;
  ctx: TriggerCtx;
}

interface JsonlEntry {
  ts: string;
  analyzer: string;
  trigger: string;
  engineId?: string;
  sessionStart?: string;
  sessionEnd?: string;
  durationSec?: number;
  report: string;
  failure?: string;
}

export class ReportPublisher {
  constructor(private cfg: PublisherCfg) {}

  async publish(text: string, meta: PublishMeta): Promise<void> {
    const now = new Date();
    this.cfg.app.handleMessage(
      this.cfg.pluginId,
      this.makeDelta(text, this.cfg.notificationState, now, meta),
    );
    await this.appendLog(this.buildEntry(text, meta, now));
  }

  async publishFailure(analyzerId: string, ctx: TriggerCtx, err: unknown): Promise<void> {
    const now = new Date();
    const reason = stringify(err);
    const message = `${analyzerId} report unavailable: ${reason}`;
    this.cfg.app.handleMessage(
      this.cfg.pluginId,
      this.makeDelta(message, 'warn', now, { analyzerId, ctx }),
    );
    await this.appendLog({
      ...this.buildEntry(message, { analyzerId, ctx }, now),
      failure: reason,
    });
  }

  private makeDelta(text: string, state: NotificationState, now: Date, meta: PublishMeta): unknown {
    return {
      updates: [
        {
          timestamp: now.toISOString(),
          values: [
            {
              path: this.cfg.notificationPath,
              value: {
                state,
                method: ['visual'],
                message: text,
                id: `${meta.analyzerId}-${now.getTime()}`,
              },
            },
          ],
        },
      ],
    };
  }

  private buildEntry(text: string, meta: PublishMeta, now: Date): JsonlEntry {
    const entry: JsonlEntry = {
      ts: now.toISOString(),
      analyzer: meta.analyzerId,
      trigger: meta.ctx.kind,
      report: text,
    };
    if (meta.ctx.engineSession) {
      entry.engineId = meta.ctx.engineSession.engineId;
      entry.sessionStart = meta.ctx.engineSession.start.toISOString();
      entry.sessionEnd = meta.ctx.engineSession.end.toISOString();
      entry.durationSec = meta.ctx.engineSession.durationSec;
    }
    return entry;
  }

  private async appendLog(entry: JsonlEntry): Promise<void> {
    await appendFile(this.cfg.logPath, `${JSON.stringify(entry)}\n`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run tests/publisher.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add ReportPublisher with SK notification + JSONL log

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5: Analyzer framework

### Task 10: MaintenanceAnalyzer

**Files:**
- Create: `src/analyzers/maintenance.ts`
- Test: `tests/maintenance.test.ts`

Triggers on engine-stop and on a PUT to `plugins.openrouter-companion.maintenance.run`. Collects session context from the buffer, snapshots engine notifications and batteries, optionally enriches with QuestDB baselines, and produces a structured prompt.

- [ ] **Step 1: Test for "session too short" branch**

`tests/maintenance.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MaintenanceAnalyzer } from '../src/analyzers/maintenance.js';
import { RollingBuffer } from '../src/core/buffer.js';
import { Logger } from '../src/core/logger.js';
import { makeMockApp, makeTmpDir, cleanupTmpDir, type MockApp } from './_mocks.js';
import type { AnalyzerDeps, TriggerCtx } from '../src/analyzers/Analyzer.js';

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

function engineStopCtx(durationSec: number, engineId = 'port'): TriggerCtx {
  const end = new Date('2026-05-10T10:00:00Z');
  const start = new Date(end.getTime() - durationSec * 1000);
  return {
    kind: 'engine-stop',
    firedAt: end,
    engineSession: { engineId, start, end, durationSec },
  };
}

describe('MaintenanceAnalyzer.collectContext', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => { dir = await makeTmpDir(); app = makeMockApp(dir); });
  afterEach(async () => { await cleanupTmpDir(dir); });

  it('returns null when session is shorter than minSessionSeconds', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const a = new MaintenanceAnalyzer({
      minSessionSeconds: 60,
      putTriggerPath: 'plugins.openrouter-companion.maintenance.run',
    });
    const r = await a.collectContext(engineStopCtx(30), makeDeps(app, buf));
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- --run tests/maintenance.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement skeleton `src/analyzers/maintenance.ts`**

```ts
import type {
  Analyzer, AnalyzerDeps, AnalysisInput, TriggerCtx, TriggerSpec,
} from './Analyzer.js';

export interface MaintenanceCfg {
  minSessionSeconds: number;
  putTriggerPath: string;
}

export class MaintenanceAnalyzer implements Analyzer {
  readonly id = 'maintenance';
  readonly title = 'Maintenance Advisor';
  readonly triggers: ReadonlyArray<TriggerSpec>;

  constructor(private cfg: MaintenanceCfg) {
    this.triggers = [
      { kind: 'engine-stop' },
      { kind: 'put', path: cfg.putTriggerPath },
    ];
  }

  async collectContext(ctx: TriggerCtx, _deps: AnalyzerDeps): Promise<AnalysisInput | null> {
    if (ctx.kind === 'engine-stop') {
      const sess = ctx.engineSession;
      if (!sess || sess.durationSec < this.cfg.minSessionSeconds) return null;
    }
    return null;
  }

  buildPrompt(_input: AnalysisInput): { system: string; user: string } {
    return { system: '', user: '' };
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- --run tests/maintenance.test.ts`
Expected: 1 test passes.

- [ ] **Step 5: Add happy-path collectContext test**

Append:

```ts
  it('builds session telemetry summaries from the buffer', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const startMs = new Date('2026-05-10T09:00:00Z').getTime();
    const endMs = new Date('2026-05-10T10:00:00Z').getTime();
    buf.record('propulsion.port.revolutions', 12, startMs + 1000, 'n2k');
    buf.record('propulsion.port.revolutions', 18, startMs + 30_000, 'n2k');
    buf.record('propulsion.port.revolutions', 22, startMs + 60_000, 'n2k');
    buf.record('electrical.batteries.house.voltage', 13.6, endMs - 500, 'bms');

    app.setSelfPath('notifications.propulsion.port', {
      lowOilPressure: { value: { state: 'normal', message: 'OK' } },
      maintenanceNeeded: { value: { state: 'alert', message: 'Service due' } },
    });
    app.setSelfPath('electrical.batteries', {
      house: {
        voltage: { value: 13.6, meta: { units: 'V' } },
        current: { value: 0.5, meta: { units: 'A' } },
        capacity: {
          stateOfCharge: { value: 0.92, meta: { units: 'ratio' } },
          nominal: { value: 5_400_000, meta: { units: 'J' } },
        },
      },
    });

    const a = new MaintenanceAnalyzer({
      minSessionSeconds: 60,
      putTriggerPath: 'plugins.openrouter-companion.maintenance.run',
    });
    const r = await a.collectContext(engineStopCtx(3600), makeDeps(app, buf));
    expect(r).not.toBeNull();
    expect(r!.session).toEqual({
      engineId: 'port',
      start: '2026-05-10T09:00:00.000Z',
      end: '2026-05-10T10:00:00.000Z',
      durationSec: 3600,
    });
    const telemetry = r!.telemetry as Record<string, { min: number; max: number; count: number }>;
    expect(telemetry['propulsion.port.revolutions']).toMatchObject({ min: 12, max: 22, count: 3 });
    expect(r!.engineNotifications).toEqual({
      lowOilPressure: { state: 'normal', message: 'OK' },
      maintenanceNeeded: { state: 'alert', message: 'Service due' },
    });
    expect(r!.batteries).toEqual([
      {
        id: 'house',
        voltage: 13.6,
        current: 0.5,
        stateOfCharge: 0.92,
        nominalCapacityJ: 5_400_000,
      },
    ]);
    expect(r!.baselines).toBeNull();
  });
```

- [ ] **Step 6: Run, expect failure**

Run: `npm test -- --run tests/maintenance.test.ts`
Expected: FAIL.

- [ ] **Step 7: Implement full `collectContext`**

Replace the body of `collectContext` and add the helpers below the class in `src/analyzers/maintenance.ts`:

```ts
  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AnalysisInput | null> {
    let engineId: string;
    let startMs: number;
    let endMs: number;
    if (ctx.kind === 'engine-stop') {
      const sess = ctx.engineSession;
      if (!sess || sess.durationSec < this.cfg.minSessionSeconds) return null;
      engineId = sess.engineId;
      startMs = sess.start.getTime();
      endMs = sess.end.getTime();
    } else if (ctx.kind === 'put') {
      endMs = ctx.firedAt.getTime();
      startMs = endMs - 30 * 60 * 1000;
      engineId = 'unknown';
    } else {
      return null;
    }

    const watchedPaths = listWatchedPaths(deps, engineId);
    const telemetry: Record<string, unknown> = {};
    for (const path of watchedPaths) {
      const s = deps.buffer.summarize(path, startMs, endMs);
      if (s) telemetry[path] = s;
    }
    const engineNotifications = snapshotEngineNotifications(deps, engineId);
    const batteries = snapshotBatteries(deps);
    const baselines = deps.questdb
      ? await fetchBaselines(deps.questdb, watchedPaths, deps.app.selfContext ?? 'vessels.self')
      : null;

    return {
      session: {
        engineId,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        durationSec: Math.round((endMs - startMs) / 1000),
      },
      telemetry,
      engineNotifications,
      batteries,
      baselines,
    };
  }
```

Add at the bottom of the file:

```ts
function listWatchedPaths(deps: AnalyzerDeps, engineId: string): string[] {
  const out = new Set<string>();
  for (const [path] of deps.buffer.paths()) {
    if (path.startsWith(`propulsion.${engineId}.`)) out.add(path);
    else if (path.startsWith('electrical.batteries.')) out.add(path);
    else if (path.startsWith('electrical.alternators.')) out.add(path);
    else if (path.startsWith('electrical.chargers.')) out.add(path);
  }
  return Array.from(out).sort();
}

function snapshotEngineNotifications(deps: AnalyzerDeps, engineId: string): Record<string, unknown> {
  const tree = deps.app.getSelfPath(`notifications.propulsion.${engineId}`);
  if (!tree || typeof tree !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [slot, node] of Object.entries(tree as Record<string, unknown>)) {
    if (node && typeof node === 'object' && 'value' in (node as Record<string, unknown>)) {
      out[slot] = (node as { value: unknown }).value;
    }
  }
  return out;
}

interface BatterySnapshot {
  id: string;
  voltage: number | null;
  current: number | null;
  stateOfCharge: number | null;
  nominalCapacityJ: number | null;
}

function snapshotBatteries(deps: AnalyzerDeps): BatterySnapshot[] {
  const tree = deps.app.getSelfPath('electrical.batteries');
  if (!tree || typeof tree !== 'object') return [];
  const out: BatterySnapshot[] = [];
  for (const [id, node] of Object.entries(tree as Record<string, unknown>)) {
    const get = (subpath: string): number | null => {
      const segs = subpath.split('.');
      let cur: unknown = node;
      for (const seg of segs) {
        if (!cur || typeof cur !== 'object') return null;
        cur = (cur as Record<string, unknown>)[seg];
      }
      if (cur && typeof cur === 'object' && 'value' in (cur as Record<string, unknown>)) {
        const v = (cur as { value: unknown }).value;
        return typeof v === 'number' ? v : null;
      }
      return null;
    };
    out.push({
      id,
      voltage: get('voltage'),
      current: get('current'),
      stateOfCharge: get('capacity.stateOfCharge'),
      nominalCapacityJ: get('capacity.nominal'),
    });
  }
  return out;
}

async function fetchBaselines(
  questdb: NonNullable<AnalyzerDeps['questdb']>,
  paths: string[],
  context: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await Promise.all(
    paths.map(async (p) => {
      try {
        const b = await questdb.baselineFor(p, context, 30);
        if (b) out[p] = b;
      } catch {
        // best-effort
      }
    }),
  );
  return out;
}
```

- [ ] **Step 8: Run tests**

Run: `npm test -- --run tests/maintenance.test.ts`
Expected: 2 tests pass.

- [ ] **Step 9: Add buildPrompt test**

Append:

```ts
describe('MaintenanceAnalyzer.buildPrompt', () => {
  it('produces a stable system + user prompt from a representative input', () => {
    const a = new MaintenanceAnalyzer({
      minSessionSeconds: 60,
      putTriggerPath: 'plugins.openrouter-companion.maintenance.run',
    });
    const out = a.buildPrompt({
      session: { engineId: 'port', start: '2026-05-10T09:00:00.000Z', end: '2026-05-10T10:00:00.000Z', durationSec: 3600 },
      telemetry: {
        'propulsion.port.revolutions': { min: 12, max: 22, mean: 17.3, count: 3, sources: ['n2k'] },
      },
      engineNotifications: {
        lowOilPressure: { state: 'normal', message: 'OK' },
        maintenanceNeeded: { state: 'alert', message: 'Service due' },
      },
      batteries: [{ id: 'house', voltage: 13.6, current: 0.5, stateOfCharge: 0.92, nominalCapacityJ: 5_400_000 }],
      baselines: null,
    });
    expect(out.system).toContain('marine');
    expect(out.system).toContain('engine');
    expect(out.user).toContain('port');
    expect(out.user).toContain('propulsion.port.revolutions');
    expect(out.user).toContain('maintenanceNeeded');
    expect(out.user).toContain('Service due');
    expect(out.user).toContain('house');
  });
});
```

- [ ] **Step 10: Run, expect failure**

Run: `npm test -- --run tests/maintenance.test.ts`
Expected: FAIL on prompt content.

- [ ] **Step 11: Implement `buildPrompt`**

Replace `buildPrompt` body:

```ts
  buildPrompt(input: AnalysisInput): { system: string; user: string } {
    const system = [
      'You are an experienced marine engine technician reading raw telemetry from a Signal K server.',
      'Produce a concise plain-English report of the engine session described in the user content.',
      'Stick to facts present in the data. Do not speculate beyond what the numbers show.',
      'If any engine notification slot is non-normal, surface it prominently.',
      'If 30-day baselines are present, briefly compare this session against them.',
      'Format the response as markdown with a 1-line summary, then short sections for Telemetry, Alarms, Batteries, and (if available) Baselines.',
      'Stay under 350 words.',
    ].join(' ');

    const session = input.session as Record<string, unknown>;
    const telemetry = input.telemetry as Record<string, Record<string, unknown>>;
    const alarms = input.engineNotifications as Record<string, unknown>;
    const batteries = input.batteries as Array<Record<string, unknown>>;
    const baselines = input.baselines as Record<string, unknown> | null;

    const lines: string[] = [];
    lines.push('## Session');
    lines.push(`Engine: ${String(session.engineId)}`);
    lines.push(`Start: ${String(session.start)}`);
    lines.push(`End:   ${String(session.end)}`);
    lines.push(`Duration: ${String(session.durationSec)} s`);
    lines.push('');
    lines.push('## Telemetry');
    for (const [path, s] of Object.entries(telemetry)) {
      lines.push(`- ${path}: min=${fmt(s.min)} max=${fmt(s.max)} mean=${fmt(s.mean)} count=${fmt(s.count)} sources=${JSON.stringify(s.sources)}`);
    }
    lines.push('');
    lines.push('## Engine notification slots');
    for (const [slot, value] of Object.entries(alarms)) {
      lines.push(`- ${slot}: ${JSON.stringify(value)}`);
    }
    lines.push('');
    lines.push('## Batteries (end-of-session snapshot)');
    for (const b of batteries) {
      lines.push(`- ${String(b.id)}: ${JSON.stringify(b)}`);
    }
    if (baselines && Object.keys(baselines).length > 0) {
      lines.push('');
      lines.push('## 30-day baselines');
      for (const [path, stats] of Object.entries(baselines)) {
        lines.push(`- ${path}: ${JSON.stringify(stats)}`);
      }
    }
    return { system, user: lines.join('\n') };
  }
```

Add helper at bottom of file:

```ts
function fmt(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}
```

- [ ] **Step 12: Run tests**

Run: `npm test -- --run tests/maintenance.test.ts`
Expected: 3 tests pass.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(analyzers): add MaintenanceAnalyzer with context collection and prompt builder

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6: Plugin assembly

### Task 11: Schema and types

**Files:**
- Create: `src/types.ts`, `src/schema.ts`
- Test: `tests/schema.test.ts`

- [ ] **Step 1: Create `src/types.ts`**

```ts
export interface PluginOptions {
  openrouter: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxCallsPerDay: number;
    requestTimeoutMs: number;
  };
  questdb: {
    enabled: boolean;
    url: string;
  };
  analyzers: {
    maintenance: {
      enabled: boolean;
      engineStopRpmHzThreshold: number;
      engineStopSettleSeconds: number;
      engineStartRpmHzThreshold: number;
      engineStartSettleSeconds: number;
      minSessionSeconds: number;
      extraWatchedPaths: string[];
    };
  };
  output: {
    notificationPath: string;
    notificationState: 'normal' | 'nominal';
    logFilename: string;
  };
}

export const DEFAULT_OPTIONS: PluginOptions = {
  openrouter: {
    apiKey: '',
    model: 'anthropic/claude-haiku-4.5',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxCallsPerDay: 20,
    requestTimeoutMs: 60_000,
  },
  questdb: { enabled: true, url: 'http://localhost:9000' },
  analyzers: {
    maintenance: {
      enabled: true,
      engineStopRpmHzThreshold: 1.0,
      engineStopSettleSeconds: 10,
      engineStartRpmHzThreshold: 5.0,
      engineStartSettleSeconds: 5,
      minSessionSeconds: 60,
      extraWatchedPaths: [],
    },
  },
  output: {
    notificationPath: 'notifications.openrouter-companion.maintenance.report',
    notificationState: 'normal',
    logFilename: 'reports.jsonl',
  },
};

export function mergeWithDefaults(input: Partial<PluginOptions> | undefined): PluginOptions {
  if (!input) return clone(DEFAULT_OPTIONS);
  return {
    openrouter: { ...DEFAULT_OPTIONS.openrouter, ...(input.openrouter ?? {}) },
    questdb: { ...DEFAULT_OPTIONS.questdb, ...(input.questdb ?? {}) },
    analyzers: {
      maintenance: {
        ...DEFAULT_OPTIONS.analyzers.maintenance,
        ...(input.analyzers?.maintenance ?? {}),
      },
    },
    output: { ...DEFAULT_OPTIONS.output, ...(input.output ?? {}) },
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
```

- [ ] **Step 2: Write `tests/schema.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildSchema, buildUiSchema } from '../src/schema.js';
import { mergeWithDefaults } from '../src/types.js';

describe('schema', () => {
  it('declares apiKey as required string and other defaults', () => {
    const s = buildSchema();
    expect(s.type).toBe('object');
    expect(s.properties.openrouter.required).toContain('apiKey');
    expect(s.properties.openrouter.properties.model.default).toBe('anthropic/claude-haiku-4.5');
    expect(s.properties.openrouter.properties.maxCallsPerDay.default).toBe(20);
    expect(s.properties.questdb.properties.enabled.default).toBe(true);
    expect(s.properties.analyzers.properties.maintenance.properties.engineStopRpmHzThreshold.default).toBe(1.0);
    expect(s.properties.output.properties.notificationState.enum).toEqual(['normal', 'nominal']);
  });

  it('uiSchema marks apiKey as password widget', () => {
    const u = buildUiSchema();
    expect(u.openrouter.apiKey['ui:widget']).toBe('password');
  });
});

describe('mergeWithDefaults', () => {
  it('returns full defaults when input is undefined', () => {
    const r = mergeWithDefaults(undefined);
    expect(r.openrouter.apiKey).toBe('');
    expect(r.analyzers.maintenance.minSessionSeconds).toBe(60);
  });

  it('overrides only provided values', () => {
    const r = mergeWithDefaults({ openrouter: { apiKey: 'sk-x' } as never });
    expect(r.openrouter.apiKey).toBe('sk-x');
    expect(r.openrouter.model).toBe('anthropic/claude-haiku-4.5');
  });
});
```

- [ ] **Step 3: Run, expect fail**

Run: `npm test -- --run tests/schema.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `src/schema.ts`**

```ts
import { DEFAULT_OPTIONS } from './types.js';

export function buildSchema(): {
  type: 'object';
  required: string[];
  properties: {
    openrouter: { type: 'object'; title: string; required: string[]; properties: Record<string, Record<string, unknown>> };
    questdb: { type: 'object'; title: string; properties: Record<string, Record<string, unknown>> };
    analyzers: {
      type: 'object'; title: string;
      properties: { maintenance: { type: 'object'; title: string; properties: Record<string, Record<string, unknown>> } };
    };
    output: { type: 'object'; title: string; properties: Record<string, Record<string, unknown>> };
  };
} {
  return {
    type: 'object',
    required: ['openrouter'],
    properties: {
      openrouter: {
        type: 'object',
        title: 'OpenRouter',
        required: ['apiKey'],
        properties: {
          apiKey: { type: 'string', title: 'API Key', description: 'OpenRouter API key. Required to call the LLM.', default: DEFAULT_OPTIONS.openrouter.apiKey },
          model: { type: 'string', title: 'Model', description: 'OpenRouter model slug.', default: DEFAULT_OPTIONS.openrouter.model },
          baseUrl: { type: 'string', title: 'Base URL', default: DEFAULT_OPTIONS.openrouter.baseUrl },
          maxCallsPerDay: { type: 'integer', title: 'Max calls per day', description: 'Hard cap on OpenRouter calls per UTC day.', default: DEFAULT_OPTIONS.openrouter.maxCallsPerDay, minimum: 0 },
          requestTimeoutMs: { type: 'integer', title: 'Request timeout (ms)', default: DEFAULT_OPTIONS.openrouter.requestTimeoutMs, minimum: 1000 },
        },
      },
      questdb: {
        type: 'object',
        title: 'QuestDB (optional history source)',
        properties: {
          enabled: { type: 'boolean', title: 'Enable QuestDB enrichment', default: DEFAULT_OPTIONS.questdb.enabled },
          url: { type: 'string', title: 'QuestDB REST URL', default: DEFAULT_OPTIONS.questdb.url },
        },
      },
      analyzers: {
        type: 'object',
        title: 'Analyzers',
        properties: {
          maintenance: {
            type: 'object',
            title: 'Maintenance Advisor',
            properties: {
              enabled: { type: 'boolean', default: DEFAULT_OPTIONS.analyzers.maintenance.enabled },
              engineStopRpmHzThreshold: { type: 'number', title: 'Engine-off RPM threshold (Hz, 1.0 = 60 RPM)', default: DEFAULT_OPTIONS.analyzers.maintenance.engineStopRpmHzThreshold },
              engineStopSettleSeconds: { type: 'integer', default: DEFAULT_OPTIONS.analyzers.maintenance.engineStopSettleSeconds },
              engineStartRpmHzThreshold: { type: 'number', title: 'Engine-on RPM threshold (Hz)', default: DEFAULT_OPTIONS.analyzers.maintenance.engineStartRpmHzThreshold },
              engineStartSettleSeconds: { type: 'integer', default: DEFAULT_OPTIONS.analyzers.maintenance.engineStartSettleSeconds },
              minSessionSeconds: { type: 'integer', title: 'Minimum session length (s)', default: DEFAULT_OPTIONS.analyzers.maintenance.minSessionSeconds },
              extraWatchedPaths: {
                type: 'array',
                title: 'Extra paths to include in analysis',
                items: { type: 'string' },
                default: DEFAULT_OPTIONS.analyzers.maintenance.extraWatchedPaths,
              },
            },
          },
        },
      },
      output: {
        type: 'object',
        title: 'Report output',
        properties: {
          notificationPath: { type: 'string', default: DEFAULT_OPTIONS.output.notificationPath },
          notificationState: { type: 'string', enum: ['normal', 'nominal'], default: DEFAULT_OPTIONS.output.notificationState },
          logFilename: { type: 'string', default: DEFAULT_OPTIONS.output.logFilename },
        },
      },
    },
  };
}

export function buildUiSchema(): { openrouter: { apiKey: { 'ui:widget': 'password' } } } {
  return { openrouter: { apiKey: { 'ui:widget': 'password' } } };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --run tests/schema.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(plugin): add PluginOptions types and schema/uiSchema builders

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Plugin lifecycle

**Files:**
- Modify: `src/index.ts`
- Create: `src/core/discovery.ts`
- Test: `tests/plugin.test.ts`

The factory wires every component together.

- [ ] **Step 1: Write the test for the "no API key" branch**

`tests/plugin.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import createPlugin from '../src/index.js';
import { makeMockApp, makeTmpDir, cleanupTmpDir, type MockApp } from './_mocks.js';

describe('plugin lifecycle', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => { dir = await makeTmpDir(); app = makeMockApp(dir); });
  afterEach(async () => { await cleanupTmpDir(dir); });

  it('loads but stays inert when apiKey is missing', () => {
    const plugin = createPlugin(app as never);
    plugin.start({}, () => {});
    expect(app.statusMessages.at(-1)).toMatch(/Awaiting API key/);
    expect(app.registeredPuts).toHaveLength(0);
  });

  it('reports "no engine data detected" when no propulsion paths exist', async () => {
    app.availablePaths = ['environment.water.temperature'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    expect(app.statusMessages.some((m) => m.includes('no engine data detected'))).toBe(true);
  });

  it('subscribes to discovered engine RPM paths and registers PUT handler', () => {
    app.availablePaths = ['propulsion.port.revolutions', 'propulsion.starboard.revolutions'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    expect(app.buses.has('propulsion.port.revolutions')).toBe(true);
    expect(app.buses.has('propulsion.starboard.revolutions')).toBe(true);
    expect(app.registeredPuts.some((r) =>
      r.path === 'plugins.openrouter-companion.maintenance.run' && r.context === 'vessels.self'
    )).toBe(true);
  });

  it('drains subscriptions on stop()', async () => {
    app.availablePaths = ['propulsion.port.revolutions'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    const beforeListeners = app.buses.get('propulsion.port.revolutions')!.listenerCount();
    expect(beforeListeners).toBeGreaterThan(0);
    await plugin.stop();
    expect(app.buses.get('propulsion.port.revolutions')!.listenerCount()).toBe(0);
    expect(app.statusMessages.at(-1)).toBe('Stopped');
  });
});
```

- [ ] **Step 2: Run, expect failures**

Run: `npm test -- --run tests/plugin.test.ts`
Expected: 4 tests fail.

- [ ] **Step 3: Create `src/core/discovery.ts`**

```ts
const ENGINE_RPM_PATTERN = /^propulsion\.([^.]+)\.revolutions$/;

export function discoverEngineIds(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const m = p.match(ENGINE_RPM_PATTERN);
    if (m && m[1]) out.add(m[1]);
  }
  return Array.from(out).sort();
}

const WATCH_PREFIXES = [
  'propulsion.',
  'electrical.batteries.',
  'electrical.alternators.',
  'electrical.chargers.',
];

export function discoverWatchedPaths(paths: string[], extras: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (WATCH_PREFIXES.some((prefix) => p.startsWith(prefix))) out.add(p);
  }
  for (const e of extras) out.add(e);
  return Array.from(out).sort();
}
```

- [ ] **Step 4: Replace `src/index.ts` with the full lifecycle**

```ts
import { join } from 'node:path';
import { mergeWithDefaults, type PluginOptions } from './types.js';
import { buildSchema, buildUiSchema } from './schema.js';
import { Logger, stringify } from './core/logger.js';
import { RollingBuffer } from './core/buffer.js';
import { BudgetTracker } from './core/budget.js';
import { EngineDetector, type EngineEvent } from './core/engineDetector.js';
import { TriggerRouter } from './core/triggerRouter.js';
import { OpenRouterClient } from './core/openrouter.js';
import { QuestDBClient } from './core/questdb.js';
import { ReportPublisher } from './core/publisher.js';
import { discoverEngineIds, discoverWatchedPaths } from './core/discovery.js';
import { MaintenanceAnalyzer } from './analyzers/maintenance.js';
import type { Analyzer, TriggerCtx } from './analyzers/Analyzer.js';

const PLUGIN_ID = 'signalk-openrouter-companion';
const PLUGIN_NAME = 'OpenRouter Companion';
const PUT_PATH_MAINTENANCE = 'plugins.openrouter-companion.maintenance.run';

interface ServerApiLike {
  streambundle: {
    getSelfBus(path: string): { onValue(cb: (v: unknown) => void): () => void };
    getAvailablePaths(): string[];
  };
  subscriptionmanager: {
    subscribe(msg: unknown, unsubs: Array<() => void>, errCb: (err: unknown) => void, deltaCb: (delta: unknown) => void): void;
  };
  handleMessage(pluginId: string, delta: unknown): void;
  registerPutHandler(context: string, path: string, handler: unknown, source?: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  debug(...args: unknown[]): void;
  error(msg: string): void;
  getDataDirPath(): string;
  getSelfPath(path: string): unknown;
  selfContext?: string;
}

export default function createPlugin(app: ServerApiLike): {
  id: string;
  name: string;
  description: string;
  enabledByDefault: boolean;
  schema: () => ReturnType<typeof buildSchema>;
  uiSchema: () => ReturnType<typeof buildUiSchema>;
  start: (settings: Partial<PluginOptions>, restart: () => void) => void;
  stop: () => Promise<void>;
} {
  const logger = new Logger(app);
  const unsubs: Array<() => void> = [];
  let intervalHandles: NodeJS.Timeout[] = [];

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'OpenRouter-powered analyzers for Signal K: maintenance reports and more.',
    enabledByDefault: false,
    schema: () => buildSchema(),
    uiSchema: () => buildUiSchema(),

    start: (rawSettings, _restart) => {
      try {
        app.setPluginStatus('Starting');
        const cfg = mergeWithDefaults(rawSettings);
        if (!cfg.openrouter.apiKey) {
          app.setPluginStatus('Awaiting API key configuration');
          return;
        }

        const dataDir = app.getDataDirPath();
        const logPath = join(dataDir, cfg.output.logFilename);
        const budgetPath = join(dataDir, 'budget.json');

        const buffer = new RollingBuffer({ maxAgeMs: 6 * 3600 * 1000, maxEntriesPerPath: 10_000 });
        const detector = new EngineDetector({
          stopRpmHz: cfg.analyzers.maintenance.engineStopRpmHzThreshold,
          stopSettleSec: cfg.analyzers.maintenance.engineStopSettleSeconds,
          startRpmHz: cfg.analyzers.maintenance.engineStartRpmHzThreshold,
          startSettleSec: cfg.analyzers.maintenance.engineStartSettleSeconds,
          watchdogSec: 30,
          sourceWindowMs: 1000,
        });
        const llm = new OpenRouterClient({
          apiKey: cfg.openrouter.apiKey,
          baseUrl: cfg.openrouter.baseUrl,
          model: cfg.openrouter.model,
          requestTimeoutMs: cfg.openrouter.requestTimeoutMs,
          referer: 'https://github.com/NearlCrews/signalk-openrouter-companion',
          title: PLUGIN_ID,
        });
        let questdbLive: QuestDBClient | null = null;
        if (cfg.questdb.enabled) {
          const candidate = new QuestDBClient({ url: cfg.questdb.url });
          void candidate.probe().then((ok) => {
            questdbLive = ok ? candidate : null;
            if (!ok) logger.debug('QuestDB unreachable; baselines disabled for this run');
          });
        }
        const publisher = new ReportPublisher({
          app,
          pluginId: PLUGIN_ID,
          notificationPath: cfg.output.notificationPath,
          notificationState: cfg.output.notificationState,
          logPath,
        });

        const maintenance = cfg.analyzers.maintenance.enabled
          ? new MaintenanceAnalyzer({
              minSessionSeconds: cfg.analyzers.maintenance.minSessionSeconds,
              putTriggerPath: PUT_PATH_MAINTENANCE,
            })
          : null;
        const analyzers: Analyzer[] = maintenance ? [maintenance] : [];

        let router: TriggerRouter | null = null;
        void BudgetTracker.load({ maxPerDay: cfg.openrouter.maxCallsPerDay, statePath: budgetPath }).then(
          (budget) => {
            router = new TriggerRouter(analyzers, {
              buffer,
              questdb: questdbLive,
              publisher,
              budget,
              llm,
              logger,
              app: { getSelfPath: (p) => app.getSelfPath(p), selfContext: app.selfContext },
            });
          },
        );

        detector.on('engine-stop', (e: EngineEvent) => {
          if (!router) return;
          const sess = e.session;
          if (!sess) return;
          const ctx: TriggerCtx = {
            kind: 'engine-stop',
            firedAt: new Date(sess.sessionEnd),
            engineSession: {
              engineId: e.engineId,
              start: new Date(sess.sessionStart),
              end: new Date(sess.sessionEnd),
              durationSec: sess.durationSec,
            },
          };
          void router.dispatch('engine-stop', ctx);
        });

        const available = app.streambundle.getAvailablePaths();
        const engineIds = discoverEngineIds(available);
        if (engineIds.length === 0) {
          app.setPluginStatus('Running, no engine data detected');
          return;
        }
        const watched = discoverWatchedPaths(available, cfg.analyzers.maintenance.extraWatchedPaths);

        for (const engineId of engineIds) {
          const rpmPath = `propulsion.${engineId}.revolutions`;
          const bus = app.streambundle.getSelfBus(rpmPath);
          const unsub = bus.onValue((delta) => {
            const d = delta as { value?: unknown; timestamp?: string; $source?: string };
            const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
            const src = d.$source ?? 'unknown';
            const v = typeof d.value === 'number' ? d.value : null;
            if (v != null) {
              detector.observe(engineId, src, v, ts);
              buffer.record(rpmPath, v, ts, src);
            }
          });
          if (unsub) unsubs.push(unsub);
        }

        for (const path of watched) {
          if (path.endsWith('.revolutions') && discoverEngineIds([path]).length > 0) continue;
          const bus = app.streambundle.getSelfBus(path);
          const unsub = bus.onValue((delta) => {
            const d = delta as { value?: unknown; timestamp?: string; $source?: string };
            const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
            const src = d.$source ?? 'unknown';
            buffer.record(path, d.value, ts, src);
          });
          if (unsub) unsubs.push(unsub);
        }

        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self',
            subscribe: [{ path: 'notifications.propulsion.*', policy: 'instant' }],
          },
          unsubs,
          (err) => logger.error(stringify(err)),
          () => { /* captured by analyzers via getSelfPath snapshot */ },
        );

        if (maintenance) {
          app.registerPutHandler('vessels.self', PUT_PATH_MAINTENANCE, (
            _context: string,
            _path: string,
            value: unknown,
            cb: (r: { state: string; statusCode?: number; message?: string }) => void,
          ): { state: string } => {
            void (async () => {
              try {
                if (!router) {
                  cb({ state: 'COMPLETED', statusCode: 503, message: 'plugin not fully started' });
                  return;
                }
                const ctx: TriggerCtx = { kind: 'put', firedAt: new Date(), put: { value } };
                await router.dispatch('put', ctx, { putPath: PUT_PATH_MAINTENANCE });
                cb({ state: 'COMPLETED', statusCode: 200 });
              } catch (err) {
                cb({ state: 'COMPLETED', statusCode: 500, message: stringify(err) });
              }
            })();
            return { state: 'PENDING' };
          }, PLUGIN_ID);
        }

        intervalHandles.push(setInterval(() => detector.tickWatchdog(Date.now()), 5000));
        intervalHandles.push(setInterval(() => {
          const fresh = app.streambundle.getAvailablePaths();
          const newEngines = discoverEngineIds(fresh).filter((id) => !engineIds.includes(id));
          for (const id of newEngines) {
            engineIds.push(id);
            const path = `propulsion.${id}.revolutions`;
            const bus = app.streambundle.getSelfBus(path);
            const u = bus.onValue((delta) => {
              const d = delta as { value?: unknown; timestamp?: string; $source?: string };
              const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
              const src = d.$source ?? 'unknown';
              const v = typeof d.value === 'number' ? d.value : null;
              if (v != null) {
                detector.observe(id, src, v, ts);
                buffer.record(path, v, ts, src);
              }
            });
            if (u) unsubs.push(u);
          }
        }, 60_000));

        app.setPluginStatus('Running');
      } catch (err) {
        app.setPluginError(stringify(err));
      }
    },

    stop: async () => {
      while (unsubs.length > 0) {
        try {
          unsubs.pop()?.();
        } catch (err) {
          logger.error(err);
        }
      }
      for (const h of intervalHandles) clearInterval(h);
      intervalHandles = [];
      app.setPluginStatus('Stopped');
    },
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --run tests/plugin.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Type-check**

Run: `npm run type-check`
Expected: exits 0.

- [ ] **Step 8: Lint**

Run: `npm run lint`
Expected: no errors (warnings about `any` are acceptable).

- [ ] **Step 9: Build**

Run: `npm run build`
Expected: `dist/index.js` and `dist/index.d.ts` produced, no errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(plugin): wire lifecycle, subscriptions, PUT handler, rescan, watchdog

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: End-to-end integration test

**Files:**
- Create: `tests/integration.test.ts`

Drive the plugin through a full engine session against the mock SK API + mocked fetch.

- [ ] **Step 1: Write the test**

`tests/integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import createPlugin from '../src/index.js';
import { makeMockApp, makeTmpDir, cleanupTmpDir, type MockApp } from './_mocks.js';

describe('integration: engine session -> report', () => {
  let dir: string;
  let app: MockApp;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanupTmpDir(dir);
  });

  it('produces a notification and JSONL entry after a simulated engine stop', async () => {
    app.availablePaths = ['propulsion.port.revolutions'];
    app.setSelfPath('notifications.propulsion.port', {
      lowOilPressure: { value: { state: 'normal', message: 'OK' } },
    });
    app.setSelfPath('electrical.batteries', {
      house: { voltage: { value: 13.6, meta: { units: 'V' } } },
    });
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('localhost:9000')) {
        return new Response(JSON.stringify({ columns: [], dataset: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Engine session completed without anomalies.' } }],
        model: 'anthropic/claude-haiku-4.5',
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});

    await new Promise((r) => setTimeout(r, 50));

    const bus = app.busFor<{ value: number; timestamp: string; $source: string }>('propulsion.port.revolutions');
    const t0 = Date.now();
    bus.push({ value: 10, timestamp: new Date(t0).toISOString(), $source: 's1' });
    bus.push({ value: 10, timestamp: new Date(t0 + 6000).toISOString(), $source: 's1' });
    bus.push({ value: 10, timestamp: new Date(t0 + 60_000).toISOString(), $source: 's1' });
    bus.push({ value: 0, timestamp: new Date(t0 + 65_000).toISOString(), $source: 's1' });
    bus.push({ value: 0, timestamp: new Date(t0 + 76_000).toISOString(), $source: 's1' });

    await new Promise((r) => setTimeout(r, 100));

    expect(app.published.length).toBeGreaterThan(0);
    const lastDelta = app.published.at(-1)!.delta as { updates: { values: { path: string; value: { message: string; state: string } }[] }[] };
    expect(lastDelta.updates[0]!.values[0]!.path).toBe('notifications.openrouter-companion.maintenance.report');
    expect(lastDelta.updates[0]!.values[0]!.value.state).toBe('normal');
    expect(lastDelta.updates[0]!.values[0]!.value.message).toContain('Engine session');

    const logRaw = await readFile(join(dir, 'reports.jsonl'), 'utf-8');
    const entry = JSON.parse(logRaw.trim().split('\n').at(-1)!);
    expect(entry.analyzer).toBe('maintenance');
    expect(entry.engineId).toBe('port');

    await plugin.stop();
  });
});
```

- [ ] **Step 2: Run**

Run: `npm test -- --run tests/integration.test.ts`
Expected: 1 test passes.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(integration): end-to-end engine-stop -> notification + log

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7: Packaging and CI

### Task 14: README, CHANGELOG

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# signalk-openrouter-companion

OpenRouter-powered analyzers for Signal K. Ships with an engine **maintenance reporter** that generates a plain-English summary after every engine session and publishes it as a Signal K notification. Designed to be extended with more analyzers (voyage logger, alarm translator, anomaly watcher) without touching the core.

## What it does (v0.1)

- Watches your propulsion + electrical telemetry on `vessels.self`.
- Detects when an engine session ends.
- Calls OpenRouter to generate a short report from the session's data plus any active engine alarms and battery state.
- Publishes the report as a Signal K notification (`notifications.openrouter-companion.maintenance.report`).
- Appends each report to a JSONL log under the plugin's data directory.
- Optionally enriches the prompt with 30-day baselines pulled from a co-installed `signalk-questdb` instance.
- Honors a per-day call cap so a misconfigured loop can't burn through credit.

## Install

Via the Signal K app store: search for "OpenRouter Companion" and install.

Or manually:

```bash
cd ~/.signalk
npm install signalk-openrouter-companion
```

Restart the Signal K server, then open the admin UI then Plugin Config then OpenRouter Companion.

## Configure

Required:

- **OpenRouter API key**: get one at <https://openrouter.ai>.

Optional:

- **Model**: defaults to `anthropic/claude-haiku-4.5`. Any OpenRouter-supported chat model works.
- **Max calls per day**: hard cap, default 20.
- **QuestDB URL**: if you run `signalk-questdb`, the plugin will pull 30-day baselines for richer reports. Default `http://localhost:9000`. Leave QuestDB disabled if you don't have it.
- **Engine-off and Engine-on RPM thresholds**: leave at defaults unless your engine idles unusually low or high.

## Where reports appear

- **Signal K notifications**: every report posts a `state: normal` notification on `notifications.openrouter-companion.maintenance.report`. Any SK-aware app surfaces it.
- **Log file**: every report also appends to `<SIGNALK_NODE_CONFIG_DIR>/plugin-config-data/signalk-openrouter-companion/reports.jsonl` (one JSON object per line).

## Trigger a report on demand

PUT to `plugins.openrouter-companion.maintenance.run` on `vessels.self`. Example:

```bash
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/maintenance/run
```

## Troubleshooting

- **"Awaiting API key configuration"**: fill in the OpenRouter API key in the admin UI and save.
- **"Running, no engine data detected"**: the plugin couldn't find any `propulsion.<id>.revolutions` paths. Check that your NMEA2000 gateway or engine source is actually publishing RPM.
- **"Running, budget exhausted for today"**: you hit the per-day cap. Raise it or wait until UTC midnight.
- **Reports not appearing**: check Server Log with `DEBUG=signalk-openrouter-companion`.

## Adding a custom analyzer

Implement the `Analyzer` interface (`src/analyzers/Analyzer.ts`), drop the new file under `src/analyzers/`, register it in `src/index.ts` next to `MaintenanceAnalyzer`. See `src/analyzers/maintenance.ts` for a worked example.

## License

Apache-2.0.
```

- [ ] **Step 2: Write `CHANGELOG.md`**

```markdown
# Changelog

All notable changes will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-05-10

### Added
- Initial release.
- Plugin core: rolling buffer, engine-session detector, trigger router, OpenRouter HTTP client, optional QuestDB enrichment, default publisher (SK notification + JSONL log), per-day budget cap.
- Maintenance analyzer: engine-stop trigger and PUT-on-demand trigger, plain-English session reports with engine alarm snapshot and battery state.
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: README and CHANGELOG for 0.1.0

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: GitHub Actions CI

**Files:**
- Create: `.github/workflows/plugin-ci.yml`, `.github/workflows/test.yml`

- [ ] **Step 1: Add the Signal K plugin-ci reusable workflow**

`.github/workflows/plugin-ci.yml`:

```yaml
name: plugin-ci
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:
jobs:
  validate:
    uses: SignalK/signalk-server/.github/workflows/plugin-ci.yml@master
```

- [ ] **Step 2: Add a local CI workflow**

`.github/workflows/test.yml`:

```yaml
name: test
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm run type-check
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "ci: add plugin-ci and test workflows

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage check, run before declaring the plan done:

- §3 Architecture file tree: Task 1, 2-15 (every file from the tree is created).
- §4 Configuration schema: Tasks 11 (types + schema), 12 (consumed in start()).
- §5 Plugin lifecycle: Task 12.
- §6 Engine session detection: Task 5.
- §7 Analyzer interface: Task 6 (interface), Task 10 (concrete).
- §8 Trigger router: Task 6.
- §9 MaintenanceAnalyzer: Task 10.
- §10 OpenRouterClient: Task 7.
- §11 QuestDBClient: Task 8.
- §12 RollingBuffer: Task 3.
- §13 ReportPublisher: Task 9.
- §14 BudgetTracker: Task 4.
- §15 Logging conventions: Task 2 (logger) + every component using it.
- §16 Packaging: Task 1 (package.json), Task 14 (README/CHANGELOG), Task 15 (CI).
- §17 Error and degraded modes: covered by tests in tasks 4, 6, 7, 12 (no API key / no engine data branches), 9 (publishFailure).
- §18 Testing: every component has a vitest test (Tasks 2-13).

Placeholder scan: no TBD / TODO / "implement later" / "add appropriate error handling" patterns remain.

Type consistency check: `EngineEvent.session` shape matches `EngineSession` (Task 5). `TriggerCtx.engineSession` shape (Date objects) matches what `index.ts` constructs from `EngineEvent.session.sessionStart/End` (number, then `new Date(...)`). `AnalyzerDeps.app.selfContext` is optional in both `Analyzer.ts` and the `MockApp`. `RollingBuffer.paths()` defined in Task 3 (step 3) is referenced by `maintenance.ts` (Task 10). `OpenRouterError` exported by Task 7 is not imported elsewhere (only used inside the client) so no consumers need updating.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-openrouter-companion.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a plan this size: ~15 tasks executed in ~15 isolated agent runs with checkpoints.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
