import { describe, expect, test } from "bun:test";
import { makeHackContext, type HackContext, type HackPlayer } from "../shared/formulas.ts";
import { staticsFromRolls } from "../shared/strategy/bounds.ts";
import {
  MAX_STEAL,
  solveCycle,
  UNLIMITED_RAM,
  type RamCaps,
  type TargetStatics,
} from "../shared/strategy/targeting.ts";
import { WORKER_RAM } from "../shared/world.ts";
import { mulberry32 } from "../sim/core/rng.ts";

/** THE PLAIN-LANGUAGE INVARIANTS.
 *
 * Everything else in this suite proves a specific mechanism: parity against the
 * engine, an upper bound, a packing rule, a refactor equivalence. This file
 * states the properties a reader would ASSUME without reading any of it — more
 * RAM earns more, the richer server wins, two candidates pick the better one —
 * and pins them, so a refactor that quietly inverts one is caught by a test
 * whose name says what broke rather than by a scenario drifting 4%.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CLAIM. `spec/targeting.md` ("What is
 * deliberately NOT claimed") proves component-wise dominance is FALSE in
 * general: near the 95% steal cap the solver's granularity is
 * `floor(0.95/p)*p`, discontinuous in p, and in the interval/slot-floored
 * pipeline regime a marginally better server can lose more steal to that floor
 * than its chance advantage recovers. So a naive "better server => better
 * score" assertion WILL flake, and tightening these tests to demand it is a
 * mistake that would have to be re-learned. Two rules keep them honest:
 *
 *   1. Strict monotonicity is asserted only in the RAM-UNBOUND regime, where
 *      no cap floor is in play.
 *   2. Under caps, the claim weakens to the always-true form: a larger cap's
 *      feasible set CONTAINS the smaller one, so its optimum cannot be worse.
 *      That holds by construction at every roll, with no dominance argument.
 *
 * All fixtures derive from `staticsFromRolls` — the same single transcription
 * of the game's world generation the simulator and the prune bounds use — so
 * no test here can invent a server the game could not roll. */

/** Neutral player: every multiplier 1, so a fixture only varies what it means
 * to vary. HackContext requires all five explicitly -- omitting one silently
 * produces NaN and every solve returns undefined. */
const ctxAt = (skill: number, mults: Partial<HackPlayer["mults"]> = {}): HackContext =>
  makeHackContext({
    skill,
    intelligence: 0,
    mults: {
      hacking_chance: 1,
      hacking_money: 1,
      hacking_speed: 1,
      hacking_exp: 1,
      hacking_grow: 1,
      ...mults,
    },
  }, {});

/** A rolled server, built the way the game builds one. */
const target = (
  hostname: string,
  rolls: { money: number; sec: number; skill: number; growth: number },
): TargetStatics => staticsFromRolls(hostname, rolls);

const RICH = target("rich", { money: 4e7, sec: 30, skill: 200, growth: 60 });
const POOR = target("poor", { money: 2e4, sec: 12, skill: 20, growth: 20 });

const caps = (batchGb: number, hackBlockGb = batchGb): RamCaps => ({ batchGb, hackBlockGb });

/** A seeded rolled server, spanning the ranges the game actually generates. */
function randomTarget(rng: () => number, index: number): TargetStatics {
  return target(`roll-${index}`, {
    money: 1e3 + rng() * 5e7,
    sec: 1 + rng() * 98,
    skill: 1 + Math.floor(rng() * 900),
    growth: 1 + Math.floor(rng() * 99),
  });
}

