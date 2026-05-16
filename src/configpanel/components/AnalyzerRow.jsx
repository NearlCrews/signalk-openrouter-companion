import { btn, S } from '../styles.js';
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

export function AnalyzerRow({
  analyzer,
  enabled,
  setEnabled,
  ui,
  onFire,
  onToggleReports,
  onTogglePrompt,
  promptValue,
  onPromptChange,
  onPromptReset,
  severityFloor,
  onSeverityFloorChange,
}) {
  return (
    <>
      <div style={S.analyzerRow}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(analyzer.id, e.target.checked)}
        />
        <span style={S.analyzerTitle}>{analyzer.title}</span>
        {analyzer.id === 'forecast' && (
          <>
            <span style={S.selectLabel}>Severity floor</span>
            <select
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
          </>
        )}
        {ui.fire && (
          <span style={{ ...S.fireResult, color: ui.fire.ok ? T.color.success : T.color.danger }}>
            {ui.fire.text}
          </span>
        )}
        <button
          type="button"
          style={btn((!enabled || ui.fire?.pending) && S.btnDisabled)}
          disabled={!enabled || ui.fire?.pending}
          onClick={() => onFire(analyzer.id)}
        >
          {ui.fire?.pending ? 'Firing...' : 'Fire now'}
        </button>
        <button
          type="button"
          style={btn(S.btnSecondary)}
          onClick={() => onToggleReports(analyzer.id)}
        >
          {ui.reportsOpen ? 'Hide reports' : 'View reports'}
        </button>
        <button
          type="button"
          style={btn(S.btnSecondary)}
          onClick={() => onTogglePrompt(analyzer.id)}
        >
          {ui.promptOpen ? 'Hide prompt' : 'Edit prompt'}
        </button>
        <span style={S.analyzerState}>{enabled ? 'enabled' : 'disabled'}</span>
      </div>
      {ui.reportsOpen && (
        <div style={S.drawer}>
          {ui.reportsLoading && <div style={S.empty}>Loading reports...</div>}
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
    </>
  );
}
