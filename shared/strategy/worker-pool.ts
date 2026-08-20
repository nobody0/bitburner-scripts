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
 * Three thread figures, and keeping them apart is the whole design:
 *   threads         INTEGER, what RAM was billed for. Never fractional.
 *   effectThreads   one-core-equivalent strength of that block (the solver's unit).
 *   strengthEffect  the effect ASKED of it on one invocation; <= effectThreads.
 * Only the first may reach the JIT capacity math: role RAM is quantized through
 * `ceil(holdMs / interval)`, so a size that moves can move the batch interval,
 * while a strength that moves costs nothing.
 *
 * Reuse rules mirror dispatcher placement: a hack must land as ONE call, but
 * `opts.threads` is fractional, so that call may be WEAKER than the process —
 * any worker at least the op's size qualifies, chosen best fit. Grow/weaken may
 * be emitted as several calls, so an op is composed greedily from idle workers
 * (largest first) plus a freshly allocated remainder. Grow calls are not
 * algebraically interchangeable with one combined call because upstream adds
 * $1 per thread inside each individual call; prediction therefore folds every
 * block separately.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/formulas/grow.ts#L36-L57 */

import { addGb, drainGb, subGb } from "../tally.ts";

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

/** Idle workers of one (kind, role), grouped by exact thread count.
 *
 * `planTake` used to materialise, filter and sort the WHOLE worker map on every
 * call, once per op launched — O(ops x workers) per pass plus an array
 * allocation each time, and only on the pooled path, which by construction is
 * the one that runs at high process counts (32k observed live, ~400k targeted).
 * The index answers the only two questions the planner asks: an idle worker of
 * exactly N threads (hack, which must land as one call), and idle workers
 * largest-first composing N threads (the divisible kinds).
 *
 * Distinct sizes are far fewer than workers — a role's blocks cluster around
 * the solved thread count — so a descending walk of `sizes` stays short where a
 * walk of workers would not. */
interface IdleBucket {
  /** Thread count -> idle workers of exactly that size, ASCENDING by workerId. */
  bySize: Map<number, PoolWorker[]>;
  /** Distinct sizes present in `bySize`, DESCENDING. Never holds an empty size. */
  sizes: number[];
}

export interface WorkerPoolMemory {
  workers: Map<number, PoolWorker>;
  /** Idle index, keyed by kind and role. Derived state: every entry is a worker
   * in `workers` with `busy === false`, and every such worker appears exactly
   * once. The four note* transitions below are the only ones that move a worker
   * in or out of the idle set, so they are the only places this is maintained. */
  idle: Map<string, IdleBucket>;
  /** SOURCE host -> GB held by resident workers. A worker owns its RAM for its
   * whole process life, so this moves only on spawn and exit — never on a job
   * boundary — which is what lets the dispatcher price a host without walking
   * the pool. */
  gbByHost: Map<string, number>;
  /** JIT role -> GB held by resident workers carrying that role. */
  gbByRole: Record<PoolRole, number>;
}

export function initPool(): WorkerPoolMemory {
  return {
    workers: new Map(),
    idle: new Map(),
    gbByHost: new Map(),
    gbByRole: { h: 0, w1: 0, g: 0, w2: 0 },
  };
}

/** Kind and role are drawn from disjoint closed vocabularies, so a single
 * separator is unambiguous. */
const idleKey = (kind: OpKind, role: PoolRole | undefined): string => `${kind}:${role ?? ""}`;

/** Insert into a DESCENDING array, keeping it sorted. */
function insertSizeDesc(sizes: number[], size: number): void {
  let lo = 0;
  let hi = sizes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sizes[mid]! > size) lo = mid + 1;
    else hi = mid;
  }
  sizes.splice(lo, 0, size);
}

/** Position of `workerId` in a list held ASCENDING by workerId. */
function seek(list: readonly PoolWorker[], workerId: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.workerId < workerId) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Ascending workerId within a size is exactly what the old implementation
 * produced: a STABLE sort by descending threads over `workers.values()`, whose
 * insertion order is spawn order, and workerIds are issued monotonically.
 * Preserving that order is what keeps `planTake`'s choice — and therefore the
 * emitted action stream — unchanged by the introduction of this index. */