describe("sanity: a solved batch is something we can actually launch", () => {
  test("every solution fits the caps it was solved under", () => {
    const rng = mulberry32(11);
    const ctx = ctxAt(500);
    let solved = 0;
    for (let i = 0; i < 400; i++) {
      const statics = randomTarget(rng, i);
      // Deliberately tight and irregular caps: this is where infeasible
      // solutions surface if the search ignores its own bounds.
      const batchGb = 16 + rng() * 4_000;
      const hackBlockGb = Math.min(batchGb, 8 + rng() * 512);
      const solution = solveCycle(ctx, statics, 1, { batchGb, hackBlockGb });
      if (solution === undefined) continue;
      solved++;

      const hackGb = solution.hackThreads * WORKER_RAM.hack;
      expect(hackGb, `${statics.hostname} hack block`).toBeLessThanOrEqual(hackBlockGb + 1e-9);
      expect(solution.ramPerBatch, `${statics.hostname} batch`).toBeLessThanOrEqual(batchGb + 1e-9);
      // A batch nobody can run is worse than no batch: every op needs threads.
      expect(solution.hackThreads).toBeGreaterThanOrEqual(1);
      expect(solution.growThreads).toBeGreaterThanOrEqual(1);
      expect(solution.weaken2Threads).toBeGreaterThanOrEqual(1);
      if (solution.kind === "hwgw") expect(solution.weaken1Threads).toBeGreaterThanOrEqual(1);
    }
    // Guard against the sweep silently solving nothing and passing vacuously.
    expect(solved).toBeGreaterThan(50);
  });

  test("we never plan to steal more money than a server holds", () => {
    // NOT the same claim as `MAX_STEAL`, and the difference matters. MAX_STEAL
    // (0.95) bounds the SEARCH DOMAIN, not the solution: `H = round(s/percent)`
    // floors at one thread, so a single thread on a server whose hack percent
    // already exceeds 95% reports a steal fraction of 1. That is physically
    // right -- you cannot steal more than is there -- and it means asserting
    // `<= MAX_STEAL` here would be false. The real postcondition is `<= 1`.
    //
    // Worth stating plainly: at any realistic multiplier the $/GB/sec optimum
    // sits around 0.1-0.2 steal, nowhere near either bound, because grow cost
    // rises superlinearly in the fraction taken. The cap is not what shapes
    // the solution, so a test claiming to pin it would be measuring nothing.
    const rng = mulberry32(12);
    const ctx = ctxAt(3000, { hacking_money: 3 });
    let solved = 0;
    for (let i = 0; i < 400; i++) {
      const solution = solveCycle(ctx, randomTarget(rng, i), 1, UNLIMITED_RAM);
      if (solution === undefined) continue;
      solved++;
      expect(solution.stealFraction).toBeGreaterThan(0);
      expect(solution.stealFraction).toBeLessThanOrEqual(1);
      expect(solution.chance).toBeGreaterThanOrEqual(0);
      expect(solution.chance).toBeLessThanOrEqual(1);
    }
    expect(solved).toBeGreaterThan(50);
  });

  test("with thread granularity to spend, the search stays inside MAX_STEAL", () => {
    // Where the domain bound IS observable: whenever the solver has more than
    // one hack thread to work with it can hit any fraction it likes, and it
    // never chooses one above the cap.
    const rng = mulberry32(14);
    const ctx = ctxAt(3000, { hacking_money: 3 });
    let multiThread = 0;
    for (let i = 0; i < 400; i++) {
      const solution = solveCycle(ctx, randomTarget(rng, i), 1, UNLIMITED_RAM);
      if (solution === undefined || solution.hackThreads < 2) continue;
      multiThread++;
      expect(solution.stealFraction).toBeLessThanOrEqual(MAX_STEAL + 1e-12);
    }
    expect(multiThread).toBeGreaterThan(50);
  });

  test("an ineligible target returns undefined rather than a zero-score batch", () => {
    // Skill far below the requirement: not a cheap target, no target at all.
    expect(solveCycle(ctxAt(1), RICH, 1, UNLIMITED_RAM)).toBeUndefined();
    // No money to steal is not a hacking target however easy it is.
    expect(
      solveCycle(ctxAt(5000), target("broke", { money: 0, sec: 5, skill: 1, growth: 50 }), 1, UNLIMITED_RAM),
    ).toBeUndefined();
    // A batch that cannot fit even one hack thread is infeasible, not free.
    expect(solveCycle(ctxAt(5000), RICH, 1, caps(1, 1))).toBeUndefined();
  });

  test("score, income and RAM agree with each other", () => {
    const rng = mulberry32(13);
    const ctx = ctxAt(800);
    for (let i = 0; i < 200; i++) {
      const solution = solveCycle(ctx, randomTarget(rng, i), 1, UNLIMITED_RAM);
      if (solution === undefined) continue;
      // The score is a rate: positive income over positive RAM over positive
      // time. A zero or negative anywhere means a term dropped out.
      expect(solution.incomePerBatch).toBeGreaterThan(0);
      expect(solution.ramPerBatch).toBeGreaterThan(0);
      expect(solution.weakenTimeS).toBeGreaterThan(0);
      expect(solution.score).toBeGreaterThan(0);
      expect(Number.isFinite(solution.score)).toBe(true);
    }
  });
});

