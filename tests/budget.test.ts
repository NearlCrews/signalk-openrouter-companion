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
});
