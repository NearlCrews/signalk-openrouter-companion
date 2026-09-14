import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { errText, fetchJson, REPORT_LIMIT } from './api.js';
import { AnalyzerRow } from './components/AnalyzerRow.js';
import { HistorySection } from './components/HistorySection.js';
import { OpenRouterSection } from './components/OpenRouterSection.js';
import { StatusBlock } from './components/StatusBlock.js';
import { fireOutcomeText, isFireSuccess } from './fireOutcome.js';
import { useOpenRouterModels } from './hooks/useOpenRouterModels.js';
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

// One shared empty-ui object so an analyzer with no UI state yet passes a stable
// reference to its (memoized) row instead of a fresh `{}` every render.
const EMPTY_UI: AnalyzerUiState = Object.freeze({});

// The forecast analyzer coerces a saved severity floor that is off the preset
// scale back to the default (see analyzers/forecast.ts), so the dropdown shows
// the same value the plugin is actually running with.
function severityFloorFor(saved: string | undefined): string {
  return isSeverityFloor(saved) ? saved : DEFAULT_SEVERITY_FLOOR_VALUE;
}

// What the reports drawer says once its list settles.
function reportsLoadedText(title: string, count: number): string {
  if (count === 0) return `No reports yet for ${title}.`;
  return count === 1 ? `1 report loaded for ${title}.` : `${count} reports loaded for ${title}.`;
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

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [historyTest, setHistoryTest] = useState<HistoryTestResult | null>(null);
  const [historyTesting, setHistoryTesting] = useState(false);
  const [analyzerUi, setAnalyzerUi] = useState<Record<string, AnalyzerUiState>>({});
  const [validationTarget, setValidationTarget] = useState<
    'api-key' | 'history-url' | 'history-database' | null
  >(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const historyUrlRef = useRef<HTMLInputElement>(null);
  const historyDatabaseRef = useRef<HTMLInputElement>(null);
  const setHistorySection = useCallback(
    (patch: Partial<PanelConfig>): void => {
      setHistoryTest(null);
      setSection(patch);
    },
    [setSection],
  );
  // Mirror of analyzerUi for reads from event handlers without going through the
  // state updater. The updater functions must be pure (StrictMode and concurrent
  // rendering may call them more than once), so any side effect (loadReports,
  // loadPrompt, setTimeout) must run outside them. A ref kept in sync via
  // useEffect gives the handlers the latest committed state without
  // re-introducing the stale-closure bug the functional setters were added to
  // fix.
  const analyzerUiRef = useRef(analyzerUi);
  useEffect(() => {
    analyzerUiRef.current = analyzerUi;
  }, [analyzerUi]);
  // Analyzer titles for the announcements, read from a ref for the same reason:
  // the handlers must not close over `status`, or every poll that changed the
  // payload would rebuild them and re-render every memoized row.
  const titlesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const titles: Record<string, string> = {};
    for (const analyzer of status?.analyzers ?? []) titles[analyzer.id] = analyzer.title;
    titlesRef.current = titles;
  }, [status]);
  const titleFor = useCallback((id: string): string => titlesRef.current[id] ?? id, []);
  // In-flight guard for the two per-analyzer GETs. React 19 StrictMode calls
  // event handlers' state updaters twice in dev; dedup-by-key here prevents
  // double-firing the network request even when the handler runs twice.
  const inFlightRef = useRef<Set<string>>(new Set());
  // Every section starts collapsed so the panel opens compact, showing just the
  // live status and the section headers. One map keyed by section id; the
  // single toggle stays stable so adding a section costs no new callback.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const setSectionOpen = useCallback((id: string, open: boolean): void => {
    setOpenSections((prev) => (Boolean(prev[id]) === open ? prev : { ...prev, [id]: open }));
  }, []);
  // Force a section open (idempotent): the first-run callout uses it to reveal
  // the OpenRouter section. Returns the same map when already open so it adds no
  // render. All writes to openSections funnel through these two named setters.
  const openSection = useCallback((id: string): void => {
    setOpenSections((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
  }, []);
  // Post-fire report refresh timers, one per analyzer so firing a second
  // analyzer cannot cancel the first one's pending refresh. Tracked so every
  // pending timer is cleared on unmount.
  const reportRefreshTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = reportRefreshTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

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

  const patchUi = useCallback((id: string, patch: Partial<AnalyzerUiState>): void => {
    setAnalyzerUi((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  }, []);

  // Shared in-flight dedup for the per-analyzer GETs: skip when a request for
  // the same key is already running, and release the key when it settles.
  const withInFlight = useCallback(async (key: string, fn: () => Promise<void>): Promise<void> => {
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    try {
      await fn();
    } finally {
      inFlightRef.current.delete(key);
    }
  }, []);

  const runTest = useCallback(async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    const r = await fetchJson<{ totalTokens?: number; model?: string }>('/openrouter/test', {
      method: 'POST',
    });
    const text = r.ok && r.body ? `OK (${r.body.totalTokens} tokens, ${r.body.model})` : errText(r);
    setTestResult({ ok: r.ok, text });
    setTesting(false);
    announce(text);
  }, [announce]);

  const historySource = cfg.history?.source ?? 'questdb';
  const questdbUrl = cfg.history?.questdb?.url;
  const influxdbVersion = cfg.history?.influxdb?.version ?? '1';
  const influxdbUrl = cfg.history?.influxdb?.url;
  const influxdbDatabase = cfg.history?.influxdb?.database;
  const influxdbUsername = cfg.history?.influxdb?.username;
  const influxdbPassword = cfg.history?.influxdb?.password;
  const runHistoryTest = useCallback(async (): Promise<void> => {
    if (historySource === 'none') return;
    setHistoryTesting(true);
    setHistoryTest(null);
    const isInfluxDB = historySource === 'influxdb';
    const r = await fetchJson<{
      ok?: boolean;
      url?: string;
      database?: string;
      version?: string;
      error?: string;
    }>(isInfluxDB ? '/influxdb/test' : '/questdb/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        isInfluxDB
          ? {
              version: influxdbVersion,
              url: influxdbUrl,
              database: influxdbDatabase,
              username: influxdbUsername,
              password: influxdbPassword,
            }
          : { url: questdbUrl },
      ),
    });
    const url = r.body?.url ?? '';
    setHistoryTest(r.body?.ok ? { ok: true, url } : { ok: false, text: errText(r) });
    setHistoryTesting(false);
    announce(`History provider test: ${r.body?.ok ? `Reachable at ${url}` : errText(r)}`);
  }, [
    announce,
    historySource,
    influxdbDatabase,
    influxdbPassword,
    influxdbUrl,
    influxdbUsername,
    influxdbVersion,
    questdbUrl,
  ]);

  const loadReports = useCallback(
    (id: string): Promise<void> =>
      withInFlight(`reports:${id}`, async () => {
        patchUi(id, { reportsLoading: true });
        announce(`Loading reports for ${titleFor(id)}.`);
        const r = await fetchJson<{ reports?: AnalyzerUiState['reports'] }>(
          `/analyzers/${id}/reports?limit=${REPORT_LIMIT}`,
        );
        if (r.ok) {
          const reports = r.body?.reports || [];
          patchUi(id, { reports, reportsLoading: false, reportsError: null });
          announce(reportsLoadedText(titleFor(id), reports.length));
        } else {
          // Keep any previously loaded reports rather than clobbering them with
          // an empty list, which would render a false "No reports yet".
          patchUi(id, { reportsLoading: false, reportsError: errText(r) });
          announce(`Failed to load reports for ${titleFor(id)}: ${errText(r)}`);
        }
      }),
    [withInFlight, patchUi, announce, titleFor],
  );

  const fireAnalyzer = useCallback(
    async (id: string): Promise<void> => {
      patchUi(id, { fire: { pending: true } });
      const r = await fetchJson<{ outcome?: string }>(`/analyzers/${id}/fire`, { method: 'POST' });
      const text = r.ok ? fireOutcomeText(r.body?.outcome) : errText(r);
      patchUi(id, { fire: { ok: r.ok && isFireSuccess(r.body?.outcome), text } });
      // The chip beside the button appears with its text, which a screen reader
      // may never observe. The announcer speaks the same words through a region
      // that already existed, and repeats them when a second run ends the same
      // way rather than reading as an unchanged region.
      announce(`${titleFor(id)}: ${text}.`);
      // Refresh the open drawer so the new report shows up after the LLM returns.
      // 800 ms is a heuristic; a real boat round-trip is 1-3 s. Read the live
      // drawer state via the ref: the multi-second fire means the closed-over
      // analyzerUi is stale by the time it resolves.
      if (analyzerUiRef.current[id]?.reportsOpen) {
        const timers = reportRefreshTimersRef.current;
        const pending = timers.get(id);
        if (pending) clearTimeout(pending);
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            void loadReports(id);
          }, 800),
        );
      }
    },
    [patchUi, loadReports, announce, titleFor],
  );

  // A pure expand/collapse write with no side effect, so it funnels through
  // patchUi like every other per-id mutation. The section reports the state it
  // is moving to, so nothing has to be re-derived here.
  const setExpanded = useCallback(
    (id: string, expanded: boolean): void => {
      patchUi(id, { expanded });
    },
    [patchUi],
  );

  const toggleReports = useCallback(
    (id: string): void => {
      const current = analyzerUiRef.current[id];
      const next = !current?.reportsOpen;
      patchUi(id, { reportsOpen: next });
      if (!next) return;
      // A drawer reopened on an already-loaded list still says what is in it,
      // since nothing new arrives to speak for it.
      if (current?.reports) announce(reportsLoadedText(titleFor(id), current.reports.length));
      else void loadReports(id);
    },
    [patchUi, loadReports, announce, titleFor],
  );

  const loadPrompt = useCallback(
    (id: string): Promise<void> =>
      withInFlight(`prompt:${id}`, async () => {
        patchUi(id, { promptLoaded: false, promptError: null });
        announce(`Loading the prompt for ${titleFor(id)}.`);
        const r = await fetchJson<{ default?: string; current?: string | null }>(
          `/analyzers/${id}/prompt`,
        );
        if (r.ok && r.body) {
          patchUi(id, {
            promptDefault: r.body.default,
            promptCurrent: r.body.current,
            promptLoaded: true,
            promptError: null,
          });
          announce(`Prompt loaded for ${titleFor(id)}.`);
        } else {
          patchUi(id, { promptError: errText(r), promptLoaded: true });
          announce(`Failed to load the prompt for ${titleFor(id)}: ${errText(r)}`);
        }
      }),
    [withInFlight, patchUi, announce, titleFor],
  );

  const togglePrompt = useCallback(
    (id: string): void => {
      const current = analyzerUiRef.current[id];
      const next = !current?.promptOpen;
      patchUi(id, { promptOpen: next });
      if (!next) return;
      // Load on first open, and retry on reopen if the previous load failed.
      if (!current?.promptLoaded || current?.promptError) void loadPrompt(id);
      else announce(`Prompt loaded for ${titleFor(id)}.`);
    },
    [patchUi, loadPrompt, announce, titleFor],
  );

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

  const onPromptChange = useCallback(
    (id: string, value: string): void => {
      const def = analyzerUiRef.current[id]?.promptDefault;
      if (!isPromptOverride(value, def)) {
        // Typed back to the built-in default: drop the override so Save does not
        // persist a redundant customSystemPrompt identical to the default.
        setAnalyzerCfg(id, { customSystemPrompt: undefined });
        patchUi(id, { promptCurrent: null });
      } else {
        setAnalyzerCfg(id, { customSystemPrompt: value });
      }
    },
    [setAnalyzerCfg, patchUi],
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

  const noApiKey = !(cfg.openrouter?.apiKey ?? '').trim();
  // One derivation of the history validation state, shared with HistorySection
  // so the save gate and the marked field can never disagree.
  const history = historyValidity(cfg.history);
  const badHistoryUrl = history.noUrl || history.invalidUrl;

  // Open the OpenRouter section and move focus to the API key field, so the
  // first-run callout's button lands the user exactly where they need to type.
  // The rAF is load-bearing on the blocked-save path and is not redundant with
  // the save bar's own focus move: SaveActionBar focuses its status line
  // inline, before it calls onSave, so this frame lands afterwards and wins.
  const focusApiKey = (): void => {
    openSection(SECTION_OPENROUTER);
    requestAnimationFrame(() => {
      apiKeyRef.current?.focus();
    });
  };

  const focusHistoryUrl = (): void => {
    openSection(SECTION_HISTORY);
    requestAnimationFrame(() => {
      historyUrlRef.current?.focus();
    });
  };

  const focusHistoryDatabase = (): void => {
    openSection(SECTION_HISTORY);
    requestAnimationFrame(() => {
      historyDatabaseRef.current?.focus();
    });
  };

  const handleSave = (): void => {
    if (noApiKey) {
      setValidationTarget('api-key');
      focusApiKey();
      return;
    }
    if (badHistoryUrl) {
      setValidationTarget('history-url');
      focusHistoryUrl();
      return;
    }
    if (history.missingDatabase) {
      setValidationTarget('history-database');
      focusHistoryDatabase();
      return;
    }
    setValidationTarget(null);
    saveConfiguration();
  };

  const handleDiscard = (): void => {
    setDiscardConfirmOpen(false);
    setValidationTarget(null);
    discardConfiguration();
  };

  const analyzersList = status?.analyzers ?? [];
  // The first-run callout keys off the edit buffer so it disappears the moment
  // the operator starts typing a key, before any save round-trip.
  const validationText =
    validationTarget === 'api-key' && noApiKey
      ? 'Enter an OpenRouter API key before saving.'
      : validationTarget === 'history-url' && badHistoryUrl
        ? `Enter a valid history-provider ${HISTORY_URL_RULE} before saving.`
        : validationTarget === 'history-database' && history.missingDatabase
          ? 'Enter the InfluxDB database or DBRP database name before saving.'
          : '';

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
          testing={testing}
          testResult={testResult}
          stale={stale}
          lastSuccessAt={lastSuccessAt}
        />
      </Section>

      <CollapsibleSection
        id={SECTION_OPENROUTER}
        title="OpenRouter"
        open={Boolean(openSections[SECTION_OPENROUTER])}
        onOpenChange={(open) => setSectionOpen(SECTION_OPENROUTER, open)}
      >
        <OpenRouterSection
          cfg={cfg}
          set={setSection}
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
        open={Boolean(openSections[SECTION_HISTORY])}
        onOpenChange={(open) => setSectionOpen(SECTION_HISTORY, open)}
      >
        <HistorySection
          cfg={cfg}
          set={setHistorySection}
          testResult={historyTest}
          onTest={runHistoryTest}
          testing={historyTesting}
          urlRef={historyUrlRef}
          databaseRef={historyDatabaseRef}
          submitted={validationTarget === 'history-url' || validationTarget === 'history-database'}
        />
      </CollapsibleSection>

      <CollapsibleSection
        id={SECTION_ANALYZERS}
        title="Analyzers"
        mountStrategy="lazy-retain"
        open={Boolean(openSections[SECTION_ANALYZERS])}
        onOpenChange={(open) => setSectionOpen(SECTION_ANALYZERS, open)}
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
              // by the analyzer, so the dropdown shows the default too rather
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
