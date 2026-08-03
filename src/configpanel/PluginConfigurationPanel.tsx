import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionBar,
  Banner,
  Button,
  Cluster,
  CollapsibleSection,
  PanelRoot,
  Section,
  Stack,
  StatusIndicator,
  type StatusTone,
  supportsNativeCssScope,
  ThemeToggle,
} from 'signalk-nearlcrews-ui';
import { DEFAULT_SEVERITY_FLOOR_VALUE } from '../severityFloors.js';
import { errText, fetchJson, REPORT_LIMIT } from './api.js';
import { AnalyzerRow } from './components/AnalyzerRow.js';
import { OpenRouterSection } from './components/OpenRouterSection.js';
import { QuestDBSection } from './components/QuestDBSection.js';
import { StatusBlock } from './components/StatusBlock.js';
import { fireOutcomeText, isFireSuccess } from './fireOutcome.js';
import { useOpenRouterModels } from './hooks/useOpenRouterModels.js';
import { useSaveLifecycle } from './hooks/useSaveLifecycle.js';
import { useStatus } from './hooks/useStatus.js';
import type { AnalyzerUiState, PanelConfig, QdbTestResult, TestResult } from './types.js';
import { isHttpUrl, isPromptOverride } from './utils.js';

interface Props {
  configuration: PanelConfig | undefined;
  save: (configuration: PanelConfig) => void;
}

// The collapsible top-level sections, keyed by their DOM ids.
const SECTION_OPENROUTER = 'orc-section-openrouter';
const SECTION_QUESTDB = 'orc-section-questdb';
const SECTION_ANALYZERS = 'orc-section-analyzers';

// One shared empty-ui object so an analyzer with no UI state yet passes a stable
// reference to its (memoized) row instead of a fresh `{}` every render.
const EMPTY_UI: AnalyzerUiState = Object.freeze({});

export default function PluginConfigurationPanel(props: Props): ReactElement {
  if (!supportsNativeCssScope(window)) {
    return (
      <div data-browser-compatibility-message="" role="alert">
        <h2>Browser update required</h2>
        <p>
          This panel requires native CSS @scope. Update the browser or embedded WebView before
          reopening Signal K Admin.
        </p>
      </div>
    );
  }

  return <SupportedPluginConfigurationPanel {...props} />;
}

