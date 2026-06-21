import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Mock, vi } from 'vitest';
import type { Analyzer, AnalyzerDeps } from '../src/analyzers/Analyzer.js';
import type { PluginRuntime } from '../src/core/api.js';
import type { CompleteResult } from '../src/core/openrouter.js';
import { RollingBuffer } from '../src/core/buffer.js';
import { Logger } from '../src/core/logger.js';
import type { ReportPublisher, SignalKNotificationValue } from '../src/core/publisher.js';
import type { QueryResult } from '../src/core/questdb.js';
import { TriggerRouter } from '../src/core/triggerRouter.js';
import { DEFAULT_OPTIONS } from '../src/types.js';

type Listener<T> = (v: T) => void;

export interface MockBus<T> {
  push(v: T): void;
  onValue(cb: Listener<T>): () => void;
  listenerCount(): number;
}

// Module-local: used by makeMockApp and makeRouterDeps below; no test imports
// it directly.
const MOCK_SELF_CONTEXT = 'vessels.urn:mrn:signalk:uuid:00000000-0000-0000-0000-000000000000';

// Module-local: makeMockApp's stream bus factory; no test imports it directly.
function makeBus<T>(): MockBus<T> {
  const subs = new Set<Listener<T>>();
  return {
    push: (v) => {
      for (const s of subs) s(v);
    },
    onValue: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    listenerCount: () => subs.size,
  };
}

export interface PublishedDelta {
  pluginId: string;
  delta: unknown;
  skVersion?: unknown;
}
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
  handleMessage(pluginId: string, delta: unknown, skVersion?: unknown): void;
  registerPutHandler(
    context: string,
    path: string,
    handler: (...args: unknown[]) => unknown,
    source?: string,
  ): void;
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
    selfContext: MOCK_SELF_CONTEXT,
    buses: new Map(),
    streambundle: {
      getSelfBus(path: string) {
        let bus = app.buses.get(path);
        if (!bus) {
          bus = makeBus<unknown>();
          app.buses.set(path, bus);
        }
        return bus;
      },
      getAvailablePaths() {
        return app.availablePaths.slice();
      },
    },
    handleMessage(pluginId, delta, skVersion) {
      app.published.push({ pluginId, delta, skVersion });
    },
    registerPutHandler(context, path, handler, source) {
      app.registeredPuts.push({ context, path, handler, source });
    },
    setPluginStatus(msg) {
      app.statusMessages.push(msg);
    },
    setPluginError(msg) {
      app.errorMessages.push(msg);
    },
    debug(...args) {
      app.debugMessages.push(args);
    },
    error(msg) {
      app.appErrorMessages.push(msg);
    },
    getDataDirPath() {
      return dataDir;
    },
    getSelfPath(path) {
      return app.selfPaths.get(path);
    },
    busFor<T = unknown>(path: string) {
      return app.streambundle.getSelfBus(path) as MockBus<T>;
    },
    setSelfPath(path, value) {
      app.selfPaths.set(path, value);
    },
  };
  return app;
}

// Standard RollingBuffer for analyzer tests: 24h retention, generous cap.
export function makeBuffer(): RollingBuffer {
  return new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
}

export interface MockQuestDB {
  query: (sql: string) => Promise<QueryResult>;
  calls: string[];
}

// Shared QuestDB stub for trend analyzer tests: pass a dispatch closure that
// maps a SQL string to a QueryResult (throw to simulate a failed query).
// Replaces the per-file stubQuestDB factories in aging.test.ts and drift.test.ts.
export function makeQuestDBStub(dispatch: (sql: string) => QueryResult): MockQuestDB {
  const stub: MockQuestDB = {
    calls: [],
    query: async (sql: string) => {
      stub.calls.push(sql);
      return dispatch(sql);
    },
  };
  return stub;
}

// Canonical AnalyzerDeps factory used by every analyzer test. Pass only what
// the test cares about; everything else gets a no-op stub or an `as never` so
// the analyzer code path under test has the deps it touches and nothing more.
export function makeAnalyzerDeps(
  app: MockApp,
  buffer: RollingBuffer,
  opts: { questdb?: MockQuestDB | null; publisher?: ReportPublisher } = {},
): AnalyzerDeps {
  return {
    app: { getSelfPath: (p) => app.getSelfPath(p), selfContext: app.selfContext },
    buffer,
    questdb: (opts.questdb ?? null) as unknown as AnalyzerDeps['questdb'],
    publisher: (opts.publisher ?? ({} as never)) as never,
    budget: {} as never,
    llm: {} as never,
    logger: new Logger({ debug: vi.fn(), error: vi.fn() }),
  };
}

// Build a PluginRuntime literal with sane defaults. Tests override only the
// fields they care about; everything else comes from DEFAULT_OPTIONS and
// zero-cost stubs. Replaces six near-identical literals that had grown
// across tests/api.test.ts.
export interface MakePluginRuntimeOpts {
  apiKeySet?: boolean;
  analyzers?: Analyzer[];
  questdbLive?: PluginRuntime['questdbLive'];
  questdbProbed?: boolean;
  router?: PluginRuntime['router'];
  startedAt?: number;
  llm?: PluginRuntime['llm'];
  budget?: PluginRuntime['budget'];
  signal?: AbortSignal;
  logPath?: string;
  cfg?: {
    openrouter?: Partial<PluginRuntime['cfg']['openrouter']>;
    questdb?: Partial<PluginRuntime['cfg']['questdb']>;
    analyzers?: Partial<PluginRuntime['cfg']['analyzers']>;
  };
}

