import { describe, expect, test } from "bun:test";
import {
  growThreads,
  growthLogPerThread,
  hackChance,
  hackPercent,
  hackTimeSeconds,
  makeHackContext,
  type HackContext,
  type HackNodeMults,
} from "../../shared/formulas.ts";
import { solveCycle, type CycleKind, type RamCaps, type TargetStatics } from "../../shared/strategy/targeting.ts";
import { scoreUpperBound, staticsFromRolls, type ServerGenMults } from "../../shared/strategy/bounds.ts";
import { SERVER_RANGES, type Range } from "../../shared/features/servers.ts";
import { mulberry32 } from "../core/rng.ts";

/** The proof suite for shared/strategy/bounds.ts.
 *
 * The pruning claim — "a target whose upper bound is below the incumbent score
 * cannot be picked, so skipping its solve changes nothing" — rests on the
 * inequality `solveCycle(...).score ≤ scoreUpperBound(...)` holding for EVERY
 * roll, skill, multiplier set, cap configuration and batch shape. The
 * derivation lives in bounds.ts; this file is the machine check. Three layers:
 *
 * 1. the two `growThreads` post-conditions the derivation leans on;
 * 2. the formula-level monotonicities interval arithmetic (rollExtremes,
 *    scoreLowerBoundH1, the band table) relies on;
 * 3. an adversarial seeded sweep of the inequality itself against the real
 *    solver, plus the boundary battery.
 *
 * Everything is exact `<=` — no epsilon. If float rounding ever produces a
 * genuine ulp-level violation, the fix is a documented safety factor in the
 * bound, not a silent tolerance here. */

const HACKABLE = Object.entries(SERVER_RANGES).filter(([, r]) => (r.money?.[1] ?? 0) > 0 && (r.growth?.[1] ?? 0) > 0);

function rollInt(rng: () => number, range: Range | undefined): number {
  const [min, max] = range ?? [0, 0];
  return min + Math.floor(rng() * (max - min + 1));
}

function rollStatics(rng: () => number, mults: ServerGenMults): TargetStatics {
  const [hostname, ranges] = HACKABLE[Math.floor(rng() * HACKABLE.length)]!;
  return staticsFromRolls(
    hostname,
    {
      money: rollInt(rng, ranges.money),
      sec: rollInt(rng, ranges.sec),
      skill: rollInt(rng, ranges.skill),
      growth: rollInt(rng, ranges.growth),
    },
    mults,
  );
}

/** BitNode-shaped multiplier presets plus a fully random draw. The BN8 preset
 * is the load-bearing one: ScriptHackMoneyGain = 0 zeroes hacked income, so a
 * bound that mixes up the two money multipliers fails here first. */
const NODE_PRESETS: { node: HackNodeMults; gen: ServerGenMults }[] = [
  { node: {}, gen: {} },
  { node: { ScriptHackMoney: 0.2, HackExpGain: 0.5 }, gen: { ServerMaxMoney: 0.2, ServerStartingSecurity: 1.5 } },
  {
    node: { ScriptHackMoney: 0.3, ScriptHackMoneyGain: 0, ServerGrowthRate: 0.05 },
    gen: { ServerMaxMoney: 0.1, ServerStartingSecurity: 2 },
  },
  { node: { ScriptHackMoney: 0.1, ServerWeakenRate: 2, HackingSpeedMultiplier: 0.4 }, gen: { ServerMaxMoney: 0.05 } },
];

function randomCtx(rng: () => number, statics: TargetStatics, node: HackNodeMults): HackContext {
  // Skill from "exactly the requirement" (the eligibility edge) to far above.
  const skill = Math.max(1, Math.round(statics.requiredHackingSkill * (1 + rng() * 9)));
  const mult = (): number => 0.5 + rng() * 2.5;
  return makeHackContext(
    {
      skill,
      intelligence: Math.floor(rng() * 1000),
      mults: { hacking_chance: mult(), hacking_money: mult(), hacking_speed: mult(), hacking_exp: 1, hacking_grow: mult() },
    },
    node,
  );
}

