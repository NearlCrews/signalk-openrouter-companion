import { T } from './tokens.js';

// The shared style object. Every entry is built from the design tokens in
// tokens.js: no raw hex codes or magic numbers live here.
export const S = {
  root: {
    fontFamily: T.font.system,
    color: T.color.textPrimary,
    padding: T.space.padRoot,
    // Leave room for the sticky save bar so the last analyzer row is never
    // hidden behind it when scrolled to the bottom.
    paddingBottom: 72,
  },
  sectionTitle: {
    fontSize: T.fontSize.md,
    fontWeight: T.fontWeight.semibold,
    color: T.color.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: T.space.lg,
    marginTop: T.space.section,
    paddingBottom: T.space.sm,
    borderBottom: `1px solid ${T.color.border}`,
  },
  // The very first section title sits flush against the top of the panel.
  sectionTitleFirst: { marginTop: 0 },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: T.space.base,
    marginBottom: T.space.lg,
  },
  statCard: {
    padding: T.space.padStatCard,
    background: T.color.surface,
    border: `1px solid ${T.color.border}`,
    borderRadius: T.radius.lg,
  },
  statLabel: {
    fontSize: T.fontSize.xs,
    color: T.color.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  statValue: {
    fontSize: T.fontSize.lg,
    fontWeight: T.fontWeight.bold,
    color: T.color.textPrimary,
    marginTop: T.space.xs,
  },
  statSub: { fontSize: T.fontSize.xs, color: T.color.textMuted, marginTop: T.space.xxs },
  dot: (color) => ({
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: T.radius.full,
    background: color,
    marginRight: T.space.sm,
    verticalAlign: 'middle',
  }),
  btn: {
    padding: T.space.padBtn,
    border: '1px solid transparent',
    borderRadius: T.radius.sm,
    fontSize: T.fontSize.sm,
    fontWeight: T.fontWeight.semibold,
    background: T.color.primary,
    color: T.color.white,
    cursor: 'pointer',
    // Match the host transition feel so hover/active changes are not jarring.
    transition: 'background 0.12s ease, box-shadow 0.12s ease',
  },
  btnSecondary: {
    background: T.color.surfaceSubtle,
    color: T.color.secondaryText,
    border: `1px solid ${T.color.secondaryBorder}`,
  },
  btnSave: {
    padding: T.space.padBtnSave,
    fontSize: T.fontSize.md,
    background: T.color.success,
  },
  // The save button when there is nothing to save: muted, clearly inert.
  btnSaveIdle: { background: T.color.disabled },
  btnDisabled: { opacity: 0.55, cursor: 'not-allowed' },
  inlineRow: {
    display: 'flex',
    alignItems: 'center',
    gap: T.space.lg,
    marginTop: T.space.sm,
    flexWrap: 'wrap',
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: T.space.lg,
    marginBottom: T.space.base,
    flexWrap: 'wrap',
  },
  fieldLabel: {
    fontSize: T.fontSize.md,
    fontWeight: T.fontWeight.medium,
    color: T.color.textSecondary,
    width: 160,
    flexShrink: 0,
  },
  input: {
    padding: T.space.padInput,
    borderRadius: T.radius.sm,
    border: `1px solid ${T.color.borderStrong}`,
    fontSize: T.fontSize.md,
    background: T.color.white,
    color: T.color.textPrimary,
    minWidth: 220,
  },
  inputSmall: { minWidth: 0, width: 100 },
  select: {
    padding: T.space.padSelect,
    borderRadius: T.radius.sm,
    border: `1px solid ${T.color.borderStrong}`,
    fontSize: T.fontSize.md,
    background: T.color.white,
    color: T.color.textPrimary,
    cursor: 'pointer',
  },
  selectLabel: {
    fontSize: T.fontSize.sm,
    color: T.color.textSecondary,
    fontWeight: T.fontWeight.medium,
  },
  hint: { fontSize: T.fontSize.xs, color: T.color.textMuted },
  testStatus: { fontSize: T.fontSize.sm, fontWeight: T.fontWeight.medium },
  testOk: { color: T.color.successText },
  testErr: { color: T.color.dangerText },
  pre: {
    background: T.color.surface,
    border: `1px solid ${T.color.border}`,
    borderRadius: T.radius.md,
    padding: T.space.lg,
    fontSize: T.fontSize.xs,
    lineHeight: 1.4,
    overflow: 'auto',
    maxHeight: 280,
    color: T.color.textSecondary,
  },
  empty: { fontSize: T.fontSize.md, color: T.color.textMuted, padding: T.space.padEmpty },
  analyzerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: T.space.lg,
    padding: T.space.padAnalyzerRow,
    background: T.color.surface,
    border: `1px solid ${T.color.border}`,
    borderRadius: T.radius.md,
    marginBottom: T.space.sm,
    fontSize: T.fontSize.md,
  },
  analyzerTitle: {
    flex: 1,
    fontWeight: T.fontWeight.medium,
    minWidth: 0,
    cursor: 'pointer',
  },
  // Pushes the per-row action buttons together as one group at the right.
  analyzerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: T.space.sm,
  },
  // Status pill on the analyzer row: carries a text label so state is not
  // signalled by a color dot alone.
  analyzerPill: {
    fontSize: T.fontSize.xs,
    fontWeight: T.fontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    padding: '2px 8px',
    borderRadius: T.radius.sm,
    whiteSpace: 'nowrap',
  },
  analyzerPillOn: { background: '#dcfce7', color: T.color.successText },
  analyzerPillOff: { background: T.color.surfaceSubtle, color: T.color.textMuted },
  // Inline group holding the forecast severity-floor label and select.
  severityGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: T.space.sm,
  },
  drawer: {
    background: T.color.white,
    border: `1px solid ${T.color.border}`,
    borderTop: 'none',
    borderRadius: `0 0 ${T.radius.md}px ${T.radius.md}px`,
    marginTop: -(T.space.sm + 1),
    marginBottom: T.space.base,
    padding: T.space.lg,
  },
  reportEntry: {
    padding: T.space.padReportEntry,
    borderBottom: `1px solid ${T.color.surfaceSubtle}`,
  },
  reportTs: { fontSize: T.fontSize.xs, color: T.color.textMuted, fontFamily: T.font.monoBasic },
  reportBody: {
    fontSize: T.fontSize.sm,
    color: T.color.textPrimary,
    marginTop: T.space.xs,
    whiteSpace: 'pre-wrap',
  },
  reportFailure: { fontSize: T.fontSize.sm, color: T.color.dangerText, marginTop: T.space.xs },
  fireResult: { fontSize: T.fontSize.xs, marginLeft: T.space.xs },
  textarea: {
    width: '100%',
    minHeight: 180,
    padding: T.space.md,
    fontFamily: T.font.mono,
    fontSize: T.fontSize.xs,
    lineHeight: 1.45,
    border: `1px solid ${T.color.borderStrong}`,
    borderRadius: T.radius.sm,
    background: T.color.white,
    color: T.color.textPrimary,
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  saveBar: {
    position: 'sticky',
    bottom: 0,
    background: T.color.white,
    borderTop: `1px solid ${T.color.border}`,
    padding: T.space.padSaveBar,
    marginTop: T.space.section,
    display: 'flex',
    alignItems: 'center',
    gap: T.space.lg,
    // Lift the bar off the content scrolling beneath it.
    boxShadow: '0 -2px 8px rgba(0, 0, 0, 0.06)',
  },
  // Reserves space and keeps the dirty hint left of the save button so the
  // button does not shift horizontally when the hint appears.
  saveHint: {
    fontSize: T.fontSize.sm,
    color: T.color.warningText,
    fontWeight: T.fontWeight.medium,
  },
  // Pushes the saved-confirmation notice to the right edge of the save bar.
  saveSpacer: { marginLeft: 'auto' },
};

