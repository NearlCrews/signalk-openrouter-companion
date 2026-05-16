import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, POLL_MS, REPORT_LIMIT } from './api.js';
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
  const [models, setModels] = useState([]);
  const [modelsState, setModelsState] = useState('idle');
  const [qdbTest, setQdbTest] = useState(null);
  const [qdbTesting, setQdbTesting] = useState(false);
  const [analyzerUi, setAnalyzerUi] = useState({});
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
  useEffect(() => {
    setCfg(structuredClone(configuration ?? {}));
    setPristine(structuredClone(configuration ?? {}));
  }, [configuration]);

  const dirty = !jsonEqual(cfg, pristine);

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
    save(cfg);
    restartWatchRef.current = { prior: status?.startedAt };
    setSavedNotice({ at: new Date().toLocaleTimeString(), phase: NOTICE_RESTARTING });
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const r = await fetchJson('/openrouter/test', { method: 'POST' });
    setTestResult(
      r.ok && r.body
        ? { ok: true, text: `OK (${r.body.totalTokens} tokens, ${r.body.model})` }
        : { ok: false, text: r.body?.error || r.error || `HTTP ${r.status}` },
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
    patchUi(id, { reportsLoading: true });
    const r = await fetchJson(`/analyzers/${id}/reports?limit=${REPORT_LIMIT}`);
    patchUi(id, { reports: r.body?.reports || [], reportsLoading: false });
  };

  const fireAnalyzer = async (id) => {
    patchUi(id, { fire: { pending: true } });
    const r = await fetchJson(`/analyzers/${id}/fire`, { method: 'POST' });
    patchUi(id, {
      fire: r.ok
        ? { ok: true, text: 'Dispatched' }
        : { ok: false, text: r.body?.error || r.error || `HTTP ${r.status}` },
    });
    // Refresh the open drawer so the new report shows up after the LLM
    // returns. 800 ms is a heuristic; a real boat round-trip is 1-3 s.
    if (analyzerUi[id]?.reportsOpen) setTimeout(() => loadReports(id), 800);
  };

  const toggleExpand = (id) => patchUi(id, { expanded: !analyzerUi[id]?.expanded });

  const toggleReports = (id) => {
    const next = !analyzerUi[id]?.reportsOpen;
    patchUi(id, { reportsOpen: next });
    if (next && !analyzerUi[id]?.reports) loadReports(id);
  };

  const loadPrompt = async (id) => {
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
        promptError: r.body?.error || r.error || `HTTP ${r.status}`,
        promptLoaded: true,
      });
    }
  };

  const togglePrompt = (id) => {
    const next = !analyzerUi[id]?.promptOpen;
    patchUi(id, { promptOpen: next });
    if (next && !analyzerUi[id]?.promptLoaded) loadPrompt(id);
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
            severityFloor={cfg.analyzers?.forecast?.severityFloor ?? DEFAULT_SEVERITY_FLOOR}
            onSeverityFloorChange={(value) => setAnalyzerCfg('forecast', { severityFloor: value })}
          />
        ))}
      </CollapsibleSection>

      <div style={S.saveBar}>
        <button
          type="button"
          className={btnClass(false)}
          style={btn(S.btnSave, !dirty && S.btnSaveIdle, !dirty && S.btnDisabled)}
          onClick={onSave}
          disabled={!dirty}
        >
          {dirty ? 'Save configuration' : 'Saved'}
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
