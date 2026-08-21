import { describe, expect, test } from "bun:test";
import {
  DARKSCAPE_AFFORDABLE_SHARE,
  DARKSCAPE_TOTAL_COST,
  stepDarkscape,
  type DarkscapeView,
} from "../shared/strategy/dnet/unlock.ts";
import { DARKSCAPE_COST, TOR_COST } from "../shared/strategy/dnet/rates.ts";

/** Enough cash that the affordability guard is satisfied. */
const RICH = DARKSCAPE_TOTAL_COST / DARKSCAPE_AFFORDABLE_SHARE;

function view(over: Partial<DarkscapeView> = {}): DarkscapeView {
  return { dnetActive: true, bitNode: 1, sf15: 0, hasProgram: false, money: RICH, ...over };
}

describe("buying DarkscapeNavigator.exe", () => {
  test("the cost always includes TOR", () => {
    // purchaseProgram fails without TOR, nothing in the player snapshot reports
    // whether we hold it, and purchaseTor is idempotent — so the executor always
    // calls it and the claim always reserves it. $200k against $50m.
    expect(DARKSCAPE_TOTAL_COST).toBe(DARKSCAPE_COST + TOR_COST);
    expect(stepDarkscape(view()).cost).toBe(DARKSCAPE_TOTAL_COST);
  });

  test("bought when affordable and absent", () => {
    const decision = stepDarkscape(view());
    expect(decision.buy).toBe(true);
    expect(decision.why).toContain("darknet access");
  });

  test("never bought in BN15 or with an active SF15", () => {
    // Prestige.ts re-grants the program, and TOR, at every install under
    // canAccessBitNodeFeature(15). Buying would be a straight loss.
    for (const redundant of [{ bitNode: 15 }, { sf15: 1 }, { bitNode: 15, sf15: 3 }]) {
      const decision = stepDarkscape(view(redundant));
      expect(decision.buy).toBe(false);
      expect(decision.why).toContain("free");
    }
  });

  test("BN15 wins over an unprobed gate, since the answer cannot change", () => {
    // Ordering matters: the redundancy guard must fire before the probe check,
    // or a BN15 run would report "not probed yet" for ever.
    expect(stepDarkscape(view({ bitNode: 15, hasProgram: undefined })).why).toContain("free");
  });

  test("not bought before the gate probe has reported", () => {
    const decision = stepDarkscape(view({ hasProgram: undefined }));
    expect(decision.buy).toBe(false);
    expect(decision.why).toContain("gate probe");
  });

  test("not bought when already owned", () => {
    expect(stepDarkscape(view({ hasProgram: true }))).toMatchObject({ buy: false, why: "already owned" });
  });

  test("the affordability guard is what stops an unpriced claim starving the farm", () => {
    // The claim is `pricing: "hard"` because the .cache payoff is unmodelled, and
    // an unpriced step resolves off the top of its band without ROI ranking. So
    // the guard is the protection: bid only while holding ten times the cost.
    expect(stepDarkscape(view({ money: DARKSCAPE_TOTAL_COST })).buy).toBe(false);
    expect(stepDarkscape(view({ money: RICH - 1 })).buy).toBe(false);
    expect(stepDarkscape(view({ money: RICH })).buy).toBe(true);
    expect(stepDarkscape(view({ money: 0 })).why).toContain("liquid cash");
  });

  test("not bought for a run that does not play dnet", () => {
    // An isolated hacking soak has no use for a darknet, and spending $50m in
    // one would make its numbers incomparable with every earlier measurement.
    const decision = stepDarkscape(view({ dnetActive: false }));
    expect(decision.buy).toBe(false);
    expect(decision.why).toContain("not a feature this run plays");
  });

  test("an unknown BitNode does not read as redundant", () => {
    // caps.bitNode is undefined until the gate probe runs. Treating that as
    // "maybe BN15" would silently never buy.
    expect(stepDarkscape(view({ bitNode: undefined })).buy).toBe(true);
  });
});
