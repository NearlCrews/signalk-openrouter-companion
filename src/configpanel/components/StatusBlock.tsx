import type { ReactElement } from 'react';
import { memo } from 'react';
import {
  Banner,
  Button,
  Cluster,
  Metric,
  MetricGrid,
  Stack,
  StatusIndicator,
  type StatusTone,
} from 'signalk-nearlcrews-ui';
import { humanizeAgo } from '../recency.js';
import type { PanelStatus, TestResult } from '../types.js';

interface Props {
  status: PanelStatus | null;
  statusError: string | null;
  onTest: () => void;
  testing: boolean;
  testResult: TestResult | null;
  stale: boolean;
  staleAgeMs: number | undefined;
}

function questdbLabel(qdb: PanelStatus['questdb']): { text: string; tone: StatusTone } {
  if (!qdb.enabled) return { text: 'Disabled', tone: 'neutral' };
  if (qdb.reachable === null) return { text: 'Probing...', tone: 'warning' };
  if (qdb.reachable) return { text: 'Reachable', tone: 'success' };
  return { text: 'Unreachable', tone: 'danger' };
}

export const StatusBlock = memo(function StatusBlock({
  status,
  statusError,
  onTest,
  testing,
  testResult,
  stale,
  staleAgeMs,
}: Props): ReactElement {
  if (statusError && !status) {
    return (
      <Banner tone="danger" live="assertive">
        {statusError}
      </Banner>
    );
  }
  if (!status) {
    return (
      <StatusIndicator tone="info" role="status" aria-live="polite">
        Loading status...
      </StatusIndicator>
    );
  }

  const openrouter: Partial<PanelStatus['openrouter']> = status.openrouter ?? {};
  const questdb: PanelStatus['questdb'] = status.questdb ?? {
    enabled: false,
    reachable: null,
  };
  const questdbState = questdbLabel(questdb);
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
          label="QuestDB"
          value={questdbState.text}
          detail={questdb.enabled ? 'Trend analyzers depend on this' : 'Trend analyzers will skip'}
          tone={questdbState.tone}
        />
        <Metric
          label="Analyzers"
          value={`${enabledCount} / ${analyzers.length}`}
          detail="Enabled"
        />
      </MetricGrid>
      <Cluster gap={3}>
        <Button
          variant="primary"
          loading={testing}
          loadingLabel="Testing"
          disabled={!openrouter.apiKeySet}
          title={openrouter.apiKeySet ? undefined : 'Set and save an API key first'}
          onClick={onTest}
        >
          Test API key
        </Button>
        {!openrouter.apiKeySet ? (
          <StatusIndicator tone="neutral">Save an API key to enable this test.</StatusIndicator>
        ) : null}
        {testResult ? (
          <StatusIndicator
            tone={testResult.ok ? 'success' : 'danger'}
            role="status"
            aria-live="polite"
          >
            {testResult.text}
          </StatusIndicator>
        ) : null}
        {stale ? (
          <StatusIndicator tone="warning">Status updated {humanizeAgo(staleAgeMs)}</StatusIndicator>
        ) : null}
      </Cluster>
    </Stack>
  );
});
