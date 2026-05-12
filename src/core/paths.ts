// Plugin-namespaced Signal K notification and PUT paths, plus per-engine and
// per-bank path builders. Centralized so the convention can't drift between
// analyzers, schema defaults, and tests.

export const NOTIFICATION_PATH_PREFIX = 'notifications.openrouter-companion.';
export const PUT_PATH_PREFIX = 'plugins.openrouter-companion.';
export const ALERT_NOTIFICATION_PREFIX = `${NOTIFICATION_PATH_PREFIX}alert.`;

export function notificationReportPath(analyzerId: string): string {
  return `${NOTIFICATION_PATH_PREFIX}${analyzerId}.report`;
}

export function alertNotificationPath(subkind: string): string {
  return `${ALERT_NOTIFICATION_PREFIX}${subkind}`;
}

export function pluginPutPath(analyzerId: string, verb = 'run'): string {
  return `${PUT_PATH_PREFIX}${analyzerId}.${verb}`;
}

export function enginePathPrefix(engineId: string): string {
  return `propulsion.${engineId}.`;
}

export function engineNotificationsPath(engineId: string): string {
  return `notifications.propulsion.${engineId}`;
}

export function enginePaths(engineId: string): { rpm: string; fuelRate: string } {
  const prefix = enginePathPrefix(engineId);
  return { rpm: `${prefix}revolutions`, fuelRate: `${prefix}fuel.rate` };
}

export function bankPathPrefix(bankId: string): string {
  return `electrical.batteries.${bankId}.`;
}

export function bankPaths(bankId: string): {
  voltage: string;
  current: string;
  soc: string;
  capacityActual: string;
  capacityNominal: string;
  cycles: string;
} {
  const prefix = bankPathPrefix(bankId);
  return {
    voltage: `${prefix}voltage`,
    current: `${prefix}current`,
    soc: `${prefix}capacity.stateOfCharge`,
    capacityActual: `${prefix}capacity.actual`,
    capacityNominal: `${prefix}capacity.nominal`,
    cycles: `${prefix}cycles`,
  };
}

export const SOG_PATH = 'navigation.speedOverGround';
