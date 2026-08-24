import { describe, expect, test } from "bun:test";
import {
  chargeCutover,
  chargeValueSeconds,
  projectedChargeEffect,
  type ChargeFragment,
  type ChargePricingInput,
} from "../shared/strategy/stanek/charge.ts";

const fragment: ChargeFragment = {
  id: 0,
  type: "6",
  x: 1,
  y: 2,
  power: 2,
  numCharge: 1,
  highestCharge: 4,
  chargedEffect: 1 + Math.log(5) / 60 * Math.pow(2 / 5, 0.07) * 2,
};

const pricing: ChargePricingInput = {
  fragments: [fragment],
  moneySecondsPerRelativeRate: 1_000,
  hackingSecondsPerRelativeRate: 500,
  totalMoneyPerSec: 10,
  totalHackingExpPerSec: 10,
  moneySourceShare: 1,
  hackingSourceShare: 1,
};

describe("Stanek charge valuation", () => {
  test("projects the game's highest-charge accumulator and inferred effect coefficient", () => {
    // Adding two threads below the previous high changes N from 1 to 1.5.
    const expected = 1 + Math.log(5) / 60 * Math.pow(2.5 / 5, 0.07) * 2;
    expect(projectedChargeEffect(fragment, 2)).toBeCloseTo(expected, 12);
  });

  test("only scheduler-owned hacking channels are priced", () => {
    expect(chargeValueSeconds(fragment, 8, pricing)).toBeGreaterThan(0);
    expect(chargeValueSeconds({ ...fragment, type: "7" }, 8, pricing)).toBe(0);
  });

  test("chooses the largest economically positive host-local call", () => {
    const cutover = chargeCutover(
      pricing,
      [
        { hostname: "small", gb: 16, cores: 1 },
        { hostname: "large", gb: 64, cores: 1 },
      ],
    );
    expect(cutover.fragment?.id).toBe(0);
    expect(cutover.threads).toBe(32);
    expect(cutover.allotmentGb).toBe(64);
    expect(cutover.valueSeconds).toBeGreaterThan(cutover.opportunitySeconds);
    expect(cutover.opportunitySeconds).toBeCloseTo(0.8, 12);
  });

  test("an unmeasured producer share disables nominal charge", () => {
    const { moneySourceShare: _money, hackingSourceShare: _hacking, ...unmeasured } = pricing;
    expect(chargeCutover(unmeasured, [{ hostname: "large", gb: 64, cores: 1 }]).allotmentGb).toBe(0);
  });
});
