import { btn, btnClass, S } from '../styles.js';
import { T } from '../tokens.js';
import { PromptDrawer } from './PromptDrawer.jsx';

// Weather Outlook Advisor: how bad the predicted weather must be before the
// outlook raises an alarm. Values and labels mirror the `severityFloor` enum
// in src/schema.ts and the config shape in src/types.ts.
const SEVERITY_FLOOR_OPTIONS = [
  { value: 'severe', label: 'Severe only' },
  { value: 'moderate', label: 'Moderate and up' },
  { value: 'minor', label: 'Any deterioration' },
];
export const DEFAULT_SEVERITY_FLOOR = 'moderate';

// How often a scheduled analyzer runs. Values are 5-field cron patterns. A
// saved pattern outside this list (a hand-edited cron) is surfaced as a
// non-selectable "Custom" entry so the dropdown never blanks.
const FREQUENCY_OPTIONS = [
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 */3 * * *', label: 'Every 3 hours' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 8 * * *', label: 'Daily (8 AM)' },
  { value: '0 8 * * 0', label: 'Weekly (Sun 8 AM)' },
  { value: '0 8 1 * *', label: 'Monthly (1st, 8 AM)' },
];

export function AnalyzerRow({
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
}) {
  const checkboxId = `orc-analyzer-${analyzer.id}`;
  const floorId = `orc-floor-${analyzer.id}`;
  const scheduleId = `orc-schedule-${analyzer.id}`;
  const expanded = !!ui.expanded;
  // cron.enabled false marks an event-driven analyzer (maintenance, alerts):
  // it has no schedule, so the frequency dropdown is shown disabled.
  const cronEnabled = !!analyzer.cron?.enabled;
  const scheduleOptions =
    !schedule || FREQUENCY_OPTIONS.some((o) => o.value === schedule)
      ? FREQUENCY_OPTIONS
      : [...FREQUENCY_OPTIONS, { value: schedule, label: `Custom: ${schedule}` }];

  return (
    <div style={S.analyzerPanel}>
      <div style={S.analyzerHeader}>
        <input
          id={checkboxId}
          type="checkbox"
          checked={enabled}
          aria-label={`Enable ${analyzer.title}`}
          onChange={(e) => setEnabled(analyzer.id, e.target.checked)}
        />
        <button
          type="button"
          style={S.analyzerHeaderToggle}
          aria-expanded={expanded}
          onClick={() => onToggleExpand(analyzer.id)}
        >
          <span style={S.sectionToggleChevron} aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span style={S.analyzerTitle}>{analyzer.title}</span>
          <span style={{ ...S.analyzerPill, ...(enabled ? S.analyzerPillOn : S.analyzerPillOff) }}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </button>
      </div>
      {expanded && (
        <div style={S.analyzerBody}>
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
            {analyzer.id === 'forecast' && (
              <span style={S.inlineControl}>
                <label htmlFor={floorId} style={S.selectLabel}>
                  Severity floor
                </label>
                <select
                  id={floorId}
                  style={S.select}
                  value={severityFloor}
                  onChange={(e) => onSeverityFloorChange(e.target.value)}
                >
                  {SEVERITY_FLOOR_OPTIONS.map((o) => (
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
            <button
              type="button"
              className={btnClass(true)}
              style={btn(S.btnSecondary)}
              aria-expanded={!!ui.reportsOpen}
              onClick={() => onToggleReports(analyzer.id)}
            >
              {ui.reportsOpen ? 'Hide reports' : 'View reports'}
            </button>
            <button
              type="button"
              className={btnClass(true)}
              style={btn(S.btnSecondary)}
              aria-expanded={!!ui.promptOpen}
              onClick={() => onTogglePrompt(analyzer.id)}
            >
              {ui.promptOpen ? 'Hide prompt' : 'Edit prompt'}
            </button>
          </div>
          {ui.reportsOpen && (
            <div style={S.drawer}>
              {ui.reportsLoading && (
                <div style={S.empty} role="status" aria-live="polite">
                  Loading reports...
                </div>
              )}
              {!ui.reportsLoading && (!ui.reports || ui.reports.length === 0) && (
                <div style={S.empty}>No reports yet for this analyzer.</div>
              )}
              {!ui.reportsLoading &&
                ui.reports?.map((r) => (
                  <div key={r.ts} style={S.reportEntry}>
                    <div style={S.reportTs}>
                      {r.ts} · trigger={r.trigger}
                      {r.engineId ? ` · engine=${r.engineId}` : ''}
                      {r.durationSec ? ` · ${r.durationSec}s` : ''}
                    </div>
                    {r.report && <div style={S.reportBody}>{r.report}</div>}
                    {r.failure && <div style={S.reportFailure}>FAILURE: {r.failure}</div>}
                  </div>
                ))}
            </div>
          )}
          {ui.promptOpen && (
            <PromptDrawer
              analyzerId={analyzer.id}
              ui={ui}
              value={promptValue}
              onChange={onPromptChange}
              onReset={onPromptReset}
              onClose={() => onTogglePrompt(analyzer.id)}
            />
          )}
        </div>
      )}
    </div>
  );
}
