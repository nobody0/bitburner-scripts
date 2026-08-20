/** Marginal-value sizing for the fleet's divisible share tail. */
import { WORKER_RAM } from "../world.ts";
import type { MeasuredMarginal } from "./progression/marginal.ts";

/** One share thread's executable footprint. Rounding the allotment to whole
 * threads is only correct while this matches what the dispatcher actually
 * reserves and what the driver passes as `ramOverride`. */
export const SHARE_RAM_GB = WORKER_RAM.share;
export const SHARE_LOG_DIVISOR = 25;

export type { MeasuredMarginal } from "./progression/marginal.ts";

export interface ShareValueCurve {
  /** Productive hacking marginal at the current full-farm rate. */
  hackMarginal: MeasuredMarginal;
  /** BN seconds saved by one unit of share bonus at the current rep gate. */
  reputationSecondsPerBonus: number;
  /** Effective shared threads contributed by one GB on this fleet. */
  effectiveThreadsPerGb: number;
}

export interface ShareCutover extends ShareValueCurve {
  /** Unrounded marginal-curve crossing. */
  cutoverGb: number;
  /** Whole-thread allotment reserved from hacking, rounded DOWN. */
  allotmentGb: number;
  /** Share marginal at the rounded cutover. */
  shareMarginal: number;
}

export interface HackMarginalInput {
  moneySecondsPerRelativeRate: number;
  hackingSecondsPerRelativeRate: number;
  /** Absent means the getter has not landed; zero is a measured zero. */
  totalMoneyPerSec?: number;
  /** Absent means the getter has not landed; zero is a measured zero. */
  totalHackingExpPerSec?: number;
  moneyPerSecPerGb: number;
  hackingExpPerSecPerGb: number;
}

export interface SharePricingInput extends Omit<HackMarginalInput, "moneyPerSecPerGb" | "hackingExpPerSecPerGb"> {
  reputationSecondsPerBonus: number;
  /** The player's ACTIVE work already earns faction reputation. Share then
   * multiplies a rate that is being produced anyway, and its workers are
   * freely stoppable, so the dispatcher lets share consume the residual free
   * tail even when the route has not priced reputation as critical. This is a
   * fact about the present ("work.type is FACTION"), never a forecast. */
  currentWorkEarnsRep?: boolean;
}

function channelMarginal(seconds: number, total: number | undefined, perGb: number): MeasuredMarginal {
  const modeled = Math.max(0, seconds);
  const marginalRate = Math.max(0, perGb);
  if (modeled <= 0 || marginalRate <= 0) return { state: "measured", value: 0 };
  if (total === undefined) return { state: "unknown", reason: "the productive rate has not been measured" };
  if (!(total > 0)) {
    return { state: "unknown", reason: "the modeled farm can produce this resource but its measured rate is not positive yet" };
  }
  return { state: "measured", value: modeled * marginalRate / total };
}

/** Convert BN-seconds-per-relative-rate into BN-sec / wall-sec / GB. */
export function hackMarginalValue(input: HackMarginalInput): MeasuredMarginal {
  const money = channelMarginal(
    input.moneySecondsPerRelativeRate,
    input.totalMoneyPerSec,
    input.moneyPerSecPerGb,
  );
  const hacking = channelMarginal(
    input.hackingSecondsPerRelativeRate,
    input.totalHackingExpPerSec,
    input.hackingExpPerSecPerGb,
  );
  if (money.state === "unknown" || hacking.state === "unknown") {
    return {
      state: "unknown",
      reason: [money, hacking].filter((entry) => entry.state === "unknown").map((entry) => entry.reason).join("; "),
    };
  }
  return { state: "measured", value: money.value + hacking.value };
}

export function shareMarginalValue(curve: ShareValueCurve, gb: number): number {
  const c = Math.max(0, curve.effectiveThreadsPerGb);
  const k = Math.max(0, curve.reputationSecondsPerBonus) / SHARE_LOG_DIVISOR;
  return c > 0 ? k * c / (1 + c * Math.max(0, gb)) : 0;
}

/** For a gap/rate clock with rate proportional to farm RAM, removing RAM
 * raises the hacking opportunity cost as 1/remainingFarm^2. This is the same
 * `gap/rate^2 * dRate` derivative as hackMarginalValue, re-based from the
 * observed full-farm rate to a candidate split. */
