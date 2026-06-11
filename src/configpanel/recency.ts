// Humanize an age in milliseconds as a short "Xs ago" / "Xm ago" / "Xh ago" /
// "Xd ago" string. Returns "unknown" for a missing, non-finite, or negative age
// so the caller can decide whether to render it. Kept JSX-free so it is
// unit-testable on its own.
export function humanizeAgo(ageMs: number | undefined): string {
  if (ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