describe("monotonic: more of a good thing is never worse", () => {
  test("more RAM never earns less per batch", () => {
    // The always-true form: a larger cap's feasible set CONTAINS the smaller
    // one, so its optimum cannot be worse. True at every roll, including deep
    // inside the slot-floored regime where dominance arguments fail.
    //
    // Income per batch is the monotone quantity, not $/GB/sec: a bigger batch
    // buys more money but saturates against the steal cap, so the RATE may
    // legitimately fall while the earnings rise.
    const rng = mulberry32(21);
    const ctx = ctxAt(1200);
    let compared = 0;
    for (let i = 0; i < 200; i++) {
      const statics = randomTarget(rng, i);
      let previous: number | undefined;
      for (const batchGb of [32, 64, 128, 512, 2_048, 16_384]) {
        const solution = solveCycle(ctx, statics, 1, caps(batchGb));
        if (solution === undefined) continue;
        if (previous !== undefined) {
          compared++;
          expect(solution.incomePerBatch, `${statics.hostname} at ${batchGb}GB`)
            .toBeGreaterThanOrEqual(previous - 1e-6);
        }
        previous = solution.incomePerBatch;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  test("a higher hacking skill never scores worse", () => {
    // Skill shortens every op and raises both chance and percent. Unlike the
    // server fields it cannot interact adversely with the steal cap: the cap
    // bounds a FRACTION, and at equal fraction a shorter batch always wins.
    // Asserted RAM-unbound so no cap floor is in play.
    const rng = mulberry32(22);
    let compared = 0;
    for (let i = 0; i < 150; i++) {
      const statics = randomTarget(rng, i);
      let previous: number | undefined;
      for (const skill of [statics.requiredHackingSkill, 1_000, 2_500, 6_000]) {
        const solution = solveCycle(ctxAt(skill), statics, 1, UNLIMITED_RAM);
        if (solution === undefined) continue;
        if (previous !== undefined) {
          compared++;
          expect(solution.score, `${statics.hostname} at skill ${skill}`)
            .toBeGreaterThanOrEqual(previous * (1 - 1e-9));
        }
        previous = solution.score;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  test("a richer server earns more per batch", () => {
    // moneyMax scales income linearly and leaves timing untouched, so this one
    // IS safe component-wise: the steal cap bounds a fraction, and grow threads
    // for a fixed fraction are money-independent except for grow's +1/thread
    // additive credit, which only ever helps the poorer server.
    const ctx = ctxAt(1_500);
    const rng = mulberry32(23);
    let compared = 0;
    for (let i = 0; i < 150; i++) {
      const base = randomTarget(rng, i);
      const lean = solveCycle(ctx, base, 1, UNLIMITED_RAM);
      const fat = solveCycle(ctx, { ...base, moneyMax: base.moneyMax * 10 }, 1, UNLIMITED_RAM);
      if (lean === undefined || fat === undefined) continue;
      compared++;
      expect(fat.incomePerBatch, `${base.hostname} x10 money`).toBeGreaterThan(lean.incomePerBatch);
    }
    expect(compared).toBeGreaterThan(50);
  });

  test("a faster-growing server is never worth less", () => {
    // Higher serverGrowth means fewer grow threads to restore the same steal,
    // so the batch is cheaper in RAM-seconds at unchanged income.
    const ctx = ctxAt(1_500);
    const rng = mulberry32(24);
    let compared = 0;
    for (let i = 0; i < 150; i++) {
      const base = randomTarget(rng, i);
      if (base.serverGrowth >= 90) continue;
      const slow = solveCycle(ctx, base, 1, UNLIMITED_RAM);
      const fast = solveCycle(ctx, { ...base, serverGrowth: base.serverGrowth + 10 }, 1, UNLIMITED_RAM);
      if (slow === undefined || fast === undefined) continue;
      compared++;
      expect(fast.score, `${base.hostname} growth +10`).toBeGreaterThanOrEqual(slow.score * (1 - 1e-9));
    }
    expect(compared).toBeGreaterThan(50);
  });

  test("a server that weakens to a lower floor is never worth less", () => {
    // minDifficulty drives every duration and the hack chance; lowering it
    // strictly improves both, with no cap interaction RAM-unbound.
    const ctx = ctxAt(1_500);
    const rng = mulberry32(25);
    let compared = 0;
    for (let i = 0; i < 150; i++) {
      const base = randomTarget(rng, i);
      if (base.minDifficulty <= 2) continue;
      const hard = solveCycle(ctx, base, 1, UNLIMITED_RAM);
      const easy = solveCycle(ctx, { ...base, minDifficulty: base.minDifficulty - 1 }, 1, UNLIMITED_RAM);
      if (hard === undefined || easy === undefined) continue;
      compared++;
      expect(easy.score, `${base.hostname} minSec -1`).toBeGreaterThanOrEqual(hard.score * (1 - 1e-9));
    }
    expect(compared).toBeGreaterThan(50);
  });
});

describe("sanity: picking between candidates", () => {
  test("the better of two candidates scores higher", () => {
    // The whole point of evaluating rather than hardcoding an order: at a skill
    // that can reach both, the rich server must out-score the poor one.
    const ctx = ctxAt(1_500);
    const rich = solveCycle(ctx, RICH, 1, UNLIMITED_RAM)!;
    const poor = solveCycle(ctx, POOR, 1, UNLIMITED_RAM)!;
    expect(rich.score).toBeGreaterThan(poor.score);
    expect(rich.incomePerBatch).toBeGreaterThan(poor.incomePerBatch);
  });

  test("the ranking never depends on the hostname", () => {
    // Two identical rolls under different names must tie EXACTLY. A hostname
    // reaching a decision is precisely the hidden hardcoded rule this suite
    // exists to prevent, and it would make every comparison above meaningless.
    const ctx = ctxAt(1_500);
    const a = solveCycle(ctx, { ...RICH, hostname: "alpha" }, 1, caps(4_096))!;
    const b = solveCycle(ctx, { ...RICH, hostname: "zulu" }, 1, caps(4_096))!;
    expect(a.score).toBe(b.score);
    expect(a.hackThreads).toBe(b.hackThreads);
    expect(a.growThreads).toBe(b.growThreads);
  });

  test("solving is deterministic: the same question gets the same answer", () => {
    const ctx = ctxAt(900);
    const rng = mulberry32(31);
    for (let i = 0; i < 100; i++) {
      const statics = randomTarget(rng, i);
      const first = solveCycle(ctx, statics, 1, caps(1_024));
      const second = solveCycle(ctx, statics, 1, caps(1_024));
      expect(second?.score).toBe(first?.score);
      expect(second?.hackThreads).toBe(first?.hackThreads);
    }
  });
});
