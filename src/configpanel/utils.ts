// Structural equality used to detect a dirty edit buffer and to skip
// redundant status-state updates. Order-insensitive on object keys: the panel
// edit buffer and the saved JSON can be structurally equal but key-ordered
// differently, which a naive JSON.stringify compare would flag as dirty.
export function jsonEqual(a: unknown, b: unknown): boolean {
  return deepEqual(a ?? null, b ?? null);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  // Ignore explicit-undefined values to match JSON.stringify semantics:
  // onPromptReset writes { customSystemPrompt: undefined } into cfg, which
  // would otherwise show as a key that pristine (deserialized JSON, which
  // drops undefined) does not have. This runs on every keystroke (dirty memo)
  // and every status poll, so iterate the keys directly instead of building
  // filtered key arrays; matching defined-key counts plus a per-key match
  // proves the defined-key sets are equal.
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  let aDefined = 0;
  for (const k in ao) {
    if (!Object.hasOwn(ao, k) || ao[k] === undefined) continue;
    aDefined += 1;
    if (bo[k] === undefined) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  let bDefined = 0;
  for (const k in bo) {
    if (Object.hasOwn(bo, k) && bo[k] !== undefined) bDefined += 1;
  }
  return aDefined === bDefined;
}

// Bound n to [min, max]. Shared by NumberInput's commit step so a clamped,
// truncated integer is the only value that reaches the config.
export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
