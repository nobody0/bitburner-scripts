import { createWriteStream, mkdirSync, renameSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { HelloBody, LogRecord, StateRecord } from "../shared/telemetry/schema.ts";
import type { ArtifactMetadata } from "../shared/run-catalog.ts";

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
  metadata: ArtifactMetadata;
}

function safeName(value: string): string {
  return value.replaceAll(/[^a-z0-9._-]+/gi, "_").slice(-120);
}

/** One install artifact, potentially fed by several emitter processes: JSONL
 * persistence, a tail ring for late-joining viewers, and last-write-wins state
 * reduction. The file is opened in append mode and keyed by install identity,
 * so process handoffs and reconnects keep writing to the same file. */
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
  #attachments = 0;
  #lastSeq = new Map<string, number>();
  #firstT: number | null = null;
  #emitters = new Set<string>();
  #metaFile: string;
  #createdAt = Date.now();

  constructor(dir: string, hello: HelloBody, resume?: ArtifactMetadata) {
    this.hello = hello;
    this.id = hello.identity?.install.id ?? hello.run;
    mkdirSync(dir, { recursive: true });
    this.file = resume
      ? path.join(dir, path.basename(resume.file))
      : path.join(dir, `${hello.startedAt}-${hello.src}-${safeName(this.id)}.jsonl`);
    this.#metaFile = `${this.file}.meta.json`;
    if (resume) {
      this.recordCount = resume.records;
      this.#firstT = resume.firstT;
      this.lastT = resume.lastT ?? 0;
      this.#createdAt = resume.createdAt;
      for (const emitter of resume.emitters) this.#emitters.add(emitter);
    }
    this.#writer = createWriteStream(this.file, { flags: "a" });
    this.attach(hello);
  }

  /** An emitter attached to this install artifact. */
  attach(hello: HelloBody): void {
    this.#attachments++;
    this.#emitters.add(hello.run);
    if (!this.live) {
      this.#writer = createWriteStream(this.file, { flags: "a" });
      this.live = true;
      this.closedAt = undefined;
    }
    this.#writeMetadata();
  }

  /** Serialized size of `ring[i]`, so the tail can be bounded in bytes without
   *  re-stringifying the whole ring on every viewer connect. */
  readonly #ringBytes: number[] = [];

  append(records: LogRecord[]): LogRecord[] {
    const accepted: LogRecord[] = [];
    for (const record of records) {
      const previousSeq = this.#lastSeq.get(record.run);
      if (previousSeq !== undefined && record.seq <= previousSeq) continue;
      this.#lastSeq.set(record.run, record.seq);
      accepted.push(record);
      const line = JSON.stringify(record);
      this.#writer.write(line + "\n");
      this.recordCount++;
      if (this.#firstT === null || record.t < this.#firstT) this.#firstT = record.t;
      if (record.t > this.lastT) this.lastT = record.t;
      if (record.kind === "state") this.state.set(record.key, record);
      this.ring.push(record);
      this.#ringBytes.push(line.length);
      if (this.ring.length > RING_SIZE) {
        const drop = this.ring.length - RING_SIZE;
        this.ring.splice(0, drop);
        this.#ringBytes.splice(0, drop);
      }
    }
    this.#writeMetadata();
    return accepted;
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

  detach(): Promise<void> | undefined {
    this.#attachments = Math.max(0, this.#attachments - 1);
    if (this.#attachments > 0) return;
    this.live = false;
    this.closedAt = Date.now();
    const closed = new Promise<void>((resolve, reject) => {
      this.#writer.once("close", resolve);
      this.#writer.once("error", reject);
    });
    this.#writer.end();
    return closed.then(() => this.#writeMetadata());
  }

  metadata(relativeFile = path.basename(this.file), pinned = false): ArtifactMetadata {
    let size = 0;
    try { size = statSync(this.file).size; } catch { /* writer may not have created it yet */ }
    return {
      version: 1,
      file: relativeFile,
      ...(this.hello.identity ? { identity: this.hello.identity } : {}),
      hello: this.hello,
      emitters: [...this.#emitters],
      records: this.recordCount,
      firstT: this.#firstT,
      lastT: this.#firstT === null ? null : this.lastT,
      createdAt: this.#createdAt,
      updatedAt: Date.now(),
      live: this.live,
      pinned,
      size,
    };
  }

  #writeMetadata(): void {
    const temporary = `${this.#metaFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.metadata(), null, 2) + "\n");
    renameSync(temporary, this.#metaFile);
  }

  summary(): RunSummary {
    return {
      id: this.id,
      file: this.file,
      hello: this.hello,
      records: this.recordCount,
      lastT: this.lastT,
      live: this.live,
      metadata: this.metadata(),
    };
  }
}
