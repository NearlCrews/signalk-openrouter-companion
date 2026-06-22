import type { ProviderRoutingCfg } from '../types.js';
import { fetchWithTimeout } from './http.js';

interface OpenRouterCfg {
  apiKey: string;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  referer: string;
  title: string;
  random?: () => number;
  fallbackModels?: string[];
  provider?: ProviderRoutingCfg;
}

interface CompleteArgs {
  system: string;
  user: string;
  abortSignal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cost: number;
  };
}

export class OpenRouterError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly metadata?: unknown,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

interface ApiResponse {
  choices: { message: { content?: string }; finish_reason?: string }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface ApiErrorBody {
  error?: { code?: number; message?: string; metadata?: unknown };
}

// Statuses worth a retry: rate limiting and gateway/server faults. Every other
// non-200 status is terminal and throws without a retry.
// 503 is excluded on purpose: OpenRouter returns it for "no provider meets
// routing requirements" (a config problem from max_price / data_collection /
// zdr / allow_fallbacks), which retrying cannot fix. It throws terminally so
// the descriptive routing message reaches the failure report. 502 (chosen
// provider down) stays retryable.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 504]);

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

  // True when the primary model or any fallback is Anthropic. Drives the
  // explicit cache breakpoint: a fallback may answer instead of the primary,
  // so gate caching on the whole resolved model set, not just cfg.model.
  private usesAnthropicModel(): boolean {
    if (this.cfg.model.startsWith('anthropic/')) return true;
    return (this.cfg.fallbackModels ?? []).some((m) => m.startsWith('anthropic/'));
  }

  private buildSystemMessage(system: string): unknown {
    // Anthropic needs an explicit cache breakpoint; OpenAI/Gemini/etc cache
    // automatically and ignore the marker. Below the model's cache floor
    // (4,096 tokens on Haiku 4.5) the marker is a silent no-op, not an error.
    if (this.usesAnthropicModel()) {
      return {
        role: 'system',
        content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      };
    }
    return { role: 'system', content: system };
  }

  private buildProvider(): Record<string, unknown> | undefined {
    const p = this.cfg.provider;
    if (!p) return undefined;
    const out: Record<string, unknown> = {};
    if (p.sort) out.sort = p.sort;
    if (p.maxPrice) out.max_price = p.maxPrice;
    if (p.allowFallbacks !== undefined) out.allow_fallbacks = p.allowFallbacks;
    if (p.dataCollection) out.data_collection = p.dataCollection;
    if (p.zdr !== undefined) out.zdr = p.zdr;
    return Object.keys(out).length > 0 ? out : undefined;
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

  // A single request bounded by its own timeout, combined with the caller's
  // abort signal via fetchWithTimeout (no manual teardown needed). Throws for
  // terminal failures (a terminal HTTP status, an empty completion, a caller
  // abort); returns a retry signal for transient HTTP statuses and transport
  // faults, including the request timeout.
  private async attempt(args: CompleteArgs): Promise<Attempt> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.cfg.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': this.cfg.referer,
            'X-OpenRouter-Title': this.cfg.title,
          },
          body: (() => {
            const payload: Record<string, unknown> = {
              max_tokens: MAX_COMPLETION_TOKENS,
              messages: [
                this.buildSystemMessage(args.system),
                { role: 'user', content: args.user },
              ],
            };
            // Drop blank entries (a cleared admin-UI row) and dedupe against
            // the primary so a copy-pasted slug does not appear twice.
            const fallbacks = (this.cfg.fallbackModels ?? []).filter((m) => m.trim() !== '');
            if (fallbacks.length > 0) {
              payload.models = [...new Set([this.cfg.model, ...fallbacks])];
            } else {
              payload.model = this.cfg.model;
            }
            const provider = this.buildProvider();
            if (provider) payload.provider = provider;
            return JSON.stringify(payload);
          })(),
        },
        this.cfg.requestTimeoutMs,
        args.abortSignal,
      );
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
      const choice = body.choices?.[0];
      const text = choice?.message?.content ?? '';
      if (text.trim() === '') {
        // Surface finish_reason (e.g. 'error', 'content_filter') so an empty
        // 200 is diagnosable rather than an opaque "empty completion".
        const reason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : '';
        throw new OpenRouterError(200, `empty completion${reason}`, body);
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
            cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
            cost: u.cost ?? 0,
          },
        },
      };
    }

    const errBody = await safeJson(res);
    const message = errBody?.error?.message ?? `HTTP ${res.status}`;
    const metadata = errBody?.error?.metadata;
    if (TRANSIENT_STATUSES.has(res.status)) {
      return {
        kind: 'retry',
        error: new OpenRouterError(res.status, message, metadata),
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      };
    }
    throw new OpenRouterError(res.status, message, metadata);
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
    error: new OpenRouterError(0, message),
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

// `Retry-After` is either a number of seconds or an HTTP-date (RFC 9110).
// Only an all-digits value is read as seconds; Number.parseInt would otherwise
// accept a malformed "12abc" as 12. Anything else falls through to the date
// branch, which yields null for an unparseable value.
function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const trimmed = h.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
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
