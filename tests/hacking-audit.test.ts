import { describe, expect, test } from "bun:test";
import {
  EXACT_THREAD_LIMIT,
  solveCycle,
  UNLIMITED_RAM,
  type RamCaps,
  type TargetStatics,
} from "../shared/strategy/targeting.ts";
import {
  growThreads,
  growthLogPerThread,
  hackChance,
  hackPercent,
  hackTimeSeconds,
  makeHackContext,
  weakenEffect,
  type HackContext,
} from "../shared/formulas.ts";
import { WORKER_RAM } from "../shared/world.ts";

function statics(over: Partial<TargetStatics> = {}): TargetStatics {
  return {
    hostname: "joesguns",
    minDifficulty: 5,
    moneyMax: 2_500_000,
    requiredHackingSkill: 10,
    serverGrowth: 20,
    baseDifficulty: 15,
    ...over,
  };
}

function context(skill: number, grow = 1, money = 1): HackContext {
  return makeHackContext({
    skill,
    intelligence: 0,
    mults: { hacking_chance: 1, hacking_money: money, hacking_speed: 1, hacking_exp: 1, hacking_grow: grow },
  });
}

/** Independent integer oracle. It deliberately does not call solveCycle or
 * share its candidate-generation code; only the public game formulas and RAM
 * constants are common inputs. */
function exhaustiveOracle(ctx: HackContext, target: TargetStatics, cores: number, caps: RamCaps) {
  const percent = hackPercent(ctx, target.minDifficulty, target.requiredHackingSkill);
  const chance = hackChance(ctx, target.minDifficulty, target.requiredHackingSkill);
  const hackTimeSec = hackTimeSeconds(ctx, target.minDifficulty, target.requiredHackingSkill);
  const growth = growthLogPerThread(ctx, target.minDifficulty, target.serverGrowth, cores);
  const weaken = weakenEffect(ctx, 1, cores);
  const maxHack = Math.max(1, Math.floor(0.95 / percent));
  let best: { score: number; hackThreads: number } | undefined;
  for (let h = 1; h <= maxHack; h++) {
    const steal = Math.min(1, h * percent);
    const grow = growThreads(growth, target.moneyMax, target.moneyMax * (1 - steal), target.moneyMax);
    if (!Number.isFinite(grow)) continue;
    const w1 = Math.ceil((0.002 * h) / weaken);
    const w2 = Math.ceil((0.004 * grow) / weaken);
    const hackGb = WORKER_RAM.hack * h;
    const batchGb = hackGb + WORKER_RAM.grow * grow + WORKER_RAM.weaken * (w1 + w2);
    if (hackGb > caps.hackBlockGb || batchGb > caps.batchGb) continue;
    const ramSeconds =
      hackTimeSec * (WORKER_RAM.hack * h + WORKER_RAM.grow * 3.2 * grow + WORKER_RAM.weaken * 4 * (w1 + w2));
    const score = (chance * steal * target.moneyMax) / ramSeconds;
    if (!best || score > best.score || (score === best.score && h < best.hackThreads)) {
      best = { score, hackThreads: h };
    }
  }
  return { best, maxHack };
}

describe("audit Q2 — duration-weighted moneyPerThread vs $/GB/sec", () => {
  function legacyScore(shape: { h: number; g: number; w: number }): number {
    return shape.h / (shape.h + shape.g * 3.2 + shape.w * 4);
  }

  function ramScore(shape: { h: number; g: number; w: number }): number {
    return shape.h / (WORKER_RAM.hack * shape.h + WORKER_RAM.grow * 3.2 * shape.g + WORKER_RAM.weaken * 4 * shape.w);
  }

  test("non-proportional shapes have the same ordering but not a constant conversion", () => {
    const shapes = [
      { h: 7, g: 29, w: 9 },
      { h: 23, g: 31, w: 17 },
      { h: 11, g: 90, w: 14 },
      { h: 61, g: 73, w: 41 },
    ];
    const rank = (values: number[]): number[] => values.map((_, i) => i).sort((a, b) => values[b]! - values[a]!);
    const legacy = shapes.map(legacyScore);
    const ram = shapes.map(ramScore);
    expect(rank(ram)).toEqual(rank(legacy));
    // Hack is 1.70 GB while grow/weaken are 1.75 GB, so the ratio varies
    // with shape even though both scores are monotonic in the same weighted
    // non-hack/hack thread ratio.
    expect(ram[0]! / legacy[0]!).not.toBeCloseTo(ram[1]! / legacy[1]!, 8);
  });
});

