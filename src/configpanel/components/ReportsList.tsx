import type { ReactElement } from 'react';
import {
  Banner,
  Card,
  Code,
  formatCount,
  RelativeAge,
  StatusIndicator,
  Text,
  usePanelLocale,
} from 'signalk-nearlcrews-ui';
import { EmptyState } from 'signalk-nearlcrews-ui/composites';
import { reportTriggerLabel } from '../reportTrigger.js';
import type { AnalyzerUiState, ReportEntry as Report } from '../types.js';
import { formatUsd } from '../utils.js';
import styles from './analyzer.module.css';

interface Props {
  ui: AnalyzerUiState;
}

// The reports drawer's content: the loading state, the failure, the empty
// state, or the newest reports, each entry with its age, trigger, cost, and
// text.
export function ReportsList({ ui }: Props): ReactElement {
  return <Card>{reportsBody(ui)}</Card>;
}

function reportsBody(ui: AnalyzerUiState): ReactElement {
  if (ui.reportsLoading) return <StatusIndicator tone="info">Loading reports…</StatusIndicator>;
  if (ui.reportsError)
    return <Banner tone="danger">Failed to load reports: {ui.reportsError}</Banner>;
  if (!ui.reports || ui.reports.length === 0) {
    return (
      <EmptyState
        title="No reports yet"
        description="This analyzer writes a report the first time it runs."
      />
    );
  }
  return (
    <div className={styles.reportList}>
      {ui.reports.map((report) => (
        <ReportEntry
          // `ts` is an ISO timestamp with milliseconds and the router runs one
          // analyzer at a time, so a repeat of this triple would take two runs
          // completing in the same millisecond.
          key={`${report.ts}-${report.trigger}-${report.engineId ?? ''}`}
          report={report}
        />
      ))}
    </div>
  );
}

function ReportEntry({ report }: { report: Report }): ReactElement {
  const locale = usePanelLocale();
  return (
    <article className={styles.reportEntry}>
      <Text as="div" tone="muted" size="sm">
        <RelativeAge since={report.ts} /> · {reportTriggerLabel(report.trigger)}
        {report.engineId ? ` · Engine ${report.engineId}` : ''}
        {typeof report.durationSec === 'number' ? ` · ${report.durationSec}s session` : ''}
      </Text>
      {report.model ? (
        <Text as="div" tone="muted" size="sm">
          <Code>{report.model}</Code>
          {typeof report.totalTokens === 'number'
            ? ` · ${formatCount(report.totalTokens, 'token', undefined, { locale })}`
            : ''}
          {typeof report.costUsd === 'number' ? ` · ${formatUsd(report.costUsd)}` : ''}
        </Text>
      ) : null}
      {report.report ? (
        <Text as="div" size="sm" className={styles.reportText}>
          {report.report}
        </Text>
      ) : null}
      {report.failure ? (
        <Text as="div" tone="danger" size="sm" className={styles.reportText}>
          Failure: {report.failure}
        </Text>
      ) : null}
    </article>
  );
}
