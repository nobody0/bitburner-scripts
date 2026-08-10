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
  /** "serve": a POOLED worker. Fixed kind and threads for the process's life;
   *  jobs arrive through `worker_jobs` (target may vary), the loop parks on a
   *  `worker_wake` resolver raced against an idle timeout, and exit reports a
   *  `workerExit` completion so the dispatcher frees the reservation. The id
   *  in `ns.args[0]` is then a WORKER id (same counter as opIds, so the two
   *  spaces can never collide). Absent/undefined = the classic one-shot. */
  mode?: "serve";
}

export interface WorkerJob {
  opId: number;
  target: string;
  additionalMsec?: number;
  stock?: boolean;
}

export interface WorkerDone {
  opId: number;
  kind: "hack" | "grow" | "weaken" | "workerExit";
  target: string;
  threads: number;
  result?: number;
}

export interface WorkerGlobals {
  /** opId (or serve-worker id) -> what that worker should do. */
  worker_info?: Map<number, WorkerInfo & { threads: number }>;
  /** workerId -> queued jobs for that serve worker. The dispatcher pushes the
   *  first job BEFORE exec, so a fresh serve worker can never observe an
   *  empty queue at boot. */
  worker_jobs?: Map<number, WorkerJob[]>;
  /** workerId -> resolver parking that serve worker's idle race. */
  worker_wake?: Map<number, () => void>;
  /** Completions waiting for the next dispatcher pump. */
  dispatch_done?: WorkerDone[];
  /** Poked by a finishing worker so the controller can wake early. */
  dispatch_wake?: () => void;
}

export type WorkerGlobalThis = typeof globalThis & WorkerGlobals;

export function workerGlobals(): WorkerGlobalThis {
  const g = globalThis as WorkerGlobalThis;
  g.worker_info ??= new Map();
  g.worker_jobs ??= new Map();
  g.worker_wake ??= new Map();
  g.dispatch_done ??= [];
  return g;
}