function SupportedPluginConfigurationPanel({ configuration, save }: Props): ReactElement {
  const { status, statusError, stale, staleAgeMs } = useStatus();
  const {
    cfg,
    dirty,
    setSection,
    setAnalyzerCfg,
    setSchedule,
    saving,
    savedNotice,
    noticeText,
    savedNoticeRef,
    onSave: saveConfiguration,
    onDiscard: discardConfiguration,
  } = useSaveLifecycle(configuration, save, status);
  const { models, modelsState, loadModels } = useOpenRouterModels();

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [qdbTest, setQdbTest] = useState<QdbTestResult | null>(null);
  const [qdbTesting, setQdbTesting] = useState(false);
  const [analyzerUi, setAnalyzerUi] = useState<Record<string, AnalyzerUiState>>({});
  const [validationTarget, setValidationTarget] = useState<'api-key' | 'questdb-url' | null>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const questdbUrlRef = useRef<HTMLInputElement>(null);
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
  // Post-fire report refresh timer, tracked so it is cleared on unmount.
  const reportRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (reportRefreshTimerRef.current) clearTimeout(reportRefreshTimerRef.current);
    };
  }, []);

  // Warn before a tab close or reload while edits are unsaved (a save restarts
  // the plugin, so lost edits are costly). Registered only while dirty.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      // Legacy browsers require a returnValue to trigger the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

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
    setTestResult(
      r.ok && r.body
        ? { ok: true, text: `OK (${r.body.totalTokens} tokens, ${r.body.model})` }
        : { ok: false, text: errText(r) },
    );
    setTesting(false);
  }, []);

  const qdbUrl = cfg.questdb?.url;
  const runQdbTest = useCallback(async (): Promise<void> => {
    setQdbTesting(true);
    setQdbTest(null);
    const r = await fetchJson<{ ok?: boolean; url?: string; error?: string }>('/questdb/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: qdbUrl }),
    });
    setQdbTest(r.body?.ok ? { ok: true, url: r.body.url ?? '' } : { ok: false, text: errText(r) });
    setQdbTesting(false);
  }, [qdbUrl]);

  const loadReports = useCallback(
    (id: string): Promise<void> =>
      withInFlight(`reports:${id}`, async () => {
        patchUi(id, { reportsLoading: true });
        const r = await fetchJson<{ reports?: AnalyzerUiState['reports'] }>(
          `/analyzers/${id}/reports?limit=${REPORT_LIMIT}`,
        );
        if (r.ok) {
          patchUi(id, {
            reports: r.body?.reports || [],
            reportsLoading: false,
            reportsError: null,
          });
        } else {
          // Keep any previously loaded reports rather than clobbering them with
          // an empty list, which would render a false "No reports yet".
          patchUi(id, { reportsLoading: false, reportsError: errText(r) });
        }
      }),
    [withInFlight, patchUi],
  );

  const fireAnalyzer = useCallback(
    async (id: string): Promise<void> => {
      patchUi(id, { fire: { pending: true } });
      const r = await fetchJson<{ outcome?: string }>(`/analyzers/${id}/fire`, { method: 'POST' });
      patchUi(id, {
        fire: r.ok
          ? { ok: isFireSuccess(r.body?.outcome), text: fireOutcomeText(r.body?.outcome) }
          : { ok: false, text: errText(r) },
      });
      // Refresh the open drawer so the new report shows up after the LLM returns.
      // 800 ms is a heuristic; a real boat round-trip is 1-3 s. Read the live
      // drawer state via the ref: the multi-second fire means the closed-over
      // analyzerUi is stale by the time it resolves.
      if (analyzerUiRef.current[id]?.reportsOpen) {
        if (reportRefreshTimerRef.current) clearTimeout(reportRefreshTimerRef.current);
        reportRefreshTimerRef.current = setTimeout(() => loadReports(id), 800);
      }
    },
    [patchUi, loadReports],
  );

  // A pure expand/collapse toggle with no side effect, so it funnels through
  // patchUi like every other per-id mutation. Reads the live value off the ref
  // (kept in sync above) so a rapid double-click toggles from the committed
  // state, not a stale closure.
  const toggleExpand = useCallback(
    (id: string): void => {
      patchUi(id, { expanded: !analyzerUiRef.current[id]?.expanded });
    },
    [patchUi],
  );

  const toggleReports = useCallback(
    (id: string): void => {
      const next = !analyzerUiRef.current[id]?.reportsOpen;
      patchUi(id, { reportsOpen: next });
      if (next && !analyzerUiRef.current[id]?.reports) void loadReports(id);
    },
    [patchUi, loadReports],
  );

  const loadPrompt = useCallback(
    (id: string): Promise<void> =>
      withInFlight(`prompt:${id}`, async () => {
        patchUi(id, { promptLoaded: false, promptError: null });
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
        } else {
          patchUi(id, { promptError: errText(r), promptLoaded: true });
        }
      }),
    [withInFlight, patchUi],
  );

  const togglePrompt = useCallback(
    (id: string): void => {
      const current = analyzerUiRef.current[id];
      const next = !current?.promptOpen;
      patchUi(id, { promptOpen: next });
      // Load on first open, and retry on reopen if the previous load failed.
      if (next && (!current?.promptLoaded || current?.promptError)) void loadPrompt(id);
    },
    [patchUi, loadPrompt],
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
  const invalidQuestDbUrl = Boolean(cfg.questdb?.enabled) && !isHttpUrl(cfg.questdb?.url);

  // Open the OpenRouter section and move focus to the API key field, so the
  // first-run callout's button lands the user exactly where they need to type.
  const focusApiKey = (): void => {
    openSection(SECTION_OPENROUTER);
    requestAnimationFrame(() => {
      apiKeyRef.current?.focus();
    });
  };

  const focusQuestDbUrl = (): void => {
    openSection(SECTION_QUESTDB);
    requestAnimationFrame(() => {
      questdbUrlRef.current?.focus();
    });
  };

  const handleSave = (): void => {
    if (noApiKey) {
      setValidationTarget('api-key');
      focusApiKey();
      return;
    }
    if (invalidQuestDbUrl) {
      setValidationTarget('questdb-url');
      focusQuestDbUrl();
      return;
    }
    setValidationTarget(null);
    saveConfiguration();
  };

  const handleDiscard = (): void => {
    setValidationTarget(null);
    discardConfiguration();
  };

  const analyzersList = status?.analyzers ?? [];
  // The first-run callout keys off the edit buffer so it disappears the moment
  // the operator starts typing a key, before any save round-trip.
  const validationText =
    validationTarget === 'api-key' && noApiKey
      ? 'Enter an OpenRouter API key before saving.'
      : validationTarget === 'questdb-url' && invalidQuestDbUrl
        ? 'Enter a valid QuestDB HTTP or HTTPS base URL without a query or fragment before saving.'
        : '';
  const saveStatusTone: StatusTone = validationText
    ? 'danger'
    : savedNotice?.error
      ? 'danger'
      : savedNotice?.phase === 'done'
        ? 'success'
        : savedNotice
          ? 'info'
          : dirty
            ? 'warning'
            : 'neutral';
  const saveStatusText =
    validationText || noticeText || (dirty ? 'Unsaved changes' : 'No unsaved changes');

  return (
    <PanelRoot>
      <Stack gap={4}>
        <Cluster justify="end">
          <ThemeToggle />
        </Cluster>

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
            staleAgeMs={staleAgeMs}
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
          />
        </CollapsibleSection>

        <CollapsibleSection
          id={SECTION_QUESTDB}
          title="QuestDB enrichment"
          open={Boolean(openSections[SECTION_QUESTDB])}
          onOpenChange={(open) => setSectionOpen(SECTION_QUESTDB, open)}
        >
          <QuestDBSection
            cfg={cfg}
            set={setSection}
            testResult={qdbTest}
            onTest={runQdbTest}
            testing={qdbTesting}
            urlRef={questdbUrlRef}
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
              <StatusIndicator tone="neutral">
                {status
                  ? 'No analyzers reported by the plugin yet.'
                  : 'Analyzer list loads once the plugin is running.'}
              </StatusIndicator>
            ) : null}
            {analyzersList.map((analyzer) => (
              <AnalyzerRow
                key={analyzer.id}
                analyzer={analyzer}
                enabled={cfg.analyzers?.[analyzer.id]?.enabled ?? analyzer.enabled}
                setEnabled={handleSetEnabled}
                ui={analyzerUi[analyzer.id] ?? EMPTY_UI}
                onToggleExpand={toggleExpand}
                onFire={fireAnalyzer}
                onToggleReports={toggleReports}
                onTogglePrompt={togglePrompt}
                promptValue={promptValueFor(analyzer.id)}
                onPromptChange={onPromptChange}
                onPromptReset={onPromptReset}
                schedule={
                  cfg.analyzers?.[analyzer.id]?.triggers?.cron?.pattern ??
                  analyzer.cron?.pattern ??
                  ''
                }
                onScheduleChange={setSchedule}
                severityFloor={
                  analyzer.hasSeverityFloor
                    ? (cfg.analyzers?.[analyzer.id]?.severityFloor ?? DEFAULT_SEVERITY_FLOOR_VALUE)
                    : undefined
                }
                onSeverityFloorChange={handleSeverityFloorChange}
              />
            ))}
          </Stack>
        </CollapsibleSection>

        <ActionBar
          sticky="bottom"
          data-panel-action-bar=""
          statusRef={savedNoticeRef}
          status={
            <StatusIndicator tone={saveStatusTone} role="status" aria-live="polite">
              {saveStatusText}
            </StatusIndicator>
          }
          actions={
            <>
              <Button
                disabled={!dirty || saving}
                title={dirty ? 'Revert all unsaved edits' : undefined}
                onClick={handleDiscard}
              >
                Discard
              </Button>
              <Button
                variant="primary"
                loading={saving}
                loadingLabel="Saving"
                disabled={!dirty}
                onClick={handleSave}
              >
                Save configuration
              </Button>
            </>
          }
        />
      </Stack>
    </PanelRoot>
  );
}
