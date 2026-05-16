import { useCallback, useEffect, useState } from 'react';

const API_BASE = '/plugins/signalk-openrouter-companion/api';
const POLL_MS = 5000;
const REPORT_LIMIT = 10;

// Match SK admin convention (Configuration.tsx passes this on every fetch).
// Default works on same-origin browsers but breaks under reverse proxies that
// don't preserve cookies; explicit is safer.
async function apiFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...opts });
}

// Standard envelope for the panel's REST calls: every endpoint returns JSON,
// and panel state always wants {ok, status, body, error}. Promotes the
// try/await/parse/catch boilerplate out of five callsites.
async function fetchJson(path, opts) {
  try {
    const res = await apiFetch(path, opts);
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON response body; leave body null, ok flag carries the status
    }
    return { ok: res.ok, status: res.status, body, error: null };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e.message };
  }
}

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
  btnSecondary: { background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' },
  btnSave: { padding: '8px 18px', fontSize: 13 },
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

const MODELS_HINT = {
  loading: 'Loading model list...',
  error: 'Could not load models; type slug manually',
};

function questdbLabel(qdb) {
  if (!qdb.enabled) return { text: 'Disabled', color: '#9ca3af' };
  if (qdb.reachable === null) return { text: 'Probing...', color: '#f59e0b' };
  if (qdb.reachable) return { text: 'Reachable', color: '#10b981' };
  return { text: 'Unreachable', color: '#ef4444' };
}

function jsonEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// Spread S.btn first, then any number of overrides (variants or disabled
// state). Falsy overrides are dropped so callers can pass `cond && S.x`.
function btn(...overrides) {
  return Object.assign({}, S.btn, ...overrides.filter(Boolean));
}

function StatusBlock({ status, statusError, onTest, testing, testResult }) {
  if (statusError && !status) return <div style={S.empty}>{statusError}</div>;
  if (!status) return <div style={S.empty}>Loading status...</div>;
  const o = status.openrouter;
  const qdb = status.questdb;
  const qdbState = questdbLabel(qdb);
  const enabledCount = status.analyzers.filter((a) => a.enabled).length;
  return (
    <>
      <div style={S.statsGrid}>
        <div style={S.statCard}>
          <div style={S.statLabel}>OpenRouter API key</div>
          <div style={S.statValue}>
            <span style={S.dot(o.apiKeySet ? '#10b981' : '#ef4444')} />
            {o.apiKeySet ? 'Configured' : 'Missing'}
          </div>
          {o.apiKeySet && <div style={S.statSub}>Model: {o.model}</div>}
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Calls today</div>
          <div style={S.statValue}>
            {o.callsToday} / {o.maxCallsPerDay}
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
          style={btn((testing || !o.apiKeySet) && S.btnDisabled)}
          onClick={onTest}
          disabled={testing || !o.apiKeySet}
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
  const hint = MODELS_HINT[modelsState] ?? `${models.length} models available (autocomplete)`;
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
        <span style={S.hint}>{hint}</span>
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
              style={btn(testing && S.btnDisabled)}
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

function PromptDrawer({ analyzerId, ui, value, onChange, onReset, onClose }) {
  if (!ui.promptLoaded)
    return (
      <div style={S.drawer}>
        <div style={S.empty}>Loading prompt...</div>
      </div>
    );
  const isOverride = value !== ui.promptDefault;
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
        <button type="button" style={btn(S.btnSecondary)} onClick={() => onReset(analyzerId)}>
          Reset to default
        </button>
        <button type="button" style={btn(S.btnSecondary)} onClick={onClose}>
          Close
        </button>
        {ui.promptError && <span style={{ ...S.testStatus, ...S.testErr }}>{ui.promptError}</span>}
      </div>
    </div>
  );
}

function AnalyzerRow({
  analyzer,
  enabled,
  setEnabled,
  ui,
  onFire,
  onToggleReports,
  onTogglePrompt,
  promptValue,
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
        {ui.fire && (
          <span style={{ ...S.fireResult, color: ui.fire.ok ? '#10b981' : '#ef4444' }}>
            {ui.fire.text}
          </span>
        )}
        <button
          type="button"
          style={btn((!enabled || ui.fire?.pending) && S.btnDisabled)}
          disabled={!enabled || ui.fire?.pending}
          onClick={() => onFire(analyzer.id)}
        >
          {ui.fire?.pending ? 'Firing...' : 'Fire now'}
        </button>
        <button
          type="button"
          style={btn(S.btnSecondary)}
          onClick={() => onToggleReports(analyzer.id)}
        >
          {ui.reportsOpen ? 'Hide reports' : 'View reports'}
        </button>
        <button
          type="button"
          style={btn(S.btnSecondary)}
          onClick={() => onTogglePrompt(analyzer.id)}
        >
          {ui.promptOpen ? 'Hide prompt' : 'Edit prompt'}
        </button>
        <span style={S.analyzerState}>{enabled ? 'enabled' : 'disabled'}</span>
      </div>
      {ui.reportsOpen && (
        <div style={S.drawer}>
          {ui.reportsLoading && <div style={S.empty}>Loading reports...</div>}
          {!ui.reportsLoading && (!ui.reports || ui.reports.length === 0) && (
            <div style={S.empty}>No reports yet for this analyzer.</div>
          )}
          {!ui.reportsLoading &&
            ui.reports?.map((r) => (
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
      {ui.promptOpen && (
        <PromptDrawer
          analyzerId={analyzer.id}
          ui={ui}
          value={promptValue}
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
  const [cfg, setCfg] = useState(() => structuredClone(configuration ?? {}));
  const [pristine, setPristine] = useState(() => structuredClone(configuration ?? {}));
  const [savedNotice, setSavedNotice] = useState(null);
  const [models, setModels] = useState([]);
  const [modelsState, setModelsState] = useState('idle');
  const [qdbTest, setQdbTest] = useState(null);
  const [qdbTesting, setQdbTesting] = useState(false);
  const [analyzerUi, setAnalyzerUi] = useState({});

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

  const patchUi = (id, patch) =>
    setAnalyzerUi((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));

  const onSave = () => {
    save(cfg);
    setSavedNotice(`Saved at ${new Date().toLocaleTimeString()}. Plugin restarting...`);
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
            // Fall back to the live /api/status value when the edit buffer
            // has no explicit setting: on a fresh install `configuration` has
            // no analyzers key, but the server defaults them all enabled, so
            // keying the checkbox off cfg alone would show them as disabled.
            enabled={cfg.analyzers?.[a.id]?.enabled ?? a.enabled}
            setEnabled={(id, enabled) => setAnalyzerCfg(id, { enabled })}
            ui={analyzerUi[a.id] ?? {}}
            onFire={fireAnalyzer}
            onToggleReports={toggleReports}
            onTogglePrompt={togglePrompt}
            promptValue={promptValueFor(a.id)}
            onPromptChange={onPromptChange}
            onPromptReset={onPromptReset}
          />
        ))}
      </div>

      <div style={S.saveBar}>
        <button
          type="button"
          style={btn(S.btnSave, !dirty && S.btnDisabled)}
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
