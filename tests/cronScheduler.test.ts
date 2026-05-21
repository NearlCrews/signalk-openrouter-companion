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
    const scheduler = new CronScheduler();
    scheduler.register('0 8 * * *', cb, 'UTC');
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
    scheduler.stopAll();
  });

  it('returns a working unregister function', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T07:59:30Z'));
    const cb = vi.fn();
    const scheduler = new CronScheduler();
    const unregister = scheduler.register('0 8 * * *', cb, 'UTC');
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
    const scheduler = new CronScheduler();
    scheduler.register('0 8 * * *', cb1, 'UTC');
    scheduler.register('0 8 * * *', cb2, 'UTC');
    scheduler.stopAll();
    vi.advanceTimersByTime(60_000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('rejects an invalid cron pattern by throwing on register', () => {
    const scheduler = new CronScheduler();
    expect(() => scheduler.register('not a cron', () => {})).toThrow();
    scheduler.stopAll();
  });

  it('fires the callback at the expected local time in a non-UTC timezone', () => {
    vi.useFakeTimers();
    // 2026-05-10 07:59:30 in Los Angeles is 2026-05-10 14:59:30 UTC (PDT = UTC-7).
    vi.setSystemTime(new Date('2026-05-10T14:59:30Z'));
    const cb = vi.fn();
    const scheduler = new CronScheduler();
    scheduler.register('0 8 * * *', cb, 'America/Los_Angeles');
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
    scheduler.stopAll();
  });

  it('honors the per-job timezone independently for each job', () => {
    vi.useFakeTimers();
    // 2026-05-10 14:59:30 UTC is 07:59:30 in Los Angeles. A "0 8 * * *" job in
    // UTC will not fire for hours, but the same pattern in Los Angeles time
    // has 08:00 local imminent, so only the LA-scheduled callback must run.
    vi.setSystemTime(new Date('2026-05-10T14:59:30Z'));
    const onUtc = vi.fn();
    const onLa = vi.fn();
    const scheduler = new CronScheduler();
    scheduler.register('0 8 * * *', onUtc, 'UTC');
    scheduler.register('0 8 * * *', onLa, 'America/Los_Angeles');
    vi.advanceTimersByTime(60_000);
    expect(onUtc).not.toHaveBeenCalled();
    expect(onLa).toHaveBeenCalledTimes(1);
    scheduler.stopAll();
  });
});
