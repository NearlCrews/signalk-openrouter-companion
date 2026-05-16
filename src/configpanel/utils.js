// Cheap structural equality used to detect a dirty edit buffer and to skip
// redundant status-state updates. Stable enough for the small plain-object
// config and status payloads the panel deals with.
export function jsonEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
