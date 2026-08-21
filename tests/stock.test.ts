import { describe, expect, test } from "bun:test";
import { buildView } from "../game/lib/features/stock.ts";
import { emptyBoard, noGrants } from "../game/lib/features/index.ts";
import { initState } from "../game/lib/state.ts";
import { unknownCapabilities } from "../shared/features/unlock.ts";
import { unknownForecast } from "../shared/strategy/progression/forecast.ts";
import {
  midpoint,
  STOCK_METADATA,
  STOCK_SYMBOLS,
  SYMBOL_BY_HOST,
  volatilityEstimate,
  worstSpreadFraction,
} from "../shared/features/stocks.ts";
import {
  breakEvenTicks,
  COMMISSION,
  driftPerTick,
  effectiveForecast,
  expectedProfit,
  manipulationLeverage,
  meanLogStep,
  nudgesPerOp,
  nudgeValue,
  roundTripCost,
  roundTripCostFraction,
  selfInfluenceCost,
  TICKS_PER_CYCLE,
} from "../shared/strategy/stock/market.ts";
import {
  CYCLE_QUORUM,
  estimateSignal,
  initHistory,
  observeMarket,
  ticksUntilCycle,
  type PriceSample,
} from "../shared/strategy/stock/history.ts";
import {
  ENTER_BAND,
  fundedActions,
  initStockMemory,
  manipulationByHost,
  MIN_HOLD_TICKS,
  stepStock,
  type StockGrants,
  type StockSymbolView,
  type StockView,
} from "../shared/strategy/stock/decide.ts";

/** The stock feature's pure half.
 *
 * Split from tests/features-remaining.test.ts because the solver stopped being a
 * ranking and became four interacting models: how prices move, what a trade
 * costs, what the price history reveals without 4S, and when a position must be
 * liquidated. Its face against the REAL market lives in sim/tests/. */

// --- fixtures ---------------------------------------------------------------
/** Both money claims funded to `amount`. Most tests exercise one of the two at a
 *  time; the ones that care about the split say so explicitly. */
function granted(amount: number): StockGrants {
  return { unlock: amount, position: amount };
}

function symbol(over: Partial<StockSymbolView> = {}): StockSymbolView {
  return {
    sym: "ECP",
    ask: 20_000,
    bid: 19_960,
    maxShares: 20_000_000,
    shares: 0,
    avgPx: 0,
    sharesShort: 0,
    avgPxShort: 0,
    ...over,
  };
}

function view(over: Partial<StockView> = {}): StockView {
  return {
    symbols: [symbol()],
    hasWseAccount: true,
    hasTixApi: true,
    has4SApi: true,
    canShort: true,
    fourSigmaDisabled: false,
    farmableHosts: [],
    symbolByHost: SYMBOL_BY_HOST,
    moneyGranted: 1e10,
    totalMoney: 1e10,
    portfolioValue: 0,
    positionHorizonSec: 3_600,
    unlockHorizonSec: 86_400,
    liquidate: false,
    ...over,
  };
}

/** Drive N market ticks past the solver, alternating price direction according
 *  to `up`. Returns the decision after the last tick. */
function run(base: StockView, ticks: number, up: (tick: number, sym: string) => boolean) {
  const memory = initStockMemory();
  let decision = stepStock(base, memory);
  const prices = new Map(base.symbols.map((s) => [s.sym, (s.ask + s.bid) / 2]));
  for (let tick = 0; tick < ticks; tick++) {
    const symbols = base.symbols.map((s) => {
      const spread = (s.ask - s.bid) / (s.ask + s.bid);
      const next = prices.get(s.sym)! * (up(tick, s.sym) ? 1.002 : 1 / 1.002);
      prices.set(s.sym, next);
      return { ...s, ask: next * (1 + spread), bid: next * (1 - spread) };
    });
    decision = stepStock({ ...base, symbols }, memory);
  }
  return { decision, memory };
}

// --- the metadata table -----------------------------------------------------

describe("stock metadata", () => {
  test("the worst spread is 4% of notional, twenty times the commission on a $1b trade", () => {
    // NTLK's spreadPerc tops out at 2.0, charged on BOTH legs.
    expect(worstSpreadFraction("NTLK")).toBeCloseTo(0.04, 6);
    const spreadCost = 1e9 * worstSpreadFraction("NTLK");
    expect(spreadCost).toBeGreaterThan(20 * 2 * COMMISSION);
  });
});

// --- price movement ---------------------------------------------------------

