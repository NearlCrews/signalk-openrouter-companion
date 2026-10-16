import { useCallback, useEffect, useRef, useState } from 'react';
import type { PanelAnnounce } from 'signalk-nearlcrews-ui';
import { errText, fetchJson, REPORT_LIMIT } from '../api.js';
import { fireOutcomeText, isFireSuccess } from '../fireOutcome.js';
import type { AnalyzerStatus, AnalyzerUiState } from '../types.js';

// How long after a fire the open reports drawer refreshes, so the new report
// shows up once the LLM returns. A heuristic: a real boat round-trip is 1 to
// 3 seconds.
const REPORT_REFRESH_DELAY_MS = 800;

// What the reports drawer says once its list settles.
function reportsLoadedText(title: string, count: number): string {
  if (count === 0) return `No reports yet for ${title}.`;
  return count === 1 ? `1 report loaded for ${title}.` : `${count} reports loaded for ${title}.`;
}

export interface UseAnalyzerActions {
  analyzerUi: Record<string, AnalyzerUiState>;
  // The latest committed state for one analyzer, for an event handler that must
  // stay stable rather than close over analyzerUi.
  readUi: (id: string) => AnalyzerUiState | undefined;
  patchUi: (id: string, patch: Partial<AnalyzerUiState>) => void;
  setExpanded: (id: string, expanded: boolean) => void;
  fireAnalyzer: (id: string) => Promise<void>;
  toggleReports: (id: string) => void;
  togglePrompt: (id: string) => void;
}

