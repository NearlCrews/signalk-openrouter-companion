// Plugin-namespaced Signal K notification and PUT paths, plus per-engine and
// per-bank path builders. Centralized so the convention can't drift between
// analyzers, schema defaults, and tests.

const NOTIFICATION_PATH_PREFIX = 'notifications.openrouter-companion.';
const PUT_PATH_PREFIX = 'plugins.openrouter-companion.';

export const PROPULSION_PREFIX = 'propulsion.';
export const BATTERIES_PARENT_PATH = 'electrical.batteries';

export type BatteryAlertKind = 'lowSoc' | 'cellImbalance';

export function notificationReportPath(analyzerId: string): string {
  return `${NOTIFICATION_PATH_PREFIX}${analyzerId}.report`;
}

// Canonical per-bank battery alert notification path. Distinct per bank so
// `signalk-nmea2000-emitter-cannon` assigns each bank its own PGN 126983 entry
// instead of overwriting a single shared cache slot. Third-party bridges
// already watching `notifications.electrical.batteries.*` pick these up.
export function batteryAlertPath(bankId: string, kind: BatteryAlertKind): string {
  return `notifications.electrical.batteries.${bankId}.${kind}`;
}

// Stable 16-bit alert identifier derived from the SK path via FNV-1a.
// `signalk-nmea2000-emitter-cannon` uses this verbatim for PGN 126983's
// "Alert Identifier"; supplying our own keeps the chartplotter's alert id
// stable across `signalk-nmea2000-emitter-cannon` restarts (its
// auto-counter resets on config reload).
export function alertIdFor(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i += 1) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0xffff || 1;
}

// Per-analyzer PUT path. The verb is fixed at 'run' across the plugin (the
// SK PUT shape used here always fires the analyzer once); a future verb would
// be a new function rather than a parameter.
export function pluginPutPath(analyzerId: string): string {
  return `${PUT_PATH_PREFIX}${analyzerId}.run`;
}

export function enginePathPrefix(engineId: string): string {
  return `${PROPULSION_PREFIX}${engineId}.`;
}

export function engineNotificationsPath(engineId: string): string {
  return `notifications.propulsion.${engineId}`;
}

export function enginePaths(engineId: string): { rpm: string; fuelRate: string } {
  const prefix = enginePathPrefix(engineId);
  return { rpm: `${prefix}revolutions`, fuelRate: `${prefix}fuel.rate` };
}

function bankPathPrefix(bankId: string): string {
  return `electrical.batteries.${bankId}.`;
}

export function bankPaths(bankId: string): {
  voltage: string;
  soc: string;
  capacityActual: string;
  cycles: string;
} {
  const prefix = bankPathPrefix(bankId);
  return {
    voltage: `${prefix}voltage`,
    soc: `${prefix}capacity.stateOfCharge`,
    capacityActual: `${prefix}capacity.actual`,
    cycles: `${prefix}cycles`,
  };
}

export const SOG_PATH = 'navigation.speedOverGround';

// Barometric pressure: the headline path for the forecast analyzer's
// pre-computed 3-hour tendency. Named separately so the tendency math and the
// canonical path list cannot drift.
export const WEATHER_PRESSURE_PATH = 'environment.outside.pressure';

// Weather telemetry the forecast ("Weather Outlook Advisor") analyzer reads.
// Two families. Canonical paths are Signal K 1.8.2 standard leaves any
// barometer/anemometer or weather plugin can feed. Extension paths are the
// producer-namespaced `environment.weather.*` leaves emitted by
// signalk-virtual-weather-sensors. The analyzer degrades gracefully when only
// the canonical family is present; the extension family enriches the outlook.
// Fixed canonical strings: no per-instance discovery is needed (unlike engines
// and battery banks), so the analyzer subscribes this list directly.
export const WEATHER_CANONICAL_PATHS = [
  WEATHER_PRESSURE_PATH,
  'environment.outside.temperature',
  'environment.outside.dewPointTemperature',
  'environment.outside.relativeHumidity',
  'environment.wind.speedOverGround',
  'environment.wind.directionTrue',
] as const;

export const WEATHER_EXTENSION_PATHS = [
  'environment.weather.speedGust',
  'environment.weather.cloudCover',
  'environment.weather.cloudCeiling',
  'environment.weather.visibility',
  'environment.weather.precipitationLastHour',
  'environment.weather.temperatureDeparture24h',
] as const;
