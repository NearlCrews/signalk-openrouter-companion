import { btn, S } from '../styles.js';
import { T } from '../tokens.js';

function questdbLabel(qdb) {
  if (!qdb.enabled) return { text: 'Disabled', color: T.color.disabled };
  if (qdb.reachable === null) return { text: 'Probing...', color: T.color.warning };
  if (qdb.reachable) return { text: 'Reachable', color: T.color.success };
  return { text: 'Unreachable', color: T.color.danger };
}

export function StatusBlock({ status, statusError, onTest, testing, testResult }) {
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
            <span style={S.dot(o.apiKeySet ? T.color.success : T.color.danger)} />
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
