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

/** Measured worker handoff uncertainty. A process which lands at t cannot be
 * budgeted for another invocation at exactly t: promise continuation, exec
 * and timer jitter consume a few milliseconds even when the math is exact. */
export const MINIMUM_WORKER_PRECISION_MS = 5;
/** Conservative landing separation: forty measured handoff quanta. This is
 * intentionally wider than the zero-overhead 4:1 weaken:hack ratio suggests;
 * promise continuation, exec and browser-timer jitter consume real time. */
export const MINIMUM_LANDING_GAP_MS = 40 * MINIMUM_WORKER_PRECISION_MS;
/** Measured allowance for dispatch plus a warm worker-module start. */
export const WORKER_STARTUP_GUARD_MS = 30;
/** A deadline wake replaces the old full-heartbeat allowance. */
export const JIT_LAUNCH_GUARD_MS = WORKER_STARTUP_GUARD_MS + MINIMUM_LANDING_GAP_MS;
export const HWGW_MIN_INTERVAL_MS = 4 * MINIMUM_LANDING_GAP_MS;
export const HGW_MIN_INTERVAL_MS = 3 * MINIMUM_LANDING_GAP_MS;

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
  const hackFortify = 0.002 * hackThreads;
  const growFortify = 0.004 * growThreads;
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
  const events = input.events
    .filter((event) => event.at > now && event.at < landing)
    .sort((a, b) => a.at - b.at || a.order - b.order);
  let difficulty = Math.max(minDifficulty, Math.min(100, input.currentDifficulty));
  let intervalStart = now;
  let best = -Infinity;

  for (let i = 0; i < events.length;) {
    const boundary = events[i]!.at;
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
  const slots = atomicRoles.flatMap((role) => Array.from({ length: slotsFor(role) }, () => role.gb));
  if (slots.length === 0) {
    const block = Math.max(1e-9, topology.divisibleBlockGb);
    return hosts.reduce((sum, gb) => sum + Math.floor((gb + 1e-9) / block) * block, 0) + 1e-9 >= divisibleGb;
  }

  const pack = (ordered: readonly number[]): boolean => {
    const free = [...hosts];
    for (const gb of ordered) {
      let best = -1;
      let bestRemainder = Infinity;
      for (let i = 0; i < free.length; i++) {
        const remainder = free[i]! - gb;
        if (remainder >= -1e-9 && remainder < bestRemainder) {
          best = i;
          bestRemainder = remainder;
        }
      }
      if (best < 0) return false;
      free[best] = Math.max(0, bestRemainder);
    }
    const block = Math.max(1e-9, topology.divisibleBlockGb);
    const divisibleCapacity = free.reduce(
      (sum, gb) => sum + Math.floor((gb + 1e-9) / block) * block,
      0,
    );
    return divisibleCapacity + 1e-9 >= divisibleGb;
  };

  const descending = [...slots].sort((a, b) => b - a);
  if (pack(descending)) return true;
  for (const first of atomicRoles) {
    const grouped = atomicRoles
      .flatMap((role) => Array.from({ length: slotsFor(role) }, () => ({ role, gb: role.gb })))
      .sort((a, b) => Number(b.role === first) - Number(a.role === first) || b.gb - a.gb)
      .map((entry) => entry.gb);
    if (pack(grouped)) return true;
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
