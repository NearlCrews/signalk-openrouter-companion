// Shared time-unit constants in milliseconds. Kept here so the trend
// analyzers (aging, drift, forecast) share one definition instead of each
// redeclaring the same literal.
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface FmtOpts {
  digits?: number;
  nan?: string;
}

export function fmtNumber(v: unknown, opts: FmtOpts = {}): string {
  const { digits = 3, nan = 'n/a' } = opts;
  if (v == null) return nan;
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return nan;
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

export function fmtPct(v: number | null, opts: FmtOpts = {}): string {
  const { digits = 1, nan = 'n/a' } = opts;
  if (v == null || !Number.isFinite(v)) return nan;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

export function fmtUnit(v: number | null | undefined, unit: string, opts: FmtOpts = {}): string {
  const { digits = 3, nan = 'n/a' } = opts;
  if (v == null || !Number.isFinite(v)) return nan;
  return `${v.toFixed(digits)} ${unit}`;
}

export function fmtRatio(v: number | null | undefined, opts: FmtOpts = {}): string {
  const { digits = 3, nan = 'n/a' } = opts;
  if (v == null || !Number.isFinite(v)) return nan;
  return `${v.toFixed(digits)} (${(v * 100).toFixed(0)}%)`;
}

// Coerce an unknown to a finite number, or null. Used by analyzers decoding
// QuestDB rows (where a column may be a number, null, or an unexpected type)
// before computing deltas, so non-finite values never enter arithmetic.
export function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Clamp text to a maximum length at a word boundary. When the cut point has no
// space in its second half, hard-cuts instead. With `ellipsis`, appends a
// single ellipsis character and reserves one character of budget for it.
export function clampAtWord(text: string, max: number, opts: { ellipsis?: boolean } = {}): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - (opts.ellipsis ? 1 : 0));
  const lastSpace = head.lastIndexOf(' ');
  const cut = (lastSpace > max / 2 ? head.slice(0, lastSpace) : head).trimEnd();
  return opts.ellipsis ? `${cut}…` : cut;
}