describe("market mechanics", () => {
  test("the exact integral beats the linear approximation at high volatility", () => {
    // NTLK can reach mv 4.0 -> volatility 0.04, where volatility/2 is visibly
    // wrong and compounds over a 75-tick hold.
    const exact = meanLogStep(0.04);
    expect(exact).toBeLessThan(0.02);
    expect(Math.abs(exact - 0.02) / 0.02).toBeGreaterThan(0.005);
  });

  test("forecast 0.5 is exactly zero drift — no information means no trade", () => {
    expect(driftPerTick(0.5, 0.01)).toBe(0);
    expect(driftPerTick(0.6, 0.01)).toBeGreaterThan(0);
    expect(driftPerTick(0.4, 0.01)).toBeCloseTo(-driftPerTick(0.6, 0.01), 12);
  });

  test("a round trip pays BOTH commissions and crosses the spread twice", () => {
    // Buy at ask, sell at bid: the loss is shares * (ask - bid) plus $200k.
    expect(roundTripCost(1000, 100, 99)).toBeCloseTo(2 * COMMISSION + 1000, 6);
    expect(roundTripCostFraction(100, 99)).toBeCloseTo(0.01, 9);
    expect(roundTripCostFraction(0, 99)).toBe(Infinity);
  });

  test("break-even ticks fall as the position grows, but never below the spread's floor", () => {
    const common = { ask: 20_000, bid: 19_960, forecast: 0.6, volatility: 0.0045, side: "long" as const };
    const small = breakEvenTicks({ ...common, shares: 100 });
    const large = breakEvenTicks({ ...common, shares: 1_000_000 });
    // Commission is fixed, so a bigger position amortizes it — that is the only
    // sense in which size helps.
    expect(large).toBeLessThan(small);
    // But the spread is proportional, so break-even converges on a positive
    // floor rather than to zero. A trader who thinks size is free stops here.
    expect(large).toBeGreaterThan(0.5);
    const spreadOnly = roundTripCostFraction(20_000, 19_960) / driftPerTick(0.6, 0.0045);
    expect(large).toBeCloseTo(spreadOnly, 0);
  });

  test("no drift means no break-even, at any size", () => {
    expect(breakEvenTicks({ shares: 1e9, ask: 100, bid: 99, forecast: 0.5, volatility: 0.01, side: "long" })).toBe(Infinity);
    expect(breakEvenTicks({ shares: 0, ask: 100, bid: 99, forecast: 0.9, volatility: 0.01, side: "long" })).toBe(Infinity);
  });

  test("expected profit is negative before break-even and positive after", () => {
    const common = { shares: 100_000, ask: 20_000, bid: 19_960, forecast: 0.6, volatility: 0.0045, side: "long" as const };
    const be = breakEvenTicks(common);
    expect(expectedProfit({ ...common, ticks: Math.floor(be / 2) })).toBeLessThan(0);
    expect(expectedProfit({ ...common, ticks: Math.ceil(be * 2) })).toBeGreaterThan(0);
  });

  test("a short's profit mirrors a long's on the same signal", () => {
    const common = { shares: 100_000, ask: 100, bid: 99, volatility: 0.01, ticks: 50 };
    const long = expectedProfit({ ...common, forecast: 0.65, side: "long" });
    const short = expectedProfit({ ...common, forecast: 0.35, side: "short" });
    // Not identical — the short's notional is the bid and the long's the ask —
    // but the same order of magnitude and both profitable.
    expect(long).toBeGreaterThan(0);
    expect(short).toBeGreaterThan(0);
    expect(Math.abs(long - short) / long).toBeLessThan
      (0.05);
  });

  test("a big trade degrades its own forecast, and cannot push it past the floor", () => {
    const shareTx = midpoint(STOCK_METADATA["ECP"]!.shareTxForMovement);
    // ECP's full 20M-share allocation is ~330 movements at 0.006 each.
    const cost = selfInfluenceCost(20_000_000, shareTx, 0.69);
    expect(cost).toBeGreaterThan(0.01);
    expect(effectiveForecast(0.69, 20_000_000, shareTx)).toBeLessThan(0.69);
    // influenceForecast floors otlkMag at 5, i.e. forecast 0.55: a symbol
    // already there cannot be damaged further, however large the trade.
    expect(selfInfluenceCost(1e9, shareTx, 0.55)).toBe(0);
    expect(selfInfluenceCost(1e9, shareTx, 0.52)).toBe(0);
    // And the damage is clamped so it can never overshoot the floor.
    expect(effectiveForecast(0.69, 1e9, shareTx)).toBeGreaterThanOrEqual(0.55);
  });

  test("a short's self-influence moves its forecast UP toward neutral", () => {
    const shareTx = 50_000;
    expect(effectiveForecast(0.3, 1_000_000, shareTx)).toBeGreaterThan(0.3);
  });
});

// --- manipulation -----------------------------------------------------------

describe("manipulation value", () => {
  test("nudges per op are the steal fraction, clamped to one roll", () => {
    expect(nudgesPerOp(0.5)).toBeCloseTo(0.05, 9);
    expect(nudgesPerOp(1)).toBeCloseTo(0.1, 9);
    expect(nudgesPerOp(4)).toBeCloseTo(0.1, 9);
    expect(nudgesPerOp(-1)).toBe(0);
  });

  test("a nudge is worth more on a bigger position and a longer hold", () => {
    const base = { notional: 1e9, volatility: 0.0045, ticks: 50, forecast: 0.6, side: "long" as const };
    expect(nudgeValue({ ...base, notional: 2e9 })).toBeCloseTo(2 * nudgeValue(base), 6);
    expect(nudgeValue({ ...base, ticks: 100 })).toBeCloseTo(2 * nudgeValue(base), 6);
    expect(nudgeValue({ ...base, ticks: 0 })).toBe(0);
  });

  test("nudging saturates as the forecast approaches the extreme", () => {
    const base = { notional: 1e9, volatility: 0.0045, ticks: 50, side: "long" as const };
    // changeForecastForecast clamps at 100, so a symbol already forecast 0.99
    // has almost no headroom left to push into.
    expect(nudgeValue({ ...base, forecast: 0.99 })).toBeLessThan(nudgeValue({ ...base, forecast: 0.55 }));
    expect(nudgeValue({ ...base, forecast: 1 })).toBe(0);
    // A short pushes the other way, so its headroom is measured downward.
    expect(nudgeValue({ ...base, forecast: 0, side: "short" })).toBe(0);
  });
});

