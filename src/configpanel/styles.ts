import type { CSSProperties } from 'react';
import { T } from './tokens.js';

// The panel renders inside the Signal K admin UI, which flips between light and
// dark on a host ancestor. Inline styles cannot read that host theme, so every
// color token in tokens.ts is a `--orc-*` CSS custom property defined here,
// once per theme. THEME_BLOCKS sets the light values on `.orc-config-panel`,
// overrides them when a host ancestor is dark, then lets ThemeToggle pin a
// theme via `data-orc-theme` on the panel root. The pinned blocks come after
// the host-dark block at equal specificity so an explicit choice wins.
//
// `color-scheme` rides each block so native widgets (checkboxes, select
// dropdown lists, number spinners, scrollbars) follow the panel theme even
// when it is pinned against the host.

// Light theme. Cards read white so they stand out; muted text clears WCAG AA
// (4.5:1) on both the white surface and the muted stat-card surface.
const LIGHT_TOKENS = `
  color-scheme: light;
  --orc-bg: #ffffff;
  --orc-surface: #ffffff;
  --orc-surface-muted: #f8f9fa;
  --orc-surface-subtle: #f1f5f9;
  --orc-surface-hover: #e2e8f0;
  --orc-text-primary: #333333;
  --orc-text-secondary: #555555;
  --orc-text-muted: #6b7280;
  --orc-accent-text: #ffffff;
  --orc-border: #e0e0e0;
  --orc-border-strong: #cccccc;
  --orc-primary: #3b82f6;
  --orc-primary-hover: #2563eb;
  --orc-focus-ring: rgba(59, 130, 246, 0.4);
  --orc-secondary-text: #475569;
  --orc-secondary-border: #e2e8f0;
  --orc-success: #10b981;
  --orc-success-text: #047857;
  --orc-success-bg: #dcfce7;
  --orc-danger: #ef4444;
  --orc-danger-text: #b91c1c;
  --orc-danger-bg: #fef2f2;
  --orc-danger-border: #fca5a5;
  --orc-disabled: #9ca3af;
  --orc-warning: #f59e0b;
  --orc-warning-text: #b45309;
  --orc-info-bg: #eef2ff;
  --orc-info-fg: #3730a3;
  --orc-info-border: #c7d2fe;
`;

// Dark theme. Text and status colors are lifted off the dark surfaces so AA
// holds; surfaces are slate, not pure black, to match a Bootstrap dark admin.
const DARK_TOKENS = `
  color-scheme: dark;
  --orc-bg: #1b1c22;
  --orc-surface: #262833;
  --orc-surface-muted: #20212b;
  --orc-surface-subtle: #30323f;
  --orc-surface-hover: #3a3c4a;
  --orc-text-primary: #e6e7ea;
  --orc-text-secondary: #c7ccd5;
  --orc-text-muted: #a3a9b5;
  --orc-accent-text: #ffffff;
  --orc-border: #3a3c4a;
  --orc-border-strong: #4a4d5e;
  --orc-primary: #4c93ff;
  --orc-primary-hover: #3a82f0;
  --orc-focus-ring: rgba(76, 147, 255, 0.5);
  --orc-secondary-text: #c7ccd5;
  --orc-secondary-border: #3a3c4a;
  --orc-success: #2dd4a0;
  --orc-success-text: #7fe3c0;
  --orc-success-bg: #12352a;
  --orc-danger: #f87171;
  --orc-danger-text: #f5a3a3;
  --orc-danger-bg: #3a1a1a;
  --orc-danger-border: #7a3a3a;
  --orc-disabled: #6b7785;
  --orc-warning: #fbbf24;
  --orc-warning-text: #f5d28a;
  --orc-info-bg: #1e2547;
  --orc-info-fg: #a9b6f0;
  --orc-info-border: #3a4577;
`;

