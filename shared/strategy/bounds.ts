import {
  growthLogPerThread,
  hackChance,
  hackPercent,
  hackTimeSeconds,
  makeHackContext,
  weakenEffect,
  type HackContext,
} from "../formulas.ts";
import { WORKER_RAM } from "../world.ts";
import { SERVER_RANGES, type Range, type ServerRanges } from "../features/servers.ts";
import { MAX_STEAL, type TargetStatics } from "./targeting.ts";

/** Provable score bounds for the target solver.
 *
 * `scoreUpperBound` is a ~10-flop closed form that is ≥ `solveCycle(...).score`
 * for EVERY hack-thread count, both batch shapes (hwgw/hgw), every `RamCaps`
 * (caps only shrink the feasible set), and the pipeline-aware score (its launch
 * period is `max(ramSec/farmGb, ...) ≥ ramSec/farmGb`, so it never exceeds the
 * plain `E/ramSec`). That inequality is what makes candidate pruning SAFE: a
 * target whose upper bound cannot beat the incumbent farm score provably cannot
 * be picked by any decision path, so its exhaustive solve can be skipped
 * without changing any decision. The proof obligation is discharged two ways:
 * the derivation below, and the seeded adversarial sweep in
 * sim/tests/bounds.test.ts asserting `score ≤ UB` against the real solver.
 *
 * Derivation (cores = 1, the evaluator's contract). For any H ≥ 1 with
 * s = min(1, H·p):
 *
 *   income + stockIncome = c·s·(M·gain + V)            — linear in s
 *   ramSec = t_h·(1.7·H + 5.6·G + 7·(W1 + W2))          — each term ≥ κ·s:
 *     1.7·H       ≥ 1.7·s/p          (s ≤ H·p)
 *     5.6·G       ≥ 5.6·s/k_eff       (grow lower bound, below)
 *     7·(W1+W2)   ≥ 7·(0.002·s/p + 0.004·s/k_eff)/w    (ceil ≥ identity;
 *                     hgw folds both fortifies into one weaken — same sum)
 *
 * so score = c·s·(M·gain+V) / ramSec ≤ c·(M·gain+V) / (t_h·D) with s cancelled,
 * D = 1.7/p + 5.6/k_eff + (0.014/p + 0.028/k_eff)/w.
 *
 * The grow lower bound: G satisfies (m₀+G)·e^{k·G} ≥ M (pinned as a property of
 * `growThreads` by the test suite), i.e. k·G ≥ ln(M/(m₀+G)). Concavity of ln
 * gives ln(m₀+G) ≤ ln(m₀) + G/m₀, hence G·(k + 1/m₀) ≥ ln(M/m₀) = −ln(1−s) ≥ s.
 * With s ≤ s_max the post-hack money m₀ = M·(1−s) ≥ M·(1−s_max), so
 * G ≥ s/k_eff for k_eff = k + 1/(M·(1−s_max)). The +1/m₀ term is NOT a fudge
 * factor: grow adds $1/thread before multiplying, so money-poor servers really
 * do need fewer threads than the pure exponential predicts, and without the
 * term the bound is falsified by n00dles-sized targets. HGW's overscaled grow
 * (solved at min+0.002·H, a smaller k) only needs MORE threads, so the same
 * bound holds.
 *
 * When p ≥ MAX_STEAL a single hack thread can push s past s_max toward 1 and
 * m₀ toward 0; the grow term is then dropped entirely (G ≥ 0), which stays
 * sound and only loosens the bound in a regime where the target is essentially
 * free money anyway.
 *
 * NOT provided here: a component-wise dominance rule ("A beats B whenever A is
 * richer, easier and faster-growing"). It is FALSE in general — near the 95%
 * steal cap the solver's thread granularity is `floor(MAX_STEAL/p)·p`, a
 * discontinuous function of p, and in the interval/slot-floored pipeline
 * regime a marginally "better" server can lose up to ~p of steal fraction to
 * that floor while gaining arbitrarily little chance. Static removal therefore
 * never rests on dominance; everything reduces to UB-vs-achieved-score. */

