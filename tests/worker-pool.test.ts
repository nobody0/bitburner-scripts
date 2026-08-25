/** The idle index in worker-pool.ts replaced a per-call scan-and-sort over the
 * whole worker map. That scan was the dominant term in a dispatcher pass at
 * live process counts, but it was also the definition of which worker serves an
 * op — so the index has to reproduce its CHOICE exactly, not merely a valid
 * one. These tests hold the indexed implementation against a literal
 * transcription of the scan it replaced, over randomized lifecycles. */
import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../sim/core/rng.ts";
import {
  initPool,
  noteExit,
  noteJobDone,
  noteJobStart,
  noteSpawn,
  planTake,
  poolGbByRole,
  poolCounts,
  type OpKind,
  type PoolRole,
  type PoolWorker,
  type WorkerPoolMemory,
} from "../shared/strategy/worker-pool.ts";

/** Recompute the idle index from `workers` and report every divergence. The
 * index is derived state maintained across four transitions, so these tests
 * hold it against a full recompute rather than trusting the increments. */
function auditPool(pool: WorkerPoolMemory): string[] {
  const problems: string[] = [];
  const indexed = new Set<number>();
  for (const [key, bucket] of pool.idle) {
    if ([...bucket.sizes].sort((a, b) => b - a).join() !== bucket.sizes.join()) {
      problems.push(`${key}: sizes are not descending`);
    }
    for (const size of bucket.sizes) {
      if (!bucket.bySize.has(size)) problems.push(`${key}: size ${size} listed with no entry`);
    }
    for (const [size, list] of bucket.bySize) {
      if (list.length === 0) problems.push(`${key}: empty list retained for size ${size}`);
      if (!bucket.sizes.includes(size)) problems.push(`${key}: size ${size} missing from sizes`);
      let previous = -Infinity;
      for (const worker of list) {
        if (worker.workerId <= previous) problems.push(`${key}/${size}: not ascending by workerId`);
        previous = worker.workerId;
        if (indexed.has(worker.workerId)) problems.push(`worker ${worker.workerId} indexed twice`);
        indexed.add(worker.workerId);
        if (worker.busy) problems.push(`worker ${worker.workerId} indexed while busy`);
        if (worker.threads !== size) problems.push(`worker ${worker.workerId} indexed under size ${size}`);
        if (pool.workers.get(worker.workerId) !== worker) {
          problems.push(`worker ${worker.workerId} indexed but not resident`);
        }
        if (`${worker.kind}:${worker.role ?? ""}` !== key) {
          problems.push(`worker ${worker.workerId} indexed under ${key}`);
        }
      }
    }
  }
  for (const worker of pool.workers.values()) {
    if (worker.busy || indexed.has(worker.workerId)) continue;
    problems.push(`idle worker ${worker.workerId} missing from the index`);
  }

  // gbByHost/gbByRole are maintained across spawn and exit only — a worker owns
  // its RAM for its whole process life — so job transitions must never move
  // them, and a drained host or role must not linger at a float residue.
  const gbByHost = new Map<string, number>();
  const gbByRole: Record<PoolRole, number> = { h: 0, w1: 0, g: 0, w2: 0 };
  for (const worker of pool.workers.values()) {
    gbByHost.set(worker.hostname, (gbByHost.get(worker.hostname) ?? 0) + worker.gb);
    if (worker.role) gbByRole[worker.role] += worker.gb;
  }
  for (const [hostname, gb] of gbByHost) {
    const held = pool.gbByHost.get(hostname);
    if (held === undefined || Math.abs(held - gb) > 1e-6) {
      problems.push(`gbByHost[${hostname}] is ${held}, expected ${gb}`);
    }
  }
  for (const hostname of pool.gbByHost.keys()) {
    if (!gbByHost.has(hostname)) problems.push(`gbByHost retains drained host ${hostname}`);
  }
  for (const role of ["h", "w1", "g", "w2"] as const) {
    if (Math.abs(pool.gbByRole[role] - gbByRole[role]) > 1e-6) {
      problems.push(`gbByRole[${role}] is ${pool.gbByRole[role]}, expected ${gbByRole[role]}`);
    }
  }
  return problems;
}

