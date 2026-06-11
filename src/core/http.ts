// A fetch bounded by a timeout and, optionally, the caller's lifecycle signal.
// AbortSignal.timeout fires its own TimeoutError after `timeoutMs`, and
// AbortSignal.any aborts the request on whichever signal trips first. Both
// auto-clean when the request settles, so callers need no manual clearTimeout
// or removeEventListener teardown. The returned signal also governs the
// response body stream, so a timeout that fires during res.json() aborts the
// read too.
//
// To tell the two abort causes apart after a throw, check the caller's signal:
// callerSignal?.aborted is true only for a caller abort, and stays false for a
// timeout (the timeout aborts the combined signal, not the caller's).
export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  return fetch(url, { ...init, signal });
}
