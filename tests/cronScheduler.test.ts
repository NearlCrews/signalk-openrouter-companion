import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronScheduler } from '../src/core/cronScheduler.js';

describe('CronScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the callback at the cron pattern', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T07:59:30Z'));
    const cb = vi.fn();
    const scheduler = new CronScheduler({ tz: 'UTC' });
    scheduler.register('0 8 * * *', cb);
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
    scheduler.stopAll();
  });

  it('returns a working unregister function', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T07:59:30Z'));
    const cb = vi.fn();
    const scheduler = new CronScheduler({ tz: 'UTC' });
    const unregister = scheduler.register('0 8 * * *', cb);
    unregister();
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    scheduler.stopAll();
  });

  it('stopAll cancels all registered jobs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T07:59:30Z'));
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const scheduler = new CronScheduler({ tz: 'UTC' });
    scheduler.register('0 8 * * *', cb1);
    scheduler.register('0 8 * * *', cb2);
    scheduler.stopAll();
    vi.advanceTimersByTime(60_000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('rejects an invalid cron pattern by throwing on register', () => {
    const scheduler = new CronScheduler({ tz: 'UTC' });
    expect(() => scheduler.register('not a cron', () => {})).toThrow();
    scheduler.stopAll();
  });

  it('fires the callback at the expected local time in a non-UTC timezone', () => {
    vi.useFakeTimers();
    // 2026-05-10 07:59:30 in Los Angeles is 2026-05-10 14:59:30 UTC (PDT = UTC-7).
    vi.setSystemTime(new Date('2026-05-10T14:59:30Z'));
    const cb = vi.fn();
    const scheduler = new CronScheduler({ tz: 'America/Los_Angeles' });
    scheduler.register('0 8 * * *', cb);
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
    scheduler.stopAll();
  });
});
