/** Rendezvous between the dispatcher and its puppet workers (same JS realm,
 * same trick as dodge-shared.ts). Type-only module: nothing exists at runtime.
 *
 * The descriptor is written BEFORE ns.exec, so a worker can never observe a
 * missing entry; the worker registers ns.atExit before awaiting its op, so
 * every engine cleanup path (completion, kill, error) reports back and frees
 * RAM.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/killWorkerScript.ts#L63-L91 */

export interface WorkerInfo {
  kind: "hack" | "grow" | "weaken" | "share";
  target: string;
  /** Live process id, filled by the driver immediately after a successful
   * exec. Broker preemption uses the pid overload so the simulator and game
   * follow the same kill path. */
  pid?: number;
  additionalMsec?: number;
  /** Absolute wall-clock deadline for the padding portion of an HGW call.
   * The worker converts this to `additionalMsec` immediately before invoking
   * Netscript, removing the time spent planning, execing, and loading main().
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L537-L561 */
  delayUntil?: number;
  /** Pass `{stock: true}`, so this op moves the target organization's share
   *  price. Set by the dispatcher on grows for a long position and hacks for a
   *  short, never both — see shared/strategy/dispatch.ts#launchBatches.
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/PlayerInfluencing.ts#L17-L60 */
  stock?: boolean;
  /** Fractional thread strength for a ONE-SHOT worker's single op. Named apart
   * from `threads` (which the exec'd descriptor carries as the spawned count,
   * and which `WorkerDone` reports) so the two can never be confused: RAM is
   * billed on the spawn count, effects land on this one. Serve-mode workers
   * carry the equivalent per job, on `WorkerJob.threads`. */
  strengthThreads?: number;
  /** "serve": a POOLED worker. Fixed kind and threads for the process's life;
   *  jobs arrive through `worker_jobs` (target may vary), the loop parks on a
   *  `worker_wake` resolver raced against an idle timeout, and exit reports a
   *  `workerExit` completion so the dispatcher frees the reservation. The id
   *  in `ns.args[0]` is then a WORKER id (same counter as opIds, so the two
   *  spaces can never collide). Absent/undefined = the classic one-shot. */
  mode?: "serve" | "share";
}

export interface WorkerJob {
  opId: number;
  target: string;
  additionalMsec?: number;
  delayUntil?: number;
  stock?: boolean;
  /** Fractional REAL thread strength for this job, passed straight through as
   * `opts.threads`. Absent = act at the process's full spawned count. The
   * dispatcher has already divided by the host's core bonus, so the worker
   * never needs to know its own core count. Must be <= the spawned count: the
   * engine throws otherwise, which would lose the op. */
  threads?: number;
}

export interface WorkerDone {
  opId: number;
  kind: "hack" | "grow" | "weaken" | "workerExit";
  target: string;
  /** Thread strength the op actually RAN at, not the process's spawned count.
   * The game awards experience and applies security fortify on the fractional
   * value, so reporting the spawn size here would over-report both — and
   * `expEarned` feeds the exp-rate EMA which the landing-skill projection
   * reads, closing a feedback loop. `workerExit` reports the spawned count,
   * which is what the RAM reservation was sized on. */
  threads: number;
  /** performance.now() when the op settled — the same clock the dispatcher
   * plans landings on, so planned-minus-observed is a real landing error. */
  at?: number;
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
  /** share-worker id -> resolver racing the current 10-second ns.share slice. */
  worker_stop?: Map<number, () => void>;
  /** Stop requested before the fresh worker installed its resolver. */
  worker_stop_requested?: Set<number>;
  /** Completions waiting for the next dispatcher pump. */
  dispatch_done?: WorkerDone[];
  /** Poked by a finishing worker so the controller can wake early. */
  dispatch_wake?: () => void;
  /** A wake which fired while the controller was between `armWake` calls.
   * Latching it is essential: losing a weaken completion loses the only
   * guaranteed minimum-security observation window. */
  dispatch_wake_pending?: boolean;
  /** One earliest-deadline timer for pending JIT work. */
  dispatch_jit_timer?: ReturnType<typeof setTimeout>;
  dispatch_jit_at?: number;
  /** Realm-wide trailing-edge debounce for weaken completions. Spread weakens
   * can finish a few milliseconds apart; the final callback is the one that
   * proves every fragment has restored minimum security. */
  dispatch_weaken_timer?: ReturnType<typeof setTimeout>;
}

export type WorkerGlobalThis = typeof globalThis & WorkerGlobals;

export function workerGlobals(): WorkerGlobalThis {
  const g = globalThis as WorkerGlobalThis;
  g.worker_info ??= new Map();
  g.worker_jobs ??= new Map();
  g.worker_wake ??= new Map();
  g.worker_stop ??= new Map();
  g.worker_stop_requested ??= new Set();
  g.dispatch_done ??= [];
  return g;
}