const HACK_FORTIFY = 0.002;
const GROW_FORTIFY = 0.004;
/** Op-RAM seconds per hack time: hack runs 1×, grow 3.2×, weaken 4×. */
const HACK_COEF = WORKER_RAM.hack;
const GROW_COEF = WORKER_RAM.grow * 3.2;
const WEAKEN_COEF = WORKER_RAM.weaken * 4;

/** Upper bound on `solveCycle(ctx, statics, 1, anyCaps, {valuePerOp}?).score`.
 * `valuePerOp` prices stock manipulation exactly as the solver does
 * (chance·steal·valuePerOp), so manipulated hosts need no special casing. */
export function scoreUpperBound(ctx: HackContext, statics: TargetStatics, valuePerOp = 0): number {
  const { minDifficulty, moneyMax, requiredHackingSkill, serverGrowth } = statics;
  if (!(moneyMax > 0) || !(serverGrowth > 0) || requiredHackingSkill > ctx.skill) return 0;
  const p = hackPercent(ctx, minDifficulty, requiredHackingSkill);
  const c = hackChance(ctx, minDifficulty, requiredHackingSkill);
  if (p <= 0 || c <= 0) return 0;
  const tH = hackTimeSeconds(ctx, minDifficulty, requiredHackingSkill);
  const k = growthLogPerThread(ctx, minDifficulty, serverGrowth, 1);
  const w = weakenEffect(ctx, 1, 1);
  if (!(tH > 0) || !(w > 0)) return 0;

  // Largest steal fraction any thread count in the solver's domain reaches.
  const sMax = Math.min(1, Math.max(1, Math.floor(MAX_STEAL / p)) * p);
  // 1/k_eff, or 0 when the grow term must be dropped (s can approach 1).
  const growInv = sMax < 1 && k > 0 ? 1 / (k + 1 / (moneyMax * (1 - sMax))) : 0;
  const denom = HACK_COEF / p + GROW_COEF * growInv + (WEAKEN_COEF * (HACK_FORTIFY / p + GROW_FORTIFY * growInv)) / w;
  return (c * (moneyMax * ctx.scriptHackMoneyGain + Math.max(0, valuePerOp))) / (tH * denom);
}

// --- range extremes ---------------------------------------------------------

/** BitNode multipliers that shape a server at world generation. */
export interface ServerGenMults {
  ServerMaxMoney?: number;
  ServerStartingSecurity?: number;
}

/** The Server-constructor derivations (bitburner-src v3.0.1 Server.ts), from
 * one concrete roll of the metadata ranges to the statics the solver reads.
 * Single choke point: the roll-extreme helpers and every test that fabricates
 * a rolled server go through here, so a future upstream change to (say) the
 * 25× money factor breaks one function and its parity pins, not five copies. */
export function staticsFromRolls(
  hostname: string,
  rolls: { money: number; sec: number; skill: number; growth: number },
  mults: ServerGenMults = {},
): TargetStatics {
  const realDifficulty = rolls.sec * (mults.ServerStartingSecurity ?? 1);
  return {
    hostname,
    moneyMax: 25 * rolls.money * (mults.ServerMaxMoney ?? 1),
    baseDifficulty: Math.min(realDifficulty, 100),
    minDifficulty: Math.min(Math.max(1, Math.round(realDifficulty / 3)), 100),
    requiredHackingSkill: rolls.skill,
    serverGrowth: rolls.growth,
  };
}

const lo = (r: Range | undefined): number => r?.[0] ?? 0;
const hi = (r: Range | undefined): number => r?.[1] ?? 0;

/** Score-extreme statics over every possible roll of a server's ranges.
 * `best` takes each field in the score-friendly direction (rich, easy, low
 * skill, fast growth), `worst` the opposite. These are FIELD-WISE extremes for
 * interval arithmetic over the individual formulas (chance, percent, time, k),
 * each of which is monotone in its server inputs (pinned by the test suite) —
 * deliberately NOT a claim that the solved score itself is monotone. */
