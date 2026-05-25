// Structural equality used to detect a dirty edit buffer and to skip
// redundant status-state updates. Order-insensitive on object keys: the panel
// edit buffer and the saved JSON can be structurally equal but key-ordered
// differently, which a naive JSON.stringify compare would flag as dirty.
export function jsonEqual(a, b) {
  return deepEqual(a ?? null, b ?? null);
}

function deepEqual(a, b) {
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
  // Filter out explicit-undefined values to match JSON.stringify semantics:
  // onPromptReset writes { customSystemPrompt: undefined } into cfg, which
  // would otherwise show as a key that pristine (deserialized JSON, which
  // drops undefined) does not have. Treating the two as equal preserves the
  // dirty-flag behavior callers had before the stable-key compare.
  const ak = Object.keys(a).filter((k) => a[k] !== undefined);
  const bk = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (b[k] === undefined) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}
