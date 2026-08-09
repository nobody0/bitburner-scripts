import { describe, expect, test } from "bun:test";
import { depthCapGb, evaluatePrep, farmIncomeRate, prepTimeDiscount, type FarmRateModel } from "../shared/strategy/economics.ts";
import type { PrepPlan } from "../shared/strategy/targeting.ts";

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
    const m = model({ score: 2, ramPerBatch: 10, weakenTimeS: 8 }); // cap = 10 batches * 10 GB
    expect(depthCapGb(m)).toBe(100);
    expect(farmIncomeRate(m, 50)).toBe(100);
    expect(farmIncomeRate(m, 100)).toBe(200);
    expect(farmIncomeRate(m, 10_000)).toBe(200); // surplus earns nothing
    expect(farmIncomeRate(undefined, 100)).toBe(0);
  });

  test("uses the dispatcher's floored depth for partial intervals", () => {
    const m = model({ ramPerBatch: 10, weakenTimeS: 2.1 });
    expect(depthCapGb(m)).toBe(20);
    expect(farmIncomeRate(m, 1_000)).toBe(20);
  });
});

describe("evaluatePrep", () => {
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
    const scale = prepTimeDiscount({ prepSeconds: 0.7 * 3600, futureOpTimeScale: 0.4 });
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
    expect(prepTimeDiscount({ prepSeconds: 1_000, futureOpTimeScale: 1 })).toBe(1);
    // Faster growth -> deeper discount, floored at half (ops cannot finish
    // before they start; the trapezoid never drops below 0.5).
    const mild = prepTimeDiscount({ prepSeconds: 1_000, futureOpTimeScale: 0.8 });
    const steep = prepTimeDiscount({ prepSeconds: 1_000, futureOpTimeScale: 0.2 });
    expect(mild).toBeGreaterThan(steep);
    expect(steep).toBeGreaterThanOrEqual(0.5);
    // A degenerate quote is left alone.
    expect(prepTimeDiscount({ prepSeconds: 0, futureOpTimeScale: 0.2 })).toBe(1);
  });

  test("a depth-capped farm preps for free: surplus RAM has no opportunity cost", () => {
    // Farm saturates at 100 GB of a 1000 GB fleet: even the 0.6 share leaves
    // (1-0.6)*1000 = 400 GB >= cap, so lost = 0 and any better candidate pays.
    const current = model({ score: 1, ramPerBatch: 10, weakenTimeS: 80 }); // cap 1000 GB? no: 100 batches*10
    expect(depthCapGb(current)).toBe(1_000);
    const capped = model({ score: 1, ramPerBatch: 10, weakenTimeS: 8 }); // cap 100 GB
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
