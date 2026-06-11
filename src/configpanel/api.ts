import type { FetchResult } from './types.js';

export const API_BASE = '/plugins/signalk-openrouter-companion/api';
export const POLL_MS = 5000;
export const REPORT_LIMIT = 10;

// Match SK admin convention (Configuration.tsx passes this on every fetch).
// Default works on same-origin browsers but breaks under reverse proxies that
// don't preserve cookies; explicit is safer.
async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...opts });
}

// Reduce a fetchJson envelope to a human-readable error string with one
// precedence: the server's {ok:false,error} body, then the transport error
// fetchJson caught, then a bare HTTP status. Body-agnostic so every call site
// (whatever its success-body shape) can reuse it; the server's error field is
// read off the body defensively rather than constraining the body type.
export function errText(r: FetchResult<unknown>): string {
  const { body } = r;
  const bodyError =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : '';
  return bodyError || r.error || `HTTP ${r.status}`;
}

// Standard envelope for the panel's REST calls: every endpoint returns JSON,
// and panel state always wants {ok, status, body, error}. Promotes the
// try/await/parse/catch boilerplate out of the callsites.
export async function fetchJson<T = unknown>(
  path: string,
  opts?: RequestInit,
): Promise<FetchResult<T>> {
  try {
    const res = await apiFetch(path, opts);
    let body: T | null = null;
    try {
      body = (await res.json()) as T;
    } catch {
      // non-JSON response body; leave body null, ok flag carries the status
    }
    return { ok: res.ok, status: res.status, body, error: null };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e instanceof Error ? e.message : String(e) };
  }
}
