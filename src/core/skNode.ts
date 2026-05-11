/**
 * Walk a Signal K self-path tree node by dotted subpath and return the leaf
 * `value` if it is a finite number, otherwise null.
 *
 * Example: given the `electrical.batteries.house` node, `readNumberAt(node, 'capacity.stateOfCharge')`
 * returns the numeric SoC at `capacity.stateOfCharge.value` or null if absent.
 */
export function readNumberAt(node: unknown, subpath: string): number | null {
  const segs = subpath.split('.');
  let cur: unknown = node;
  for (const seg of segs) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur && typeof cur === 'object' && 'value' in (cur as Record<string, unknown>)) {
    const v = (cur as { value: unknown }).value;
    return typeof v === 'number' ? v : null;
  }
  return null;
}
