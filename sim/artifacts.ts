import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realEpochMs } from "./clock.ts";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import type { ArtifactMetadata } from "../shared/run-catalog.ts";
import type { ExperimentIdentity } from "../shared/experiment.ts";
import {
  bitNodeRunId,
  installRunId,
  shortIdentity,
  type ArtifactIdentity,
  type LineageIdentity,
} from "../shared/run-identity.ts";

export interface SimSessionOptions {
  outDir: string;
  label?: string;
  seed: number;
  bitNode?: number;
  seededFrom?: string;
  experiment?: ExperimentIdentity;
  createdAt?: number;
}

export interface SimSessionManifest {
  version: 2;
  identity: LineageIdentity;
  seed: number;
  bitNode?: number;
  experiment?: ExperimentIdentity;
  scenarioFingerprint?: string;
  result?: {
    reached: boolean;
    timeToGoalMs: number;
    validity: string;
    stoppedBecause: string;
  };
  artifacts: string[];
}

/** A speedrun checkpoint may only descend from a completed, fully valid route
 * leg with complete experimental identity. Feature scenarios and diagnostic
 * runs are useful evidence but can never become route state. */
export function assertPromotableSession(manifest: SimSessionManifest): void {
  if (manifest.experiment?.class !== "bitnode-route") {
    throw new Error("only bitnode-route sessions can be promoted");
  }
  if (!manifest.scenarioFingerprint) throw new Error("route session has no scenario fingerprint");
  if (!manifest.result?.reached || manifest.result.validity !== "valid") {
    throw new Error("route session did not reach its goal with valid fidelity");
  }
}

function uuid(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
}

function safe(value: string): string {
  return value.replaceAll(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
}

/** Write a sidecar the way a reader may find it at any instant: to a temporary
 * and rename, so a process killed mid-write leaves the previous complete
 * version rather than a truncated one. */
function writeSidecar(metadata: ArtifactMetadata, file: string): void {
  try {
    metadata.size = statSync(file).size;
  } catch {
    /* the sink has not created it yet; the recorded size stays as it was */
  }
  const target = `${file}.meta.json`;
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(metadata, null, 2) + "\n");
  renameSync(temporary, target);
}

/** Streaming per-install writer. Rotation happens after sim.prestige, leaving
 * the causal event as the final row of the install it ended. */
export class SimArtifactSession {
  readonly identity: LineageIdentity;
  readonly manifestFile: string;
  /** Sync-appended NDJSON heartbeat: what an operator or an agent reads to see
   * a run that has not finished yet. See {@link note}. */
  readonly progressFile: string;
  readonly files: string[] = [];
  #options: SimSessionOptions;
  #nodeId: string | undefined;
  #installIndex = 0;
  #writer: ReturnType<ReturnType<typeof Bun.file>["writer"]> | undefined;
  #file = "";
  #metadata: ArtifactMetadata | undefined;
  #rotate = false;
  #nextInstallStartedAt: number | undefined;
  #finalizations: Promise<void>[] = [];
  #scenarioFingerprint: string | undefined;
  #result: SimSessionManifest["result"];
  #closing: Promise<void> | undefined;

  constructor(options: SimSessionOptions) {
    this.#options = options;
    const createdAt = options.createdAt ?? realEpochMs();
    const id = uuid();
    this.identity = {
      id,
      kind: "sim",
      label: options.label ?? `sim session ${shortIdentity(id)}`,
      createdAt,
      ...(options.seededFrom ? { seededFrom: options.seededFrom } : {}),
    };
    this.#nodeId = options.bitNode === undefined ? undefined : bitNodeRunId(id, 0);
    mkdirSync(options.outDir, { recursive: true });
    const stem = path.join(
      options.outDir,
      `${createdAt}-sim-${safe(this.identity.label)}-seed${options.seed}-${safe(shortIdentity(id))}`,
    );
    this.manifestFile = `${stem}.session.json`;
    this.progressFile = `${stem}.progress.ndjson`;
    this.note({
      phase: "start",
      label: this.identity.label,
      seed: options.seed,
      ...(options.bitNode !== undefined ? { bitNode: options.bitNode } : {}),
      pid: globalThis.process?.pid,
    });
  }

