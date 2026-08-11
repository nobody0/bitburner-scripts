import { describe, expect, test } from "bun:test";
import {
  depthCapGb,
  evaluatePrep,
  farmIncomeRate,
  incomePresentValue,
  prepTimeDiscount,
  type FarmRateModel,
} from "../shared/strategy/economics.ts";
import { allocateSegments, retainPrepReservation } from "../shared/strategy/evaluator.ts";
import { BATCH_INTERVAL_S, type PrepPlan } from "../shared/strategy/targeting.ts";

/** Prep opportunity-cost economics: the "3 hours of prep is 3 hours of lost
 * income" model, with the depth-cap carve-out that makes surplus-RAM prep
 * free. */

function model(overrides: Partial<FarmRateModel> = {}): FarmRateModel {
  return { score: 1, ramPerBatch: 10, weakenTimeS: 80, ...overrides };
}

function plan(overrides: Partial<PrepPlan> = {}): PrepPlan {
  return {
    weaken1Threads: 0,
    growThreads: 100,
    weaken2Threads: 8,
    ramSec: 10_000,
    weakenTimeS: 60,
    totalRamGb: 200,
    prepped: false,
    ...overrides,
  };
}

describe("farmIncomeRate", () => {
  test("scales with RAM until the depth cap, then saturates", () => {
    const m = model({ score: 2, ramPerBatch: 10, weakenTimeS: 8 });
    const cap = Math.floor(8 / BATCH_INTERVAL_S) * 10;
    expect(depthCapGb(m)).toBe(cap);
    expect(farmIncomeRate(m, 50)).toBe(100);
    expect(farmIncomeRate(m, cap)).toBe(2 * cap);
    expect(farmIncomeRate(m, 10_000)).toBe(2 * cap); // surplus earns nothing
    expect(farmIncomeRate(undefined, 100)).toBe(0);
  });

  test("uses the dispatcher's floored depth for partial intervals", () => {
    const m = model({ ramPerBatch: 10, weakenTimeS: 2.1 });
    const cap = Math.floor(2.1 / BATCH_INTERVAL_S) * 10;
    expect(depthCapGb(m)).toBe(cap);
    expect(farmIncomeRate(m, 1_000)).toBe(cap);
  });
});

describe("dynamic RAM allocation", () => {
  test("prep gets exact executable demand and farming gets every remaining GB", () => {
    expect(allocateSegments(100, 37)).toEqual([
      { kind: "prep", gb: 37 },
      { kind: "farm", gb: 63 },
      { kind: "share", gb: 0 },
    ]);
    expect(allocateSegments(100, 0)[0]).toEqual({ kind: "farm", gb: 100 });
    expect(allocateSegments(100, 150).slice(0, 2)).toEqual([
      { kind: "prep", gb: 100 },
      { kind: "farm", gb: 0 },
    ]);
  });

  test("an atomic grow/weaken wave cannot lose its reservation at the transient grow landing", () => {
    expect(retainPrepReservation(1.75, 350, true)).toBe(350);
    expect(retainPrepReservation(1.75, 350, false)).toBe(1.75);
  });

  test("prefers the executable JIT role envelope and cadence when available", () => {
    const m = model({ jitSaturationGb: 60, maximumIncomePerSec: 120 });
    expect(depthCapGb(m)).toBe(60);
    expect(farmIncomeRate(m, 30)).toBe(60);
    expect(farmIncomeRate(m, 60)).toBe(120);
    expect(farmIncomeRate(m, 1_000)).toBe(120);
  });
});

describe("incomePresentValue", () => {
  test("is linear without reinvestment and values equal earlier income more with it", () => {
    expect(incomePresentValue(10, 20, 120, 0)).toBe(1_000);
    expect(incomePresentValue(10, 0, 100, 0.01)).toBeGreaterThan(
      incomePresentValue(10, 100, 200, 0.01),
    );
  });
});

