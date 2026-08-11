/** One independently reusable steady-state pipeline role. W1 and W2 are
 * separate roles even though both call weaken: their thread counts differ and
 * each needs enough resident capacity for its own cadence. */
export interface JitRole {
  role: "h" | "w1" | "g" | "w2";
  kind: "hack" | "grow" | "weaken";
  gb: number;
  /** Conservative call-to-landing time, including launch guards. */
  holdMs: number;
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

/** Choose the fastest safe cadence, restricted to whole landing intervals so
 * every batch retains the same H/W/G/W slot grid. Undefined means even one
 * reusable slot per role does not fit; the dispatcher then uses its simpler
 * batch-atomic path. */
export function chooseJitSchedule(
  roles: readonly JitRole[],
  capacityGb: number,
  minimumIntervalMs: number,
): JitSchedule | undefined {
  if (capacityGb <= 0 || minimumIntervalMs <= 0) return undefined;
  const longest = Math.max(minimumIntervalMs, ...roles.map((role) => role.holdMs));
  const factors = Math.ceil(longest / minimumIntervalMs) + 1;
  for (let factor = 1; factor <= factors; factor++) {
    const schedule = jitCapacity(roles, factor * minimumIntervalMs);
    if (schedule.totalGb <= capacityGb + 1e-9) return schedule;
  }
  return undefined;
}
