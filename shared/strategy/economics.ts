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
 * "Money now" is also an input from the infrastructure arbiter: its best
 * observed income/sec/dollar quote prices how much an earlier dollar can earn
 * before a later target comes online. Keeping that quote outside this module
 * avoids duplicating purchase policy while still accounting for reinvestment.
 */

/** What the rate model needs from a CycleSolution. */
export interface FarmRateModel {
  /** $/GB/sec — the solver's ranking score. */
  score: number;
  ramPerBatch: number;
  weakenTimeS: number;
  /** Executable reusable-role envelope. Optional only for older fixtures and
   * topology-unaware callers. */
  jitSaturationGb?: number;
  /** Maximum cadence of the fastest legal reusable-role envelope. */
  maximumIncomePerSec?: number;
  /** Hacking experience/GB/sec for the same solution. Optional for the money-
   *  only callers and older fixtures. */
  experienceScore?: number;
}

/** GB beyond which more farm RAM earns nothing: the pipeline holds at most
 * one batch per interval for one weakenTime. */
export function depthCapGb(model: FarmRateModel): number {
  if (model.jitSaturationGb !== undefined && model.jitSaturationGb > 0) return model.jitSaturationGb;
  return Math.max(1, Math.floor(model.weakenTimeS / BATCH_INTERVAL_S)) * model.ramPerBatch;
}

/** Farm income in $/sec from `farmGb` of fleet, saturating at the depth cap. */
export function farmIncomeRate(model: FarmRateModel | undefined, farmGb: number): number {
  if (!model || farmGb <= 0) return 0;
  if (model.maximumIncomePerSec !== undefined && model.jitSaturationGb !== undefined) {
    return model.maximumIncomePerSec * Math.min(1, farmGb / model.jitSaturationGb);
  }
  return model.score * Math.min(farmGb, depthCapGb(model));
}

/** Hacking experience per second from `farmGb`, saturating at the same depth
 * cap the income does.
 *
 * The experience side of `farmIncomeRate`, and it exists for the same reason:
 * both are what the COMMITTED batch will produce once it lands, which is a
 * different question from what has landed so far. A warming-up farm has
 * measured zero of both and is still about to be the best producer of each.
 * Deliberately without the `maximumIncomePerSec` shortcut, which is a money
 * cadence refinement with no experience analogue. */
export function farmExperienceRate(model: FarmRateModel | undefined, farmGb: number): number {
  const score = model?.experienceScore ?? 0;
  if (!model || farmGb <= 0 || !(score > 0)) return 0;
  return score * Math.min(farmGb, depthCapGb(model));
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
  /** The fleet share that maximised `net` (one of `shares`, or exact prepGb). */
  prepShare: number;
  /** Exact executable allocation evaluated, after demand/placement caps. */
  prepGb: number;
  prepSeconds: number;
}

/** Value an income window using the arbiter's continuously refreshed marginal
 * income/sec/dollar. Normalizing terminal value by the common horizon factor
 * keeps comparisons bounded; at r=0 this is exactly rate times duration. */
export function incomePresentValue(ratePerSec: number, fromSec: number, toSec: number, reinvestmentRate: number): number {
  const from = Math.max(0, fromSec);
  const to = Math.max(from, toSec);
  const rate = Math.max(0, ratePerSec);
  const r = Number.isFinite(reinvestmentRate) ? Math.max(0, reinvestmentRate) : 0;
  if (r <= 1e-12) return rate * (to - from);
  return rate * (Math.exp(-r * from) - Math.exp(-r * to)) / r;
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
  /** Executable allocation ceiling (placement, wave demand, and any atomic
   * farm reservation). The value search still chooses below this ceiling. */
  maxPrepGb?: number;
  /** Exact demand-driven allocation. When supplied, replaces `shares`. */
  prepGb?: number;
  /** Best currently observed marginal income/sec per invested dollar. */
  reinvestmentReturnPerDollarSec?: number;
}): PrepEconomics | undefined {
  const { current, candidate, plan, fleetGb, horizonMs } = args;
  if (plan.prepped || fleetGb <= 0) return undefined;
  const maxPrepGb = Math.min(fleetGb, Math.max(0, args.maxPrepGb ?? fleetGb));
  const unconstrainedAllocations = args.prepGb === undefined
    ? (args.shares ?? [0.25, 0.6]).map((share) => fleetGb * share)
    : [Math.min(fleetGb, Math.max(0, args.prepGb))];
  const allocations = [...new Set(unconstrainedAllocations.map((prepGb) => Math.min(maxPrepGb, prepGb)))];
  const timeScale = args.prepTimeScale ?? 1;
  const horizonS = horizonMs / 1_000;
  const currentRate = farmIncomeRate(current, fleetGb);
  const candidateRate = farmIncomeRate(candidate, fleetGb);
  const reinvestmentRate = args.reinvestmentReturnPerDollarSec ?? 0;

  let best: PrepEconomics | undefined;
  for (const prepGb of allocations) {
    if (prepGb <= 0) continue;
    const share = prepGb / fleetGb;
    // Income lost while prepping: only the RAM the farm could actually USE
    // counts — when the farm is depth-capped below (1−share)·fleet, the prep
    // segment is funded entirely by surplus and costs nothing.
    const duringPrepRate = farmIncomeRate(current, fleetGb - prepGb);
    // Productive infrastructure makes the executable prep allocation grow
    // during a long investment. Scale the arbiter's marginal growth by the
    // income retained while prepping: RAM diverted from farming cannot also
    // fund the fleet growth that shortens the prep.
    const ramGrowthRate = reinvestmentRate * (currentRate > 0 ? duringPrepRate / currentRate : 0);
    const prepSeconds = prepTimeSeconds(plan, prepGb, ramGrowthRate, timeScale);
    if (!Number.isFinite(prepSeconds)) continue;
    const prepEnd = Math.min(horizonS, prepSeconds);
    // The dispatcher lends every unused reserved GB to batches that land
    // before the prep wave. Opportunity cost is therefore the work actually
    // executed by prep, not `reservation * wall time`. Existing farm surplus
    // above its depth cap absorbs that work first at zero lost income.
    const effectiveRamSec = Math.max(0, plan.ramSec * timeScale);
    const surplusGb = current ? Math.max(0, fleetGb - depthCapGb(current)) : fleetGb;
    const paidRamSec = Math.max(0, effectiveRamSec - surplusGb * prepSeconds);
    const averageLostRate = current && prepSeconds > 0 ? current.score * paidRamSec / prepSeconds : 0;
    const upgradeGain = incomePresentValue(candidateRate, prepEnd, horizonS, reinvestmentRate) -
      incomePresentValue(currentRate, prepEnd, horizonS, reinvestmentRate);
    const prepCost = incomePresentValue(averageLostRate, 0, prepEnd, reinvestmentRate);
    const net = upgradeGain - prepCost;
    if (!best || net > best.net) best = { net, prepShare: share, prepGb, prepSeconds };
  }
  return best;
}
