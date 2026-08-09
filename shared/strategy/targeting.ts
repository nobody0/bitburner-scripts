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
 * Pure math on shared/formulas.ts. Small domains are exhaustively searched;
 * large ones use a bounded grid/refinement search. Both stay inside the
 * refresh budgets pinned by sim/tests/targeting.test.ts.
 *
 * Scores are $/GB/sec at the PREPPED steady state (minSec, moneyMax): the
 * right unit for a RAM-bound dispatcher. The insight came from an earlier
 * rewrite's `analyze-profit.js` (`nobody0/bitburner`, no longer checked out —
 * see README's citation note); we compute it with exact thread counts instead
 * of its log-approximation. The predecessor scripts on disk score differently
 * and arguably better — `src/_lib/optimizer.ts:123` weights money per thread by
 * op duration, `(moneyHack + moneyStocks)·hackChance / (1 + growPerHack·3.2 +
 * weakPerHack·4) / hackTime`, which prices grow and weaken holding RAM longer.
 * spec/progress.md tracks that as an open audit question.
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

/** Stock manipulation priced for the target solver.
 *
 * `valuePerOp` is dollars of stock profit per influencing op at a steal fraction
 * of 1; the solver multiplies by the steal fraction its own batch achieves, which
 * is exactly the probability `influenceStockThroughServer*` rolls against.
 *
 * The consequence that inverts ordinary target selection: that probability is
 * `moneyMoved / server.moneyMax`, a FRACTION, so `moneyMax` cancels out of the
 * manipulation rate entirely. Two servers with the same steal fraction and batch
 * time manipulate their symbols equally well however much money they hold — which
 * makes `joesguns` (JGN) and `foodnstuff` (FNS) the cheapest manipulators in the
 * game, at a small fraction of `ecorp`'s threads and batch time.
 *
 * Not scaled by `ScriptHackMoneyGain`, and that is the point of keeping the two
 * income terms apart: the player's cut applies to the hacking half only, because
 * influence is computed from `moneyDrained` before the cut. In BN8 the cut is 0 —
 * hacking earns literally nothing while manipulating at near-full strength — and
 * that asymmetry is the node. */
export interface ManipulationValue {
  valuePerOp: number;
  /** Long positions are driven by GROW, shorts by HACK. Determines which op
   *  carries the flag, and therefore which op count the value multiplies. */
  side: "long" | "short";
}

/** Batch shape a solution was solved for. HWGW is the default; HGW drops the
 * first weaken (the grow is overscaled to fight the hack's security rise, the
 * single weaken covers both fortifies) — a worse $/GB/sec but 3 processes per
 * batch instead of 4, which is what matters when the BROWSER's process count
 * is the binding constraint. */
export type CycleKind = "hwgw" | "hgw";

