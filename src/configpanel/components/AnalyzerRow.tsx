import type { ReactElement } from 'react';
import { memo, useEffect, useRef } from 'react';
import { SEVERITY_FLOOR_PRESETS } from '../../severityFloors.js';
import { buildScheduleOptions } from '../scheduleOptions.js';
import { btn, btnClass, S } from '../styles.js';
import { T } from '../tokens.js';
import type { AnalyzerStatus, AnalyzerUiState } from '../types.js';
import { DisclosureCaret } from './DisclosureCaret.js';
import { PromptDrawer } from './PromptDrawer.js';
import { SecondaryButton } from './SecondaryButton.js';

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
  // Only forecast carries a severity floor today; severityFloor is undefined for
  // the rest so the control is omitted. The handler takes (id, value) to match
  // onScheduleChange's signature and to stay a single stable callback for every
  // row.
  severityFloor?: string;
  onSeverityFloorChange?: (id: string, value: string) => void;
}

// Memoized: a keystroke or status poll elsewhere in the panel must not re-render
// every analyzer row. The panel passes stable callbacks and value-equal scalars
// plus a shared empty-ui object, so the shallow prop compare holds for every row
// except the one whose own state changed.
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
  const floorId = `orc-floor-${analyzer.id}`;
  const scheduleId = `orc-schedule-${analyzer.id}`;
  const bodyId = `orc-analyzer-body-${analyzer.id}`;
  const reportsId = `orc-reports-${analyzer.id}`;
  const promptId = `orc-prompt-body-${analyzer.id}`;
  const expanded = !!ui.expanded;
  // cron.enabled false marks an event-driven analyzer (maintenance, alerts): it
  // has no schedule, so the frequency dropdown is replaced by a static value.
  const cronEnabled = !!analyzer.cron?.enabled;
  const scheduleOptions = buildScheduleOptions(schedule);

  // Focus management: opening a drawer moves focus into it; closing restores
  // focus to the toggle that opened it (which matters when the prompt drawer is
  // closed from its own Close button). Refs to the toggles and the drawer
  // containers, plus a previous-state latch so focus only moves on an actual
  // open/close transition, not on every re-render.
  const reportsBtnRef = useRef<HTMLButtonElement>(null);
  const promptBtnRef = useRef<HTMLButtonElement>(null);
  const reportsBodyRef = useRef<HTMLDivElement>(null);
  const promptBodyRef = useRef<HTMLDivElement>(null);
  const prevReportsOpen = useRef(!!ui.reportsOpen);
  const prevPromptOpen = useRef(!!ui.promptOpen);

  useEffect(() => {
    const open = !!ui.reportsOpen;
    if (open === prevReportsOpen.current) return;
    prevReportsOpen.current = open;
    if (open) reportsBodyRef.current?.focus();
    else reportsBtnRef.current?.focus();
  }, [ui.reportsOpen]);

  useEffect(() => {
    const open = !!ui.promptOpen;
    if (open === prevPromptOpen.current) return;
    prevPromptOpen.current = open;
    if (open) promptBodyRef.current?.focus();
    else promptBtnRef.current?.focus();
  }, [ui.promptOpen]);

  return (
    <div style={S.analyzerPanel}>
      <div style={S.analyzerHeader}>
        {/* aria-label names the checkbox; the visible title lives in the toggle
            button beside it, so no separate <label> is wired. */}
        <input
          type="checkbox"
          checked={enabled}
          aria-label={`Enable ${analyzer.title}`}
          onChange={(e) => setEnabled(analyzer.id, e.target.checked)}
        />
        <button
          type="button"
          style={S.analyzerHeaderToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => onToggleExpand(analyzer.id)}
        >
          <DisclosureCaret expanded={expanded} />
          <span style={S.analyzerTitle}>{analyzer.title}</span>
          <span style={{ ...S.analyzerPill, ...(enabled ? S.analyzerPillOn : S.analyzerPillOff) }}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </button>
      </div>
      {/* The body stays mounted (hidden when collapsed) so the header's
          aria-controls target always resolves; its expensive contents mount only
          while expanded. The inline body style is applied only when expanded so
          the `hidden` attribute's display:none is not overridden. */}
      <div id={bodyId} hidden={!expanded} style={expanded ? S.analyzerBody : undefined}>
        {expanded ? (
          <>
            <div style={S.analyzerSettings}>
              <span style={S.inlineControl}>
                {cronEnabled ? (
                  <>
                    <label htmlFor={scheduleId} style={S.selectLabel}>
                      Frequency
                    </label>
                    <select
                      id={scheduleId}
                      style={S.select}
                      value={schedule}
                      onChange={(e) => onScheduleChange(analyzer.id, e.target.value)}
                    >
                      {scheduleOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <>
                    <span style={S.selectLabel}>Frequency</span>
                    <span style={S.staticValue}>Event-driven</span>
                    <span style={S.hint}>runs from boat events, not a schedule</span>
                  </>
                )}
              </span>
              {severityFloor != null && (
                <span style={S.inlineControl}>
                  <label htmlFor={floorId} style={S.selectLabel}>
                    Severity floor
                  </label>
                  <select
                    id={floorId}
                    style={S.select}
                    value={severityFloor}
                    onChange={(e) => onSeverityFloorChange?.(analyzer.id, e.target.value)}
                  >
                    {SEVERITY_FLOOR_PRESETS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </span>
              )}
            </div>
            <div style={S.analyzerActions}>
              {ui.fire && (
                <span
                  style={{
                    ...S.fireResult,
                    color: ui.fire.ok ? T.color.successText : T.color.dangerText,
                  }}
                  role="status"
                  aria-live="polite"
                >
                  {ui.fire.text}
                </span>
              )}
              <button
                type="button"
                className={btnClass(false)}
                style={btn((!enabled || ui.fire?.pending) && S.btnDisabled)}
                disabled={!enabled || ui.fire?.pending}
                title={enabled ? undefined : 'Enable this analyzer to fire it'}
                onClick={() => onFire(analyzer.id)}
              >
                {ui.fire?.pending ? 'Firing...' : 'Fire now'}
              </button>
              <SecondaryButton
                btnRef={reportsBtnRef}
                aria-expanded={!!ui.reportsOpen}
                aria-controls={reportsId}
                onClick={() => onToggleReports(analyzer.id)}
              >
                {ui.reportsOpen ? 'Hide reports' : 'View reports'}
              </SecondaryButton>
              <SecondaryButton
                btnRef={promptBtnRef}
                aria-expanded={!!ui.promptOpen}
                aria-controls={promptId}
                onClick={() => onTogglePrompt(analyzer.id)}
              >
                {ui.promptOpen ? 'Hide prompt' : 'Edit prompt'}
              </SecondaryButton>
            </div>
            <div
              id={reportsId}
              ref={reportsBodyRef}
              tabIndex={-1}
              hidden={!ui.reportsOpen}
              style={ui.reportsOpen ? { ...S.drawer, outline: 'none' } : undefined}
            >
              {ui.reportsOpen ? (
                <>
                  {ui.reportsLoading && (
                    <div style={S.empty} role="status" aria-live="polite">
                      Loading reports...
                    </div>
                  )}
                  {!ui.reportsLoading && ui.reportsError && (
                    <div style={S.reportFailure} role="alert">
                      Failed to load reports: {ui.reportsError}
                    </div>
                  )}
                  {!ui.reportsLoading &&
                    !ui.reportsError &&
                    (!ui.reports || ui.reports.length === 0) && (
                      <div style={S.empty}>No reports yet for this analyzer.</div>
                    )}
                  {!ui.reportsLoading &&
                    ui.reports?.map((r) => (
                      // ts+trigger alone can collide for a multi-engine analyzer
                      // (two engine reports at the same trigger); the engine id
                      // disambiguates without an array-index key.
                      <div key={`${r.ts}-${r.trigger}-${r.engineId ?? ''}`} style={S.reportEntry}>
                        <div style={S.reportTs}>
                          {r.ts} · trigger={r.trigger}
                          {r.engineId ? ` · engine=${r.engineId}` : ''}
                          {r.durationSec ? ` · ${r.durationSec}s` : ''}
                        </div>
                        {r.model && (
                          <div style={S.statSub}>
                            {r.model}
                            {typeof r.totalTokens === 'number' ? ` · ${r.totalTokens.toLocaleString()} tok` : ''}
                            {typeof r.costUsd === 'number' ? ` · $${r.costUsd.toFixed(4)}` : ''}
                          </div>
                        )}
                        {r.report && <div style={S.reportBody}>{r.report}</div>}
                        {r.failure && <div style={S.reportFailure}>FAILURE: {r.failure}</div>}
                      </div>
                    ))}
                </>
              ) : null}
            </div>
            <div
              id={promptId}
              ref={promptBodyRef}
              tabIndex={-1}
              hidden={!ui.promptOpen}
              style={{ outline: 'none' }}
            >
              {ui.promptOpen ? (
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
          </>
        ) : null}
      </div>
    </div>
  );
});
