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
// Settle with `work`, or reject as soon as the caller's signal aborts, with the
// signal's own reason. Only this caller's wait ends: the work itself is left to
// finish or time out on its own, which is what a shared in-flight promise needs
// so one caller walking away cannot cancel another's. `onAbort` releases a
// resource the wait owned, such as the timer behind a delay.
export function abortable<T>(
  work: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      onAbort?.();
      reject(signal.reason);
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', handleAbort));
  });
}

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
