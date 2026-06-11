import { asFiniteNumber } from './format.js';

// Return v when it is a finite number at or above `min`, else the fallback.
// Used to sanitize float configuration values (RPM thresholds, seconds) that,
// unlike clampPositiveInt, keep their fractional part.
export function clampMin(v: unknown, min: number, fallback: number): number {
  const n = asFiniteNumber(v);
  return n != null && n >= min ? n : fallback;
}

// Return v when it is a finite number within [min, max], else the fallback.
export function clampRange(v: unknown, min: number, max: number, fallback: number): number {
  const n = asFiniteNumber(v);
  return n != null && n >= min && n <= max ? n : fallback;
}

// Return v when it is any finite number, else the fallback. No range gate, for
// signed configuration values (an RPM threshold may legitimately be any finite
// value the operator picks).
export function finiteOr(v: unknown, fallback: number): number {
  return asFiniteNumber(v) ?? fallback;
}

// Sanitize a numeric configuration value. Falls back to `fallback` when the
// input is not a finite number >= 1; otherwise it is truncated to an integer
// and clamped into the caller-supplied min/max range.
export function clampPositiveInt(
  v: number,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  if (!Number.isFinite(v) || v < 1) return fallback;
  const n = Math.trunc(v);
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// Pick the user's customSystemPrompt if it has non-whitespace content,
// otherwise the analyzer's built-in default. Centralizes the trim/fallback
// pattern that every analyzer constructor would otherwise repeat verbatim.
export function resolveSystemPrompt(custom: string | undefined, fallback: string): string {
  const trimmed = custom?.trim();
  return trimmed ? trimmed : fallback;
}

// Shared opening line for every long-form report prompt. The first line of the
// reply becomes the chartplotter notification (see headlineOf in publisher.ts),
// so it must be short and plain; the full report is logged to disk. Kept
// identical across analyzers so the publisher's headline split has one
// contract to rely on.
export const REPORT_HEADLINE_INSTRUCTION =
  'Begin your reply with a single headline line, then an empty line, then the full report. The headline is at most 80 characters of plain, conversational language that a person reads at a glance like a phone notification: it states only the single most important takeaway, with no statistics, no lists, and no jargon.';

// Shared body-format clause for the long-form report prompts. Each analyzer
// appends its own content-specific sentence after this.
export const REPORT_BODY_INSTRUCTION =
  'The full report is one short paragraph of plain prose (80 to 150 words) rendered in the Signal K data browser. Do not use markdown: no headers, no bullets, no horizontal rules, no section dividers. Use semicolons and commas to separate points.';
