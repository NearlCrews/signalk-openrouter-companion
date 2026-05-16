import { btn, S } from '../styles.js';

export function QuestDBSection({ cfg, set, testResult, onTest, testing }) {
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