export function hackMarginalAt(curve: ShareValueCurve, fleetGb: number, shareGb: number): number | undefined {
  if (curve.hackMarginal.state === "unknown") return undefined;
  const base = Math.max(0, curve.hackMarginal.value);
  if (base === 0) return 0;
  const fleet = Math.max(0, fleetGb);
  const remaining = Math.max(0, fleet - Math.max(0, shareGb));
  if (fleet <= 0 || remaining <= 0) return Infinity;
  return base * (fleet / remaining) ** 2;
}

/** Find the unique crossing between share's declining marginal and hacking's
 * rising opportunity cost. `depthCapGb` remains an ignored compatibility
 * input: one target's current pipeline cap is not idle fleet capacity. */
export function shareCutover(
  curve: ShareValueCurve,
  fleetGb: number,
  depthCapGb = Infinity,
  allotmentGb: number = SHARE_RAM_GB,
): ShareCutover {
  const fleet = Math.max(0, fleetGb);
  const c = Math.max(0, curve.effectiveThreadsPerGb);
  const k = Math.max(0, curve.reputationSecondsPerBonus) / SHARE_LOG_DIVISOR;
  const hack = curve.hackMarginal.state === "measured" ? Math.max(0, curve.hackMarginal.value) : undefined;
  // An ABSENT hacking marginal is not a zero hacking marginal.
  //
  // `hackMarginalValue` only counts money/exp seconds the forecast flagged
  // `critical`. On a reputation-bound run neither is flagged, so it returns 0
  // — and treating that as "hacking earns nothing" sent the crossing to
  // Infinity and handed share the entire fleet. Measured on bn1-progression
  // seed 1 against a true share-off control (launchShare stubbed out):
  // hacking income $15.36q -> $12.23q (-20%) for the SAME augmentation count.
  // Share bought nothing and cost a fifth of the farm.
  //
  // So an unmeasured marginal must be conservative: no crossing, no share.
  // The genuine "hacking really does earn nothing" case (BN8, where hacked
  // money is zeroed) has to arrive as a POSITIVE statement — a measured
  // income rate of zero while the farm is actually running — rather than as
  // an absent critical-path label. Until the value model can tell those two
  // apart, share stays off rather than shipping a measured regression.
  let crossing = 0;
  if (k > 0 && c > 0 && hack !== undefined) {
    if (hack === 0) crossing = fleet;
    else if (shareMarginalValue(curve, 0) > hack) {
      // Monotone intersection: share falls with g; hacking rises with g.
      // Forty-eight iterations are sub-femtobyte precision at Bitburner's RAM
      // scales and run only on the evaluator's five-second decision gate.
      let low = 0;
      let high = fleet;
      for (let iteration = 0; iteration < 48; iteration++) {
        const mid = (low + high) / 2;
        const candidateHack = hackMarginalAt(curve, fleet, mid) ?? Infinity;
        if (shareMarginalValue(curve, mid) > candidateHack) low = mid;
        else high = mid;
      }
      crossing = low;
    }
  }
  // ONLY the marginal crossing decides the split.
  //
  // A previous version also took `fleet - depthCapGb` as a lower bound, on the
  // theory that RAM past the current target's pipeline depth has zero hack
  // marginal and is therefore free. Measured on bn1-progression seed 1, that
  // was false and expensive: share claimed 130 TB, hacking income fell from
  // $18.05q to $12.23q (-32%), and the augmentation count was 10 either way —
  // so the RAM was bought at a third of the farm's income and returned
  // nothing. RAM above one target's depth cap is not idle; it is the farm's
  // growth headroom (prep for the next target, and the bigger targets skill
  // growth unlocks), which `depthCapGb` does not describe because it is scoped
  // to the CURRENT target only.
  //
  // The crossing needs no such help: if hacking's measured marginal really is
  // zero, share takes the fleet. That is the BN8 case, handled by the same
  // curve rather than a BitNode-specific rule.
  const cutoverGb = Math.min(fleet, Math.max(0, crossing));
  const whole = allotmentGb > 0 ? Math.floor((cutoverGb + 1e-12) / allotmentGb) * allotmentGb : 0;
  const rounded = Math.min(fleet, Math.max(0, whole));
  return {
    ...curve,
    cutoverGb,
    allotmentGb: rounded,
    shareMarginal: shareMarginalValue(curve, rounded),
  };
}