function addIdle(pool: WorkerPoolMemory, worker: PoolWorker): void {
  const key = idleKey(worker.kind, worker.role);
  let bucket = pool.idle.get(key);
  if (!bucket) {
    bucket = { bySize: new Map(), sizes: [] };
    pool.idle.set(key, bucket);
  }
  let list = bucket.bySize.get(worker.threads);
  if (!list) {
    list = [];
    bucket.bySize.set(worker.threads, list);
    insertSizeDesc(bucket.sizes, worker.threads);
  }
  list.splice(seek(list, worker.workerId), 0, worker);
}

function removeIdle(pool: WorkerPoolMemory, worker: PoolWorker): void {
  const bucket = pool.idle.get(idleKey(worker.kind, worker.role));
  const list = bucket?.bySize.get(worker.threads);
  if (!bucket || !list) return;
  const at = seek(list, worker.workerId);
  if (list[at] !== worker) return;
  list.splice(at, 1);
  if (list.length > 0) return;
  bucket.bySize.delete(worker.threads);
  const size = bucket.sizes.indexOf(worker.threads);
  if (size >= 0) bucket.sizes.splice(size, 1);
}

/** Best fit over the idle index: the SMALLEST size at least `want`, and within
 * it the lowest workerId.
 *
 * `sizes` is descending, so the qualifying sizes form a prefix and the smallest
 * of them is the last element of that prefix — a binary search for the prefix
 * boundary, not a scan. Which matters: `planTake` runs once per op launched, on
 * the pooled path, which by construction is the one that runs at high process
 * counts, so a linear walk here is a per-op cost in the hottest loop we have.
 *
 * Only the entries whose workers are all spoken for need stepping over, and
 * that is bounded by the reservations in one batch plan rather than by the
 * pool. `strict` asks for a size strictly greater than `want`. */
function smallestAtLeast(
  bucket: IdleBucket | undefined,
  want: number,
  reserved: ReadonlySet<number>,
  claimed?: ReadonlySet<number>,
  strict = false,
): PoolWorker | undefined {
  const sizes = bucket?.sizes;
  if (!sizes || sizes.length === 0) return undefined;
  const qualifies = (size: number): boolean => (strict ? size > want : size >= want);
  // First index that does NOT qualify; the candidate prefix is [0, lo).
  let lo = 0;
  let hi = sizes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (qualifies(sizes[mid]!)) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0; i--) {
    for (const worker of bucket!.bySize.get(sizes[i]!)!) {
      if (reserved.has(worker.workerId) || claimed?.has(worker.workerId)) continue;
      return worker;
    }
  }
  return undefined;
}

/** One reusable worker plus the one-core effect it should actually perform.
 * `strengthEffect` below the worker's own `effectThreads` means the caller must
 * pass a reduced fractional `opts.threads`. */
export interface PoolTake {
  worker: PoolWorker;
  strengthEffect: number;
}

/** Idle workers of `kind` that can compose an op of `threads`. Read-only — the
 * caller commits with `noteJobStart` once the whole batch is placeable.
 *
 * A hack is still ONE call, but that call may now be WEAKER than the process
 * running it, so any worker at least the requested size qualifies. Best fit,
 * not largest-first: spending a big worker on a small hack strands it for the
 * batch that actually needs it, and inflates the RAM charged per op.
 *
 * Grow keeps its greedy largest-first composition and gains a remainder step —
 * an oversized idle worker performing just the remainder beats allocating a
 * fresh block for it.
 *
 * Weaken deliberately gets NEITHER. Over-weakening is free (the effect clamps
 * at minDifficulty) and is precisely the ordering insurance THREAD_WEAKEN_UPSCALE
 * exists to provide, so asking a weaken worker for exactly its computed strength
 * would remove protection in exchange for nothing. */
