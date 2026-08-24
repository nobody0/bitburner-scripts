/** Farm scheduling mode — HOW the chosen target is farmed, decided per pass
 * (the evaluator decides WHICH target; this is a separate axis with separate
 * inputs and a much cheaper cadence).
 *
 * - "hwgw": the default four-op batch. Best $/GB/sec for most of the game.
 * - "hgw": drop the first weaken, overscale the grow. Worse per-GB score but
 *   3 processes per batch instead of 4 — the lever when the BROWSER's real
 *   RAM (script/process count), not game RAM, is the binding constraint.
 * - "shotgun": once hackTime is shorter than the timer-resolution safety
 *   window, every batch of a wave lands in the SAME engine tick, ordered by
 *   launch order (same-tick timers fire in registration order), one wave per
 *   weakenTime.
 */
export type FarmMode = "hwgw" | "hgw" | "shotgun";

/** Below this native hack duration, separate timer deadlines are no longer a
 * dependable ordering mechanism and same-deadline FIFO shotgun takes over. */
export const SHOTGUN_HACK_MS = 100;
/** Economic shotgun trigger: which resource binds. RAM can hold
 * `farmGb / ramPerBatch` concurrent batches; the landing grid at minimum
 * spacing holds `weakenMs / intervalMs`. When RAM holds MORE than the grid,
 * the spacing floor is the binding cap while RAM idles — same-deadline
 * shotgun volleys need no inter-batch spacing and convert the surplus into
 * throughput (post-install: a weak target farmed with ~1% of a huge fleet).
 * When RAM binds, JIT's worker reuse and precise slots win. The hysteresis
 * keeps the boundary from flapping as the fleet compounds past the envelope. */
export const SHOTGUN_BOUND_HYSTERESIS = 1.2;
/** Live in-flight ops above which HWGW's process count starts to threaten the
 * browser's limits and HGW's −25 % ops/batch pays for its worse score. Enter
 * above the threshold, exit below the release; the gap is the hysteresis. */
export const HGW_LIVE_OPS_PRESSURE = 1_500;
export const HGW_LIVE_OPS_RELEASE = 1_000;
/** Minimum time in a mode before switching again (flap guard). */
export const MODE_DWELL_MS = 30_000;

export interface ModeInputs {
  /** Hack time for the farm target at its prepped security, ms. */
  hackMs: number;
  /** In-flight op count (the dispatcher's tracked ledger size). */
  liveOps: number;
  /** Concurrent batches the farm segment's RAM can hold (farmGb/ramPerBatch).
   * Absent = no economic shotgun consideration. */
  ramBoundedBatches?: number;
  /** Concurrent batches the landing grid holds at minimum spacing
   * (weakenMs/intervalMs). */
  timeBoundedBatches?: number;
  lastMode: FarmMode;
  lastModeSince: number;
  now: number;
}

export function decideMode(inputs: ModeInputs): FarmMode {
  const correctnessShotgun = inputs.hackMs < SHOTGUN_HACK_MS;
  const timeBound =
    inputs.ramBoundedBatches !== undefined &&
    inputs.timeBoundedBatches !== undefined &&
    inputs.ramBoundedBatches > SHOTGUN_BOUND_HYSTERESIS * inputs.timeBoundedBatches;
  let desired: FarmMode;
  if (correctnessShotgun || timeBound) {
    desired = "shotgun";
  } else if (
    inputs.liveOps > HGW_LIVE_OPS_PRESSURE
    // Hysteresis: once in hgw, stay until pressure falls below the release line.
    || (inputs.lastMode === "hgw" && inputs.liveOps > HGW_LIVE_OPS_RELEASE)
  ) {
    desired = "hgw";
  } else {
    desired = "hwgw";
  }
  // Enter the correctness-preserving short-timer mode immediately. Dwell
  // suppresses performance-driven switches — including entering (and leaving)
  // the ECONOMIC shotgun, whose boundary moves with the fleet — and leaving a
  // still-safe correctness shotgun.
  const immediate = desired === "shotgun" && correctnessShotgun;
  if (!immediate && desired !== inputs.lastMode && inputs.now - inputs.lastModeSince < MODE_DWELL_MS) {
    return inputs.lastMode;
  }
  return desired;
}
