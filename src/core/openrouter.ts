export interface OpenRouterCfg {
  apiKey: string;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  referer: string;
  title: string;
  random?: () => number;
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

// Statuses worth a retry: rate limiting and gateway/server faults. Every other
// non-200 status is terminal and throws without a retry.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

const MAX_RETRIES = 3;

// Upper bound on a single completion. Analyzer reports are short (a headline
// plus a few sentences), so this is generous headroom for the longest
// narrative while still bounding a pathological runaway completion. The
// per-day call cap in BudgetTracker bounds total spend; this bounds one call.
const MAX_COMPLETION_TOKENS = 2000;

// One attempt's terminal outcome: either a usable result, or a retry signal
// carrying the error to throw once the retry budget is exhausted.
type Attempt =
  | { kind: 'result'; result: CompleteResult }
  | { kind: 'retry'; error: OpenRouterError; retryAfterMs: number | null };

export class OpenRouterClient {
  private readonly random: () => number;

  constructor(private cfg: OpenRouterCfg) {
    this.random = cfg.random ?? Math.random;
  }

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.attempt(args);
      if (outcome.kind === 'result') return outcome.result;
      if (attempt >= MAX_RETRIES) throw outcome.error;
      // delay() rejects with the caller's abort reason if the signal trips
      // mid-backoff, so a shutdown does not wait out the full delay first.
      await delay(backoffMs(attempt, outcome.retryAfterMs, this.random), args.abortSignal);
    }
  }

  // A single request: its own timeout and abort wiring, both cleaned up before
  // the caller decides whether to retry. Throws for terminal failures (a
  // terminal HTTP status, an empty completion, a caller abort); returns a retry
  // signal for transient HTTP statuses and transport faults.
  private async attempt(args: CompleteArgs): Promise<Attempt> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
    const onCallerAbort = (): void => ctrl.abort();
    if (args.abortSignal) {
      if (args.abortSignal.aborted) ctrl.abort();
      else args.abortSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      let res: Response;
      try {
        res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
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
            max_tokens: MAX_COMPLETION_TOKENS,
            messages: [
              { role: 'system', content: args.system },
              { role: 'user', content: args.user },
            ],
          }),
        });
      } catch (err) {
        return transportRetry(args, err);
      }

      if (res.status === 200) {
        let body: ApiResponse;
        try {
          body = (await res.json()) as ApiResponse;
        } catch (err) {
          // The timeout firing mid-body-read, or a truncated/malformed
          // payload: same transient treatment as a failed fetch.
          return transportRetry(args, err);
        }
        const text = body.choices?.[0]?.message?.content ?? '';
        if (text.trim() === '') {
          throw new OpenRouterError(200, 'empty completion', body, false);
        }
        const u = body.usage ?? {};
        return {
          kind: 'result',
          result: {
            text,
            model: body.model ?? this.cfg.model,
            usage: {
              promptTokens: u.prompt_tokens ?? 0,
              completionTokens: u.completion_tokens ?? 0,
              totalTokens: u.total_tokens ?? 0,
            },
            raw: body,
          },
        };
      }

      const errBody = await safeJson(res);
      const message = errBody?.error?.message ?? `HTTP ${res.status}`;
      const metadata = errBody?.error?.metadata;
      if (TRANSIENT_STATUSES.has(res.status)) {
        return {
          kind: 'retry',
          error: new OpenRouterError(res.status, message, metadata, true),
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        };
      }
      throw new OpenRouterError(res.status, message, metadata, false);
    } finally {
      clearTimeout(timeout);
      args.abortSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

// Classify a thrown fetch or body-read error. A caller-requested abort
// propagates untouched; anything else (a transport fault or the internal
// timeout abort) becomes a transient retry signal.
function transportRetry(args: CompleteArgs, err: unknown): Attempt {
  if (args.abortSignal?.aborted) throw err;
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: 'retry',
    error: new OpenRouterError(0, message, undefined, true),
    retryAfterMs: null,
  };
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

const BACKOFF_LADDER = [500, 1500, 4500] as const;

function backoffMs(attempt: number, retryAfterMs: number | null, random: () => number): number {
  const base = BACKOFF_LADDER[Math.min(attempt, BACKOFF_LADDER.length - 1)] as number;
  const jitteredBase = base * (0.5 + random() * 0.5);
  return Math.max(jitteredBase, retryAfterMs ?? 0);
}

// Resolve after `ms`, or reject early with the caller's abort reason if the
// signal trips first. Used for the inter-attempt backoff wait.
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
