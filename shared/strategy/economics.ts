import { BATCH_INTERVAL_S } from "./targeting.ts";
import { prepTimeSeconds, type PrepPlan } from "./targeting.ts";

/** Prep opportunity-cost economics — pure.
 *
 * "If I need to prep a target for 3 hours, that is 3 hours of lost income."
 * The legacy scripts compared `(T − weakenTime)·newRate` against `T·curRate`
 * over a fixed 15-minute window (bitburner-2023 src/main.ts:518-521); this is
 * that model generalized to (a) the real prep time on the share of the fleet
 * prep actually gets, and (b) the farm's DEPTH CAP — RAM beyond what the
 * pipeline can absorb earns nothing, so handing it to prep is free.
 *
 * Deliberately NOT modelled here: "money could buy more RAM instead". The
 * infrastructure arbiter already prices fleet RAM against farm income
 * (game/lib/features/hacking.ts); double-counting it would bias toward
 * hoarding.
 */

/** What the rate model needs from a CycleSolution. */
export interface FarmRateModel {
  /** $/GB/sec — the solver's ranking score. */
  score: number;
  ramPerBatch: number;
  weakenTimeS: number;
}

/** GB beyond which more farm RAM earns nothing: the pipeline holds at most
 * one batch per interval for one weakenTime. */
export function depthCapGb(model: FarmRateModel): number {
  return Math.max(1, Math.floor(model.weakenTimeS / BATCH_INTERVAL_S)) * model.ramPerBatch;
}

/** Farm income in $/sec from `farmGb` of fleet, saturating at the depth cap. */
export function farmIncomeRate(model: FarmRateModel | undefined, farmGb: number): number {
  if (!model || farmGb <= 0) return 0;
  return model.score * Math.min(farmGb, depthCapGb(model));
}

/** How much of a prep's clock the player's OWN growth gives back.
 *
 * Prep time is quoted at today's skill, but weaken/grow times shrink as the
 * player levels DURING the prep — on a small early fleet that error prices
 * every upgrade out of reach forever. The caller projects the skill at the
 * prep's end and passes the relative op time there (weakenTime(future) /
 * weakenTime(now), 1 = no growth measured); the discount averages start and
 * end speed (trapezoid). Deliberately takes ONLY that ratio: an earlier
 * signature also took prepSeconds and ignored its value, which read as if a
 * longer prep discounted differently. Returns a multiplier in (0, 1]. */
export function prepTimeDiscount(futureOpTimeScale: number): number {
  const scale = Math.min(1, Math.max(0, futureOpTimeScale));
  return (1 + scale) / 2;
}

export interface PrepEconomics {
  /** $ over the horizon: gain after the switch minus income lost during prep.
   * The decision value — prep only when positive (plus a churn epsilon). */
  net: number;
  /** The fleet share that maximised `net` (one of `shares`). */
  prepShare: number;
  prepSeconds: number;
}

export function evaluatePrep(args: {
  /** What is farming NOW. Undefined = nothing is earning, prep is free. */
  current?: FarmRateModel | undefined;
  candidate: FarmRateModel;
  plan: PrepPlan;
  fleetGb: number;
  horizonMs: number;
  /** Multiplier on the quoted prep time, from prepTimeDiscount — skill growth
   * during the prep shrinks it. Default 1: no growth assumed. */
  prepTimeScale?: number;
  /** Candidate fleet shares for the prep segment. Defaults let the caller's
   * segment split follow the winning share. */
  shares?: readonly number[];
}): PrepEconomics | undefined {
  const { current, candidate, plan, fleetGb, horizonMs } = args;
  if (plan.prepped || fleetGb <= 0) return undefined;
  const shares = args.shares ?? [0.25, 0.6];
  const timeScale = args.prepTimeScale ?? 1;
  const horizonS = horizonMs / 1_000;
  const currentRate = farmIncomeRate(current, fleetGb);
  const candidateRate = farmIncomeRate(candidate, fleetGb);

  let best: PrepEconomics | undefined;
  for (const share of shares) {
    const prepSeconds = prepTimeSeconds(plan, Math.max(1, fleetGb * share)) * timeScale;
    if (!Number.isFinite(prepSeconds)) continue;
    // Income lost while prepping: only the RAM the farm could actually USE
    // counts — when the farm is depth-capped below (1−share)·fleet, the prep
    // segment is funded entirely by surplus and costs nothing.
    const lost = (currentRate - farmIncomeRate(current, fleetGb * (1 - share))) * prepSeconds;
    const gain = (candidateRate - currentRate) * Math.max(0, horizonS - prepSeconds);
    const net = gain - lost;
    if (!best || net > best.net) best = { net, prepShare: share, prepSeconds };
  }
  return best;
}
