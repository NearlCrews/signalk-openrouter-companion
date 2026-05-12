import React, { useCallback, useEffect, useState } from 'react';

const API_BASE = '/plugins/signalk-openrouter-companion/api';
const POLL_MS = 5000;

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
    padding: '6px 14px',
    border: 'none',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    background: '#3b82f6',
    color: '#fff',
    cursor: 'pointer',
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
    padding: '8px 12px',
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    marginBottom: 6,
    fontSize: 13,
  },
  analyzerTitle: { flex: 1 },
  analyzerState: { fontSize: 11, color: '#888' },
};

function questdbLabel(qdb) {
  if (!qdb.enabled) return { text: 'Disabled', color: '#9ca3af' };
  if (qdb.reachable === null) return { text: 'Probing...', color: '#f59e0b' };
  return qdb.reachable
    ? { text: 'Reachable', color: '#10b981' }
    : { text: 'Unreachable', color: '#ef4444' };
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

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
          ? {
              ok: true,
              text: `OK (${body.totalTokens} tokens, ${body.model})`,
            }
          : { ok: false, text: body.error || `HTTP ${res.status}` },
      );
    } catch (e) {
      setTestResult({ ok: false, text: e.message });
    }
    setTesting(false);
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
              <div key={a.id} style={S.analyzerRow}>
                <span style={S.dot(a.enabled ? '#10b981' : '#9ca3af')} />
                <span style={S.analyzerTitle}>{a.title}</span>
                <span style={S.analyzerState}>{a.enabled ? 'enabled' : 'disabled'}</span>
              </div>
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
