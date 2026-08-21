import { describe, expect, test } from "bun:test";
import {
  announcedIncome,
  announcedRates,
  bestIncomePerSec,
  bestReinvestmentReturnPerDollarSec,
  incomeShares,
} from "../game/lib/income.ts";
import { NOMINAL_VALUE_SEC_PER_WEIGHT } from "../shared/strategy/access/value.ts";
import {
  bestByChannel,
  channelWorth,
  compareSlotValues,
  deliveryFraction,
  scaleSlotValue,
  slotValue,
} from "../shared/strategy/income.ts";
import { postNeeds } from "../shared/strategy/needs.ts";
import { MS_PER_TICK } from "../shared/strategy/stock/market.ts";
import type { GameState } from "../game/lib/state.ts";

/** A FRESH state per call. `initState()` hands back a module-global singleton, so
 *  building fixtures from it leaks every test's topics into the next one. */
function state(topics: Record<string, unknown> = {}): GameState {
  return {
    topics, dirty: new Set(), mirrors: {}, mirrorDirty: new Set(),
    probeFailures: {}, featureLastRun: {},
  } as unknown as GameState;
}
const by = (s: GameState, who: string) => announcedIncome(s).find((a) => a.by === who);
const perSec = (s: GameState, who: string): number | undefined => {
  const entry = by(s, who);
  return entry?.state === "measured" ? entry.perSec : undefined;
};

describe("income announcements", () => {
  test("the gang is converted from per-CYCLE to per-second", () => {
    // `GangGenInfo.moneyGainRate` is money per 200ms game cycle upstream. Announcing
    // it raw would understate the gang fivefold and hand career a priority it did not
    // earn — the exact kind of unit slip this comparison is most vulnerable to.
    expect(perSec(state({ gang: { moneyGainRate: 200 } }), "gang")).toBe(1_000);
  });

  test("corp announces DIVIDENDS, not revenue", () => {
    // Revenue is the company's money; only dividends reach the player.
    const s = state({ corp: { revenue: 1e9, dividendEarnings: 500 } });
    expect(perSec(s, "corp")).toBe(500);
    expect(bestIncomePerSec(s)).toEqual({ state: "measured", value: 500 });
  });

  test("stock spreads its expected profit over the hold it expects to need", () => {
    const s = state({ stock: { plan: { entry: { expectedProfit: 6_000, holdTicks: 10 } } } });
    // 10 ticks x 6s = 60s, so $100/sec.
    expect(perSec(s, "stock")).toBeCloseTo(6_000 / (10 * (MS_PER_TICK / 1_000)), 9);
  });

  test("hacknet is silent in HASH mode — hashes are not dollars", () => {
    expect(by(state({ hacknet: { productionPerSec: 500, hashes: { current: 1 } } }), "hacknet")).toMatchObject({ state: "unknown" });
    expect(perSec(state({ hacknet: { productionPerSec: 500 } }), "hacknet")).toBe(500);
  });

  test("unknown income remains unknown rather than reading as zero", () => {
    const empty = bestIncomePerSec(state());
    expect(empty.state).toBe("unknown");
    expect(announcedIncome(state()).filter((entry) => entry.state === "unknown").map((entry) => entry.by))
      .toEqual(expect.arrayContaining(["hacking", "hacknet", "career", "sleeves", "bladeburner", "side"]));

    // Measured zeros remain distinct, but unknown parallel earners prevent
    // them from being promoted to a known best-of-field zero.
    expect(bestIncomePerSec(state({ gang: { moneyGainRate: 0 }, corp: { dividendEarnings: 0 } })).state).toBe("unknown");
  });
  test("the best rate wins across features", () => {
    const s = state({
      fleet: { scriptIncome: [1_000, 0] },
      gang: { moneyGainRate: 400 },
      career: { plan: { ranked: [{ moneyPerSec: 300 }] } },
    });
    // gang 400/cycle = 2000/sec beats the farm's 1000.
    expect(bestIncomePerSec(s)).toEqual({ state: "measured", value: 2_000 });
    expect(announcedIncome(s).filter((a) => a.state === "measured").map((a) => a.by).sort()).toEqual(["career", "gang", "hacking"]);
  });
});