export function rollExtremes(hostname: string, ranges: ServerRanges, mults: ServerGenMults = {}): {
  best: TargetStatics;
  worst: TargetStatics;
} {
  return {
    best: staticsFromRolls(
      hostname,
      { money: hi(ranges.money), sec: lo(ranges.sec), skill: lo(ranges.skill), growth: hi(ranges.growth) },
      mults,
    ),
    worst: staticsFromRolls(
      hostname,
      { money: lo(ranges.money), sec: hi(ranges.sec), skill: hi(ranges.skill), growth: lo(ranges.growth) },
      mults,
    ),
  };
}

/** Guaranteed-achievable score floor: the one-hack-thread batch, priced with
 * every factor at its roll-worst value and every thread count at its roll-worst
 * (largest) bound. Sound because H = 1 is always in the solver's domain under
 * unlimited RAM, so whatever the roll, `solveCycle` returns at least this much:
 *
 *   income ≥ c_worst · min(1, p_worst) · M_worst · gain      (per-factor floors)
 *   ramSec ≤ t_worst · (1.7 + 5.6·G_hi + 7·(W1_hi + W2_hi))
 *
 * with G_hi = −ln(1 − p_best)/k_worst + 2 an upper bound on `growThreads` for
 * a refill of at most p_best: the exact solution obeys e^{k·x} = M/(m₀+x) ≤
 * M/m₀, so x ≤ −ln(1−s)/k, and the implementation returns at most ceil(x)+1
 * (pinned). W bounds use ceil(x) ≤ x+1. Used only by the band table, whose
 * contract is unlimited RAM — under a real cap the H = 1 batch of a rich
 * server may not fit, and no static floor exists at all. */
export function scoreLowerBoundH1(ctx: HackContext, worst: TargetStatics, best: TargetStatics): number {
  if (!(worst.moneyMax > 0) || !(worst.serverGrowth > 0) || worst.requiredHackingSkill > ctx.skill) return 0;
  const pWorst = hackPercent(ctx, worst.minDifficulty, worst.requiredHackingSkill);
  const cWorst = hackChance(ctx, worst.minDifficulty, worst.requiredHackingSkill);
  if (pWorst <= 0 || cWorst <= 0) return 0;
  const tWorst = hackTimeSeconds(ctx, worst.minDifficulty, worst.requiredHackingSkill);
  const kWorst = growthLogPerThread(ctx, worst.minDifficulty, worst.serverGrowth, 1);
  const w = weakenEffect(ctx, 1, 1);
  if (!(kWorst > 0) || !(w > 0)) return 0;
  const pBest = hackPercent(ctx, best.minDifficulty, best.requiredHackingSkill);
  if (pBest >= 1) return 0; // refill bound blows up; no useful floor
  const growHi = -Math.log1p(-pBest) / kWorst + 2;
  const w1Hi = HACK_FORTIFY / w + 1;
  const w2Hi = (GROW_FORTIFY * growHi) / w + 1;
  const income = cWorst * Math.min(1, pWorst) * worst.moneyMax * ctx.scriptHackMoneyGain;
  const ramSec = tWorst * (HACK_COEF + GROW_COEF * growHi + WEAKEN_COEF * (w1Hi + w2Hi));
  return income / ramSec;
}

// --- the precomputed contention table ---------------------------------------

/** One row: for hacking skill in [from, to], only `contenders` can be the
 * steady-state score argmax — for EVERY roll of the world RNG. */
export interface TargetBand {
  from: number;
  to: number;
  /** Hostnames, ordered by best-roll upper bound at the band's top skill. */
  contenders: string[];
}

export interface TargetBandOptions {
  /** World-generation multipliers (default BN1: all 1). */
  mults?: ServerGenMults;
  /** Highest skill to tabulate. Above the last breakpoint the set is stable. */
  maxSkill?: number;
  /** Multiplicative grid fill between eligibility breakpoints. Matches the
   * evaluator's SKILL_DELTA re-score threshold: the running system never
   * distinguishes skills closer than 2% either. */
  gridStep?: number;
}

