import { describe, expect, test } from "bun:test";
import { only } from "../../shared/features/profile.ts";
import { parseGoal } from "../../shared/goals/presets.ts";
import { runGame } from "../game-run.ts";
import { lane } from "../../tests/support/lanes.ts";

/** The real controller against a fresh BN8 market, where hacked money is
 * worth nothing and the market is the only income. `bun run long bn8`. */
lane({ feature: "stock", bn: 8 }).describe("BN8 stock isolation validity", () => {
  test("the real controller can observe and trade a fresh BN8 market with no fidelity gaps", async () => {
    const result = await runGame({
      goal: parseGoal("wealth:1e99"),
      seed: 1,
      horizonMs: 5 * 60_000 + 1,
      bitnode: 8,
      startingMoney: 250e6,
      features: only("stock", "progression"),
    });

    // Crosses the five-minute order-probe boundary. An empty book is observed
    // state; it must not invalidate every BN8 experiment merely because order
    // mutation/fills are intentionally outside the strategy.
    expect(result.unmodeled).toEqual({});
    expect(result.crashes).toEqual([]);
    expect(result.validity).toBe("valid");
    expect(result.stock.wealth).toBe(result.stock.cash + result.stock.liquidationValue);
    expect(result.stock.tradesMade).toBeGreaterThan(0);
  });
});