function randomCaps(rng: () => number): RamCaps | undefined {
  const pick = rng();
  if (pick < 0.25) return undefined; // solver default: unlimited
  const batchGb = 16 + rng() * 100_000;
  const hackBlockGb = Math.min(batchGb, 8 + rng() * 8_192);
  if (pick < 0.6) return { batchGb, hackBlockGb };
  const hostBlocksGb = Array.from({ length: 1 + Math.floor(rng() * 12) }, () => 4 + rng() * hackBlockGb).sort(
    (a, b) => b - a,
  );
  return { batchGb, hackBlockGb, hostBlocksGb, farmGb: Math.max(16, batchGb * (0.5 + rng() * 0.5)) };
}

describe("growThreads post-conditions (the grow bounds the derivation uses)", () => {
  test("returned threads reach the target, and never exceed the log bound + 2", () => {
    const rng = mulberry32(0xb0117d5);
    for (let i = 0; i < 4_000; i++) {
      const k = Math.exp(Math.log(1e-6) + rng() * Math.log(3.5e-3 / 1e-6));
      const moneyMax = Math.exp(Math.log(1e4) + rng() * Math.log(1e13 / 1e4));
      const steal = 0.001 + rng() * 0.994;
      const start = moneyMax * (1 - steal);
      const threads = growThreads(k, moneyMax, start, moneyMax);
      expect(Number.isFinite(threads)).toBe(true);
      // Achieves the target: (start + G) * e^(kG) >= target. This is the exact
      // game semantics of grow (add $1/thread, then multiply).
      expect((start + threads) * Math.exp(k * threads)).toBeGreaterThanOrEqual(moneyMax);
      // Never more than the pure-exponential need plus Newton's slack.
      expect(threads).toBeLessThanOrEqual(-Math.log1p(-steal) / k + 2);
    }
  });
});

describe("formula monotonicity in server fields (what interval arithmetic rests on)", () => {
  test("chance/percent fall, time rises, growth log falls as difficulty and skill req worsen", () => {
    const rng = mulberry32(0x0a11ce);
    for (let i = 0; i < 2_000; i++) {
      const ctx = makeHackContext(
        {
          skill: 1 + Math.floor(rng() * 3_000),
          intelligence: Math.floor(rng() * 500),
          mults: { hacking_chance: 0.5 + rng() * 2, hacking_money: 0.5 + rng() * 2, hacking_speed: 0.5 + rng() * 2, hacking_exp: 1, hacking_grow: 0.5 + rng() * 2 },
        },
        {},
      );
      const d = 1 + rng() * 98;
      const dWorse = d + rng() * (99.9 - d);
      const req = 1 + Math.floor(rng() * ctx.skill);
      const reqWorse = req + Math.floor(rng() * 200);
      expect(hackChance(ctx, dWorse, req)).toBeLessThanOrEqual(hackChance(ctx, d, req));
      expect(hackChance(ctx, d, reqWorse)).toBeLessThanOrEqual(hackChance(ctx, d, req));
      expect(hackPercent(ctx, dWorse, req)).toBeLessThanOrEqual(hackPercent(ctx, d, req));
      expect(hackPercent(ctx, d, reqWorse)).toBeLessThanOrEqual(hackPercent(ctx, d, req));
      expect(hackTimeSeconds(ctx, dWorse, req)).toBeGreaterThanOrEqual(hackTimeSeconds(ctx, d, req));
      expect(hackTimeSeconds(ctx, d, reqWorse)).toBeGreaterThanOrEqual(hackTimeSeconds(ctx, d, req));
      const growth = 1 + rng() * 98;
      expect(growthLogPerThread(ctx, dWorse, growth)).toBeLessThanOrEqual(growthLogPerThread(ctx, d, growth));
      expect(growthLogPerThread(ctx, d, growth * 0.5)).toBeLessThanOrEqual(growthLogPerThread(ctx, d, growth));
    }
  });
});

