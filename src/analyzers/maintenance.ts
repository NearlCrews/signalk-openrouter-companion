import type { BufferSummary } from '../core/buffer.js';
import {
  REPORT_BODY_INSTRUCTION,
  REPORT_HEADLINE_INSTRUCTION,
  resolveSystemPrompt,
} from '../core/cfg.js';
import { discoverEngineIds, WATCH_PREFIXES } from '../core/discovery.js';
import { fmtNumber, pushBankLines } from '../core/format.js';
import {
  BATTERIES_PARENT_PATH,
  bankPaths,
  engineNotificationsPath,
  enginePathPrefix,
  PROPULSION_PREFIX,
} from '../core/paths.js';
import {
  asTreeMap,
  type BankSnapshot,
  isBankNode,
  readBankSnapshot,
  readValueAt,
} from '../core/skNode.js';
import { buildTriggers } from '../core/triggers.js';
import { type AnalyzerTriggerCfg, MAINTENANCE_SUPPORTED_EVENTS } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

export interface MaintenanceCfg {
  triggers: AnalyzerTriggerCfg;
  minSessionSeconds: number;
  // Operator-configured extra Signal K paths to fold into the session report.
  // These are buffered by the plugin lifecycle but are not necessarily under
  // WATCH_PREFIXES, so the analyzer must be told about them explicitly.
  extraWatchedPaths?: string[];
  customSystemPrompt?: string;
}

export const MAINTENANCE_DEFAULT_SYSTEM_PROMPT = [
  'You are an experienced marine engine technician reading raw telemetry from a Signal K server.',
  'Produce a concise plain-English report of the engine session described in the user content.',
  'Stick to facts present in the data. Do not speculate beyond what the numbers show.',
  'All numeric values are in Signal K SI base units except where the SK spec dictates otherwise: voltage in V, current in A, temperature in K, capacity in J, SoC as a 0-1 ratio. propulsion.*.revolutions is in Hz (rev/s, the documented Signal K unit for that path: do not convert to rad/s). Do not invent unit conversions you cannot derive.',
  'If any engine notification slot is non-normal, surface it prominently.',
  'If you cannot identify a cause from the provided fields, say "cause not determinable from telemetry" rather than guessing. Any claim must cite the field that supports it.',
  REPORT_HEADLINE_INSTRUCTION,
  REPORT_BODY_INSTRUCTION,
  'Cover the engine session (engine, duration, what happened), then alarm state and battery state if there is anything worth noting.',
].join(' ');

interface SessionSummary {
  engineId: string;
  start: string;
  end: string;
  durationSec: number;
}

interface BatterySnapshot extends BankSnapshot {
  id: string;
  voltageSession: BufferSummary | null;
  socSession: BufferSummary | null;
}

export interface MaintenanceInput extends AnalysisInput {
  session: SessionSummary;
  telemetry: Record<string, BufferSummary>;
  engineNotifications: Record<string, unknown>;
  batteries: BatterySnapshot[];
}

// When fired by cron or PUT (not engine-stop), maintenance falls back to
// summarizing the last 30 minutes of telemetry as the "session".
const MAINT_FALLBACK_WINDOW_MS = 30 * 60 * 1000;

// Sentinel engine id used by the cron/PUT fallback when no engine session is
// available and the buffer does not yield a single unambiguous engine.
const UNKNOWN_ENGINE = 'unknown';

export class MaintenanceAnalyzer implements Analyzer<MaintenanceInput> {
  readonly id = 'maintenance';
  readonly title = ANALYZER_TITLES.maintenance;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  private readonly minSessionSeconds: number;
  private readonly extraWatchedPaths: ReadonlySet<string>;
  private readonly systemPrompt: string;

