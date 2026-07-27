import type { ReactElement, RefObject } from 'react';
import { memo, useEffect, useRef } from 'react';
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
import { SEVERITY_FLOOR_PRESETS } from '../../severityFloors.js';
import { buildScheduleOptions } from '../scheduleOptions.js';
import type { AnalyzerStatus, AnalyzerUiState } from '../types.js';
import styles from './AnalyzerRow.module.css';
import { PromptDrawer } from './PromptDrawer.js';

interface Props {
  analyzer: AnalyzerStatus;
  enabled: boolean;
  setEnabled: (id: string, enabled: boolean) => void;
  ui: AnalyzerUiState;
  onToggleExpand: (id: string) => void;
  onFire: (id: string) => void;
  onToggleReports: (id: string) => void;
  onTogglePrompt: (id: string) => void;
  promptValue: string;
  onPromptChange: (id: string, value: string) => void;
  onPromptReset: (id: string) => void;
  schedule: string;
  onScheduleChange: (id: string, value: string) => void;
  severityFloor?: string;
  onSeverityFloorChange?: (id: string, value: string) => void;
}

function useDrawerFocus(
  open: boolean,
  bodyRef: RefObject<HTMLElement | null>,
  buttonRef: RefObject<HTMLElement | null>,
): void {
  const previousOpen = useRef(open);
  useEffect(() => {
    if (open === previousOpen.current) return;
    previousOpen.current = open;
    if (open) bodyRef.current?.focus();
    else buttonRef.current?.focus();
  }, [open, bodyRef, buttonRef]);
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
  const cronEnabled = Boolean(analyzer.cron?.enabled);
  const scheduleOptions = buildScheduleOptions(schedule);

  const reportsButtonRef = useRef<HTMLButtonElement>(null);
  const promptButtonRef = useRef<HTMLButtonElement>(null);
  const reportsBodyRef = useRef<HTMLDivElement>(null);
  const promptBodyRef = useRef<HTMLDivElement>(null);
  useDrawerFocus(reportsOpen, reportsBodyRef, reportsButtonRef);
  useDrawerFocus(promptOpen, promptBodyRef, promptButtonRef);

  return (
    <CollapsibleSection
      title={
        <Cluster gap={2}>
          <span className={styles.title}>{analyzer.title}</span>
          <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
        </Cluster>
      }
      actions={
        <Checkbox
          label={
            <>
              <span className="snui-visually-hidden">{analyzer.title}: </span>
              Enabled
            </>
          }
          checked={enabled}
          onChange={(event) => setEnabled(analyzer.id, event.target.checked)}
        />
      }
      headingLevel={3}
      open={expanded}
      onOpenChange={() => onToggleExpand(analyzer.id)}
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
              onChange={(event) => onSeverityFloorChange?.(analyzer.id, event.target.value)}
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
            disabled={!enabled}
            title={enabled ? undefined : 'Enable this analyzer to fire it'}
            onClick={() => onFire(analyzer.id)}
          >
            Fire now
          </Button>
          <Button
            ref={reportsButtonRef}
            aria-label={`${reportsOpen ? 'Hide' : 'View'} reports for ${analyzer.title}`}
            aria-expanded={reportsOpen}
            aria-controls={reportsId}
            onClick={() => onToggleReports(analyzer.id)}
          >
            {reportsOpen ? 'Hide reports' : 'View reports'}
          </Button>
          <Button
            ref={promptButtonRef}
            aria-label={`${promptOpen ? 'Hide' : 'Edit'} prompt for ${analyzer.title}`}
            aria-expanded={promptOpen}
            aria-controls={promptId}
            onClick={() => onTogglePrompt(analyzer.id)}
          >
            {promptOpen ? 'Hide prompt' : 'Edit prompt'}
          </Button>
          {ui.fire?.text ? (
            <StatusIndicator
              tone={ui.fire.ok ? 'success' : 'danger'}
              role="status"
              aria-live="polite"
            >
              {ui.fire.text}
            </StatusIndicator>
          ) : null}
        </Cluster>

        <div
          id={reportsId}
          ref={reportsBodyRef}
          className={styles.drawer}
          tabIndex={-1}
          hidden={!reportsOpen}
        >
          {reportsOpen ? (
            <Card>
              {ui.reportsLoading ? (
                <StatusIndicator tone="info" role="status" aria-live="polite">
                  Loading reports...
                </StatusIndicator>
              ) : ui.reportsError ? (
                <Banner tone="danger" live="assertive">
                  Failed to load reports: {ui.reportsError}
                </Banner>
              ) : !ui.reports || ui.reports.length === 0 ? (
                <StatusIndicator tone="neutral">No reports yet for this analyzer.</StatusIndicator>
              ) : (
                <div className={styles.reportList}>
                  {ui.reports.map((report) => (
                    <article
                      key={`${report.ts}-${report.trigger}-${report.engineId ?? ''}`}
                      className={styles.reportEntry}
                    >
                      <div className={styles.reportTimestamp}>
                        {report.ts} · trigger={report.trigger}
                        {report.engineId ? ` · engine=${report.engineId}` : ''}
                        {report.durationSec ? ` · ${report.durationSec}s` : ''}
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
          ) : null}
        </div>

        <div
          id={promptId}
          ref={promptBodyRef}
          className={styles.drawer}
          tabIndex={-1}
          hidden={!promptOpen}
        >
          {promptOpen ? (
            <PromptDrawer
              analyzerId={analyzer.id}
              ui={ui}
              value={promptValue}
              onChange={onPromptChange}
              onReset={onPromptReset}
              onClose={() => onTogglePrompt(analyzer.id)}
            />
          ) : null}
        </div>
      </Stack>
    </CollapsibleSection>
  );
});
