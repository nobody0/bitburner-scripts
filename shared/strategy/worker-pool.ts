/** Pure pooled-worker accounting for the dispatcher.
 *
 * A serve-mode worker is a process with FIXED (kind, threads) that performs
 * many ops over its life. A cached CycleSolution keeps hack counts stable;
 * landing-state correction may resize grow/weaken support, so those workers
 * are reused when their block sizes happen to compose the corrected request.
 * Heap RAM belongs
 * to the WORKER (reserved at spawn, freed on its workerExit completion); job
 * completions merely flip it idle.
 *
 * Reuse rules mirror dispatcher placement: a hack must land as ONE call, so
 * only a worker with exactly the op's thread count qualifies; grow/weaken may
 * be emitted as several calls, so an op is composed greedily from idle workers
 * (largest first) plus a freshly allocated remainder. Grow calls are not
 * algebraically interchangeable with one combined call because upstream adds
 * $1 per thread inside each individual call; prediction therefore folds every
 * block separately.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/formulas/grow.ts#L36-L57 */

export type OpKind = "hack" | "grow" | "weaken";
/** JIT weakens have distinct capacity envelopes even though they run the same
 * Netscript call. Keeping the role on a resident worker prevents an idle W1
 * process from being double-counted as reusable W2 capacity (and vice versa). */
export type PoolRole = "h" | "w1" | "g" | "w2";

export interface PoolWorker {
  workerId: number;
  hostname: string;
  kind: OpKind;
  /** Present for workers owned by the proper JIT pipeline. Eager batches have
   * no role and continue to share workers by operation kind alone. */
  role?: PoolRole;
  threads: number;
  /** Core-adjusted one-core-equivalent threads (what the block was worth when
   * allocated; hack equals `threads`). */
  effectThreads: number;
  gb: number;
  busy: boolean;
  idleSince: number;
}

export interface WorkerPoolMemory {
  workers: Map<number, PoolWorker>;
}

export function initPool(): WorkerPoolMemory {
  return { workers: new Map() };
}

/** Idle workers of `kind` that can compose an op of `threads`. Exact-match
 * only for hack; greedy largest-first for the divisible kinds. Read-only —
 * the caller commits with `noteJobStart` once the whole batch is placeable. */
export function planTake(
  pool: WorkerPoolMemory,
  kind: OpKind,
  threads: number,
  /** Workers already claimed by another op in the same atomic batch plan. */
  reserved: ReadonlySet<number> = new Set(),
  /** When supplied, only resident workers from this JIT role are reusable. */
  role?: PoolRole,
): { take: PoolWorker[]; missThreads: number } {
  const idle = [...pool.workers.values()]
    .filter((w) => w.kind === kind && w.role === role && !w.busy && !reserved.has(w.workerId))
    .sort((a, b) => b.threads - a.threads);
  if (kind === "hack") {
    const exact = idle.find((w) => w.threads === threads);
    return exact ? { take: [exact], missThreads: 0 } : { take: [], missThreads: threads };
  }
  const take: PoolWorker[] = [];
  let remaining = threads;
  for (const worker of idle) {
    if (worker.threads > remaining) continue;
    take.push(worker);
    remaining -= worker.threads;
    if (remaining < 1) break;
  }
  return { take, missThreads: remaining >= 1 ? remaining : 0 };
}

export function noteSpawn(
  pool: WorkerPoolMemory,
  worker: Omit<PoolWorker, "busy" | "idleSince">,
  now: number,
): PoolWorker {
  const entry: PoolWorker = { ...worker, busy: true, idleSince: now };
  pool.workers.set(entry.workerId, entry);
  return entry;
}

export function noteJobStart(pool: WorkerPoolMemory, workerId: number): void {
  const worker = pool.workers.get(workerId);
  if (worker) worker.busy = true;
}

export function noteJobDone(pool: WorkerPoolMemory, workerId: number, now: number): void {
  const worker = pool.workers.get(workerId);
  if (!worker) return;
  worker.busy = false;
  worker.idleSince = now;
}

/** The worker's process ended — caller frees its heap reservation. */
export function noteExit(pool: WorkerPoolMemory, workerId: number): PoolWorker | undefined {
  const worker = pool.workers.get(workerId);
  pool.workers.delete(workerId);
  return worker;
}
