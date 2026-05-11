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
}
export interface RegisteredPut {
  context: string;
  path: string;
  handler: (...args: unknown[]) => unknown;
  source?: string;
}

export interface RegisteredSubscription {
  msg: unknown;
  errCb: (err: unknown) => void;
  deltaCb: (delta: unknown) => void;
}

export interface MockApp {
  published: PublishedDelta[];
  registeredPuts: RegisteredPut[];
  registeredSubscriptions: RegisteredSubscription[];
  pushSubscriptionDelta(pathFilter: string, delta: unknown): void;
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
    subscribe(
      msg: unknown,
      unsubs: Array<() => void>,
      errCb: (err: unknown) => void,
      deltaCb: (delta: unknown) => void,
    ): void;
  };
  handleMessage(pluginId: string, delta: unknown): void;
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
    registeredSubscriptions: [],
    pushSubscriptionDelta(pathFilter, delta) {
      for (const sub of app.registeredSubscriptions) {
        const msg = sub.msg as { subscribe?: Array<{ path?: string }> } | undefined;
        const subs = msg?.subscribe ?? [];
        if (subs.length === 0 || subs.some((s) => s.path === pathFilter || s.path === '*')) {
          sub.deltaCb(delta);
        }
      }
    },
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
    subscriptionmanager: {
      subscribe(msg, unsubs, errCb, deltaCb) {
        const entry: RegisteredSubscription = { msg, errCb, deltaCb };
        app.registeredSubscriptions.push(entry);
        const removeReg = () => {
          const i = app.registeredSubscriptions.indexOf(entry);
          if (i >= 0) app.registeredSubscriptions.splice(i, 1);
        };
        unsubs.push(removeReg);
        app.unsubscribes.push(removeReg);
      },
    },
    handleMessage(pluginId, delta) {
      app.published.push({ pluginId, delta });
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

export async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orc-test-'));
}

export async function cleanupTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
