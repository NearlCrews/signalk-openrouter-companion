import type { Analyzer } from '../analyzers/Analyzer.js';
import type { BudgetTracker } from './budget.js';
import type { OpenRouterClient } from './openrouter.js';
import { OpenRouterError } from './openrouter.js';
import type { QuestDBClient } from './questdb.js';

export interface RouteRequest {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
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
}

const ANALYZER_META: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'maintenance', title: 'Maintenance Advisor' },
  { id: 'health', title: 'Daily Battery Health Summary' },
  { id: 'aging', title: 'Battery Aging Tracker' },
  { id: 'drift', title: 'Engine Performance Drift' },
  { id: 'alerts', title: 'Battery Threshold Alerts' },
];

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
}
