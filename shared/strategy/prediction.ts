import {
  GROW_FORTIFY,
  growthLogPerThread,
  HACK_FORTIFY,
  growThreads,
  hackPercent,
  weakenEffect,
  skillFromExp,
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
  /** Conservative real-thread ceiling when placement is still pending. Grow
   * may move from a high-core host to a one-core host before JIT launch; its
   * money effect remains core-adjusted, but its security cost can increase. */
  fortifyThreads?: number;
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
    .sort(compareLedgerOps);
  let state = current;
  for (const op of relevant) state = applyLedgerOp(ctx, statics, state, op);
  return state;
}

/** Landing order, with opId as the deterministic tie-break. Exported so an
 * incremental fold sorts by exactly the same key as the whole-ledger one. */
export function compareLedgerOps(a: LedgerOp, b: LedgerOp): number {
  return a.landing - b.landing || a.opId - b.opId;
}

/** Fold ONE op over a state. The single definition of what an in-flight
 * operation does to its target, shared by the whole-ledger fold above and by
 * the dispatcher's incremental cursor — a second copy would be free to drift,
 * and the two are compared against each other by the dispatcher tests. */
export function applyLedgerOp(
  ctx: HackContext,
  statics: TargetStatics,
  state: PredictedState,
  op: LedgerOp,
): PredictedState {
  const maxSec = 100;
  let sec = state.hackDifficulty;
  let money = state.moneyAvailable;
  if (op.kind === "hack") {
    const percent = hackPercent(ctx, sec, statics.requiredHackingSkill);
    const steal = Math.min(1, op.threads * percent);
    money = Math.max(0, money * (1 - steal));
    sec = Math.min(maxSec, sec + HACK_FORTIFY * (op.fortifyThreads ?? op.threads));
  } else if (op.kind === "grow") {
    const k = growthLogPerThread(ctx, sec, statics.serverGrowth, 1);
    const grown = (money + op.threads) * (k === -Infinity ? 1 : Math.exp(k * op.effectThreads));
    money = Math.min(statics.moneyMax, grown);
    sec = Math.min(maxSec, sec + GROW_FORTIFY * (op.fortifyThreads ?? op.threads));
  } else {
    sec = Math.max(statics.minDifficulty, sec - weakenEffect(ctx, 1, 1) * op.effectThreads);
  }
  return { hackDifficulty: sec, moneyAvailable: money };
}

export interface SkillProjectionInput {
  hackingExp: number;
  /** Measured hacking exp per SECOND (EMA). Zero/absent = no projection. */
  expPerSec: number;
  /** `mults.hacking` times the BitNode's HackingLevelMultiplier. Folding the
   * node mult in is not optional: it is 0.35 in BN4 and 0.25 in BN9, so
   * omitting it over-projects the level roughly threefold. */
  hackingMult: number;
  currentSkill: number;
}

/** Hacking level `horizonMs` from now, at the measured experience rate.
 *
 * Hack DURATION is fixed when the Netscript call is made, and the dispatcher
 * already recomputes durations live per pass. Hack PERCENTAGE is different: it
 * is evaluated when the hack LANDS. A batch solved at level L therefore
 * over-steals if it lands at L+n, and its grow cover — sized for the smaller
 * steal — no longer restores the server.
 *
 * Never returns less than the current skill: the projection exists to shrink a
 * hack, and skewing it late (over-estimating the level) under-steals, which is
 * the recoverable direction. Reference: batchRunner.ts:317-327. */
export function projectedSkill(input: SkillProjectionInput, horizonMs: number): number {
  if (!(input.expPerSec > 0) || !(horizonMs > 0) || !Number.isFinite(horizonMs)) {
    return input.currentSkill;
  }
  const projected = skillFromExp(
    input.hackingExp + input.expPerSec * (horizonMs / 1_000),
    input.hackingMult,
  );
  return Math.max(input.currentSkill, projected);
}

export interface SizedBatch {
  hackThreads: number;
  weaken1Threads: number;
  growThreads: number;
  weaken2Threads: number;
}

/** Re-check the only destructive operation against its predicted arrival
 * state. Security invalidates the duration/percent solve entirely; short
 * money instead removes the threads which would have drained the missing
 * fraction of max money. The caller may still cap this result to an earlier
 * planning-time size, but must never send more than this many threads. */
