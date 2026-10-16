import { appendFile, open, rename, stat } from 'node:fs/promises';

// The JSONL report log: one JSON object per line, appended by the publisher
// and read back newest-first by the admin reports route. The row shape, the
// rotation, and the tail reader live together here so the writer and the
// reader cannot disagree about the file.

// One log row.
export interface JsonlEntry {
  ts: string;
  analyzer: string;
  trigger: string;
  engineId?: string;
  sessionStart?: string;
  sessionEnd?: string;
  durationSec?: number;
  report: string;
  failure?: string;
  model?: string;
  totalTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}

// Size at which the log rotates. One generation is kept, so the log costs at
// most twice this on disk, and the tail reader still reads a bounded file.
// Sized so a plugin running at the daily call ceiling holds weeks of history
// before the first rotation.
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;

export class ReportLog {
  // Bytes in the current generation, or null until the first append of this
  // process stats the file. See rotateIfOversized.
  private bytes: number | null = null;

  constructor(
    private readonly path: string,
    private readonly maxBytes = DEFAULT_MAX_LOG_BYTES,
  ) {}

  // Append one row. Rejects on a write fault; the caller decides what a failed
  // append means.
  async append(entry: JsonlEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    await this.rotateIfOversized();
    await appendFile(this.path, line);
    // A failed append leaves the running total where it was, which is what
    // the file still holds.
    this.bytes = (this.bytes ?? 0) + Buffer.byteLength(line);
  }

  // Keep the log bounded. Nothing else trims it, so an unbounded log would
  // eventually cost both disk and a growing admin request. One generation is
  // kept as `<log>.1`; the reports route reads only the current file, so
  // history immediately after a rotation is short rather than lost.
  //
  // The size is stat'd once per plugin start and then tracked by what this
  // writer appends, because the rotation fires about once a year at a few
  // hundred rows a day and a stat before every append is a filesystem round
  // trip that learns nothing. The plugin is the sole writer of this file.
  private async rotateIfOversized(): Promise<void> {
    if (this.bytes === null) {
      try {
        this.bytes = (await stat(this.path)).size;
      } catch {
        // No log yet (the first append creates it), or it is unreadable; either
        // way there is nothing to rotate and the append reports any real fault.
        this.bytes = 0;
        return;
      }
    }
    if (this.bytes < this.maxBytes) return;
    await rename(this.path, `${this.path}.1`);
    this.bytes = 0;
  }
}

// How much of the tail of the report log the first read takes. Ten entries,
// what the panel asks for, fit in a small fraction of this; the window widens
// only when a larger `limit` is not satisfied by it.
const REPORTS_TAIL_WINDOW_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

// The newest `limit` entries for one analyzer, newest first. The panel opens a
// drawer per analyzer and refreshes after every fire, so this reads and parses
// the tail of the log rather than all of it: the rotation ceiling is 8 MB, and
// parsing that per request to keep ten rows is seconds of blocked event loop on
// a Raspberry Pi. Entries older than the last rotation live in `<log>.1` and
// are deliberately not read here; the panel shows recent history, not the
// archive.
export async function readReportTail(
  logPath: string,
  analyzerId: string,
  limit: number,
): Promise<JsonlEntry[]> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(logPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const out: JsonlEntry[] = [];
    // `end` is where the bytes still unread stop; `carry` is the partial first
    // line of the previous window, which the next window completes. Splitting
    // on the newline byte rather than on decoded text is safe because 0x0A
    // never occurs inside a multi-byte UTF-8 sequence, so a window that opens
    // mid-character only ever cuts the carried line.
    let end = size;
    let carry = Buffer.alloc(0);
    let window = REPORTS_TAIL_WINDOW_BYTES;
    for (;;) {
      const start = Math.max(0, size - window);
      const chunk = Buffer.alloc(end - start);
      if (chunk.length > 0) await handle.read(chunk, 0, chunk.length, start);
      const bytes = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      end = start;
      // Backwards, stopping at `limit`: the newest entries are at the end, and
      // walking from there means the result is already newest-first and no
      // older entry is parsed at all.
      let lineEnd = bytes.length;
      while (lineEnd > 0 && out.length < limit) {
        const newline = bytes.lastIndexOf(NEWLINE, lineEnd - 1);
        // Everything before the first newline of a window that does not reach
        // the start of the file is part of a line the next window completes.
        if (newline < 0 && start > 0) break;
        pushReport(out, bytes.subarray(newline + 1, lineEnd), analyzerId);
        lineEnd = Math.max(0, newline);
      }
      // A window short of `limit` matches for this analyzer widens rather than
      // under-reporting: the other analyzers' rows are interleaved, so a large
      // limit can need more of the log than the first window holds. Only the
      // bytes not yet read are read again.
      if (out.length >= limit || start === 0) return out;
      carry = Buffer.from(bytes.subarray(0, lineEnd));
      window *= 4;
    }
  } finally {
    await handle.close();
  }
}

// Parse one log line and keep it when it belongs to the analyzer. A malformed
// line is skipped so a single corrupt entry does not poison the tail.
function pushReport(out: JsonlEntry[], line: Buffer, analyzerId: string): void {
  if (line.length === 0) return;
  try {
    const entry = JSON.parse(line.toString('utf-8')) as JsonlEntry;
    if (entry.analyzer === analyzerId) out.push(entry);
  } catch {
    // skip malformed lines
  }
}
