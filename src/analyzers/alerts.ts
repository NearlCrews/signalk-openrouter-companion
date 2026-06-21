import { resolveSystemPrompt } from '../core/cfg.js';
import { clampAtWord, fmtRatio, fmtUnit } from '../core/format.js';
import {
  alertIdFor,
  BATTERIES_PARENT_PATH,
  type BatteryAlertKind,
  batteryAlertPath,
} from '../core/paths.js';
import { asTreeMap, readBankSnapshot } from '../core/skNode.js';
import { buildTriggers } from '../core/triggers.js';
import { ALERTS_SUPPORTED_EVENTS, type AnalyzerTriggerCfg } from '../types.js';
import type {
  AnalysisInput,
  Analyzer,
  AnalyzerDeps,
  BatteryEventKind,
  PublishRunMeta,
  TriggerCtx,
  TriggerSpec,
} from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

// PGN 126985 (Alert Text Description) is the field chartplotters display.
// Real-world caps observed across MFDs (Raymarine Axiom ~60, B&G Zeus ~70,
// Furuno TZTouch ~80, Garmin ~72), so 64 chars is the safe headline budget.
// The chartplotter alert and the SK notification value both carry this
// truncated headline; the JSONL log keeps the full LLM text (passed
// separately as `logText` to publishOnPath).
const MAX_ALERT_MESSAGE_CHARS = 64;

function truncateForN2K(message: string): string {
  return clampAtWord(message, MAX_ALERT_MESSAGE_CHARS, { ellipsis: true });
}

function isBatteryEventKind(s: string): s is BatteryEventKind {
  return (ALERTS_SUPPORTED_EVENTS as readonly string[]).includes(s);
}

// Maps the enter/exit subkind to a canonical per-bank path plus state, so
// enter and exit share one cache slot in `signalk-nmea2000-emitter-cannon`.
const ALERT_ROUTING: Record<
  BatteryEventKind,
  { kind: BatteryAlertKind; state: 'alert' | 'normal' }
> = {
  'low-soc-enter': { kind: 'lowSoc', state: 'alert' },
  'low-soc-exit': { kind: 'lowSoc', state: 'normal' },
  'cell-imbalance-enter': { kind: 'cellImbalance', state: 'alert' },
  'cell-imbalance-exit': { kind: 'cellImbalance', state: 'normal' },
};

export interface AlertCfg {
  triggers: AnalyzerTriggerCfg;
  customSystemPrompt?: string;
}

// Built once at module load using the MAX_ALERT_MESSAGE_CHARS constant so
// bumping the constant updates the prompt automatically. Custom overrides
// see whatever budget the operator typed.
export const ALERTS_DEFAULT_SYSTEM_PROMPT = [
  'You are a marine electrical specialist reading raw battery telemetry from a Signal K server.',
  'A battery bank just crossed a state threshold.',
  `Write a very short headline (under ${MAX_ALERT_MESSAGE_CHARS} characters) that will display on a chartplotter's NMEA 2000 alert. Lead with the bank id and what crossed, e.g., "House SoC 38%" or "Starter cell imbalance 0.12 V".`,
  'All numeric values are in Signal K SI base units: voltage in V, current in A, temperature in K, capacity in J, SoC as a 0-1 ratio.',
  'Stick to facts present in the data. Do not speculate beyond the numbers.',
  'Output is rendered on a chartplotter and in the Signal K data browser. Plain prose, no markdown, no headers, no bullets. One short sentence.',
].join(' ');

export interface AlertInput extends AnalysisInput {
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
  readonly title = ANALYZER_TITLES.alerts;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  // Safety analyzer: a sustained battery-event failure must still beep, so this
  // opts into audible failure. See Analyzer.failureAudible for the rationale.
  readonly failureAudible = true;
  private readonly systemPrompt: string;

  constructor(cfg: AlertCfg) {
    this.triggers = buildTriggers(this.id, cfg.triggers, (sub) =>
      isBatteryEventKind(sub) ? { kind: 'battery-event', subkind: sub } : null,
    );
    this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, ALERTS_DEFAULT_SYSTEM_PROMPT);
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AlertInput | null> {
    if (ctx.kind !== 'battery-event' || !ctx.batteryEvent || !ctx.bankId) return null;
    const bankNode = asTreeMap(deps.app.getSelfPath(BATTERIES_PARENT_PATH))?.[ctx.bankId];
    const { voltage, current, stateOfCharge, cycles } = readBankSnapshot(bankNode);
    return {
      subkind: ctx.batteryEvent.subkind,
      bankId: ctx.bankId,
      eventData: {
        soc: ctx.batteryEvent.soc,
        imbalanceV: ctx.batteryEvent.imbalanceV,
      },
      snapshot: { voltage, current, stateOfCharge, cycles },
    };
  }

  buildPrompt(input: AlertInput): { system: string; user: string } {
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
    return { system: this.systemPrompt, user: lines.join('\n') };
  }

  async publishOutput(
    text: string,
    ctx: TriggerCtx,
    deps: AnalyzerDeps,
    run?: PublishRunMeta,
  ): Promise<void> {
    const subkind = ctx.batteryEvent?.subkind;
    const bankId = ctx.bankId;
    // collectContext already guarantees both; this is a type guard. If it ever
    // fires the LLM result is discarded after the budget was spent, so log it.
    if (!subkind || !bankId) {
      deps.logger.error('alerts.publishOutput: missing subkind or bankId; discarding result');
      return;
    }
    const { kind, state } = ALERT_ROUTING[subkind];
    const path = batteryAlertPath(bankId, kind);
    // Truncated headline for the chartplotter alert (PGN 126985); full LLM
    // text into the JSONL log so an operator reviewing history reads the
    // reasoning behind the alert, not just the headline.
    await deps.publisher.publishOnPath(
      truncateForN2K(text),
      { analyzerId: this.id, ctx, run },
      { path, state, alertId: alertIdFor(path), logText: text },
    );
  }
}
