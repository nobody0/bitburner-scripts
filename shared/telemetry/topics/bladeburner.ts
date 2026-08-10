/** Bladeburner feature — BN6/BN7's theme. Problem: pick the action sequence
 * (contracts / operations / black ops / general) that climbs rank fastest
 * without dying, spending skill points and managing stamina and city chaos.
 * A stochastic scheduling problem over ~30 actions. */

export interface BladeActionDigest {
  type: "contract" | "operation" | "blackop" | "general";
  name: string;
  /** Estimated success chance range [min, max]. */
  chance: [number, number];
  timeMs: number;
  countRemaining: number;
  level?: number;
  maxLevel?: number;
  autolevel?: boolean;
  successes?: number;
  repGain?: number;
  /** Level-adjusted base rank gain before completion variance. */
  rankGain?: number;
  /** Level-adjusted base rank loss before completion variance. */
  rankLoss?: number;
  /** Rank required to attempt — Black Ops only. */
  rankNeeded?: number;
  /** Black ops only: rank required to attempt. */
  rankReq?: number;
}

export interface BladeCityDigest {
  name: string;
  population: number;
  communities: number;
  chaos: number;
}

export interface BladeburnerState {
  rank: number;
  skillPoints: number;
  stamina: [number, number];
  city: string;
  current?: { type: string; name: string; elapsedMs: number };
  nextBlackOp?: { name: string; rank: number };
  /** Completed black operations, derived on the CORE probe from the next
   *  uncompleted op's position in getBlackOpNames (0 GB). The endgame route
   *  estimate reads this rather than counting the detail probe's action
   *  table, which lands minutes later and costs ~28 GB — a fabricated 0 in
   *  that window mispriced the whole bladeburner route. */
  blackOpsComplete?: number;
  /** Owned by the `bladeburner.actions` / `.cities` probes, never by `.core`.
   *  Core runs four times as often; because topic merges are shallow, an
   *  empty placeholder from core would wipe these between detail sweeps. */
  skills?: Record<string, { level: number; upgradeCost: number }>;
  actions?: BladeActionDigest[];
  cities?: BladeCityDigest[];
  bonusTime?: number;
  plan?: BladeburnerPlan;
}

export interface BladeburnerPlan {
  action: { type: string; why: string; actionType?: string; name?: string; skill?: string };
  ranked: { name: string; actionType: string; rankPerSec: number; chanceLow: number; why: string }[];
  why: string;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}
