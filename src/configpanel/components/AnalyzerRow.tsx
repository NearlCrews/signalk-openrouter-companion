import type { ReactElement } from 'react';
import { memo } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Cluster,
  CollapsibleSection,
  LabeledField,
  Select,
  Stack,
  StatusIndicator,
} from 'signalk-nearlcrews-ui';
import { EmptyState } from 'signalk-nearlcrews-ui/composites';
import { SEVERITY_FLOOR_PRESETS } from '../../severityFloors.js';
import { buildScheduleOptions } from '../scheduleOptions.js';
import type { AnalyzerStatus, AnalyzerUiState } from '../types.js';
import { AnalyzerDrawerBody, AnalyzerDrawerToggle, useAnalyzerDrawer } from './AnalyzerDrawer.js';
import styles from './analyzer.module.css';
import { PromptDrawer } from './PromptDrawer.js';

interface Props {
  analyzer: AnalyzerStatus;
  enabled: boolean;
  setEnabled: (id: string, enabled: boolean) => void;
  ui: AnalyzerUiState;
  onToggleExpand: (id: string, expanded: boolean) => void;
  onFire: (id: string) => void;
  onToggleReports: (id: string) => void;
  onTogglePrompt: (id: string) => void;
  promptValue: string;
  onPromptChange: (id: string, value: string) => void;
  onPromptReset: (id: string) => void;
  schedule: string;
  onScheduleChange: (id: string, value: string) => void;
  severityFloor?: string;
  onSeverityFloorChange: (id: string, value: string) => void;
}

