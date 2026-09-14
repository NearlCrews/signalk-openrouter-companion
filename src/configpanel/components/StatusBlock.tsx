import type { ReactElement } from 'react';
import { memo } from 'react';
import {
  Banner,
  Button,
  Cluster,
  Metric,
  MetricGrid,
  RelativeAge,
  Stack,
  StatusIndicator,
  type StatusTone,
} from 'signalk-nearlcrews-ui';
import type { PanelStatus, TestResult } from '../types.js';
import { useControlHint } from './ControlHint.js';

interface Props {
  status: PanelStatus | null;
  statusError: string | null;
  onTest: () => void;
  testing: boolean;
  testResult: TestResult | null;
  stale: boolean;
  // Epoch milliseconds of the last good status snapshot, or null before the
  // first one. RelativeAge owns the clock from here.
  lastSuccessAt: number | null;
}

function historyLabel(history: PanelStatus['history']): { text: string; tone: StatusTone } {
  if (history.source === 'none') return { text: 'Disabled', tone: 'neutral' };
  if (history.reachable === null) return { text: 'Probing…', tone: 'warning' };
  if (history.reachable) return { text: 'Reachable', tone: 'success' };
  return { text: 'Unreachable', tone: 'danger' };
}

export const StatusBlock = memo(function StatusBlock({
  status,
  statusError,
  onTest,
  testing,
  testResult,
  stale,
  lastSuccessAt,
}: Props): ReactElement {
  // The test spends money the daily cap does not govern, so both facts sit
  // beside the button rather than in the collapsed OpenRouter section where the
  // cap is configured. Read before the branches below, since a hook cannot sit
  // behind an early return.
  const apiKeySet = Boolean(status?.openrouter?.apiKeySet);
  const { hintId: testHintId, hint: testHint } = useControlHint(
    apiKeySet
      ? 'The test makes one paid OpenRouter call, and it does not count against the daily cap.'
      : 'Save an API key to enable this test. It makes one paid OpenRouter call that does not count against the daily cap.',
  );
  // Nothing here is a live region: every element below mounts together with the
  // text it carries, which a screen reader may never observe as a change. The
  // panel speaks the poll failure and the test result through the shell's own
  // regions instead, which is also why this no longer splits into a shell and a
  // loaded body to keep a region mounted across the branches.
  if (statusError && !status) return <Banner tone="danger">{statusError}</Banner>;
  if (!status) return <StatusIndicator tone="info">Loading status…</StatusIndicator>;

  const openrouter: Partial<PanelStatus['openrouter']> = status.openrouter ?? {};
  const history = status.history;
  const historyState = historyLabel(history);
  const historyName =
    history.source === 'questdb'
      ? 'QuestDB'
      : history.source === 'influxdb'
        ? 'InfluxDB'
        : 'History';
  const analyzers = status.analyzers ?? [];
  const enabledCount = analyzers.filter((analyzer) => analyzer.enabled).length;

  return (
    <Stack gap={3}>
      <MetricGrid>
        <Metric
          label="OpenRouter API key"
          value={openrouter.apiKeySet ? 'Configured' : 'Missing'}
          detail={openrouter.apiKeySet ? `Model: ${openrouter.model}` : 'Set a key below'}
          tone={openrouter.apiKeySet ? 'success' : 'danger'}
        />
        <Metric
          label="Calls today"
          value={`${openrouter.callsToday ?? 0} / ${openrouter.maxCallsPerDay ?? 0}`}
          detail="UTC daily cap"
        />
        <Metric
          label="Tokens today"
          value={(openrouter.tokensToday ?? 0).toLocaleString()}
          detail="Prompt and completion"
        />
        <Metric
          label="Estimated cost today"
          value={`$${(openrouter.costToday ?? 0).toFixed(4)}`}
          detail="OpenRouter usage cost"
        />
        <Metric
          label={historyName}
          value={historyState.text}
          detail="Trend history source"
          tone={historyState.tone}
        />
        <Metric
          label="Analyzers"
          value={`${enabledCount} / ${analyzers.length}`}
          detail="Enabled"
        />
      </MetricGrid>
      <Stack gap={2}>
        <Cluster gap={3}>
          <Button
            variant="primary"
            loading={testing}
            loadingLabel="Testing"
            disabled={!openrouter.apiKeySet}
            aria-describedby={testHintId}
            onClick={onTest}
          >
            Test API key
          </Button>
          {testResult ? (
            <StatusIndicator tone={testResult.ok ? 'success' : 'danger'}>
              {testResult.text}
            </StatusIndicator>
          ) : null}
          {stale ? (
            <StatusIndicator tone="warning">
              Status updated <RelativeAge since={lastSuccessAt} />
            </StatusIndicator>
          ) : null}
        </Cluster>
        {testHint}
      </Stack>
    </Stack>
  );
});
