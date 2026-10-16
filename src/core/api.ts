import type { Analyzer } from '../analyzers/Analyzer.js';
import { ANALYZER_IDS, ANALYZER_TITLES, type AnalyzerId, isAnalyzerId } from '../analyzers/ids.js';
import { ANALYZER_DEFAULT_SYSTEM_PROMPTS } from '../analyzers/registry.js';
import { type BaseUrlProblem, baseUrlProblem } from '../historyConfig.js';
import type { PluginOptions } from '../types.js';
import type { BudgetTracker } from './budget.js';
import { HOUR_MS } from './format.js';
import type { HistoryProvider } from './history.js';
import { abortable, discardBody, fetchWithTimeout, normalizeBaseUrl } from './http.js';
import { InfluxDBClient } from './influxdb.js';
import { stringify } from './logger.js';
import type { CompleteResult, OpenRouterClient } from './openrouter.js';
import { OpenRouterError } from './openrouter.js';
import { PLUGIN_HTTP_PREFIX } from './paths.js';
import { QuestDBClient } from './questdb.js';
import { readReportTail } from './reportLog.js';
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

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown;

export interface RouterLike {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

export interface PluginRuntime {
  // PluginOptions is the storage shape; the runtime only reads, so a typed
  // alias is enough. Avoids drift between the stripped duplicate that this
  // type used to declare and the real option type in src/types.ts.
  cfg: Pick<PluginOptions, 'openrouter' | 'history' | 'analyzers'>;
  llm: OpenRouterClient;
  budget: BudgetTracker;
  historyLive: HistoryProvider | null;
  historyProbed: boolean;
  analyzers: Analyzer[];
  router: TriggerRouter | null;
  logPath: string;
  // Lifecycle abort signal, fired by stop(). Direct LLM/history calls from
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

// A runtime exists only once an API key is configured (start() returns before
// building one otherwise), so the snapshot carries no key flag: the panel reads
// a 503 from this route as "no key yet".
interface StatusResponse {
  openrouter: {
    model: string;
    callsToday: number;
    maxCallsPerDay: number;
    tokensToday: number;
    costToday: number;
  };
  history: { source: PluginOptions['history']['source']; reachable: boolean | null };
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
  const { callsToday, tokensToday, costToday } = rt.budget.snapshot();
  return {
    startedAt: rt.startedAt,
    openrouter: {
      model: rt.cfg.openrouter.model,
      callsToday,
      maxCallsPerDay: rt.cfg.openrouter.maxCallsPerDay,
      tokensToday,
      costToday,
    },
    history: {
      source: rt.cfg.history.source,
      reachable:
        rt.cfg.history.source !== 'none' && rt.historyProbed ? rt.historyLive !== null : null,
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

// The catalog as this route serves it: each model's id and display name, the
// two fields the panel's model picker reads. The upstream entries carry
// descriptions, pricing, and architecture besides, which would otherwise sit
// in the module cache and cross the wire to every admin tab.
interface OpenRouterModelsResponse {
  data: Array<{ id: string; name?: string }>;
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
// Bounds the upstream models fetch: a hung connection would otherwise pin
// the shared slot (and with it the admin model picker) until process restart.
// Same magnitude as the OpenRouter completion timeout and the QuestDB ceiling.
const MODELS_FETCH_TIMEOUT_MS = 30_000;
const MODELS_CACHE_TTL_MS = HOUR_MS;
let modelsCache: { fetchedAt: number; body: OpenRouterModelsResponse } | null = null;

// One upstream call shared by everyone who arrives while it is running. Written
// once because both unmetered OpenRouter routes need it: a second admin tab
// polling the model catalog, and a second press of the Test button, must not
// each open their own call. `cooling` additionally bars a fresh call for a
// while after one finished, for the route that bills.
class SingleFlight<T> {
  private inFlight: Promise<T> | null = null;
  private lastFinishedAt = 0;

  run(work: () => Promise<T>): Promise<T> {
    if (!this.inFlight) {
      const started = work().finally(() => {
        this.inFlight = null;
        this.lastFinishedAt = Date.now();
      });
      // Every waiter awaits its own copy of the settlement, so a shared call
      // that rejects after its last waiter walked away cannot surface as an
      // unhandled rejection.
      started.catch(() => {});
      this.inFlight = started;
    }
    return this.inFlight;
  }

  // True when nothing is running and the last call finished inside the window.
  cooling(cooldownMs: number): boolean {
    return this.inFlight === null && Date.now() - this.lastFinishedAt < cooldownMs;
  }

  reset(): void {
    this.inFlight = null;
    this.lastFinishedAt = 0;
  }
}

const modelsFlight = new SingleFlight<OpenRouterModelsResponse>();

// The /api/openrouter/test route is deliberately outside the daily budget: an
// admin debugging connectivity should not run themselves out of analyzer calls.
// That makes it the one route where a real, billable completion is unmetered,
// so it carries a cooldown that bounds how often a held button can bill. Short
// enough that a human retry cycle (read the failure, fix the key, press again)
// never meets it.
const OPENROUTER_TEST_COOLDOWN_MS = 5_000;
const openRouterTestFlight = new SingleFlight<CompleteResult>();

// Exposed so tests can wipe every module-level cache in this file between
// cases: the model catalog and both single-flight slots. Not part of the public
// HTTP surface.
export function _resetOpenRouterApiState(): void {
  modelsCache = null;
  modelsFlight.reset();
  openRouterTestFlight.reset();
}

// `abortSignal` is the caller's own: the plugin lifecycle signal while the
// plugin is running, absent before the first start (the picker must populate
// then too). It cancels this caller's wait, never the shared fetch, which is
// bounded by its own timeout instead. Binding the coalesced fetch to whichever
// caller happened to arrive first would let a stop() that aborts caller 1
// reject caller 2 as a 502 in a second admin tab, for a request caller 2 never
// cancelled. The cost is an upstream socket that can outlive a stop by up to
// the fetch timeout, with nothing to write to but a module cache.
async function getOpenRouterModels(abortSignal?: AbortSignal): Promise<OpenRouterModelsResponse> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.body;
  }
  // A second poll while the first is in flight (admin opens two tabs) awaits
  // the same upstream call.
  return abortable(modelsFlight.run(fetchOpenRouterModels), abortSignal);
}

async function fetchOpenRouterModels(): Promise<OpenRouterModelsResponse> {
  const res = await fetchWithTimeout(OPENROUTER_MODELS_URL, {}, MODELS_FETCH_TIMEOUT_MS);
  if (!res.ok) {
    discardBody(res);
    throw new Error(`upstream HTTP ${res.status}`);
  }
  const upstream = (await res.json()) as { data?: unknown } | null;
  // Validate the shape before caching: a malformed-but-valid-JSON response with
  // a non-array `data` field would otherwise poison the 1-hour module cache and
  // break the model picker until the TTL lapses.
  if (!Array.isArray(upstream?.data)) {
    throw new Error('upstream returned an unexpected models payload');
  }
  // Keep the two fields the picker reads, and skip a row without a string id
  // rather than failing the whole catalog over it.
  const data: OpenRouterModelsResponse['data'] = [];
  for (const row of upstream.data as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const { id, name } = row as { id?: unknown; name?: unknown };
    if (typeof id !== 'string') continue;
    data.push(typeof name === 'string' ? { id, name } : { id });
  }
  const body: OpenRouterModelsResponse = { data };
  // Stamp with a fresh read, taken after the awaited fetch, so the TTL is not
  // shortened by the request's own latency. The cache is fresh from when the
  // data actually arrived.
  modelsCache = { fetchedAt: Date.now(), body };
  return body;
}

// The failure envelope every route answers with: `{ ok: false, error }` plus
// whatever the route adds, so the panel's fetchJson wrapper reads one shape
// whichever guard tripped.
function sendErr(res: RouteResponse, status: number, error: string, extra: object = {}): void {
  res.status(status).json({ ok: false, ...extra, error });
}

// The error text for each way a probe URL can be unusable. The product name
// only appears where it tells the operator which field to fix.
const BASE_URL_ERRORS: Record<BaseUrlProblem, (product: string) => string> = {
  invalid: () => 'invalid URL',
  scheme: () => 'unsupported URL scheme',
  credentials: (product) => `${product} base URL must not include credentials`,
  query: (product) => `${product} base URL must not include a query string or fragment`,
};

// Validate a probe URL before constructing a client: the admin gate keeps
// unauthenticated callers out, but even an admin should not be able to probe
// an arbitrary scheme (file://, gopher://, javascript:) from the Signal K host.
// On success it returns the client's own normalization, so the URL a route
// reports is exactly the one probe() dials.
function validateProbeUrl(raw: string, product: string): { url: string } | { error: string } {
  const problem = baseUrlProblem(raw);
  return problem ? { error: BASE_URL_ERRORS[problem](product) } : { url: normalizeBaseUrl(raw) };
}

function requireRuntime(
  getRuntime: () => PluginRuntime | null,
  res: RouteResponse,
): PluginRuntime | null {
  const rt = getRuntime();
  if (!rt) {
    sendErr(res, 503, 'plugin not started');
    return null;
  }
  return rt;
}

function requireAnalyzerId(req: RouteRequest, res: RouteResponse): AnalyzerId | null {
  const id = req.params?.id;
  if (!isAnalyzerId(id)) {
    sendErr(res, 404, 'unknown analyzer');
    return null;
  }
  return id;
}

// Success envelope shared by every route's happy path: the same { ok, ... }
// shape the panel's fetchJson wrapper reads on the failure paths above.
function sendOk(res: RouteResponse, payload: object = {}): void {
  res.json({ ok: true, ...payload });
}

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
  description: `Analyzer id: one of ${ANALYZER_IDS.join(', ')}.`,
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
    // Not a one-token ping: only the prompt asks for one word. The client
    // bounds every completion with its own max_tokens (2000) and offers no
    // per-call override, so a model that ignores the instruction bills up to
    // that. A small per-call cap is not the fix: it returns an empty completion
    // with finish_reason 'length' on a reasoning model, breaking the button for
    // exactly the models an operator is most likely to be testing.
    summary: 'Send a minimal completion request to verify the saved key.',
    handler: (getRuntime) => async (_req, res) => {
      const rt = requireRuntime(getRuntime, res);
      if (!rt) return;
      if (openRouterTestFlight.cooling(OPENROUTER_TEST_COOLDOWN_MS)) {
        sendErr(res, 429, 'a test just ran; wait a few seconds');
        return;
      }
      try {
        // The lifecycle signal aborts the request if stop() runs (admin
        // disables or saves config); without it, an in-flight ping holds a
        // socket open for the full requestTimeoutMs. Concurrent presses share
        // one upstream call rather than each billing their own.
        const result = await openRouterTestFlight.run(() =>
          rt.llm.complete({
            system: 'Reply with the single word OK.',
            user: 'ping',
            abortSignal: rt.signal,
          }),
        );
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
        sendErr(res, status, stringify(err), { status });
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
        sendErr(res, 503, 'plugin not started');
        return;
      }
      if (!rt.analyzers.some((a) => a.id === id)) {
        sendErr(res, 409, 'analyzer not enabled');
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
        sendErr(res, 500, stringify(err));
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
    handler: (getRuntime) => async (_req, res) => {
      // No runtime gate: the model list is fetched from OpenRouter independently
      // of plugin state, so the picker populates before the plugin starts, the
      // same way the prompt route serves its compile-time default. The runtime
      // is read only for its lifecycle signal, which is absent then.
      try {
        const result = await getOpenRouterModels(getRuntime()?.signal);
        sendOk(res, result);
      } catch (err) {
        sendErr(res, 502, stringify(err));
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
      const raw = body.url || rt?.cfg.history.questdb.url;
      if (!raw) {
        sendErr(res, 400, 'no URL provided and none in saved config');
        return;
      }
      const checked = validateProbeUrl(raw, 'QuestDB');
      if ('error' in checked) {
        sendErr(res, 400, checked.error);
        return;
      }
      const { url } = checked;
      try {
        const reachable = await new QuestDBClient({ url }).probe(rt?.signal);
        // A false probe means the server answered but not with a dataset (wrong
        // service, or QuestDB returning an error payload). Carry an `error` so
        // every ok:false response, transport fault or bad answer, has the same
        // shape for the panel to read.
        if (reachable) sendOk(res, { url });
        else sendErr(res, 200, 'reachable but did not return a result set', { url });
      } catch {
        sendErr(res, 502, 'QuestDB is unreachable or returned an invalid response', { url });
      }
    },
  },
  {
    method: 'post',
    path: '/api/influxdb/test',
    summary: 'Probe an InfluxDB v1-compatible query API for reachability.',
    handler: (getRuntime) => async (req, res) => {
      const body = (req.body ?? {}) as Partial<PluginOptions['history']['influxdb']>;
      const rt = getRuntime();
      const saved = rt?.cfg.history.influxdb;
      const raw = body.url ?? saved?.url;
      const database = body.database ?? saved?.database;
      const version = body.version ?? saved?.version ?? '1';
      if (!raw || !database) {
        sendErr(res, 400, 'an InfluxDB URL and database are required');
        return;
      }
      const checked = validateProbeUrl(raw, 'InfluxDB');
      if ('error' in checked) {
        sendErr(res, 400, checked.error);
        return;
      }
      if (version !== '1' && version !== '2') {
        sendErr(res, 400, 'unsupported InfluxDB version');
        return;
      }
      const { url } = checked;
      // The stored credential travels only to the stored host. A request that
      // names a different URL must carry its own credentials, an empty string
      // being a legitimate "no auth": without this, overriding the URL alone
      // turns one admin-authenticated probe into "post the vessel's InfluxDB
      // token to a host of my choosing". The admin gate and the JSON content
      // type keep that out of reach of an unauthenticated caller; it should not
      // be within reach of an authenticated one either. Both sides go through
      // the client's own normalization, so the gate compares the URL the probe
      // will dial; an unparseable saved value matches nothing.
      const useSavedCredentials =
        body.url === undefined || (saved?.url ? normalizeBaseUrl(saved.url) === url : false);
      const username = body.username ?? (useSavedCredentials ? (saved?.username ?? '') : '');
      const password = body.password ?? (useSavedCredentials ? (saved?.password ?? '') : '');
      const echo = { url, database, version };
      try {
        const client = new InfluxDBClient({ url, database, version, username, password });
        const reachable = await client.probe(rt?.signal);
        if (reachable) sendOk(res, echo);
        else sendErr(res, 200, 'reachable but did not return a result set', echo);
      } catch {
        sendErr(res, 502, 'InfluxDB is unreachable or returned an invalid response', echo);
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
      // Saturating clamp into [1, 100]: a degenerate limit (0, negative) pins to
      // 1 rather than falling back to the default, which clampPositiveInt would
      // do. A non-numeric limit (NaN) takes the default.
      const limit = Number.isFinite(parsed)
        ? Math.min(REPORTS_MAX_LIMIT, Math.max(1, parsed))
        : REPORTS_DEFAULT_LIMIT;
      try {
        const reports = await readReportTail(rt.logPath, id, limit);
        sendOk(res, { analyzer: id, reports });
      } catch (err) {
        sendErr(res, 500, stringify(err));
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
    // Each route has a unique path today; the spread still merges cleanly should
    // two methods ever share one path, without the read-back-and-reassign dance.
    paths[docPath] = {
      ...paths[docPath],
      [r.method]: {
        summary: r.summary,
        ...(parameters.length > 0 ? { parameters } : {}),
        responses: OK_RESPONSE,
      },
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
  servers: [{ url: PLUGIN_HTTP_PREFIX }],
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