describe("evaluatePrep", () => {
  test("exact demand replaces fixed shares and reinvestment prices money-now", () => {
    const current = model({ score: 1, ramPerBatch: 1, weakenTimeS: 800 });
    const candidate = model({ score: 1.08, ramPerBatch: 1, weakenTimeS: 800 });
    const p = plan({ ramSec: 5_000, weakenTimeS: 10 });
    const linear = evaluatePrep({
      current,
      candidate,
      plan: p,
      fleetGb: 100,
      horizonMs: 1_000_000,
      prepGb: 50,
    })!;
    expect(linear.prepGb).toBe(50);
    expect(linear.prepShare).toBe(0.5);
    expect(linear.prepSeconds).toBe(100);
    expect(linear.net).toBeGreaterThan(0);

    const compounded = evaluatePrep({
      current,
      candidate,
      plan: p,
      fleetGb: 100,
      horizonMs: 1_000_000,
      prepGb: 50,
      reinvestmentReturnPerDollarSec: 0.01,
    })!;
    expect(compounded.net).toBeLessThan(0);
  });

  test("nothing farming: net is the legacy idle rule, rate x (T - prepTime)", () => {
    // No current income means prep costs nothing — the value is exactly what
    // the candidate earns in the horizon left after its prep.
    const candidate = model({ score: 5, weakenTimeS: 8, ramPerBatch: 10 });
    const p = plan({ ramSec: 1_000, weakenTimeS: 60 });
    const result = evaluatePrep({ candidate, plan: p, fleetGb: 100, horizonMs: 600_000 })!;
    const rate = farmIncomeRate(candidate, 100);
    // prepTime floors at the weaken latency for both shares here.
    expect(result.prepSeconds).toBe(60);
    expect(result.net).toBeCloseTo(rate * (600 - 60), 6);
  });

  test("a 3-hour prep never pays on a 30-minute horizon, even for a 10x candidate", () => {
    const current = model({ score: 1, weakenTimeS: 1_000, ramPerBatch: 1_000 }); // cap far above fleet
    const candidate = model({ score: 10, weakenTimeS: 1_000, ramPerBatch: 1_000 });
    const p = plan({ ramSec: 3 * 3600 * 100, weakenTimeS: 1_000 }); // ~3h on any share of 100 GB
    const result = evaluatePrep({ current, candidate, plan: p, fleetGb: 100, horizonMs: 1_800_000 })!;
    // Gain is zero (horizon ends before prep does) and the farm still paid.
    expect(result.net).toBeLessThan(0);
  });

  test("the skill-growth discount turns a horizon-breaking prep into a paying one", () => {
    // Same 10x candidate; the prep quote exceeds the horizon at today's skill,
    // but at the measured growth the ops will run ~2.5x faster by the end —
    // the trapezoid discount ((1+0.4)/2 = 0.7) brings the prep inside the
    // window and the upgrade pays.
    const current = model({ score: 1, weakenTimeS: 1_000, ramPerBatch: 1_000 });
    const candidate = model({ score: 10, weakenTimeS: 1_000, ramPerBatch: 1_000 });
    // 120k GB·s on the 0.6 share of 100 GB = 2,000s — just past the 1,800s
    // horizon at today's speed, inside it at the discounted 1,400s.
    const p = plan({ ramSec: 120_000, weakenTimeS: 1_000 });
    const blocked = evaluatePrep({ current, candidate, plan: p, fleetGb: 100, horizonMs: 1_800_000 })!;
    expect(blocked.net).toBeLessThan(0);
    const scale = prepTimeDiscount(0.4);
    expect(scale).toBeCloseTo(0.7, 10);
    const discounted = evaluatePrep({
      current,
      candidate,
      plan: p,
      fleetGb: 100,
      horizonMs: 1_800_000,
      prepTimeScale: scale,
    })!;
    expect(discounted.prepSeconds).toBeLessThan(blocked.prepSeconds);
    expect(discounted.net).toBeGreaterThan(0);
  });

  test("prepTimeDiscount is bounded and inert without growth", () => {
    // No growth measured (future ops as slow as today's) -> no discount.
    expect(prepTimeDiscount(1)).toBe(1);
    // Faster growth -> deeper discount, floored at half (ops cannot finish
    // before they start; the trapezoid never drops below 0.5).
    const mild = prepTimeDiscount(0.8);
    const steep = prepTimeDiscount(0.2);
    expect(mild).toBeGreaterThan(steep);
    expect(steep).toBeGreaterThanOrEqual(0.5);
  });

  test("a depth-capped farm preps for free: surplus RAM has no opportunity cost", () => {
    // Even the 0.6 prep share leaves (1-0.6)*1000 = 400 GB, above the
    // incumbent's cadence-derived cap, so lost = 0 and any better candidate pays.
    const current = model({ score: 1, ramPerBatch: 10, weakenTimeS: 80 });
    expect(depthCapGb(current)).toBe(Math.floor(80 / BATCH_INTERVAL_S) * 10);
    const capped = model({ score: 1, ramPerBatch: 10, weakenTimeS: 8 });
    const candidate = model({ score: 1.5, ramPerBatch: 10, weakenTimeS: 8 });
    const p = plan({ ramSec: 60_000, weakenTimeS: 100 });
    const result = evaluatePrep({ current: capped, candidate, plan: p, fleetGb: 1_000, horizonMs: 1_800_000 })!;
    const gain = (farmIncomeRate(candidate, 1_000) - farmIncomeRate(capped, 1_000)) * (1_800 - result.prepSeconds);
    expect(result.net).toBeCloseTo(gain, 6); // lost === 0
    expect(result.net).toBeGreaterThan(0);
  });

  test("RAM-bound prep takes the large share; latency-bound prep takes the small one", () => {
    // RAM-bound: the farm's loss is share-INVARIANT (lost = rate_per_GB ·
    // shareGb · ramSec/shareGb = score·ramSec), so the bigger share is pure
    // upside — it finishes sooner and the gain window grows. Latency-bound:
    // prep takes one weakenTime regardless of share, so the extra share is
    // pure loss and the small one wins.
    const current = model({ score: 1, ramPerBatch: 1, weakenTimeS: 800 }); // cap 1000 GB = whole fleet
    const ramBound = evaluatePrep({
      current,
      candidate: model({ score: 20, ramPerBatch: 1, weakenTimeS: 800 }),
      plan: plan({ ramSec: 500_000, weakenTimeS: 10 }),
      fleetGb: 1_000,
      horizonMs: 1_800_000,
    })!;
    const latencyBound = evaluatePrep({
      current,
      candidate: model({ score: 1.2, ramPerBatch: 1, weakenTimeS: 800 }),
      plan: plan({ ramSec: 10_000, weakenTimeS: 300 }),
      fleetGb: 1_000,
      horizonMs: 1_800_000,
    })!;
    expect(ramBound.prepShare).toBe(0.6);
    expect(latencyBound.prepShare).toBe(0.25);
  });

  test("a prepped plan or an empty fleet yields no economics", () => {
    expect(evaluatePrep({ candidate: model(), plan: plan({ prepped: true }), fleetGb: 100, horizonMs: 1e6 })).toBeUndefined();
    expect(evaluatePrep({ candidate: model(), plan: plan(), fleetGb: 0, horizonMs: 1e6 })).toBeUndefined();
  });
});
