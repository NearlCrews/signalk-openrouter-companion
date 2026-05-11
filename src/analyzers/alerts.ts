import type { AnalyzerTriggerCfg } from '../types.js';
import type {
  Analyzer,
  AnalyzerDeps,
  BatteryEventKind,
  TriggerCtx,
  TriggerSpec,
} from './Analyzer.js';
import { readNumberAt } from './health.js';

const ENTER_SUBKINDS: ReadonlyArray<BatteryEventKind> = ['low-soc-enter', 'cell-imbalance-enter'];

const ALL_SUBKINDS: ReadonlyArray<BatteryEventKind> = [
  'low-soc-enter',
  'low-soc-exit',
  'cell-imbalance-enter',
  'cell-imbalance-exit',
];

function isBatteryEventKind(s: string): s is BatteryEventKind {
  return ALL_SUBKINDS.includes(s as BatteryEventKind);
}

export interface AlertCfg {
  triggers: AnalyzerTriggerCfg;
}

export interface AlertInput {
  subkind: BatteryEventKind;
  bankId: string;
  eventData: { soc?: number; imbalanceV?: number };
  snapshot: {
    voltage: number | null;
    current: number | null;
    stateOfCharge: number | null;
    cycles: number | null;
  };
  [key: string]: unknown;
}

export class AlertAnalyzer implements Analyzer<AlertInput> {
  readonly id = 'alerts';
  readonly title = 'Battery Alerts';
  readonly triggers: ReadonlyArray<TriggerSpec>;

  constructor(private cfg: AlertCfg) {
    const triggers: TriggerSpec[] = [];
    if (cfg.triggers.cron.enabled && cfg.triggers.cron.pattern) {
      triggers.push({ kind: 'cron', pattern: cfg.triggers.cron.pattern });
    }
    if (cfg.triggers.put.enabled && cfg.triggers.put.path) {
      triggers.push({ kind: 'put', path: cfg.triggers.put.path });
    }
    for (const sub of cfg.triggers.events) {
      if (isBatteryEventKind(sub)) {
        triggers.push({ kind: 'battery-event', subkind: sub });
      }
    }
    this.triggers = triggers;
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AlertInput | null> {
    if (ctx.kind !== 'battery-event' || !ctx.batteryEvent || !ctx.bankId) return null;
    const tree = deps.app.getSelfPath('electrical.batteries');
    const bankNode =
      tree && typeof tree === 'object' ? (tree as Record<string, unknown>)[ctx.bankId] : undefined;
    return {
      subkind: ctx.batteryEvent.subkind,
      bankId: ctx.bankId,
      eventData: {
        soc: ctx.batteryEvent.soc,
        imbalanceV: ctx.batteryEvent.imbalanceV,
      },
      snapshot: {
        voltage: readNumberAt(bankNode, 'voltage'),
        current: readNumberAt(bankNode, 'current'),
        stateOfCharge: readNumberAt(bankNode, 'capacity.stateOfCharge'),
        cycles: readNumberAt(bankNode, 'cycles'),
      },
    };
  }

  buildPrompt(input: AlertInput): { system: string; user: string } {
    const system = [
      'You are a marine electrical specialist reading raw battery telemetry from a Signal K server.',
      'A battery bank just crossed a state threshold.',
      'Write a short notification (under 150 words): lead with the bank id and what crossed (e.g., "House bank SoC dropped to 38%"), then the current state, then the most likely cause if obvious from the data.',
      'All numeric values are in Signal K SI base units: voltage in V, current in A, temperature in K, capacity in J, SoC as a 0-1 ratio.',
      'Stick to facts present in the data. Do not speculate beyond the numbers. If you cannot identify a cause from the provided fields, say "cause not determinable from telemetry" rather than guessing.',
      'Format as one paragraph of plain English.',
    ].join(' ');

    const lines = [`Event: ${input.subkind}`, `Bank: ${input.bankId}`];
    const ed = input.eventData;
    if (typeof ed.soc === 'number') {
      lines.push(`Triggering SoC: ${ed.soc.toFixed(3)} (${(ed.soc * 100).toFixed(0)}%)`);
    }
    if (typeof ed.imbalanceV === 'number') {
      lines.push(`Triggering cell imbalance: ${ed.imbalanceV.toFixed(3)} V`);
    }
    const snap = input.snapshot;
    lines.push(`Voltage now: ${fmtUnit(snap.voltage, 'V')}`);
    lines.push(`Current now: ${fmtUnit(snap.current, 'A')}`);
    lines.push(`SoC now: ${fmtRatio(snap.stateOfCharge)}`);
    if (snap.cycles != null) lines.push(`Cycles: ${snap.cycles}`);
    return { system, user: lines.join('\n') };
  }

  async publishOutput(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void> {
    const subkind = ctx.batteryEvent?.subkind;
    if (!subkind) return;
    const path = `notifications.openrouter-companion.alert.${subkind}`;
    const state: 'alert' | 'normal' = ENTER_SUBKINDS.includes(subkind) ? 'alert' : 'normal';
    await deps.publisher.publishOnPath(text, { analyzerId: this.id, ctx }, { path, state });
  }
}

function fmtUnit(v: number | null | undefined, unit: string): string {
  if (v == null) return 'n/a';
  return `${v.toFixed(3)} ${unit}`;
}

function fmtRatio(v: number | null | undefined): string {
  if (v == null) return 'n/a';
  return `${v.toFixed(3)} (${(v * 100).toFixed(0)}%)`;
}
