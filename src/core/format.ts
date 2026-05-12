/**
 * Shared number formatters used by analyzer prompts. State analyzers want a
 * forgiving formatter (anything that isn't a usable number renders as a
 * sentinel like 'n/a'). Trend analyzers want the same shape with a custom
 * sentinel or digit count.
 *
 * Behavior:
 * - null or undefined renders as the `nan` sentinel.
 * - Non-number inputs render via `String(v)` (preserves boolean/string passthrough).
 * - Non-finite numbers (NaN, Infinity) render as the `nan` sentinel.
 * - Integers render with no decimals; non-integers render with `digits` fixed
 *   decimal places.
 */
export function fmtNumber(v: unknown, opts: { digits?: number; nan?: string } = {}): string {
  const { digits = 3, nan = 'n/a' } = opts;
  if (v == null) return nan;
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return nan;
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

/**
 * Render a percent delta with an explicit sign prefix. null or non-finite
 * inputs render as the `nan` sentinel.
 */
export function fmtPct(v: number | null, opts: { digits?: number; nan?: string } = {}): string {
  const { digits = 1, nan = 'n/a' } = opts;
  if (v == null || !Number.isFinite(v)) return nan;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}