// Spread S.btn first, then any number of overrides (variants or disabled
// state). Falsy overrides are dropped so callers can pass `cond && S.x`.
export function btn(...overrides) {
  return Object.assign({}, S.btn, ...overrides.filter(Boolean));
}

// className for a button: selects the hover rule in PANEL_CSS. Pass
// `secondary: true` for the slate variant, otherwise the primary blue.
export function btnClass(secondary) {
  return secondary ? 'orc-btn-secondary' : 'orc-btn-primary';
}

// Root class so the scoped stylesheet below only targets this panel and
// never bleeds into the surrounding SK admin UI.
export const PANEL_CLASS = 'orc-config-panel';

// Inline styles cannot express :focus-visible or :hover, both of which are
// accessibility-critical (a visible focus ring) and polish-critical (button
// hover feedback). This stylesheet is injected once, scoped under
// PANEL_CLASS, so it adds the interactive states the inline `S` object
// cannot. Colors mirror the design tokens.
export const PANEL_CSS = `
.${PANEL_CLASS} input:focus-visible,
.${PANEL_CLASS} select:focus-visible,
.${PANEL_CLASS} textarea:focus-visible,
.${PANEL_CLASS} button:focus-visible {
  outline: none;
  border-color: ${T.color.primary};
  box-shadow: 0 0 0 3px ${T.color.focusRing};
}
.${PANEL_CLASS} button:not(:disabled) { cursor: pointer; }
.${PANEL_CLASS} button.orc-btn-primary:not(:disabled):hover {
  background: ${T.color.primaryHover};
}
.${PANEL_CLASS} button.orc-btn-secondary:not(:disabled):hover {
  background: ${T.color.surfaceHover};
}
.${PANEL_CLASS} button:disabled { cursor: not-allowed; }
.${PANEL_CLASS} input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: ${T.color.primary};
  cursor: pointer;
  margin: 0;
}
`;
