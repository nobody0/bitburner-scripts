import type { NS } from "@ns";

/** Rendezvous between the dispatcher and its puppet workers (same JS realm,
 * same trick as dodge-shared.ts). Type-only module: nothing exists at runtime.
 *
 * The descriptor is written BEFORE ns.exec, so a worker can never observe a
 * missing entry; the worker registers ns.atExit before awaiting its op, so
 * every exit path (completion, kill, error) reports back and frees RAM. */

export interface WorkerInfo {
  kind: "hack" | "grow" | "weaken";
  target: string;
  additionalMsec?: number;
  /** Pass `{stock: true}`, so this op moves the target organization's share
   *  price. Set by the dispatcher on grows for a long position and hacks for a
   *  short, never both — see shared/strategy/dispatch.ts#launchBatches. */
  stock?: boolean;
}

export interface WorkerDone {
  opId: number;
  kind: "hack" | "grow" | "weaken";
  target: string;
  threads: number;
  result?: number;
}

export interface WorkerGlobals {
  /** opId -> what that worker should do. */
  worker_info?: Map<number, WorkerInfo & { threads: number }>;
  /** Completions waiting for the next dispatcher pump. */
  dispatch_done?: WorkerDone[];
  /** Poked by a finishing worker so the controller can wake early. */
  dispatch_wake?: () => void;
}

export type WorkerGlobalThis = typeof globalThis & WorkerGlobals;

export function workerGlobals(): WorkerGlobalThis {
  const g = globalThis as WorkerGlobalThis;
  g.worker_info ??= new Map();
  g.dispatch_done ??= [];
  return g;
}

/** ns type re-export so the worker bundle stays import-light. */
export type WorkerNS = NS;
