// Tiny per-event-kind listener bookkeeping shared by BatteryMonitor and
// EngineDetector. Both keep a map of kind -> Set<callback> and a per-event
// fan-out. Centralized so adding a third detector with the same shape does
// not duplicate the on/emit boilerplate.
export class TypedEmitter<K extends string, E extends { kind: K }> {
  private listeners = new Map<K, Set<(e: E) => void>>();

  on(kind: K, cb: (e: E) => void): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    const target = set;
    target.add(cb);
    return () => {
      target.delete(cb);
    };
  }

  protected emit(e: E): void {
    const set = this.listeners.get(e.kind);
    if (!set) return;
    // Isolate listeners: a throwing listener (e.g., the maintenance dispatch
    // that fires on engine-stop) must not skip the state-persist listener for
    // the same event. console.error is the visible-but-cheap surface; the
    // detector tests assert no thrown error from emit().
    for (const cb of set) {
      try {
        cb(e);
      } catch (err) {
        console.error(`emitter listener for ${e.kind}:`, err);
      }
    }
  }
}
