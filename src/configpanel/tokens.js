// Design tokens: the single source of truth for every color, spacing,
// radius, and type value the panel uses. The `S` style object (styles.js)
// and every inline JSX style literal reference these, so there are no raw
// hex codes or magic numbers scattered through the components.
export const T = {
  color: {
    textPrimary: '#333',
    textSecondary: '#555',
    textMuted: '#888',
    white: '#fff',
    surface: '#f8f9fa',
    // Light slate, shared by the secondary-button fill and the report-row divider.
    surfaceSubtle: '#f1f5f9',
    border: '#e0e0e0',
    // Slightly darker border used on text inputs, selects, and the textarea.
    borderStrong: '#ccc',
    primary: '#3b82f6',
    secondaryText: '#475569',
    secondaryBorder: '#e2e8f0',
    success: '#10b981',
    danger: '#ef4444',
    disabled: '#9ca3af',
    warning: '#f59e0b',
  },
  // Spacing scale plus the composite (vertical horizontal) paddings.
  space: {
    xxs: 2,
    xs: 4,
    sm: 6,
    md: 8,
    base: 10,
    lg: 12,
    xl: 14,
    xxl: 16,
    xxxl: 18,
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
};
