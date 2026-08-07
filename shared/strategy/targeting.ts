import {
  growthLogPerThread,
  growThreads,
  hackChance,
  hackPercent,
  hackTimeSeconds,
  weakenEffect,
  type HackContext,
} from "../formulas.ts";
import { WORKER_RAM } from "../world.ts";

/** Per-target strategy solve — the inner half of "find the optimal target".
 * Pure math on shared/formulas.ts; ~27 evaluations per target (16-pt grid in
 * -log(1-s) + golden-section refine + integer snap), budget ~50µs.
 *
 * Scores are $/GB/sec at the PREPPED steady state (minSec, moneyMax): the
 * right unit for a RAM-bound dispatcher (legacy analyze-profit's insight),
 * computed with exact thread counts instead of its log-approximation.
 *
 * RAM-seconds are UNWEIGHTED by hack chance: our HWGW batches always launch
 * all four ops (the RAM is spent whether the hack lands or not); only income
 * carries the chance factor. */

export interface TargetStatics {
  hostname: string;
  minDifficulty: number;
  moneyMax: number;
  requiredHackingSkill: number;
  serverGrowth: number;
  baseDifficulty: number;
}

export interface CycleSolution {
  /** Effective steal fraction per successful hack (H * percent, capped). */
  stealFraction: number;
  hackThreads: number;
  weaken1Threads: number;
  growThreads: number;
  weaken2Threads: number;
  hackTimeS: number;
  growTimeS: number;
  weakenTimeS: number;
  chance: number;
  /** $/GB/sec at steady state — the ranking key. */
  score: number;
  /** GB when all four ops of one batch are in flight. */
  ramPerBatch: number;
  /** Expected $ per batch (chance-weighted). */
  incomePerBatch: number;
}

export interface PrepPlan {
  weaken1Threads: number;
  growThreads: number;
  weaken2Threads: number;
  /** GB·s to execute the whole prep. */
  ramSec: number;
  /** Latency floor: even with infinite RAM prep takes one weaken. */
  weakenTimeS: number;
  totalRamGb: number;
  /** Already at min security and >= 90% money? */
  prepped: boolean;
}

export function isEligible(ctx: HackContext, statics: TargetStatics): boolean {
  return (
    statics.moneyMax > 0 &&
    statics.requiredHackingSkill <= ctx.skill &&
    hackPercent(ctx, statics.minDifficulty, statics.requiredHackingSkill) > 0 &&
    statics.serverGrowth > 0
  );
}

