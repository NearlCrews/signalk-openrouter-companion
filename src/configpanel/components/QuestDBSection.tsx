import type { ReactElement } from 'react';
import { memo } from 'react';
import { S } from '../styles.js';
import type { PanelConfig, QdbTestResult } from '../types.js';
import { TestButton } from './TestButton.js';
import { TestStatus } from './TestStatus.js';

interface Props {
  cfg: PanelConfig;
  set: (patch: Partial<PanelConfig>) => void;
  testResult: QdbTestResult | null;
  onTest: () => void;
  testing: boolean;
}

// Memoized: skips the status-poll re-render and any keystroke that lands in a
// different section.
export const QuestDBSection = memo(function QuestDBSection({
  cfg,
  set,
  testResult,
  onTest,
  testing,
}: Props): ReactElement {
  const q: NonNullable<PanelConfig['questdb']> = cfg.questdb ?? {};
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
            <TestButton
              label="Test connection"
              busyLabel="Testing..."
              busy={testing}
              disabled={testing || noUrl}
              title={noUrl ? 'Enter a REST URL first' : undefined}
              onClick={onTest}
            />
            <TestStatus ok={testResult?.ok}>
              {testResult
                ? testResult.ok
                  ? `Reachable at ${testResult.url}`
                  : testResult.text
                : ''}
            </TestStatus>
          </div>
        </>
      )}
    </>
  );
});
