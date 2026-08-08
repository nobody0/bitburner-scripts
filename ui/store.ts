import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { HelloBody, LogRecord, StateRecord } from "../shared/telemetry/schema.ts";

const RING_SIZE = 10_000;
/** Bytes of serialized tail a viewer is worth sending on connect.
 *
 * A record count alone is the wrong bound: state payloads vary by three orders
 * of magnitude, so 1,000 records can be 40 KB or 100 MB depending on which
 * topics happened to be dirty. The snapshot is JSON the browser must parse
 * before its first paint, so it is bounded in the unit that actually costs
 * something. */
const TAIL_BYTES = 2_000_000;

export interface RunSummary {
  id: string;
  file: string;
  hello: HelloBody;
  records: number;
  lastT: number;
  live: boolean;
}

/** One emitter run (game script or sim): JSONL persistence, a tail ring for
 * late-joining viewers, and last-write-wins state reduction. The file is
 * opened in APPEND mode and keyed by the run id, so a telemetry client that
 * reconnects (same hello.run) keeps writing to the same file instead of
 * truncating it. */
export class RunStore {
  readonly id: string;
  readonly file: string;
  readonly hello: HelloBody;
  readonly state = new Map<string, StateRecord>();
  readonly ring: LogRecord[] = [];
  recordCount = 0;
  lastT = 0;
  live = true;
  closedAt: number | undefined;
  #writer: WriteStream;

  constructor(dir: string, hello: HelloBody) {
    this.hello = hello;
    this.id = hello.run;
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${hello.startedAt}-${hello.src}-${hello.run}.jsonl`);
    this.#writer = createWriteStream(this.file, { flags: "a" });
  }

  /** A client reconnected with the same run id. */
  reattach(): void {
    if (!this.live) {
      this.#writer = createWriteStream(this.file, { flags: "a" });
      this.live = true;
      this.closedAt = undefined;
    }
  }

  /** Serialized size of `ring[i]`, so the tail can be bounded in bytes without
   *  re-stringifying the whole ring on every viewer connect. */
  readonly #ringBytes: number[] = [];

  append(records: LogRecord[]): void {
    for (const record of records) {
      const line = JSON.stringify(record);
      this.#writer.write(line + "\n");
      this.recordCount++;
      this.lastT = record.t;
      if (record.kind === "state") this.state.set(record.key, record);
      this.ring.push(record);
      this.#ringBytes.push(line.length);
      if (this.ring.length > RING_SIZE) {
        const drop = this.ring.length - RING_SIZE;
        this.ring.splice(0, drop);
        this.#ringBytes.splice(0, drop);
      }
    }
  }

  /** Newest records that fit in `maxBytes`, oldest first. Always yields at
   *  least one record when the ring is non-empty: a single oversized record is
   *  still better than an empty feed, and the size test keeps that rare. */
  tail(maxBytes = TAIL_BYTES): LogRecord[] {
    let start = this.ring.length;
    let bytes = 0;
    while (start > 0) {
      bytes += this.#ringBytes[start - 1] ?? 0;
      if (bytes > maxBytes && start < this.ring.length) break;
      start--;
    }
    return this.ring.slice(start);
  }

  close(): void {
    this.live = false;
    this.closedAt = Date.now();
    this.#writer.end();
  }

  summary(): RunSummary {
    return {
      id: this.id,
      file: this.file,
      hello: this.hello,
      records: this.recordCount,
      lastT: this.lastT,
      live: this.live,
    };
  }
}
