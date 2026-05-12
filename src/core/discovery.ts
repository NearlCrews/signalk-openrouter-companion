const ENGINE_RPM_PATTERN = /^propulsion\.([^.]+)\.revolutions$/;
const BANK_PATTERN = /^electrical\.batteries\.([^.]+)\./;

export const SOC_PATH_RE = /^electrical\.batteries\.([^.]+)\.capacity\.stateOfCharge$/;
// Both BMS forms in the wild: `cellN.voltage` (vendor-extension flat form)
// and `cells.<n>.voltage` (the more common community form). Accept both.
export const CELL_VOLT_PATH_RE = /^electrical\.batteries\.([^.]+)\.(?:cell|cells\.)(\d+)\.voltage$/;

export function discoverEngineIds(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const m = p.match(ENGINE_RPM_PATTERN);
    if (m?.[1]) out.add(m[1]);
  }
  return Array.from(out).sort();
}

export function discoverBankIds(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const m = p.match(BANK_PATTERN);
    if (m?.[1]) out.add(m[1]);
  }
  return Array.from(out).sort();
}

export const WATCH_PREFIXES: ReadonlyArray<string> = [
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
