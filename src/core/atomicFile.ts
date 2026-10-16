import { rename, writeFile } from 'node:fs/promises';

// Writes one file atomically and in order. Each write goes to a temporary file
// that is then renamed over the target, so a concurrent reader or a power loss
// mid-write only ever sees a complete file, and the writes are chained, so two
// that overlap (the budget's pre-call and post-call saves, or the detector's
// periodic and event-driven saves) cannot land out of order or interleave.
//
// Best-effort by contract: a failed write is handed to `onError` and the
// returned promise still resolves, because both callers run inside paths that
// must not reject over a persistence fault.
export class AtomicFileWriter {
  private chain: Promise<void> = Promise.resolve();
  private readonly tempPath: string;

  constructor(
    private readonly path: string,
    private readonly onError: (err: unknown) => void,
  ) {
    this.tempPath = `${path}.tmp`;
  }

  write(data: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await writeFile(this.tempPath, data);
        await rename(this.tempPath, this.path);
      } catch (err) {
        this.onError(err);
      }
    });
    return this.chain;
  }

  // Settles once every write queued so far has.
  settled(): Promise<void> {
    return this.chain;
  }
}
