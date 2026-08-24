import { GROW_FORTIFY, HACK_FORTIFY } from "../formulas.ts";
import { MINIMUM_WORKER_PRECISION_MS } from "./timing.ts";

/** One independently reusable steady-state pipeline role. W1 and W2 are
 * separate roles even though both call weaken: their thread counts differ and
 * each needs enough resident capacity for its own cadence. */
export interface JitRole {
  role: "h" | "w1" | "g" | "w2";
  kind: "hack" | "grow" | "weaken";
  gb: number;
  /** Conservative call-to-landing time, including launch guards. */
  holdMs: number;
  /** Hack and grow are one Netscript call and therefore need one contiguous
   * host for every concurrent slot. Weaken deliberately omits this: its
   * additive effect may be spread over slabs. */
  atomic?: boolean;
}

/** Re-exported from its own leaf module so game/worker/worker.ts can import the
 * constant without bundling this one. See shared/strategy/timing.ts. */
export { MINIMUM_WORKER_PRECISION_MS };

/* Landing separation and launch slack are independent quantities. The engine
 * fixes an operation's end time at the moment the Netscript call is made, so
 * `additionalMsec` absorbs JS lateness without moving the landing — we send an
 * absolute `delayUntil` resolved inside the worker immediately before the call
 * (game/lib/worker-shared.ts, game/worker/worker.ts). Jitter therefore belongs
 * in the launch budget, never in the landing grid; putting it in the grid costs
 * pipeline depth directly, since depthCapGb scales as 1/interval.
 * Reference: JOB_LATE_FINISH vs POSSIBLE_LAGS, imports/batchPlanner.ts:7-14. */

/** Landing separation: how far apart effects inside a batch land, and the floor
 * on the batch interval. Two precision quanta (10 ms): live engine lateness
 * oscillates 5-10 ms under load, and at one quantum (5 ms) that lag flipped
 * adjacent landings — measured live as "landed in order" sinking to 72% as the
 * pipeline deepened, entirely "w1 landed where h was due" rows. The wider gap
 * halves the cadence CEILING (50 → 25 batches/sec), which nothing currently
 * reaches; ordering insurance (THREAD_WEAKEN_UPSCALE) still covers the
 * residue beyond 10 ms. */
export const MINIMUM_LANDING_GAP_MS = 2 * MINIMUM_WORKER_PRECISION_MS;
/** How late the JavaScript side may be without moving a landing. Absorbed by
 * additionalMsec, so it buys safety at no cost to pipeline depth. */
export const LAUNCH_SLACK_MS = 200;
/** Measured allowance for dispatch plus a warm worker-module start. */
export const WORKER_STARTUP_GUARD_MS = 30;
/** Built from the launch slack rather than the landing gap: this budget exists
 * to survive a late dispatch, which is what LAUNCH_SLACK_MS measures. */
export const JIT_LAUNCH_GUARD_MS = WORKER_STARTUP_GUARD_MS + LAUNCH_SLACK_MS;
export const HWGW_MIN_INTERVAL_MS = 4 * MINIMUM_LANDING_GAP_MS;
export const HGW_MIN_INTERVAL_MS = 3 * MINIMUM_LANDING_GAP_MS;

/** Ordering insurance. At a few milliseconds of separation a GC pause can
 * reorder two effects; rather than prevent that, oversize weaken by 0.1% so the
 * next already-queued weaken absorbs the residue instead of security ratcheting
 * up (imports/batchPlanner.ts:21-27). Apply it ADDITIVELY — see
 * targeting.ts weakenThreadsFor.
 *
 * The reference's paired THREAD_HACK_DOWNSCALE has no analogue here: it guards
 * fractional hack counts against rounding up into an overdraw, and our hack
 * count is the integer search variable itself. */
export const THREAD_WEAKEN_UPSCALE = 1.001;

export interface JitTopology {
  /** Placeable GB per host. Standing reservations are already subtracted. */
  hostBlocksGb: readonly number[];
  /** Smallest divisible worker block (weaken in the current worker set). */
  divisibleBlockGb: number;
}

export interface JitCycleShape {
  kind: "hwgw" | "hgw";
  hackGb: number;
  weaken1Gb: number;
  growGb: number;
  weaken2Gb: number;
}

/** One construction path for both executable dispatch and economic pricing. */
export function cycleJitRoles(
  cycle: JitCycleShape,
  durationMs: (kind: JitRole["kind"]) => number,
  safetyMs: number,
): JitRole[] {
  const role = (
    roleName: JitRole["role"],
    kind: JitRole["kind"],
    gb: number,
    atomic = false,
  ): JitRole => ({
    role: roleName,
    kind,
    gb,
    holdMs: durationMs(kind) + safetyMs,
    ...(atomic ? { atomic: true } : {}),
  });
  return [
    role("h", "hack", cycle.hackGb, true),
    ...(cycle.kind === "hwgw" ? [role("w1", "weaken", cycle.weaken1Gb)] : []),
    role("g", "grow", cycle.growGb, true),
    role("w2", "weaken", cycle.weaken2Gb),
  ].filter((entry) => entry.gb > 0);
}