// --- BitNode multipliers ----------------------------------------------------

describe("BitNode effect on the market", () => {
  test("manipulation leverage is infinite exactly when hacked money is worthless", () => {
    // BN8: ScriptHackMoneyGain 0. Hacking earns literally nothing while still
    // draining the server, so the market is not one income source among several.
    expect(manipulationLeverage({ ScriptHackMoneyGain: 0 })).toBe(Infinity);
    expect(manipulationLeverage({ ScriptHackMoneyGain: 0.5 })).toBe(2);
    expect(manipulationLeverage(undefined)).toBe(1);
  });
});

// --- signal recovery --------------------------------------------------------

describe("price history", () => {
  /** A tick where every symbol moves by v * mv/100, sharing one `v`. */
  function tick(
    prices: Map<string, number>,
    v: number,
    up: (sym: string) => boolean,
    volatility = (sym: string) => midpoint(STOCK_METADATA[sym]!.mv) / 100,
  ): PriceSample[] {
    return [...prices.entries()].map(([sym, price]) => {
      const av = v * volatility(sym);
      const next = up(sym) ? price * (1 + av) : price / (1 + av);
      prices.set(sym, next);
      const spread = midpoint(STOCK_METADATA[sym]!.spreadPerc) / 100;
      return { sym, ask: next * (1 + spread), bid: next * (1 - spread) };
    });
  }

  test("oversampling is free: a sample with no price change is the same tick", () => {
    const history = initHistory();
    const samples: PriceSample[] = [{ sym: "ECP", ask: 100.1, bid: 99.9 }];
    expect(observeMarket(history, samples)).toBe(false); // first sighting, no move yet
    expect(observeMarket(history, samples)).toBe(false);
    expect(history.tick).toBe(0);
    expect(observeMarket(history, [{ sym: "ECP", ask: 101.1, bid: 100.9 }])).toBe(true);
    expect(history.tick).toBe(1);
  });

  test("upstream ranges bootstrap the shared roll, then live prices refine volatility", () => {
    const prices = new Map(STOCK_SYMBOLS.map((sym) => [sym, midpoint(STOCK_METADATA[sym]!.initPrice)]));
    const history = initHistory();
    observeMarket(history, tick(prices, 0.5, () => true));
    for (let i = 0; i < 40; i++) observeMarket(history, tick(prices, 0.6, (sym) => sym !== "JGN"));
    expect(history.lastV).toBeCloseTo(0.6, 1);
    expect(history.symbols["ECP"]!.volatility).toBeCloseTo(volatilityEstimate("ECP"), 3);
    expect(history.symbols["NTLK"]!.volatility).toBeCloseTo(volatilityEstimate("NTLK"), 3);
  });

  test("one basket tick solves extreme discrete volatility rolls from the vendored corpus", () => {
    const prices = new Map(STOCK_SYMBOLS.map((sym) => [sym, midpoint(STOCK_METADATA[sym]!.initPrice)]));
    const actual = new Map(STOCK_SYMBOLS.map((sym, index) => {
      const range = STOCK_METADATA[sym]!.mv;
      return [sym, range[index % 2] / 100] as const;
    }));
    const history = initHistory();
    const quotes = tick(prices, 0, () => true, (sym) => actual.get(sym)!);
    observeMarket(history, quotes);
    observeMarket(history, tick(prices, 0.731, (sym) => sym !== "NTLK", (sym) => actual.get(sym)!));

    expect(history.lastV).toBeCloseTo(0.731, 10);
    for (const sym of STOCK_SYMBOLS) {
      expect(history.symbols[sym]!.volatility, sym).toBeCloseTo(actual.get(sym)!, 10);
    }
  });

  test("the up-tick frequency estimates the forecast, shrunk until there is evidence", () => {
    const history = initHistory();
    let price = 100;
    const step = (up: boolean): void => {
      price = up ? price * 1.002 : price / 1.002;
      observeMarket(history, [{ sym: "ECP", ask: price * 1.001, bid: price * 0.999 }]);
    };
    step(true);
    // Four heads is not evidence: shrinkage keeps the estimate near the coin flip.
    for (let i = 0; i < 4; i++) step(true);
    const thin = estimateSignal(history, "ECP");
    expect(thin.confident).toBe(false);
    expect(Math.abs(thin.forecast - 0.5)).toBeLessThan(ENTER_BAND);
    // A long run of up-ticks does move it, and marks itself as estimated.
    for (let i = 0; i < 120; i++) step(true);
    const thick = estimateSignal(history, "ECP");
    expect(thick.confident).toBe(true);
    expect(thick.exact).toBe(false);
    expect(thick.forecast).toBeGreaterThan(0.5 + ENTER_BAND);
  });

  test("4S overrides the estimate outright", () => {
    const history = initHistory();
    observeMarket(history, [{ sym: "ECP", ask: 100, bid: 99, forecast: 0.62, volatility: 0.0044 }]);
    const signal = estimateSignal(history, "ECP", 0.62);
    expect(signal.exact).toBe(true);
    expect(signal.confident).toBe(true);
    expect(signal.forecast).toBe(0.62);
  });

  test("a cycle boundary is detected from simultaneous 0.5 crossings, and fixes the clock", () => {
    // A cycle flips bull/bear for ~45% of symbols, which moves each one's
    // forecast from 50+otlkMag to 50-otlkMag — straight across 0.5. Nothing else
    // moves that many at once: ordinary drift is ~0.0004 per tick.
    const history = initHistory();
    const prices = new Map(STOCK_SYMBOLS.map((sym) => [sym, 1000]));
    const forecasts = new Map(STOCK_SYMBOLS.map((sym) => [sym, 0.65]));
    const sample = (): PriceSample[] =>
      tick(prices, 0.5, () => true).map((s) => ({ ...s, forecast: forecasts.get(s.sym)!, volatility: 0.005 }));

    for (let i = 0; i < 20; i++) observeMarket(history, sample());
    expect(ticksUntilCycle(history)).toBeUndefined();
    expect(history.cyclesSeen).toBe(0);

    // Flip a quorum's worth.
    for (const sym of STOCK_SYMBOLS.slice(0, CYCLE_QUORUM + 2)) forecasts.set(sym, 0.35);
    observeMarket(history, sample());
    expect(history.cyclesSeen).toBe(1);
    expect(history.lastFlipCount).toBeGreaterThanOrEqual(CYCLE_QUORUM);
    expect(ticksUntilCycle(history)).toBe(TICKS_PER_CYCLE);

    // From here the period is exact: 75 ticks, counted in ticks rather than
    // seconds because the tick interval varies with the stored-cycle catch-up.
    for (let i = 0; i < 10; i++) observeMarket(history, sample());
    expect(ticksUntilCycle(history)).toBe(TICKS_PER_CYCLE - 10);
  });

  test("ordinary drift never trips the cycle detector", () => {
    const history = initHistory();
    const prices = new Map(STOCK_SYMBOLS.map((sym) => [sym, 1000]));
    let forecast = 0.65;
    for (let i = 0; i < 200; i++) {
      forecast -= 0.0004; // the real otlkMag drift rate for a mid-cap
      observeMarket(
        history,
        tick(prices, 0.5, () => true).map((s) => ({ ...s, forecast, volatility: 0.005 })),
      );
    }
    expect(history.cyclesSeen).toBe(0);
  });
});

