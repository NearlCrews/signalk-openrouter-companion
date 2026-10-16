import type { ReactElement, RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Banner,
  Button,
  CollapsibleSection,
  InlineConfirm,
  PanelShell,
  Section,
  Stack,
  usePanelAnnouncer,
  useUnsavedChangesGuard,
} from 'signalk-nearlcrews-ui';
import { EmptyState, SaveActionBar } from 'signalk-nearlcrews-ui/composites';
import { DEFAULT_SEVERITY_FLOOR_VALUE, isSeverityFloor } from '../severityFloors.js';
import { errText, fetchJson } from './api.js';
import { AnalyzerRow } from './components/AnalyzerRow.js';
import { HistorySection } from './components/HistorySection.js';
import { OpenRouterSection } from './components/OpenRouterSection.js';
import { StatusBlock } from './components/StatusBlock.js';
import { useAnalyzerActions } from './hooks/useAnalyzerActions.js';
import { useOpenRouterModels } from './hooks/useOpenRouterModels.js';
import { useOpenSections } from './hooks/useOpenSections.js';
import { useProbe } from './hooks/useProbe.js';
import { useSaveLifecycle } from './hooks/useSaveLifecycle.js';
import { useStatus } from './hooks/useStatus.js';
import styles from './panel.module.css';
import type { AnalyzerUiState, HistoryTestResult, PanelConfig, TestResult } from './types.js';
import { HISTORY_URL_RULE, historyValidity, isPromptOverride } from './utils.js';

interface Props {
  configuration: PanelConfig | undefined;
  save: (configuration: PanelConfig) => void;
}

// The collapsible top-level sections, keyed by their DOM ids.
const SECTION_OPENROUTER = 'orc-section-openrouter';
const SECTION_HISTORY = 'orc-section-history';
const SECTION_ANALYZERS = 'orc-section-analyzers';

const SAVE_LABEL = 'Save configuration';

// The field a blocked save points at, and what the save bar says about it.
type ValidationTarget = 'api-key' | 'history-url' | 'history-database';
const VALIDATION_TEXT: Record<ValidationTarget, string> = {
  'api-key': 'Enter an OpenRouter API key before saving.',
  'history-url': `Enter a valid history-provider ${HISTORY_URL_RULE} before saving.`,
  'history-database': 'Enter the InfluxDB database or DBRP database name before saving.',
};

// One shared empty-ui object so an analyzer with no UI state yet passes a stable
// reference to its (memoized) row instead of a fresh `{}` every render.
const EMPTY_UI: AnalyzerUiState = Object.freeze({});

// The forecast analyzer coerces a saved severity floor that is off the preset
// scale back to the default (see validateOptions in types.ts), so the dropdown
// shows the same value the plugin is actually running with.
function severityFloorFor(saved: string | undefined): string {
  return isSeverityFloor(saved) ? saved : DEFAULT_SEVERITY_FLOOR_VALUE;
}

// The shell runs the browser preflight, owns the theme toggle, and wraps the
// content in an error boundary whose secondary action reloads the page on its
// own. The content is a separate component so its polling and save hooks only
// mount on a supported browser and can be remounted by the boundary's "Try
// again".
export default function PluginConfigurationPanel(props: Props): ReactElement {
  return (
    <PanelShell className={styles.shell} themeToggle="end">
      <PanelContent {...props} />
    </PanelShell>
  );
}

