import { readFile } from 'node:fs/promises';
import type { Analyzer } from '../analyzers/Analyzer.js';
import { ANALYZER_IDS, ANALYZER_TITLES, type AnalyzerId, isAnalyzerId } from '../analyzers/ids.js';
import { ANALYZER_DEFAULT_SYSTEM_PROMPTS } from '../analyzers/registry.js';
import type { PluginOptions } from '../types.js';
import type { BudgetTracker } from './budget.js';
import { stringify } from './logger.js';
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
  // Lifecycle abort signal, fired by stop(). Direct LLM/QuestDB calls from
  // the REST surface (admin Test buttons) wire this so stop() aborts the
  // in-flight request rather than waiting out the full request timeout.
  signal: AbortSignal;
  // Epoch ms when this runtime was built. SK rebuilds the runtime on every
  // config save, so a changed value tells the config panel the restart it
  // triggered has completed.
  startedAt: number;
}

const REPORTS_DEFAULT_LIMIT = 10;
const REPORTS_MAX_LIMIT = 100;

interface StatusResponse {
  openrouter: {
    apiKeySet: boolean;
    model: string;
    callsToday: number;
    maxCallsPerDay: number;
  };
  questdb: { enabled: boolean; reachable: boolean | null };
  analyzers: Array<{
    id: AnalyzerId;
    title: string;
    enabled: boolean;
    // The analyzer's cron trigger. `enabled: false` marks an event-driven
    // analyzer with no schedule; the panel shows its frequency dropdown
    // disabled rather than hiding it.
    cron: { enabled: boolean; pattern: string };
  }>;
  startedAt: number;
}

function buildStatus(rt: PluginRuntime): StatusResponse {
  const enabled = new Set(rt.analyzers.map((a) => a.id));
  return {
    startedAt: rt.startedAt,
    openrouter: {
      apiKeySet: rt.apiKeySet,
      model: rt.cfg.openrouter.model,
      callsToday: rt.budget.callsToday(),
      maxCallsPerDay: rt.cfg.openrouter.maxCallsPerDay,
    },
    questdb: {
      enabled: rt.cfg.questdb.enabled,
      reachable: rt.cfg.questdb.enabled && rt.questdbProbed ? rt.questdbLive !== null : null,
    },
    analyzers: ANALYZER_IDS.map((id) => {
      const cron = rt.cfg.analyzers[id].triggers.cron;
      return {
        id,
        title: ANALYZER_TITLES[id],
        enabled: enabled.has(id),
        cron: { enabled: cron.enabled, pattern: cron.pattern },
      };
    }),
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
      // Validate the shape before caching: a malformed-but-valid-JSON
      // response with a non-array `data` field would otherwise poison the
      // 1-hour module cache and break the model picker until the TTL lapses.
      if (!Array.isArray(body?.data)) {
        throw new Error('upstream returned an unexpected models payload');
      }
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
    raw = await readFile(logPath, 'utf-8');
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
    // Consistent { ok, error } envelope across every route's failure paths
    // so the panel's fetchJson wrapper sees the same shape regardless of
    // which guard tripped.
    res.status(503).json({ ok: false, error: 'plugin not started' });
    return null;
  }
  return rt;
}

function requireAnalyzerId(req: RouteRequest, res: RouteResponse): AnalyzerId | null {
  const id = req.params?.id;
  if (!isAnalyzerId(id)) {
    // Same { ok, error } envelope as requireRuntime so a single panel
    // branch handles every failure path uniformly.
    res.status(404).json({ ok: false, error: 'unknown analyzer' });
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
      // The lifecycle signal aborts the request if stop() runs (admin
      // disables or saves config); without it, an in-flight ping holds a
      // socket open for the full requestTimeoutMs. The Test button is
      // operator-driven and explicitly does NOT consume the daily budget:
      // an admin debugging connectivity should not run themselves out of
      // analyzer calls.
      const result = await rt.llm.complete({
        system: 'Reply with the single word OK.',
        user: 'ping',
        abortSignal: rt.signal,
      });
      res.json({
        ok: true,
        model: result.model,
        totalTokens: result.usage.totalTokens,
        text: result.text.trim().slice(0, 80),
      });
    } catch (err) {
      // An OpenRouterError can carry status 0 (transport failure) or 200
      // (empty completion); neither is a valid HTTP error status to echo, so
      // anything below 400 collapses to 500.
      const status = err instanceof OpenRouterError && err.status >= 400 ? err.status : 500;
      res.status(status).json({ ok: false, status, error: stringify(err) });
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
    // Run the named analyzer directly. A manual fire uses a put-kind ctx; an
    // analyzer with nothing to report (alerts has no pending battery event)
    // returns null from collectContext and the router skips the LLM call. The
    // outcome lets the panel distinguish a real report from a silent no-op.
    try {
      const outcome = await rt.router.runById(id, manualPutCtx());
      res.json({ ok: true, analyzer: id, outcome });
    } catch (err) {
      res.status(500).json({ ok: false, error: stringify(err) });
    }
  });

  router.get('/api/analyzers/:id/prompt', (req, res) => {
    const id = requireAnalyzerId(req, res);
    if (!id) return;
    const rt = getRuntime();
    // Deliberately does NOT go through requireRuntime: the default prompt
    // is a compile-time constant, so the endpoint can serve it before the
    // plugin's runtime is built. The panel's promptValueFor reads from
    // its own `cfg` first (which the SK admin populates from the saved
    // configuration), so a transient `current: null` here does not
    // overwrite a real saved override the panel already has.
    const defaultPrompt = ANALYZER_DEFAULT_SYSTEM_PROMPTS[id];
    const current = rt?.cfg.analyzers[id]?.customSystemPrompt ?? null;
    res.json({ analyzer: id, default: defaultPrompt, current, runtimeReady: rt !== null });
  });

  router.get('/api/openrouter/models', async (_req, res) => {
    const rt = requireRuntime(getRuntime, res);
    if (!rt) return;
    try {
      const result = await getOpenRouterModels();
      res.json(result);
    } catch (err) {
      res.status(502).json({ ok: false, error: stringify(err) });
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
    // Validate the URL before constructing the client: the admin gate keeps
    // unauthenticated callers out, but even an admin should not be able to
    // probe an arbitrary scheme (file://, gopher://, javascript:) from the
    // SK host. Restrict to http/https, the only schemes QuestDB serves.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      res.status(400).json({ ok: false, error: 'invalid URL' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ ok: false, error: 'unsupported URL scheme' });
      return;
    }
    // Use the normalized URL the parser produced (with a stripped trailing
    // slash) so probe() builds `${url}/exec?query=...` without a double
    // slash on inputs like 'http://qdb:9000/'.
    const normalized = parsed.href.replace(/\/$/, '');
    try {
      const client = new QuestDBClient({ url: normalized });
      const ok = await client.probe(rt?.signal);
      res.json({ ok, url: normalized });
    } catch (err) {
      res.status(502).json({ ok: false, url: normalized, error: stringify(err) });
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
      res.status(500).json({ ok: false, error: stringify(err) });
    }
  });
}
