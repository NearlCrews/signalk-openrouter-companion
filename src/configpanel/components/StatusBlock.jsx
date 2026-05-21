import { btn, btnClass, S } from '../styles.js';
import { T } from '../tokens.js';

function questdbLabel(qdb) {
  if (!qdb.enabled) return { text: 'Disabled', color: T.color.disabled };
  if (qdb.reachable === null) return { text: 'Probing...', color: T.color.warning };
  if (qdb.reachable) return { text: 'Reachable', color: T.color.success };
  return { text: 'Unreachable', color: T.color.danger };
}

export function StatusBlock({ status, statusError, onTest, testing, testResult }) {
  if (statusError && !status)
    return (
      <div style={{ ...S.empty, ...S.testErr }} role="status">
        {statusError}
      </div>
    );
  if (!status)
    return (
      <div style={S.empty} role="status" aria-live="polite">
        Loading status...
      </div>
    );
  // Default each branch: a malformed /status payload must degrade gracefully
  // rather than throw and blank the whole panel.
  const o = status.openrouter ?? {};
  const qdb = status.questdb ?? { enabled: false, reachable: null };
  const qdbState = questdbLabel(qdb);
  const analyzers = status.analyzers ?? [];
  const enabledCount = analyzers.filter((a) => a.enabled).length;
  return (
    <>
      <div style={S.statsGrid}>
        <div style={S.statCard}>
          <div style={S.statLabel}>OpenRouter API key</div>
          <div style={S.statValue}>
            <span
              style={S.dot(o.apiKeySet ? T.color.success : T.color.danger)}
              aria-hidden="true"
            />
            {o.apiKeySet ? 'Configured' : 'Missing'}
          </div>
          <div style={S.statSub}>{o.apiKeySet ? `Model: ${o.model}` : 'Set a key below'}</div>
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
            <span style={S.dot(qdbState.color)} aria-hidden="true" />
            {qdbState.text}
          </div>
          <div style={S.statSub}>
            {qdb.enabled ? 'Trend analyzers depend on this' : 'Trend analyzers will skip'}
          </div>
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Analyzers</div>
          <div style={S.statValue}>
            {enabledCount} / {analyzers.length}
          </div>
          <div style={S.statSub}>enabled</div>
        </div>
      </div>
      <div style={S.inlineRow}>
        <button
          type="button"
          className={btnClass(false)}
          style={btn((testing || !o.apiKeySet) && S.btnDisabled)}
          onClick={onTest}
          disabled={testing || !o.apiKeySet}
          title={o.apiKeySet ? undefined : 'Set and save an API key first'}
        >
          {testing ? 'Testing...' : 'Test API key'}
        </button>
        {!o.apiKeySet && <span style={S.hint}>Save an API key to enable this test.</span>}
        <span
          style={{ ...S.testStatus, ...(testResult?.ok ? S.testOk : S.testErr) }}
          role="status"
          aria-live="polite"
        >
          {testResult?.text ?? ''}
        </span>
      </div>
    </>
  );
}
