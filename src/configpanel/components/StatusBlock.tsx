import type { ReactElement } from 'react';
import { memo, useId } from 'react';
import {
  Banner,
  Button,
  Cluster,
  LiveRegion,
  Metric,
  MetricGrid,
  RelativeAge,
  Stack,
  StatusIndicator,
  type StatusTone,
  Text,
} from 'signalk-nearlcrews-ui';
import type { PanelStatus, TestResult } from '../types.js';

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

interface LoadedProps {
  status: PanelStatus;
  onTest: () => void;
  testing: boolean;
  testResult: TestResult | null;
  stale: boolean;
  lastSuccessAt: number | null;
}

// The loaded body. Split from the shell so the shell's live regions keep one
// identity across the loading, failed, and loaded branches: a region a screen
// reader can announce is one that already existed when its text changed.
function LoadedStatus({
  status,
  onTest,
  testing,
  testResult,
  stale,
  lastSuccessAt,
}: LoadedProps): ReactElement {
  const testHintId = useId();
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
        {/*
         * The test spends money the daily cap does not govern, so both facts
         * sit beside the button rather than in the collapsed OpenRouter
         * section where the cap is configured.
         */}
        <Text id={testHintId} as="p" tone="muted" size="sm">
          {openrouter.apiKeySet
            ? 'The test makes one paid OpenRouter call, and it does not count against the daily cap.'
            : 'Save an API key to enable this test. It makes one paid OpenRouter call that does not count against the daily cap.'}
        </Text>
      </Stack>
    </Stack>
  );
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
  return (
    <>
      {/*
       * Two regions that outlive every branch below, because a live region
       * created together with its message is not announced reliably. The
       * visible chips and banners carry no `live` of their own.
       *
       * "Loading status" deliberately announces nothing. It renders at mount,
       * where any region carrying it would be brand new and unobservable, and
       * no user action is waiting on it. The one transition worth hearing, the
       * plugin coming back after a save restarts it, is already announced by
       * SaveActionBar's own status line, which is a region that already
       * existed and whose text changes.
       */}
      <LiveRegion live="assertive" message={statusError && !status ? statusError : ''} />
      <LiveRegion message={testResult ? testResult.text : ''} />
      {statusError && !status ? (
        <Banner tone="danger">{statusError}</Banner>
      ) : status ? (
        <LoadedStatus
          status={status}
          onTest={onTest}
          testing={testing}
          testResult={testResult}
          stale={stale}
          lastSuccessAt={lastSuccessAt}
        />
      ) : (
        <StatusIndicator tone="info">Loading status…</StatusIndicator>
      )}
    </>
  );
});