// --- the solver -------------------------------------------------------------

describe("stepStock", () => {
  test("it produces a plan on the FIRST pass, with no money granted", () => {
    // The deadlock this replaces: the claim was derived from what executed last
    // pass, the execution from the grant, and the grant from the claim. With
    // moneyGranted 0 the old solver could never emit an action, so the claim
    // never existed and no trade was ever placed. A plan must exist regardless.
    const { decision } = run(
      view({ moneyGranted: 0, symbols: [symbol({ forecast: 0.68, volatility: 0.0045 })] }),
      MIN_HOLD_TICKS + 2,
      () => true,
    );
    expect(decision.plan.entry).toBeDefined();
    expect(decision.plan.entry!.sym).toBe("ECP");
    expect(decision.plan.entry!.cost).toBeGreaterThan(0);
    // And nothing is executed until the grant arrives.
    expect(fundedActions(decision.plan, granted(0))).toHaveLength(0);
    expect(fundedActions(decision.plan, granted(decision.plan.entry!.cost)).some((a) => a.type === "buy")).toBe(true);
  });

  test("it refuses to trade a coin flip", () => {
    const { decision } = run(view({ symbols: [symbol({ forecast: 0.5, volatility: 0.0045 })] }), 20, (t) => t % 2 === 0);
    expect(decision.plan.entry).toBeUndefined();
  });

  test("it refuses a horizon too short to clear the round trip", () => {
    // No reason to invest when the payoff cannot arrive before the install.
    const { decision } = run(
      view({ positionHorizonSec: 6, symbols: [symbol({ forecast: 0.9, volatility: 0.0045 })] }),
      5,
      () => true,
    );
    expect(decision.plan.entry).toBeUndefined();
  });

  test("it sells everything and buys nothing when an install is imminent", () => {
    // An install calls initStockMarket, which zeroes every holding and credits
    // no money. There is no reason to hold an asset past it.
    const held = symbol({ shares: 1_000_000, avgPx: 19_000, forecast: 0.9, volatility: 0.0045 });
    const { decision } = run(view({ liquidate: true, symbols: [held] }), MIN_HOLD_TICKS + 2, () => true);
    expect(decision.plan.exits).toHaveLength(1);
    expect(decision.plan.exits[0]).toMatchObject({ type: "sell", sym: "ECP", short: false });
    expect(decision.plan.entry).toBeUndefined();
    // Liquidation raises money, so it is never gated on a grant.
    expect(fundedActions(decision.plan, granted(0))).toHaveLength(1);
  });

  test("`flat` is the install barrier, and it accounts for INTENT not just holdings", () => {
    // What progression gates the irreversible reset on. A raw position snapshot
    // cannot answer it: an exit decided but not yet executed, and an entry wanted
    // on the next pass, are both invisible in one and both mean the book is not
    // flat. So this is published by the feature that knows.
    const held = symbol({ shares: 1_000_000, avgPx: 19_000, forecast: 0.9, volatility: 0.0045 });

    // Holding: not flat.
    const holding = run(view({ symbols: [held] }), MIN_HOLD_TICKS + 2, () => true);
    expect(holding.decision.plan.flat).toBe(false);

    // Liquidating: an exit is outstanding, so still not flat — this is the window
    // that would lose the whole book if the barrier only looked at positions.
    const selling = run(view({ liquidate: true, symbols: [held] }), 2, () => true);
    expect(selling.decision.plan.exits).toHaveLength(1);
    expect(selling.decision.plan.flat).toBe(false);

    // Nothing held and nothing pending: flat.
    const done = run(view({ liquidate: true, symbols: [symbol()] }), 2, () => true);
    expect(done.decision.plan.exits).toHaveLength(0);
    expect(done.decision.plan.flat).toBe(true);

    // Nothing held, but an entry WANTED. Progression arms one pass before it
    // installs, so publishing "flat" here would let the install land on a
    // position opened in between.
    const wanting = run(
      view({ symbols: [symbol({ forecast: 0.68, volatility: 0.0045 })] }),
      MIN_HOLD_TICKS + 2,
      () => true,
    );
    expect(wanting.decision.plan.entry).toBeDefined();
    expect(wanting.decision.plan.flat).toBe(false);
  });

  test("a market that cannot be traded at all reports flat, not unknown", () => {
    // No WSE or no TIX means there is no book for an install to destroy, so
    // blocking the reset on it would stall the run forever.
    expect(run(view({ hasWseAccount: false }), 1, () => true).decision.plan.flat).toBe(true);
    expect(run(view({ hasTixApi: false }), 1, () => true).decision.plan.flat).toBe(true);
  });

  test("a short position is liquidated too", () => {
    const held = symbol({ sharesShort: 500_000, avgPxShort: 20_000, forecast: 0.1, volatility: 0.0045 });
    const { decision } = run(view({ liquidate: true, symbols: [held] }), 2, () => false);
    expect(decision.plan.exits).toEqual([
      expect.objectContaining({ type: "sell", sym: "ECP", short: true }),
    ]);
  });

  test("it never emits a short without SF8.2", () => {
    // The old solver took only the top-|edge| symbol and broke. One bearish
    // symbol therefore blocked every long ranked below it, forever.
    const bearish = symbol({ sym: "NTLK", ask: 3000, bid: 2940, forecast: 0.2, volatility: 0.03 });
    const bullish = symbol({ sym: "ECP", forecast: 0.7, volatility: 0.0045 });
    const { decision } = run(
      view({ canShort: false, symbols: [bearish, bullish] }),
      MIN_HOLD_TICKS + 2,
      (_t, sym) => sym === "ECP",
    );
    expect(decision.plan.entry?.side).not.toBe("short");
    expect(decision.plan.entry?.sym).toBe("ECP");
  });

  test("with SF8.2 it does take the short", () => {
    const bearish = symbol({ sym: "JGN", ask: 900, bid: 880, forecast: 0.15, volatility: 0.03 });
    const { decision } = run(view({ canShort: true, symbols: [bearish] }), MIN_HOLD_TICKS + 2, () => false);
    expect(decision.plan.entry?.side).toBe("short");
  });

  test("hysteresis: a fresh position is not reversed on one bad tick", () => {
    const held = symbol({ shares: 1_000_000, avgPx: 19_000, forecast: 0.3, volatility: 0.0045 });
    const memory = initStockMemory();
    // Commit the intent this tick, then immediately turn the forecast against it.
    memory.intent["ECP"] = { side: "long", sinceTick: 0 };
    const first = stepStock(view({ symbols: [held] }), memory);
    expect(first.plan.exits).toHaveLength(0);
    // Only after MIN_HOLD_TICKS does the exit fire.
    memory.history.tick = MIN_HOLD_TICKS + 1;
    const later = stepStock(view({ symbols: [held] }), memory);
    expect(later.plan.exits).toHaveLength(1);
    expect(later.plan.exits[0]).toMatchObject({ type: "sell", sym: "ECP", short: false });
  });

  test("it publishes manipulation intent for a held symbol, on the right op — FARMABLE hosts only", () => {
    const held = symbol({ shares: 1_000_000, avgPx: 19_000, forecast: 0.7, volatility: 0.0045 });
    const memory = initStockMemory();
    memory.intent["ECP"] = { side: "long", sinceTick: 0 };
    memory.history.tick = 5;
    const { plan } = stepStock(view({ symbols: [held], farmableHosts: ["ecorp"] }), memory);
    const byHost = manipulationByHost(plan.manipulation);
    expect(byHost["ecorp"]).toBeDefined();
    // grow pushes the second-order forecast UP, so a long is driven by grows.
    expect(byHost["ecorp"]!.side).toBe("long");
    expect(byHost["ecorp"]!.valuePerOp).toBeGreaterThan(0);

    // A host the farm cannot work gets NO intent: publishing the metadata host
    // list unfiltered broadcast intents for servers that did not exist in the
    // run's network, and the manipulation profile influenced nobody all run.
    const memory2 = initStockMemory();
    memory2.intent["ECP"] = { side: "long", sinceTick: 0 };
    memory2.history.tick = 5;
    const { plan: unreachable } = stepStock(view({ symbols: [held], farmableHosts: [] }), memory2);
    expect(manipulationByHost(unreachable.manipulation)["ecorp"]).toBeUndefined();
  });

  test("it never manipulates speculatively or against a held position's signal", () => {
    const open = symbol({ forecast: 0.7, volatility: 0.0045 });
    const flat = stepStock(view({ symbols: [open], farmableHosts: ["ecorp"] }), initStockMemory());
    expect(flat.plan.manipulation).toHaveLength(0);

    const held = symbol({ shares: 1_000_000, avgPx: 19_000, forecast: 0.3, volatility: 0.0045 });
    const memory = initStockMemory();
    memory.intent["ECP"] = { side: "long", sinceTick: 0 };
    memory.history.tick = 5;
    const adverse = stepStock(view({ symbols: [held], farmableHosts: ["ecorp"] }), memory);
    expect(adverse.plan.manipulation).toHaveLength(0);
  });

  test("manipulation availability never raises the base entry threshold", () => {
    const candidate = symbol({ sym: "JGN", forecast: 0.595, volatility: 0.03, ask: 1_000, bid: 990 });
    const withoutFarm = run(view({ symbols: [candidate], farmableHosts: [] }), MIN_HOLD_TICKS + 2, () => true);
    const withFarm = run(view({ symbols: [candidate], farmableHosts: ["joesguns"] }), MIN_HOLD_TICKS + 2, () => true);

    expect(withoutFarm.decision.plan.entry).toMatchObject({ sym: "JGN", side: "long" });
    expect(withFarm.decision.plan.entry).toEqual(withoutFarm.decision.plan.entry);
  });

  test("it reports manipulability without changing the economic ranking", () => {
    const unreachable = symbol({ sym: "MGCP", ask: 30_000, bid: 29_940, forecast: 0.70, volatility: 0.0045 });
    const pushable = symbol({ sym: "FNS", ask: 3_000, bid: 2_964, forecast: 0.68, volatility: 0.0075 });
    const withFarm = run(
      view({ symbols: [unreachable, pushable], farmableHosts: ["foodnstuff"] }),
      MIN_HOLD_TICKS + 2,
      () => true,
    );
    expect(withFarm.decision.plan.ranked[0]!.sym).toBe("FNS");
    expect(withFarm.decision.plan.ranked[0]!.manipulable).toBe(true);

    const noFarm = run(view({ symbols: [unreachable, pushable], farmableHosts: [] }), MIN_HOLD_TICKS + 2, () => true);
    expect(noFarm.decision.plan.ranked.map((entry) => entry.sym))
      .toEqual(withFarm.decision.plan.ranked.map((entry) => entry.sym));
    expect(noFarm.decision.plan.ranked.every((entry) => !entry.manipulable)).toBe(true);
  });

  test("it does not give up a large edge for manipulability", () => {
    const strong = symbol({ sym: "MGCP", ask: 30_000, bid: 29_940, forecast: 0.9, volatility: 0.0045 });
    const weak = symbol({ sym: "FNS", ask: 3_000, bid: 2_910, forecast: 0.52, volatility: 0.0075 });
    const { decision } = run(
      view({ symbols: [strong, weak], farmableHosts: ["foodnstuff"] }),
      MIN_HOLD_TICKS + 2,
      () => true,
    );
    expect(decision.plan.ranked[0]!.sym).toBe("MGCP");
  });

  test("a symbol with no server is never given manipulation intent", () => {
    const held = symbol({ sym: "WDS", ask: 6000, bid: 5950, shares: 1_000_000, avgPx: 5500, forecast: 0.7, volatility: 0.025 });
    const memory = initStockMemory();
    memory.intent["WDS"] = { side: "long", sinceTick: 0 };
    memory.history.tick = 5;
    const { plan } = stepStock(view({ symbols: [held] }), memory);
    expect(plan.manipulation).toHaveLength(0);
  });

  test("it offers the best investment at full cash ambition to the arbiter", () => {
    const rich = view({
      totalMoney: 1e12,
      symbols: [symbol({ forecast: 0.7, volatility: 0.0045, maxShares: 1e12 })],
    });
    const { decision } = run(rich, MIN_HOLD_TICKS + 2, () => true);
    const entry = decision.plan.entry!;
    expect(entry.cost).toBeLessThanOrEqual(rich.totalMoney);
    expect(entry.cost).toBeGreaterThan(rich.totalMoney * 0.99);
  });
});