describe("income shares", () => {
  test("shares are GROSS live rates, normalised over measured announcers only", () => {
    const s = state({
      farm: { moneyRate: 99 },
      hacknet: { productionPerSec: 1 },
      // Expenses cannot enter: this reads announced RATES, never the
      // since-install ledger. `MoneySource.total` is net of hacknet, server and
      // augmentation spending, so dividing by it once reported a hacknet share
      // ABOVE ONE and pinned the Go selector on Netburners for hours.
      progression: { moneySources: { sinceInstall: { total: 1, hacking: 1e9, hacknet: 1e9, hacknet_expenses: -1e9 } } },
    });
    expect(incomeShares(s).hacknet).toBeCloseTo(0.01, 9);
    expect(incomeShares(s).hacking).toBeCloseTo(0.99, 9);
  });

  test("an unmeasured source is absent, not a measured zero", () => {
    const shares = incomeShares(state({ farm: { moneyRate: 100 } }));
    expect(shares.hacking).toBe(1);
    expect("hacknet" in shares).toBe(false);
    expect("career" in shares).toBe(false);
    // Nothing measured at all yields an empty map rather than fabricated zeros.
    expect(incomeShares(state())).toEqual({});
  });
});

describe("reinvestment return", () => {
  test("uses the best money return across granted and denied claims", () => {
    const s = state({
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
    });
    expect(bestReinvestmentReturnPerDollarSec(s)).toBeCloseTo(1 / 300, 12);
  });

  test("includes the productive infrastructure frontier that is not yet affordable", () => {
    const s = state({
      fleet: { infrastructurePlan: { reinvestmentReturnPerDollarSec: 1 / 120 } },
      arbitration: {
        grants: [{ by: "hacknet", id: "upgrade", resource: "money", returnPerDollarSec: 1 / 300 }],
        denied: [],
        remaining: { money: 0, ram: 0 },
      },
    });
    expect(bestReinvestmentReturnPerDollarSec(s)).toBeCloseTo(1 / 120, 12);
  });

  test("ignores absent, non-positive and non-finite returns", () => {
    const s = state({
      fleet: { infrastructurePlan: { reinvestmentReturnPerDollarSec: Number.NaN } },
      arbitration: {
        grants: [{ by: "hacknet", id: "upgrade", resource: "money", returnPerDollarSec: -1 }],
        denied: [{ by: "stock", id: "position", resource: "money", returnPerDollarSec: Infinity }],
        remaining: { money: 0, ram: 0 },
      },
    });
    expect(bestReinvestmentReturnPerDollarSec(s)).toBe(0);
  });
});

