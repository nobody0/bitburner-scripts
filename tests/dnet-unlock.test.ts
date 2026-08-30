import { describe, expect, test } from "bun:test";
import {
  DARKSCAPE_TOTAL_COST,
  stepDarkscape,
  type DarkscapeView,
} from "../shared/strategy/dnet/unlock.ts";
import { only } from "../sim/feature-selection.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";

/** Enough cash that the affordability guard is satisfied. */
const RICH = DARKSCAPE_TOTAL_COST;

function view(over: Partial<DarkscapeView> = {}): DarkscapeView {
  return { bitNode: 1, sf15: 0, hasProgram: false, money: RICH, ...over };
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

  test("scenario selection does not rewrite a locked capability or the pure purchase decision", () => {
    const locked = deriveCapabilities({ bitNode: 1, sourceFiles: {}, hasDarknetProgram: false });
    expect(locked.unlocked.dnet).toBe("no");
    expect(new Set(only("hacking")).has("dnet")).toBe(false);
    expect(locked.unlocked.dnet).toBe("no");
    expect(stepDarkscape(view())).toBe(true);
  });

  test("an unknown BitNode does not read as redundant", () => {
    // caps.bitNode is undefined until the gate probe runs. Treating that as
    // "maybe BN15" would silently never buy.
    expect(stepDarkscape(view({ bitNode: undefined }))).toBe(true);
  });
});