export interface CycleSolution {
  kind: CycleKind;
  /** True when every feasible integer hack-thread count was evaluated. */
  exact: boolean;
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
  /** Expected $ per batch from stock manipulation, when this target's
   *  organization has a position riding on it. Reported separately from
   *  `incomePerBatch` because the two respond to different BitNode multipliers
   *  and a target that is worth farming ONLY for its price impact should be
   *  visibly so. */
  stockIncomePerBatch: number;
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
  stockIncome: number;
  ram: number;
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;
const MAX_STEAL = 0.95;
/** Exhaustive integer search is cheap enough below this inclusive boundary. */
export const EXACT_THREAD_LIMIT = 1_024;

/** One batch per pipeline lane per interval, in seconds. The dispatcher's
 * INTERVAL_MS is derived from this (4 spacers of 200 ms), so the solver's
 * launch-rate floor and the dispatcher's anchor spacing cannot drift apart. */
export const BATCH_INTERVAL_S = 0.8;
/** HGW batches have three landings, so their interval is 3 spacers. */
export const HGW_INTERVAL_S = 0.6;

/** RAM feasibility caps. A batch that cannot be placed is worthless however
 * well it scores, so the search only considers placeable thread counts:
 * `batchGb` bounds the whole batch, `hackBlockGb` bounds the hack op alone —
 * hack must land as ONE call (splitting it compounds the steal fraction and
 * would desync the grow sizing), so it is limited by the largest single host. */
export interface RamCaps {
  batchGb: number;
  hackBlockGb: number;
  /** FREE GB per host, descending (a bounded prefix is fine). When present
   * together with `farmGb`, the score becomes pipeline-aware: a hack block so
   * large that only one host can hold one caps the LAUNCH RATE — however well
   * the batch scores per RAM-second — because every op holds its RAM from
   * launch until it lands ~weakenTime later. */
  hostBlocksGb?: number[];
  /** GB the farm segment actually gets; the launch-rate denominator. */
  farmGb?: number;
}

export const UNLIMITED_RAM: RamCaps = { batchGb: Infinity, hackBlockGb: Infinity };

/** Solve the steady-state HWGW cycle for one target.
 *
 * UNIT CONTRACT: thread counts are ONE-CORE EFFECT UNITS. The evaluator always
 * solves at `cores = 1`; the heap's `coreAware` allocation converts effect
 * units to real threads per host (grow/weaken get the core bonus, hack never
 * does). Solving at home's core count instead would overshoot whenever an op
 * spills to a 1-core host — do not "fix" the pessimism that way. The residual
 * cost of the contract is scoring only: ramSec slightly overestimates
 * grow/weaken RAM on a multi-core home, near-uniformly across targets. */
export function solveCycle(
  ctx: HackContext,
  statics: TargetStatics,
  cores = 1,
  caps: RamCaps = UNLIMITED_RAM,
  /** Present when `stock` holds (or wants) a position in this target's
   *  organization. Adds a second income term to the SAME `$/GB/sec` score, so
   *  the two ways a target makes money are traded off on one scale instead of
   *  the market silently commandeering the farm. */
  manipulation?: ManipulationValue,
  /** Batch shape. "hgw" overscales the grow against the hack's security rise
   *  and sizes ONE weaken to cover both fortifies; landing order H→G→W a
   *  spacer apart, so the batch interval is 3 spacers instead of 4. */
  kind: CycleKind = "hwgw",
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
  const intervalS = kind === "hgw" ? HGW_INTERVAL_S : BATCH_INTERVAL_S;

  const stealBound = Math.max(1, Math.floor(MAX_STEAL / percent));
  const hackBlockBound = Number.isFinite(caps.hackBlockGb)
    ? Math.floor(caps.hackBlockGb / WORKER_RAM.hack)
    : Infinity;
  // The other three operations consume additional RAM, so this is a finite
  // upper bound, not a claim that every count below it is feasible.
  const batchBound = Number.isFinite(caps.batchGb) ? Math.floor(caps.batchGb / WORKER_RAM.hack) : Infinity;
  const maxThreads = Math.min(stealBound, hackBlockBound, batchBound);
  if (maxThreads < 1) return undefined;

  const evalThreads = (hackThreads: number): CycleEval | undefined => {
    if (hackThreads < 1) return undefined;
    const steal = Math.min(1, hackThreads * percent);
    const postHack = moneyMax * (1 - steal);
    // HGW: no weaken lands between the hack and the grow, so the grow fires
    // at min + 0.002·H — weaker growth per thread, hence the OVERSCALE. The
    // single weaken covers both fortifies.
    const growK = kind === "hgw" ? growthLogPerThread(ctx, minDifficulty + 0.002 * hackThreads, serverGrowth, cores) : k;
    if (growK === -Infinity) return undefined;
    const growThreadCount = growThreads(growK, moneyMax, postHack, moneyMax);
    if (!Number.isFinite(growThreadCount)) return undefined;
    const weaken1 = kind === "hgw" ? 0 : Math.ceil((0.002 * hackThreads) / weakenPerThread);
    const weaken2 =
      kind === "hgw"
        ? Math.ceil((0.002 * hackThreads + 0.004 * growThreadCount) / weakenPerThread)
        : Math.ceil((0.004 * growThreadCount) / weakenPerThread);
    // ScriptHackMoneyGain, NOT ScriptHackMoney: the latter is already folded
    // into `percent` (and therefore `steal`, which sizes the grow). This is the
    // player's cut of what was drained, and it is 0 in BN8 — where the farm
    // still has to run, for experience and for price manipulation, but earns
    // nothing while doing it.
    const income = chance * steal * moneyMax * ctx.scriptHackMoneyGain;
    // One influencing op per batch, and only one: the hack takes what the grow
    // puts back, so flagging both would cancel the nudges out. The roll is
    // against the FRACTION of moneyMax moved, which is `steal` on either side —
    // and BOTH sides carry the hack chance: a failed hack drains nothing (no
    // short influence), and it leaves the server at moneyMax so the paired
    // grow moves a zero fraction (no long influence either). Fixes the
    // long-side overvaluation spec/targeting.md used to acknowledge.
    const stockIncome = manipulation ? chance * steal * manipulation.valuePerOp : 0;
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
    let score = (income + stockIncome) / ramSec;
    if (caps.farmGb !== undefined && Number.isFinite(caps.farmGb) && caps.farmGb > 0 && caps.hostBlocksGb) {
      // Pipeline-aware score. The dispatcher execs all four ops at launch, so
      // each holds its RAM until it lands ~weakenTime later; a contiguous hack
      // slot therefore serves at most one batch per weakenTime. With S slots
      // the launch period cannot beat weakenTime/S no matter how much total
      // RAM is free — the regime behind the 32 GB-home stall, where a hack
      // block sized to the whole home had exactly one slot and the pipeline
      // collapsed to depth 1. The period also floors at the batch interval
      // and at the RAM-bound rate; when RAM binds, the score degenerates to
      // exactly income/ramSec, so small fleets are unaffected.
      const weakenTimeS = 4 * hackTimeS;
      const slotsNeeded = Math.max(1, Math.ceil(weakenTimeS / intervalS));
      let slots = 0;
      for (const hostGb of caps.hostBlocksGb) {
        slots += Math.floor(hostGb / hackGb);
        if (slots >= slotsNeeded) break; // beyond full depth, slots are free
      }
      if (slots < 1) return undefined;
      const period = Math.max(ramSec / caps.farmGb, weakenTimeS / slots, intervalS);
      score = (income + stockIncome) / (period * caps.farmGb);
    }
    return {
      score,
      hackThreads,
      growThreadCount,
      weaken1,
      weaken2,
      steal,
      income,
      stockIncome,
      ram,
    };
  };

  const better = (candidate: CycleEval | undefined, incumbent: CycleEval | undefined): candidate is CycleEval =>
    candidate !== undefined &&
    (incumbent === undefined ||
      candidate.score > incumbent.score ||
      (candidate.score === incumbent.score && candidate.hackThreads < incumbent.hackThreads));

  const finish = (best: CycleEval, exact: boolean): CycleSolution => ({
    kind,
    exact,
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
    stockIncomePerBatch: best.stockIncome,
  });

  if (maxThreads <= EXACT_THREAD_LIMIT) {
    let exactBest: CycleEval | undefined;
    for (let threads = 1; threads <= maxThreads; threads++) {
      const candidate = evalThreads(threads);
      if (better(candidate, exactBest)) exactBest = candidate;
    }
    return exactBest ? finish(exactBest, true) : undefined;
  }

  const threadsFor = (s: number): number => Math.min(maxThreads, Math.max(1, Math.round(s / percent)));
  const evalSteal = (s: number): CycleEval | undefined => evalThreads(threadsFor(s));

  // 16-point grid, uniform in u = -log(1-s) over [one thread, MAX_STEAL].
  // Infeasible (too-large) candidates simply score nothing, so the search
  // naturally settles on the largest batch that fits.
  const sLow = Math.min(percent, MAX_STEAL);
  const uLow = -Math.log1p(-sLow);
  const uHigh = -Math.log1p(-MAX_STEAL);
  let best: CycleEval | undefined;
  let bestU = uLow;
  const promising = new Set<number>();
  for (let i = 0; i < 16; i++) {
    const u = uLow + ((uHigh - uLow) * i) / 15;
    const candidate = evalSteal(1 - Math.exp(-u));
    if (candidate) promising.add(candidate.hackThreads);
    if (better(candidate, best)) {
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
    let hi = maxThreads;
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
    if (eval1) promising.add(eval1.hackThreads);
    if (eval2) promising.add(eval2.hackThreads);
    if ((eval1?.score ?? -1) >= (eval2?.score ?? -1)) hi = mid2;
    else lo = mid1;
    const mid = evalSteal(1 - Math.exp(-(lo + hi) / 2));
    if (mid) promising.add(mid.hackThreads);
    if (better(mid, best)) best = mid;
  }

  // The large domain remains heuristic, but every promising continuous/grid
  // point gets a bounded integer neighborhood rather than a one-step snap.
  promising.add(best.hackThreads);
  for (const center of promising) {
    for (let candidateThreads = Math.max(1, center - 8); candidateThreads <= Math.min(maxThreads, center + 8); candidateThreads++) {
      const candidate = evalThreads(candidateThreads);
      if (better(candidate, best)) best = candidate;
    }
  }

  return finish(best, false);
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
