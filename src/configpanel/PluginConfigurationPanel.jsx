import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errText, fetchJson, POLL_MS, REPORT_LIMIT } from './api.js';
import { AnalyzerRow, DEFAULT_SEVERITY_FLOOR } from './components/AnalyzerRow.jsx';
import { CollapsibleSection } from './components/CollapsibleSection.jsx';
import { OpenRouterSection } from './components/OpenRouterSection.jsx';
import { QuestDBSection } from './components/QuestDBSection.jsx';
import { StatusBlock } from './components/StatusBlock.jsx';
import { btn, btnClass, PANEL_CLASS, PANEL_CSS, S } from './styles.js';
import { jsonEqual } from './utils.js';

// Phases of the post-save notice: the plugin is restarting, then it is done.
const NOTICE_RESTARTING = 'restarting';
const NOTICE_DONE = 'done';

// Maps the /fire endpoint's run outcome to the message shown beside the button,
// so a no-op fire reads as "Nothing to report" rather than a misleading success.
// `unknown` covers the runById path where the analyzer id is not registered;
// the REST /fire endpoint pre-guards with 409, but the panel covers it too so
// any future code path that bypasses the pre-guard reads correctly here.
const FIRE_OUTCOME_TEXT = {
  reported: 'Report generated',
  'no-input': 'Nothing to report',
  'budget-exhausted': 'Daily call budget exhausted',
  failed: 'Analysis failed (check notifications)',
  unknown: 'Analyzer not registered',
};

