import { readFile } from 'node:fs/promises';
import type { Analyzer } from '../analyzers/Analyzer.js';
import { ANALYZER_IDS, ANALYZER_TITLES, type AnalyzerId, isAnalyzerId } from '../analyzers/ids.js';
import { ANALYZER_DEFAULT_SYSTEM_PROMPTS } from '../analyzers/registry.js';
import type { PluginOptions } from '../types.js';
import type { BudgetTracker } from './budget.js';
import { fetchWithTimeout } from './http.js';
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
    tokensToday: number;
    costToday: number;
  };
  questdb: { enabled: boolean; reachable: boolean | null };
  analyzers: Array<{
    id: AnalyzerId;
    title: string;
    enabled: boolean;
    // True when the analyzer's config section carries a severityFloor, so the
    // panel knows to render the floor dropdown (today only forecast).
    hasSeverityFloor: boolean;
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
      tokensToday: rt.budget.tokensToday(),
      costToday: rt.budget.costToday(),
    },
    questdb: {
      enabled: rt.cfg.questdb.enabled,
      reachable: rt.cfg.questdb.enabled && rt.questdbProbed ? rt.questdbLive !== null : null,
    },
    analyzers: ANALYZER_IDS.map((id) => {
      const section = rt.cfg.analyzers[id];
      const cron = section.triggers.cron;
      return {
        id,
        title: ANALYZER_TITLES[id],
        enabled: enabled.has(id),
        // Derived from the config shape, not an id list, so a future analyzer
        // gaining a floor needs no edit here.
        hasSeverityFloor: 'severityFloor' in section,
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
// Bounds the upstream models fetch: a hung connection would otherwise pin
// modelsInFlight (and with it the admin model picker) until process restart.
// Same magnitude as the OpenRouter completion timeout and the QuestDB ceiling.
const MODELS_FETCH_TIMEOUT_MS = 30_000;
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
      const res = await fetchWithTimeout(OPENROUTER_MODELS_URL, {}, MODELS_FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
      const body = (await res.json()) as OpenRouterModelsResponse;
      // Validate the shape before caching: a malformed-but-valid-JSON
      // response with a non-array `data` field would otherwise poison the
      // 1-hour module cache and break the model picker until the TTL lapses.
      if (!Array.isArray(body?.data)) {
        throw new Error('upstream returned an unexpected models payload');
      }
      // Stamp with a fresh read, not the `now` from the staleness check above:
      // that value predates the awaited fetch, so reusing it would shorten the
      // effective TTL by the request's own latency. The cache is fresh from
      // when the data actually arrived.
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

// Success envelope shared by every route's happy path: the same { ok, ... }
// shape the panel's fetchJson wrapper reads on the guard failure paths above.
function sendOk(res: RouteResponse, payload: object = {}): void {
  res.json({ ok: true, ...payload });
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown;

// One row per REST route. registerApiRoutes registers each row's handler and
// the OpenAPI document is built from the same rows, so the published API docs
// cannot drift from the registered surface.
interface ApiRoute {
  method: 'get' | 'post';
  // Express-style path; ':id' is rendered as the OpenAPI '{id}' parameter.
  path: string;
  summary: string;
  // OpenAPI parameters beyond the ':id' path parameter derived from `path`
  // (the reports route's `limit` query).
  extraParameters?: ReadonlyArray<object>;
  handler: (getRuntime: () => PluginRuntime | null) => RouteHandler;
}

const ID_PATH_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Analyzer id (one of the seven analyzer ids).',
  schema: { type: 'string' },
} as const;

const OK_RESPONSE = { '200': { description: 'OK' } } as const;

const API_ROUTES: ReadonlyArray<ApiRoute> = [
  {
    method: 'get',
    path: '/api/status',
    summary: 'Plugin, budget, and analyzer status snapshot.',
    handler: (getRuntime) => (_req, res) => {
      const rt = requireRuntime(getRuntime, res);
      if (!rt) return;
      sendOk(res, buildStatus(rt));
    },
  },
  {
    method: 'post',
    path: '/api/openrouter/test',
    summary: 'Send a one-token ping to verify the OpenRouter API key.',
    handler: (getRuntime) => async (_req, res) => {
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
        sendOk(res, {
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
    },
  },
  {
    method: 'post',
    path: '/api/analyzers/:id/fire',
    summary: 'Run one analyzer immediately, bypassing its triggers.',
    handler: (getRuntime) => async (req, res) => {
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
        sendOk(res, { analyzer: id, outcome });
      } catch (err) {
        res.status(500).json({ ok: false, error: stringify(err) });
      }
    },
  },
  {
    method: 'get',
    path: '/api/analyzers/:id/prompt',
    summary: "An analyzer's default and current system prompt.",
    handler: (getRuntime) => (req, res) => {
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
      sendOk(res, {
        analyzer: id,
        default: defaultPrompt,
        current,
        runtimeReady: rt !== null,
      });
    },
  },
  {
    method: 'get',
    path: '/api/openrouter/models',
    summary: 'List the available OpenRouter models.',
    handler: () => async (_req, res) => {
      // No runtime gate: the model list is fetched from OpenRouter independently
      // of plugin state, so the picker populates before the plugin starts, the
      // same way the prompt route serves its compile-time default.
      try {
        const result = await getOpenRouterModels();
        sendOk(res, result);
      } catch (err) {
        res.status(502).json({ ok: false, error: stringify(err) });
      }
    },
  },
  {
    method: 'post',
    path: '/api/questdb/test',
    summary: 'Probe a QuestDB URL for reachability.',
    handler: (getRuntime) => async (req, res) => {
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
        const reachable = await client.probe(rt?.signal);
        // A false probe means the server answered but not with a dataset (wrong
        // service, or QuestDB returning an error payload). Carry an `error` so
        // every ok:false response, transport fault or bad answer, has the same
        // shape for the panel to read.
        if (reachable) {
          sendOk(res, { url: normalized });
        } else {
          res.json({
            ok: false,
            url: normalized,
            error: 'reachable but did not return a result set',
          });
        }
      } catch (err) {
        res.status(502).json({ ok: false, url: normalized, error: stringify(err) });
      }
    },
  },
  {
    method: 'get',
    path: '/api/analyzers/:id/reports',
    summary: "Recent entries from an analyzer's report history.",
    extraParameters: [
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: 'Maximum entries to return (1 to 100, default 10).',
        schema: { type: 'integer' },
      },
    ],
    handler: (getRuntime) => async (req, res) => {
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
        sendOk(res, { analyzer: id, reports });
      } catch (err) {
        res.status(500).json({ ok: false, error: stringify(err) });
      }
    },
  },
];

// OpenAPI operations derived from API_ROUTES, one per route, with the ':id'
// path parameter inferred from the route path.
function buildOpenApiPaths(): Record<string, Record<string, object>> {
  const paths: Record<string, Record<string, object>> = {};
  for (const r of API_ROUTES) {
    const parameters = [
      ...(r.path.includes('/:id/') ? [ID_PATH_PARAM] : []),
      ...(r.extraParameters ?? []),
    ];
    const docPath = r.path.replace('/:id/', '/{id}/');
    const ops = paths[docPath] ?? {};
    paths[docPath] = ops;
    ops[r.method] = {
      summary: r.summary,
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: OK_RESPONSE,
    };
  }
  return paths;
}

// Minimal OpenAPI 3 description of the plugin's REST surface, built from the
// same route table the registrations use. SK serves it at
// /skServer/plugins/<id>/openapi.json and renders it in the admin API docs.
const OPENAPI_DOC = {
  openapi: '3.0.0',
  info: {
    title: 'OpenRouter Companion API',
    version: '1.0.0',
    description: 'Admin-gated REST routes that back the OpenRouter Companion configuration panel.',
  },
  servers: [{ url: '/plugins/signalk-openrouter-companion' }],
  paths: buildOpenApiPaths(),
};

// Wired into the plugin object in index.ts. SK calls this once to publish the
// API docs; the document is static, so there is nothing to recompute per call.
export function getOpenApi(): object {
  return OPENAPI_DOC;
}

export function registerApiRoutes(
  router: RouterLike,
  getRuntime: () => PluginRuntime | null,
): void {
  for (const { method, path, handler } of API_ROUTES) {
    router[method](path, handler(getRuntime));
  }
}
