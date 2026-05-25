interface LoggerHost {
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
