// Match an engine id (group 1) off revolutions or any of the aux fields. Some
// gateways publish coolantTemperature, runTime, or oilPressure but not
// revolutions (e.g. an older NMEA-2000 engine that only emits PGN 127489 /
// 127488 fragments), so discovering the engine off any of those keeps the
// analyzers coming up.
const ENGINE_PATTERN =
  /^propulsion\.([^.]+)\.(?:revolutions|coolantTemperature|runTime|oilPressure|temperature|alternatorVoltage|fuel\.rate)$/;
const BANK_PATTERN = /^electrical\.batteries\.([^.]+)\./;

export const SOC_PATH_RE = /^electrical\.batteries\.([^.]+)\.capacity\.stateOfCharge$/;
// Both BMS forms in the wild: `cellN.voltage` (vendor-extension flat form)
// and `cells.<n>.voltage` (the more common community form). Accept both.
export const CELL_VOLT_PATH_RE = /^electrical\.batteries\.([^.]+)\.(?:cell|cells\.)(\d+)\.voltage$/;

// Collect the group-1 capture of every path matching `regex` into a sorted,
// de-duplicated id list. Shared by the engine and bank discoverers, which
// differ only in their pattern.
function collectGroup1(paths: Iterable<string>, regex: RegExp): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const m = p.match(regex);
    if (m?.[1]) out.add(m[1]);
  }
  return Array.from(out).sort();
}

export function discoverEngineIds(paths: Iterable<string>): string[] {
  return collectGroup1(paths, ENGINE_PATTERN);
}

export function discoverBankIds(paths: Iterable<string>): string[] {
  return collectGroup1(paths, BANK_PATTERN);
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

export function discoverWatchedPaths(paths: Iterable<string>, extras: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (WATCH_PREFIXES.some((prefix) => p.startsWith(prefix))) out.add(p);
  }
  for (const e of extras) out.add(e);
  return Array.from(out).sort();
}
