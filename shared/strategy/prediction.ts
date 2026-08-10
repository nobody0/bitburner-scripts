import {
  growthLogPerThread,
  growThreads,
  hackPercent,
  weakenEffect,
  type HackContext,
} from "../formulas.ts";
import { PREPPED_SEC_TOLERANCE, type CycleSolution, type TargetStatics } from "./targeting.ts";

/** Landing-state prediction — pure. The Q1 answer.
 *
 * Thread counts come from a solution solved at (minSec, moneyMax), but
 * `isPrepped` admits min+1 security and 90 % money, and in-flight ops keep
 * moving the target between launch and landing. A batch launched against the
 * LIVE state therefore under-steals and over-grows. This module folds the
 * dispatcher's own in-flight ledger forward to a future instant, so the
 * dispatcher can (a) skip a hack that would land above min security and
 * (b) resize the grow for the money that will ACTUALLY be there.
 *
 * The legacy scripts kept a cached timeline of the same fold
 * (bitburner-2023 src/_lib/simulation.ts) and inverted its cache invalidation
 * in three places, leaving the guards blind. There is deliberately NO cache
 * here: the ledger is small (hundreds of ops) and a fresh fold per launch is
 * microseconds — that is what kills the whole invalidation bug class.
 *
 * Skill is held constant across the fold (percent/effects at completion use
 * the player's then-current skill; predicting exp-driven skill growth is a
 * separate, deferred refinement). Hacks are success-assumed, matching how the
 * dispatcher sizes batches — grow cover must hold for the success case.
 * Source (effects apply after the delay, with hack success decided then): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L561-L637
 * Source (grow money/security and weaken core effect): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L286-L308 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L362-L385 */

export interface LedgerOp {
  kind: "hack" | "grow" | "weaken";
  /** REAL threads (fortify scales with these). */
  threads: number;
  /** Core-adjusted one-core-equivalent threads (grow/weaken strength). */
  effectThreads: number;
  /** ms, same clock as `view.time`. */
  landing: number;
  /** Stable tie-break for equal landings: launch order. */
  opId: number;
}

export interface PredictedState {
  hackDifficulty: number;
  moneyAvailable: number;
}

/** Fold every ledger op landing in (now, at] over `current`, in landing order.
 * opId is the model's deterministic launch-order tie-break for equal landings;
 * upstream starts cached script modules through promise continuations in exec
 * order, but Netscript does not formally specify equal-deadline ordering.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L48-L66 */
export function predictAtLanding(
  ctx: HackContext,
  statics: TargetStatics,
  current: PredictedState,
  ops: readonly LedgerOp[],
  at: number,
): PredictedState {
  const relevant = ops
    .filter((op) => op.landing <= at)
    .sort((a, b) => a.landing - b.landing || a.opId - b.opId);
  let sec = current.hackDifficulty;
  let money = current.moneyAvailable;
  const maxSec = 100;
  for (const op of relevant) {
    if (op.kind === "hack") {
      const percent = hackPercent(ctx, sec, statics.requiredHackingSkill);
      const steal = Math.min(1, op.threads * percent);
      money = Math.max(0, money * (1 - steal));
      sec = Math.min(maxSec, sec + 0.002 * op.threads);
    } else if (op.kind === "grow") {
      const k = growthLogPerThread(ctx, sec, statics.serverGrowth, 1);
      const grown = (money + op.threads) * (k === -Infinity ? 1 : Math.exp(k * op.effectThreads));
      money = Math.min(statics.moneyMax, grown);
      sec = Math.min(maxSec, sec + 0.004 * op.threads);
    } else {
      sec = Math.max(statics.minDifficulty, sec - weakenEffect(ctx, 1, 1) * op.effectThreads);
    }
  }
  return { hackDifficulty: sec, moneyAvailable: money };
}

export interface SizedBatch {
  hackThreads: number;
  weaken1Threads: number;
  growThreads: number;
  weaken2Threads: number;
}

/** Resize the cached solution for the state the batch will actually land on.
 *
 * Security above the prepped tolerance at the hack's landing means the batch
 * must not launch at all (percent and duration assumptions are broken):
 * returns undefined. Otherwise the hack keeps its solved thread count (it
 * steals a FRACTION, correct at any money level) and the grow/W2 cover is
 * re-solved from the predicted post-hack money — the piece that actually
 * drifts when `isPrepped` admits 90 % money. */
export function sizeBatchAtLanding(
  ctx: HackContext,
  statics: TargetStatics,
  predicted: PredictedState,
  base: CycleSolution,
): SizedBatch | undefined {
  if (predicted.hackDifficulty > statics.minDifficulty + PREPPED_SEC_TOLERANCE) return undefined;
  const postHack = Math.max(0, predicted.moneyAvailable * (1 - base.stealFraction));
  const securityExcess = Math.max(0, predicted.hackDifficulty - statics.minDifficulty);
  const hackFortify = 0.002 * base.hackThreads;
  const weakenPerThread = weakenEffect(ctx, 1, 1);
  // W1 makes an HWGW grow execute at minimum security, including when the
  // admitted landing state begins above minimum. HGW has no W1, so its grow
  // executes at the full predicted security plus the hack's fortify.
  const weaken1 = base.kind === "hgw"
    ? 0
    : Math.ceil((securityExcess + hackFortify) / weakenPerThread);
  const growSec = base.kind === "hgw"
    ? predicted.hackDifficulty + hackFortify
    : statics.minDifficulty;
  const k = growthLogPerThread(ctx, growSec, statics.serverGrowth, 1);
  const grow =
    statics.moneyMax > 0 && k !== -Infinity ? growThreads(k, statics.moneyMax, postHack, statics.moneyMax) : 0;
  const growCount = Number.isFinite(grow) ? grow : base.growThreads;
  const weaken2Cover = base.kind === "hgw"
    ? securityExcess + hackFortify + 0.004 * growCount
    : 0.004 * growCount;
  const weaken2 = Math.ceil(weaken2Cover / weakenPerThread);
  return {
    hackThreads: base.hackThreads,
    weaken1Threads: weaken1,
    growThreads: growCount,
    weaken2Threads: weaken2,
  };
}
