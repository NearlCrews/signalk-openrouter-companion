// Walk a Signal K self-path tree node by dotted subpath and return the leaf
// `.value` field. readNumberAt returns the value when it is a finite number;
// readValueAt returns the raw value (any type) so callers can handle string,
// object, or null leaves themselves.

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
  const v = readValueAt(node, subpath);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function readValueAt(node: unknown, subpath: string): unknown {
  const cur = walk(node, subpath);
  if (cur && typeof cur === 'object' && 'value' in (cur as Record<string, unknown>)) {
    return (cur as { value: unknown }).value;
  }
  return undefined;
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
