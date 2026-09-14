import { useEffect, useState } from 'react';
import { usePollFreshness } from 'signalk-nearlcrews-ui';
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
  // Epoch milliseconds of the last good snapshot, or null before the first
  // success. RelativeAge owns the clock from there, so nothing here re-renders
  // to advance the age text.
  lastSuccessAt: number | null;
}

// Polls /status on an interval, deep-equality-guarding setStatus so an unchanged
// payload does not re-render, and gates the interval on tab visibility: while
// the tab is hidden the poll is skipped, and it fires immediately when the tab
// becomes visible again. Effect-local cancellation and request sequencing
// suppress writes after unmount and from an older request that resolves late.
//
// The healthy steady state is quiet: an unchanged payload and a repeated
// failure flag both write the value the state already holds, which React bails
// out of, and the freshness clock ticks on the shared interval the whole panel
// already reads.
export function useStatus(): UseStatus {
  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  // The age of the last good snapshot and whether it has passed the threshold
  // come from the shared hook rather than from a clock and a comparison of this
  // panel's own: it is the same rule every reader of a polled value needs, and
  // it catches a fetch that hangs without ever resolving into the failure
  // branch below.
  const freshness = usePollFreshness(lastSuccessAt, {
    staleAfterMs: STALE_AFTER_MS,
    tickMs: POLL_MS,
  });
  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    let activeController: AbortController | null = null;

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
        setLastSuccessAt(Date.now());
        setPollFailed(false);
        setStatus((prev) => (jsonEqual(prev, body) ? prev : body));
        setStatusError(null);
      } else if (r.status === 503) {
        setPollFailed(true);
        setStatus(null);
        setStatusError('Plugin is not running. Set an API key and Save to start it.');
      } else {
        setPollFailed(true);
        setStatusError(`Status fetch failed: ${errText(r)}`);
      }
    };

    // Poll only while the tab is visible: a backgrounded admin tab should not
    // keep hitting the server, and it fires immediately when the tab comes back.
    const tickIfVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
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

  return { status, statusError, stale: pollFailed || freshness.stale, lastSuccessAt };
}
