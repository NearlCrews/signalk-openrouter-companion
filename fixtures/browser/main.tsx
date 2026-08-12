import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';

declare const __REMOTE_URL__: string;

interface PanelProps {
  configuration: Record<string, unknown>;
  save: (configuration: Record<string, unknown>) => void;
}

interface RemoteContainer {
  get(module: string): Promise<() => { default: React.ComponentType<PanelProps> }>;
  init(scope: ShareScope): Promise<void> | void;
}

interface ShareScope {
  readonly react: Record<
    string,
    {
      readonly eager: boolean;
      readonly from: string;
      readonly get: () => Promise<() => typeof React>;
      readonly loaded: boolean;
    }
  >;
  readonly 'react-dom': Record<
    string,
    {
      readonly eager: boolean;
      readonly from: string;
      readonly get: () => Promise<() => typeof ReactDOM>;
      readonly loaded: boolean;
    }
  >;
}

const parameters = new URLSearchParams(window.location.search);
const screenshotMode = parameters.has('screenshots');
const statusRaceMode = parameters.has('status-race');
if (parameters.has('unsupported-css-scope')) {
  Object.defineProperty(window, 'CSSScopeRule', {
    configurable: true,
    value: undefined,
  });
}

const statusPayload = {
  startedAt: 1_786_000_000_000,
  openrouter: {
    apiKeySet: screenshotMode,
    model: 'anthropic/claude-sonnet-4',
    callsToday: 3,
    maxCallsPerDay: 50,
    tokensToday: 12_480,
    costToday: 0.0832,
  },
  history: { source: 'questdb', reachable: true },
  analyzers: [
    {
      id: 'maintenance',
      title: 'Maintenance Advisor',
      enabled: true,
      cron: { enabled: false, pattern: '' },
    },
    {
      id: 'health',
      title: 'Battery Health Advisor',
      enabled: true,
      cron: { enabled: true, pattern: '0 8 * * *' },
    },
    {
      id: 'aging',
      title: 'Battery Aging Tracker',
      enabled: true,
      cron: { enabled: true, pattern: '0 8 1 * *' },
    },
    {
      id: 'drift',
      title: 'Engine Performance Drift',
      enabled: true,
      cron: { enabled: true, pattern: '0 8 * * 0' },
    },
    {
      id: 'alerts',
      title: 'Battery Alerts',
      enabled: true,
      cron: { enabled: false, pattern: '' },
    },
    {
      id: 'liveness',
      title: 'Sensor Liveness Monitor',
      enabled: true,
      cron: { enabled: true, pattern: '0 8 * * *' },
    },
    {
      id: 'forecast',
      title: 'Weather Outlook Advisor',
      enabled: false,
      cron: { enabled: true, pattern: '0 */3 * * *' },
      hasSeverityFloor: true,
    },
  ],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

window.fetch = async (input, init): Promise<Response> => {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(rawUrl, window.location.origin);
  const path = url.pathname;
  if (path.endsWith('/status')) {
    const requestCount = Number(document.body.dataset.statusRequestCount ?? 0) + 1;
    document.body.dataset.statusRequestCount = String(requestCount);
    if (statusRaceMode && requestCount === 2) {
      await new Promise<void>((resolveAbort) => {
        const signal = init?.signal;
        let settled = false;
        let timeout: number | undefined;
        const finish = (aborted: boolean): void => {
          if (settled) return;
          settled = true;
          if (timeout !== undefined) window.clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
          if (aborted) document.body.dataset.supersededStatusAborted = 'true';
          resolveAbort();
        };
        const onAbort = (): void => finish(true);
        timeout = window.setTimeout(() => finish(false), 10_000);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      return jsonResponse({
        ...statusPayload,
        openrouter: { ...statusPayload.openrouter, callsToday: 1 },
      });
    }
    if (statusRaceMode && requestCount >= 3) {
      return jsonResponse({
        ...statusPayload,
        openrouter: { ...statusPayload.openrouter, callsToday: 9 },
      });
    }
    return jsonResponse(statusPayload);
  }
  if (path.endsWith('/openrouter/models')) {
    const requestCount = Number(document.body.dataset.modelRequestCount ?? 0) + 1;
    document.body.dataset.modelRequestCount = String(requestCount);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    return jsonResponse({
      data: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet' },
        { id: 'openai/gpt-5', name: 'GPT-5' },
      ],
    });
  }
  if (path.endsWith('/openrouter/test') && init?.method === 'POST') {
    return jsonResponse({ totalTokens: 42, model: 'fixture/model' });
  }
  if (path.endsWith('/questdb/test') && init?.method === 'POST') {
    return jsonResponse({ ok: true, url: 'http://localhost:9000' });
  }
  if (path.endsWith('/influxdb/test') && init?.method === 'POST') {
    return jsonResponse({
      ok: true,
      url: 'http://influx.local:8086',
      database: 'signalk',
      version: '2',
    });
  }
  if (path.endsWith('/reports')) return jsonResponse({ reports: [] });
  if (path.endsWith('/prompt')) {
    return jsonResponse({ default: 'Summarize the vessel data.', current: null });
  }
  if (path.endsWith('/fire') && init?.method === 'POST') {
    return jsonResponse({ outcome: 'reported' });
  }
  return jsonResponse({ ok: false, error: `Unhandled fixture request: ${path}` }, 404);
};

const shareScope: ShareScope = {
  react: {
    [React.version]: {
      eager: true,
      from: 'openrouter-companion-browser-fixture',
      get: () => Promise.resolve(() => React),
      loaded: true,
    },
  },
  'react-dom': {
    [ReactDOM.version]: {
      eager: true,
      from: 'openrouter-companion-browser-fixture',
      get: () => Promise.resolve(() => ReactDOM),
      loaded: true,
    },
  },
};

try {
  const container = (await import(/* @vite-ignore */ __REMOTE_URL__)) as RemoteContainer;
  await container.init(shareScope);
  const factory = await container.get('./PluginConfigurationPanel');
  const Panel = factory().default;
  const rootElement = document.querySelector('#root');
  if (!(rootElement instanceof HTMLElement)) throw new Error('Fixture root is missing.');

  const initialConfiguration = {
    extensionOwnedByAnotherPlugin: {
      enabled: true,
      nested: { retained: 'unchanged' },
    },
    openrouter: {
      ...(screenshotMode ? { apiKey: 'sk-or-v1-fixture-not-a-real-key' } : {}),
      model: 'anthropic/claude-sonnet-4',
      maxCallsPerDay: 50,
      futureOpenRouterSetting: { retained: 'openrouter' },
    },
    history: {
      futureHistorySetting: { retained: 'history' },
      questdb: { futureQuestDBSetting: { retained: 'questdb' } },
      influxdb: { futureInfluxDBSetting: { retained: 'influxdb' } },
    },
    analyzers: {
      maintenance: { futureAnalyzerSetting: { retained: 'analyzer' } },
    },
    questdb: { enabled: true, url: 'http://localhost:9000' },
  };

  function HostFixture(): React.ReactElement {
    const [configuration, setConfiguration] =
      React.useState<Record<string, unknown>>(initialConfiguration);

    const save = (nextConfiguration: Record<string, unknown>): void => {
      const priorSaveCount = Number(document.body.dataset.saveCount ?? 0);
      document.body.dataset.saveCount = String(priorSaveCount + 1);
      document.body.dataset.savedConfiguration = JSON.stringify(nextConfiguration);
      let completed = false;
      let fallbackTimer: number | undefined;
      const completeHostResync = (): void => {
        if (completed) return;
        completed = true;
        document.removeEventListener('fixture-host-resync', completeHostResync);
        if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
        setConfiguration(nextConfiguration);
        statusPayload.startedAt += 1;
        document.body.dataset.hostResyncCount = String(
          Number(document.body.dataset.hostResyncCount ?? 0) + 1,
        );
        document.dispatchEvent(new Event('visibilitychange'));
      };
      document.addEventListener('fixture-host-resync', completeHostResync, { once: true });
      fallbackTimer = window.setTimeout(completeHostResync, 95_000);
    };

    return <Panel configuration={configuration} save={save} />;
  }

  createRoot(rootElement).render(
    <React.StrictMode>
      <HostFixture />
    </React.StrictMode>,
  );
  document.body.dataset.fixtureReady = 'true';
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const errorElement = document.querySelector('#fixture-error');
  if (errorElement) {
    errorElement.setAttribute('role', 'alert');
    errorElement.textContent = message;
  }
  document.body.dataset.fixtureReady = 'false';
}
