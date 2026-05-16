import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../src/core/openrouter.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeClient(overrides: Partial<ConstructorParameters<typeof OpenRouterClient>[0]> = {}) {
  return new OpenRouterClient({
    apiKey: 'k',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'm',
    requestTimeoutMs: 60_000,
    referer: 'r',
    title: 't',
    ...overrides,
  });
}

describe('OpenRouterClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns text and usage on a 200', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'hello world' } }],
        model: 'anthropic/claude-haiku-4.5',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const c = makeClient({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      requestTimeoutMs: 5000,
      referer: 'https://example.test',
      title: 'test-plugin',
    });
    const r = await c.complete({ system: 'sys', user: 'usr' });
    expect(r.text).toBe('hello world');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('expected fetch call');
    const [url, init] = firstCall;
    expect(url).toBe(ENDPOINT);
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBe('https://example.test');
    expect(headers['X-OpenRouter-Title']).toBe('test-plugin');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('anthropic/claude-haiku-4.5');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('retries on 429 honoring Retry-After', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { code: 429, message: 'rate limit' } }, { 'retry-after': '1' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const c = makeClient({ requestTimeoutMs: 5000 });
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(1500);
    const r = await p;
    expect(r.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws immediately on 401', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 401, message: 'bad key' } }),
    );
    const c = makeClient({ requestTimeoutMs: 5000 });
    await expect(c.complete({ system: 's', user: 'u' })).rejects.toMatchObject({
      name: 'OpenRouterError',
      status: 401,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight request when caller signal aborts', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const c = makeClient();
    const ctrl = new AbortController();
    const p = c.complete({ system: 's', user: 'u', abortSignal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });

  it('gives up after 3 retries on 503', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { code: 503, message: 'down' } }));
    const c = makeClient();
    const p = c.complete({ system: 's', user: 'u' });
    const assertion = expect(p).rejects.toMatchObject({ status: 503, retryable: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('retries on transient 500 and eventually succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 500, message: 'oops' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: 'after-retry' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const c = makeClient();
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.text).toBe('after-retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('retries on transient 502 and eventually succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(502, { error: { code: 502, message: 'bad gateway' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: 'after-502' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const c = makeClient();
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.text).toBe('after-502');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('retries on transient 504 and eventually succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(504, { error: { code: 504, message: 'gateway timeout' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: 'after-504' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const c = makeClient();
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.text).toBe('after-504');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('retries a rejected network call and succeeds on the next attempt', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [{ message: { content: 'reconnected' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const c = makeClient();
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.text).toBe('reconnected');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws a transport OpenRouterError after 4 failed network attempts', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const c = makeClient();
    const p = c.complete({ system: 's', user: 'u' });
    const assertion = expect(p).rejects.toMatchObject({
      name: 'OpenRouterError',
      status: 0,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('retries when the internal request timeout fires, not treated as a caller abort', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      })
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: 'recovered' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const c = makeClient({ requestTimeoutMs: 10 });
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.text).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('rethrows without retry when the caller signal is already aborted', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const c = makeClient();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      c.complete({ system: 's', user: 'u', abortSignal: ctrl.signal }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on an empty completion and does not retry', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      }),
    );
    const c = makeClient();
    await expect(c.complete({ system: 's', user: 'u' })).rejects.toMatchObject({
      name: 'OpenRouterError',
      status: 200,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies equal jitter to the backoff at the lower bound (random() = 0)', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: 503, message: 'down' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    // First ladder rung is 500ms; equal jitter with random()=0 yields 500 * 0.5 = 250ms.
    const c = makeClient({ random: () => 0 });
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const r = await p;
    expect(r.text).toBe('ok');
    vi.useRealTimers();
  });

  it('applies equal jitter to the backoff at the upper bound (random() = 1)', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: 503, message: 'down' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    // First ladder rung is 500ms; equal jitter with random()=1 yields 500 * 1.0 = 500ms.
    const c = makeClient({ random: () => 1 });
    const p = c.complete({ system: 's', user: 'u' });
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const r = await p;
    expect(r.text).toBe('ok');
    vi.useRealTimers();
  });
});