export function cycleWorstDifficulty(
  kind: JitCycleShape["kind"],
  minDifficulty: number,
  hackThreads: number,
  growThreads: number,
): number {
  const hackFortify = HACK_FORTIFY * hackThreads;
  const growFortify = GROW_FORTIFY * growThreads;
  const excess = kind === "hgw" ? hackFortify + growFortify : Math.max(hackFortify, growFortify);
  return Math.min(100, minDifficulty + excess);
}

export interface JitSchedule {
  intervalMs: number;
  totalGb: number;
  quotaGb: Record<JitRole["role"], number>;
}

/** A future landing which changes the duration of operations invoked after it.
 * `deltaDifficulty` is positive for hack/grow and negative for weaken. */
export interface JitSecurityEvent {
  at: number;
  order: number;
  deltaDifficulty: number;
}

export interface LatestJitStartInput {
  now: number;
  landing: number;
  currentDifficulty: number;
  minDifficulty: number;
  events: readonly JitSecurityEvent[];
  /** Caller has already ordered events by (at, order). Hot dispatch paths
   * share one immutable ledger across many pending operations. */
  eventsSorted?: boolean;
  durationMs: (difficulty: number) => number;
  /** Time reserved for dispatch + worker startup before an invocation deadline. */
  launchGuardMs: number;
}

/** Latest safe dispatch time across every predicted security interval.
 *
 * A simple `landing - duration(liveSecurity)` is unsafe when a hack/grow lands
 * before that time: the native call would then see a longer duration and miss
 * its slot. Conversely, always using the maximum possible security launches
 * too early and strands RAM in `additionalMsec`.
 *
 * Each interval offers one latest deadline. At a security boundary the worker
 * must be dispatched one launch guard before the effect, so its HGW call has
 * observed the old duration before that effect lands. Taking the latest valid
 * candidate across all intervals minimizes process-held padding without ever
 * assuming that a future security change will not happen. */
export function latestJitStart(input: LatestJitStartInput): number {
  const { now, landing, minDifficulty, durationMs, launchGuardMs } = input;
  const events = input.eventsSorted
    ? input.events
    : input.events
        .filter((event) => event.at > now && event.at < landing)
        .sort((a, b) => a.at - b.at || a.order - b.order);
  let difficulty = Math.max(minDifficulty, Math.min(100, input.currentDifficulty));
  let intervalStart = now;
  let best = -Infinity;

  for (let i = 0; i < events.length;) {
    if (events[i]!.at <= now) {
      i++;
      continue;
    }
    const boundary = events[i]!.at;
    if (boundary >= landing) break;
    const nativeDeadline = landing - durationMs(difficulty) - launchGuardMs;
    const candidate = Math.min(nativeDeadline, boundary - launchGuardMs);
    if (candidate >= intervalStart) best = Math.max(best, candidate);

    do {
      difficulty = Math.max(minDifficulty, Math.min(100, difficulty + events[i]!.deltaDifficulty));
      i++;
    } while (i < events.length && events[i]!.at === boundary);
    intervalStart = boundary;
  }

  const nativeDeadline = landing - durationMs(difficulty) - launchGuardMs;
  if (nativeDeadline >= intervalStart) best = Math.max(best, nativeDeadline);

  // No guarded future deadline remains. Returning `now` lets the dispatcher
  // use its existing live-duration late check: launch immediately if the slot
  // is still reachable, otherwise abandon the dependent pending suffix.
  return Number.isFinite(best) ? best : now;
}

/** RAM needed by fixed-role pipelines at one batch every `intervalMs`.
 *
 * A role needs ceil(duration / interval) reusable slots. This is deliberately
 * a little more conservative than average GB-ms: unlike an average, the
 * integer slot count is an executable capacity guarantee. */
export function jitCapacity(roles: readonly JitRole[], intervalMs: number): JitSchedule {
  const quotaGb: JitSchedule["quotaGb"] = { h: 0, w1: 0, g: 0, w2: 0 };
  for (const role of roles) {
    if (role.gb <= 0 || role.holdMs <= 0) continue;
    quotaGb[role.role] = Math.ceil(role.holdMs / intervalMs) * role.gb;
  }
  return {
    intervalMs,
    totalGb: quotaGb.h + quotaGb.w1 + quotaGb.g + quotaGb.w2,
    quotaGb,
  };
}

