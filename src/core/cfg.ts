// Sanitize a numeric configuration value: must be a finite integer >= 1.
// Caller-supplied min/max clamp on top of that. Falls back to `fallback` on
// non-finite, non-numeric, or below-1 input.
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