export const AnalyzerRow = memo(function AnalyzerRow({
  analyzer,
  enabled,
  setEnabled,
  ui,
  onToggleExpand,
  onFire,
  onToggleReports,
  onTogglePrompt,
  promptValue,
  onPromptChange,
  onPromptReset,
  schedule,
  onScheduleChange,
  severityFloor,
  onSeverityFloorChange,
}: Props): ReactElement {
  const reportsId = `orc-reports-${analyzer.id}`;
  const promptId = `orc-prompt-body-${analyzer.id}`;
  const expanded = Boolean(ui.expanded);
  const reportsOpen = Boolean(ui.reportsOpen);
  const promptOpen = Boolean(ui.promptOpen);
  const cronEnabled = analyzer.cron.enabled;
  const scheduleOptions = buildScheduleOptions(schedule);

  const { buttonRef: reportsButtonRef, bodyRef: reportsBodyRef } = useAnalyzerDrawer(reportsOpen);
  const { buttonRef: promptButtonRef, bodyRef: promptBodyRef } = useAnalyzerDrawer(promptOpen);

  return (
    <CollapsibleSection
      title={<span className={styles.title}>{analyzer.title}</span>}
      // The enabled state rides in the summary rather than the title: a summary
      // renders outside the toggle button, so ticking the checkbox does not
      // rewrite the disclosure's accessible name.
      summary={
        <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
      }
      summaryPlacement="header"
      summaryVisibility="always"
      actions={
        <Checkbox
          label={
            <>
              <span className={styles.visuallyHidden}>{analyzer.title}: </span>
              Enabled
            </>
          }
          checked={enabled}
          onChange={(event) => setEnabled(analyzer.id, event.target.checked)}
        />
      }
      headingLevel={3}
      open={expanded}
      onOpenChange={(open) => onToggleExpand(analyzer.id, open)}
    >
      <Stack gap={3}>
        {cronEnabled ? (
          <LabeledField
            label="Frequency"
            description="Scheduled run frequency."
            layout="inline"
            density="compact"
          >
            <Select
              value={schedule}
              onChange={(event) => onScheduleChange(analyzer.id, event.target.value)}
            >
              {scheduleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </LabeledField>
        ) : (
          <StatusIndicator tone="neutral">
            Event-driven: runs from boat events instead of a schedule.
          </StatusIndicator>
        )}

        {severityFloor !== undefined ? (
          <LabeledField
            label="Severity floor"
            description="The lowest forecast deterioration level that raises an alert."
            layout="inline"
            density="compact"
          >
            <Select
              value={severityFloor}
              onChange={(event) => onSeverityFloorChange(analyzer.id, event.target.value)}
            >
              {SEVERITY_FLOOR_PRESETS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </LabeledField>
        ) : null}

        <Cluster gap={2}>
          <Button
            variant="primary"
            aria-label={`Fire now for ${analyzer.title}`}
            loading={Boolean(ui.fire?.pending)}
            loadingLabel="Running"
            // aria-disabled rather than disabled: the control keeps focus and
            // its title, so the reason it is inert reaches keyboard users.
            ariaDisabled={!enabled}
            title={enabled ? undefined : 'Enable this analyzer to fire it'}
            onClick={() => onFire(analyzer.id)}
          >
            Fire now
          </Button>
          <AnalyzerDrawerToggle
            buttonRef={reportsButtonRef}
            bodyId={reportsId}
            open={reportsOpen}
            noun="reports"
            openVerb="View"
            analyzerTitle={analyzer.title}
            onToggle={() => onToggleReports(analyzer.id)}
          />
          <AnalyzerDrawerToggle
            buttonRef={promptButtonRef}
            bodyId={promptId}
            open={promptOpen}
            noun="prompt"
            openVerb="Edit"
            analyzerTitle={analyzer.title}
            onToggle={() => onTogglePrompt(analyzer.id)}
          />
          {ui.fire?.text ? (
            <StatusIndicator tone={ui.fire.ok ? 'success' : 'danger'} live="polite">
              {ui.fire.text}
            </StatusIndicator>
          ) : null}
        </Cluster>

        <AnalyzerDrawerBody bodyRef={reportsBodyRef} bodyId={reportsId} open={reportsOpen}>
          <Card>
            {ui.reportsLoading ? (
              <StatusIndicator tone="info" live="polite">
                Loading reports...
              </StatusIndicator>
            ) : ui.reportsError ? (
              <Banner tone="danger" live="assertive">
                Failed to load reports: {ui.reportsError}
              </Banner>
            ) : !ui.reports || ui.reports.length === 0 ? (
              <EmptyState
                title="No reports yet"
                description="This analyzer writes a report the first time it runs."
              />
            ) : (
              <div className={styles.reportList}>
                {ui.reports.map((report) => (
                  <article
                    // `ts` is an ISO timestamp with milliseconds and the router
                    // runs one analyzer at a time, so a repeat of this triple
                    // would take two runs completing in the same millisecond.
                    key={`${report.ts}-${report.trigger}-${report.engineId ?? ''}`}
                    className={styles.reportEntry}
                  >
                    <div className={styles.reportTimestamp}>
                      {report.ts} · trigger={report.trigger}
                      {report.engineId ? ` · engine=${report.engineId}` : ''}
                      {typeof report.durationSec === 'number' ? ` · ${report.durationSec}s` : ''}
                    </div>
                    {report.model ? (
                      <div className={styles.reportMetadata}>
                        {report.model}
                        {typeof report.totalTokens === 'number'
                          ? ` · ${report.totalTokens.toLocaleString()} tokens`
                          : ''}
                        {typeof report.costUsd === 'number'
                          ? ` · $${report.costUsd.toFixed(4)}`
                          : ''}
                      </div>
                    ) : null}
                    {report.report ? (
                      <div className={styles.reportBody}>{report.report}</div>
                    ) : null}
                    {report.failure ? (
                      <div className={styles.reportFailure}>Failure: {report.failure}</div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </Card>
        </AnalyzerDrawerBody>

        <AnalyzerDrawerBody bodyRef={promptBodyRef} bodyId={promptId} open={promptOpen}>
          <PromptDrawer
            analyzerId={analyzer.id}
            ui={ui}
            value={promptValue}
            onChange={onPromptChange}
            onReset={onPromptReset}
            onClose={() => onTogglePrompt(analyzer.id)}
          />
        </AnalyzerDrawerBody>
      </Stack>
    </CollapsibleSection>
  );
});
