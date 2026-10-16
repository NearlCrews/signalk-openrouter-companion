// Shared time-unit constants in milliseconds, so a seconds-to-milliseconds
// conversion or a window length reads as the unit it is rather than a literal.
export const SECOND_MS = 1000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// Join the parts of a composite map key. The separator is NUL because no
// analyzer id, Signal K path segment, cron pattern, or IANA timezone name can
// contain one, so two different part lists cannot collide into one key.
// Written once here rather than interpolated at each call site, so the
// separator is a decision the code states rather than a comment beside it.
const KEY_SEPARATOR = '\x00';

export function compositeKey(...parts: string[]): string {
  return parts.join(KEY_SEPARATOR);
}

interface FmtOpts {
  digits?: number;
  nan?: string;
}

// Shared renderable guard: every fmt* below except fmtNumber (which stringifies
// non-number input) treats null, undefined, and non-finite the same way. The
// type predicate narrows v to number for the formatting that follows.
function isFiniteValue(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

// Fixed-precision value with an explicit leading '+' on non-negatives. Shared
// by fmtPct and fmtSigned, which differ only in the trailing unit.
function signedFixed(v: number, digits: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
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
  if (!isFiniteValue(v)) return nan;
  return `${signedFixed(v, digits)}%`;
}

export function fmtUnit(v: number | null | undefined, unit: string, opts: FmtOpts = {}): string {
  const { digits = 3, nan = 'n/a' } = opts;
  if (!isFiniteValue(v)) return nan;
  return `${v.toFixed(digits)} ${unit}`;
}

export function fmtRatio(v: number | null | undefined, opts: FmtOpts = {}): string {
  const { digits = 3, nan = 'n/a' } = opts;
  if (!isFiniteValue(v)) return nan;
  return `${v.toFixed(digits)} (${(v * 100).toFixed(0)}%)`;
}

// Coerce an unknown to a finite number, or null. Used when decoding history
// rows where a column may be a number, null, or an unexpected type, so
// non-finite values never enter arithmetic.
export function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Clamp text to a maximum length at a word boundary. When the cut point has no
// space in its second half, hard-cuts instead. With `ellipsis`, appends a
// single ellipsis character (U+2026) and reserves one character of budget
// for it. ASCII-only chartplotters may render the ellipsis as `?`; the
// trade-off is character-budget vs glyph compatibility, with the canonical
// single-char form chosen here for budget.
export function clampAtWord(text: string, max: number, opts: { ellipsis?: boolean } = {}): string {
  if (max <= 0) return opts.ellipsis ? '…' : '';
  if (text.length <= max) return text;
  const head = text.slice(0, max - (opts.ellipsis ? 1 : 0));
  const lastSpace = head.lastIndexOf(' ');
  const cut = (lastSpace > max / 2 ? head.slice(0, lastSpace) : head).trimEnd();
  return opts.ellipsis ? `${cut}…` : cut;
}

// Signed number with `digits` precision, no unit. Used by the forecast
// analyzer to format absolute differences (delta T, delta wind) where the
// sign is the story but a percent isn't appropriate.
export function fmtSigned(v: number | null, opts: FmtOpts = {}): string {
  const { digits = 1, nan = 'n/a' } = opts;
  if (!isFiniteValue(v)) return nan;
  return signedFixed(v, digits);
}
