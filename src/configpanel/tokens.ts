// Design tokens: the single source of truth for every color, spacing, radius,
// and type value the panel uses. Colors are CSS custom properties (`--orc-*`),
// not hex literals, so the theme layer in styles.ts can redefine them per
// theme (light, dark, and the red-preserving night mode) without touching a
// single component. The scale tokens (space, radius, fontSize, fontWeight,
// font) are theme-independent, so they stay plain values used inline. A raw
// hex literal inside a component is a defect: every color routes through here.
export const T = {
  color: {
    textPrimary: 'var(--orc-text-primary)',
    textSecondary: 'var(--orc-text-secondary)',
    textMuted: 'var(--orc-text-muted)',
    // Card and input fill (the old `white`). Splits from accentText so a dark
    // or night theme can darken surfaces while button text stays legible.
    surface: 'var(--orc-surface)',
    // Panel root background, painted so a pinned dark or night theme reads as
    // one continuous surface rather than dark cards on the host's light page.
    bg: 'var(--orc-bg)',
    // Text drawn on a filled accent (primary or success) button.
    accentText: 'var(--orc-accent-text)',
    surfaceMuted: 'var(--orc-surface-muted)',
    // Light slate, shared by the secondary-button fill and the report-row divider.
    surfaceSubtle: 'var(--orc-surface-subtle)',
    // Slightly stronger slate used for secondary-button hover.
    surfaceHover: 'var(--orc-surface-hover)',
    border: 'var(--orc-border)',
    // Slightly darker border used on text inputs, selects, and the textarea.
    borderStrong: 'var(--orc-border-strong)',
    primary: 'var(--orc-primary)',
    // Darker primary for the button hover/active state.
    primaryHover: 'var(--orc-primary-hover)',
    // Translucent primary used for the input/button focus ring.
    focusRing: 'var(--orc-focus-ring)',
    secondaryText: 'var(--orc-secondary-text)',
    secondaryBorder: 'var(--orc-secondary-border)',
    success: 'var(--orc-success)',
    // Darker success for text on white: the fill color fails AA as text.
    successText: 'var(--orc-success-text)',
    // Pale success fill behind the "enabled" analyzer pill, paired with successText.
    successBg: 'var(--orc-success-bg)',
    danger: 'var(--orc-danger)',
    // Darker danger for text on white: the fill color is borderline as text.
    dangerText: 'var(--orc-danger-text)',
    // Soft danger fill and border for an error banner (models-load failure).
    dangerBg: 'var(--orc-danger-bg)',
    dangerBorder: 'var(--orc-danger-border)',
    disabled: 'var(--orc-disabled)',
    warning: 'var(--orc-warning)',
    warningText: 'var(--orc-warning-text)',
    // Info palette for the first-run callout: guidance, not an error.
    infoBg: 'var(--orc-info-bg)',
    infoFg: 'var(--orc-info-fg)',
    infoBorder: 'var(--orc-info-border)',
  },
  // Spacing scale plus the composite (vertical horizontal) paddings.
  space: {
    xxs: 2,
    xs: 4,
    sm: 6,
    md: 8,
    base: 10,
    lg: 12,
    section: 24,
    padInput: '6px 10px',
    padSelect: '5px 8px',
    padBtn: '6px 12px',
    padBtnSave: '8px 18px',
    padRoot: '16px 0',
    padSaveBar: '12px 0',
    padStatCard: '12px 16px',
    padAnalyzerRow: '10px 14px',
    padReportEntry: '10px 12px',
    padEmpty: '20px 0',
  },
  radius: {
    sm: 6,
    md: 8,
    lg: 10,
    full: '50%',
  },
  fontSize: {
    xs: 11,
    sm: 12,
    md: 13,
    lg: 18,
  },
  fontWeight: {
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  font: {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    // Bare keyword used by the report timestamp; kept distinct from the full
    // `mono` stack so the tokenization refactor stays pixel-identical.
    monoBasic: 'monospace',
  },
} as const;
