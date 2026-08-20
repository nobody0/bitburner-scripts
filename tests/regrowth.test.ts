import { describe, expect, test } from "bun:test";
import {
  augmentationAcquisitionRate,
  cycleProgressEta,
  cycleProgressEtaWithPrior,
  cycleProgressExponent,
  retainCycleCurve,
} from "../shared/strategy/progression/regrowth.ts";

describe("fresh-cycle regrowth curves", () => {
  test("bounded retention keeps the cold bootstrap and the latest regime", () => {
    const points = Array.from({ length: 10 }, (_, index) => ({
      sec: index * 60,
      money: index,
      hacking: index + 1,
      combat: 1,
    }));
    retainCycleCurve(points, 6, 3);
    expect(points.map((point) => point.sec)).toEqual([0, 60, 120, 420, 480, 540]);
  });
  test("completed install cycles remain an augmentation-rate signal", () => {
    expect(augmentationAcquisitionRate([{ sec: 4_200, augmentations: 7 }])).toBeCloseTo(7 / 4_200, 12);
    // Latest cycle has twice the influence of the preceding regime.
    expect(augmentationAcquisitionRate([
      { sec: 4_000, augmentations: 4 },
      { sec: 2_000, augmentations: 4 },
    ])).toBeCloseTo(6 / 4_000, 12);
    expect(augmentationAcquisitionRate([{ sec: 100, augmentations: 0 }])).toBe(0);
    // A harness/save that starts with purchases already queued only observes
    // the button press, not the acquisition cycle. Never extrapolate that
    // censored startup into "twenty more augmentations in seconds".
    expect(augmentationAcquisitionRate([{ sec: 4, augmentations: 9 }])).toBe(0);
  });

  test("fits and inverts accelerating cumulative progress", () => {
    const points = [
      { sec: 60, money: 1e6, hacking: 10, combat: 2 },
      { sec: 120, money: 4e6, hacking: 20, combat: 3 },
      { sec: 240, money: 16e6, hacking: 40, combat: 5 },
    ];
    const eta = cycleProgressEta(points, "money", 64e6, 99_999);
    expect(eta.measured).toBe(true);
    expect(eta.exponent).toBeCloseTo(2, 6);
    expect(eta.sec).toBeCloseTo(480, 6);
    expect(cycleProgressExponent(points, "money")).toBeCloseTo(2, 6);
  });

  test("the cadence shape distinguishes linear output from a convex bootstrap", () => {
    const linear = [
      { sec: 100, money: 100, hacking: 2, combat: 1 },
      { sec: 200, money: 200, hacking: 3, combat: 1 },
    ];
    const convex = [
      { sec: 100, money: 100, hacking: 2, combat: 1 },
      { sec: 200, money: 1_600, hacking: 3, combat: 1 },
    ];
    expect(cycleProgressExponent(linear, "money")).toBeCloseTo(1, 12);
    expect(cycleProgressExponent(convex, "money")).toBe(4);
  });

  test("interpolates an observed crossing and falls back without a shape", () => {
    const points = [
      { sec: 100, money: 10, hacking: 2, combat: 1 },
      { sec: 200, money: 30, hacking: 3, combat: 1 },
    ];
    expect(cycleProgressEta(points, "money", 20, 999)).toMatchObject({ sec: 150, measured: true });
    expect(cycleProgressEta(points.slice(0, 1), "money", 20, 999)).toEqual({ sec: 999, measured: false });
  });

  test("bounds lucky-jump extrapolation and accepts multiplier scaling", () => {
    const points = [
      { sec: 100, money: 1, hacking: 2, combat: 1 },
      { sec: 200, money: 1e12, hacking: 3, combat: 1 },
    ];
    expect(cycleProgressEta(points, "money", 16e12, 999).exponent).toBe(4);
    expect(cycleProgressEta(points, "money", 2e12, 999, 2).sec).toBeLessThanOrEqual(200);
  });

  test("uses a completed cold-start shape instead of sparse fresh-cycle runaway", () => {
    const prior = [
      { sec: 60, money: 100, hacking: 11, combat: 2 },
      { sec: 120, money: 400, hacking: 21, combat: 3 },
      { sec: 240, money: 1_600, hacking: 41, combat: 5 },
    ];
    // Two tiny, nearly-linear opening observations extrapolate to 384,000s
    // alone. They are not enough evidence to discard a measured 480s shape.
    const sparse = [
      { sec: 60, money: 1, hacking: 2, combat: 1 },
      { sec: 120, money: 2, hacking: 3, combat: 1 },
    ];
    // Given room to run away it still would — the shape of the sparse fit is
    // unchanged, and this is what the prior-cycle anchor exists to correct.
    expect(cycleProgressEta(sparse, "money", 6_400, 1e9).sec).toBeGreaterThan(100_000);
    expect(cycleProgressEtaWithPrior(sparse, prior, "money", 6_400, 1e9).sec).toBeLessThan(2_000);
  });

  test("an extrapolation may not be worse than the caller's recent-rate estimate", () => {
    // The fit is cumulative since cycle start; far outside the observed span it
    // reads the slow bootstrap as the future regime. `fallbackSec` is the
    // caller's linear estimate at the RECENTLY measured rate, and acceleration —
    // the only thing this fit exists to capture — can only shorten an estimate.
    //
    // MEASURED on a cold `bn1-full` start, where there is no prior cycle to
    // anchor to: twenty minutes in, income $28.7k/s against a $100b gap (forty
    // days linear), the unbounded fit returned 2.8 million years on 30.6% of
    // samples, and that became a 1.7e14 BN-second money marginal.
    const sparse = [
      { sec: 60, money: 1, hacking: 2, combat: 1 },
      { sec: 120, money: 2, hacking: 3, combat: 1 },
    ];
    expect(cycleProgressEta(sparse, "money", 6_400, 5_000).sec).toBe(5_000);
    // Interpolation inside the observed span is exact and untouched by the bound.
    expect(cycleProgressEta(sparse, "money", 1.5, 0.001).sec).toBeCloseTo(90, 6);
  });

  test("same-time drift scales the prior when the new cycle is faster", () => {
    const prior = [
      { sec: 60, money: 100, hacking: 11, combat: 2 },
      { sec: 120, money: 400, hacking: 21, combat: 3 },
      { sec: 240, money: 1_600, hacking: 41, combat: 5 },
    ];
    const doubled = prior.slice(0, 2).map((point) => ({ ...point, money: point.money * 2 }));
    const estimate = cycleProgressEtaWithPrior(doubled, prior, "money", 6_400, 999);
    expect(estimate.sec).toBeCloseTo(6 * Math.sqrt(6_400 / 2), 6);
  });
});
