import { describe, expect, test } from "bun:test";
import {
  hackMarginalValue,
  hackMarginalAt,
  shareCutover,
  shareMarginalValue,
  type ShareValueCurve,
} from "../shared/strategy/share.ts";

describe("marginal share cutover", () => {
  const curve: ShareValueCurve = {
    hackMarginal: { state: "measured", value: 1 },
    reputationSecondsPerBonus: 250,
    effectiveThreadsPerGb: 0.5,
  };

  test("hack marginal is constant while share marginal strictly decreases", () => {
    const hack = hackMarginalValue({
      moneySecondsPerRelativeRate: 1_000,
      hackingSecondsPerRelativeRate: 500,
      totalMoneyPerSec: 100,
      totalHackingExpPerSec: 50,
      moneyPerSecPerGb: 2,
      hackingExpPerSecPerGb: 1,
    });
    expect(hack).toEqual({ state: "measured", value: 30 });
    expect(shareMarginalValue(curve, 0)).toBeGreaterThan(shareMarginalValue(curve, 10));
    expect(shareMarginalValue(curve, 10)).toBeGreaterThan(shareMarginalValue(curve, 100));
  });

  test("solves the analytic crossing and rounds the reservation down", () => {
    // The crossing includes hacking's rising opportunity cost as farm RAM is
    // removed, so it is left of the old constant-marginal 8 GB solution.
    const sized = shareCutover(curve, 100);
    expect(sized.cutoverGb).toBeGreaterThan(0);
    expect(sized.cutoverGb).toBeLessThan(8);
    expect(shareMarginalValue(curve, sized.cutoverGb)).toBeCloseTo(
      hackMarginalAt(curve, 100, sized.cutoverGb)!,
      10,
    );
    expect(sized.allotmentGb).toBeLessThanOrEqual(sized.cutoverGb);
  });

  test("zero critical-path reputation collapses share to zero", () => {
    const sized = shareCutover({ ...curve, reputationSecondsPerBonus: 0 }, 1_000, 10);
    expect(sized.cutoverGb).toBe(0);
    expect(sized.allotmentGb).toBe(0);
    expect(sized.shareMarginal).toBe(0);
  });

  test("near-zero hack value moves the same equation right without a BitNode case", () => {
    const ordinary = shareCutover(curve, 1_000);
    const weakHack = shareCutover({ ...curve, hackMarginal: { state: "measured", value: 1e-4 } }, 1_000);
    expect(weakHack.cutoverGb).toBeGreaterThan(ordinary.cutoverGb);
    expect(weakHack.cutoverGb).toBeLessThan(1_000);
  });

  test("unknown and measured-zero hacking marginals are distinct", () => {
    const unknown = shareCutover({
      ...curve,
      hackMarginal: { state: "unknown", reason: "getter pending" },
    }, 1_000);
    const zero = shareCutover({
      ...curve,
      hackMarginal: { state: "measured", value: 0 },
    }, 1_000);
    expect(unknown.allotmentGb).toBe(0);
    expect(zero.allotmentGb).toBeGreaterThan(0);
    expect(zero.cutoverGb).toBe(1_000);
  });

  test("RAM beyond the depth cap is NOT free — only the marginal crossing decides", () => {
    // The depth cap describes the CURRENT target's pipeline, not the farm's
    // appetite: surplus above it is growth headroom (prep for the next target,
    // and the bigger targets skill growth unlocks). Treating it as idle and
    // handing it to share was measured on bn1-progression seed 1 as hacking
    // income $18.05q -> $12.23q (-32%) for the same augmentation count.
    const capped = shareCutover(curve, 100, 60);
    const uncapped = shareCutover(curve, 100);
    expect(capped.cutoverGb).toBe(uncapped.cutoverGb);
    expect(capped.cutoverGb).toBeLessThan(40);
  });
});
