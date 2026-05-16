import { btn, btnClass, S } from '../styles.js';

export function QuestDBSection({ cfg, set, testResult, onTest, testing }) {
  const q = cfg.questdb ?? {};
  const noUrl = !q.url || q.url.trim() === '';
  return (
    <>
      <div style={S.fieldRow}>
        <label htmlFor="orc-qdb-enabled" style={S.fieldLabel}>
          Enabled
        </label>
        <input
          id="orc-qdb-enabled"
          type="checkbox"
          checked={!!q.enabled}
          onChange={(e) => set({ questdb: { ...q, enabled: e.target.checked } })}
        />
        <span style={S.hint}>Trend analyzers (aging, drift) require this</span>
      </div>
      {q.enabled && (
        <>
          <div style={S.fieldRow}>
            <label htmlFor="orc-qdb-url" style={S.fieldLabel}>
              QuestDB REST URL
            </label>
            <input
              id="orc-qdb-url"
              type="url"
              spellCheck={false}
              placeholder="http://localhost:9000"
              style={S.input}
              value={q.url ?? ''}
              onChange={(e) => set({ questdb: { ...q, url: e.target.value } })}
            />
          </div>
          <div style={S.inlineRow}>
            <button
              type="button"
              className={btnClass(false)}
              style={btn((testing || noUrl) && S.btnDisabled)}
              onClick={onTest}
              disabled={testing || noUrl}
              title={noUrl ? 'Enter a REST URL first' : undefined}
            >
              {testing ? 'Testing...' : 'Test connection'}
            </button>
            <span
              style={{ ...S.testStatus, ...(testResult?.ok ? S.testOk : S.testErr) }}
              role="status"
              aria-live="polite"
            >
              {testResult
                ? testResult.ok
                  ? `Reachable at ${testResult.url}`
                  : testResult.text
                : ''}
            </span>
          </div>
        </>
      )}
    </>
  );
}