/** Independent oracle for `planTake`, written from the SPECIFICATION rather
 * than from the implementation — deriving it from `planTake` would make the
 * differential below tautological, and this is the only guard the idle index
 * has.
 *
 * Spec:
 *  - hack: one call, but it may run weaker than the process, so any idle worker
 *    at least `threads` qualifies. Best fit — the SMALLEST such worker.
 *  - grow/weaken: greedy largest-first over workers no larger than the
 *    remainder.
 *  - grow only: if a remainder survives, one oversized worker may serve it
 *    partially rather than allocating a fresh block.
 *  - weaken never runs partially: over-weakening clamps at minDifficulty and is
 *    the ordering insurance, so a weaken worker always runs at full strength.
 *  - within one size, lowest workerId first. */
function scanTake(
  pool: WorkerPoolMemory,
  kind: OpKind,
  threads: number,
  reserved: ReadonlySet<number> = new Set(),
  role?: PoolRole,
): { take: PoolWorker[]; missThreads: number } {
  const idle = [...pool.workers.values()]
    .filter((w) => w.kind === kind && w.role === role && !w.busy && !reserved.has(w.workerId))
    .sort((a, b) => b.threads - a.threads || a.workerId - b.workerId);
  /** Best fit: the smallest qualifying size, then the lowest workerId in it. */
  const bestFit = (candidates: PoolWorker[]): PoolWorker | undefined => {
    if (candidates.length === 0) return undefined;
    const smallest = Math.min(...candidates.map((w) => w.threads));
    return candidates.filter((w) => w.threads === smallest)
      .sort((a, b) => a.workerId - b.workerId)[0];
  };
  if (kind === "hack") {
    const best = bestFit(idle.filter((w) => w.threads >= threads));
    return best ? { take: [best], missThreads: 0 } : { take: [], missThreads: threads };
  }
  const take: PoolWorker[] = [];
  let remaining = threads;
  for (const worker of idle) {
    if (worker.threads > remaining) continue;
    take.push(worker);
    remaining -= worker.threads;
    if (remaining < 1) break;
  }
  if (kind === "grow" && remaining >= 1) {
    const best = bestFit(idle.filter((w) => w.threads > remaining && !take.includes(w)));
    if (best) {
      take.push(best);
      remaining = 0;
    }
  }
  return { take, missThreads: remaining >= 1 ? remaining : 0 };
}

const KINDS: OpKind[] = ["hack", "grow", "weaken"];
const ROLES: (PoolRole | undefined)[] = ["h", "w1", "g", "w2", undefined];

const ids = (result: { take: readonly ({ workerId: number } | { worker: PoolWorker })[] }) =>
  result.take.map((entry) => ("worker" in entry ? entry.worker.workerId : entry.workerId));

