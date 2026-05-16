import { open } from 'node:fs/promises';
import type { Analyzer } from '../analyzers/Analyzer.js';
import { AGING_DEFAULT_SYSTEM_PROMPT } from '../analyzers/aging.js';
import { ALERTS_DEFAULT_SYSTEM_PROMPT } from '../analyzers/alerts.js';
import { DRIFT_DEFAULT_SYSTEM_PROMPT } from '../analyzers/drift.js';
import { HEALTH_DEFAULT_SYSTEM_PROMPT } from '../analyzers/health.js';
import { ANALYZER_IDS, ANALYZER_TITLES, type AnalyzerId, isAnalyzerId } from '../analyzers/ids.js';
import { LIVENESS_DEFAULT_SYSTEM_PROMPT } from '../analyzers/liveness.js';
import { MAINTENANCE_DEFAULT_SYSTEM_PROMPT } from '../analyzers/maintenance.js';
import type { PluginOptions } from '../types.js';
import type { BudgetTracker } from './budget.js';
import type { OpenRouterClient } from './openrouter.js';
import { OpenRouterError } from './openrouter.js';
import type { JsonlEntry } from './publisher.js';
import { QuestDBClient } from './questdb.js';
import type { TriggerRouter } from './triggerRouter.js';
import { manualPutCtx } from './triggers.js';

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
  // PluginOptions is the storage shape; the runtime only reads, so a typed
  // alias is enough. Avoids drift between the stripped duplicate that this
  // type used to declare and the real option type in src/types.ts.
  cfg: Pick<PluginOptions, 'openrouter' | 'questdb' | 'analyzers'>;
  llm: OpenRouterClient;
  budget: BudgetTracker;
  questdbLive: QuestDBClient | null;
  questdbProbed: boolean;
  analyzers: Analyzer[];
  apiKeySet: boolean;
  router: TriggerRouter | null;
  logPath: string;
}

export const DEFAULT_SYSTEM_PROMPTS: Record<AnalyzerId, string> = {
  maintenance: MAINTENANCE_DEFAULT_SYSTEM_PROMPT,
  health: HEALTH_DEFAULT_SYSTEM_PROMPT,
  aging: AGING_DEFAULT_SYSTEM_PROMPT,
  drift: DRIFT_DEFAULT_SYSTEM_PROMPT,
  alerts: ALERTS_DEFAULT_SYSTEM_PROMPT,
  liveness: LIVENESS_DEFAULT_SYSTEM_PROMPT,
};

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
  analyzers: Array<{ id: AnalyzerId; title: string; enabled: boolean }>;
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
    analyzers: ANALYZER_IDS.map((id) => ({
      id,
      title: ANALYZER_TITLES[id],
      enabled: enabled.has(id),
    })),
  };
}

interface OpenRouterModelsResponse {
  data: Array<{
    id: string;
    name?: string;
    context_length?: number;
    pricing?: { prompt?: string; completion?: string };
  }>;
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
let modelsCache: { fetchedAt: number; body: OpenRouterModelsResponse } | null = null;
let modelsInFlight: Promise<OpenRouterModelsResponse> | null = null;

// Exposed so tests can wipe the cache between cases. Not part of the public
// HTTP surface.
export function _resetOpenRouterModelsCache(): void {
  modelsCache = null;
  modelsInFlight = null;
}

async function getOpenRouterModels(): Promise<OpenRouterModelsResponse> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.body;
  }
  // Coalesce concurrent fetches: a second poll while the first is in flight
  // (admin opens two tabs) awaits the same upstream call.
  if (modelsInFlight) return modelsInFlight;
  modelsInFlight = (async () => {
    try {
      const res = await fetch(OPENROUTER_MODELS_URL);
      if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
      const body = (await res.json()) as OpenRouterModelsResponse;
      modelsCache = { fetchedAt: Date.now(), body };
      return body;
    } finally {
      modelsInFlight = null;
    }
  })();
  return modelsInFlight;
}

// Read the trailing N lines of the JSONL log filtered by analyzer. Loads the
// whole file: reports.jsonl on a real boat reaches a few KB/day, so even a
// 1-year-old file fits in memory comfortably. If usage ever calls for it,
// switch to a chunked tail-read; not worth the complexity today.
async function tailReports(
  logPath: string,
  analyzerId: string,
  limit: number,
): Promise<JsonlEntry[]> {
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
  const out: JsonlEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as JsonlEntry;
      if (entry.analyzer === analyzerId) out.push(entry);
    } catch {
      // skip malformed lines so a single corrupt entry doesn't poison tail
    }
  }
  return out.slice(-limit).reverse();
}

function requireRuntime(
  getRuntime: () => PluginRuntime | null,
  res: RouteResponse,
): PluginRuntime | null {
  const rt = getRuntime();
  if (!rt) {
    res.status(503).json({ error: 'plugin not started' });
    return null;
  }
  return rt;
}

function requireAnalyzerId(req: RouteRequest, res: RouteResponse): AnalyzerId | null {
  const id = req.params?.id;
  if (!isAnalyzerId(id)) {
    res.status(404).json({ error: 'unknown analyzer' });
    return null;
  }
  return id;
}

export function registerApiRoutes(
  router: RouterLike,
  getRuntime: () => PluginRuntime | null,
): void {
  router.get('/api/status', (_req, res) => {
    const rt = requireRuntime(getRuntime, res);
    if (!rt) return;
    res.json(buildStatus(rt));
  });

  router.post('/api/openrouter/test', async (_req, res) => {
    const rt = requireRuntime(getRuntime, res);
    if (!rt) return;
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
    const id = requireAnalyzerId(req, res);
    if (!id) return;
    const rt = requireRuntime(getRuntime, res);
    if (!rt) return;
    if (!rt.router) {
      res.status(503).json({ ok: false, error: 'plugin not started' });
      return;
    }
    if (!rt.analyzers.some((a) => a.id === id)) {
      res.status(409).json({ ok: false, error: 'analyzer not enabled' });
      return;
    }
    // Maintenance/health/aging/drift treat 'put' as "report on current state
    // in the fallback window"; alerts requires a battery-event so a manual
    // fire there will collectContext-return null and the router skips the
    // LLM call.
    try {
      await rt.router.dispatch('put', manualPutCtx(), { putPath: `manual:${id}` });
      res.json({ ok: true, analyzer: id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.get('/api/analyzers/:id/prompt', (req, res) => {
    const id = requireAnalyzerId(req, res);
    if (!id) return;
    const rt = getRuntime();
    const defaultPrompt = DEFAULT_SYSTEM_PROMPTS[id];
    const current = rt?.cfg.analyzers[id]?.customSystemPrompt ?? null;
    res.json({ analyzer: id, default: defaultPrompt, current });
  });

  router.get('/api/openrouter/models', async (_req, res) => {
    const rt = requireRuntime(getRuntime, res);
    if (!rt) return;
    try {
      const result = await getOpenRouterModels();
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  });

  router.post('/api/questdb/test', async (req, res) => {
    const body = (req.body ?? {}) as { url?: string };
    const rt = getRuntime();
    const url = body.url || rt?.cfg.questdb.url;
    if (!url) {
      res.status(400).json({ ok: false, error: 'no URL provided and none in saved config' });
      return;
    }
    try {
      const client = new QuestDBClient({ url });
      const ok = await client.probe();
      res.json({ ok, url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ ok: false, url, error: message });
    }
  });

  router.get('/api/analyzers/:id/reports', async (req, res) => {
    const id = requireAnalyzerId(req, res);
    if (!id) return;
    const rt = requireRuntime(getRuntime, res);
    if (!rt) return;
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