export function hackThreadsAtLanding(
  ctx: HackContext,
  statics: TargetStatics,
  predicted: PredictedState,
  plannedThreads: number,
): number | undefined {
  if (predicted.hackDifficulty > statics.minDifficulty + PREPPED_SEC_TOLERANCE) return undefined;
  if (statics.moneyMax <= 0 || plannedThreads <= 0) return 0;
  const missingFraction = Math.max(0, 1 - predicted.moneyAvailable / statics.moneyMax);
  if (missingFraction <= 0) return plannedThreads;
  const percentPerThread = hackPercent(ctx, predicted.hackDifficulty, statics.requiredHackingSkill);
  if (percentPerThread <= 0) return 0;
  // Unrounded. The result is a thread STRENGTH, passed to Netscript as a
  // fractional `opts.threads`, so rounding the correction up would over-shrink
  // by as much as a whole thread — on a small hack that is a large fraction of
  // the steal, given up for nothing.
  return Math.max(0, plannedThreads - missingFraction / percentPerThread);
}

/** Re-derive a grow's strength against the state it will actually land on.
 *
 * Grow is the second dynamic operation. Its planned size was solved against a
 * predicted post-hack money that any number of things can move before it
 * launches: the hack ahead of it shrank on the arrival-money brake, a level-up
 * changed what that hack stole, an earlier batch landed out of order, or an
 * out-of-band reward topped the server up.
 *
 * Both directions matter, and they are not symmetric:
 *
 * - **Too much grow** is not free. Growth clamps at `moneyMax`, so the surplus
 *   buys nothing, but the security it adds is real — `GROW_FORTIFY` per thread,
 *   charged whether or not the money had anywhere to go. The already-committed
 *   W2 was sized for the PLANNED grow, so an over-grow is the one error that
 *   can outrun its own cover and leave the target above minimum for the next
 *   batch to trip over.
 * - **Too little grow** only costs money, and only until the next batch: the
 *   server comes back short, and the following hack's own arrival-money brake
 *   sizes itself down to match.
 *
 * So the clamp is asymmetric by construction. `coverThreads` is what the
 * committed weaken can actually neutralise; the result never exceeds it, even
 * when the money says a larger grow would pay. Under-growing is recoverable,
 * over-fortifying is what starts a spiral.
 *
 * Weaken has no equivalent of this function on purpose: it always runs at its
 * full spawned strength. Once its RAM is committed the threads are paid for,
 * over-weakening clamps harmlessly at `minDifficulty`, and the surplus IS the
 * ordering insurance described in spec/jit-reference.md section 2.
 *
 * Returns undefined when arrival security is above tolerance — same contract as
 * `hackThreadsAtLanding`, and the same meaning: do not launch. */
export function growThreadsAtLanding(
  ctx: HackContext,
  statics: TargetStatics,
  predicted: PredictedState,
  /** Effect units this grow was spawned with — the hard upper bound, since
   * `opts.threads` may never exceed the process's own thread count. */
  plannedThreads: number,
  /** Largest grow the committed weaken cover can neutralise, in effect units. */
  coverThreads: number,
): number | undefined {
  if (predicted.hackDifficulty > statics.minDifficulty + PREPPED_SEC_TOLERANCE) return undefined;
  if (statics.moneyMax <= 0 || plannedThreads <= 0) return 0;
  if (predicted.moneyAvailable >= statics.moneyMax) return 0;
  const k = growthLogPerThread(ctx, predicted.hackDifficulty, statics.serverGrowth, 1);
  if (k === -Infinity) return plannedThreads;
  const required = growThreads(k, statics.moneyMax, predicted.moneyAvailable, statics.moneyMax);
  if (!Number.isFinite(required)) return plannedThreads;
  // Unrounded, for the same reason hackThreadsAtLanding is: this is a
  // fractional strength, and rounding it up would spend a whole thread of
  // fortify the cover was not sized for.
  return Math.max(0, Math.min(required, plannedThreads, coverThreads));
}

/** Resize the cached solution for the state the batch will actually land on.
 *
 * Security above the prepped tolerance at the hack's landing means the batch
 * must not launch at all (percent and duration assumptions are broken):
 * returns undefined. Otherwise retain the full planned H while re-solving
 * support from the lower predicted state. H is shrunk only at its actual
 * dispatch boundary, after its already-scheduled support has become sunk. */
export function sizeBatchAtLanding(
  ctx: HackContext,
  statics: TargetStatics,
  predicted: PredictedState,
  base: CycleSolution,
): SizedBatch | undefined {
  if (predicted.hackDifficulty > statics.minDifficulty + PREPPED_SEC_TOLERANCE) return undefined;
  const postHack = Math.max(0, predicted.moneyAvailable * (1 - base.stealFraction));
  const securityExcess = Math.max(0, predicted.hackDifficulty - statics.minDifficulty);
  const hackFortify = HACK_FORTIFY * base.hackThreads;
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
    ? securityExcess + hackFortify + GROW_FORTIFY * growCount
    : GROW_FORTIFY * growCount;
  const weaken2 = Math.ceil(weaken2Cover / weakenPerThread);
  return {
    hackThreads: base.hackThreads,
    weaken1Threads: weaken1,
    growThreads: growCount,
    weaken2Threads: weaken2,
  };
}