describe("audit Q3 — honest exhaustive oracle", () => {
  const cases = [
    { skill: 80, growth: 12, cores: 1, caps: UNLIMITED_RAM },
    { skill: 200, growth: 20, cores: 1, caps: UNLIMITED_RAM },
    { skill: 450, growth: 75, cores: 4, caps: { batchGb: 512, hackBlockGb: 128 } },
    { skill: 1_000, growth: 99, cores: 8, caps: { batchGb: 256, hackBlockGb: 64 } },
  ];

  test.each(cases)("matches every integer candidate: skill $skill, growth $growth, cores $cores", ({ skill, growth, cores, caps }) => {
    const ctx = context(skill);
    const target = statics({ serverGrowth: growth });
    const oracle = exhaustiveOracle(ctx, target, cores, caps);
    expect(oracle.maxHack).toBeLessThanOrEqual(EXACT_THREAD_LIMIT);
    expect(oracle.best).toBeDefined();
    const solved = solveCycle(ctx, target, cores, caps)!;
    expect(solved.exact).toBe(true);
    expect(solved.hackThreads).toBe(oracle.best!.hackThreads);
    expect(solved.score).toBeCloseTo(oracle.best!.score, 12);
  });

  test("regression: 11 threads beats the old grid result of 14", () => {
    const ctx = context(200);
    const target = statics();
    const oracle = exhaustiveOracle(ctx, target, 1, UNLIMITED_RAM);
    const solved = solveCycle(ctx, target)!;
    expect(oracle.best!.hackThreads).toBe(11);
    expect(solved.hackThreads).toBe(11);
    expect(solved.score).toBeCloseTo(19.0776, 3);
    expect(solved.exact).toBe(true);
  });

  /* --- Q5: is a second batch parameterization worth building? -------------
   *
   * The 2024 reference brute-forces three anchors (HxGW / HGxW / HGWx) and
   * takes the best by moneyPerMs (imports/batchPlanner.ts:984-1004). We anchor
   * on hack threads only. Below EXACT_THREAD_LIMIT the H-scan provably
   * subsumes all three — our counts are ceil'ed, so the anchor cannot change
   * what is reachable. Above it the search falls back to a grid plus golden
   * section, and spec/jit-reference.md carried that as an open question until
   * these cases answered it. The oracle is the one above, which is not limited
   * to the exact domain: it enumerates every integer candidate.
   *
   * ANSWER: not worth building. The heuristic scores within 0.15% of
   * exhaustive across the large domain, an order of magnitude below the 0.89%
   * loss that justified the exact search in Q3, and 0% under a binding RAM cap
   * (the domain collapses into the exact regime). The reason is in the
   * numbers: it picks 12,600 threads where the oracle picks 4,575 and still
   * scores within 0.04%, because the surface is FLAT across that region, so a
   * second anchor lands on the same plateau. */
  const largeDomain = [
    { name: "skill 200, money x0.001", ctx: () => context(200, 1, 0.001), target: () => statics(), caps: UNLIMITED_RAM },
    { name: "skill 500, money x0.0005", ctx: () => context(500, 1, 0.0005), target: () => statics({ serverGrowth: 60 }), caps: UNLIMITED_RAM },
    { name: "skill 1000, money x0.0002", ctx: () => context(1_000, 1, 0.0002), target: () => statics({ serverGrowth: 99, moneyMax: 1e10 }), caps: UNLIMITED_RAM },
    { name: "skill 300, growth 5", ctx: () => context(300, 1, 0.002), target: () => statics({ serverGrowth: 5 }), caps: UNLIMITED_RAM },
    { name: "skill 500 under an 8 TB cap", ctx: () => context(500, 1, 0.0005), target: () => statics({ serverGrowth: 60 }), caps: { batchGb: 8_000_000, hackBlockGb: 1_000_000 } },
  ];

  test.each(largeDomain)(
    "Q5 — the heuristic stays within 0.15% of exhaustive above the boundary: $name",
    ({ ctx: makeCtx, target: makeTarget, caps }) => {
      const ctx = makeCtx();
      const target = makeTarget();
      const oracle = exhaustiveOracle(ctx, target, 1, caps);
      expect(oracle.maxHack).toBeGreaterThan(EXACT_THREAD_LIMIT);
      const solved = solveCycle(ctx, target, 1, caps)!;
      expect(solved.exact).toBe(false);
      const gap = (oracle.best!.score - solved.score) / oracle.best!.score;
      // Never BETTER than exhaustive: that would mean the two disagree about
      // the objective rather than about the search.
      expect(gap).toBeGreaterThanOrEqual(-1e-12);
      expect(gap).toBeLessThan(0.0015);
    },
    30_000,
  );

  test("domains above the boundary are explicitly labelled heuristic", () => {
    const ctx = context(200, 1, 0.001);
    const target = statics();
    const oracleDomain = Math.max(1, Math.floor(0.95 / hackPercent(ctx, target.minDifficulty, target.requiredHackingSkill)));
    expect(oracleDomain).toBeGreaterThan(EXACT_THREAD_LIMIT);
    const solved = solveCycle(ctx, target)!;
    expect(solved.exact).toBe(false);
    expect(solved.hackThreads).toBeGreaterThan(0);
    expect(solved.score).toBeGreaterThan(0);
  });
});
