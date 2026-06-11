// Shared time-unit constants in milliseconds. Kept here so the trend
// analyzers (aging, drift, forecast) share one definition instead of each
// redeclaring the same literal.
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

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

// Coerce an unknown to a finite number, or null. Used by analyzers decoding
// QuestDB rows (where a column may be a number, null, or an unexpected type)
// before computing deltas, so non-finite values never enter arithmetic.
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

// Rolling-window stats clause shared by the battery prompt summary lines in
// the maintenance and health analyzers, so the template cannot drift between
// them. Structural parameter shape: BufferSummary satisfies it without this
// module importing buffer.ts.
export function fmtStats(s: { min: number; max: number; mean: number; count: number }): string {
  return `min=${fmtNumber(s.min)} max=${fmtNumber(s.max)} mean=${fmtNumber(s.mean)} count=${fmtNumber(s.count)}`;
}

// The per-bank battery block shared verbatim by the maintenance and health
// prompts: header, the always-present readings, the optional readings, then
// one stats line per labeled summary. The caller supplies the summary labels
// ('voltage (session)' vs 'voltage 24h') and appends any analyzer-specific
// lines after. Structural bank shape: BankSnapshot satisfies it without this
// module importing skNode.ts.
export function pushBankLines(
  lines: string[],
  id: string,
  bank: {
    voltage: number | null;
    current: number | null;
    stateOfCharge: number | null;
    nominalCapacityJ: number | null;
    cycles: number | null;
    temperatureK: number | null;
  },
  summaries: ReadonlyArray<{
    label: string;
    summary: { min: number; max: number; mean: number; count: number } | null;
  }>,
): void {
  lines.push(`### Bank: ${id}`);
  lines.push(`- voltage now: ${fmtNumber(bank.voltage)}`);
  lines.push(`- current now: ${fmtNumber(bank.current)}`);
  lines.push(`- state of charge: ${fmtNumber(bank.stateOfCharge)}`);
  if (bank.nominalCapacityJ != null)
    lines.push(`- nominal capacity (J): ${fmtNumber(bank.nominalCapacityJ)}`);
  if (bank.cycles != null) lines.push(`- cycles: ${fmtNumber(bank.cycles)}`);
  if (bank.temperatureK != null) lines.push(`- temperature (K): ${fmtNumber(bank.temperatureK)}`);
  for (const { label, summary } of summaries) {
    if (summary) lines.push(`- ${label}: ${fmtStats(summary)}`);
  }
}

// Signed number with `digits` precision, no unit. Used by the forecast
// analyzer to format absolute differences (delta T, delta wind) where the
// sign is the story but a percent isn't appropriate.
export function fmtSigned(v: number | null, opts: FmtOpts = {}): string {
  const { digits = 1, nan = 'n/a' } = opts;
  if (!isFiniteValue(v)) return nan;
  return signedFixed(v, digits);
}
