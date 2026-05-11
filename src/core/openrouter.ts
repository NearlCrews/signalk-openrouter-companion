export interface OpenRouterCfg {
  apiKey: string;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  referer: string;
  title: string;
}

export interface CompleteArgs {
  system: string;
  user: string;
  abortSignal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  raw: unknown;
}

export class OpenRouterError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly metadata?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

interface ApiResponse {
  choices: { message: { content?: string } }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface ApiErrorBody {
  error?: { code?: number; message?: string; metadata?: unknown };
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503]);
const TERMINAL_STATUSES = new Set([400, 401, 402, 403, 408, 413, 422]);

export class OpenRouterClient {
  constructor(private cfg: OpenRouterCfg) {}

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    return this.doCall(args, 0);
  }

  private async doCall(args: CompleteArgs, attempt: number): Promise<CompleteResult> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
    const onCallerAbort = (): void => ctrl.abort();
    if (args.abortSignal) {
      if (args.abortSignal.aborted) ctrl.abort();
      else args.abortSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': this.cfg.referer,
          'X-OpenRouter-Title': this.cfg.title,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            { role: 'system', content: args.system },
            { role: 'user', content: args.user },
          ],
        }),
      });

      if (res.status === 200) {
        const body = (await res.json()) as ApiResponse;
        const text = body.choices?.[0]?.message?.content ?? '';
        const u = body.usage ?? {};
        return {
          text,
          model: body.model ?? this.cfg.model,
          usage: {
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            totalTokens: u.total_tokens ?? 0,
          },
          raw: body,
        };
      }

      const errBody = await safeJson(res);
      const message = errBody?.error?.message ?? `HTTP ${res.status}`;
      const metadata = errBody?.error?.metadata;

      if (TERMINAL_STATUSES.has(res.status)) {
        throw new OpenRouterError(res.status, message, metadata, false);
      }
      if (TRANSIENT_STATUSES.has(res.status)) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        if (attempt >= 3) {
          throw new OpenRouterError(res.status, message, metadata, true);
        }
        await delay(backoffMs(attempt, retryAfter));
        return this.doCall(args, attempt + 1);
      }
      throw new OpenRouterError(res.status, message, metadata, false);
    } finally {
      clearTimeout(timeout);
      args.abortSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

async function safeJson(res: Response): Promise<ApiErrorBody | null> {
  try {
    return (await res.json()) as ApiErrorBody;
  } catch {
    return null;
  }
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const sec = Number.parseInt(h, 10);
  return Number.isFinite(sec) ? sec * 1000 : null;
}

function backoffMs(attempt: number, retryAfterMs: number | null): number {
  const base = [500, 1500, 4500][attempt] ?? 4500;
  if (retryAfterMs == null) return base;
  return Math.max(base, retryAfterMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
