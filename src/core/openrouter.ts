import type { ProviderRoutingCfg } from '../types.js';
import { abortable, fetchWithTimeout } from './http.js';

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
  // Asked before each retry, with `timedOut` set when the attempt that just
  // failed was the client's own request timeout rather than an HTTP status.
  // That distinction matters to the caller's spend accounting: a timeout
  // abandons a request the provider may already have billed, while a 429 or a
  // gateway fault produced no generation at all. Returning false ends the
  // ladder and throws the failure that prompted the retry. Absent, every
  // attempt up to MAX_RETRIES runs.
  beforeRetry?(previous: { timedOut: boolean }): Promise<boolean>;
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

// OpenRouter's error envelope. `metadata.error_type` is its canonical
// classification (`provider_overloaded`, `rate_limit_exceeded`, ...); the
// other metadata keys vary by failure and are passed through untyped.
interface ApiErrorMetadata {
  error_type?: unknown;
  [key: string]: unknown;
}

interface ApiErrorBody {
  error?: { code?: number; message?: string; metadata?: ApiErrorMetadata };
}

// Statuses worth a retry on the status alone: rate limiting and gateway/server
// faults. 502 (chosen provider down) stays retryable. 503 is classified by
// the error body instead, see isTransient. Every other non-200 status is
// terminal and throws without a retry.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 504]);

// OpenRouter answers 503 for two different things. An overloaded provider is
// transient and carries Retry-After; the body marks it with this error_type.
// "No provider meets the routing requirements" (a config problem from
// max_price / data_collection / zdr / allow_fallbacks) is the other 503, and
// retrying cannot fix it. Only the overloaded form is retried; a 503 without
// that marker, including one with no body at all, throws terminally so the
// descriptive routing message reaches the failure report.
const SERVICE_UNAVAILABLE_STATUS = 503;
const PROVIDER_OVERLOADED_ERROR_TYPE = 'provider_overloaded';

// Second sentence of a terminal 503 message, so the failure notification, the
// JSONL log, and the server log all point the operator at the settings that
// can leave no eligible provider.
const ROUTING_HINT =
  'Check the OpenRouter provider preferences (maxPrice, dataCollection, zdr, allowFallbacks) and the model list.';

const MAX_RETRIES = 3;

// Upper bound on a single completion. Analyzer reports are short (a headline
// plus a few sentences), so this is generous headroom for the longest
// narrative while still bounding a pathological runaway completion. The
// per-day call cap in BudgetTracker bounds total spend; this bounds one call.
const MAX_COMPLETION_TOKENS = 2000;

// AbortSignal.timeout rejects with a DOMException named TimeoutError, which is
// how a request the client gave up on is told apart from a transport fault that
// never reached the provider (a TypeError from fetch). Only the former can have
// left a generation running, and billing, upstream.
const TIMEOUT_ERROR_NAME = 'TimeoutError';

// One attempt's terminal outcome: either a usable result, or a retry signal
// carrying the error to throw once the retry budget is exhausted. `timedOut`
// marks the client's own request timeout, the one retry the caller may have to
// pay for; see CompleteArgs.beforeRetry.
type Attempt =
  | { kind: 'result'; result: CompleteResult }
  | {
      kind: 'retry';
      error: OpenRouterError;
      retryAfterMs: number | null;
      timedOut: boolean;
    };

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
      // The caller gets the last word on whether another attempt is affordable.
      if (args.beforeRetry && !(await args.beforeRetry({ timedOut: outcome.timedOut }))) {
        throw outcome.error;
      }
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
            // Trim first, then drop blank entries (a cleared admin-UI row) and
            // dedupe against the primary so a copy-pasted slug does not appear
            // twice, nor reach the request body wearing its stray spaces.
            const fallbacks = (this.cfg.fallbackModels ?? [])
              .map((m) => m.trim())
              .filter((m) => m !== '');
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
    const errorType = typeof metadata?.error_type === 'string' ? metadata.error_type : undefined;
    if (isTransient(res.status, errorType)) {
      return {
        kind: 'retry',
        error: new OpenRouterError(res.status, message, metadata),
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        timedOut: false,
      };
    }
    throw new OpenRouterError(res.status, terminalMessage(res.status, message), metadata);
  }
}

// Whether a non-200 status is worth another attempt. 503 depends on the body:
// only an overloaded provider is transient, and a missing or different
// error_type means a routing problem that retrying cannot fix.
function isTransient(status: number, errorType: string | undefined): boolean {
  if (status === SERVICE_UNAVAILABLE_STATUS) return errorType === PROVIDER_OVERLOADED_ERROR_TYPE;
  return TRANSIENT_STATUSES.has(status);
}

// A terminal 503 gets the routing hint appended as its own sentence, after
// OpenRouter's message (or the bare `HTTP 503` when the body carried none).
function terminalMessage(status: number, message: string): string {
  if (status !== SERVICE_UNAVAILABLE_STATUS) return message;
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return `${sentence} ${ROUTING_HINT}`;
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
    // The request timeout, or that timeout firing mid-body-read: both abandon
    // a generation the provider may have finished and billed.
    timedOut: err instanceof Error && err.name === TIMEOUT_ERROR_NAME,
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

// Ceiling on an honored `Retry-After`. A provider is free to ask for an hour,
// but the budget call is already recorded and the next cron fire is coming, so
// waiting that long pins the run and delays the failure report the operator
// needs. Past this bound the header is capped rather than obeyed.
const MAX_RETRY_AFTER_MS = 60_000;

function backoffMs(attempt: number, retryAfterMs: number | null, random: () => number): number {
  const base = BACKOFF_LADDER[Math.min(attempt, BACKOFF_LADDER.length - 1)] as number;
  const jitteredBase = base * (0.5 + random() * 0.5);
  return Math.max(jitteredBase, Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
}

// Resolve after `ms`, or reject early with the caller's abort reason if the
// signal trips first. Used for the inter-attempt backoff wait. The abort hook
// clears the pending timer so a cancelled backoff holds the event loop open no
// longer than the caller does.
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return abortable(wait, signal, () => clearTimeout(timer));
}
