const ENGINE_RPM_PATTERN = /^propulsion\.([^.]+)\.revolutions$/;

export function discoverEngineIds(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const m = p.match(ENGINE_RPM_PATTERN);
    if (m?.[1]) out.add(m[1]);
  }
  return Array.from(out).sort();
}

const WATCH_PREFIXES = [
  'propulsion.',
  'electrical.batteries.',
  'electrical.alternators.',
  'electrical.chargers.',
];

export function discoverWatchedPaths(paths: string[], extras: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (WATCH_PREFIXES.some((prefix) => p.startsWith(prefix))) out.add(p);
  }
  for (const e of extras) out.add(e);
  return Array.from(out).sort();
}
