import { BATCH_INTERVAL_S } from "./targeting.ts";

/** Farm scheduling mode — HOW the chosen target is farmed, decided per pass
 * (the evaluator decides WHICH target; this is a separate axis with separate
 * inputs and a much cheaper cadence).
 *
 * - "hwgw": the default four-op batch. Best $/GB/sec for most of the game.
 * - "hgw": drop the first weaken, overscale the grow. Worse per-GB score but
 *   3 processes per batch instead of 4 — the lever when the BROWSER's real
 *   RAM (script/process count), not game RAM, is the binding constraint.
 * - "shotgun": when weakenTime shrinks toward the batch interval there is no
 *   room left to interleave batches; instead every batch of a wave lands in
 *   the SAME engine tick, ordered by launch order (same-tick timers fire in
 *   registration order), one wave per weakenTime.
 */
export type FarmMode = "hwgw" | "hgw" | "shotgun";

/** Below this many interleaved batches per weakenTime, batching degenerates
 * (the legacy `intervalFactor < 1` regime) and shotgun takes over. */
export const SHOTGUN_MIN_DEPTH = 2;
/** Live in-flight ops above which HWGW's process count starts to threaten the
 * browser's limits and HGW's −25 % ops/batch pays for its worse score. Enter
 * above the threshold, exit below the release; the gap is the hysteresis. */
export const HGW_LIVE_OPS_PRESSURE = 1_500;
export const HGW_LIVE_OPS_RELEASE = 1_000;
/** Minimum time in a mode before switching again (flap guard). */
export const MODE_DWELL_MS = 30_000;

export interface ModeInputs {
  /** Weaken time for the farm target at its CURRENT security, ms. */
  weakenMs: number;
  /** In-flight op count (the dispatcher's tracked ledger size). */
  liveOps: number;
  lastMode: FarmMode;
  lastModeSince: number;
  now: number;
}

export interface ModeDecision {
  mode: FarmMode;
  why: string;
}

export function decideMode(inputs: ModeInputs): ModeDecision {
  const depth = Math.floor(inputs.weakenMs / (BATCH_INTERVAL_S * 1_000));
  let desired: FarmMode;
  let why: string;
  if (depth < SHOTGUN_MIN_DEPTH) {
    desired = "shotgun";
    why = `weakenTime ${Math.round(inputs.weakenMs)}ms fits ${depth} interleaved batches`;
  } else if (inputs.liveOps > HGW_LIVE_OPS_PRESSURE) {
    desired = "hgw";
    why = `${inputs.liveOps} live ops > ${HGW_LIVE_OPS_PRESSURE}`;
  } else if (inputs.lastMode === "hgw" && inputs.liveOps > HGW_LIVE_OPS_RELEASE) {
    desired = "hgw";
    why = `${inputs.liveOps} live ops holds hgw (release ${HGW_LIVE_OPS_RELEASE})`;
  } else {
    desired = "hwgw";
    why = `depth ${depth}, ${inputs.liveOps} live ops`;
  }
  if (desired !== inputs.lastMode && inputs.now - inputs.lastModeSince < MODE_DWELL_MS) {
    return { mode: inputs.lastMode, why: `dwell (${desired} pending)` };
  }
  return { mode: desired, why };
}
