import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SEVERITY_FLOOR_VALUE } from '../severityFloors.js';
import { errText, fetchJson, REPORT_LIMIT } from './api.js';
import { AnalyzerRow } from './components/AnalyzerRow.js';
import { CollapsibleSection } from './components/CollapsibleSection.js';
import { OpenRouterSection } from './components/OpenRouterSection.js';
import { QuestDBSection } from './components/QuestDBSection.js';
import { SecondaryButton } from './components/SecondaryButton.js';
import { StatusBlock } from './components/StatusBlock.js';
import { TestStatus } from './components/TestStatus.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { fireOutcomeText, isFireSuccess } from './fireOutcome.js';
import { useOpenRouterModels } from './hooks/useOpenRouterModels.js';
import { useSaveLifecycle } from './hooks/useSaveLifecycle.js';
import { useStatus } from './hooks/useStatus.js';
import { btn, btnClass, PANEL_CLASS, PANEL_CSS, S } from './styles.js';
import type { AnalyzerUiState, PanelConfig, QdbTestResult, TestResult } from './types.js';

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

// Inject the scoped theme + focus/hover stylesheet once. It carries the
// `--orc-*` token blocks per theme and the interactive states (focus rings,
// button hover) that inline styles cannot express.
function useScopedStyles(): void {
  useEffect(() => {
    const id = 'orc-config-panel-styles';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = PANEL_CSS;
    document.head.appendChild(el);
  }, []);
}

