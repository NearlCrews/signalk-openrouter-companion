import { describe, expect, it, vi } from 'vitest';
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