  /** Timestamps here go through `realEpochMs`, never the global `Date.now`:
   * records are written from inside an installed realm, where `Date.now` is
   * the run's VIRTUAL clock. Sidecars used to claim they were last updated in
   * January 2024 because of it. */
  write(line: string): void {
    // A session that is closing (a signal handler, say) must not accept more
    // records: the writer is gone, so the next record would open a FRESH
    // install artifact and add it to a manifest that has already been written.
    if (this.#closing) return;
    const record = JSON.parse(line) as LogRecord;
    if (this.#rotate) {
      this.#installIndex++;
      this.#open(this.#nextInstallStartedAt ?? record.t);
      this.#rotate = false;
      this.#nextInstallStartedAt = undefined;
    }
    if (!this.#writer) this.#open(record.t);
    this.#writer!.write(line + "\n");
    const meta = this.#metadata!;
    meta.records++;
    meta.firstT ??= record.t;
    meta.lastT = meta.lastT === null ? record.t : Math.max(meta.lastT, record.t);
    meta.updatedAt = realEpochMs();
    if (record.kind === "event" && record.name === "sim.prestige") {
      this.#rotate = true;
      // The reset epoch is the prestige itself, even if the next emitted state
      // record arrives later in virtual time.
      this.#nextInstallStartedAt = record.t;
    }
    if (record.kind === "event" && record.name === "sim.meta") {
      const fingerprint = (record.data as { scenarioFingerprint?: unknown } | undefined)?.scenarioFingerprint;
      if (typeof fingerprint === "string") this.#scenarioFingerprint = fingerprint;
    }
    if (record.kind === "event" && record.name === "sim.result") {
      const data = record.data as Partial<NonNullable<SimSessionManifest["result"]>> | undefined;
      // `Infinity` does not survive JSON. A run that did not reach its goal
      // reports `timeToGoalMs: Infinity`, which arrives here as `null`, and
      // requiring a number dropped the ENTIRE result — so every horizon-,
      // budget- and memory-stopped session wrote a manifest carrying no
      // verdict at all (49 of the last 60 in runs/), which is precisely the
      // class of run whose verdict someone goes looking for.
      const timeToGoalMs = typeof data?.timeToGoalMs === "number"
        ? data.timeToGoalMs
        : data?.timeToGoalMs === null ? Infinity : undefined;
      if (
        typeof data?.reached === "boolean"
        && timeToGoalMs !== undefined
        && typeof data.validity === "string"
        && typeof data.stoppedBecause === "string"
      ) {
        this.#result = {
          reached: data.reached,
          timeToGoalMs,
          validity: data.validity,
          stoppedBecause: data.stoppedBecause,
        };
      }
    }
  }

  /** Append one heartbeat line. Synchronous and unbuffered on purpose: this is
   * the stream that has to be readable while the run is still going, and every
   * buffered channel this harness owns is exactly what made a 45-minute run
   * look identical to a hung one. It is never worth failing a run for, so a
   * failed append is swallowed. */
  note(event: Record<string, unknown>): void {
    try {
      appendFileSync(this.progressFile, JSON.stringify({ at: realEpochMs(), ...event }) + "\n");
    } catch {
      /* progress is diagnostic; a full disk must not take the run with it */
    }
  }

  /** Persist everything a reader needs WITHOUT ending the run.
   *
   * `close()` used to be the only durable write in the session's life, and a
   * run that is SIGKILLed by a watchdog or segfaults Bun never reaches it —
   * which is how the runs that most needed their evidence lost all of it.
   * Neither death can be caught, so the manifest and the open artifact's
   * sidecar are written as the run goes and the last checkpoint is what
   * survives. Cheap enough to call on the heartbeat cadence: the manifest is a
   * few hundred bytes and the sidecar a couple of thousand. */
  checkpoint(): void {
    if (this.#closing) return;
    if (this.#writer && this.#metadata) {
      // Best effort: the sink's flush may complete asynchronously, so the
      // recorded size can lag by one buffer. A reader that parses JSONL line
      // by line tolerates a short tail; one that trusted an over-reported size
      // would not, which is why the size is read back from the file.
      // `FileSink.flush` may answer with a PROMISE, so a bare try/catch would
      // let a failed flush escape as an unhandled rejection and take down the
      // very run the checkpoint exists to preserve evidence for.
      try {
        void Promise.resolve(this.#writer.flush()).catch(() => {});
      } catch { /* a sink already ending */ }
      writeSidecar(this.#metadata, this.#file);
    }
    this.#writeManifest();
  }

  /** The manifest as it stands. Exposed so a caller can put it through
   * `assertPromotableSession` BEFORE `close()`, while the run's own result and
   * fingerprint are already recorded. `artifacts` is the session's record
   * streams and nothing else — sim/compare.ts resolves every entry against
   * this directory and parses it as JSONL. */
  manifest(): SimSessionManifest {
    return {
      version: 2,
      identity: this.identity,
      seed: this.#options.seed,
      ...(this.#options.bitNode !== undefined ? { bitNode: this.#options.bitNode } : {}),
      ...(this.#options.experiment !== undefined ? { experiment: this.#options.experiment } : {}),
      ...(this.#scenarioFingerprint !== undefined ? { scenarioFingerprint: this.#scenarioFingerprint } : {}),
      ...(this.#result !== undefined ? { result: this.#result } : {}),
      artifacts: this.files.map((file) => path.basename(file)),
    };
  }

  /** Idempotent, and returns the same promise to every caller: a signal
   * handler and the normal path can both close the session, and the handler
   * must wait for the finalizations the normal path already started rather
   * than racing them to `process.exit`. */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#finishArtifact();
    await Promise.all(this.#finalizations);
    this.#writeManifest();
    this.note({ phase: "done", ...(this.#result ?? { reached: false, stoppedBecause: "unwritten" }) });
  }

  #writeManifest(): void {
    const temporary = `${this.manifestFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.manifest(), null, 2) + "\n");
    renameSync(temporary, this.manifestFile);
  }

  #open(startedAt: number): void {
    this.#finishArtifact();
    const installId = installRunId(this.#nodeId, this.identity.id, startedAt);
    const artifact: ArtifactIdentity = {
      lineage: this.identity,
      ...(this.#options.bitNode !== undefined && this.#nodeId
        ? { bitNode: { id: this.#nodeId, bitNode: this.#options.bitNode, startedAt: 0 } }
        : {}),
      install: { id: installId, startedAt, index: this.#installIndex },
    };
    this.#file = path.join(
      this.#options.outDir,
      `${this.identity.createdAt}-sim-${safe(this.identity.label)}-seed${this.#options.seed}-install${this.#installIndex + 1}-${safe(shortIdentity(this.identity.id))}.jsonl`,
    );
    this.files.push(this.#file);
    this.#writer = Bun.file(this.#file).writer();
    this.#metadata = {
      version: 1,
      file: path.basename(this.#file),
      identity: artifact,
      hello: {
        run: this.identity.id,
        src: "sim",
        script: "sim/run.ts",
        startedAt: this.identity.createdAt,
        label: this.identity.label,
        identity: artifact,
      },
      emitters: [this.identity.id],
      records: 0,
      firstT: null,
      lastT: null,
      createdAt: this.identity.createdAt,
      updatedAt: realEpochMs(),
      live: false,
      pinned: false,
      size: 0,
    };
    // A rotation is a durability point of its own: the install that just ended
    // is complete on disk, and the manifest should say so before the next one
    // starts accumulating.
    this.#writeManifest();
  }

  #finishArtifact(): void {
    if (!this.#writer || !this.#metadata || !this.#file) return;
    const writer = this.#writer;
    const metadata = this.#metadata;
    const file = this.#file;
    this.#writer = undefined;
    this.#metadata = undefined;
    this.#file = "";
    this.#finalizations.push(Promise.resolve(writer.end()).then(() => {
      writeSidecar(metadata, file);
    }));
  }
}