// The per-analyzer UI state and the requests behind each row's buttons: fire,
// the reports drawer, and the prompt drawer. Every per-id mutation funnels
// through patchUi into the one analyzerUi map, and every callback here is
// stable, so the memoized rows keep their props across a status poll.
export function useAnalyzerActions(
  announce: PanelAnnounce,
  analyzers: ReadonlyArray<AnalyzerStatus> | undefined,
): UseAnalyzerActions {
  const [analyzerUi, setAnalyzerUi] = useState<Record<string, AnalyzerUiState>>({});
  // Mirror of analyzerUi for reads from event handlers without going through
  // the state updater. The updater functions must be pure (StrictMode and
  // concurrent rendering may call them more than once), so any side effect
  // (loadReports, loadPrompt, setTimeout) must run outside them. A ref kept in
  // sync via useEffect gives the handlers the latest committed state without
  // re-introducing the stale-closure bug the functional setters were added to
  // fix.
  const analyzerUiRef = useRef(analyzerUi);
  useEffect(() => {
    analyzerUiRef.current = analyzerUi;
  }, [analyzerUi]);
  // Analyzer titles for the announcements, read from a ref for the same reason:
  // the handlers must not close over the status, or every poll that changed the
  // payload would rebuild them and re-render every memoized row.
  const titlesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const titles: Record<string, string> = {};
    for (const analyzer of analyzers ?? []) titles[analyzer.id] = analyzer.title;
    titlesRef.current = titles;
  }, [analyzers]);
  const titleFor = useCallback((id: string): string => titlesRef.current[id] ?? id, []);
  const readUi = useCallback((id: string) => analyzerUiRef.current[id], []);
  // In-flight guard for the two per-analyzer GETs. React 19 StrictMode calls
  // event handlers' state updaters twice in dev; dedup-by-key here prevents
  // double-firing the network request even when the handler runs twice.
  const inFlightRef = useRef<Set<string>>(new Set());
  // Post-fire report refresh timers, one per analyzer so firing a second
  // analyzer cannot cancel the first one's pending refresh. Tracked so every
  // pending timer is cleared on unmount.
  const reportRefreshTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = reportRefreshTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const patchUi = useCallback((id: string, patch: Partial<AnalyzerUiState>): void => {
    setAnalyzerUi((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  }, []);

  // A pure expand/collapse write with no side effect. The section reports the
  // state it is moving to, so nothing has to be re-derived here.
  const setExpanded = useCallback(
    (id: string, expanded: boolean): void => patchUi(id, { expanded }),
    [patchUi],
  );

  // Shared in-flight dedup for the per-analyzer GETs: skip when a request for
  // the same key is already running, and release the key when it settles.
  const withInFlight = useCallback(async (key: string, fn: () => Promise<void>): Promise<void> => {
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    try {
      await fn();
    } finally {
      inFlightRef.current.delete(key);
    }
  }, []);

  const loadReports = useCallback(
    (id: string): Promise<void> =>
      withInFlight(`reports:${id}`, async () => {
        patchUi(id, { reportsLoading: true });
        announce(`Loading reports for ${titleFor(id)}.`);
        const r = await fetchJson<{ reports?: AnalyzerUiState['reports'] }>(
          `/analyzers/${id}/reports?limit=${REPORT_LIMIT}`,
        );
        if (r.ok) {
          const reports = r.body?.reports || [];
          patchUi(id, { reports, reportsLoading: false, reportsError: null });
          announce(reportsLoadedText(titleFor(id), reports.length));
        } else {
          // Keep any previously loaded reports rather than clobbering them with
          // an empty list, which would render a false "No reports yet".
          patchUi(id, { reportsLoading: false, reportsError: errText(r) });
          announce(`Failed to load reports for ${titleFor(id)}: ${errText(r)}`);
        }
      }),
    [withInFlight, patchUi, announce, titleFor],
  );

  const fireAnalyzer = useCallback(
    async (id: string): Promise<void> => {
      patchUi(id, { fire: { pending: true } });
      const r = await fetchJson<{ outcome?: string }>(`/analyzers/${id}/fire`, { method: 'POST' });
      const text = r.ok ? fireOutcomeText(r.body?.outcome) : errText(r);
      patchUi(id, { fire: { ok: r.ok && isFireSuccess(r.body?.outcome), text } });
      // The chip beside the button appears with its text, which a screen reader
      // may never observe. The announcer speaks the same words through a region
      // that already existed, and repeats them when a second run ends the same
      // way rather than reading as an unchanged region.
      announce(`${titleFor(id)}: ${text}.`);
      // Refresh the open drawer so the new report shows up after the LLM
      // returns. Read the live drawer state via the ref: the multi-second fire
      // means the closed-over analyzerUi is stale by the time it resolves.
      if (analyzerUiRef.current[id]?.reportsOpen) {
        const timers = reportRefreshTimersRef.current;
        const pending = timers.get(id);
        if (pending) clearTimeout(pending);
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            void loadReports(id);
          }, REPORT_REFRESH_DELAY_MS),
        );
      }
    },
    [patchUi, loadReports, announce, titleFor],
  );

  const toggleReports = useCallback(
    (id: string): void => {
      const current = analyzerUiRef.current[id];
      const next = !current?.reportsOpen;
      patchUi(id, { reportsOpen: next });
      if (!next) return;
      // A drawer reopened on an already-loaded list still says what is in it,
      // since nothing new arrives to speak for it.
      if (current?.reports) announce(reportsLoadedText(titleFor(id), current.reports.length));
      else void loadReports(id);
    },
    [patchUi, loadReports, announce, titleFor],
  );

  const loadPrompt = useCallback(
    (id: string): Promise<void> =>
      withInFlight(`prompt:${id}`, async () => {
        patchUi(id, { promptLoaded: false, promptError: null });
        announce(`Loading the prompt for ${titleFor(id)}.`);
        const r = await fetchJson<{ default?: string; current?: string | null }>(
          `/analyzers/${id}/prompt`,
        );
        if (r.ok && r.body) {
          patchUi(id, {
            promptDefault: r.body.default,
            promptCurrent: r.body.current,
            promptLoaded: true,
            promptError: null,
          });
          announce(`Prompt loaded for ${titleFor(id)}.`);
        } else {
          patchUi(id, { promptError: errText(r), promptLoaded: true });
          announce(`Failed to load the prompt for ${titleFor(id)}: ${errText(r)}`);
        }
      }),
    [withInFlight, patchUi, announce, titleFor],
  );

  const togglePrompt = useCallback(
    (id: string): void => {
      const current = analyzerUiRef.current[id];
      const next = !current?.promptOpen;
      patchUi(id, { promptOpen: next });
      if (!next) return;
      // Load on first open, and retry on reopen if the previous load failed.
      if (!current?.promptLoaded || current?.promptError) void loadPrompt(id);
      else announce(`Prompt loaded for ${titleFor(id)}.`);
    },
    [patchUi, loadPrompt, announce, titleFor],
  );

  return { analyzerUi, readUi, patchUi, setExpanded, fireAnalyzer, toggleReports, togglePrompt };
}
