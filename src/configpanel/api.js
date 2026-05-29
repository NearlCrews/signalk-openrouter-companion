export const API_BASE = '/plugins/signalk-openrouter-companion/api';
export const POLL_MS = 5000;
export const REPORT_LIMIT = 10;

// Match SK admin convention (Configuration.tsx passes this on every fetch).
// Default works on same-origin browsers but breaks under reverse proxies that
// don't preserve cookies; explicit is safer.
async function apiFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...opts });
}

// Reduce a fetchJson envelope to a human-readable error string with one
// precedence: the server's {ok:false,error} body, then the transport error
// fetchJson caught, then a bare HTTP status. Shared so the panel's failure
// branches do not each re-spell the same fallback chain.
export function errText(r) {
  return r.body?.error || r.error || `HTTP ${r.status}`;
}

// Standard envelope for the panel's REST calls: every endpoint returns JSON,
// and panel state always wants {ok, status, body, error}. Promotes the
// try/await/parse/catch boilerplate out of five callsites.
export async function fetchJson(path, opts) {
  try {
    const res = await apiFetch(path, opts);
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON response body; leave body null, ok flag carries the status
    }
    return { ok: res.ok, status: res.status, body, error: null };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e.message };
  }
}
