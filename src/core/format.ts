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
