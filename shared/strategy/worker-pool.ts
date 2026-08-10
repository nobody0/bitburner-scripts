/** Pure pooled-worker accounting for the dispatcher.
 *
 * A serve-mode worker is a process with FIXED (kind, threads) that performs
 * many ops over its life. Within one farm regime every batch has identical
 * thread counts (they come from one cached CycleSolution), so batch N+1's ops
 * reuse batch N's workers and exec churn collapses to ~zero. Heap RAM belongs
 * to the WORKER (reserved at spawn, freed on its workerExit completion); job
 * completions merely flip it idle.
 *
 * Reuse rules mirror the op semantics: a hack must land as ONE call, so only
 * a worker with exactly the op's thread count qualifies; grow/weaken are
 * divisible, so an op is composed greedily from idle workers (largest first)
 * plus a freshly allocated remainder. */

export type OpKind = "hack" | "grow" | "weaken";

export interface PoolWorker {
  workerId: number;
  hostname: string;
  kind: OpKind;
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
): { take: PoolWorker[]; missThreads: number } {
  const idle = [...pool.workers.values()]
    .filter((w) => w.kind === kind && !w.busy && !reserved.has(w.workerId))
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