// --- the unlock ladder ------------------------------------------------------

describe("the unlock ladder", () => {
  test("no WSE account is reported as a blocker, and priced as a PAIR with TIX", () => {
    // A WSE account alone buys nothing scriptable: getSymbols needs the TIX API.
    const { decision } = run(view({ hasWseAccount: false, totalMoney: 1e12 }), 1, () => true);
    expect(decision.plan.blocker).toContain("WSE");
    expect(decision.plan.unlock?.action.type).toBe("buyWse");
    expect(decision.plan.unlock?.investmentCost).toBe(5.2e9);
    expect(decision.plan.unlock?.paybackSec).toBe(
      decision.plan.unlock!.investmentCost / decision.plan.unlock!.gainPerSec,
    );
    expect(decision.plan.unlock?.netOverHorizon).toBe(
      decision.plan.unlock!.gainPerSec * 86_400 - decision.plan.unlock!.investmentCost,
    );
  });

  test("the ladder stops when the money would leave nothing to trade with", () => {
    // Spending the bankroll on the unlock makes it worthless the moment it lands.
    const { decision } = run(view({ hasWseAccount: false, totalMoney: 3e9 }), 1, () => true);
    expect(decision.plan.unlock).toBeUndefined();
  });

  test("it buys the $25b 4S API and never the $1b 4S data", () => {
    // getForecast checks has4SDataTixApi, and purchase4SMarketDataTixApi does
    // NOT require has4SData first — so the $1b buys a script exactly nothing.
    // The previous version's only unlock purchase was that one.
    const symbols = STOCK_SYMBOLS.slice(0, 8).map((sym) =>
      symbol({ sym, ask: 20_000, bid: 19_960, maxShares: 1e9 }),
    );
    const { decision } = run(
      view({ has4SApi: false, totalMoney: 1e13, unlockHorizonSec: 86_400, symbols }),
      120,
      (_t, sym) => sym !== "MGCP",
    );
    expect(decision.plan.unlock?.action.type).toBe("buy4SApi");
    const actions = fundedActions(decision.plan, granted(1e12));
    expect(actions.some((a) => a.type === "buy4SApi")).toBe(true);
    expect(actions.some((a) => (a.type as string) === "buy4SData")).toBe(false);
  });

  test("4S is not bought when the node's options forbid it", () => {
    const symbols = STOCK_SYMBOLS.slice(0, 8).map((sym) => symbol({ sym, maxShares: 1e9 }));
    const { decision } = run(
      view({ has4SApi: false, fourSigmaDisabled: true, totalMoney: 1e13, symbols }),
      120,
      () => true,
    );
    expect(decision.plan.unlock).toBeUndefined();
  });

  test("an unlock is amortized over the NODE horizon, not the install horizon", () => {
    // WSE, TIX and 4S all survive prestigeAugmentation and die only with the
    // BitNode. Pricing them against the install cadence (as the shared horizon
    // did) made the highest-leverage purchase in the feature unaffordable at any
    // bankroll below ~$100b — which in BN8 is unreachable without it.
    const shared = { hasTixApi: false, totalMoney: 1e12, positionHorizonSec: 60 };
    const longNode = run(view({ ...shared, unlockHorizonSec: 86_400 }), 1, () => true);
    const shortNode = run(view({ ...shared, unlockHorizonSec: 30 }), 1, () => true);
    expect(longNode.decision.plan.unlock?.action.type).toBe("buyTix");
    expect(shortNode.decision.plan.unlock).toBeUndefined();
  });
});

