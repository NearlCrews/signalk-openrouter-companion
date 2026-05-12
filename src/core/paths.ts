// Plugin-namespaced Signal K notification and PUT paths, plus per-engine and
// per-bank path builders. Centralized so the convention can't drift between
// analyzers, schema defaults, and tests.

export const NOTIFICATION_PATH_PREFIX = 'notifications.openrouter-companion.';
export const PUT_PATH_PREFIX = 'plugins.openrouter-companion.';

export function notificationReportPath(analyzerId: string): string {
  return `${NOTIFICATION_PATH_PREFIX}${analyzerId}.report`;
}

export function pluginPutPath(analyzerId: string, verb = 'run'): string {
  return `${PUT_PATH_PREFIX}${analyzerId}.${verb}`;
}

export function enginePaths(engineId: string): { rpm: string; fuelRate: string } {
  return {
    rpm: `propulsion.${engineId}.revolutions`,
    fuelRate: `propulsion.${engineId}.fuel.rate`,
  };
}

export function bankPaths(bankId: string): {
  voltage: string;
  current: string;
  soc: string;
  capacityActual: string;
  capacityNominal: string;
  cycles: string;
} {
  const base = `electrical.batteries.${bankId}`;
  return {
    voltage: `${base}.voltage`,
    current: `${base}.current`,
    soc: `${base}.capacity.stateOfCharge`,
    capacityActual: `${base}.capacity.actual`,
    capacityNominal: `${base}.capacity.nominal`,
    cycles: `${base}.cycles`,
  };
}

export const SOG_PATH = 'navigation.speedOverGround';
