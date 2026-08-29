import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
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

/** Streaming per-install writer. Rotation happens after sim.prestige, leaving
 * the causal event as the final row of the install it ended. */
export class SimArtifactSession {
  readonly identity: LineageIdentity;
  readonly manifestFile: string;
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

  constructor(options: SimSessionOptions) {
    this.#options = options;
    const createdAt = options.createdAt ?? Date.now();
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
    this.manifestFile = path.join(
      options.outDir,
      `${createdAt}-sim-${safe(this.identity.label)}-seed${options.seed}-${safe(shortIdentity(id))}.session.json`,
    );
  }

  write(line: string): void {
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
    meta.updatedAt = Date.now();
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
      if (
        typeof data?.reached === "boolean"
        && typeof data.timeToGoalMs === "number"
        && typeof data.validity === "string"
        && typeof data.stoppedBecause === "string"
      ) {
        this.#result = {
          reached: data.reached,
          timeToGoalMs: data.timeToGoalMs,
          validity: data.validity,
          stoppedBecause: data.stoppedBecause,
        };
      }
    }
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

  async close(): Promise<void> {
    this.#finishArtifact();
    await Promise.all(this.#finalizations);
    writeFileSync(this.manifestFile, JSON.stringify(this.manifest(), null, 2) + "\n");
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
      updatedAt: Date.now(),
      live: false,
      pinned: false,
      size: 0,
    };
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
      metadata.size = statSync(file).size;
      const target = `${file}.meta.json`;
      const temporary = `${target}.tmp`;
      writeFileSync(temporary, JSON.stringify(metadata, null, 2) + "\n");
      renameSync(temporary, target);
    }));
  }
}