describe("the alternatives-and-worth table", () => {
  test("channels are announced separately, and an unknown one is not a zero", () => {
    const best = bestByChannel(announcedRates(state({
      fleet: { scriptIncome: [1_000, 0] },
      farm: { expRate: 250 },
    })));
    expect(best.get("money")).toEqual({ state: "measured", value: 1_000 });
    expect(best.get("hacking")).toEqual({ state: "measured", value: 250 });
    // Only the work slot produces reputation, so the background field is empty
    // — stated explicitly, never as a measured zero, or a claim would be scored
    // as a fraction of nothing.
    expect(best.get("reputation")?.state).toBe("unknown");
  });

  test("a route marginal prices its currency, INCLUDING a measured zero", () => {
    // The live BN12 number: the farm clears the Daedalus money gate long before
    // anything else on the route binds, so a relative income increase saves no
    // seconds at all. That is an answer, and career's crime is scored by it.
    const worth = channelWorth(postNeeds([]), {
      money: { state: "estimated", secondsPerRelativeRate: 0 },
      hacking: { state: "estimated", secondsPerRelativeRate: 19_174 },
      reputation: { state: "unknown", secondsPerRelativeRate: 0, reason: "no forecast" },
    });
    expect(worth.get("money")).toBe(0);
    expect(worth.get("hacking")).toBe(19_174);
    // Unknown leaves the channel ABSENT, which is what puts its claims on the
    // bootstrap money rule rather than pricing them at zero.
    expect(worth.has("reputation")).toBe(false);
  });

  test("the marginal overrides a posted weight for the same outcome", () => {
    const moneyGate = {
      by: "progression" as const, kind: "money" as const, target: 1e11, have: 1.8e10,
      weight: 5, urgency: "blocking" as const,
    };
    // Posting both would count the same progress twice, and only one of them
    // was measured.
    const priced = channelWorth(postNeeds([moneyGate]), {
      money: { state: "estimated", secondsPerRelativeRate: 0 },
      hacking: { state: "unknown", secondsPerRelativeRate: 0, reason: "no forecast" },
      reputation: { state: "unknown", secondsPerRelativeRate: 0, reason: "no forecast" },
    });
    expect(priced.get("money")).toBe(0);

    // With no marginal the poster's estimate is still better than silence.
    expect(channelWorth(postNeeds([moneyGate])).get("money")).toBe(5 * NOMINAL_VALUE_SEC_PER_WEIGHT);
  });

  test("same-key needs add, exactly as their weights do", () => {
    const karma = (by: "factions" | "progression", weight: number) => ({
      by, kind: "karma" as const, target: -54_000, have: -3_000,
      weight, urgency: "wanted" as const,
    });
    expect(channelWorth(postNeeds([karma("factions", 1), karma("progression", 2)])).get("karma"))
      .toBe(3 * NOMINAL_VALUE_SEC_PER_WEIGHT);
  });

  test("a measured valueSec is preferred to the nominal weight fallback", () => {
    expect(channelWorth(postNeeds([{
      by: "factions", kind: "backdoor", subject: "CSEC", target: 1, have: 0,
      weight: 2, valueSec: 4_000, urgency: "blocking",
    }])).get("backdoor:CSEC")).toBe(4_000);
  });
});

describe("pricing a bid for the work slot", () => {
  const worth = new Map([["money", 100], ["reputation", 4_000]]);

  test("a bid is worth its share of the best rate, times what that rate is worth", () => {
    const value = slotValue({
      produces: { money: 1_000 },
      best: new Map([["money", { state: "measured", value: 4_000 }]]),
      worth,
    });
    expect(value.state).toBe("priced");
    expect(value.valueSec).toBeCloseTo(0.25 * 100, 12);
  });

  test("channels ADD, because work paying in two currencies is worth both", () => {
    const value = slotValue({
      produces: { money: 2_000, reputation: 40 },
      best: new Map<string, { state: "measured"; value: number }>([
        ["money", { state: "measured", value: 4_000 }],
        ["reputation", { state: "measured", value: 40 }],
      ]),
      worth,
    });
    expect(value.valueSec).toBeCloseTo(0.5 * 100 + 1 * 4_000, 12);
  });

  test("a channel nobody priced contributes nothing and leaves the bid unpriced", () => {
    const value = slotValue({ produces: { karma: 3 }, best: new Map(), worth });
    expect(value).toMatchObject({ state: "unpriced", valueSec: 0, moneyPerSec: 0 });
  });

  test("unpriced bids compare by money, and never against a priced one", () => {
    const priced = slotValue({
      produces: { money: 1 },
      best: new Map([["money", { state: "measured" as const, value: 1 }]]),
      worth: new Map([["money", 1]]),
    });
    const richer = slotValue({ produces: { money: 1e9 }, best: new Map(), worth: new Map() });
    const poorer = slotValue({ produces: { money: 1 }, best: new Map(), worth: new Map() });
    expect(compareSlotValues(richer, poorer)).toBeLessThan(0);
    // Dollars are never compared against BN-seconds: priced sorts first.
    expect(compareSlotValues(priced, richer)).toBeLessThan(0);
  });
});