  constructor(cfg: MaintenanceCfg) {
    this.triggers = buildTriggers(this.id, cfg.triggers, (sub) =>
      (MAINTENANCE_SUPPORTED_EVENTS as readonly string[]).includes(sub)
        ? { kind: 'engine-stop' }
        : null,
    );
    this.minSessionSeconds = cfg.minSessionSeconds;
    this.extraWatchedPaths = new Set(cfg.extraWatchedPaths ?? []);
    this.systemPrompt = resolveSystemPrompt(
      cfg.customSystemPrompt,
      MAINTENANCE_DEFAULT_SYSTEM_PROMPT,
    );
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<MaintenanceInput | null> {
    let engineId: string;
    let startMs: number;
    let endMs: number;
    if (ctx.kind === 'engine-stop') {
      const sess = ctx.engineSession;
      if (!sess || sess.durationSec < this.minSessionSeconds) return null;
      engineId = sess.engineId;
      startMs = sess.start.getTime();
      endMs = sess.end.getTime();
    } else if (ctx.kind === 'put' || ctx.kind === 'cron') {
      endMs = ctx.firedAt.getTime();
      startMs = endMs - MAINT_FALLBACK_WINDOW_MS;
      // No engine session is supplied on a cron/PUT fire. Recover the engine
      // id from the buffer when the vessel has exactly one, so the fallback
      // report both names the engine and scopes its telemetry correctly.
      const discovered = discoverEngineIds(deps.buffer.pathKeys());
      engineId = discovered.length === 1 && discovered[0] ? discovered[0] : UNKNOWN_ENGINE;
    } else {
      return null;
    }

    const watchedPaths = listWatchedPaths(deps, engineId, this.extraWatchedPaths);
    const telemetry: Record<string, BufferSummary> = {};
    for (const path of watchedPaths) {
      const s = deps.buffer.summarize(path, startMs, endMs);
      if (s) telemetry[path] = s;
    }
    const engineNotifications = snapshotEngineNotifications(deps, engineId);
    const batteries = snapshotBatteries(deps, startMs, endMs);

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
      pushBankLines(lines, b.id, b, [
        { label: 'voltage (session)', summary: b.voltageSession },
        { label: 'state of charge (session)', summary: b.socSession },
      ]);
    }
    return { system: this.systemPrompt, user: lines.join('\n') };
  }
}

function listWatchedPaths(
  deps: AnalyzerDeps,
  engineId: string,
  extraWatchedPaths: ReadonlySet<string>,
): string[] {
  // A null prefix means no specific engine is in scope (cron/PUT fallback on
  // a zero- or multi-engine vessel); in that case every propulsion path is
  // kept rather than scoped to one engine.
  const engPrefix = engineId === UNKNOWN_ENGINE ? null : enginePathPrefix(engineId);
  const out = new Set<string>();
  for (const path of deps.buffer.pathKeys()) {
    if (extraWatchedPaths.has(path)) {
      out.add(path);
      continue;
    }
    if (engPrefix) {
      if (path.startsWith(engPrefix)) {
        out.add(path);
        continue;
      }
      // A definite engine is in scope: drop other engines' propulsion paths.
      if (path.startsWith(PROPULSION_PREFIX)) continue;
    }
    if (WATCH_PREFIXES.some((prefix) => path.startsWith(prefix))) out.add(path);
  }
  return Array.from(out).sort();
}

function snapshotEngineNotifications(
  deps: AnalyzerDeps,
  engineId: string,
): Record<string, unknown> {
  const tree = asTreeMap(deps.app.getSelfPath(engineNotificationsPath(engineId)));
  if (!tree) return {};
  const out: Record<string, unknown> = {};
  for (const slot of Object.keys(tree)) {
    const value = readValueAt(tree, slot);
    if (value !== undefined) out[slot] = value;
  }
  return out;
}

function snapshotBatteries(deps: AnalyzerDeps, startMs: number, endMs: number): BatterySnapshot[] {
  const tree = asTreeMap(deps.app.getSelfPath(BATTERIES_PARENT_PATH));
  if (!tree) return [];
  // Filter to true bank subtrees: a future SK server release could attach
  // metadata leaves (`meta`, `$source`, `value`, `timestamp`, ...) at the
  // `electrical.batteries` container level, and treating those as banks
  // would produce nonsense LLM input. A real bank node is an object that
  // carries at least one of the canonical bank fields.
  return Object.entries(tree)
    .filter(([_, node]) => isBankNode(node))
    .map(([id, node]) => {
      const paths = bankPaths(id);
      return {
        id,
        ...readBankSnapshot(node),
        voltageSession: deps.buffer.summarize(paths.voltage, startMs, endMs),
        socSession: deps.buffer.summarize(paths.soc, startMs, endMs),
      };
    });
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
  ['.fuel.used', 'm3'],
  ['.oilPressure', 'Pa'],
];

function unitForPath(path: string): string | null {
  for (const [suffix, unit] of UNIT_BY_SUFFIX) {
    if (path.endsWith(suffix)) return unit;
  }
  return null;
}
