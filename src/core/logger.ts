import type { PluginApp } from './app.js';

type LoggerHost = Pick<PluginApp, 'debug' | 'error'>;

export function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
