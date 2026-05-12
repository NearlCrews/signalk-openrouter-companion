import React, { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = '/plugins/signalk-openrouter-companion/api';
const POLL_MS = 5000;
const REPORT_LIMIT = 10;

const ANALYZER_ORDER = ['maintenance', 'health', 'aging', 'drift', 'alerts'];

const S = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#333',
    padding: '16px 0',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 10,
    marginTop: 24,
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 10,
    marginBottom: 12,
  },
  statCard: {
    padding: '12px 16px',
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 10,
  },
  statLabel: { fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' },
  statValue: { fontSize: 18, fontWeight: 700, color: '#333', marginTop: 4 },
  statSub: { fontSize: 11, color: '#888', marginTop: 2 },
  dot: (color) => ({
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    marginRight: 6,
    verticalAlign: 'middle',
  }),
  btn: {
    padding: '6px 12px',
    border: 'none',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    background: '#3b82f6',
    color: '#fff',
    cursor: 'pointer',
  },
  btnSecondary: {
    background: '#f1f5f9',
    color: '#475569',
    border: '1px solid #e2e8f0',
  },
  btnSave: {
    padding: '8px 18px',
    fontSize: 13,
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  inlineRow: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, flexWrap: 'wrap' },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
  fieldLabel: { fontSize: 13, fontWeight: 500, color: '#555', width: 160, flexShrink: 0 },
  input: {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    fontSize: 13,
    background: '#fff',
    color: '#333',
    minWidth: 220,
  },
  inputSmall: { minWidth: 80, width: 100 },
  hint: { fontSize: 11, color: '#888' },
  testStatus: { fontSize: 12 },
  testOk: { color: '#10b981' },
  testErr: { color: '#ef4444' },
  pre: {
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    padding: 12,
    fontSize: 11,
    lineHeight: 1.4,
    overflow: 'auto',
    maxHeight: 280,
    color: '#555',
  },
  empty: { fontSize: 13, color: '#888', padding: '20px 0' },
  analyzerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    marginBottom: 6,
    fontSize: 13,
  },
  analyzerTitle: { flex: 1, fontWeight: 500 },
  analyzerState: { fontSize: 11, color: '#888', minWidth: 60, textAlign: 'right' },
  drawer: {
    background: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    marginTop: -2,
    marginBottom: 8,
    padding: 12,
  },
  reportEntry: { padding: '10px 12px', borderBottom: '1px solid #f1f5f9' },
  reportTs: { fontSize: 11, color: '#888', fontFamily: 'monospace' },
  reportBody: { fontSize: 12, color: '#333', marginTop: 4, whiteSpace: 'pre-wrap' },
  reportFailure: { fontSize: 12, color: '#ef4444', marginTop: 4 },
  fireResult: { fontSize: 11, marginLeft: 4 },
  textarea: {
    width: '100%',
    minHeight: 180,
    padding: 8,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 11,
    lineHeight: 1.45,
    border: '1px solid #ccc',
    borderRadius: 6,
    background: '#fff',
    color: '#333',
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  saveBar: {
    position: 'sticky',
    bottom: 0,
    background: '#fff',
    borderTop: '1px solid #e0e0e0',
    padding: '12px 0',
    marginTop: 24,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
};

function questdbLabel(qdb) {
  if (!qdb.enabled) return { text: 'Disabled', color: '#9ca3af' };
  if (qdb.reachable === null) return { text: 'Probing...', color: '#f59e0b' };
  return qdb.reachable
    ? { text: 'Reachable', color: '#10b981' }
    : { text: 'Unreachable', color: '#ef4444' };
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? {}));
}

function deepEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function StatusBlock({ status, statusError, onTest, testing, testResult }) {
  if (statusError && !status) return <div style={S.empty}>{statusError}</div>;
  if (!status) return <div style={S.empty}>Loading status...</div>;
  const apiKeySet = status.openrouter.apiKeySet;
  const calls = status.openrouter;
  const qdb = status.questdb;
  const qdbState = questdbLabel(qdb);
  const enabledCount = status.analyzers.filter((a) => a.enabled).length;
  return (
    <>
      <div style={S.statsGrid}>
        <div style={S.statCard}>
          <div style={S.statLabel}>OpenRouter API key</div>
          <div style={S.statValue}>
            <span style={S.dot(apiKeySet ? '#10b981' : '#ef4444')} />
            {apiKeySet ? 'Configured' : 'Missing'}
          </div>
          {apiKeySet && <div style={S.statSub}>Model: {calls.model}</div>}
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Calls today</div>
          <div style={S.statValue}>
            {calls.callsToday} / {calls.maxCallsPerDay}
          </div>
          <div style={S.statSub}>UTC daily cap</div>
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>QuestDB</div>
          <div style={S.statValue}>
            <span style={S.dot(qdbState.color)} />
            {qdbState.text}
          </div>
          <div style={S.statSub}>
            {qdb.enabled ? 'Trend analyzers depend on this' : 'Trend analyzers will skip'}
          </div>
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Analyzers</div>
          <div style={S.statValue}>
            {enabledCount} / {status.analyzers.length}
          </div>
          <div style={S.statSub}>enabled</div>
        </div>
      </div>
      <div style={S.inlineRow}>
        <button
          type="button"
          style={{ ...S.btn, ...(testing || !apiKeySet ? S.btnDisabled : {}) }}
          onClick={onTest}
          disabled={testing || !apiKeySet}
        >
          {testing ? 'Testing...' : 'Test API key'}
        </button>
        {testResult && (
          <span style={{ ...S.testStatus, ...(testResult.ok ? S.testOk : S.testErr) }}>
            {testResult.text}
          </span>
        )}
      </div>
    </>
  );
}

function OpenRouterSection({ cfg, set, models, modelsState, loadModels }) {
  const o = cfg.openrouter ?? {};
  return (
    <>
      <div style={S.sectionTitle}>OpenRouter</div>
      <div style={S.fieldRow}>
        <span style={S.fieldLabel}>API key</span>
        <input
          type="password"
          autoComplete="new-password"
          style={S.input}
          value={o.apiKey ?? ''}
          onChange={(e) => set({ openrouter: { ...o, apiKey: e.target.value } })}
        />
        <span style={S.hint}>Required to call the LLM</span>
      </div>
      <div style={S.fieldRow}>
        <span style={S.fieldLabel}>Model</span>
        <input
          type="text"
          list="openrouter-models"
          style={S.input}
          value={o.model ?? ''}
          onFocus={() => modelsState === 'idle' && loadModels()}
          onChange={(e) => set({ openrouter: { ...o, model: e.target.value } })}
        />
        <datalist id="openrouter-models">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </datalist>
        <span style={S.hint}>
          {modelsState === 'loading'
            ? 'Loading model list...'
            : modelsState === 'error'
              ? 'Could not load models; type slug manually'
              : `${models.length} models available (autocomplete)`}
        </span>
      </div>
      <div style={S.fieldRow}>
        <span style={S.fieldLabel}>Max calls per day</span>
        <input
          type="number"
          min="0"
          style={{ ...S.input, ...S.inputSmall }}
          value={o.maxCallsPerDay ?? 0}
          onChange={(e) => set({ openrouter: { ...o, maxCallsPerDay: Number(e.target.value) } })}
        />
        <span style={S.hint}>UTC daily hard cap on OpenRouter calls</span>
      </div>
    </>
  );
}

function QuestDBSection({ cfg, set, testResult, onTest, testing }) {
  const q = cfg.questdb ?? {};
  return (
    <>
      <div style={S.sectionTitle}>QuestDB enrichment</div>
      <div style={S.fieldRow}>
        <span style={S.fieldLabel}>Enabled</span>
        <input
          type="checkbox"
          checked={!!q.enabled}
          onChange={(e) => set({ questdb: { ...q, enabled: e.target.checked } })}
        />
        <span style={S.hint}>Trend analyzers (aging, drift) require this</span>
      </div>
      {q.enabled && (
        <>
          <div style={S.fieldRow}>
            <span style={S.fieldLabel}>QuestDB REST URL</span>
            <input
              type="text"
              style={S.input}
              value={q.url ?? ''}
              onChange={(e) => set({ questdb: { ...q, url: e.target.value } })}
            />
          </div>
          <div style={S.inlineRow}>
            <button
              type="button"
              style={{ ...S.btn, ...(testing ? S.btnDisabled : {}) }}
              onClick={onTest}
              disabled={testing}
            >
              {testing ? 'Testing...' : 'Test connection'}
            </button>
            {testResult && (
              <span style={{ ...S.testStatus, ...(testResult.ok ? S.testOk : S.testErr) }}>
                {testResult.ok ? `Reachable at ${testResult.url}` : testResult.text}
              </span>
            )}
          </div>
        </>
      )}
    </>
  );
}

