import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analyzer } from '../src/analyzers/Analyzer.js';
import type { AnalyzerId } from '../src/analyzers/ids.js';
import type { PluginRuntime, RouteRequest, RouteResponse, RouterLike } from '../src/core/api.js';
import { _resetOpenRouterModelsCache, getOpenApi, registerApiRoutes } from '../src/core/api.js';
import { OpenRouterError } from '../src/core/openrouter.js';
import createPlugin from '../src/index.js';
import {
  cleanupTmpDir,
  type MockApp,
  makeMockApp,
  makePluginRuntime,
  makeRouter,
  makeTmpDir,
} from './_mocks.js';

interface RecordedRoute {
  method: 'get' | 'post';
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => unknown;
}

function makeRecordingRouter(): { router: RouterLike; routes: RecordedRoute[] } {
  const routes: RecordedRoute[] = [];
  const router: RouterLike = {
    get: (path, handler) => {
      routes.push({ method: 'get', path, handler });
    },
    post: (path, handler) => {
      routes.push({ method: 'post', path, handler });
    },
  };
  return { router, routes };
}

interface CapturedResponse {
  status: number;
  body: unknown;
}

function makeResponse(): { res: RouteResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 200, body: undefined };
  const res: RouteResponse = {
    status(code) {
      captured.status = code;
      return res;
    },
    json(body) {
      captured.body = body;
      return res;
    },
    send(body) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

async function call(
  routes: RecordedRoute[],
  method: 'get' | 'post',
  path: string,
  req: RouteRequest = {},
): Promise<CapturedResponse> {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  const { res, captured } = makeResponse();
  await route.handler(req, res);
  return captured;
}

function fakeAnalyzer(id: string): Analyzer {
  return { id, title: id, triggers: [] } as unknown as Analyzer;
}

describe('plugin REST API', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
  });
  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  describe('routes registered via registerWithRouter', () => {
    it('registers status, openrouter test, fire, reports, prompt, models, and questdb-test routes', () => {
      const plugin = createPlugin(app as never);
      const { router, routes } = makeRecordingRouter();
      plugin.registerWithRouter(router);
      expect(routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort()).toEqual([
        'GET /api/analyzers/:id/prompt',
        'GET /api/analyzers/:id/reports',
        'GET /api/openrouter/models',
        'GET /api/status',
        'POST /api/analyzers/:id/fire',
        'POST /api/openrouter/test',
        'POST /api/questdb/test',
      ]);
    });

    it('publishes an OpenAPI doc whose operations match the registered routes', () => {
      // Both are built from the same route table; this guards the table
      // plumbing itself (a route added to the table must appear in both).
      const plugin = createPlugin(app as never);
      const { router, routes } = makeRecordingRouter();
      plugin.registerWithRouter(router);
      const doc = getOpenApi() as { paths: Record<string, Record<string, unknown>> };
      const docOps = Object.entries(doc.paths)
        .flatMap(([path, ops]) =>
          Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`),
        )
        .sort();
      const registered = routes
        .map((r) => `${r.method.toUpperCase()} ${r.path.replace('/:id/', '/{id}/')}`)
        .sort();
      expect(docOps).toEqual(registered);
    });

    it('returns 503 from /api/status before plugin start', async () => {
      const plugin = createPlugin(app as never);
      const { router, routes } = makeRecordingRouter();
      plugin.registerWithRouter(router);
      const r = await call(routes, 'get', '/api/status');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ ok: false, error: 'plugin not started' });
    });

    it('returns 503 from /api/status when started without an API key', async () => {
      const plugin = createPlugin(app as never);
      const { router, routes } = makeRecordingRouter();
      plugin.registerWithRouter(router);
      plugin.start({}, () => {});
      const r = await call(routes, 'get', '/api/status');
      expect(r.status).toBe(503);
    });

    it('returns live status after the router is initialized', async () => {
      app.availablePaths = ['propulsion.port.revolutions'];
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ columns: [], dataset: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
      const plugin = createPlugin(app as never);
      const { router, routes } = makeRecordingRouter();
      plugin.registerWithRouter(router);
      plugin.start({ openrouter: { apiKey: 'sk-test' } } as never, () => {});
      await plugin._whenReady();

      const r = await call(routes, 'get', '/api/status');
      expect(r.status).toBe(200);
      const body = r.body as {
        openrouter: { apiKeySet: boolean; model: string; callsToday: number };
        questdb: { enabled: boolean; reachable: boolean | null };
        analyzers: Array<{
          id: string;
          enabled: boolean;
          hasSeverityFloor: boolean;
          cron: { enabled: boolean; pattern: string };
        }>;
      };
      expect(body.openrouter.apiKeySet).toBe(true);
      expect(body.openrouter.callsToday).toBe(0);
      // The status payload lists every analyzer with its enabled flag. Assert
      // one enabled analyzer is present plus the total count, rather than the
      // full set, to stay resilient to default flips.
      const enabled = new Set(body.analyzers.filter((a) => a.enabled).map((a) => a.id));
      expect(enabled.has('maintenance')).toBe(true);
      expect(body.analyzers).toHaveLength(7);
      // Each analyzer reports its cron trigger so the panel can render the
      // frequency dropdown: event-driven analyzers carry a disabled cron,
      // scheduled analyzers a pattern.
      const byId = new Map(body.analyzers.map((a) => [a.id, a]));
      expect(byId.get('maintenance')?.cron.enabled).toBe(false);
      expect(byId.get('health')?.cron).toEqual({ enabled: true, pattern: '0 8 * * *' });
      // hasSeverityFloor is derived from the config shape (only forecast's
      // section carries a severityFloor today), so the panel can render the
      // floor dropdown without a hardcoded id list.
      expect(byId.get('forecast')?.hasSeverityFloor).toBe(true);
      expect(byId.get('health')?.hasSeverityFloor).toBe(false);

      vi.unstubAllGlobals();
      await plugin.stop();
    });
  });

  describe('/api/openrouter/test handler', () => {
    const okLlm = {
      complete: async () => ({
        text: 'OK',
        model: 'anthropic/claude-haiku-4.5',
        usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
      }),
    } as never as PluginRuntime['llm'];

    it('returns ok+token usage on a successful ping', async () => {
      const rt = makePluginRuntime({ llm: okLlm });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/openrouter/test');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        ok: true,
        model: 'anthropic/claude-haiku-4.5',
        totalTokens: 6,
        text: 'OK',
      });
    });

    it('returns 400 when no API key is configured', async () => {
      const rt = makePluginRuntime({ llm: okLlm, apiKeySet: false });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/openrouter/test');
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ ok: false, error: 'API key not configured' });
    });

    it('passes through OpenRouter HTTP status on error', async () => {
      const rt = makePluginRuntime({
        llm: {
          complete: async () => {
            throw new OpenRouterError(401, 'invalid key');
          },
        } as never,
      });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/openrouter/test');
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ ok: false, status: 401, error: 'invalid key' });
    });
  });

  describe('/api/analyzers/:id/fire handler', () => {
    function makeRuntimeWithRouter(opts: {
      enabledIds: string[];
      runById?: (id: string, ctx: unknown) => Promise<string>;
    }): { rt: PluginRuntime; calls: Array<{ id: string; ctx: unknown }> } {
      const calls: Array<{ id: string; ctx: unknown }> = [];
      const runById =
        opts.runById ??
        (async (id: string, ctx: unknown): Promise<string> => {
          calls.push({ id, ctx });
          return 'reported';
        });
      const rt = makePluginRuntime({
        analyzers: opts.enabledIds.map(fakeAnalyzer),
        router: { runById } as never,
      });
      return { rt, calls };
    }

    it('returns 404 for an unknown analyzer id', async () => {
      const { rt } = makeRuntimeWithRouter({ enabledIds: ['health'] });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/analyzers/:id/fire', {
        params: { id: 'bogus' },
      });
      expect(r.status).toBe(404);
    });

    it('returns 503 before plugin start', async () => {
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => null);
      const r = await call(routes, 'post', '/api/analyzers/:id/fire', {
        params: { id: 'health' },
      });
      expect(r.status).toBe(503);
    });

    it('returns 409 when the analyzer is disabled', async () => {
      const { rt } = makeRuntimeWithRouter({ enabledIds: ['maintenance'] });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/analyzers/:id/fire', {
        params: { id: 'health' },
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false });
    });

    it('runs the named analyzer with a put-kind ctx on success', async () => {
      const { rt, calls } = makeRuntimeWithRouter({ enabledIds: ['health'] });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/analyzers/:id/fire', {
        params: { id: 'health' },
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, analyzer: 'health', outcome: 'reported' });
      expect(calls).toHaveLength(1);
      const first = calls[0];
      expect(first?.id).toBe('health');
      expect((first?.ctx as { kind: string }).kind).toBe('put');
    });

    it('returns 500 when the router run throws', async () => {
      const { rt } = makeRuntimeWithRouter({
        enabledIds: ['health'],
        runById: async () => {
          throw new Error('boom');
        },
      });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/analyzers/:id/fire', {
        params: { id: 'health' },
      });
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ ok: false, error: 'boom' });
    });

    it('actually runs the named analyzer through a real TriggerRouter', async () => {
      // Regression: the fire endpoint must run the named analyzer end to end.
      // It previously dispatched a synthetic put path that matched no
      // analyzer's trigger, so nothing ran and no LLM call was recorded.
      const collectContext = vi.fn(async () => ({ ok: true }));
      const analyzer = {
        id: 'health',
        title: 'health',
        triggers: [],
        collectContext,
        buildPrompt: () => ({ system: 's', user: 'u' }),
        publishOutput: vi.fn(async () => {}),
      } as unknown as Analyzer;
      // makeRouter wires up working spy collaborators (canSpend, recordCall,
      // complete, publish) so the full router dance runs against fakes; see
      // makeRouterDeps in _mocks.ts.
      const { router: triggerRouter, mocks } = makeRouter([analyzer]);
      const rt = makePluginRuntime({
        analyzers: [analyzer],
        router: triggerRouter,
      });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/analyzers/:id/fire', {
        params: { id: 'health' },
      });
      expect(r.status).toBe(200);
      expect(collectContext).toHaveBeenCalledOnce();
      expect(mocks.complete).toHaveBeenCalledOnce();
      expect(mocks.recordCall).toHaveBeenCalledOnce();
    });
  });

  describe('/api/analyzers/:id/reports handler', () => {
    function makeRuntimeWithLog(logPath: string): PluginRuntime {
      return makePluginRuntime({
        analyzers: [fakeAnalyzer('health'), fakeAnalyzer('maintenance')],
        logPath,
      });
    }

    it('returns 404 for unknown analyzer', async () => {
      const rt = makeRuntimeWithLog('/tmp/missing.jsonl');
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'get', '/api/analyzers/:id/reports', {
        params: { id: 'unknown' },
      });
      expect(r.status).toBe(404);
    });

    it('returns empty list when the log file does not exist', async () => {
      const rt = makeRuntimeWithLog(join(dir, 'never-written.jsonl'));
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'get', '/api/analyzers/:id/reports', {
        params: { id: 'health' },
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, analyzer: 'health', reports: [] });
    });

    it('returns reports for the requested analyzer in newest-first order, respecting limit', async () => {
      const logPath = join(dir, 'reports.jsonl');
      const lines = [
        { ts: '2026-05-10T01:00:00Z', analyzer: 'health', trigger: 'cron', report: 'h1' },
        { ts: '2026-05-10T02:00:00Z', analyzer: 'maintenance', trigger: 'put', report: 'm1' },
        { ts: '2026-05-10T03:00:00Z', analyzer: 'health', trigger: 'cron', report: 'h2' },
        { ts: '2026-05-10T04:00:00Z', analyzer: 'health', trigger: 'cron', report: 'h3' },
      ];
      await writeFile(logPath, lines.map((l) => JSON.stringify(l)).join('\n'));
      const rt = makeRuntimeWithLog(logPath);
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);

      const r = await call(routes, 'get', '/api/analyzers/:id/reports', {
        params: { id: 'health' },
        query: { limit: '2' },
      });
      expect(r.status).toBe(200);
      const body = r.body as { reports: Array<{ report: string }> };
      expect(body.reports.map((x) => x.report)).toEqual(['h3', 'h2']);
    });

    it('clamps limit into [1, 100]', async () => {
      const logPath = join(dir, 'reports.jsonl');
      await writeFile(
        logPath,
        Array.from({ length: 5 }, (_, i) =>
          JSON.stringify({
            ts: `2026-05-10T0${i}:00:00Z`,
            analyzer: 'health',
            trigger: 'cron',
            report: `r${i}`,
          }),
        ).join('\n'),
      );
      const rt = makeRuntimeWithLog(logPath);
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);

      const overflow = await call(routes, 'get', '/api/analyzers/:id/reports', {
        params: { id: 'health' },
        query: { limit: '9999' },
      });
      expect((overflow.body as { reports: unknown[] }).reports).toHaveLength(5);

      const zero = await call(routes, 'get', '/api/analyzers/:id/reports', {
        params: { id: 'health' },
        query: { limit: '0' },
      });
      expect((zero.body as { reports: unknown[] }).reports).toHaveLength(1);
    });
  });

  describe('/api/analyzers/:id/prompt handler', () => {
    function makeRuntimeWithPromptOverride(id: AnalyzerId, custom?: string): PluginRuntime {
      const analyzers = custom ? { [id]: { customSystemPrompt: custom } } : {};
      return makePluginRuntime({ cfg: { analyzers } });
    }

    it('returns 404 for unknown analyzer', async () => {
      const rt = makeRuntimeWithPromptOverride('health');
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'get', '/api/analyzers/:id/prompt', {
        params: { id: 'bogus' },
      });
      expect(r.status).toBe(404);
    });

    it('returns default prompt with current=null when no override is set', async () => {
      const rt = makeRuntimeWithPromptOverride('health');
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'get', '/api/analyzers/:id/prompt', {
        params: { id: 'health' },
      });
      expect(r.status).toBe(200);
      const body = r.body as { analyzer: string; default: string; current: string | null };
      expect(body.analyzer).toBe('health');
      expect(body.default).toContain('marine electrical specialist');
      expect(body.current).toBeNull();
    });

    it('returns current=<override> when configured', async () => {
      const rt = makeRuntimeWithPromptOverride('health', 'CUSTOM_PROMPT');
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'get', '/api/analyzers/:id/prompt', {
        params: { id: 'health' },
      });
      expect((r.body as { current: string | null }).current).toBe('CUSTOM_PROMPT');
    });
  });

  describe('/api/openrouter/models handler', () => {
    beforeEach(() => {
      _resetOpenRouterModelsCache();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      _resetOpenRouterModelsCache();
    });

    const emptyRuntime = (): PluginRuntime => makePluginRuntime();

    it('serves the model list before plugin start (no runtime gate)', async () => {
      // The models route does not require a runtime, so the picker populates
      // before the plugin starts, the same way the prompt route serves its
      // compile-time default.
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ data: [{ id: 'x/y' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => null);
      const r = await call(routes, 'get', '/api/openrouter/models');
      expect(r.status).toBe(200);
      const body = r.body as { ok: boolean; data: Array<{ id: string }> };
      expect(body.ok).toBe(true);
      expect(body.data[0]?.id).toBe('x/y');
    });

    it('proxies upstream JSON on success and caches the result', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'a/b' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const rt = emptyRuntime();
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);

      const first = await call(routes, 'get', '/api/openrouter/models');
      expect(first.status).toBe(200);
      expect((first.body as { data: Array<{ id: string }> }).data[0]?.id).toBe('a/b');

      // Second call within the TTL must not re-hit the upstream.
      const second = await call(routes, 'get', '/api/openrouter/models');
      expect(second.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns 502 when upstream is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('Bad Gateway', {
              status: 502,
              headers: { 'content-type': 'text/plain' },
            }),
        ),
      );
      const rt = emptyRuntime();
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'get', '/api/openrouter/models');
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ error: 'upstream HTTP 502' });
    });
  });

  describe('/api/questdb/test handler', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const makeRuntime = (url: string): PluginRuntime =>
      makePluginRuntime({ cfg: { questdb: { enabled: true, url } } });

    it('returns 400 when no url and no plugin runtime', async () => {
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => null);
      const r = await call(routes, 'post', '/api/questdb/test', { body: {} });
      expect(r.status).toBe(400);
    });

    it('returns ok:true when QuestDB probe succeeds against the saved url', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ columns: [], dataset: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
      const rt = makeRuntime('http://qdb:9000');
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/questdb/test', { body: {} });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, url: 'http://qdb:9000' });
    });

    it('uses the url from the request body if provided', async () => {
      const fetchMock = vi.fn(
        async (..._args: unknown[]) =>
          new Response(JSON.stringify({ columns: [], dataset: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const rt = makeRuntime('http://saved:9000');
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/questdb/test', {
        body: { url: 'http://override:9000' },
      });
      expect((r.body as { url: string }).url).toBe('http://override:9000');
      const calledWith = String(fetchMock.mock.calls[0]?.[0] ?? '');
      expect(calledWith.startsWith('http://override:9000/')).toBe(true);
    });

    it('returns ok:false when QuestDB probe fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('boom', { status: 500 })),
      );
      const rt = makeRuntime('http://qdb:9000');
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/questdb/test', { body: {} });
      expect(r.status).toBe(200);
      const body = r.body as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      // Every ok:false response carries an error string, including the
      // reachable-but-wrong-answer probe (HTTP 200 with a falsy result).
      expect(typeof body.error).toBe('string');
    });
  });
});
