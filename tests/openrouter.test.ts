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
    const c = new OpenRouterClient({
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-haiku-4.5',
      requestTimeoutMs: 5000,
      referer: 'https://example.test',
      title: 'test-plugin',
    });
    const r = await c.complete({ system: 'sys', user: 'usr' });
    expect(r.text).toBe('hello world');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
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
    const c = new OpenRouterClient({
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'm',
      requestTimeoutMs: 5000,
      referer: 'r',
      title: 't',
    });
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
    const c = new OpenRouterClient({
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'm',
      requestTimeoutMs: 5000,
      referer: 'r',
      title: 't',
    });
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
    const c = new OpenRouterClient({
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'm',
      requestTimeoutMs: 60_000,
      referer: 'r',
      title: 't',
    });
    const ctrl = new AbortController();
    const p = c.complete({ system: 's', user: 'u', abortSignal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });

  it('gives up after 3 retries on 503', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { code: 503, message: 'down' } }));
    const c = new OpenRouterClient({
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'm',
      requestTimeoutMs: 60_000,
      referer: 'r',
      title: 't',
    });
    const p = c.complete({ system: 's', user: 'u' });
    const assertion = expect(p).rejects.toMatchObject({ status: 503, retryable: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