export default function PluginConfigurationPanel({ configuration, save }: Props): ReactElement {
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
    onSave,
    onDiscard,
  } = useSaveLifecycle(configuration, save, status);
  const { models, modelsState, loadModels } = useOpenRouterModels();

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [qdbTest, setQdbTest] = useState<QdbTestResult | null>(null);
  const [qdbTesting, setQdbTesting] = useState(false);
  const [analyzerUi, setAnalyzerUi] = useState<Record<string, AnalyzerUiState>>({});
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
  const toggleSection = useCallback((id: string): void => {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);
  // Post-fire report refresh timer, tracked so it is cleared on unmount.
  const reportRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useScopedStyles();

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

  // Read live state via the ref to avoid the stale-closure bug a rapid
  // double-click would hit on `analyzerUi`, and use a functional state updater
  // for the mutation. Side effects (loadReports, loadPrompt) MUST stay outside
  // the updater: React 19 may invoke the updater more than once (StrictMode in
  // dev, concurrent rendering in production), and the inFlightRef guard in load*
  // is the dedup of last resort.
  const toggleExpand = useCallback((id: string): void => {
    setAnalyzerUi((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? {}), expanded: !prev[id]?.expanded },
    }));
  }, []);

  const toggleReports = useCallback(
    (id: string): void => {
      const next = !analyzerUiRef.current[id]?.reportsOpen;
      patchUi(id, { reportsOpen: next });
      if (next && !analyzerUiRef.current[id]?.reports) loadReports(id);
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
      if (next && (!current?.promptLoaded || current?.promptError)) loadPrompt(id);
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
      if (def !== undefined && value === def) {
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

  // Open the OpenRouter section and move focus to the API key field, so the
  // first-run callout's button lands the user exactly where they need to type.
  const focusApiKey = (): void => {
    setOpenSections((prev) => ({ ...prev, [SECTION_OPENROUTER]: true }));
    requestAnimationFrame(() => {
      document.getElementById('orc-api-key')?.focus();
    });
  };

  const analyzersList = status?.analyzers ?? [];
  // The first-run callout keys off the edit buffer so it disappears the moment
  // the operator starts typing a key, before any save round-trip.
  const noApiKey = !(cfg.openrouter?.apiKey ?? '').trim();
  const saveDisabled = !dirty || saving;

  return (
    <div className={PANEL_CLASS} style={S.root}>
      <div style={S.controlBar}>
        <ThemeToggle />
      </div>

      {noApiKey && (
        <div style={S.calloutFirstRun}>
          <span style={S.calloutText}>
            No OpenRouter API key set yet. Add one in the OpenRouter section to start the plugin.
          </span>
          <button type="button" className={btnClass(false)} style={btn()} onClick={focusApiKey}>
            Add API key
          </button>
        </div>
      )}

      <h2 style={{ ...S.sectionTitle, ...S.sectionTitleFirst }}>Live status</h2>
      <StatusBlock
        status={status}
        statusError={statusError}
        onTest={runTest}
        testing={testing}
        testResult={testResult}
        stale={stale}
        staleAgeMs={staleAgeMs}
      />

      <CollapsibleSection
        id={SECTION_OPENROUTER}
        title="OpenRouter"
        open={!!openSections[SECTION_OPENROUTER]}
        onToggle={toggleSection}
      >
        <OpenRouterSection
          cfg={cfg}
          set={setSection}
          models={models}
          modelsState={modelsState}
          loadModels={loadModels}
        />
      </CollapsibleSection>

      <CollapsibleSection
        id={SECTION_QUESTDB}
        title="QuestDB enrichment"
        open={!!openSections[SECTION_QUESTDB]}
        onToggle={toggleSection}
      >
        <QuestDBSection
          cfg={cfg}
          set={setSection}
          testResult={qdbTest}
          onTest={runQdbTest}
          testing={qdbTesting}
        />
      </CollapsibleSection>

      <CollapsibleSection
        id={SECTION_ANALYZERS}
        title="Analyzers"
        open={!!openSections[SECTION_ANALYZERS]}
        onToggle={toggleSection}
      >
        {analyzersList.length === 0 && (
          <div style={S.empty}>
            {status
              ? 'No analyzers reported by the plugin yet.'
              : 'Analyzer list loads once the plugin is running.'}
          </div>
        )}
        {analyzersList.map((a) => (
          <AnalyzerRow
            key={a.id}
            analyzer={a}
            // Fall back to the live /api/status value when the edit buffer has no
            // explicit setting: on a fresh install `configuration` has no
            // analyzers key, but the server defaults them all enabled, so keying
            // the checkbox off cfg alone would show them as disabled.
            enabled={cfg.analyzers?.[a.id]?.enabled ?? a.enabled}
            setEnabled={handleSetEnabled}
            ui={analyzerUi[a.id] ?? EMPTY_UI}
            onToggleExpand={toggleExpand}
            onFire={fireAnalyzer}
            onToggleReports={toggleReports}
            onTogglePrompt={togglePrompt}
            promptValue={promptValueFor(a.id)}
            onPromptChange={onPromptChange}
            onPromptReset={onPromptReset}
            schedule={cfg.analyzers?.[a.id]?.triggers?.cron?.pattern ?? a.cron?.pattern ?? ''}
            onScheduleChange={setSchedule}
            // The status payload declares which analyzers carry a severity
            // floor; pass a value only for those so the row renders the control
            // when given a value, without the panel hardcoding analyzer ids. The
            // handler is a single stable callback shared by every row (the row
            // calls it with its own id).
            severityFloor={
              a.hasSeverityFloor
                ? (cfg.analyzers?.[a.id]?.severityFloor ?? DEFAULT_SEVERITY_FLOOR_VALUE)
                : undefined
            }
            onSeverityFloorChange={handleSeverityFloorChange}
          />
        ))}
      </CollapsibleSection>

      <div style={S.saveBar}>
        <button
          type="button"
          className={btnClass(false)}
          style={btn(S.btnSave, saveDisabled && S.btnSaveIdle, saveDisabled && S.btnDisabled)}
          onClick={onSave}
          disabled={saveDisabled}
        >
          {saving ? 'Saving...' : dirty ? 'Save configuration' : 'Saved'}
        </button>
        <SecondaryButton
          extraStyle={!dirty ? S.btnDisabled : undefined}
          disabled={!dirty}
          onClick={onDiscard}
          title={dirty ? 'Revert all unsaved edits' : undefined}
        >
          Discard
        </SecondaryButton>
        {dirty && <span style={S.saveHint}>Unsaved changes</span>}
        <TestStatus
          spanRef={savedNoticeRef}
          tabIndex={-1}
          ok={!savedNotice?.error}
          style={S.saveSpacer}
        >
          {noticeText}
        </TestStatus>
      </div>
    </div>
  );
}
