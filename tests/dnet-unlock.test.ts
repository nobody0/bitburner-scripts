import { describe, expect, test } from "bun:test";
import {
  DARKSCAPE_TOTAL_COST,
  stepDarkscape,
  type DarkscapeView,
} from "../shared/strategy/dnet/unlock.ts";
import { applyOverrides, disabledByProfile, only } from "../shared/features/profile.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";

/** Enough cash that the affordability guard is satisfied. */
const RICH = DARKSCAPE_TOTAL_COST;

function view(over: Partial<DarkscapeView> = {}): DarkscapeView {
  return { dnetDisabled: false, bitNode: 1, sf15: 0, hasProgram: false, money: RICH, ...over };
}

describe("buying DarkscapeNavigator.exe", () => {
  test("never bought in BN15 or with an active SF15", () => {
    // Prestige.ts re-grants the program, and TOR, at every install under
    // canAccessBitNodeFeature(15). Buying would be a straight loss.
    for (const redundant of [{ bitNode: 15 }, { sf15: 1 }, { bitNode: 15, sf15: 3 }]) {
      expect(stepDarkscape(view(redundant))).toBe(false);
    }
  });

  test("BN15 with an unprobed gate still refuses without waiting on the probe", () => {
    expect(stepDarkscape(view({ bitNode: 15, hasProgram: undefined }))).toBe(false);
  });

  test("not bought before the gate probe has reported", () => {
    expect(stepDarkscape(view({ hasProgram: undefined }))).toBe(false);
  });

  test("not bought when already owned", () => {
    expect(stepDarkscape(view({ hasProgram: true }))).toBe(false);
  });

  test("access is bought as soon as TOR plus Darkscape are affordable", () => {
    // The arbiter prices the indivisible claim economically; this guard ensures
    // the executor cannot bid until it can pay for both TOR and the program.
    expect(stepDarkscape(view({ money: RICH - 1 }))).toBe(false);
    expect(stepDarkscape(view({ money: RICH }))).toBe(true);
    expect(stepDarkscape(view({ money: 0 }))).toBe(false);
  });

  test("not bought for a run that has dnet switched off", () => {
    // An isolated hacking soak has no use for a darknet, and spending $50m in
    // one would make its numbers incomparable with every earlier measurement.
    // The signal is the profile override, NOT activeFeatures — that set is
    // derived from driverEnabled, so dnet is absent from it while still locked
    // and gating on it would deadlock the purchase.
    expect(stepDarkscape(view({ dnetDisabled: true }))).toBe(false);
  });

  test("locked is not the same as switched off, which is what makes the purchase possible", () => {
    // `activeFeatures` comes from driverEnabled and excludes dnet
    // exactly while it is locked — the state in which we need to buy it.
    const locked = deriveCapabilities({ bitNode: 1, sourceFiles: {}, hasDarknetProgram: false });
    expect(locked.unlocked.dnet).toBe("no");
    expect(disabledByProfile(locked, "dnet")).toBe(false);

    // A profile that switched it off is a different state, and the only one
    // that should stop the purchase.
    const off = applyOverrides(locked, only("hacking"));
    expect(off.unlocked.dnet).toBe("no");
    expect(disabledByProfile(off, "dnet")).toBe(true);

    expect(stepDarkscape(view({ dnetDisabled: disabledByProfile(locked, "dnet") }))).toBe(true);
    expect(stepDarkscape(view({ dnetDisabled: disabledByProfile(off, "dnet") }))).toBe(false);
  });

  test("an unknown BitNode does not read as redundant", () => {
    // caps.bitNode is undefined until the gate probe runs. Treating that as
    // "maybe BN15" would silently never buy.
    expect(stepDarkscape(view({ bitNode: undefined }))).toBe(true);
  });
});
