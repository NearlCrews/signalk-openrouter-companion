// Walk a Signal K self-path tree node by dotted subpath and return the leaf
// `.value` field. readNumberAt returns the value when it is a finite number;
// readValueAt returns the raw value (any type) so callers can handle string,
// object, or null leaves themselves.

import type { PluginApp } from './app.js';
import { asFiniteNumber, fmtNumber, HOUR_MS } from './format.js';
import { BATTERIES_PARENT_PATH } from './paths.js';

function walk(node: unknown, subpath: string): unknown {
  const segs = subpath.split('.');
  let cur: unknown = node;
  for (const seg of segs) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function readNumberAt(node: unknown, subpath: string): number | null {
  return asFiniteNumber(readValueAt(node, subpath));
}

export function readValueAt(node: unknown, subpath: string): unknown {
  const cur = walk(node, subpath);
  if (cur && typeof cur === 'object' && 'value' in (cur as Record<string, unknown>)) {
    return (cur as { value: unknown }).value;
  }
  return undefined;
}

// How far a delta's timestamp may sit from wall-clock before it is treated as
// a clock fault rather than a legitimate sample. Sensors with a mis-set RTC
// commonly drift hours, so anything past this falls back to wall-clock.
const CLOCK_SKEW_GRACE_MS = HOUR_MS;

// When a delta was sampled, in epoch milliseconds: its own timestamp when that
// parses and sits within the grace of wall-clock, else wall-clock. Date.parse
// returns NaN for a malformed stamp, which would silently break buffer
// eviction and the detector's session arithmetic. A future stamp (mis-set RTC,
// backlog replay) would evict the entire RollingBuffer in one record() and
// freeze the engine watchdog (silentFor goes negative and never trips). A
// far-past stamp (epoch 0 from a sensor with no RTC, or Unix seconds read as
// milliseconds) is as bad the other way: silentFor becomes years, and the next
// tick ends a phantom multi-decade session.
export function deltaTimestampMs(timestamp: string | undefined, wallMs: number): number {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) && Math.abs(parsed - wallMs) <= CLOCK_SKEW_GRACE_MS
    ? parsed
    : wallMs;
}

// Normalize a Signal K subtree fetched via app.getSelfPath into a flat
// Record map. Returns null when the value is missing or not an object, so
// callers can early-return rather than re-doing the typeof guard.
export function asTreeMap(tree: unknown): Record<string, unknown> | null {
  if (!tree || typeof tree !== 'object') return null;
  return tree as Record<string, unknown>;
}

// Canonical numeric fields from electrical.batteries.<bank>. All values are
// SI base units per the SK 1.8.2 spec: V, A, J for capacity, K for
// temperature, ratio 0..1 for stateOfCharge.
export interface BankSnapshot {
  voltage: number | null;
  current: number | null;
  stateOfCharge: number | null;
  nominalCapacityJ: number | null;
  cycles: number | null;
  temperatureK: number | null;
}

export function readBankSnapshot(node: unknown): BankSnapshot {
  return {
    voltage: readNumberAt(node, 'voltage'),
    current: readNumberAt(node, 'current'),
    stateOfCharge: readNumberAt(node, 'capacity.stateOfCharge'),
    nominalCapacityJ: readNumberAt(node, 'capacity.nominal'),
    cycles: readNumberAt(node, 'cycles'),
    temperatureK: readNumberAt(node, 'temperature'),
  };
}

// Canonical fields any real `electrical.batteries.<bank>` subtree exposes. A
// real bank node is an object carrying at least one of these; a leaf with a
// `value`, or a metadata blob (`meta`, `$source`, `timestamp`), is rejected.
const BANK_FIELD_KEYS: ReadonlyArray<string> = ['voltage', 'current', 'capacity', 'temperature'];

export function isBankNode(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if ('value' in (node as object)) return false;
  return BANK_FIELD_KEYS.some((k) => k in (node as object));
}

// Every battery bank under `electrical.batteries`, as [bank id, subtree]
// pairs. Shared by the health and maintenance analyzers, which must reject the
// same non-bank children: a Signal K release that attaches container-level
// metadata leaves (`meta`, `$source`, `value`, `timestamp`) must not inject a
// phantom bank id into either prompt.
export function readBankNodes(
  app: Pick<PluginApp, 'getSelfPath'>,
): Array<[id: string, node: unknown]> {
  const tree = asTreeMap(app.getSelfPath(BATTERIES_PARENT_PATH));
  if (!tree) return [];
  return Object.entries(tree).filter(([, node]) => isBankNode(node));
}

// Rolling-window stats clause shared by the battery prompt summary lines.
// Structural parameter shape: BufferSummary satisfies it without this module
// importing buffer.ts.
function fmtStats(s: { min: number; max: number; mean: number; count: number }): string {
  return `min=${fmtNumber(s.min)} max=${fmtNumber(s.max)} mean=${fmtNumber(s.mean)} count=${fmtNumber(s.count)}`;
}

// The per-bank battery block shared verbatim by the maintenance and health
// prompts: header, the always-present readings, the optional readings, then
// one stats line per labeled summary. The caller supplies the summary labels
// ('voltage (session)' vs 'voltage 24h') and appends any analyzer-specific
// lines after.
export function pushBankLines(
  lines: string[],
  id: string,
  bank: BankSnapshot,
  summaries: ReadonlyArray<{
    label: string;
    summary: { min: number; max: number; mean: number; count: number } | null;
  }>,
): void {
  lines.push(`### Bank: ${id}`);
  lines.push(`- voltage now: ${fmtNumber(bank.voltage)}`);
  lines.push(`- current now: ${fmtNumber(bank.current)}`);
  lines.push(`- state of charge: ${fmtNumber(bank.stateOfCharge)}`);
  if (bank.nominalCapacityJ != null)
    lines.push(`- nominal capacity (J): ${fmtNumber(bank.nominalCapacityJ)}`);
  if (bank.cycles != null) lines.push(`- cycles: ${fmtNumber(bank.cycles)}`);
  if (bank.temperatureK != null) lines.push(`- temperature (K): ${fmtNumber(bank.temperatureK)}`);
  for (const { label, summary } of summaries) {
    if (summary) lines.push(`- ${label}: ${fmtStats(summary)}`);
  }
}
