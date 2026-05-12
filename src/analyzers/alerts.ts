import { fmtRatio, fmtUnit } from '../core/format.js';
import { NOTIFICATION_PATH_PREFIX } from '../core/paths.js';
import { readNumberAt } from '../core/skNode.js';
import { buildTriggers } from '../core/triggers.js';
import { ALERTS_SUPPORTED_EVENTS, type AnalyzerTriggerCfg } from '../types.js';
import type {
  Analyzer,
  AnalyzerDeps,
  BatteryEventKind,
  TriggerCtx,
  TriggerSpec,
} from './Analyzer.js';

const ENTER_SUBKINDS: ReadonlyArray<BatteryEventKind> = ['low-soc-enter', 'cell-imbalance-enter'];

// PGN 126985 (Alert Text) carries this through the NMEA 2000 emitter. Chartplotter
// implementations vary in how much of alertTextDescription they render; 200 ASCII
// chars is comfortably under every cap we have seen and preserves the lead sentence
// the prompt is engineered to produce.
const MAX_ALERT_MESSAGE_CHARS = 200;

function truncateForN2K(message: string): string {
  if (message.length <= MAX_ALERT_MESSAGE_CHARS) return message;
  const head = message.slice(0, MAX_ALERT_MESSAGE_CHARS - 1);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > MAX_ALERT_MESSAGE_CHARS / 2 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
}

function isBatteryEventKind(s: string): s is BatteryEventKind {
  return (ALERTS_SUPPORTED_EVENTS as ReadonlyArray<string>).includes(s);
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
}

export class AlertAnalyzer implements Analyzer<AlertInput> {
  readonly id = 'alerts';
  readonly title = 'Battery Alerts';
  readonly triggers: ReadonlyArray<TriggerSpec>;

  constructor(cfg: AlertCfg) {
    this.triggers = buildTriggers(cfg.triggers, (sub) =>
      isBatteryEventKind(sub) ? { kind: 'battery-event', subkind: sub } : null,
    );
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
      'Output is rendered in the Signal K data browser as a single string. Produce one short paragraph of plain prose (under 150 words). Do not use markdown: no headers, no bullets, no horizontal rules, no section dividers.',
    ].join(' ');

    const lines = [`Event: ${input.subkind}`, `Bank: ${input.bankId}`];
    const ed = input.eventData;
    if (typeof ed.soc === 'number') lines.push(`Triggering SoC: ${fmtRatio(ed.soc)}`);
    if (typeof ed.imbalanceV === 'number') {
      lines.push(`Triggering cell imbalance: ${fmtUnit(ed.imbalanceV, 'V')}`);
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
    const path = `${NOTIFICATION_PATH_PREFIX}alert.${subkind}`;
    const state: 'alert' | 'normal' = ENTER_SUBKINDS.includes(subkind) ? 'alert' : 'normal';
    const message = truncateForN2K(text);
    await deps.publisher.publishOnPath(message, { analyzerId: this.id, ctx }, { path, state });
  }
}
