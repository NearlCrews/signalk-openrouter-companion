import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    it('registers /api/status (GET) and /api/openrouter/test (POST)', () => {
      const plugin = createPlugin(app as never);
      const { router, routes } = makeRecordingRouter();
      plugin.registerWithRouter(router);
      expect(routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort()).toEqual([
        'GET /api/status',
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
});
