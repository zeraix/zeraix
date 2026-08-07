/**
 * The file-backed audit sink. Node only.
 *
 * Split from `audit-log.ts` because that module is imported by the renderer, and a top-level `node:fs`
 * import would break the client bundle for every consumer of the types. Import this one only from code that
 * is definitely running in the main process or a script.
 *
 * See the tamper-resistance note at the top of `audit-log.ts`: append-only is a property of the interface,
 * not of the file, and the controls that make the record survive a hostile agent are outside this process.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  SYSTEM_CLOCK,
  matches,
  type AuditClock,
  type AuditEvent,
  type AuditQuery,
  type AuditRecord,
  type AuditSink,
} from "./audit-log";

/**
 * JSON Lines sink. One record per line, appended, never rewritten.
 *
 * Writes are serialized through a promise chain because concurrent `appendFile` calls on the same path can
 * interleave partial lines and leave the file unparseable — and a log that corrupts under exactly the
 * conditions it exists to document (several sub-agents running at once) is not a log. The chain also makes
 * `seq` a true ordering rather than a hint.
 */
export class JsonlAuditLog implements AuditSink {
  private tail: Promise<void> = Promise.resolve();
  private seq: number | null = null;
  private readonly filePath: string;
  private readonly clock: AuditClock;

  constructor(filePath: string, clock: AuditClock = SYSTEM_CLOCK) {
    this.filePath = filePath;
    this.clock = clock;
  }

  append(event: AuditEvent): Promise<void> {
    // Capture the write's position in line before awaiting anything, so callers that fire several appends
    // without awaiting still land in call order.
    const done = this.tail.then(async () => {
      if (this.seq === null) this.seq = await this.lastSeq();
      const record = { ...event, seq: ++this.seq, at: this.clock.now() } as AuditRecord;
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    });
    // Keep the chain alive after a failed write: one unwritable record must not silently stop every
    // subsequent one from being attempted.
    this.tail = done.catch(() => {});
    return done;
  }

  async query(filter: AuditQuery = {}): Promise<AuditRecord[]> {
    // Ordering matters here: a query issued mid-flight should see the appends that were already queued.
    await this.tail;
    return (await this.readAll()).filter((r) => matches(r, filter));
  }

  private async readAll(): Promise<AuditRecord[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: AuditRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditRecord);
      } catch {
        // A torn final line (process killed mid-write) must not make the whole history unreadable.
        continue;
      }
    }
    return out;
  }

  private async lastSeq(): Promise<number> {
    const records = await this.readAll();
    return records.length === 0 ? 0 : Math.max(...records.map((r) => r.seq));
  }
}