// Night theme: red-preserving for night vision at the helm. Near-black
// surfaces, and every text and accent token collapses into the desaturated
// red and amber families. Nothing renders blue, green, or white.
const NIGHT_TOKENS = `
  color-scheme: dark;
  --orc-bg: #0d0606;
  --orc-surface: #160a0a;
  --orc-surface-muted: #110808;
  --orc-surface-subtle: #1f0e0e;
  --orc-surface-hover: #2a1313;
  --orc-text-primary: #e08a8a;
  --orc-text-secondary: #cf8a8a;
  --orc-text-muted: #b87474;
  --orc-accent-text: #1a0808;
  --orc-border: #3a1616;
  --orc-border-strong: #4a2020;
  --orc-primary: #cf6a3c;
  --orc-primary-hover: #b85a30;
  --orc-focus-ring: rgba(207, 106, 60, 0.5);
  --orc-secondary-text: #cf8a8a;
  --orc-secondary-border: #3a1616;
  --orc-success: #cf8a4a;
  --orc-success-text: #cf8a5a;
  --orc-success-bg: #1d0f08;
  --orc-danger: #e07a6a;
  --orc-danger-text: #e07a6a;
  --orc-danger-bg: #2a0d0d;
  --orc-danger-border: #6e2a2a;
  --orc-disabled: #7a4f4f;
  --orc-warning: #a9742e;
  --orc-warning-text: #d9a05a;
  --orc-info-bg: #200c0c;
  --orc-info-fg: #c98080;
  --orc-info-border: #5e2a2a;
`;

// Root class so the scoped stylesheet only targets this panel and never bleeds
// into the surrounding SK admin UI.
export const PANEL_CLASS = 'orc-config-panel';

// The token contract plus the host-driven dark override and the pinned theme
// blocks. The host selectors cover the admin themes seen in the SK ecosystem
// (Bootstrap `data-bs-theme`, CoreUI `data-coreui-theme`, legacy `.dark-mode`).
// Order matters: the pinned `[data-orc-theme]` blocks come last so an explicit
// user choice outranks the host theme at equal specificity.
const THEME_BLOCKS = `
.${PANEL_CLASS} {${LIGHT_TOKENS}}
[data-bs-theme="dark"] .${PANEL_CLASS},
[data-coreui-theme="dark"] .${PANEL_CLASS},
.dark-mode .${PANEL_CLASS} {${DARK_TOKENS}}
.${PANEL_CLASS}[data-orc-theme="light"] {${LIGHT_TOKENS}}
.${PANEL_CLASS}[data-orc-theme="dark"] {${DARK_TOKENS}}
.${PANEL_CLASS}[data-orc-theme="night"] {${NIGHT_TOKENS}}
`;

// Inline styles cannot express :focus-visible or :hover, both of which are
// accessibility-critical (a visible focus ring) and polish-critical (button
// hover feedback). This stylesheet is injected once, scoped under PANEL_CLASS,
// so it adds the interactive states the inline `S` object cannot. Colors all
// reference the design tokens, so every rule follows the active theme.
export const PANEL_CSS = `${THEME_BLOCKS}
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
  width: 22px;
  height: 22px;
  accent-color: ${T.color.primary};
  cursor: pointer;
  margin: 0;
}
`;

