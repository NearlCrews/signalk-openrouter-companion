import type { AnalyzerTriggerCfg } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';

export interface MaintenanceCfg {
  triggers: AnalyzerTriggerCfg;
  minSessionSeconds: number;
}

export class MaintenanceAnalyzer implements Analyzer {
  readonly id = 'maintenance';
  readonly title = 'Maintenance Advisor';
  readonly triggers: ReadonlyArray<TriggerSpec>;

  constructor(private cfg: MaintenanceCfg) {
    const triggers: TriggerSpec[] = [];
    if (cfg.triggers.cron.enabled && cfg.triggers.cron.pattern) {
      triggers.push({ kind: 'cron', pattern: cfg.triggers.cron.pattern });
    }
    if (cfg.triggers.put.enabled && cfg.triggers.put.path) {
      triggers.push({ kind: 'put', path: cfg.triggers.put.path });
    }
    if (cfg.triggers.events.includes('engine-stop')) {
      triggers.push({ kind: 'engine-stop' });
    }
    this.triggers = triggers;
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AnalysisInput | null> {
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
    const telemetry: Record<string, unknown> = {};
    for (const path of watchedPaths) {
      const s = deps.buffer.summarize(path, startMs, endMs);
      if (s) telemetry[path] = s;
    }
    const engineNotifications = snapshotEngineNotifications(deps, engineId);
    const batteries = snapshotBatteries(deps);
    const baselines = deps.questdb
      ? await fetchBaselines(deps.questdb, watchedPaths, deps.app.selfContext ?? 'vessels.self')
      : null;

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
      baselines,
    };
  }

  buildPrompt(input: AnalysisInput): { system: string; user: string } {
    const system = [
      'You are an experienced marine engine technician reading raw telemetry from a Signal K server.',
      'Produce a concise plain-English report of the engine session described in the user content.',
      'Stick to facts present in the data. Do not speculate beyond what the numbers show.',
      'If any engine notification slot is non-normal, surface it prominently.',
      'If 30-day baselines are present, briefly compare this session against them.',
      'Format the response as markdown with a 1-line summary, then short sections for Telemetry, Alarms, Batteries, and (if available) Baselines.',
      'Stay under 350 words.',
    ].join(' ');

    const session = input.session as Record<string, unknown>;
    const telemetry = input.telemetry as Record<string, Record<string, unknown>>;
    const alarms = input.engineNotifications as Record<string, unknown>;
    const batteries = input.batteries as Array<Record<string, unknown>>;
    const baselines = input.baselines as Record<string, unknown> | null;

    const lines: string[] = [];
    lines.push('## Session');
    lines.push(`Engine: ${String(session.engineId)}`);
    lines.push(`Start: ${String(session.start)}`);
    lines.push(`End:   ${String(session.end)}`);
    lines.push(`Duration: ${String(session.durationSec)} s`);
    lines.push('');
    lines.push('## Telemetry');
    for (const [path, s] of Object.entries(telemetry)) {
      lines.push(
        `- ${path}: min=${fmt(s.min)} max=${fmt(s.max)} mean=${fmt(s.mean)} count=${fmt(s.count)} sources=${JSON.stringify(s.sources)}`,
      );
    }
    lines.push('');
    lines.push('## Engine notification slots');
    for (const [slot, value] of Object.entries(alarms)) {
      lines.push(`- ${slot}: ${JSON.stringify(value)}`);
    }
    lines.push('');
    lines.push('## Batteries (end-of-session snapshot)');
    for (const b of batteries) {
      lines.push(`- ${String(b.id)}: ${JSON.stringify(b)}`);
    }
    if (baselines && Object.keys(baselines).length > 0) {
      lines.push('');
      lines.push('## 30-day baselines');
      for (const [path, stats] of Object.entries(baselines)) {
        lines.push(`- ${path}: ${JSON.stringify(stats)}`);
      }
    }
    return { system, user: lines.join('\n') };
  }
}

function listWatchedPaths(deps: AnalyzerDeps, engineId: string): string[] {
  const out = new Set<string>();
  for (const [path] of deps.buffer.paths()) {
    if (path.startsWith(`propulsion.${engineId}.`)) out.add(path);
    else if (path.startsWith('electrical.batteries.')) out.add(path);
    else if (path.startsWith('electrical.alternators.')) out.add(path);
    else if (path.startsWith('electrical.chargers.')) out.add(path);
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

interface BatterySnapshot {
  id: string;
  voltage: number | null;
  current: number | null;
  stateOfCharge: number | null;
  nominalCapacityJ: number | null;
}

function snapshotBatteries(deps: AnalyzerDeps): BatterySnapshot[] {
  const tree = deps.app.getSelfPath('electrical.batteries');
  if (!tree || typeof tree !== 'object') return [];
  const out: BatterySnapshot[] = [];
  for (const [id, node] of Object.entries(tree as Record<string, unknown>)) {
    const get = (subpath: string): number | null => {
      const segs = subpath.split('.');
      let cur: unknown = node;
      for (const seg of segs) {
        if (!cur || typeof cur !== 'object') return null;
        cur = (cur as Record<string, unknown>)[seg];
      }
      if (cur && typeof cur === 'object' && 'value' in (cur as Record<string, unknown>)) {
        const v = (cur as { value: unknown }).value;
        return typeof v === 'number' ? v : null;
      }
      return null;
    };
    out.push({
      id,
      voltage: get('voltage'),
      current: get('current'),
      stateOfCharge: get('capacity.stateOfCharge'),
      nominalCapacityJ: get('capacity.nominal'),
    });
  }
  return out;
}

async function fetchBaselines(
  questdb: NonNullable<AnalyzerDeps['questdb']>,
  paths: string[],
  context: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await Promise.all(
    paths.map(async (p) => {
      try {
        const b = await questdb.baselineFor(p, context, 30);
        if (b) out[p] = b;
      } catch {
        // best-effort
      }
    }),
  );
  return out;
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}
