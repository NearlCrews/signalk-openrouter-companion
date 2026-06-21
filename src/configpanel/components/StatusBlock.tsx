import type { CSSProperties, ReactElement } from 'react';
import { memo } from 'react';
import { humanizeAgo } from '../recency.js';
import { S } from '../styles.js';
import type { PanelStatus, TestResult } from '../types.js';
import { TestButton } from './TestButton.js';
import { TestStatus } from './TestStatus.js';

interface Props {
  status: PanelStatus | null;
  statusError: string | null;
  onTest: () => void;
  testing: boolean;
  testResult: TestResult | null;
  // Staleness cue from useStatus: stale flips when polling stalls, and
  // staleAgeMs carries the live age of the last good snapshot while it does.
  stale: boolean;
  staleAgeMs: number | undefined;
}

// Maps the QuestDB probe state to its label and the matching pre-built status
// dot, so the render picks a static style object rather than allocating one.
function questdbLabel(qdb: PanelStatus['questdb']): { text: string; dot: CSSProperties } {
  if (!qdb.enabled) return { text: 'Disabled', dot: S.dotOff };
  if (qdb.reachable === null) return { text: 'Probing...', dot: S.dotWait };
  if (qdb.reachable) return { text: 'Reachable', dot: S.dotOk };
  return { text: 'Unreachable', dot: S.dotDanger };
}

// Memoized: a keystroke elsewhere in the panel leaves status, testResult, and
// the staleness props identity-equal, so the block skips. While polling is
// stalled the panel re-renders each interval and staleAgeMs changes, keeping
// the age text live.
export const StatusBlock = memo(function StatusBlock({
  status,
  statusError,
  onTest,
  testing,
  testResult,
  stale,
  staleAgeMs,
}: Props): ReactElement {
  if (statusError && !status)
    return (
      <div style={{ ...S.empty, ...S.testErr }} role="alert">
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
  const o: Partial<PanelStatus['openrouter']> = status.openrouter ?? {};
  const qdb: PanelStatus['questdb'] = status.questdb ?? { enabled: false, reachable: null };
  const qdbState = questdbLabel(qdb);
  const analyzers = status.analyzers ?? [];
  const enabledCount = analyzers.filter((a) => a.enabled).length;
  return (
    <>
      <div style={S.statsGrid}>
        <div style={S.statCard}>
          <div style={S.statLabel}>OpenRouter API key</div>
          <div style={S.statValue}>
            <span style={o.apiKeySet ? S.dotOk : S.dotDanger} aria-hidden="true" />
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
          <div style={S.statLabel}>Tokens today</div>
          <div style={S.statValue}>{(o.tokensToday ?? 0).toLocaleString()}</div>
          <div style={S.statSub}>prompt + completion</div>
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Est. cost today</div>
          <div style={S.statValue}>${(o.costToday ?? 0).toFixed(4)}</div>
          <div style={S.statSub}>OpenRouter usage.cost</div>
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>QuestDB</div>
          <div style={S.statValue}>
            <span style={qdbState.dot} aria-hidden="true" />
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
        <TestButton
          label="Test API key"
          busyLabel="Testing..."
          busy={testing}
          disabled={testing || !o.apiKeySet}
          title={o.apiKeySet ? undefined : 'Set and save an API key first'}
          onClick={onTest}
        />
        {!o.apiKeySet && <span style={S.hint}>Save an API key to enable this test.</span>}
        <TestStatus ok={testResult?.ok}>{testResult?.text ?? ''}</TestStatus>
        {stale && <span style={S.staleMarker}>updated {humanizeAgo(staleAgeMs)}</span>}
      </div>
    </>
  );
});
