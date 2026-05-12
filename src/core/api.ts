import { open } from 'node:fs/promises';
import type { Analyzer, TriggerCtx } from '../analyzers/Analyzer.js';
import type { BudgetTracker } from './budget.js';
import type { OpenRouterClient } from './openrouter.js';
import { OpenRouterError } from './openrouter.js';
import type { QuestDBClient } from './questdb.js';
import type { TriggerRouter } from './triggerRouter.js';

export interface RouteRequest {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
}

export interface RouteResponse {
  status(code: number): RouteResponse;
  json(body: unknown): RouteResponse;
  send(body: string): RouteResponse;
}

export interface RouterLike {
  get(path: string, handler: (req: RouteRequest, res: RouteResponse) => unknown): unknown;
  post(path: string, handler: (req: RouteRequest, res: RouteResponse) => unknown): unknown;
}

export interface PluginRuntime {
  cfg: {
    openrouter: { model: string; maxCallsPerDay: number };
    questdb: { enabled: boolean };
  };
  llm: OpenRouterClient;
  budget: BudgetTracker;
  questdbLive: QuestDBClient | null;
  questdbProbed: boolean;
  analyzers: Analyzer[];
  apiKeySet: boolean;
  router: TriggerRouter | null;
  logPath: string;
}

const ANALYZER_META: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'maintenance', title: 'Maintenance Advisor' },
  { id: 'health', title: 'Daily Battery Health Summary' },
  { id: 'aging', title: 'Battery Aging Tracker' },
  { id: 'drift', title: 'Engine Performance Drift' },
  { id: 'alerts', title: 'Battery Threshold Alerts' },
];

const KNOWN_ANALYZER_IDS = new Set(ANALYZER_META.map((m) => m.id));
const REPORTS_DEFAULT_LIMIT = 10;
const REPORTS_MAX_LIMIT = 100;

export interface StatusResponse {
  openrouter: {
    apiKeySet: boolean;
    model: string;
    callsToday: number;
    maxCallsPerDay: number;
  };
  questdb: { enabled: boolean; reachable: boolean | null };
  analyzers: Array<{ id: string; title: string; enabled: boolean }>;
}

function buildStatus(rt: PluginRuntime): StatusResponse {
  const enabled = new Set(rt.analyzers.map((a) => a.id));
  return {
    openrouter: {
      apiKeySet: rt.apiKeySet,
      model: rt.cfg.openrouter.model,
      callsToday: rt.budget.callsToday(),
      maxCallsPerDay: rt.cfg.openrouter.maxCallsPerDay,
    },
    questdb: {
      enabled: rt.cfg.questdb.enabled,
      reachable: !rt.cfg.questdb.enabled ? null : rt.questdbProbed ? rt.questdbLive !== null : null,
    },
    analyzers: ANALYZER_META.map((m) => ({ ...m, enabled: enabled.has(m.id) })),
  };
}

interface ReportEntry {
  ts: string;
  analyzer: string;
  trigger: string;
  report?: string;
  failure?: string;
  engineId?: string;
  durationSec?: number;
}

// Read the trailing N lines of the JSONL log filtered by analyzer. Loads the
// whole file: reports.jsonl on a real boat reaches a few KB/day, so even a
// 1-year-old file fits in memory comfortably. If usage ever calls for it,
// switch to a chunked tail-read; not worth the complexity today.
async function tailReports(
  logPath: string,
  analyzerId: string,
  limit: number,
): Promise<ReportEntry[]> {
  let raw: string;
  try {
    const fh = await open(logPath, 'r');
    try {
      raw = await fh.readFile('utf-8');
    } finally {
      await fh.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: ReportEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as ReportEntry;
      if (entry.analyzer === analyzerId) out.push(entry);
    } catch {
      // skip malformed lines so a single corrupt entry doesn't poison tail
    }
  }
  return out.slice(-limit).reverse();
}

export function registerApiRoutes(
  router: RouterLike,
  getRuntime: () => PluginRuntime | null,
): void {
  router.get('/api/status', (_req, res) => {
    const rt = getRuntime();
    if (!rt) {
      res.status(503).json({ error: 'plugin not started' });
      return;
    }
    res.json(buildStatus(rt));
  });

  router.post('/api/openrouter/test', async (_req, res) => {
    const rt = getRuntime();
    if (!rt) {
      res.status(503).json({ error: 'plugin not started' });
      return;
    }
    if (!rt.apiKeySet) {
      res.status(400).json({ ok: false, error: 'API key not configured' });
      return;
    }
    try {
      const result = await rt.llm.complete({
        system: 'Reply with the single word OK.',
        user: 'ping',
      });
      res.json({
        ok: true,
        model: result.model,
        totalTokens: result.usage.totalTokens,
        text: result.text.trim().slice(0, 80),
      });
    } catch (err) {
      const status = err instanceof OpenRouterError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      res.status(status).json({ ok: false, status, error: message });
    }
  });

  router.post('/api/analyzers/:id/fire', async (req, res) => {
    const id = req.params?.id;
    if (!id || !KNOWN_ANALYZER_IDS.has(id)) {
      res.status(404).json({ ok: false, error: 'unknown analyzer' });
      return;
    }
    const rt = getRuntime();
    if (!rt || !rt.router) {
      res.status(503).json({ ok: false, error: 'plugin not started' });
      return;
    }
    if (!rt.analyzers.some((a) => a.id === id)) {
      res.status(409).json({ ok: false, error: 'analyzer not enabled' });
      return;
    }
    // Synthesize a put-kind ctx. Maintenance/health/aging/drift treat 'put'
    // as "report on current state in the fallback window"; alerts requires
    // a battery-event so a manual fire there will collectContext-return null
    // and the router skips the LLM call (returns ok with skipped:true).
    const ctx: TriggerCtx = { kind: 'put', firedAt: new Date(), put: { value: 'manual' } };
    try {
      await rt.router.dispatch('put', ctx, { putPath: `manual:${id}` });
      res.json({ ok: true, analyzer: id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.get('/api/analyzers/:id/reports', async (req, res) => {
    const id = req.params?.id;
    if (!id || !KNOWN_ANALYZER_IDS.has(id)) {
      res.status(404).json({ error: 'unknown analyzer' });
      return;
    }
    const rt = getRuntime();
    if (!rt) {
      res.status(503).json({ error: 'plugin not started' });
      return;
    }
    const limitRaw = req.query?.limit;
    const limitStr = Array.isArray(limitRaw) ? limitRaw[0] : limitRaw;
    const parsed = limitStr ? Number.parseInt(limitStr, 10) : REPORTS_DEFAULT_LIMIT;
    const limit = Number.isFinite(parsed)
      ? Math.min(REPORTS_MAX_LIMIT, Math.max(1, parsed))
      : REPORTS_DEFAULT_LIMIT;
    try {
      const reports = await tailReports(rt.logPath, id, limit);
      res.json({ analyzer: id, reports });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
}
