import type { ActionHandler } from '@signalk/server-api';

// The slice of the Signal K server's plugin API this plugin calls, declared
// once. Structural rather than the full ServerAPI type, so a test harness can
// supply exactly these members; each consumer takes the Pick it needs.
export interface PluginApp {
  streambundle: {
    getSelfBus(path: string): { onValue(cb: (v: unknown) => void): () => void };
    getAvailablePaths(): string[];
  };
  // The server's plugin wrapper forwards only the id and the delta, so a
  // Signal K version argument would never arrive: every delta lands as v1.
  handleMessage(pluginId: string, delta: unknown): void;
  registerPutHandler(context: string, path: string, handler: ActionHandler, source?: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  debug(...args: unknown[]): void;
  error(msg: string): void;
  getDataDirPath(): string;
  getSelfPath(path: string): unknown;
  selfContext?: string;
}