function PanelContent({ configuration, save }: Props): ReactElement {
  // The shell mounts one polite and one assertive region before any message
  // exists and hands them out through this hook, which is the whole point: a
  // region created together with its first message is not announced reliably.
  // Nothing in this panel mounts a region of its own; every status change is
  // spoken from the point its result arrives.
  const announce = usePanelAnnouncer();
  const { status, statusError, stale, lastSuccessAt } = useStatus();
  const {
    cfg,
    dirty,
    setSection,
    setAnalyzerCfg,
    setSchedule,
    saving,
    savedNotice,
    noticeText,
    onSave: saveConfiguration,
    onDiscard: discardConfiguration,
  } = useSaveLifecycle(configuration, save, status);
  const { models, modelsState, loadModels } = useOpenRouterModels(announce);
  const { analyzerUi, readUi, patchUi, setExpanded, fireAnalyzer, toggleReports, togglePrompt } =
    useAnalyzerActions(announce, status?.analyzers);
  const sections = useOpenSections();
  const apiTest = useProbe<TestResult>();
  const historyTest = useProbe<HistoryTestResult>();

  const [validationTarget, setValidationTarget] = useState<ValidationTarget | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const historyUrlRef = useRef<HTMLInputElement>(null);
  const historyDatabaseRef = useRef<HTMLInputElement>(null);

  const setOpenRouter = useCallback(
    (openrouter: NonNullable<PanelConfig['openrouter']>): void => setSection({ openrouter }),
    [setSection],
  );
  // An edited history setting invalidates the last connection test's result.
  const { clear: clearHistoryTest } = historyTest;
  const setHistory = useCallback(
    (history: NonNullable<PanelConfig['history']>): void => {
      clearHistoryTest();
      setSection({ history });
    },
    [setSection, clearHistoryTest],
  );

  // A save restarts the plugin, so lost edits are costly: ask before a tab
  // close or reload while edits are unsaved.
  useUnsavedChangesGuard(dirty);

  // The two failures that arrive from a poll or from the host rather than from
  // a handler of this panel's own. Both interrupt: the plugin is not answering,
  // or the edits were not taken. The effect runs only when the text or the
  // notice actually changes, so a poll that keeps failing the same way is not
  // read out again and again.
  const savedError = savedNotice?.error;
  useEffect(() => {
    if (savedError) announce(noticeText, { assertive: true });
  }, [savedError, noticeText, announce]);
  const pluginUnreachable = statusError && !status ? statusError : '';
  useEffect(() => {
    if (pluginUnreachable) announce(pluginUnreachable, { assertive: true });
  }, [pluginUnreachable, announce]);

  const { run: runApiTest } = apiTest;
  const runTest = useCallback(async (): Promise<void> => {
    const outcome = await runApiTest(async () => {
      const r = await fetchJson<{ totalTokens?: number; model?: string }>('/openrouter/test', {
        method: 'POST',
      });
      const text =
        r.ok && r.body ? `OK (${r.body.totalTokens} tokens, ${r.body.model})` : errText(r);
      return { ok: r.ok, text };
    });
    if (outcome) announce(outcome.text);
  }, [runApiTest, announce]);

  const { run: runHistoryProbe } = historyTest;
  const history = cfg.history;
  const runHistoryTest = useCallback(async (): Promise<void> => {
    const source = history?.source ?? 'questdb';
    if (source === 'none') return;
    const outcome = await runHistoryProbe(async (): Promise<HistoryTestResult> => {
      const isInfluxDB = source === 'influxdb';
      const r = await fetchJson<{ ok?: boolean; url?: string; error?: string }>(
        isInfluxDB ? '/influxdb/test' : '/questdb/test',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            isInfluxDB
              ? {
                  version: history?.influxdb?.version ?? '1',
                  url: history?.influxdb?.url,
                  database: history?.influxdb?.database,
                  username: history?.influxdb?.username,
                  password: history?.influxdb?.password,
                }
              : { url: history?.questdb?.url },
          ),
        },
      );
      return r.body?.ok ? { ok: true, url: r.body.url ?? '' } : { ok: false, text: errText(r) };
    });
    if (outcome) {
      announce(
        `History provider test: ${outcome.ok ? `Reachable at ${outcome.url}` : outcome.text}`,
      );
    }
  }, [runHistoryProbe, announce, history]);

  const handleSetEnabled = useCallback(
    (id: string, value: boolean): void => setAnalyzerCfg(id, { enabled: value }),
    [setAnalyzerCfg],
  );

  const handleSeverityFloorChange = useCallback(
    (id: string, value: string): void => setAnalyzerCfg(id, { severityFloor: value }),
    [setAnalyzerCfg],
  );

  const onPromptReset = useCallback(
    (id: string): void => {
      setAnalyzerCfg(id, { customSystemPrompt: undefined });
      patchUi(id, { promptCurrent: null });
    },
    [setAnalyzerCfg, patchUi],
  );

  // The built-in default is read off the latest analyzer UI state, not closed
  // over, so the callback stays stable across every keystroke.
  const onPromptChange = useCallback(
    (id: string, value: string): void => {
      const def = readUi(id)?.promptDefault;
      if (!isPromptOverride(value, def)) {
        // Typed back to the built-in default: drop the override so Save does not
        // persist a redundant customSystemPrompt identical to the default.
        setAnalyzerCfg(id, { customSystemPrompt: undefined });
        patchUi(id, { promptCurrent: null });
      } else {
        setAnalyzerCfg(id, { customSystemPrompt: value });
      }
    },
    [setAnalyzerCfg, patchUi, readUi],
  );

  // Single source of truth for the prompt edit buffer: the cfg object. The
  // textarea value is derived from cfg.analyzers[id].customSystemPrompt
  // (override), or analyzerUi[id].promptCurrent (saved override from server), or
  // promptDefault (built-in).
  const promptValueFor = (id: string): string => {
    const overlay = cfg.analyzers?.[id]?.customSystemPrompt;
    if (overlay !== undefined) return overlay;
    const ui = analyzerUi[id];
    return ui?.promptCurrent ?? ui?.promptDefault ?? '';
  };

  // The first-run callout keys off the edit buffer so it disappears the moment
  // the operator starts typing a key, before any save round-trip.
  const noApiKey = !(cfg.openrouter?.apiKey ?? '').trim();
  // One derivation of the history validation state, shared with HistorySection
  // so the save gate and the marked field can never disagree.
  const validity = historyValidity(cfg.history);
  const badHistoryUrl = validity.noUrl || validity.invalidUrl;

  // Open a section and hand back the field inside it. The reveal commits inside
  // flushSync, so the field is connected and visible when the caller focuses it
  // or returns it to the save bar, which focuses a returned target once the
  // handler has run.
  const revealField = (
    sectionId: string,
    ref: RefObject<HTMLInputElement | null>,
  ): RefObject<HTMLInputElement | null> => {
    flushSync(() => sections.setOpen(sectionId, true));
    return ref;
  };

  // The first-run callout's button lands the user exactly where they need to
  // type.
  const focusApiKey = (): void => {
    revealField(SECTION_OPENROUTER, apiKeyRef).current?.focus();
  };

  const handleSave = (): RefObject<HTMLInputElement | null> | undefined => {
    if (noApiKey) {
      setValidationTarget('api-key');
      return revealField(SECTION_OPENROUTER, apiKeyRef);
    }
    if (badHistoryUrl) {
      setValidationTarget('history-url');
      return revealField(SECTION_HISTORY, historyUrlRef);
    }
    if (validity.missingDatabase) {
      setValidationTarget('history-database');
      return revealField(SECTION_HISTORY, historyDatabaseRef);
    }
    setValidationTarget(null);
    saveConfiguration();
    return undefined;
  };

  const handleDiscard = (): void => {
    setDiscardConfirmOpen(false);
    setValidationTarget(null);
    discardConfiguration();
  };

  const analyzersList = status?.analyzers ?? [];
  // A blocked save's message stands only while the field is still wrong, so
  // fixing it clears the save bar's complaint before the next save attempt.
  const stillInvalid: Record<ValidationTarget, boolean> = {
    'api-key': noApiKey,
    'history-url': badHistoryUrl,
    'history-database': validity.missingDatabase,
  };
  const validationText =
    validationTarget && stillInvalid[validationTarget] ? VALIDATION_TEXT[validationTarget] : '';

  return (
    <>
      {noApiKey ? (
        <Banner
          tone="info"
          title="OpenRouter setup required"
          actions={
            <Button variant="primary" size="compact" onClick={focusApiKey}>
              Add API key
            </Button>
          }
        >
          No OpenRouter API key set yet. Add one in the OpenRouter section to start the plugin.
        </Banner>
      ) : null}

      <Section title="Live status">
        <StatusBlock
          status={status}
          statusError={statusError}
          onTest={runTest}
          testing={apiTest.pending}
          testResult={apiTest.result}
          stale={stale}
          // Every good poll moves the timestamp, and the block shows it only
          // while the snapshot is stale, so a healthy poll leaves the memoized
          // block's props unchanged.
          lastSuccessAt={stale ? lastSuccessAt : null}
        />
      </Section>

      <CollapsibleSection
        id={SECTION_OPENROUTER}
        title="OpenRouter"
        open={sections.isOpen(SECTION_OPENROUTER)}
        onOpenChange={(open) => sections.setOpen(SECTION_OPENROUTER, open)}
      >
        <OpenRouterSection
          openrouter={cfg.openrouter}
          setOpenRouter={setOpenRouter}
          models={models}
          modelsState={modelsState}
          loadModels={loadModels}
          apiKeyRef={apiKeyRef}
          submitted={validationTarget === 'api-key'}
        />
      </CollapsibleSection>

      <CollapsibleSection
        id={SECTION_HISTORY}
        title="History source"
        open={sections.isOpen(SECTION_HISTORY)}
        onOpenChange={(open) => sections.setOpen(SECTION_HISTORY, open)}
      >
        <HistorySection
          history={cfg.history}
          setHistory={setHistory}
          testResult={historyTest.result}
          onTest={runHistoryTest}
          testing={historyTest.pending}
          urlRef={historyUrlRef}
          databaseRef={historyDatabaseRef}
          submitted={validationTarget === 'history-url' || validationTarget === 'history-database'}
        />
      </CollapsibleSection>

      <CollapsibleSection
        id={SECTION_ANALYZERS}
        title="Analyzers"
        mountStrategy="lazy-retain"
        open={sections.isOpen(SECTION_ANALYZERS)}
        onOpenChange={(open) => sections.setOpen(SECTION_ANALYZERS, open)}
      >
        <Stack gap={2}>
          {analyzersList.length === 0 ? (
            <EmptyState
              title={status ? 'No analyzers reported' : 'Waiting for the plugin'}
              description={
                status
                  ? 'The plugin is running but reported no analyzers.'
                  : 'The analyzer list loads once the plugin is running.'
              }
            />
          ) : null}
          {analyzersList.map((analyzer) => (
            <AnalyzerRow
              key={analyzer.id}
              analyzer={analyzer}
              enabled={cfg.analyzers?.[analyzer.id]?.enabled ?? analyzer.enabled}
              setEnabled={handleSetEnabled}
              ui={analyzerUi[analyzer.id] ?? EMPTY_UI}
              onToggleExpand={setExpanded}
              onFire={fireAnalyzer}
              onToggleReports={toggleReports}
              onTogglePrompt={togglePrompt}
              promptValue={promptValueFor(analyzer.id)}
              onPromptChange={onPromptChange}
              onPromptReset={onPromptReset}
              schedule={
                cfg.analyzers?.[analyzer.id]?.triggers?.cron?.pattern ?? analyzer.cron.pattern
              }
              onScheduleChange={setSchedule}
              // A saved value off the preset scale is coerced to the default
              // by the plugin, so the dropdown shows the default too rather
              // than blanking on a value the plugin is not using.
              severityFloor={
                analyzer.hasSeverityFloor
                  ? severityFloorFor(cfg.analyzers?.[analyzer.id]?.severityFloor)
                  : undefined
              }
              onSeverityFloorChange={handleSeverityFloorChange}
            />
          ))}
        </Stack>
      </CollapsibleSection>

      {savedNotice?.error ? (
        // The edits are still in the buffer after a failed save, so the save
        // bar keeps reporting them as unsaved; the failure itself stays on
        // screen until the next save or discard.
        <Banner tone="danger">{noticeText}</Banner>
      ) : null}

      <InlineConfirm
        // Closes itself if the buffer goes clean while it is open, so it
        // cannot ask about edits that no longer exist.
        open={discardConfirmOpen && dirty}
        title="Discard unsaved changes?"
        message="Every unsaved edit in this panel is reverted, including prompt overrides."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onCancel={() => setDiscardConfirmOpen(false)}
        onConfirm={handleDiscard}
      />

      <SaveActionBar
        data-panel-action-bar=""
        dirty={dirty}
        saving={saving}
        // Once the host has taken the save, the status line reads the request
        // time while the plugin restarts and the completion once the restart is
        // seen, until the notice retires and the bar falls back to its clean
        // wording. While the save is still in flight the bar's own "Saving
        // changes" covers both the status and the busy Save button.
        saveRequestedAt={savedNotice && !savedNotice.error ? savedNotice.requestedAt : null}
        // The panel ends the saved window on the restart it watches for, not on
        // a clock, so the bar holds the message until the request timestamp
        // clears rather than retiring it after its own default.
        savedMessageDurationMs={0}
        labels={{ save: SAVE_LABEL, saved: noticeText }}
        invalidMessage={validationText || null}
        onSave={handleSave}
        onDiscard={() => setDiscardConfirmOpen(true)}
      />
    </>
  );
}