interface CycleEval {
  score: number;
  hackThreads: number;
  growThreadCount: number;
  weaken1: number;
  weaken2: number;
  steal: number;
  income: number;
  ram: number;
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;
const MAX_STEAL = 0.95;

/** RAM feasibility caps. A batch that cannot be placed is worthless however
 * well it scores, so the search only considers placeable thread counts:
 * `batchGb` bounds the whole batch, `hackBlockGb` bounds the hack op alone —
 * hack must land as ONE call (splitting it compounds the steal fraction and
 * would desync the grow sizing), so it is limited by the largest single host. */
export interface RamCaps {
  batchGb: number;
  hackBlockGb: number;
}

export const UNLIMITED_RAM: RamCaps = { batchGb: Infinity, hackBlockGb: Infinity };

export function solveCycle(
  ctx: HackContext,
  statics: TargetStatics,
  cores = 1,
  caps: RamCaps = UNLIMITED_RAM,
): CycleSolution | undefined {
  if (!isEligible(ctx, statics)) return undefined;
  const { minDifficulty, moneyMax, requiredHackingSkill, serverGrowth } = statics;
  const percent = hackPercent(ctx, minDifficulty, requiredHackingSkill);
  const chance = hackChance(ctx, minDifficulty, requiredHackingSkill);
  if (chance <= 0) return undefined;
  const k = growthLogPerThread(ctx, minDifficulty, serverGrowth, cores);
  if (k === -Infinity) return undefined;
  const hackTimeS = hackTimeSeconds(ctx, minDifficulty, requiredHackingSkill);
  const weakenPerThread = weakenEffect(ctx, 1, cores);

  const evalThreads = (hackThreads: number): CycleEval | undefined => {
    if (hackThreads < 1) return undefined;
    const steal = Math.min(1, hackThreads * percent);
    const postHack = moneyMax * (1 - steal);
    const growThreadCount = growThreads(k, moneyMax, postHack, moneyMax);
    if (!Number.isFinite(growThreadCount)) return undefined;
    const weaken1 = Math.ceil((0.002 * hackThreads) / weakenPerThread);
    const weaken2 = Math.ceil((0.004 * growThreadCount) / weakenPerThread);
    const income = chance * steal * moneyMax;
    // RAM-seconds: op RAM held for its own duration (1x/3.2x/4x hack time).
    const ramSec =
      hackTimeS *
      (WORKER_RAM.hack * hackThreads +
        WORKER_RAM.grow * 3.2 * growThreadCount +
        WORKER_RAM.weaken * 4 * (weaken1 + weaken2));
    if (ramSec <= 0) return undefined;
    const hackGb = WORKER_RAM.hack * hackThreads;
    if (hackGb > caps.hackBlockGb) return undefined;
    const ram = hackGb + WORKER_RAM.grow * growThreadCount + WORKER_RAM.weaken * (weaken1 + weaken2);
    if (ram > caps.batchGb) return undefined;
    return {
      score: income / ramSec,
      hackThreads,
      growThreadCount,
      weaken1,
      weaken2,
      steal,
      income,
      ram,
    };
  };

  const threadsFor = (s: number): number => Math.max(1, Math.round(s / percent));
  const evalSteal = (s: number): CycleEval | undefined => evalThreads(threadsFor(s));

  // 16-point grid, uniform in u = -log(1-s) over [one thread, MAX_STEAL].
  // Infeasible (too-large) candidates simply score nothing, so the search
  // naturally settles on the largest batch that fits.
  const sLow = Math.min(percent, MAX_STEAL);
  const uLow = -Math.log1p(-sLow);
  const uHigh = -Math.log1p(-MAX_STEAL);
  let best: CycleEval | undefined;
  let bestU = uLow;
  for (let i = 0; i < 16; i++) {
    const u = uLow + ((uHigh - uLow) * i) / 15;
    const candidate = evalSteal(1 - Math.exp(-u));
    if (candidate && (!best || candidate.score > best.score)) {
      best = candidate;
      bestU = u;
    }
  }
  if (!best) {
    // Every grid point was too big for the RAM cap. Batch RAM is monotonic in
    // hack threads and score rises with steal fraction below the unconstrained
    // optimum, so the largest feasible batch is the best one — bisect for it.
    if (!evalThreads(1)) return undefined;
    let lo = 1;
    let hi = threadsFor(MAX_STEAL);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (evalThreads(mid)) lo = mid;
      else hi = mid - 1;
    }
    best = evalThreads(lo);
    if (!best) return undefined;
  }

  // Golden-section refine around the best grid point (unimodal in practice;
  // the value-only search tolerates the growth-log cap discontinuity).
  const step = (uHigh - uLow) / 15;
  let lo = Math.max(uLow, bestU - step);
  let hi = Math.min(uHigh, bestU + step);
  for (let i = 0; i < 8; i++) {
    const mid1 = hi - GOLDEN * (hi - lo);
    const mid2 = lo + GOLDEN * (hi - lo);
    const eval1 = evalSteal(1 - Math.exp(-mid1));
    const eval2 = evalSteal(1 - Math.exp(-mid2));
    if ((eval1?.score ?? -1) >= (eval2?.score ?? -1)) hi = mid2;
    else lo = mid1;
    const mid = evalSteal(1 - Math.exp(-(lo + hi) / 2));
    if (mid && mid.score > best.score) best = mid;
  }

