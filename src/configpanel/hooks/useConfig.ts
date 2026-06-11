import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzerConfig, PanelConfig } from '../types.js';
import { jsonEqual } from '../utils.js';

export interface UseConfig {
  cfg: PanelConfig;
  dirty: boolean;
  setSection: (patch: Partial<PanelConfig>) => void;
  setAnalyzerCfg: (id: string, patch: Partial<AnalyzerConfig>) => void;
  setSchedule: (id: string, pattern: string) => void;
  // Revert every edit to the pristine baseline.
  discard: () => void;
  // Increments once per genuine host config push (after the edit buffer and
  // baseline are reset). useSaveLifecycle keys its latch-clearing effect off
  // this counter instead of pristine's identity, which can change for other
  // reasons in the future.
  resyncCount: number;
}

// Owns the edit buffer and its pristine baseline. The setters are stable
// (functional updaters, no captured deps) so the memoized analyzer rows keep
// their referential equality across keystrokes elsewhere in the panel.
export function useConfig(configuration: PanelConfig | undefined): UseConfig {
  const [cfg, setCfg] = useState<PanelConfig>(() => structuredClone(configuration ?? {}));
  const [pristine, setPristine] = useState<PanelConfig>(() => structuredClone(configuration ?? {}));
  const [resyncCount, setResyncCount] = useState(0);

  // Reset the edit buffer and baseline whenever the host pushes a new config.
  // Guarded by a structural compare: the SK admin host can re-render with a
  // fresh-but-equal `configuration` object, and resyncing then would silently
  // discard in-progress unsaved edits. The guard also keeps StrictMode's
  // double-run of this effect from double-incrementing the counter.
  const lastSyncedRef = useRef<PanelConfig>(configuration ?? {});
  useEffect(() => {
    const next = configuration ?? {};
    if (jsonEqual(lastSyncedRef.current, next)) return;
    lastSyncedRef.current = next;
    setCfg(structuredClone(next));
    setPristine(structuredClone(next));
    setResyncCount((n) => n + 1);
  }, [configuration]);

  // Memoized: an unrelated re-render (a status poll) must not rerun the
  // full-tree deep compare; it reruns only when an edit or a host resync
  // actually changes one of the two buffers.
  const dirty = useMemo(() => !jsonEqual(cfg, pristine), [cfg, pristine]);

  const setSection = useCallback((patch: Partial<PanelConfig>): void => {
    setCfg((prev) => ({ ...prev, ...patch }));
  }, []);

  const setAnalyzerCfg = useCallback((id: string, patch: Partial<AnalyzerConfig>): void => {
    setCfg((prev) => ({
      ...prev,
      analyzers: {
        ...(prev.analyzers ?? {}),
        [id]: { ...(prev.analyzers?.[id] ?? {}), ...patch },
      },
    }));
  }, []);

  // Write only triggers.cron.pattern into the edit buffer; the server merges
  // cron.enabled and timezone from defaults. Nested because setAnalyzerCfg
  // merges only at the analyzer level.
  const setSchedule = useCallback((id: string, pattern: string): void => {
    setCfg((prev) => {
      const analyzer = prev.analyzers?.[id] ?? {};
      const triggers = analyzer.triggers ?? {};
      const cron = triggers.cron ?? {};
      return {
        ...prev,
        analyzers: {
          ...(prev.analyzers ?? {}),
          [id]: { ...analyzer, triggers: { ...triggers, cron: { ...cron, pattern } } },
        },
      };
    });
  }, []);

  const discard = useCallback((): void => {
    setCfg(structuredClone(pristine));
  }, [pristine]);

  return { cfg, dirty, setSection, setAnalyzerCfg, setSchedule, discard, resyncCount };
}
