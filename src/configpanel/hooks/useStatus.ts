import { useEffect, useRef, useState } from 'react';
import { errText, fetchJson, POLL_MS } from '../api.js';
import type { PanelStatus } from '../types.js';
import { jsonEqual } from '../utils.js';

// A snapshot older than this reads as stale: the poll has likely stalled
// (server restart, lost connection), so the dim "updated Xs ago" marker shows.
const STALE_AFTER_MS = 10_000;

export interface UseStatus {
  status: PanelStatus | null;
  statusError: string | null;
  // True while polling is stalled: a poll failed, or the last good snapshot has
  // aged past the threshold. Flips back false on the next success.
  stale: boolean;
  // Age (ms) of the last good snapshot, defined only while stale and after at
  // least one success. Stays live because the interval re-renders while stale.
  staleAgeMs: number | undefined;
}

// Polls /status on an interval, deep-equality-guarding setStatus so an unchanged
// payload does not re-render, and gates the interval on tab visibility: while
// the tab is hidden the poll is skipped, and it fires immediately when the tab
// becomes visible again. Effect-local cancellation and request sequencing
// suppress writes after unmount and from an older request that resolves late.
//
// The healthy steady state produces no re-render for an unchanged payload: the
// success timestamp lives in a ref, and each state setter receives its existing
// value. Only while stale does the interval refresh the displayed snapshot age.
export function useStatus(): UseStatus {
  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [staleAgeMs, setStaleAgeMs] = useState<number | undefined>(undefined);
  const lastSuccessRef = useRef<number | null>(null);
  // Mirror of `stale` readable from the interval without re-arming it.
  const staleRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    let activeController: AbortController | null = null;

    const markStale = (value: boolean): void => {
      staleRef.current = value;
      setStale(value);
      const lastSuccess = lastSuccessRef.current;
      setStaleAgeMs(value && lastSuccess !== null ? Date.now() - lastSuccess : undefined);
    };

    const tick = async (): Promise<void> => {
      const request = ++latestRequest;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const r = await fetchJson<PanelStatus>('/status', { signal: controller.signal });
      if (cancelled || request !== latestRequest) return;
      activeController = null;
      if (r.ok && r.body) {
        const body = r.body;
        // Only a successful poll advances the freshness clock, so the staleness
        // marker measures time since the last good snapshot.
        lastSuccessRef.current = Date.now();
        markStale(false);
        setStatus((prev) => (jsonEqual(prev, body) ? prev : body));
        setStatusError(null);
      } else if (r.status === 503) {
        markStale(true);
        setStatus(null);
        setStatusError('Plugin is not running. Set an API key and Save to start it.');
      } else {
        markStale(true);
        setStatusError(`Status fetch failed: ${errText(r)}`);
      }
    };

    // Shared by the interval and the visibilitychange handler: poll only while
    // the tab is visible (a backgrounded admin tab should not keep hitting the
    // server), and detect a stalled poll by the snapshot's age, which catches a
    // fetch that hangs without ever resolving into the failure branch.
    const tickIfVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      const last = lastSuccessRef.current;
      if (last !== null && Date.now() - last > STALE_AFTER_MS) {
        staleRef.current = true;
        setStale(true);
      }
      // While stale the age text must advance even when no other state moves.
      if (staleRef.current) {
        const lastSuccess = lastSuccessRef.current;
        setStaleAgeMs(lastSuccess === null ? undefined : Date.now() - lastSuccess);
      }
      void tick();
    };

    void tick();
    const id = setInterval(tickIfVisible, POLL_MS);
    document.addEventListener('visibilitychange', tickIfVisible);

    return () => {
      cancelled = true;
      latestRequest += 1;
      activeController?.abort();
      clearInterval(id);
      document.removeEventListener('visibilitychange', tickIfVisible);
    };
  }, []);

  return { status, statusError, stale, staleAgeMs };
}