describe("score ≤ upper bound: the pruning inequality", () => {
  test("adversarial seeded sweep across rolls, skills, mults, caps and both batch shapes", () => {
    const rng = mulberry32(0x5c0feb0);
    let solved = 0;
    for (let i = 0; i < 3_000; i++) {
      const preset = NODE_PRESETS[Math.floor(rng() * NODE_PRESETS.length)]!;
      const statics = rollStatics(rng, preset.gen);
      const ctx = randomCtx(rng, statics, preset.node);
      const caps = randomCaps(rng);
      const manipulation =
        rng() < 0.3
          ? { valuePerOp: Math.exp(rng() * 20), side: (rng() < 0.5 ? "long" : "short") as "long" | "short" }
          : undefined;
      const kind: CycleKind = rng() < 0.5 ? "hwgw" : "hgw";
      const solution = solveCycle(ctx, statics, 1, caps, manipulation, kind);
      if (!solution) continue;
      solved++;
      const bound = scoreUpperBound(ctx, statics, manipulation?.valuePerOp ?? 0);
      if (solution.score > bound) {
        // Loud context on failure: which corner of the space broke the proof.
        console.error("violation", { statics, skill: ctx.skill, caps, manipulation, kind, score: solution.score, bound });
      }
      expect(solution.score).toBeLessThanOrEqual(bound);
    }
    // The sweep must actually exercise the solver, not skip everything.
    expect(solved).toBeGreaterThan(1_000);
  });

  test("boundary battery: eligibility edges, the steal cap, and the additive-grow trap", () => {
    const neutral = { hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1 };
    const n00dles: TargetStatics = { hostname: "n00dles", minDifficulty: 1, moneyMax: 1_750_000, requiredHackingSkill: 1, serverGrowth: 3000, baseDifficulty: 1 };
    // Money-poor targets are where grow's $1/thread additive credit bites the
    // hardest; a bound without the 1/m0 term fails exactly here.
    for (const skill of [1, 5, 50, 500, 5_000]) {
      const ctx = makeHackContext({ skill, intelligence: 0, mults: neutral }, {});
      const solution = solveCycle(ctx, n00dles)!;
      expect(solution.score).toBeLessThanOrEqual(scoreUpperBound(ctx, n00dles));
    }
    // Steal cap: an absurd money mult clamps hackPercent at 1, one thread
    // steals everything, and the grow term of the bound must drop out rather
    // than divide by zero.
    const capped = makeHackContext({ skill: 1_000, intelligence: 0, mults: { ...neutral, hacking_money: 1e6 } }, {});
    const joes: TargetStatics = { hostname: "joesguns", minDifficulty: 5, moneyMax: 62_500_000, requiredHackingSkill: 10, serverGrowth: 20, baseDifficulty: 15 };
    const cappedSolution = solveCycle(capped, joes)!;
    const cappedBound = scoreUpperBound(capped, joes);
    expect(Number.isFinite(cappedBound)).toBe(true);
    expect(cappedSolution.score).toBeLessThanOrEqual(cappedBound);
    // Ineligible shapes bound to zero, matching the solver returning nothing.
    const ctx = makeHackContext({ skill: 100, intelligence: 0, mults: neutral }, {});
    expect(scoreUpperBound(ctx, { ...joes, requiredHackingSkill: 101 })).toBe(0);
    expect(scoreUpperBound(ctx, { ...joes, moneyMax: 0 })).toBe(0);
    expect(scoreUpperBound(ctx, { ...joes, serverGrowth: 0 })).toBe(0);
    expect(scoreUpperBound(ctx, { ...joes, minDifficulty: 100 })).toBe(0);
  });

  test("the pipeline-aware score never exceeds the plain score (the bound covers both)", () => {
    const rng = mulberry32(0x9192a7e);
    const neutral = { hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1 };
    for (let i = 0; i < 300; i++) {
      const statics = rollStatics(rng, {});
      const skill = Math.max(1, Math.round(statics.requiredHackingSkill * (1 + rng() * 4)));
      const ctx = makeHackContext({ skill, intelligence: 0, mults: neutral }, {});
      const batchGb = 32 + rng() * 10_000;
      const hackBlockGb = Math.min(batchGb, 8 + rng() * 2_048);
      const plain = solveCycle(ctx, statics, 1, { batchGb, hackBlockGb });
      const aware = solveCycle(ctx, statics, 1, {
        batchGb,
        hackBlockGb,
        hostBlocksGb: [hackBlockGb, hackBlockGb / 2, hackBlockGb / 4],
        farmGb: batchGb,
      });
      if (!plain || !aware) continue;
      // Real-arithmetic identity, but when RAM binds the solver forms it as
      // income/((ramSec/farmGb)*farmGb) — reassociation costs an ulp. The UB
      // inequality above needs no such tolerance: its slack is at least the
      // dropped weaken-thread ceilings, far above float noise.
      expect(aware.score).toBeLessThanOrEqual(plain.score * (1 + 1e-12));
    }
  });
});