export function planTake(
  pool: WorkerPoolMemory,
  kind: OpKind,
  threads: number,
  /** Workers already claimed by another op in the same atomic batch plan. */
  reserved: ReadonlySet<number> = new Set(),
  /** When supplied, only resident workers from this JIT role are reusable. */
  role?: PoolRole,
): { take: PoolTake[]; missThreads: number } {
  const bucket = pool.idle.get(idleKey(kind, role));
  /** Effect this worker delivers per REAL thread. Composition below counts in
   * real threads, so a partial take converts back through the same ratio. */
  const ratio = (worker: PoolWorker): number =>
    worker.threads > 0 ? worker.effectThreads / worker.threads : 1;

  if (kind === "hack") {
    const best = smallestAtLeast(bucket, threads, reserved);
    if (best) return { take: [{ worker: best, strengthEffect: threads }], missThreads: 0 };
    return { take: [], missThreads: threads };
  }

  const take: PoolTake[] = [];
  let remaining = threads;
  for (const size of bucket?.sizes ?? []) {
    if (size > remaining) continue;
    for (const worker of bucket!.bySize.get(size)!) {
      if (reserved.has(worker.workerId)) continue;
      // The remainder can fall below this size part-way through the list; the
      // old scan expressed that as its per-worker `threads > remaining` skip.
      if (size > remaining) break;
      take.push({ worker, strengthEffect: worker.effectThreads });
      remaining -= size;
      if (remaining < 1) break;
    }
    if (remaining < 1) break;
  }

  if (kind === "grow" && remaining >= 1) {
    // Smallest idle worker strictly larger than the remainder, run partially.
    // The greedy pass above may already hold a worker of this very size, so
    // exclude what it took — a worker cannot serve two calls of one op.
    const claimed = new Set(take.map((entry) => entry.worker.workerId));
    const best = smallestAtLeast(bucket, remaining, reserved, claimed, true);
    if (best) {
      take.push({ worker: best, strengthEffect: remaining * ratio(best) });
      remaining = 0;
    }
  }

  return { take, missThreads: remaining >= 1 ? remaining : 0 };
}

/** Resident and busy counts for the 1 Hz rollup, without materialising the
 * pool. Idle workers are already grouped, and the group count is bounded by
 * (kind, role) pairs and distinct block sizes rather than by process count. */
export function poolCounts(pool: WorkerPoolMemory): { workers: number; busy: number } {
  let idle = 0;
  for (const bucket of pool.idle.values()) {
    for (const list of bucket.bySize.values()) idle += list.length;
  }
  return { workers: pool.workers.size, busy: pool.workers.size - idle };
}

export function noteSpawn(
  pool: WorkerPoolMemory,
  worker: Omit<PoolWorker, "busy" | "idleSince">,
  now: number,
): PoolWorker {
  const entry: PoolWorker = { ...worker, busy: true, idleSince: now };
  pool.workers.set(entry.workerId, entry);
  addGb(pool.gbByHost, entry.hostname, entry.gb);
  if (entry.role) pool.gbByRole[entry.role] += entry.gb;
  return entry;
}

export function noteJobStart(pool: WorkerPoolMemory, workerId: number): void {
  const worker = pool.workers.get(workerId);
  if (!worker) return;
  if (!worker.busy) removeIdle(pool, worker);
  worker.busy = true;
}

export function noteJobDone(pool: WorkerPoolMemory, workerId: number, now: number): void {
  const worker = pool.workers.get(workerId);
  if (!worker) return;
  const wasBusy = worker.busy;
  worker.busy = false;
  worker.idleSince = now;
  // Only a busy->idle transition adds; a repeated completion must not index the
  // same worker twice.
  if (wasBusy) addIdle(pool, worker);
}

/** The worker's process ended — caller frees its heap reservation. */
export function noteExit(pool: WorkerPoolMemory, workerId: number): PoolWorker | undefined {
  const worker = pool.workers.get(workerId);
  if (!worker) return undefined;
  if (!worker.busy) removeIdle(pool, worker);
  pool.workers.delete(workerId);
  subGb(pool.gbByHost, worker.hostname, worker.gb);
  if (worker.role) pool.gbByRole[worker.role] = drainGb(pool.gbByRole[worker.role], worker.gb);
  return worker;
}