// --- funding ----------------------------------------------------------------

describe("fundedActions", () => {
  test("a partially funded entry is RE-PRICED, not assumed to scale", () => {
    // Commission is fixed, so a position cut to a fraction pays the same $200k
    // against a fraction of the drift and can flip to a guaranteed loss.
    const { decision } = run(
      view({ totalMoney: 1e11, symbols: [symbol({ forecast: 0.62, volatility: 0.0045, maxShares: 1e9 })] }),
      MIN_HOLD_TICKS + 2,
      () => true,
    );
    const entry = decision.plan.entry!;
    const full = fundedActions(decision.plan, granted(entry.cost));
    expect(full.some((a) => a.type === "buy" && a.shares === entry.shares)).toBe(true);

    // A grant that buys a handful of shares cannot clear the round trip.
    const tiny = fundedActions(decision.plan, granted(COMMISSION + 10 * entry.ask));
    expect(tiny.filter((a) => a.type === "buy")).toHaveLength(0);
  });

  test("exits come first and are never gated on the grant", () => {
    const held = symbol({ shares: 1_000_000, avgPx: 19_000, forecast: 0.9, volatility: 0.0045 });
    const { decision } = run(view({ liquidate: true, symbols: [held] }), 2, () => true);
    const actions = fundedActions(decision.plan, granted(0));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("sell");
  });

  test("the two money claims never cross-subsidise", () => {
    // They are separate claims at different priorities, so they are granted
    // independently. A pass where only the position claim won must not fund the
    // $25b unlock with it — and a pass where only the unlock won must not buy a
    // position with money set aside for the API.
    const symbols = STOCK_SYMBOLS.slice(0, 8).map((sym) => symbol({ sym, maxShares: 1e9 }));
    const { decision } = run(
      view({ has4SApi: false, totalMoney: 1e13, unlockHorizonSec: 86_400, symbols }),
      120,
      (_t, sym) => sym !== "MGCP",
    );
    const plan = decision.plan;
    expect(plan.unlock).toBeDefined();
    expect(plan.entry).toBeDefined();

    const positionOnly = fundedActions(plan, { unlock: 0, position: plan.entry!.cost });
    expect(positionOnly.some((a) => a.type === "buy4SApi")).toBe(false);
    expect(positionOnly.some((a) => a.type === "buy")).toBe(true);

    const unlockOnly = fundedActions(plan, { unlock: plan.unlock!.cost, position: 0 });
    expect(unlockOnly.some((a) => a.type === "buy4SApi")).toBe(true);
    expect(unlockOnly.some((a) => a.type === "buy")).toBe(false);
  });

  test("the unlock is indivisible", () => {
    const { decision } = run(view({ hasTixApi: false, totalMoney: 1e12, unlockHorizonSec: 86_400 }), 1, () => true);
    const unlock = decision.plan.unlock!;
    expect(fundedActions(decision.plan, granted(unlock.cost - 1))).toHaveLength(0);
    expect(fundedActions(decision.plan, granted(unlock.cost))).toHaveLength(1);
  });
});

