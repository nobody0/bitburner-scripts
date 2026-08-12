import type { ArtifactIdentity } from "../run-identity.ts";

/** Telemetry wire schema shared by the game logger, the simulator, and the UI
 * process. One JSONL line per LogRecord on disk; JSON text frames on the wire. */

export const TELEMETRY_PORT = 12526;
export const WIRE_VERSION = 1;

export type Source = "game" | "sim";

interface RecordBase {
  /** Monotonic per emitter; a gap means records were dropped. */
  seq: number;
  /** Game: Date.now(). Sim: virtual-clock milliseconds. */
  t: number;
  run: string;
  src: Source;
}

/** Mirrored result of a state read. Reading state IS logging state: every
 * watched/dodged ns getter emits one of these. Last-write-wins per key. */
export interface StateRecord extends RecordBase {
  kind: "state";
  /** `<getter>` or `<getter>:<argKey>`, e.g. "getPlayer", "getServer:home". */
  key: string;
  data: unknown;
}

export interface EventRecord extends RecordBase {
  kind: "event";
  name: string;
  data?: unknown;
}

export interface DebugRecord extends RecordBase {
  kind: "debug";
  msg: string;
  data?: unknown;
}

export type LogRecord = StateRecord | EventRecord | DebugRecord;

export interface HelloBody {
  /** Emitter/process identity. Records retain this value for sequence gaps. */
  run: string;
  src: Source;
  script: string;
  startedAt: number;
  /** Optional label / git rev for A/B bookkeeping. */
  label?: string;
  /** Install artifact identity. Absent on legacy clients. */
  identity?: ArtifactIdentity;
}

export type WireMessage =
  | { v: typeof WIRE_VERSION; hello: HelloBody }
  | { v: typeof WIRE_VERSION; records: LogRecord[] };

/** Remove planner-authored narration before a value reaches the wire or the
 * legacy-record viewer. Decisions should be explainable from their inputs,
 * rankings, constraints, and outcomes; these fields merely restated those
 * facts as prose. Categorical outcomes such as `reason` remain intact. */
export function factsOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(factsOnly);
  if (value === null || typeof value !== "object") return value;

  const facts: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "why" || key.endsWith("Why") || key === "hold" || key === "warning") continue;
    facts[key] = factsOnly(entry);
  }
  return facts;
}

export function stateKey(getter: string, ...args: readonly (string | number | boolean)[]): string {
  return args.length === 0 ? getter : `${getter}:${args.join(",")}`;
}
