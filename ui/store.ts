import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { HelloBody, LogRecord, StateRecord } from "../shared/telemetry/schema.ts";

const RING_SIZE = 10_000;

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

  append(records: LogRecord[]): void {
    for (const record of records) {
      this.#writer.write(JSON.stringify(record) + "\n");
      this.recordCount++;
      this.lastT = record.t;
      if (record.kind === "state") this.state.set(record.key, record);
      this.ring.push(record);
      if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    }
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
