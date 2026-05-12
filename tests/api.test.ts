import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analyzer } from '../src/analyzers/Analyzer.js';
import type { PluginRuntime, RouteRequest, RouteResponse, RouterLike } from '../src/core/api.js';
import { registerApiRoutes } from '../src/core/api.js';
import { OpenRouterError } from '../src/core/openrouter.js';
import createPlugin from '../src/index.js';
import { cleanupTmpDir, type MockApp, makeMockApp, makeTmpDir } from './_mocks.js';

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
    it('registers status, openrouter test, fire, and reports routes', () => {
      const plugin = createPlugin(app as never);
      const { router, routes } = makeRecordingRouter();
      plugin.registerWithRouter(router);
      expect(routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort()).toEqual([
        'GET /api/analyzers/:id/reports',
        'GET /api/status',
        'POST /api/analyzers/:id/fire',
        'POST /api/openrouter/test',
      ]);
    });

    it('returns 503 from /api/status before plugin start', async () => {
      const plugin = createPlugin(app as never);
      const { router, routes } = makeRecordingRouter();
      plugin.registerWithRouter(router);
      const r = await call(routes, 'get', '/api/status');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: 'plugin not started' });
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
      await plugin.whenReady();

      const r = await call(routes, 'get', '/api/status');
      expect(r.status).toBe(200);
      const body = r.body as {
        openrouter: { apiKeySet: boolean; model: string; callsToday: number };
        questdb: { enabled: boolean; reachable: boolean | null };
        analyzers: Array<{ id: string; enabled: boolean }>;
      };
      expect(body.openrouter.apiKeySet).toBe(true);
      expect(body.openrouter.callsToday).toBe(0);
      // The default config enables maintenance + alerts; aging/drift/health
      // default off. Assert via the union to stay resilient to default flips.
      const enabled = new Set(body.analyzers.filter((a) => a.enabled).map((a) => a.id));
      expect(enabled.has('maintenance')).toBe(true);
      expect(body.analyzers).toHaveLength(5);

      vi.unstubAllGlobals();
      await plugin.stop();
    });
  });

  describe('/api/openrouter/test handler', () => {
    function makeRuntime(overrides: Partial<PluginRuntime> = {}): PluginRuntime {
      const calls: string[] = [];
      return {
        cfg: { openrouter: { model: 'm', maxCallsPerDay: 100 }, questdb: { enabled: false } },
        llm: {
          complete: async () => ({
            text: 'OK',
            model: 'anthropic/claude-haiku-4.5',
            usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
            raw: {},
          }),
        } as never,
        budget: { callsToday: () => calls.length } as never,
        questdbLive: null,
        questdbProbed: false,
        analyzers: [],
        apiKeySet: true,
        router: null,
        logPath: '/tmp/unused.jsonl',
        ...overrides,
      };
    }

    it('returns ok+token usage on a successful ping', async () => {
      const rt = makeRuntime();
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
      const rt = makeRuntime({ apiKeySet: false });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/openrouter/test');
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ ok: false, error: 'API key not configured' });
    });

    it('passes through OpenRouter HTTP status on error', async () => {
      const rt = makeRuntime({
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
      dispatch?: (kind: string, ctx: unknown) => Promise<void>;
    }): { rt: PluginRuntime; calls: Array<{ kind: string; ctx: unknown }> } {
      const calls: Array<{ kind: string; ctx: unknown }> = [];
      const dispatch =
        opts.dispatch ??
        (async (kind: string, ctx: unknown): Promise<void> => {
          calls.push({ kind, ctx });
        });
      const rt: PluginRuntime = {
        cfg: { openrouter: { model: 'm', maxCallsPerDay: 100 }, questdb: { enabled: false } },
        llm: {} as never,
        budget: { callsToday: () => 0 } as never,
        questdbLive: null,
        questdbProbed: false,
        analyzers: opts.enabledIds.map(fakeAnalyzer),
        apiKeySet: true,
        router: { dispatch } as never,
        logPath: '/tmp/unused.jsonl',
      };
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

    it('dispatches a put-kind ctx via the router on success', async () => {
      const { rt, calls } = makeRuntimeWithRouter({ enabledIds: ['health'] });
      const { router, routes } = makeRecordingRouter();
      registerApiRoutes(router, () => rt);
      const r = await call(routes, 'post', '/api/analyzers/:id/fire', {
        params: { id: 'health' },
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, analyzer: 'health' });
      expect(calls).toHaveLength(1);
      const first = calls[0];
      expect(first?.kind).toBe('put');
      expect((first?.ctx as { kind: string }).kind).toBe('put');
    });

    it('returns 500 when the router dispatch throws', async () => {
      const { rt } = makeRuntimeWithRouter({
        enabledIds: ['health'],
        dispatch: async () => {
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
  });

  describe('/api/analyzers/:id/reports handler', () => {
    function makeRuntimeWithLog(logPath: string): PluginRuntime {
      return {
        cfg: { openrouter: { model: 'm', maxCallsPerDay: 100 }, questdb: { enabled: false } },
        llm: {} as never,
        budget: { callsToday: () => 0 } as never,
        questdbLive: null,
        questdbProbed: false,
        analyzers: [fakeAnalyzer('health'), fakeAnalyzer('maintenance')],
        apiKeySet: true,
        router: null,
        logPath,
      };
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
      expect(r.body).toEqual({ analyzer: 'health', reports: [] });
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
});