function PromptDrawer({ analyzerId, promptState, onChange, onReset, onClose }) {
  if (!promptState) return null;
  const value = promptState.edited ?? promptState.current ?? promptState.default ?? '';
  const isOverride = promptState.edited != null || promptState.current != null;
  return (
    <div style={S.drawer}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>System prompt</div>
        <div style={S.hint}>
          The prompt the LLM receives. Save the panel to apply changes.
          {isOverride ? ' (custom override active)' : ' (using built-in default)'}
        </div>
      </div>
      <textarea
        style={S.textarea}
        value={value}
        onChange={(e) => onChange(analyzerId, e.target.value)}
      />
      <div style={S.inlineRow}>
        <button
          type="button"
          style={{ ...S.btn, ...S.btnSecondary }}
          onClick={() => onReset(analyzerId)}
        >
          Reset to default
        </button>
        <button type="button" style={{ ...S.btn, ...S.btnSecondary }} onClick={onClose}>
          Close
        </button>
        {promptState.error && (
          <span style={{ ...S.testStatus, ...S.testErr }}>{promptState.error}</span>
        )}
      </div>
    </div>
  );
}

function AnalyzerRow({
  analyzer,
  enabled,
  setEnabled,
  fireState,
  onFire,
  reportsOpen,
  onToggleReports,
  reports,
  reportsLoading,
  promptOpen,
  onTogglePrompt,
  promptState,
  onPromptChange,
  onPromptReset,
}) {
  return (
    <>
      <div style={S.analyzerRow}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(analyzer.id, e.target.checked)}
        />
        <span style={S.analyzerTitle}>{analyzer.title}</span>
        {fireState && (
          <span style={{ ...S.fireResult, color: fireState.ok ? '#10b981' : '#ef4444' }}>
            {fireState.text}
          </span>
        )}
        <button
          type="button"
          style={{ ...S.btn, ...(!enabled || fireState?.pending ? S.btnDisabled : {}) }}
          disabled={!enabled || fireState?.pending}
          onClick={() => onFire(analyzer.id)}
        >
          {fireState?.pending ? 'Firing...' : 'Fire now'}
        </button>
        <button
          type="button"
          style={{ ...S.btn, ...S.btnSecondary }}
          onClick={() => onToggleReports(analyzer.id)}
        >
          {reportsOpen ? 'Hide reports' : 'View reports'}
        </button>
        <button
          type="button"
          style={{ ...S.btn, ...S.btnSecondary }}
          onClick={() => onTogglePrompt(analyzer.id)}
        >
          {promptOpen ? 'Hide prompt' : 'Edit prompt'}
        </button>
        <span style={S.analyzerState}>{enabled ? 'enabled' : 'disabled'}</span>
      </div>
      {reportsOpen && (
        <div style={S.drawer}>
          {reportsLoading && <div style={S.empty}>Loading reports...</div>}
          {!reportsLoading && (!reports || reports.length === 0) && (
            <div style={S.empty}>No reports yet for this analyzer.</div>
          )}
          {!reportsLoading &&
            reports?.map((r) => (
              <div key={r.ts} style={S.reportEntry}>
                <div style={S.reportTs}>
                  {r.ts} · trigger={r.trigger}
                  {r.engineId ? ` · engine=${r.engineId}` : ''}
                  {r.durationSec ? ` · ${r.durationSec}s` : ''}
                </div>
                {r.report && <div style={S.reportBody}>{r.report}</div>}
                {r.failure && <div style={S.reportFailure}>FAILURE: {r.failure}</div>}
              </div>
            ))}
        </div>
      )}
      {promptOpen && (
        <PromptDrawer
          analyzerId={analyzer.id}
          promptState={promptState}
          onChange={onPromptChange}
          onReset={onPromptReset}
          onClose={() => onTogglePrompt(analyzer.id)}
        />
      )}
    </>
  );
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [cfg, setCfg] = useState(() => deepClone(configuration));
  const [savedNotice, setSavedNotice] = useState(null);
  const [models, setModels] = useState([]);
  const [modelsState, setModelsState] = useState('idle');
  const [qdbTest, setQdbTest] = useState(null);
  const [qdbTesting, setQdbTesting] = useState(false);
  const [fireState, setFireState] = useState({});
  const [reportsByAnalyzer, setReportsByAnalyzer] = useState({});
  const [reportsLoading, setReportsLoading] = useState({});
  const [reportsOpen, setReportsOpen] = useState({});
  const [promptOpen, setPromptOpen] = useState({});
  const [promptState, setPromptState] = useState({});

  // Reset local edit buffer whenever the host pushes a new configuration.
  useEffect(() => {
    setCfg(deepClone(configuration));
  }, [configuration]);

  const dirty = useMemo(() => !deepEqual(cfg, configuration), [cfg, configuration]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/status`);
      if (res.ok) {
        setStatus(await res.json());
        setStatusError(null);
      } else if (res.status === 503) {
        setStatus(null);
        setStatusError('Plugin is not running. Set an API key and Save to start it.');
      } else {
        setStatusError(`Status fetch failed: HTTP ${res.status}`);
      }
    } catch (e) {
      setStatusError(`Status fetch failed: ${e.message}`);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const handle = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(handle);
  }, [fetchStatus]);

  const setSection = (patch) => {
    setCfg((prev) => ({ ...prev, ...patch }));
  };

  const setAnalyzerCfg = (id, patch) => {
    setCfg((prev) => ({
      ...prev,
      analyzers: {
        ...(prev.analyzers ?? {}),
        [id]: { ...((prev.analyzers ?? {})[id] ?? {}), ...patch },
      },
    }));
  };

  const setAnalyzerEnabled = (id, enabled) => setAnalyzerCfg(id, { enabled });

  const onSave = () => {
    save(cfg);
    setSavedNotice(`Saved at ${new Date().toLocaleTimeString()}. Plugin restarting...`);
    // After save, the host pushes a new configuration prop and useEffect resets cfg.
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API_BASE}/openrouter/test`, { method: 'POST' });
      const body = await res.json();
      setTestResult(
        res.ok
          ? { ok: true, text: `OK (${body.totalTokens} tokens, ${body.model})` }
          : { ok: false, text: body.error || `HTTP ${res.status}` },
      );
    } catch (e) {
      setTestResult({ ok: false, text: e.message });
    }
    setTesting(false);
  };

  const loadModels = useCallback(async () => {
    if (modelsState === 'loading') return;
    setModelsState('loading');
    try {
      const res = await fetch(`${API_BASE}/openrouter/models`);
      if (res.ok) {
        const body = await res.json();
        setModels(body.data || []);
        setModelsState('ready');
      } else {
        setModelsState('error');
      }
    } catch {
      setModelsState('error');
    }
  }, [modelsState]);

  const runQdbTest = async () => {
    setQdbTesting(true);
    setQdbTest(null);
    try {
      const res = await fetch(`${API_BASE}/questdb/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: cfg.questdb?.url }),
      });
      const body = await res.json();
      setQdbTest(
        body.ok
          ? { ok: true, url: body.url }
          : { ok: false, text: body.error || `HTTP ${res.status}` },
      );
    } catch (e) {
      setQdbTest({ ok: false, text: e.message });
    }
    setQdbTesting(false);
  };

  const fireAnalyzer = async (id) => {
    setFireState((s) => ({ ...s, [id]: { pending: true } }));
    try {
      const res = await fetch(`${API_BASE}/analyzers/${id}/fire`, { method: 'POST' });
      const body = await res.json();
      setFireState((s) => ({
        ...s,
        [id]: res.ok
          ? { ok: true, text: 'Dispatched' }
          : { ok: false, text: body.error || `HTTP ${res.status}` },
      }));
      if (reportsOpen[id]) setTimeout(() => loadReports(id), 800);
    } catch (e) {
      setFireState((s) => ({ ...s, [id]: { ok: false, text: e.message } }));
    }
  };

  const loadReports = useCallback(async (id) => {
    setReportsLoading((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(`${API_BASE}/analyzers/${id}/reports?limit=${REPORT_LIMIT}`);
      const body = await res.json();
      setReportsByAnalyzer((s) => ({ ...s, [id]: body.reports || [] }));
    } catch {
      setReportsByAnalyzer((s) => ({ ...s, [id]: [] }));
    }
    setReportsLoading((s) => ({ ...s, [id]: false }));
  }, []);

  const toggleReports = (id) => {
    const next = !reportsOpen[id];
    setReportsOpen((s) => ({ ...s, [id]: next }));
    if (next && !reportsByAnalyzer[id]) loadReports(id);
  };

  const loadPrompt = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/analyzers/${id}/prompt`);
      if (res.ok) {
        const body = await res.json();
        setPromptState((s) => ({
          ...s,
          [id]: { default: body.default, current: body.current, edited: null },
        }));
      } else {
        setPromptState((s) => ({ ...s, [id]: { error: `HTTP ${res.status}` } }));
      }
    } catch (e) {
      setPromptState((s) => ({ ...s, [id]: { error: e.message } }));
    }
  };

  const togglePrompt = (id) => {
    const next = !promptOpen[id];
    setPromptOpen((s) => ({ ...s, [id]: next }));
    if (next && !promptState[id]) loadPrompt(id);
  };

  const onPromptChange = (id, value) => {
    setPromptState((s) => ({ ...s, [id]: { ...(s[id] ?? {}), edited: value } }));
    setAnalyzerCfg(id, { customSystemPrompt: value });
  };

  const onPromptReset = (id) => {
    setPromptState((s) => ({
      ...s,
      [id]: { ...(s[id] ?? {}), edited: null, current: null },
    }));
    setAnalyzerCfg(id, { customSystemPrompt: undefined });
  };

  const analyzersList =
    status?.analyzers ?? ANALYZER_ORDER.map((id) => ({ id, title: id, enabled: false }));

  return (
    <div style={S.root}>
      <div style={S.sectionTitle}>Live status</div>
      <StatusBlock
        status={status}
        statusError={statusError}
        onTest={runTest}
        testing={testing}
        testResult={testResult}
      />

      <OpenRouterSection
        cfg={cfg}
        set={setSection}
        models={models}
        modelsState={modelsState}
        loadModels={loadModels}
      />

      <QuestDBSection
        cfg={cfg}
        set={setSection}
        testResult={qdbTest}
        onTest={runQdbTest}
        testing={qdbTesting}
      />

      <div style={S.sectionTitle}>Analyzers</div>
      <div>
        {analyzersList.map((a) => (
          <AnalyzerRow
            key={a.id}
            analyzer={a}
            enabled={!!cfg.analyzers?.[a.id]?.enabled}
            setEnabled={setAnalyzerEnabled}
            fireState={fireState[a.id]}
            onFire={fireAnalyzer}
            reportsOpen={!!reportsOpen[a.id]}
            onToggleReports={toggleReports}
            reports={reportsByAnalyzer[a.id]}
            reportsLoading={reportsLoading[a.id]}
            promptOpen={!!promptOpen[a.id]}
            onTogglePrompt={togglePrompt}
            promptState={promptState[a.id]}
            onPromptChange={onPromptChange}
            onPromptReset={onPromptReset}
          />
        ))}
      </div>

      <div style={S.saveBar}>
        <button
          type="button"
          style={{ ...S.btn, ...S.btnSave, ...(dirty ? {} : S.btnDisabled) }}
          onClick={onSave}
          disabled={!dirty}
        >
          {dirty ? 'Save configuration' : 'No changes'}
        </button>
        {savedNotice && <span style={{ ...S.testStatus, ...S.testOk }}>{savedNotice}</span>}
      </div>
    </div>
  );
}