// Inject the scoped focus/hover stylesheet once. It carries the interactive
// states (focus rings, button hover) that inline styles cannot express.
function useScopedStyles() {
  useEffect(() => {
    const id = 'orc-config-panel-styles';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = PANEL_CSS;
    document.head.appendChild(el);
  }, []);
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [cfg, setCfg] = useState(() => structuredClone(configuration ?? {}));
  const [pristine, setPristine] = useState(() => structuredClone(configuration ?? {}));
  const [savedNotice, setSavedNotice] = useState(null);
  // Latches between Save click and the next host configuration push so a
  // rapid double-click cannot fire two saves before the host resyncs.
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsState, setModelsState] = useState('idle');
  const [qdbTest, setQdbTest] = useState(null);
  const [qdbTesting, setQdbTesting] = useState(false);
  const [analyzerUi, setAnalyzerUi] = useState({});
  // Mirror of analyzerUi for reads from event handlers without going through
  // the state updater. The updater functions must be pure (StrictMode and
  // concurrent rendering may call them more than once), so any side effect
  // (loadReports, loadPrompt, setTimeout) must run outside them. A ref kept
  // in sync via useEffect gives the handlers the latest committed state
  // without re-introducing the stale-closure bug the functional setters
  // were originally added to fix.
  const analyzerUiRef = useRef(analyzerUi);
  useEffect(() => {
    analyzerUiRef.current = analyzerUi;
  }, [analyzerUi]);
  // In-flight guard for the two per-analyzer GETs. React 19 StrictMode calls
  // event handlers' state updaters twice in dev; dedup-by-key here prevents
  // double-firing the network request even when the handler runs twice.
  const inFlightRef = useRef(new Set());
  // Every section starts collapsed so the panel opens compact, showing just
  // the live status and the section headers.
  const [openrouterOpen, setOpenrouterOpen] = useState(false);
  const [questdbOpen, setQuestdbOpen] = useState(false);
  const [analyzersOpen, setAnalyzersOpen] = useState(false);
  // While awaiting a post-save restart, holds { prior: startedAt-at-save-time }.
  // Null when not awaiting one.
  const restartWatchRef = useRef(null);

  useScopedStyles();

  // Reset edit buffer + pristine ref whenever the host pushes a new config.
  // Guarded by a structural compare: the SK admin host can re-render with a
  // fresh-but-equal `configuration` object, and resyncing then would silently
  // discard in-progress unsaved edits.
  const lastSyncedRef = useRef(configuration ?? {});
  useEffect(() => {
    const next = configuration ?? {};
    if (jsonEqual(lastSyncedRef.current, next)) return;
    lastSyncedRef.current = next;
    setCfg(structuredClone(next));
    setPristine(structuredClone(next));
    // Host pushed a fresh config after a save round-trip: clear the saving
    // latch so the button re-enables for the next edit cycle.
    setSaving(false);
  }, [configuration]);

  // Memoized: the 5s status poll re-renders the panel without touching cfg or
  // pristine, so the full-tree deep compare reruns only when an edit or a host
  // resync actually changes one of them.
  const dirty = useMemo(() => !jsonEqual(cfg, pristine), [cfg, pristine]);

  const fetchStatus = useCallback(async () => {
    const r = await fetchJson('/status');
    if (r.ok && r.body) {
      setStatus((prev) => (jsonEqual(prev, r.body) ? prev : r.body));
      setStatusError(null);
      // A save restarts the plugin. The first post-save status poll that
      // reports a startedAt different from the one seen at save time means
      // the restart has finished: flip the notice from "restarting" to "done".
      const watch = restartWatchRef.current;
      if (watch && typeof r.body.startedAt === 'number' && r.body.startedAt !== watch.prior) {
        restartWatchRef.current = null;
        setSavedNotice((prev) =>
          prev?.phase === NOTICE_RESTARTING ? { ...prev, phase: NOTICE_DONE } : prev,
        );
      }
    } else if (r.status === 503) {
      setStatus(null);
      setStatusError('Plugin is not running. Set an API key and Save to start it.');
    } else {
      setStatusError(`Status fetch failed: ${r.error ?? `HTTP ${r.status}`}`);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const handle = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(handle);
  }, [fetchStatus]);

  const setSection = (patch) => setCfg((prev) => ({ ...prev, ...patch }));

  const setAnalyzerCfg = (id, patch) => {
    setCfg((prev) => ({
      ...prev,
      analyzers: {
        ...(prev.analyzers ?? {}),
        [id]: { ...(prev.analyzers?.[id] ?? {}), ...patch },
      },
    }));
  };

  // Write only triggers.cron.pattern into the edit buffer; the server merges
  // cron.enabled and timezone from defaults. Nested because setAnalyzerCfg
  // merges only at the analyzer level.
  const setSchedule = (id, pattern) => {
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
  };

  const patchUi = (id, patch) =>
    setAnalyzerUi((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));

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

  const onSave = () => {
    if (saving) return;
    setSaving(true);
    try {
      save(cfg);
    } catch (err) {
      // save() rejected synchronously (transient client error, validation
      // reject from the host). Clear the latch so the user can retry;
      // surface the error in the notice slot.
      setSaving(false);
      setSavedNotice({
        at: new Date().toLocaleTimeString(),
        phase: NOTICE_DONE,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Arm the restart watcher only when a startedAt is known. With status null
    // (plugin not yet running) prior would be undefined and the first poll
    // with any startedAt would falsely flip "restarting" to "restarted"; leave
    // it disarmed and let the auto-clear retire the notice instead.
    restartWatchRef.current =
      typeof status?.startedAt === 'number' ? { prior: status.startedAt } : null;
    setSavedNotice({ at: new Date().toLocaleTimeString(), phase: NOTICE_RESTARTING });
    // Fallback: if the host never pushes a fresh configuration prop (the only
    // other path that clears `saving`), drop the latch after a generous
    // timeout so the Save button is not pinned forever on a silent failure.
    setTimeout(() => setSaving((s) => (s ? false : s)), 30_000);
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const r = await fetchJson('/openrouter/test', { method: 'POST' });
    setTestResult(
      r.ok && r.body
        ? { ok: true, text: `OK (${r.body.totalTokens} tokens, ${r.body.model})` }
        : { ok: false, text: errText(r) },
    );
    setTesting(false);
  };

  const loadModels = useCallback(async () => {
    if (modelsState === 'loading') return;
    setModelsState('loading');
    const r = await fetchJson('/openrouter/models');
    if (r.ok && r.body) {
      setModels(r.body.data || []);
      setModelsState('ready');
    } else {
      setModelsState('error');
    }
  }, [modelsState]);

  const runQdbTest = async () => {
    setQdbTesting(true);
    setQdbTest(null);
    const r = await fetchJson('/questdb/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: cfg.questdb?.url }),
    });
    // The /questdb/test endpoint returns HTTP 200 with { ok: false } (and no
    // `error` field) for a cleanly-unreachable server: only a thrown probe
    // yields a non-2xx status with an `error`. Fall back to 'Unreachable'
    // rather than the misleading 'HTTP 200' the generic envelope would show.
    setQdbTest(
      r.body?.ok
        ? { ok: true, url: r.body.url }
        : {
            ok: false,
            text: r.body?.error || (r.ok ? 'Unreachable' : r.error || `HTTP ${r.status}`),
          },
    );
    setQdbTesting(false);
  };

  const loadReports = async (id) => {
    const key = `reports:${id}`;
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    try {
      patchUi(id, { reportsLoading: true });
      const r = await fetchJson(`/analyzers/${id}/reports?limit=${REPORT_LIMIT}`);
      if (r.ok) {
        patchUi(id, {
          reports: r.body?.reports || [],
          reportsLoading: false,
          reportsError: null,
        });
      } else {
        // Keep any previously loaded reports rather than clobbering them with
        // an empty list, which would render a false "No reports yet".
        patchUi(id, {
          reportsLoading: false,
          reportsError: errText(r),
        });
      }
    } finally {
      inFlightRef.current.delete(key);
    }
  };

  const fireAnalyzer = async (id) => {
    patchUi(id, { fire: { pending: true } });
    const r = await fetchJson(`/analyzers/${id}/fire`, { method: 'POST' });
    patchUi(id, {
      fire: r.ok
        ? {
            // 'failed' and 'unknown' both render in the danger color; everything
            // else (reported, no-input, budget-exhausted) reads as a normal
            // success or a benign no-op.
            ok: r.body?.outcome !== 'failed' && r.body?.outcome !== 'unknown',
            text: FIRE_OUTCOME_TEXT[r.body?.outcome] ?? 'Dispatched',
          }
        : { ok: false, text: errText(r) },
    });
    // Refresh the open drawer so the new report shows up after the LLM
    // returns. 800 ms is a heuristic; a real boat round-trip is 1-3 s. Read
    // the live drawer state via the ref: the multi-second fire means the
    // closed-over analyzerUi is stale by the time it resolves.
    if (analyzerUiRef.current[id]?.reportsOpen) {
      setTimeout(() => loadReports(id), 800);
    }
  };

  // Read live state via the ref to avoid the stale-closure bug a rapid
  // double-click would hit on `analyzerUi`, and use a functional state
  // updater for the mutation. Side effects (loadReports, loadPrompt) MUST
  // stay outside the updater: React 19 may invoke the updater more than once
  // (StrictMode in dev, concurrent rendering in production), and the
  // inFlightRef guard in load* is the dedup of last resort.
  const toggleExpand = (id) => {
    setAnalyzerUi((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? {}), expanded: !prev[id]?.expanded },
    }));
  };

  const toggleReports = (id) => {
    const next = !analyzerUiRef.current[id]?.reportsOpen;
    setAnalyzerUi((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? {}), reportsOpen: next },
    }));
    if (next && !analyzerUiRef.current[id]?.reports) loadReports(id);
  };

  const loadPrompt = async (id) => {
    const key = `prompt:${id}`;
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    try {
      patchUi(id, { promptLoaded: false, promptError: null });
      const r = await fetchJson(`/analyzers/${id}/prompt`);
      if (r.ok && r.body) {
        patchUi(id, {
          promptDefault: r.body.default,
          promptCurrent: r.body.current,
          promptLoaded: true,
          promptError: null,
        });
      } else {
        patchUi(id, {
          promptError: errText(r),
          promptLoaded: true,
        });
      }
    } finally {
      inFlightRef.current.delete(key);
    }
  };

  const togglePrompt = (id) => {
    const current = analyzerUiRef.current[id];
    const next = !current?.promptOpen;
    setAnalyzerUi((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? {}), promptOpen: next },
    }));
    // Load on first open, and retry on reopen if the previous load failed.
    if (next && (!current?.promptLoaded || current?.promptError)) loadPrompt(id);
  };

  // Single source of truth for the prompt edit buffer: the cfg object. The
  // textarea value is derived from cfg.analyzers[id].customSystemPrompt
  // (override), or analyzerUi[id].promptCurrent (saved override from server),
  // or promptDefault (built-in).
  const promptValueFor = (id) => {
    const overlay = cfg.analyzers?.[id]?.customSystemPrompt;
    if (overlay !== undefined) return overlay;
    const ui = analyzerUi[id];
    return ui?.promptCurrent ?? ui?.promptDefault ?? '';
  };

  const onPromptChange = (id, value) => setAnalyzerCfg(id, { customSystemPrompt: value });

  const onPromptReset = (id) => {
    setAnalyzerCfg(id, { customSystemPrompt: undefined });
    patchUi(id, { promptCurrent: null });
  };

  const analyzersList = status?.analyzers ?? [];

  return (
    <div className={PANEL_CLASS} style={S.root}>
      <div style={{ ...S.sectionTitle, ...S.sectionTitleFirst }}>Live status</div>
      <StatusBlock
        status={status}
        statusError={statusError}
        onTest={runTest}
        testing={testing}
        testResult={testResult}
      />

      <CollapsibleSection
        title="OpenRouter"
        open={openrouterOpen}
        onToggle={() => setOpenrouterOpen((v) => !v)}
      >
        <OpenRouterSection
          cfg={cfg}
          set={setSection}
          models={models}
          modelsState={modelsState}
          loadModels={loadModels}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="QuestDB enrichment"
        open={questdbOpen}
        onToggle={() => setQuestdbOpen((v) => !v)}
      >
        <QuestDBSection
          cfg={cfg}
          set={setSection}
          testResult={qdbTest}
          onTest={runQdbTest}
          testing={qdbTesting}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Analyzers"
        open={analyzersOpen}
        onToggle={() => setAnalyzersOpen((v) => !v)}
      >
        {analyzersList.length === 0 && (
          <div style={S.empty}>
            {status
              ? 'No analyzers reported by the plugin yet.'
              : 'Analyzer list loads once the plugin is running.'}
          </div>
        )}
        {analyzersList.map((a) => (
          <AnalyzerRow
            key={a.id}
            analyzer={a}
            // Fall back to the live /api/status value when the edit buffer
            // has no explicit setting: on a fresh install `configuration` has
            // no analyzers key, but the server defaults them all enabled, so
            // keying the checkbox off cfg alone would show them as disabled.
            enabled={cfg.analyzers?.[a.id]?.enabled ?? a.enabled}
            setEnabled={(id, enabled) => setAnalyzerCfg(id, { enabled })}
            ui={analyzerUi[a.id] ?? {}}
            onToggleExpand={toggleExpand}
            onFire={fireAnalyzer}
            onToggleReports={toggleReports}
            onTogglePrompt={togglePrompt}
            promptValue={promptValueFor(a.id)}
            onPromptChange={onPromptChange}
            onPromptReset={onPromptReset}
            schedule={cfg.analyzers?.[a.id]?.triggers?.cron?.pattern ?? a.cron?.pattern ?? ''}
            onScheduleChange={setSchedule}
            // Only forecast carries a severity floor today; pass the control's
            // props only for analyzers that have one so AnalyzerRow stays
            // analyzer-agnostic (it renders the floor when given a value, not
            // by checking the id). A second floor-bearing analyzer needs only a
            // prop here, no AnalyzerRow edit.
            severityFloor={
              a.id === 'forecast'
                ? (cfg.analyzers?.[a.id]?.severityFloor ?? DEFAULT_SEVERITY_FLOOR)
                : undefined
            }
            onSeverityFloorChange={
              a.id === 'forecast'
                ? (value) => setAnalyzerCfg(a.id, { severityFloor: value })
                : undefined
            }
          />
        ))}
      </CollapsibleSection>

      <div style={S.saveBar}>
        <button
          type="button"
          className={btnClass(false)}
          style={btn(
            S.btnSave,
            (!dirty || saving) && S.btnSaveIdle,
            (!dirty || saving) && S.btnDisabled,
          )}
          onClick={onSave}
          disabled={!dirty || saving}
        >
          {saving ? 'Saving...' : dirty ? 'Save configuration' : 'Saved'}
        </button>
        {dirty && <span style={S.saveHint}>Unsaved changes</span>}
        {savedNotice && (
          <span
            style={{ ...S.testStatus, ...S.testOk, ...S.saveSpacer }}
            role="status"
            aria-live="polite"
          >
            {savedNotice.phase === NOTICE_DONE
              ? `Saved at ${savedNotice.at}. Plugin restarted.`
              : `Saved at ${savedNotice.at}. Plugin restarting...`}
          </span>
        )}
      </div>
    </div>
  );
}
