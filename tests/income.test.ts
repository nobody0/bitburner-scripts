import { describe, expect, test } from "bun:test";
import {
  announcedIncome,
  bestIncomePerSec,
  bestReinvestmentReturnPerDollarSec,
} from "../game/lib/income.ts";
import { MS_PER_TICK } from "../shared/strategy/stock/market.ts";
import type { GameState } from "../game/lib/state.ts";

/** A FRESH state per call. `initState()` hands back a module-global singleton, so
 *  building fixtures from it leaks every test's topics into the next one. */
function state(topics: Record<string, unknown> = {}): GameState {
  return {
    topics, dirty: new Set(), mirrors: {}, mirrorDirty: new Set(),
    probeFailures: {}, probeSkips: {}, featureLastRun: {},
  } as unknown as GameState;
}
const by = (s: GameState, who: string) => announcedIncome(s).find((a) => a.by === who);

describe("income announcements", () => {
  test("the gang is converted from per-CYCLE to per-second", () => {
    // `GangGenInfo.moneyGainRate` is money per 200ms game cycle upstream. Announcing
    // it raw would understate the gang fivefold and hand career a priority it did not
    // earn — the exact kind of unit slip this comparison is most vulnerable to.
    expect(by(state({ gang: { moneyGainRate: 200 } }), "gang")?.perSec).toBe(1_000);
  });

  test("corp announces DIVIDENDS, not revenue", () => {
    // Revenue is the company's money; only dividends reach the player.
    const s = state({ corp: { revenue: 1e9, dividendEarnings: 500 } });
    expect(by(s, "corp")?.perSec).toBe(500);
    expect(bestIncomePerSec(s)).toBe(500);
  });

  test("stock spreads its expected profit over the hold it expects to need", () => {
    const s = state({ stock: { plan: { entry: { expectedProfit: 6_000, holdTicks: 10 } } } });
    // 10 ticks x 6s = 60s, so $100/sec.
    expect(by(s, "stock")?.perSec).toBeCloseTo(6_000 / (10 * (MS_PER_TICK / 1_000)), 9);
  });

  test("hacknet is silent in HASH mode — hashes are not dollars", () => {
    expect(by(state({ hacknet: { productionPerSec: 500, hashes: { current: 1 } } }), "hacknet")).toBeUndefined();
    expect(by(state({ hacknet: { productionPerSec: 500 } }), "hacknet")?.perSec).toBe(500);
  });

  test("nothing to say means NO announcement, never a zero", () => {
    // A fabricated zero would look like a real measurement of "earns nothing", and
    // `rateFraction` would then divide by it. Absence is the honest signal.
    expect(announcedIncome(state())).toEqual([]);
    expect(bestIncomePerSec(state())).toBe(0);
    expect(announcedIncome(state({ gang: { moneyGainRate: 0 }, corp: { dividendEarnings: 0 } }))).toEqual([]);
  });

  test("the best rate wins across features", () => {
    const s = state({
      fleet: { scriptIncome: [1_000, 0] },
      gang: { moneyGainRate: 400 },
      career: { plan: { ranked: [{ moneyPerSec: 300 }] } },
    });
    // gang 400/cycle = 2000/sec beats the farm's 1000.
    expect(bestIncomePerSec(s)).toBe(2_000);
    expect(announcedIncome(s).map((a) => a.by).sort()).toEqual(["career", "gang", "hacking"]);
  });
});

describe("reinvestment return", () => {
  test("uses the best money return across granted and denied claims", () => {
    const s = state({
      progression: {
        arbitration: {
          grants: [
            { by: "hacknet", id: "upgrade", resource: "money", returnPerDollarSec: 1 / 600 },
            { by: "hacking", id: "action", resource: "ram", returnPerDollarSec: 1 },
          ],
          denied: [
            { by: "stock", id: "position", resource: "money", returnPerDollarSec: 1 / 300 },
          ],
          remaining: { money: 0, ram: 0 },
        },
      },
    });
    expect(bestReinvestmentReturnPerDollarSec(s)).toBeCloseTo(1 / 300, 12);
  });

  test("includes the productive infrastructure frontier that is not yet affordable", () => {
    const s = state({
      fleet: { infrastructurePlan: { reinvestmentReturnPerDollarSec: 1 / 120 } },
      progression: {
        arbitration: {
          grants: [{ by: "hacknet", id: "upgrade", resource: "money", returnPerDollarSec: 1 / 300 }],
          denied: [],
          remaining: { money: 0, ram: 0 },
        },
      },
    });
    expect(bestReinvestmentReturnPerDollarSec(s)).toBeCloseTo(1 / 120, 12);
  });

  test("ignores absent, non-positive and non-finite returns", () => {
    const s = state({
      fleet: { infrastructurePlan: { reinvestmentReturnPerDollarSec: Number.NaN } },
      progression: {
        arbitration: {
          grants: [{ by: "hacknet", id: "upgrade", resource: "money", returnPerDollarSec: -1 }],
          denied: [{ by: "stock", id: "position", resource: "money", returnPerDollarSec: Infinity }],
          remaining: { money: 0, ram: 0 },
        },
      },
    });
    expect(bestReinvestmentReturnPerDollarSec(s)).toBe(0);
  });
});
