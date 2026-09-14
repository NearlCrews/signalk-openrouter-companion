import type { ReactElement } from 'react';
import { memo, useCallback } from 'react';
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Cluster,
  Code,
  CollapsibleSection,
  LabeledField,
  RelativeAge,
  Select,
  Stack,
  StatusIndicator,
  Text,
  VisuallyHidden,
} from 'signalk-nearlcrews-ui';
import { EmptyState, useDisclosure } from 'signalk-nearlcrews-ui/composites';
import { SEVERITY_FLOOR_PRESETS } from '../../severityFloors.js';
import { reportTriggerLabel } from '../reportTrigger.js';
import { buildScheduleOptions } from '../scheduleOptions.js';
import type { AnalyzerStatus, AnalyzerUiState } from '../types.js';
import { AnalyzerDrawerBody, AnalyzerDrawerToggle } from './AnalyzerDrawer.js';
import styles from './analyzer.module.css';
import { useControlHint } from './ControlHint.js';
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
  const expanded = Boolean(ui.expanded);
  const reportsOpen = Boolean(ui.reportsOpen);
  const promptOpen = Boolean(ui.promptOpen);
  const cronEnabled = analyzer.cron.enabled;
  const scheduleOptions = buildScheduleOptions(schedule);
  // The cost sits beside the button that spends it, not in a section the
  // operator may never open, and it doubles as the inert button's reason.
  const { hintId: fireHintId, hint: fireHint } = useControlHint(
    enabled
      ? 'Running an analyzer now makes one paid OpenRouter call that counts against the daily cap.'
      : 'Enable this analyzer to fire it. A run makes one paid OpenRouter call that counts against the daily cap.',
  );

  // Bound to the row's analyzer once rather than rebuilt each render: the
  // shared hook memoizes the props it hands to the toggle and the body on this
  // callback's identity, so a fresh arrow every render would rebuild all of
  // them and give the button a new onClick besides.
  const onReports = useCallback(() => onToggleReports(analyzer.id), [onToggleReports, analyzer.id]);
  const onPrompt = useCallback(() => onTogglePrompt(analyzer.id), [onTogglePrompt, analyzer.id]);
  const reportsDrawer = useDisclosure({ open: reportsOpen, onOpenChange: onReports });
  const promptDrawer = useDisclosure({ open: promptOpen, onOpenChange: onPrompt });

  return (
    <CollapsibleSection
      title={analyzer.title}
      actions={
        <Checkbox
          label={
            <>
              <VisuallyHidden>{analyzer.title}: </VisuallyHidden>
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

        <Stack gap={2}>
          <Cluster gap={2}>
            <Button
              variant="primary"
              aria-label={`Fire now for ${analyzer.title}`}
              loading={Boolean(ui.fire?.pending)}
              loadingLabel="Running"
              // aria-disabled rather than disabled: the control keeps focus, so
              // the description below reaches a keyboard user who lands on it.
              ariaDisabled={!enabled}
              aria-describedby={fireHintId}
              onClick={() => onFire(analyzer.id)}
            >
              Fire now
            </Button>
            <AnalyzerDrawerToggle
              drawer={reportsDrawer}
              noun="reports"
              openVerb="View"
              analyzerTitle={analyzer.title}
            />
            <AnalyzerDrawerToggle
              drawer={promptDrawer}
              noun="prompt"
              openVerb="Edit"
              analyzerTitle={analyzer.title}
            />
            {ui.fire?.text ? (
              <StatusIndicator tone={ui.fire.ok ? 'success' : 'danger'}>
                {ui.fire.text}
              </StatusIndicator>
            ) : null}
          </Cluster>
          {fireHint}
        </Stack>

        <AnalyzerDrawerBody drawer={reportsDrawer} label={`Reports for ${analyzer.title}`}>
          <Card>
            {ui.reportsLoading ? (
              <StatusIndicator tone="info">Loading reports…</StatusIndicator>
            ) : ui.reportsError ? (
              <Banner tone="danger">Failed to load reports: {ui.reportsError}</Banner>
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
                    <Text as="div" tone="muted" size="sm">
                      <RelativeAge since={report.ts} /> · {reportTriggerLabel(report.trigger)}
                      {report.engineId ? ` · Engine ${report.engineId}` : ''}
                      {typeof report.durationSec === 'number'
                        ? ` · ${report.durationSec}s session`
                        : ''}
                    </Text>
                    {report.model ? (
                      <Text as="div" tone="muted" size="sm">
                        <Code>{report.model}</Code>
                        {typeof report.totalTokens === 'number'
                          ? ` · ${report.totalTokens.toLocaleString()} tokens`
                          : ''}
                        {typeof report.costUsd === 'number'
                          ? ` · $${report.costUsd.toFixed(4)}`
                          : ''}
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
                ))}
              </div>
            )}
          </Card>
        </AnalyzerDrawerBody>

        <AnalyzerDrawerBody drawer={promptDrawer} label={`Prompt for ${analyzer.title}`}>
          <PromptDrawer
            analyzerId={analyzer.id}
            ui={ui}
            value={promptValue}
            onChange={onPromptChange}
            onReset={onPromptReset}
            // Closing through the disclosure rather than the parent's own
            // toggle is what returns focus to the trigger: a change made by
            // setting `open` directly moves no focus, and this panel unmounts
            // its children on close, so the pressed button would be removed
            // from the document with focus still on it. setOpen still calls
            // onOpenChange, so the parent state stays in step.
            onClose={() => promptDrawer.setOpen(false)}
          />
        </AnalyzerDrawerBody>
      </Stack>
    </CollapsibleSection>
  );
});