/** `slotValue` prices a SUSTAINED rate. A claimant that must occupy the slot
 *  before it delivers anything — a program write, not a wage — only gets the
 *  part of the run that is left once it has finished paying. */
describe("a bounded bid delivers only the horizon it leaves behind", () => {
  const value = (): ReturnType<typeof slotValue> => slotValue({
    produces: { money: 1_000, reputation: 40 },
    best: new Map<string, { state: "measured"; value: number }>([
      ["money", { state: "measured", value: 4_000 }],
      ["reputation", { state: "measured", value: 40 }],
    ]),
    worth: new Map([["money", 100], ["reputation", 4_000]]),
  });

  test("the delivery fraction is the share of the horizon left after the occupancy", () => {
    expect(deliveryFraction(600, 3_600)).toBeCloseTo(5 / 6, 12);
    expect(deliveryFraction(1_800, 3_600)).toBeCloseTo(0.5, 12);
    // Nothing to occupy: continuous work delivers for the whole horizon.
    expect(deliveryFraction(0, 3_600)).toBe(1);
    // Finishing exactly when the node ends, or after it, delivers nothing.
    expect(deliveryFraction(3_600, 3_600)).toBe(0);
    expect(deliveryFraction(7_200, 3_600)).toBe(0);
  });

  test("a scale can only ever discount", () => {
    // The invariant the whole table rests on: a score never exceeds what the
    // channels it produces are worth, so no caller can inflate a bid.
    expect(scaleSlotValue(value(), 2).valueSec).toBe(value().valueSec);
    expect(scaleSlotValue(value(), -1).valueSec).toBe(0);
    expect(scaleSlotValue(value(), Number.NaN).valueSec).toBe(0);
  });

  test("scaling a value scales every channel contribution with it", () => {
    const scaled = scaleSlotValue(value(), 0.5);
    expect(scaled.valueSec).toBeCloseTo(value().valueSec * 0.5, 12);
    for (const [index, channel] of scaled.channels.entries()) {
      const original = value().channels[index]!;
      expect(channel.valueSec).toBeCloseTo(original.valueSec * 0.5, 12);
      // What the channel is worth and how fast we produce it are both unchanged
      // — only the share of it that lands is discounted.
      expect(channel.worthSec).toBe(original.worthSec);
      expect(channel.ourRate).toBe(original.ourRate);
    }
    expect(scaled.moneyPerSec).toBe(value().moneyPerSec);
  });

  test("a bid that delivers nothing inside the horizon is unpriced, not priced at zero", () => {
    // Load-bearing: `compareSlotValues` puts every priced claim ahead of every
    // unpriced one, so a priced ZERO would still beat every crime on a board
    // where only its own need carries a worth, and would hold the slot forever
    // producing nothing.
    const write = slotValue({
      produces: { "file:SQLInject.exe": 1 },
      best: new Map([["file:SQLInject.exe", { state: "measured" as const, value: 1 }]]),
      worth: new Map([["file:SQLInject.exe", 2_400]]),
    });
    expect(write).toMatchObject({ state: "priced" });
    const nothing = scaleSlotValue(write, 0);
    expect(nothing).toMatchObject({ state: "unpriced", valueSec: 0 });
    const crime = slotValue({
      produces: { money: 1_000 },
      best: new Map([["money", { state: "measured" as const, value: 1_000 }]]),
      worth: new Map([["money", 1]]),
    });
    // Worth a single BN-second, and it still takes the slot from a write that
    // will not land before the node ends.
    expect(compareSlotValues(crime, nothing)).toBeLessThan(0);
  });
});