/** Check the role envelope against real host topology.
 *
 * Total GB is insufficient when the few hosts large enough for atomic H/G
 * calls are already occupied by other concurrent H/G slots. Pack each atomic
 * call separately (largest first, best fit), then make sure the residual slabs
 * can hold the divisible weaken envelope. Trying the two role-group orders as
 * well as global size order avoids the common two-size greedy pathology while
 * keeping this cheap enough for every evaluator generation. */
export function jitTopologyFits(
  roles: readonly JitRole[],
  schedule: JitSchedule,
  topology: JitTopology,
): boolean {
  const hosts = topology.hostBlocksGb.filter((gb) => gb > 0);
  if (hosts.length === 0) return schedule.totalGb <= 1e-9;
  const atomicRoles = roles.filter((role) => role.atomic && role.gb > 0);
  const divisibleGb = roles
    .filter((role) => !role.atomic)
    .reduce((sum, role) => sum + schedule.quotaGb[role.role], 0);
  const slotsFor = (role: JitRole): number => Math.ceil(role.holdMs / schedule.intervalMs);
  const runOf = (role: JitRole): { gb: number; count: number } => ({ gb: role.gb, count: slotsFor(role) });
  const block = Math.max(1e-9, topology.divisibleBlockGb);
  const divisibleFits = (free: readonly number[]): boolean =>
    free.reduce((sum, gb) => sum + Math.floor((gb + 1e-9) / block) * block, 0) + 1e-9 >= divisibleGb;
  if (atomicRoles.every((role) => slotsFor(role) === 0)) return divisibleFits(hosts);

  // Slots are placed as RUNS of one size, never one array entry per slot.
  //
  // `slotsFor` is holdMs/intervalMs, so a three-minute weaken on a 20 ms grid
  // is ~9,000 identical blocks; materialising and sorting that list, then
  // best-fitting each entry against every host, made this the most expensive
  // function in a profile of the running game — and `chooseJitSchedule` binary
  // searches, so it runs a dozen times a pass.
  //
  // Best-fit over equal sizes collapses: the chosen host is the SMALLEST free
  // block that still holds one, and subtracting leaves it still the smallest
  // that holds one, so it keeps winning until it cannot. Placing
  // floor(free/gb) at once is therefore the same packing, not an approximation.
  const free = hosts.slice();
  const pack = (runs: readonly { gb: number; count: number }[]): boolean => {
    for (let i = 0; i < hosts.length; i++) free[i] = hosts[i]!;
    for (const run of runs) {
      let remaining = run.count;
      while (remaining > 0) {
        let best = -1;
        let bestFree = Infinity;
        for (let i = 0; i < free.length; i++) {
          const candidate = free[i]!;
          if (candidate - run.gb >= -1e-9 && candidate < bestFree) {
            best = i;
            bestFree = candidate;
          }
        }
        if (best < 0) return false;
        const placed = Math.min(remaining, Math.max(1, Math.floor((bestFree + 1e-9) / run.gb)));
        free[best] = Math.max(0, bestFree - placed * run.gb);
        remaining -= placed;
      }
    }
    return divisibleFits(free);
  };

  const byLargest = atomicRoles.map(runOf).sort((a, b) => b.gb - a.gb);
  if (pack(byLargest)) return true;
  // Largest-first alone hits the classic two-size greedy pathology, so also try
  // leading with each role in turn.
  for (const first of atomicRoles) {
    const led = atomicRoles.filter((role) => role !== first).map(runOf).sort((a, b) => b.gb - a.gb);
    if (pack([runOf(first), ...led])) return true;
  }
  return false;
}

/** Choose the fastest safe cadence, restricted to whole landing intervals so
 * every batch retains the same H/W/G/W slot grid. Undefined means even one
 * reusable slot per role does not fit; the dispatcher then uses its simpler
 * batch-atomic path. */
export function chooseJitSchedule(
  roles: readonly JitRole[],
  capacityGb: number,
  minimumIntervalMs: number,
  topology?: JitTopology,
): JitSchedule | undefined {
  if (capacityGb <= 0 || minimumIntervalMs <= 0) return undefined;
  const longest = Math.max(minimumIntervalMs, ...roles.map((role) => role.holdMs));
  const factors = Math.ceil(longest / minimumIntervalMs) + 1;
  const fits = (factor: number): JitSchedule | undefined => {
    const schedule = jitCapacity(roles, factor * minimumIntervalMs);
    if (
      schedule.totalGb <= capacityGb + 1e-9 &&
      (!topology || jitTopologyFits(roles, schedule, topology))
    ) return schedule;
    return undefined;
  };
  // Capacity is monotone as cadence slows: every role retains the same or
  // fewer integer slots, and topology only has fewer blocks to place. Binary
  // search keeps long weaken schedules cheap even when they last minutes.
  if (!fits(factors)) return undefined;
  let low = 1;
  let high = factors;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) high = mid;
    else low = mid + 1;
  }
  return fits(low);
}
