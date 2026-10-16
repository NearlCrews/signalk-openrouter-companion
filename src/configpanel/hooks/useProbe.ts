import { useCallback, useRef, useState } from 'react';

export interface UseProbe<R> {
  pending: boolean;
  result: R | null;
  // Run one probe: the previous outcome clears as it starts, so a stale result
  // never sits beside a running one, and the new outcome replaces it. Resolves
  // to that outcome, or to null once a later run or clear() superseded it, so
  // the caller announces only a result the panel still shows.
  run: (probe: () => Promise<R>) => Promise<R | null>;
  // Drop the shown outcome and any still on its way: a setting edited while a
  // probe runs makes that probe's answer describe settings no longer there.
  clear: () => void;
}

// A request a button starts and whose outcome renders beside that button: the
// API key test and the history connection test. `pending` drives the button's
// busy state. Both callbacks are stable, so a memoized section that receives
// them keeps its props across renders.
export function useProbe<R>(): UseProbe<R> {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<R | null>(null);
  // Bumped by every run and clear, so a probe can tell it was superseded.
  const generation = useRef(0);
  const run = useCallback(async (probe: () => Promise<R>): Promise<R | null> => {
    generation.current += 1;
    const mine = generation.current;
    setPending(true);
    setResult(null);
    try {
      const outcome = await probe();
      if (mine !== generation.current) return null;
      setResult(outcome);
      return outcome;
    } finally {
      if (mine === generation.current) setPending(false);
    }
  }, []);
  const clear = useCallback((): void => {
    generation.current += 1;
    setPending(false);
    setResult(null);
  }, []);
  return { pending, result, run, clear };
}
