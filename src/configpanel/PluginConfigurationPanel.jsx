import React, { useCallback, useEffect, useState } from 'react';

const API_BASE = '/plugins/signalk-openrouter-companion/api';
const POLL_MS = 5000;
const REPORT_LIMIT = 10;

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
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  inlineRow: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 },
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
  reportDrawer: {
    background: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    marginTop: -2,
    marginBottom: 8,
    padding: 12,
  },
  reportEntry: {
    padding: '10px 12px',
    borderBottom: '1px solid #f1f5f9',
  },
  reportTs: { fontSize: 11, color: '#888', fontFamily: 'monospace' },
  reportBody: { fontSize: 12, color: '#333', marginTop: 4, whiteSpace: 'pre-wrap' },
  reportFailure: { fontSize: 12, color: '#ef4444', marginTop: 4 },
  fireResult: { fontSize: 11, marginLeft: 4 },
};

function questdbLabel(qdb) {
  if (!qdb.enabled) return { text: 'Disabled', color: '#9ca3af' };
  if (qdb.reachable === null) return { text: 'Probing...', color: '#f59e0b' };
  return qdb.reachable
    ? { text: 'Reachable', color: '#10b981' }
    : { text: 'Unreachable', color: '#ef4444' };
}

function AnalyzerRow({ analyzer, fireState, onFire, onView, viewing, reports, reportsLoading }) {
  const disabled = !analyzer.enabled;
  return (
    <>
      <div style={S.analyzerRow}>
        <span style={S.dot(analyzer.enabled ? '#10b981' : '#9ca3af')} />
        <span style={S.analyzerTitle}>{analyzer.title}</span>
        {fireState && (
          <span
            style={{
              ...S.fireResult,
              color: fireState.ok ? '#10b981' : '#ef4444',
            }}
          >
            {fireState.text}
          </span>
        )}
        <button
          type="button"
          style={{ ...S.btn, ...(disabled || fireState?.pending ? S.btnDisabled : {}) }}
          disabled={disabled || fireState?.pending}
          onClick={() => onFire(analyzer.id)}
        >
          {fireState?.pending ? 'Firing...' : 'Fire now'}
        </button>
        <button
          type="button"
          style={{ ...S.btn, ...S.btnSecondary }}
          onClick={() => onView(analyzer.id)}
        >
          {viewing ? 'Hide' : 'View reports'}
        </button>
        <span style={S.analyzerState}>{analyzer.enabled ? 'enabled' : 'disabled'}</span>
      </div>
      {viewing && (
        <div style={S.reportDrawer}>
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
    </>
  );
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [fireState, setFireState] = useState({});
  const [reportsByAnalyzer, setReportsByAnalyzer] = useState({});
  const [reportsLoading, setReportsLoading] = useState({});
  const [viewing, setViewing] = useState({});

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/status`);
      if (res.ok) {
        setStatus(await res.json());
        setStatusError(null);
      } else if (res.status === 503) {
        setStatus(null);
        setStatusError('Plugin is not running. Enable it and set an API key to see live status.');
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
      // If the drawer is open, refresh it so the new report shows up.
      if (viewing[id]) {
        setTimeout(() => loadReports(id), 800);
      }
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

  const toggleView = (id) => {
    const next = !viewing[id];
    setViewing((s) => ({ ...s, [id]: next }));
    if (next && !reportsByAnalyzer[id]) loadReports(id);
  };

  const apiKeySet = status?.openrouter?.apiKeySet;
  const calls = status?.openrouter;
  const qdb = status?.questdb;
  const qdbState = qdb ? questdbLabel(qdb) : null;
  const enabledCount = (status?.analyzers || []).filter((a) => a.enabled).length;

  return (
    <div style={S.root}>
      <div style={S.sectionTitle}>Live status</div>
      {statusError && <div style={S.empty}>{statusError}</div>}
      {status && (
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
              onClick={runTest}
              disabled={testing || !apiKeySet}
            >
              {testing ? 'Testing...' : 'Test API key'}
            </button>
            {testResult && (
              <span
                style={{
                  ...S.testStatus,
                  ...(testResult.ok ? S.testOk : S.testErr),
                }}
              >
                {testResult.text}
              </span>
            )}
          </div>

          <div style={S.sectionTitle}>Analyzers</div>
          <div>
            {status.analyzers.map((a) => (
              <AnalyzerRow
                key={a.id}
                analyzer={a}
                fireState={fireState[a.id]}
                onFire={fireAnalyzer}
                onView={toggleView}
                viewing={viewing[a.id]}
                reports={reportsByAnalyzer[a.id]}
                reportsLoading={reportsLoading[a.id]}
              />
            ))}
          </div>
        </>
      )}

      <div style={S.sectionTitle}>Saved configuration (raw)</div>
      <pre style={S.pre}>{JSON.stringify(configuration ?? {}, null, 2)}</pre>
      <div style={S.inlineRow}>
        <button type="button" style={S.btn} onClick={() => save(configuration || {})}>
          Save (no-op rewrite)
        </button>
      </div>
    </div>
  );
}
