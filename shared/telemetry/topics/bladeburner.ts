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
  rankGain?: number;
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
