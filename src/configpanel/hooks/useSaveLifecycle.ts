import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalyzerConfig, PanelConfig, PanelStatus, SavedNotice } from '../types.js';
import { useConfig } from './useConfig.js';

// Phases of the post-save notice: the plugin is restarting, then it is done.
const NOTICE_RESTARTING = 'restarting';
const NOTICE_DONE = 'done';

export interface UseSaveLifecycle {
  // The edit-buffer surface, re-exposed from useConfig so the panel has one
  // hook to consume.
  cfg: PanelConfig;
  dirty: boolean;
  setSection: (patch: Partial<PanelConfig>) => void;
  setAnalyzerCfg: (id: string, patch: Partial<AnalyzerConfig>) => void;
  setSchedule: (id: string, pattern: string) => void;
  // The save lifecycle: the in-flight latch, the two-phase notice and its
  // rendered text, the focus target beside the Save button, and the actions.
  saving: boolean;
  savedNotice: SavedNotice | null;
  noticeText: string;
  savedNoticeRef: RefObject<HTMLSpanElement | null>;
  onSave: () => void;
  onDiscard: () => void;
}

// Owns everything between the Save click and the post-restart confirmation:
// the saving latch and its fallback timer, the restart watch keyed off
// status.startedAt, and the auto-clearing saved notice. Consumes useConfig
// internally and clears the latch on its resync signal, so the panel component
// keeps orchestration and layout only.
export function useSaveLifecycle(
  configuration: PanelConfig | undefined,
  save: (configuration: PanelConfig) => void,
  status: PanelStatus | null,
): UseSaveLifecycle {
  const { cfg, dirty, setSection, setAnalyzerCfg, setSchedule, discard, resyncCount } =
    useConfig(configuration);

  // Latches between Save click and the next host configuration push so a rapid
  // double-click cannot fire two saves before the host resyncs. Cleared on the
  // host's resync (below), by showSaveError, or by the fallback timer.
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<SavedNotice | null>(null);
  // While awaiting a post-save restart, holds { prior: startedAt-at-save-time }.
  // Null when not awaiting one.
  const restartWatchRef = useRef<{ prior: number } | null>(null);
  // Focus target when the Save button self-disables: the always-mounted save
  // notice (a role=status live region), so focus does not drop to <body>.
  const savedNoticeRef = useRef<HTMLSpanElement>(null);
  // The 30s save-latch fallback timer, tracked so it is cleared on unmount.
  const latchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the latch once per genuine host config push. The counter increments
  // only then, so a StrictMode re-run of this effect (same count) is a no-op;
  // the prev ref starts at the mount-time count so mounting never clears.
  const prevResyncRef = useRef(resyncCount);
  useEffect(() => {
    if (resyncCount === prevResyncRef.current) return;
    prevResyncRef.current = resyncCount;
    setSaving(false);
  }, [resyncCount]);

  useEffect(() => {
    return () => {
      if (latchTimerRef.current) clearTimeout(latchTimerRef.current);
    };
  }, []);

  // A save restarts the plugin. The first post-save status poll that reports a
  // startedAt different from the one seen at save time means the restart has
  // finished: flip the notice from "restarting" to "done". Status identity only
  // changes on a real payload change (the poll deep-equality-guards it), so this
  // runs only when there is something new to check.
  useEffect(() => {
    const watch = restartWatchRef.current;
    if (watch && typeof status?.startedAt === 'number' && status.startedAt !== watch.prior) {
      restartWatchRef.current = null;
      setSavedNotice((prev) =>
        prev?.phase === NOTICE_RESTARTING ? { ...prev, phase: NOTICE_DONE } : prev,
      );
    }
  }, [status]);

  // Auto-clear the saved-confirmation notice. A completed restart ("done")
  // clears quickly; one still showing "restarting" clears only on a generous
  // fallback, so a stuck or failed restart does not pin the notice forever.
  useEffect(() => {
    if (!savedNotice) return;
    const handle = setTimeout(
      () => setSavedNotice(null),
      savedNotice.phase === NOTICE_DONE ? 6000 : 30000,
    );
    return () => clearTimeout(handle);
  }, [savedNotice]);

  const showSaveError = useCallback((err: unknown): void => {
    setSaving(false);
    if (latchTimerRef.current) {
      clearTimeout(latchTimerRef.current);
      latchTimerRef.current = null;
    }
    restartWatchRef.current = null;
    setSavedNotice({
      at: new Date().toLocaleTimeString(),
      phase: NOTICE_DONE,
      error: err instanceof Error ? err.message : String(err),
    });
    savedNoticeRef.current?.focus();
  }, []);

  const onSave = (): void => {
    if (saving) return;
    setSaving(true);
    let result: unknown;
    try {
      result = save(cfg);
    } catch (err) {
      // save() threw synchronously (transient client error, validation reject).
      showSaveError(err);
      return;
    }
    // Arm the restart watcher only when a startedAt is known. With status null
    // (plugin not yet running) prior would be undefined and the first poll with
    // any startedAt would falsely flip "restarting" to "restarted"; leave it
    // disarmed and let the auto-clear retire the notice instead.
    restartWatchRef.current =
      typeof status?.startedAt === 'number' ? { prior: status.startedAt } : null;
    setSavedNotice({ at: new Date().toLocaleTimeString(), phase: NOTICE_RESTARTING });
    // Surface a host save that rejects asynchronously instead of relying on the
    // 30s latch to silently lapse.
    Promise.resolve(result).catch(showSaveError);
    // Fallback: if the host never pushes a fresh configuration prop (the only
    // other path that clears `saving`), drop the latch after a generous timeout
    // so the Save button is not pinned forever on a silent failure.
    if (latchTimerRef.current) clearTimeout(latchTimerRef.current);
    latchTimerRef.current = setTimeout(() => setSaving((s) => (s ? false : s)), 30_000);
    // The Save button is about to disable itself; move focus to the notice
    // region so it does not drop to <body> and the result is announced.
    savedNoticeRef.current?.focus();
  };

  const onDiscard = (): void => {
    discard();
    // Discard self-disables once the buffer is clean; keep focus in the save bar.
    savedNoticeRef.current?.focus();
  };

  const noticeText = savedNotice
    ? savedNotice.error
      ? `Save failed at ${savedNotice.at}: ${savedNotice.error}`
      : savedNotice.phase === NOTICE_DONE
        ? `Saved at ${savedNotice.at}. Plugin restarted.`
        : `Saved at ${savedNotice.at}. Plugin restarting...`
    : '';

  return {
    cfg,
    dirty,
    setSection,
    setAnalyzerCfg,
    setSchedule,
    saving,
    savedNotice,
    noticeText,
    savedNoticeRef,
    onSave,
    onDiscard,
  };
}
