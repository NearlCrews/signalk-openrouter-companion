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