// The shared style object. Every entry is built from the design tokens in
// tokens.ts: no raw hex codes or magic numbers live here.
// `satisfies` (not an index-signature annotation) so each member keeps its
// concrete presence: every S.* access stays a CSSProperties, not
// CSSProperties | undefined under noUncheckedIndexedAccess.
export const S = {
  root: {
    fontFamily: T.font.system,
    color: T.color.textPrimary,
    background: T.color.bg,
    padding: T.space.padRoot,
    // Leave room for the sticky save bar so the last analyzer row is never
    // hidden behind it when scrolled to the bottom.
    paddingBottom: 72,
  },
  // Top control row: the theme toggle aligned to the right edge.
  controlBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: T.space.md,
    marginBottom: T.space.base,
  },
  // First-run callout: shown when no API key is set yet. Info-colored so it
  // reads as guidance, not an error.
  calloutFirstRun: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: T.space.lg,
    background: T.color.infoBg,
    border: `1px solid ${T.color.infoBorder}`,
    color: T.color.infoFg,
    borderRadius: T.radius.md,
    padding: T.space.padStatCard,
    marginBottom: T.space.lg,
    fontSize: T.fontSize.md,
    lineHeight: 1.45,
  },
  calloutText: { flex: 1, minWidth: 220 },
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
  // Neutralizes the user-agent margins and font scale of a heading element used
  // purely to wrap a disclosure button, so the button keeps its own type scale
  // and its margins drive the spacing.
  headingReset: { margin: 0, font: 'inherit' },
  // Dim, right-aligned "updated Xs ago" cue shown when the status snapshot has
  // gone stale (polling stalled).
  staleMarker: { marginLeft: 'auto', color: T.color.textMuted, fontSize: T.fontSize.xs },
  // Section header rendered as a full-width button so the whole row toggles a
  // collapsible section. Mirrors sectionTitle's type scale and divider.
  sectionToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: T.space.sm,
    width: '100%',
    minHeight: 36,
    marginTop: T.space.section,
    marginBottom: T.space.lg,
    padding: 0,
    paddingBottom: T.space.sm,
    background: 'none',
    border: 'none',
    borderBottom: `1px solid ${T.color.border}`,
    borderRadius: 0,
    fontSize: T.fontSize.md,
    fontWeight: T.fontWeight.semibold,
    fontFamily: 'inherit',
    color: T.color.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    textAlign: 'left',
  },
  // Fixed-width disclosure triangle so the title text does not shift when the
  // glyph swaps between the collapsed and expanded states.
  sectionToggleChevron: {
    display: 'inline-block',
    width: T.fontSize.md,
    color: T.color.textMuted,
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: T.space.base,
    marginBottom: T.space.lg,
  },
  statCard: {
    padding: T.space.padStatCard,
    background: T.color.surfaceMuted,
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
  // Status dots: the base geometry plus a static color variant per state, so
  // a render picks a pre-built object instead of allocating one per dot.
  dotOk: dotStyle(T.color.success),
  dotDanger: dotStyle(T.color.danger),
  dotWait: dotStyle(T.color.warning),
  dotOff: dotStyle(T.color.disabled),
  btn: {
    padding: T.space.padBtn,
    minHeight: 36,
    border: '1px solid transparent',
    borderRadius: T.radius.sm,
    fontSize: T.fontSize.sm,
    fontWeight: T.fontWeight.semibold,
    background: T.color.primary,
    color: T.color.accentText,
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
    background: T.color.surface,
    color: T.color.textPrimary,
    minWidth: 220,
  },
  inputSmall: { minWidth: 0, width: 100 },
  select: {
    padding: T.space.padSelect,
    borderRadius: T.radius.sm,
    border: `1px solid ${T.color.borderStrong}`,
    fontSize: T.fontSize.md,
    background: T.color.surface,
    color: T.color.textPrimary,
    cursor: 'pointer',
  },
  selectLabel: {
    fontSize: T.fontSize.sm,
    color: T.color.textSecondary,
    fontWeight: T.fontWeight.medium,
  },
  // Read-only value shown in place of a control (event-driven analyzers have
  // no schedule to pick).
  staticValue: {
    fontSize: T.fontSize.md,
    color: T.color.textPrimary,
    fontWeight: T.fontWeight.medium,
  },
  hint: { fontSize: T.fontSize.xs, color: T.color.textMuted },
  testStatus: { fontSize: T.fontSize.sm, fontWeight: T.fontWeight.medium },
  testOk: { color: T.color.successText },
  testErr: { color: T.color.dangerText },
  // Error banner with a soft danger fill, used for the models-load failure.
  errorBanner: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: T.space.md,
    background: T.color.dangerBg,
    border: `1px solid ${T.color.dangerBorder}`,
    color: T.color.dangerText,
    borderRadius: T.radius.sm,
    padding: T.space.padInput,
    fontSize: T.fontSize.sm,
  },
  empty: { fontSize: T.fontSize.md, color: T.color.textMuted, padding: T.space.padEmpty },
  // A collapsible card per analyzer. The header (checkbox, title, status pill)
  // is always visible; the body with controls renders only when expanded.
  analyzerPanel: {
    border: `1px solid ${T.color.border}`,
    borderRadius: T.radius.md,
    marginBottom: T.space.sm,
    overflow: 'hidden',
    fontSize: T.fontSize.md,
  },
  analyzerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: T.space.md,
    padding: T.space.padAnalyzerRow,
    background: T.color.surfaceMuted,
  },
  // The chevron, title, and pill region: one full-width toggle button. Sits
  // beside the enable checkbox, which stays a separate control.
  analyzerHeaderToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: T.space.md,
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    padding: 0,
    background: 'none',
    border: 'none',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    color: 'inherit',
    textAlign: 'left',
  },
  analyzerTitle: { flex: 1, fontWeight: T.fontWeight.medium, minWidth: 0 },
  analyzerBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: T.space.lg,
    padding: T.space.padAnalyzerRow,
    borderTop: `1px solid ${T.color.border}`,
    background: T.color.surface,
  },
  // Stacked label-plus-select rows (frequency, severity floor) in the body.
  analyzerSettings: {
    display: 'flex',
    flexDirection: 'column',
    gap: T.space.sm,
  },
  // Per-analyzer action buttons.
  analyzerActions: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: T.space.sm,
  },
  // Status pill in the analyzer header: carries a text label so state is not
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
  analyzerPillOn: { background: T.color.successBg, color: T.color.successText },
  analyzerPillOff: { background: T.color.surfaceSubtle, color: T.color.textMuted },
  // Inline label-plus-select group used by the frequency and severity-floor
  // controls.
  inlineControl: {
    display: 'flex',
    alignItems: 'center',
    gap: T.space.sm,
  },
  // Reports / prompt sub-panel inside an expanded analyzer body.
  drawer: {
    background: T.color.surfaceMuted,
    border: `1px solid ${T.color.border}`,
    borderRadius: T.radius.md,
    padding: T.space.lg,
  },
  reportEntry: {
    padding: T.space.padReportEntry,
    borderBottom: `1px solid ${T.color.surfaceSubtle}`,
  },
  reportTs: { fontSize: T.fontSize.xs, color: T.color.textMuted, fontFamily: T.font.mono },
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
    background: T.color.surface,
    color: T.color.textPrimary,
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  saveBar: {
    position: 'sticky',
    bottom: 0,
    background: T.color.bg,
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
  // Segmented control (the theme toggle): a bordered pill of aria-pressed
  // buttons with the active segment filled by the accent. 36px segments for
  // marine touch use.
  segmented: {
    display: 'inline-flex',
    // Rendered as a <fieldset>: zero out the user-agent margin and padding so
    // the segments sit flush inside the border.
    margin: 0,
    padding: 0,
    border: `1px solid ${T.color.border}`,
    borderRadius: T.radius.sm,
    overflow: 'hidden',
    background: T.color.surface,
  },
  segmentedBtn: {
    padding: T.space.padBtn,
    minHeight: 36,
    background: 'transparent',
    color: T.color.textMuted,
    border: 'none',
    borderRadius: 0,
    fontSize: T.fontSize.sm,
    cursor: 'pointer',
  },
  segmentedBtnActive: {
    background: T.color.primary,
    color: T.color.accentText,
    fontWeight: T.fontWeight.semibold,
  },
  // Visually hidden but screen-reader-available (the segmented control legend).
  visuallyHidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
  },
} satisfies Record<string, CSSProperties>;

// Base geometry for a status dot, shared by the per-state variants above.
function dotStyle(background: string): CSSProperties {
  return {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: T.radius.full,
    background,
    marginRight: T.space.sm,
    verticalAlign: 'middle',
  };
}

// Spread S.btn first, then any number of overrides (variants or disabled
// state). Falsy overrides are dropped so callers can pass `cond && S.x`.
export function btn(...overrides: Array<CSSProperties | false | undefined>): CSSProperties {
  return Object.assign({}, S.btn, ...overrides.filter(Boolean));
}

// className for a button: selects the hover rule in PANEL_CSS. Pass
// `secondary: true` for the slate variant, otherwise the primary blue.
export function btnClass(secondary: boolean): string {
  return secondary ? 'orc-btn-secondary' : 'orc-btn-primary';
}
