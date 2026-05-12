import { WATCH_PREFIXES } from '../core/discovery.js';
import { fmtNumber } from '../core/format.js';
import { readNumberAt } from '../core/skNode.js';
import { buildTriggers } from '../core/triggers.js';
import type { AnalyzerTriggerCfg } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';

export interface MaintenanceCfg {
  triggers: AnalyzerTriggerCfg;
  minSessionSeconds: number;
}

interface SessionSummary {
  engineId: string;
  start: string;
  end: string;
  durationSec: number;
}

interface TelemetryStats {
  min: number;
  max: number;
  mean: number;
  count: number;
  sources: string[];
}

interface BatterySnapshot {
  id: string;
  voltage: number | null;
  current: number | null;
  stateOfCharge: number | null;
  nominalCapacityJ: number | null;
}

export interface MaintenanceInput extends AnalysisInput {
  session: SessionSummary;
  telemetry: Record<string, TelemetryStats>;
  engineNotifications: Record<string, unknown>;
  batteries: BatterySnapshot[];
}

export class MaintenanceAnalyzer implements Analyzer<MaintenanceInput> {
  readonly id = 'maintenance';
  readonly title = 'Maintenance Advisor';
  readonly triggers: ReadonlyArray<TriggerSpec>;

  constructor(private cfg: MaintenanceCfg) {
    this.triggers = buildTriggers(cfg.triggers, (sub) =>
      sub === 'engine-stop' ? { kind: 'engine-stop' } : null,
    );
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<MaintenanceInput | null> {
    let engineId: string;
    let startMs: number;
    let endMs: number;
    if (ctx.kind === 'engine-stop') {
      const sess = ctx.engineSession;
      if (!sess || sess.durationSec < this.cfg.minSessionSeconds) return null;
      engineId = sess.engineId;
      startMs = sess.start.getTime();
      endMs = sess.end.getTime();
    } else if (ctx.kind === 'put' || ctx.kind === 'cron') {
      endMs = ctx.firedAt.getTime();
      startMs = endMs - 30 * 60 * 1000;
      engineId = 'unknown';
    } else {
      return null;
    }

    const watchedPaths = listWatchedPaths(deps, engineId);
    const telemetry: Record<string, TelemetryStats> = {};
    for (const path of watchedPaths) {
      const s = deps.buffer.summarize(path, startMs, endMs);
      if (s) telemetry[path] = s;
    }
    const engineNotifications = snapshotEngineNotifications(deps, engineId);
    const batteries = snapshotBatteries(deps);

    return {
      session: {
        engineId,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        durationSec: Math.round((endMs - startMs) / 1000),
      },
      telemetry,
      engineNotifications,
      batteries,
    };
  }

  buildPrompt(input: MaintenanceInput): { system: string; user: string } {
    const system = [
      'You are an experienced marine engine technician reading raw telemetry from a Signal K server.',
      'Produce a concise plain-English report of the engine session described in the user content.',
      'Stick to facts present in the data. Do not speculate beyond what the numbers show.',
      'All numeric values are in Signal K SI base units except where the SK spec dictates otherwise: voltage in V, current in A, temperature in K, capacity in J, SoC as a 0-1 ratio. propulsion.*.revolutions is in Hz (rev/s, the documented Signal K unit for that path: do not convert to rad/s). Do not invent unit conversions you cannot derive.',
      'If any engine notification slot is non-normal, surface it prominently.',
      'If you cannot identify a cause from the provided fields, say "cause not determinable from telemetry" rather than guessing. Any claim must cite the field that supports it.',
      'Output is rendered in the Signal K data browser as a single string. Produce one short paragraph of plain prose (80-150 words). Do not use markdown: no headers, no bullets, no horizontal rules, no section dividers. Use semicolons and commas to separate points within the paragraph. Lead with the session headline (engine, duration, what happened), then weave in alarm state and battery state if there is anything worth noting.',
    ].join(' ');

    const { session, telemetry, engineNotifications, batteries } = input;
    const f = (v: unknown) => fmtNumber(v, { nan: 'n/a (no samples)' });

    const lines: string[] = [];
    lines.push('## Session');
    lines.push(`Engine: ${session.engineId}`);
    lines.push(`Start: ${session.start}`);
    lines.push(`End:   ${session.end}`);
    lines.push(`Duration: ${session.durationSec} s`);
    lines.push('');
    lines.push('## Telemetry');
    for (const path of Object.keys(telemetry).sort()) {
      const s = telemetry[path];
      if (!s || s.count === 0) continue;
      const unit = unitForPath(path);
      const unitSuffix = unit ? ` ${unit}` : '';
      lines.push(
        `- ${path}: min=${f(s.min)} max=${f(s.max)} mean=${f(s.mean)}${unitSuffix} count=${f(s.count)} sources=${JSON.stringify(s.sources)}`,
      );
    }
    lines.push('');
    lines.push('## Engine notification slots');
    for (const [slot, value] of Object.entries(engineNotifications)) {
      lines.push(`- ${slot}: ${JSON.stringify(value)}`);
    }
    lines.push('');
    lines.push('## Batteries (end-of-session snapshot)');
    for (const b of batteries) {
      lines.push(`- ${b.id}: ${JSON.stringify(b)}`);
    }
    return { system, user: lines.join('\n') };
  }
}

function listWatchedPaths(deps: AnalyzerDeps, engineId: string): string[] {
  const out = new Set<string>();
  for (const path of deps.buffer.pathKeys()) {
    if (path.startsWith(`propulsion.${engineId}.`)) {
      out.add(path);
      continue;
    }
    if (path.startsWith('propulsion.')) continue;
    if (WATCH_PREFIXES.some((prefix) => path.startsWith(prefix))) out.add(path);
  }
  return Array.from(out).sort();
}

function snapshotEngineNotifications(
  deps: AnalyzerDeps,
  engineId: string,
): Record<string, unknown> {
  const tree = deps.app.getSelfPath(`notifications.propulsion.${engineId}`);
  if (!tree || typeof tree !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [slot, node] of Object.entries(tree as Record<string, unknown>)) {
    if (node && typeof node === 'object' && 'value' in (node as Record<string, unknown>)) {
      out[slot] = (node as { value: unknown }).value;
    }
  }
  return out;
}

function snapshotBatteries(deps: AnalyzerDeps): BatterySnapshot[] {
  const tree = deps.app.getSelfPath('electrical.batteries');
  if (!tree || typeof tree !== 'object') return [];
  const out: BatterySnapshot[] = [];
  for (const [id, node] of Object.entries(tree as Record<string, unknown>)) {
    out.push({
      id,
      voltage: readNumberAt(node, 'voltage'),
      current: readNumberAt(node, 'current'),
      stateOfCharge: readNumberAt(node, 'capacity.stateOfCharge'),
      nominalCapacityJ: readNumberAt(node, 'capacity.nominal'),
    });
  }
  return out;
}

const UNIT_BY_SUFFIX: ReadonlyArray<readonly [suffix: string, unit: string]> = [
  ['.revolutions', 'Hz'],
  ['.voltage', 'V'],
  ['.current', 'A'],
  ['.temperature', 'K'],
  ['Temperature', 'K'],
  ['.stateOfCharge', 'ratio'],
  ['capacity.nominal', 'J'],
  ['capacity.remaining', 'J'],
  ['.runTime', 's'],
  ['.fuel.rate', 'm3/s'],
  ['.fuel.level', 'ratio'],
  ['.fuel.used', 'ratio'],
  ['.oilPressure', 'Pa'],
];

function unitForPath(path: string): string | null {
  for (const [suffix, unit] of UNIT_BY_SUFFIX) {
    if (path.endsWith(suffix)) return unit;
  }
  return null;
}