  // Integer snap: the solution space is integer hack threads.
  for (const candidateThreads of [best.hackThreads - 1, best.hackThreads + 1]) {
    const candidate = evalThreads(candidateThreads);
    if (candidate && candidate.score > best.score) best = candidate;
  }

  return {
    stealFraction: best.steal,
    hackThreads: best.hackThreads,
    weaken1Threads: best.weaken1,
    growThreads: best.growThreadCount,
    weaken2Threads: best.weaken2,
    hackTimeS,
    growTimeS: 3.2 * hackTimeS,
    weakenTimeS: 4 * hackTimeS,
    chance,
    score: best.score,
    ramPerBatch: best.ram,
    incomePerBatch: best.income,
  };
}

export const PREPPED_SEC_TOLERANCE = 1;
export const PREPPED_MONEY_FRACTION = 0.9;

/** "Ready to farm": at (or within tolerance of) min security and near max
 * money. Single definition — the evaluator, the prep planner and the
 * dispatcher must all agree on what prepped means. */
export function isPrepped(state: {
  hackDifficulty: number;
  minDifficulty: number;
  moneyAvailable: number;
  moneyMax: number;
}): boolean {
  return (
    state.hackDifficulty <= state.minDifficulty + PREPPED_SEC_TOLERANCE &&
    state.moneyAvailable >= PREPPED_MONEY_FRACTION * state.moneyMax
  );
}

/** Threads to take a target from its CURRENT state to (minSec, moneyMax).
 * Landing order W1 -> G -> W2; grow threads are solved at min security
 * (post-W1), matching the dispatch order. */
export function solvePrep(
  ctx: HackContext,
  statics: TargetStatics,
  current: { hackDifficulty: number; moneyAvailable: number },
  cores = 1,
): PrepPlan {
  const weakenPerThread = weakenEffect(ctx, 1, cores);
  const weakenTimeS = 4 * hackTimeSeconds(ctx, current.hackDifficulty, statics.requiredHackingSkill);
  const weaken1Threads = Math.max(0, Math.ceil((current.hackDifficulty - statics.minDifficulty) / weakenPerThread));

  const k = growthLogPerThread(ctx, statics.minDifficulty, statics.serverGrowth, cores);
  const grow = statics.moneyMax > 0 ? growThreads(k, statics.moneyMax, current.moneyAvailable, statics.moneyMax) : 0;
  const growCount = Number.isFinite(grow) ? grow : 0;
  const weaken2Threads = Math.ceil((0.004 * growCount) / weakenPerThread);

  const hackTimeAtMin = hackTimeSeconds(ctx, statics.minDifficulty, statics.requiredHackingSkill);
  const ramSec =
    weakenTimeS * WORKER_RAM.weaken * weaken1Threads +
    3.2 * hackTimeAtMin * WORKER_RAM.grow * growCount +
    4 * hackTimeAtMin * WORKER_RAM.weaken * weaken2Threads;

  return {
    weaken1Threads,
    growThreads: growCount,
    weaken2Threads,
    ramSec,
    weakenTimeS,
    totalRamGb: WORKER_RAM.weaken * (weaken1Threads + weaken2Threads) + WORKER_RAM.grow * growCount,
    prepped: isPrepped({
      hackDifficulty: current.hackDifficulty,
      minDifficulty: statics.minDifficulty,
      moneyAvailable: current.moneyAvailable,
      moneyMax: statics.moneyMax,
    }),
  };
}

/** prepTime = max(latency floor, RAM-seconds / prep segment GB). */
export function prepTimeSeconds(plan: PrepPlan, prepGb: number): number {
  if (plan.prepped) return 0;
  if (prepGb <= 0) return Infinity;
  return Math.max(plan.weakenTimeS, plan.ramSec / prepGb);
}