/** Which servers can contest the RAM-unbound steady-state optimum, per skill
 * band, over ALL possible world rolls.
 *
 * CONTRACT (every part matters): BN1-shaped hacking formulas with neutral
 * player mults and intelligence 0; the plain $/GB/sec score with RAM not
 * binding; root access assumed; no stock manipulation (a live position can
 * promote any host — the runtime prune prices that in, this table cannot).
 * A host is excluded from a band only when its best-possible-roll upper bound
 * cannot reach the worst-possible-roll guaranteed floor of some always-eligible
 * host — both sides interval arithmetic over the pinned-monotone formulas, so
 * the exclusion holds for every roll. Grid rows are evaluated at the band's
 * edge skills and adjacent rows are merged by union, conservative in between.
 *
 * This table never gates the runtime evaluator (which prunes exactly, from
 * live rolls and the live incumbent). It exists for the cheap global question
 * "who could the farm even belong to at skill X?" — progression planning,
 * port-opener pricing, UI — asked before servers are scanned at all. */
export function computeTargetBands(opts: TargetBandOptions = {}): TargetBand[] {
  const mults = opts.mults ?? {};
  const gridStep = opts.gridStep ?? 1.02;
  const hosts = Object.entries(SERVER_RANGES)
    .filter(([, r]) => hi(r.money) > 0 && hi(r.growth) > 0)
    .map(([hostname, ranges]) => ({ hostname, ranges, ...rollExtremes(hostname, ranges, mults) }));
  const lastBreak = Math.max(...hosts.map((h) => hi(h.ranges.skill)));
  const maxSkill = opts.maxSkill ?? lastBreak + 1;

  // Grid: every eligibility edge (skill range endpoints, ±0 and +1 so both
  // sides of each flip are sampled) plus a 2% multiplicative fill.
  const points = new Set<number>([1, maxSkill]);
  for (const h of hosts) {
    for (const edge of [lo(h.ranges.skill), hi(h.ranges.skill)]) {
      if (edge >= 1 && edge <= maxSkill) points.add(edge);
      if (edge + 1 >= 1 && edge + 1 <= maxSkill) points.add(edge + 1);
    }
  }
  for (let s = 1; s < maxSkill; s = Math.max(s + 1, Math.floor(s * gridStep))) points.add(s);
  const grid = [...points].sort((a, b) => a - b);

  const contendersAt = (skill: number): { names: Set<string>; ub: Map<string, number> } => {
    const ctx = makeHackContext(
      { skill, intelligence: 0, mults: { hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1 } },
      {},
    );
    const ub = new Map<string, number>();
    for (const h of hosts) {
      // Best roll must also be an ELIGIBLE roll: the skill requirement can
      // roll as low as its range minimum, no lower.
      if (lo(h.ranges.skill) > skill) continue;
      const bound = scoreUpperBound(ctx, h.best);
      if (bound > 0) ub.set(h.hostname, bound);
    }
    // The floor only counts hosts eligible in EVERY roll (skill-range top ≤
    // current skill); a maybe-eligible host guarantees nothing.
    let floor = 0;
    for (const h of hosts) {
      if (hi(h.ranges.skill) > skill) continue;
      floor = Math.max(floor, scoreLowerBoundH1(ctx, h.worst, h.best));
    }
    const names = new Set<string>();
    for (const [name, bound] of ub) if (bound >= floor) names.add(name);
    return { names, ub };
  };

  const bands: TargetBand[] = [];
  let prev = contendersAt(grid[0]!);
  for (let i = 1; i < grid.length; i++) {
    const next = contendersAt(grid[i]!);
    const union = new Set([...prev.names, ...next.names]);
    const order = (name: string): number => next.ub.get(name) ?? prev.ub.get(name) ?? 0;
    const contenders = [...union].sort((a, b) => order(b) - order(a) || (a < b ? -1 : 1));
    const last = bands[bands.length - 1];
    if (last && last.contenders.length === contenders.length && last.contenders.every((n, j) => n === contenders[j])) {
      last.to = grid[i]!;
    } else {
      bands.push({ from: grid[i - 1]!, to: grid[i]!, contenders });
    }
    prev = next;
  }
  return bands;
}