describe("when to liquidate — the signal, not the solver", () => {
  // THE BUG: `liquidate` was `progression.plan.phase === "ending"`. That phase is an
  // economic test — cash above half of what the run earned, with something queued —
  // not a claim that an install is close. On a real BN1 run with $72t banked and a
  // Daedalus route ~525h out it latched on the first tick and never cleared: 9811
  // progression records, every one "ending", and the market sat flat for the whole
  // run refusing FSIG at a 0.673 forecast with a 3.4-tick break-even. The phase
  // ANNOUNCES that conversion is coming; it is not the moment to convert.
  function ctxWith(plan: unknown) {
    const state = initState();
    state.topics.stock = {
      hasWseAccount: true,
      hasTixApiAccess: true,
      has4SDataApi: false,
      positions: [],
      signals: {},
    } as never;
    state.topics.player = { money: 1e9, skills: { hacking: 1 } } as never;
    if (plan !== undefined) state.topics.progression = { plan } as never;
    else delete state.topics.progression;
    return {
      state,
      caps: unknownCapabilities(),
      board: emptyBoard(),
      grants: noGrants(),
      horizons: {
        node: unknownForecast(0, "test-node", "test fixture"),
        install: unknownForecast(0, "test-install", "test fixture"),
      },
    } as unknown as Parameters<typeof buildView>[0];
  }

  const ending = { phase: "ending", installWanted: true, liquidationWanted: true };

  test("the ENDING PHASE ALONE does not liquidate", () => {
    // The regression, stated directly: factions still has reputation to earn, so
    // there is time to trade however long the phase has been latched.
    const view = buildView(ctxWith({
      ...ending,
      installBlockers: ["factions"],
    }));
    expect(view?.liquidate).toBe(false);
  });

  test("a graft in flight does not liquidate either", () => {
    const view = buildView(ctxWith({
      ...ending,
      installBlockers: ["graft"],
    }));
    expect(view?.liquidate).toBe(false);
  });

  test("the book being the last barrier DOES liquidate", () => {
    const view = buildView(ctxWith({
      ...ending,
      installBlockers: ["stock"],
    }));
    expect(view?.liquidate).toBe(true);
  });

  test("a purchasable augmentation liquidates — that is what the cash is FOR", () => {
    // Gating on this blocker would deadlock the two features: the purchase waits on
    // the proceeds and the proceeds wait on the purchase.
    const view = buildView(ctxWith({
      ...ending,
      installBlockers: [
        "stock",
        "augmentations",
      ],
    }));
    expect(view?.liquidate).toBe(true);
  });

  test("no barriers left at all liquidates", () => {
    expect(buildView(ctxWith({ ...ending, installBlockers: [] }))?.liquidate).toBe(true);
  });

  test("an install not wanted never liquidates", () => {
    const view = buildView(ctxWith({
      phase: "start",
      installWanted: false,
      liquidationWanted: false,
      installBlockers: [],
    }));
    expect(view?.liquidate).toBe(false);
  });

  test("an empty-queue purchase bootstrap liquidates without install intent", () => {
    const view = buildView(ctxWith({
      phase: "start",
      installWanted: false,
      liquidationWanted: true,
      installBlockers: [],
    }));
    expect(view?.liquidate).toBe(true);
  });

  test("unknown means keep trading, and that is the safe direction", () => {
    // `progression` refuses to reset while the book is open, so an install cannot
    // slip past an unliquidated portfolio. Freezing the market on a missing field
    // would cost a whole run; failing to liquidate merely blocks the reset until we
    // are asked properly.
    expect(buildView(ctxWith(undefined))?.liquidate).toBe(false);
    expect(buildView(ctxWith({ ...ending }))?.liquidate).toBe(false);
  });
});
