const ENGINE_RPM_PATTERN = /^propulsion\.([^.]+)\.revolutions$/;
// Some gateways publish coolantTemperature, runTime, or oilPressure but not
// revolutions (e.g. an older NMEA-2000 engine that only emits PGN 127489 /
// 127488 fragments). Discover the engine off any of those so analyzers
// come up.
const ENGINE_AUX_PATTERN =
  /^propulsion\.([^.]+)\.(?:coolantTemperature|runTime|oilPressure|temperature|alternatorVoltage|fuel\.rate)$/;
const BANK_PATTERN = /^electrical\.batteries\.([^.]+)\./;

export const SOC_PATH_RE = /^electrical\.batteries\.([^.]+)\.capacity\.stateOfCharge$/;
// Both BMS forms in the wild: `cellN.voltage` (vendor-extension flat form)
// and `cells.<n>.voltage` (the more common community form). Accept both.
export const CELL_VOLT_PATH_RE = /^electrical\.batteries\.([^.]+)\.(?:cell|cells\.)(\d+)\.voltage$/;

export function discoverEngineIds(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const m = p.match(ENGINE_RPM_PATTERN) ?? p.match(ENGINE_AUX_PATTERN);
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
  // Buffering tanks.fuel.* lets the maintenance prompt cross-check fuel rate
  // against tank-level drift over the session window. If the gateway doesn't
  // publish them, the buffer just stays empty for that prefix.
  'tanks.fuel.',
];

export function discoverWatchedPaths(paths: string[], extras: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (WATCH_PREFIXES.some((prefix) => p.startsWith(prefix))) out.add(p);
  }
  for (const e of extras) out.add(e);
  return Array.from(out).sort();
}