export function makePluginRuntime(opts: MakePluginRuntimeOpts = {}): PluginRuntime {
  return {
    cfg: {
      openrouter: { ...DEFAULT_OPTIONS.openrouter, ...(opts.cfg?.openrouter ?? {}) },
      questdb: { ...DEFAULT_OPTIONS.questdb, ...(opts.cfg?.questdb ?? {}) },
      analyzers: { ...DEFAULT_OPTIONS.analyzers, ...(opts.cfg?.analyzers ?? {}) },
    },
    llm: (opts.llm ?? ({} as never)) as PluginRuntime['llm'],
    budget: (opts.budget ?? ({ callsToday: () => 0, tokensToday: () => 0, costToday: () => 0 } as never)) as PluginRuntime['budget'],
    questdbLive: opts.questdbLive ?? null,
    questdbProbed: opts.questdbProbed ?? false,
    analyzers: opts.analyzers ?? [],
    apiKeySet: opts.apiKeySet ?? true,
    router: opts.router ?? null,
    logPath: opts.logPath ?? '/tmp/unused.jsonl',
    signal: opts.signal ?? new AbortController().signal,
    startedAt: opts.startedAt ?? 0,
  };
}

// Build an AnalyzerDeps with working spy collaborators (budget, llm,
// publisher, logger) so a test can drive a real TriggerRouter through the
// full canSpend -> recordCall -> complete -> publish dance. Returns the deps
// plus the individual mocks so the test can assert on call args.
// A bare vi.fn() infers as Mock<Procedure | Constructable>, which strict mode
// treats as neither callable nor assignable to a precise (...args) => T. Pin a
// plain callable signature so the spies stay both invokable and assignable to
// the deps function types they stand in for.
type Spy = Mock<(...args: unknown[]) => unknown>;

export interface RouterDepsMocks {
  publishReport: Spy;
  publishFailure: Spy;
  publishOnPath: Spy;
  canSpend: Spy;
  recordCall: Spy;
  recordUsage: Spy;
  complete: Spy;
  setStatus: Spy;
  debug: Spy;
  error: Spy;
  getSelfPath: Spy;
}

export function makeRouterDeps(
  overrides: { okStatus?: string; completeResult?: CompleteResult } = {},
): { deps: AnalyzerDeps; mocks: RouterDepsMocks } {
  const mocks: RouterDepsMocks = {
    publishReport: vi.fn().mockResolvedValue(undefined),
    publishFailure: vi.fn().mockResolvedValue(undefined),
    publishOnPath: vi.fn().mockResolvedValue(undefined),
    canSpend: vi.fn().mockReturnValue(true),
    recordCall: vi.fn().mockResolvedValue(undefined),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(
      overrides.completeResult ?? {
        text: 'ok',
        model: 'stub',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cost: 0 },
      },
    ),
    setStatus: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    getSelfPath: vi.fn(),
  };
  const deps: AnalyzerDeps = {
    app: { getSelfPath: mocks.getSelfPath as never, selfContext: MOCK_SELF_CONTEXT },
    buffer: new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 }),
    questdb: null as unknown as AnalyzerDeps['questdb'],
    publisher: {
      publishReport: mocks.publishReport,
      publishFailure: mocks.publishFailure,
      publishOnPath: mocks.publishOnPath,
    } as unknown as AnalyzerDeps['publisher'],
    budget: {
      canSpend: mocks.canSpend,
      recordCall: mocks.recordCall,
      recordUsage: mocks.recordUsage,
    } as unknown as AnalyzerDeps['budget'],
    llm: { complete: mocks.complete } as unknown as AnalyzerDeps['llm'],
    logger: new Logger({ debug: mocks.debug, error: mocks.error }),
    setStatus: mocks.setStatus,
    okStatus: overrides.okStatus,
  };
  return { deps, mocks };
}

// Build a TriggerRouter wired to working spy collaborators. Common shape for
// tests that exercise the router's dispatch/runById behavior against real
// analyzers but mock the LLM/publish boundary.
export function makeRouter(
  analyzers: Analyzer[],
  overrides: { okStatus?: string; completeResult?: CompleteResult } = {},
): { router: TriggerRouter; mocks: RouterDepsMocks } {
  const { deps, mocks } = makeRouterDeps(overrides);
  return { router: new TriggerRouter(analyzers, deps), mocks };
}

// Pull the first SK notification value out of a published delta. Throws on
// empty deltas so a test that expected a publication never silently passes.
export function firstNotificationValue(
  delta: unknown,
): SignalKNotificationValue & { path: string } {
  const d = delta as {
    updates?: { values?: { path: string; value: SignalKNotificationValue }[] }[];
  };
  const entry = d.updates?.[0]?.values?.[0];
  if (!entry) throw new Error('expected at least one notification value in delta');
  return { ...entry.value, path: entry.path };
}

export async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orc-test-'));
}

export async function cleanupTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
