import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetTracker } from '../src/core/budget.js';
import { cleanupTmpDir, makeTmpDir } from './_mocks.js';

describe('BudgetTracker', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
  });
  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it('starts with canSpend = true when no state file exists', async () => {
    const path = join(dir, 'budget.json');
    const b = await BudgetTracker.load({
      maxPerDay: 3,
      statePath: path,
      now: () => new Date('2026-05-10T00:00:00Z'),
    });
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
    const b = await BudgetTracker.load({
      maxPerDay: 3,
      statePath: path,
      now: () => new Date('2026-05-10T00:00:00Z'),
    });
    expect(b.canSpend()).toBe(true);
    expect(b.callsToday()).toBe(0);
  });

  it('resets when callsToday is negative or non-integer (hardened load)', async () => {
    // A hand-edited or corrupted file whose callsToday is well-formed JSON but
    // not a non-negative integer must not pass through to the spend-cap
    // comparison. Each bad shape resets to a clean counter.
    const now = () => new Date('2026-05-10T00:00:00Z');
    for (const bad of [
      { day: '2026-05-10', callsToday: -1 },
      { day: '2026-05-10', callsToday: 1.5 },
    ]) {
      const path = join(dir, `budget-${bad.callsToday}.json`);
      await writeFile(path, JSON.stringify(bad));
      const b = await BudgetTracker.load({ maxPerDay: 3, statePath: path, now });
      expect(b.callsToday()).toBe(0);
      expect(b.canSpend()).toBe(true);
    }
  });

  it('logs and does not throw when the state write fails', async () => {
    const messages: string[] = [];
    // statePath under a non-existent subdirectory: load reads ENOENT (the clean
    // first-run path, which logs nothing), then recordCall's write rejects with
    // ENOENT too. That write failure must be logged and swallowed, never thrown,
    // and the in-memory counter must still increment.
    const path = join(dir, 'missing-subdir', 'budget.json');
    const b = await BudgetTracker.load({
      maxPerDay: 3,
      statePath: path,
      now: () => new Date('2026-05-10T00:00:00Z'),
      log: (m) => messages.push(m),
    });
    await expect(b.recordCall()).resolves.toBeUndefined();
    expect(messages.some((m) => m.includes('budget state write failed'))).toBe(true);
    expect(b.callsToday()).toBe(1);
  });
});