describe("worker pool idle index", () => {
  test("matches the scan it replaced across randomized lifecycles", () => {
    const random = mulberry32(20260819);
    const pool = initPool();
    let nextId = 1;
    const live: number[] = [];

    for (let step = 0; step < 4_000; step++) {
      const roll = random();
      if (roll < 0.4 || live.length === 0) {
        const kind = KINDS[Math.floor(random() * KINDS.length)]!;
        const worker = noteSpawn(
          pool,
          {
            workerId: nextId++,
            hostname: `host-${Math.floor(random() * 5)}`,
            kind,
            // Sizes deliberately collide so equal-size ordering is exercised.
            threads: 1 + Math.floor(random() * 6),
            effectThreads: 1,
            gb: 1.75 + Math.floor(random() * 3) * 0.1,
            ...(kind === "hack"
              ? { role: "h" as const }
              : { role: ROLES[Math.floor(random() * ROLES.length)] }),
          },
          step,
        );
        live.push(worker.workerId);
      } else if (roll < 0.7) {
        noteJobDone(pool, live[Math.floor(random() * live.length)]!, step);
      } else if (roll < 0.85) {
        noteJobStart(pool, live[Math.floor(random() * live.length)]!);
      } else {
        const at = Math.floor(random() * live.length);
        noteExit(pool, live[at]!);
        live.splice(at, 1);
      }

      // The index is derived state; recompute and compare after EVERY step, so
      // a divergence is attributed to the transition that caused it.
      expect(auditPool(pool)).toEqual([]);
      const counts = poolCounts(pool);
      expect(counts.workers).toBe(pool.workers.size);
      expect(counts.busy).toBe([...pool.workers.values()].filter((w) => w.busy).length);

      const kind = KINDS[Math.floor(random() * KINDS.length)]!;
      const role = kind === "hack" ? ("h" as const) : ROLES[Math.floor(random() * ROLES.length)];
      const want = 1 + Math.floor(random() * 12);
      const reserved = new Set(live.filter(() => random() < 0.15));
      const indexed = planTake(pool, kind, want, reserved, role);
      const scanned = scanTake(pool, kind, want, reserved, role);
      expect(ids(indexed)).toEqual(ids(scanned));
      expect(indexed.missThreads).toBe(scanned.missThreads);
    }
  });

  test("prefers the lowest workerId among equally sized idle workers", () => {
    const pool = initPool();
    for (const workerId of [7, 3, 9]) {
      noteSpawn(pool, { workerId, hostname: "home", kind: "hack", role: "h", threads: 4, effectThreads: 4, gb: 1.7 }, 0);
      noteJobDone(pool, workerId, 0);
    }
    // Spawn order is 7, 3, 9 but ids are what the old stable sort ordered by.
    expect(ids(planTake(pool, "hack", 4, new Set(), "h"))).toEqual([3]);
    expect(ids(planTake(pool, "hack", 4, new Set([3]), "h"))).toEqual([7]);
  });

  test("a hack reuses a larger worker at reduced strength, smallest sufficient first", () => {
    const pool = initPool();
    // Only oversized workers exist: under exact-match this op would allocate.
    for (const [workerId, threads] of [[1, 9], [2, 6], [3, 6]] as const) {
      noteSpawn(pool, { workerId, hostname: "home", kind: "hack", role: "h", threads, effectThreads: threads, gb: 1.7 * threads }, 0);
      noteJobDone(pool, workerId, 0);
    }
    const taken = planTake(pool, "hack", 4, new Set(), "h");
    // Best fit, not largest-first: spending the 9-thread worker on a 4-thread
    // hack strands it for the batch that actually needs it.
    expect(ids(taken)).toEqual([2]);
    expect(taken.missThreads).toBe(0);
    // The block stays 6 threads; only the strength drops to what was asked.
    expect(taken.take[0]!.worker.threads).toBe(6);
    expect(taken.take[0]!.strengthEffect).toBe(4);
    // Nothing large enough: still a miss, reported at the full request.
    expect(planTake(pool, "hack", 12, new Set(), "h").missThreads).toBe(12);
  });

  test("a grow remainder is served partially by an oversized worker", () => {
    const pool = initPool();
    for (const [workerId, threads] of [[1, 8], [2, 5]] as const) {
      noteSpawn(pool, { workerId, hostname: "home", kind: "grow", role: "g", threads, effectThreads: threads, gb: 1.75 * threads }, 0);
      noteJobDone(pool, workerId, 0);
    }
    // Greedy takes the 8; 2 remain and only the oversized 5 is left.
    const taken = planTake(pool, "grow", 10, new Set(), "g");
    expect(ids(taken)).toEqual([1, 2]);
    expect(taken.missThreads).toBe(0);
    expect(taken.take[1]!.strengthEffect).toBe(2);
  });

  test("a weaken always runs at full spawned strength", () => {
    const pool = initPool();
    for (const [workerId, threads] of [[1, 8], [2, 5]] as const) {
      noteSpawn(pool, { workerId, hostname: "home", kind: "weaken", role: "w2", threads, effectThreads: threads, gb: 1.75 * threads }, 0);
      noteJobDone(pool, workerId, 0);
    }
    // Over-weakening clamps at minDifficulty and IS the ordering insurance, so
    // weaken never takes an oversized worker partially — the remainder is a
    // miss, and every take runs at its whole effect.
    const taken = planTake(pool, "weaken", 10, new Set(), "w2");
    expect(ids(taken)).toEqual([1]);
    expect(taken.missThreads).toBe(2);
    expect(taken.take.every((entry) => entry.strengthEffect === entry.worker.effectThreads)).toBe(true);
  });

  test("composes a divisible op largest-first and reports the shortfall", () => {
    const pool = initPool();
    const sizes: Record<number, number> = { 1: 8, 2: 3, 3: 5 };
    for (const [workerId, threads] of Object.entries(sizes)) {
      noteSpawn(
        pool,
        { workerId: Number(workerId), hostname: "home", kind: "grow", role: "g", threads, effectThreads: threads, gb: 1.75 },
        0,
      );
      noteJobDone(pool, Number(workerId), 0);
    }
    const taken = planTake(pool, "grow", 12, new Set(), "g");
    expect(ids(taken)).toEqual(ids(scanTake(pool, "grow", 12, new Set(), "g")));
    expect(taken.missThreads).toBe(scanTake(pool, "grow", 12, new Set(), "g").missThreads);
  });

  test("a busy worker leaves the index and a repeated completion does not double-index it", () => {
    const pool = initPool();
    noteSpawn(pool, { workerId: 1, hostname: "home", kind: "weaken", role: "w2", threads: 2, effectThreads: 2, gb: 1.75 }, 0);
    expect(ids(planTake(pool, "weaken", 2, new Set(), "w2"))).toEqual([]);
    noteJobDone(pool, 1, 0);
    noteJobDone(pool, 1, 1);
    expect(auditPool(pool)).toEqual([]);
    expect(ids(planTake(pool, "weaken", 2, new Set(), "w2"))).toEqual([1]);
    noteJobStart(pool, 1);
    expect(auditPool(pool)).toEqual([]);
    expect(ids(planTake(pool, "weaken", 2, new Set(), "w2"))).toEqual([]);
  });

  test("exiting an idle worker empties its size out of the index", () => {
    const pool = initPool();
    noteSpawn(pool, { workerId: 1, hostname: "home", kind: "grow", role: "g", threads: 5, effectThreads: 5, gb: 1.75 }, 0);
    noteJobDone(pool, 1, 0);
    expect(noteExit(pool, 1)?.workerId).toBe(1);
    expect(auditPool(pool)).toEqual([]);
    expect(planTake(pool, "grow", 5, new Set(), "g").missThreads).toBe(5);
  });

  test("JIT workers are isolated by target and shape generation", () => {
    const pool = initPool();
    noteSpawn(pool, {
      workerId: 1, hostname: "home", kind: "grow", role: "g",
      target: "alpha", generation: 3, threads: 5, effectThreads: 5, gb: 8.75,
    }, 0);
    noteJobDone(pool, 1, 0);
    expect(ids(planTake(pool, "grow", 5, new Set(), "g", {
      target: "alpha", generation: 3,
    }))).toEqual([1]);
    expect(ids(planTake(pool, "grow", 5, new Set(), "g", {
      target: "alpha", generation: 4,
    }))).toEqual([]);
    expect(ids(planTake(pool, "grow", 5, new Set(), "g", {
      target: "beta", generation: 3,
    }))).toEqual([]);
    expect(poolGbByRole(pool, "alpha", 3).g).toBe(8.75);
    expect(poolGbByRole(pool, "alpha", 4).g).toBe(0);
    noteExit(pool, 1);
    expect(poolGbByRole(pool, "alpha", 3).g).toBe(0);
  });
});
