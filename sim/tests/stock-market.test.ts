import { beforeEach, describe, expect, test } from "bun:test";
import { midpoint, STOCK_METADATA } from "../../shared/features/stocks.ts";
import {
  FORECAST_NUDGE_PER_OP,
  meanLogStep,
  nudgesPerOp,
  roundTripCost,
  TICKS_PER_CYCLE,
} from "../../shared/strategy/stock/market.ts";
import { initHistory, observeMarket, ticksUntilCycle } from "../../shared/strategy/stock/history.ts";
import { mulberry32 } from "../core/rng.ts";
import { StockMarketSystem } from "../features/stock.ts";
import {
  getDarknetVolatilityMult,
  resetDarknetContext,
  setDarknetContext,
  StockMarket,
} from "../vendor/bitburner/src/StockMarket/MarketAdapter.ts";
import {
  promoteStockCharges,
  promoteStockCharismaExp,
  promoteStockWaitMs,
  stockPromotionMult,
} from "../features/dnet.ts";
import { replaceCurrentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { SimWorld } from "../world.ts";
import { DEFAULT_NETWORK } from "../network.ts";

/** Our MODEL of the market, against the market.
 *
 * Everything the strategy believes about price movement is asserted here against
 * the vendored v3.0.1 price engine rather than against another transcription of
 * it. That distinction is the point: `sim/tests/stock-parity.test.ts` checks the
 * constants match, and this checks the CONSEQUENCES the solver draws from them.
 *
 * A tick needs both conditions the game imposes: at least
 * `msPerStockUpdate / MilliPerCycle` = 30 buffered cycles, AND at least
 * `msPerStockUpdateMin` = 4 s of wall clock since the last update. */
const CYCLES_PER_TICK = 30;

function makeWorld(seed = 1): SimWorld {
  return new SimWorld({ seed, network: [] });
}

/** Advance the virtual clock without an engine, by scheduling a no-op at the
 *  target and running to it. */
function advance(world: SimWorld, ms: number): void {
  const target = world.clock.now() + ms;
  world.clock.at(target, () => {});
  world.clock.run(() => false, target);
}

/** One market tick: enough buffered cycles, and enough wall clock. */
function tick(world: SimWorld, market: StockMarketSystem, ms = 6_000): void {
  advance(world, ms);
  market.processPrices(CYCLES_PER_TICK);
}

function makeMarket(seed = 1): { world: SimWorld; market: StockMarketSystem } {
  const world = makeWorld(seed);
  const market = new StockMarketSystem(world, world.player, mulberry32(seed + 7), {
    hasWseAccount: true,
    hasTixApiAccess: true,
    has4SDataTixApi: true,
  });
  world.stockSystem = market;
  return { world, market };
}

beforeEach(() => {
  replaceCurrentNodeMults(getBitNodeMultipliers(1, 1));
  resetDarknetContext();
});

describe("disable4SData", () => {
  test("the BitNodeOption refuses both 4S purchases however much money is present", () => {
    // Upstream: purchase4SMarketData / purchase4SMarketDataTixApi both check
    // `bitNodeOptions.disable4SData` before anything else. The option is what
    // makes the ladder's blind stage a robust capability rung rather than a
    // bankroll accident.
    const world = makeWorld(11);
    const market = new StockMarketSystem(world, world.player, mulberry32(3), {
      hasWseAccount: true,
      hasTixApiAccess: true,
      disable4SData: true,
    });
    world.player.money = 1e12;
    expect(market.purchase4SMarketData()).toBe(false);
    expect(market.purchase4SMarketDataTixApi()).toBe(false);
    expect(market.has4SData).toBe(false);
    expect(market.has4SDataTixApi).toBe(false);
    expect(world.player.money).toBe(1e12);
  });
});

describe("the price tick", () => {
  test("TIX access alone initializes and advances the market, as canAccessStockMarket permits", () => {
    const world = makeWorld(43);
    const market = new StockMarketSystem(world, world.player, mulberry32(12), { hasTixApiAccess: true });
    expect(market.hasWseAccount).toBe(false);
    expect(market.symbols().length).toBeGreaterThan(0);
    const stock = market.stock(market.symbols()[0]!)!;
    const before = stock.price;
    tick(world, market);
    expect(stock.price).not.toBe(before);
  });

  test("real default-network HGW manipulation reaches the matching organization stock", () => {
    const world = new SimWorld({ seed: 41, network: DEFAULT_NETWORK });
    const market = new StockMarketSystem(world, world.player, mulberry32(99), {
      hasWseAccount: true,
      hasTixApiAccess: true,
      has4SDataTixApi: true,
    });
    world.stockSystem = market;
    const server = world.servers.get("foodnstuff")!;
    const stock = market.symbols().map((symbol) => market.stock(symbol)!).find((entry) => entry.name === "FoodNStuff")!;
    expect(server.organizationName).toBe("FoodNStuff");
    server.hasAdminRights = true;
    server.moneyAvailable = server.moneyMax;
    server.hackDifficulty = server.minDifficulty;
    const before = stock.otlkMagForecast;

    world.person.skills.hacking = 1_000_000_000;
    world.land("hack", "foodnstuff", 1_000_000, 1, true);

    expect(stock.otlkMagForecast).toBeLessThan(before);
  });

  test("a tick needs BOTH the buffered cycles and the 4 s floor, and cycles BUFFER", () => {
    const { world, market } = makeMarket();
    const before = market.stock("ECP")!.price;
    // Enough cycles, no clock movement: nothing happens. The cycles are not
    // discarded, though — they accumulate in storedCycles, which is how the game
    // catches up on offline time.
    market.processPrices(CYCLES_PER_TICK);
    expect(market.stock("ECP")!.price).toBe(before);

    // Not enough clock: still nothing, however many cycles have piled up.
    advance(world, 3_000);
    market.processPrices(CYCLES_PER_TICK);
    expect(market.stock("ECP")!.price).toBe(before);

    // Past the 4 s floor, the buffered cycles fire.
    advance(world, 1_500);
    market.processPrices(1);
    expect(market.stock("ECP")!.price).not.toBe(before);
  });

  test("a fresh market with no buffered cycles does not tick on clock alone", () => {
    const { world, market } = makeMarket(3);
    const before = market.stock("ECP")!.price;
    advance(world, 60_000);
    market.processPrices(1);
    expect(market.stock("ECP")!.price).toBe(before);
  });

  test("the mean log step is HALF the reported volatility, as meanLogStep predicts", () => {
    // The single most consequential number in the model: getVolatility() reports
    // the CEILING (mv/100) and the realized magnitude is v * mv/100 with
    // v ~ U(0,1). A solver that sized against the reported figure would double
    // every expected-profit estimate.
    const { world, market } = makeMarket(11);
    const stock = market.stock("ECP")!;
    const volatility = stock.mv / 100;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < 3_000; i++) {
      const before = stock.price;
      tick(world, market);
      const step = Math.abs(Math.log(stock.price / before));
      if (step > 0) {
        sum += step;
        count++;
      }
    }
    expect(count).toBeGreaterThan(2_900);
    const measured = sum / count;
    const predicted = meanLogStep(volatility);
    expect(measured).toBeCloseTo(predicted, 4);
    // And decisively NOT the reported volatility.
    expect(Math.abs(measured - volatility) / volatility).toBeGreaterThan(0.4);
  });

  test("the volatility roll is SHARED across every symbol in a tick", () => {
    // `const v = Math.random()` sits outside the per-symbol loop, so in one tick
    // every symbol's magnitude is the same `v` scaled by its own mv. This is the
    // leak the no-4S volatility measurement inverts.
    const { world, market } = makeMarket(23);
    const symbols = market.symbols();
    const before = new Map(symbols.map((sym) => [sym, market.stock(sym)!.price]));
    tick(world, market);
    const recovered = symbols.map((sym) => {
      const stock = market.stock(sym)!;
      const step = Math.abs(Math.log(stock.price / before.get(sym)!));
      return Math.expm1(step) / (stock.mv / 100);
    });
    const lo = Math.min(...recovered);
    const hi = Math.max(...recovered);
    expect(hi - lo).toBeLessThan(1e-9);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThanOrEqual(1);
  });

  test("history recovers each symbol's true volatility with no 4S call at all", () => {
    const { world, market } = makeMarket(31);
    const history = initHistory();
    const sample = () =>
      market.symbols().map((sym) => {
        const stock = market.stock(sym)!;
        // Ask/bid ONLY: no forecast, no volatility. Exactly what a run without
        // the $25b 4S API can see.
        return { sym, ask: stock.getAskPrice(), bid: stock.getBidPrice() };
      });
    observeMarket(history, sample());
    for (let i = 0; i < 200; i++) {
      tick(world, market);
      observeMarket(history, sample());
    }
    for (const sym of ["ECP", "NTLK", "JGN", "FNS"]) {
      const measured = history.symbols[sym]!.volatility!;
      const truth = market.stock(sym)!.mv / 100;
      expect(Math.abs(measured - truth) / truth, `${sym}`).toBeLessThan(0.02);
    }
  });
});

describe("the 75-tick cycle", () => {
  test("the period is exactly 75 ticks, and our detector finds it", () => {
    // ticksUntilCycle is seeded once at 1..75 and reset to exactly 75 after each
    // cycle, so after ONE observed boundary every future regime change is known.
    const { world, market } = makeMarket(41);
    const history = initHistory();
    const sample = () =>
      market.symbols().map((sym) => {
        const stock = market.stock(sym)!;
        return {
          sym,
          ask: stock.getAskPrice(),
          bid: stock.getBidPrice(),
          forecast: stock.getAbsoluteForecast() / 100,
          volatility: stock.mv / 100,
        };
      });

    observeMarket(history, sample());
    const detected: number[] = [];
    for (let i = 0; i < 400; i++) {
      tick(world, market);
      observeMarket(history, sample());
      if (history.cyclesSeen > detected.length) detected.push(history.tick);
    }
    expect(detected.length).toBeGreaterThanOrEqual(3);
    // Every gap between detected boundaries is the period, exactly.
    for (let i = 1; i < detected.length; i++) {
      expect(detected[i]! - detected[i - 1]!).toBe(TICKS_PER_CYCLE);
    }
    // And the countdown agrees with the engine's own counter.
    expect(ticksUntilCycle(history)).toBe(market.ticksUntilCycle);
  });

  test("a cycle inverts a large minority of symbols at once", () => {
    // ~45% per symbol. Nothing else moves that many forecasts across 0.5 in one
    // tick, which is what makes the detector safe.
    const { world, market } = makeMarket(53);
    const bull = () => new Map(market.symbols().map((sym) => [sym, market.stock(sym)!.b]));
    let flips = 0;
    for (let i = 0; i < 200; i++) {
      const before = bull();
      tick(world, market);
      const after = bull();
      const changed = market.symbols().filter((sym) => before.get(sym) !== after.get(sym)).length;
      if (changed > 5) flips = Math.max(flips, changed);
    }
    expect(flips).toBeGreaterThanOrEqual(6);
    expect(flips).toBeLessThanOrEqual(market.symbols().length);
  });
});

describe("the forecast follows the second-order forecast", () => {
  /** Run `ticks` with `otlkMagForecast` pinned, reporting how often the absolute
   * forecast ROSE and where it ended.
   *
   * Same seed both ways, and pinning changes only which BRANCH each
   * `Math.random()` selects, never how many are drawn — so the two runs see
   * identical random streams and the comparison is a controlled experiment
   * rather than two samples of noise. */
  function push(pinned: number, ticks: number, seed: number): { upFraction: number; final: number; start: number } {
    const { world, market } = makeMarket(seed);
    const stock = market.stock("ECP")!;
    const start = stock.getAbsoluteForecast();
    let ups = 0;
    for (let i = 0; i < ticks; i++) {
      stock.otlkMagForecast = pinned;
      const before = stock.getAbsoluteForecast();
      tick(world, market);
      if (stock.getAbsoluteForecast() > before) ups++;
    }
    return { upFraction: ups / ticks, final: stock.getAbsoluteForecast(), start };
  }

  test("pushing the second-order forecast UP raises the forecast, and DOWN lowers it", () => {
    // The mechanism the entire manipulation model rests on. hack/grow can ONLY
    // move otlkMagForecast; the price responds because getForecastIncreaseChance
    // pulls the forecast toward it. With the gap clamped at +/-45 the per-tick
    // chance saturates near 0.95 and 0.05 respectively — so the DIRECTION is
    // overwhelming even though each step is tiny. If this were backwards the
    // strategy would manipulate every symbol exactly the wrong way.
    const high = push(100, 500, 67);
    const low = push(0, 500, 67);
    expect(high.upFraction).toBeGreaterThan(0.6);
    expect(low.upFraction).toBeLessThan(0.2);
    // The per-tick DIRECTION is what is asserted, not the level reached: a single
    // cycle flip mirrors the absolute forecast across 0.5 outright (69 -> 31), so
    // over 500 ticks the ending level says more about where the last boundary
    // fell than about the push. The level claim is the next test, with cycles off.
  });

  test("with the cycle suppressed, a sustained push drives the forecast to the extreme", () => {
    // Cycles held off, so this measures the convergence alone: given enough
    // uninterrupted ticks, pinning otlkMagForecast at 100 really does walk the
    // forecast to ~1.0. That is the theoretical ceiling of manipulation.
    const { world, market } = makeMarket(79);
    const stock = market.stock("ECP")!;
    for (let i = 0; i < 3_000; i++) {
      stock.otlkMagForecast = 100;
      StockMarket.ticksUntilCycle = 10_000; // suppress the regime change
      tick(world, market);
    }
    expect(stock.getAbsoluteForecast()).toBeGreaterThan(95);
  });

  test("with the cycle running, the push is repeatedly UNDONE — the hold must be bounded", () => {
    // The same 3000 ticks with cycles enabled do NOT reach the extreme: every 75
    // ticks each symbol has a 45% chance of flipping bull/bear, and a flip turns
    // the accumulated otlkMag from an asset into a liability (the same magnitude,
    // now on the wrong side of 50).
    //
    // This is why the solver bounds a position's hold by `ticksUntilCycle` rather
    // than by the horizon alone, and why NUDGE_CONVERGENCE discounts a nudge to
    // half credit instead of pricing it at its theoretical value.
    const withCycles = push(100, 3_000, 79);
    expect(withCycles.final).toBeLessThan(95);
    // Still directionally right within a cycle, though — the up-ticks dominate.
    expect(withCycles.upFraction).toBeGreaterThan(0.5);
  });

  test("the convergence is SLOW, which is why a position must be held", () => {
    // otlkMag drifts by otlkMag * av, a few hundredths of a point per tick, and
    // every 75-tick cycle can flip bull/bear and undo progress. So a nudge pays
    // off over hundreds of ticks, not immediately — exactly what
    // NUDGE_CONVERGENCE discounts for, and why MIN_HOLD_TICKS exists.
    const { world, market } = makeMarket(73);
    const stock = market.stock("ECP")!;
    stock.otlkMagForecast = 100;
    const start = stock.getAbsoluteForecast();
    for (let i = 0; i < 20; i++) {
      stock.otlkMagForecast = 100;
      tick(world, market);
    }
    // Twenty ticks of maximum pressure move the forecast by a couple of points
    // at most. A solver that expected an immediate response would size wildly.
    expect(Math.abs(stock.getAbsoluteForecast() - start)).toBeLessThan(5);
  });
});

describe("hack/grow manipulation", () => {
  const org = STOCK_METADATA["FNS"]!.organization;

  test("grow raises the second-order forecast, hack lowers it, weaken does neither", () => {
    const { world, market } = makeMarket(83);
    const stock = market.stock("FNS")!;
    const server = { organizationName: org, moneyMax: 1e9 };

    stock.otlkMagForecast = 50;
    for (let i = 0; i < 200; i++) market.influenceGrow(server, 1e9);
    expect(stock.otlkMagForecast).toBeGreaterThan(50);

    stock.otlkMagForecast = 50;
    for (let i = 0; i < 200; i++) market.influenceHack(server, 1e9);
    expect(stock.otlkMagForecast).toBeLessThan(50);

    // There is NO weaken-side influence in the game — PlayerInfluencing.ts has
    // exactly three entry points and weaken is not one. The dispatcher must
    // therefore never expect a weaken to move a price.
    stock.otlkMagForecast = 50;
    world.servers.set("foodnstuff", {
      ...world.servers.get("home")!,
      hostname: "foodnstuff",
      organizationName: org,
      moneyMax: 1e9,
      moneyAvailable: 1e9,
      hasAdminRights: true,
      requiredHackingSkill: 1,
      minDifficulty: 1,
      hackDifficulty: 1,
      baseDifficulty: 1,
      serverGrowth: 100,
    });
    for (let i = 0; i < 50; i++) world.land("weaken", "foodnstuff", 1, 1, true);
    expect(stock.otlkMagForecast).toBe(50);
  });

  test("the nudge rate matches nudgesPerOp, and moneyMax cancels out of it", () => {
    // The roll is `random() < moneyMoved / moneyMax`, so the expected nudge per
    // op is `stealFraction * 0.1` — and a poor server manipulates exactly as fast
    // as a rich one at the same fraction. That inverts ordinary target selection:
    // joesguns is as good a manipulator as ecorp and far cheaper to run.
    // Few enough ops that changeForecastForecast's [0,100] clamp is not reached —
    // 50 -> 100 takes 500 successful nudges — and enough that the binomial noise
    // stays under the tolerance. Measuring past saturation would report the clamp
    // rather than the rate, which is exactly the trap a naive measurement falls
    // into: a long manipulation campaign DOES saturate, and its marginal value
    // there is zero (which nudgeValue's headroom term prices in).
    const measure = (moneyMax: number, fraction: number, ops: number, seed: number): number => {
      const { market } = makeMarket(seed);
      const stock = market.stock("FNS")!;
      stock.otlkMagForecast = 50;
      for (let i = 0; i < ops; i++) market.influenceGrow({ organizationName: org, moneyMax }, moneyMax * fraction);
      expect(stock.otlkMagForecast).toBeLessThan(100); // clamp not reached
      return (stock.otlkMagForecast - 50) / ops;
    };
    const predicted = nudgesPerOp(0.5);
    const poor = measure(1e6, 0.5, 800, 101);
    const rich = measure(1e12, 0.5, 800, 101);
    expect(poor).toBeCloseTo(predicted, 2);
    expect(rich).toBeCloseTo(predicted, 2);
    // Identical, not merely similar: moneyMax cancels out of the rate exactly.
    expect(poor).toBe(rich);
    // A full drain rolls at probability 1, so every op lands its nudge — 200 ops
    // rather than 800, because at P=1 the clamp arrives four times sooner.
    expect(measure(1e9, 1, 200, 103)).toBeCloseTo(FORECAST_NUDGE_PER_OP, 9);
  });

  test("BN8 leaves manipulation at full strength while hacking earns nothing", () => {
    // ScriptHackMoneyGain 0 scales only the player's cut; influence rolls against
    // moneyDrained, before it is applied.
    replaceCurrentNodeMults(getBitNodeMultipliers(8, 1));
    const { market } = makeMarket(109);
    const stock = market.stock("FNS")!;
    stock.otlkMagForecast = 50;
    for (let i = 0; i < 500; i++) market.influenceHack({ organizationName: org, moneyMax: 1e9 }, 1e9);
    expect(stock.otlkMagForecast).toBe(0); // clamped at the floor, having moved 50 points
    replaceCurrentNodeMults(getBitNodeMultipliers(1, 1));
  });

  test("influence on a server with no matching symbol is a no-op", () => {
    const { market } = makeMarket(113);
    const before = market.symbols().map((sym) => market.stock(sym)!.otlkMagForecast);
    for (let i = 0; i < 100; i++) {
      market.influenceGrow({ organizationName: "Not A Company", moneyMax: 1e9 }, 1e9);
    }
    expect(market.symbols().map((sym) => market.stock(sym)!.otlkMagForecast)).toEqual(before);
  });
});

describe("the unlock ladder", () => {
  test("buying the WSE account after the TIX API leaves the live market alone", () => {
    // Upstream guards the purchase on isStockMarketInitialized(). Buying TIX
    // first is legal and does initialise the market, so an unguarded re-init on
    // the WSE purchase would re-roll every price and silently destroy the
    // position the player was holding through it.
    const world = makeWorld(42);
    world.player.money = 1e12;
    const market = new StockMarketSystem(world, world.player, mulberry32(43));
    expect(market.purchaseTixApi()).toBe(true);
    expect(market.symbols().length).toBeGreaterThan(0);

    const stock = market.stock("ECP")!;
    market.buyStock("ECP", 1_000);
    const price = stock.price;
    const cap = stock.cap;
    const shares = stock.playerShares;
    expect(shares).toBe(1_000);

    expect(market.purchaseWseAccount()).toBe(true);
    expect(market.stock("ECP")!.price).toBe(price);
    expect(market.stock("ECP")!.cap).toBe(cap);
    expect(market.stock("ECP")!.playerShares).toBe(shares);
  });

  test("a market bought from nothing IS rolled, in either order", () => {
    for (const first of ["wse", "tix"] as const) {
      const world = makeWorld(9);
      world.player.money = 1e12;
      const market = new StockMarketSystem(world, world.player, mulberry32(10));
      expect(market.symbols()).toHaveLength(0);
      if (first === "wse") market.purchaseWseAccount();
      else market.purchaseTixApi();
      expect(market.symbols().length).toBeGreaterThan(0);
      expect(market.stock("ECP")!.price).toBeGreaterThan(0);
    }
  });
});

describe("transactions", () => {
  test("a save seed restores prices, forecasts, positions, and cycle progress", () => {
    const { world, market } = makeMarket(700);
    const stock = market.stock("ECP")!;
    const marketKey = Object.entries(StockMarket).find(([, value]) => value === stock)?.[0]!;
    const restored = new StockMarketSystem(world, world.player, mulberry32(701), {
      hasWseAccount: true,
      hasTixApiAccess: true,
      seed: {
        stocks: {
          [marketKey]: {
            symbol: "ECP", price: 12_345, lastPrice: 12_000, b: false,
            otlkMag: 31, otlkMagForecast: 27, playerShares: 77,
            playerAvgPx: 11_111, playerShortShares: 4, playerAvgShortPx: 13_000,
          },
        },
        storedCycles: 19,
        ticksUntilCycle: 7,
        hasOrders: false,
      },
    });
    expect(restored.stock("ECP")).toMatchObject({
      price: 12_345, lastPrice: 12_000, b: false, otlkMag: 31,
      otlkMagForecast: 27, playerShares: 77, playerAvgPx: 11_111,
      playerShortShares: 4, playerAvgShortPx: 13_000,
    });
    expect(StockMarket.storedCycles).toBe(19);
    expect(StockMarket.ticksUntilCycle).toBe(7);
  });

  test("an immediate round trip loses exactly roundTripCost", () => {
    // The cost the previous solver could not see at all: both commissions PLUS
    // the spread, crossed on both legs. On a position worth opening the spread
    // is the larger half by an order of magnitude or two.
    const world = makeWorld(127);
    const market = new StockMarketSystem(world, world.player, mulberry32(200), {
      hasWseAccount: true,
      hasTixApiAccess: true,
    });
    const startMoney = 1e12;
    world.player.money = startMoney;
    const stock = market.stock("ECP")!;
    const ask = stock.getAskPrice();
    const bid = stock.getBidPrice();
    expect(ask).toBeGreaterThan(bid);

    const shares = 10_000;
    market.buyStock("ECP", shares);
    market.sellStock("ECP", shares);

    const lost = startMoney - world.player.money;
    expect(lost).toBeCloseTo(roundTripCost(shares, ask, bid), 4);
    expect(lost).toBeGreaterThan(2 * 100_000);
  });

  test("a maxShares trade drags its own forecast toward neutral", () => {
    // processTransactionForecastMovement: 0.006 of otlkMag per
    // shareTxForMovement shares, floored at otlkMag 5.
    const w = makeWorld(131);
    const m = new StockMarketSystem(w, w.player, mulberry32(300), {
      hasWseAccount: true,
      hasTixApiAccess: true,
    });
    w.player.money = 1e15;
    const stock = m.stock("ECP")!;
    stock.otlkMag = 19;
    const before = stock.otlkMag;
    m.buyStock("ECP", stock.maxShares);
    const movements = stock.maxShares / stock.shareTxForMovement;
    const actual = before - stock.otlkMag;
    expect(actual).toBeGreaterThan(0);
    // `numIterations` is a ceil over the remaining shares after the current
    // headroom, so the exact count differs from shares/shareTxForMovement by less
    // than one movement. A relative check is the honest one.
    expect(Math.abs(actual - 0.006 * movements) / actual).toBeLessThan(0.01);

    // And our model's estimate — which cannot see the ROLLED shareTxForMovement,
    // only its range — lands within the range's own width. That is the accuracy
    // ceiling for anything sized before 4S, and it is why selfInfluenceCost is
    // used as a haircut rather than a precise correction.
    const range = STOCK_METADATA["ECP"]!.shareTxForMovement;
    const modelled = 0.006 * (stock.maxShares / midpoint(range));
    const best = 0.006 * (stock.maxShares / range[1]);
    const worst = 0.006 * (stock.maxShares / range[0]);
    expect(modelled).toBeGreaterThan(0);
    expect(actual).toBeGreaterThanOrEqual(best * 0.99);
    expect(actual).toBeLessThanOrEqual(worst * 1.01);
  });

  test("an augmentation install DESTROYS the portfolio — no money, no shares", () => {
    // prestigeAugmentation -> initStockMarket replaces every Stock object. This
    // is the fact the whole liquidation rule exists for.
    const w = makeWorld(137);
    const m = new StockMarketSystem(w, w.player, mulberry32(400), {
      hasWseAccount: true,
      hasTixApiAccess: true,
    });
    w.player.money = 1e15;
    m.buyStock("ECP", 100_000);
    expect(m.portfolioValue()).toBeGreaterThan(0);
    const moneyBefore = w.player.money;

    m.prestige();

    expect(m.portfolioValue()).toBe(0);
    expect(m.stock("ECP")!.playerShares).toBe(0);
    // And nothing was credited for it.
    expect(w.player.money).toBe(moneyBefore);
  });

  test("the unlock flags survive a prestige; only a BitNode reset clears them", () => {
    const w = makeWorld(139);
    const m = new StockMarketSystem(w, w.player, mulberry32(500), {
      hasWseAccount: true,
      hasTixApiAccess: true,
      has4SDataTixApi: true,
    });
    m.prestige();
    expect(m.hasWseAccount).toBe(true);
    expect(m.hasTixApiAccess).toBe(true);
    expect(m.has4SDataTixApi).toBe(true);
  });

  test("the 4S TIX API can be bought WITHOUT the $1b ticker data", () => {
    // Which makes the $1b purchase worthless to a script, and is why the solver
    // never emits it.
    const w = makeWorld(149);
    const m = new StockMarketSystem(w, w.player, mulberry32(600), {
      hasWseAccount: true,
      hasTixApiAccess: true,
    });
    w.player.money = 1e12;
    expect(m.has4SData).toBe(false);
    expect(m.purchase4SMarketDataTixApi()).toBe(true);
    expect(m.has4SDataTixApi).toBe(true);
    expect(m.has4SData).toBe(false);
  });
});

/** THE DARKNET'S PROPAGANDA.
 *
 * `ns.dnet.promoteStock` is the one mechanic outside the market that changes how
 * the market MOVES, rather than what we know about it. It raises a symbol's
 * volatility and nothing else: no forecast change, no income. These tests face
 * the transcribed curve against the vendored price engine that consumes it, and
 * pin the arithmetic against upstream's literal expression.
 *
 * The upstream source is `src/DarkNet/effects/effects.ts` and
 * `src/NetscriptFunctions/Darknet.ts`; `DarkNet/` cannot be vendored, so
 * `sim/tests/drift-pins.test.ts` pins both files by hash and this pins what we
 * read out of them. */
describe("darknet stock propaganda", () => {
  /** Upstream's expression, written out again rather than imported, so a change
   *  to ours has to be made twice to pass. */
  function upstreamMult(charges: number): number {
    const growthRate = 0.001;
    return 1 + (1 - Math.exp(-growthRate * charges) + 2 * (1 - Math.exp(-growthRate * 0.15 * charges)));
  }

  test("the charge curve matches upstream and saturates at 4x", () => {
    for (const charges of [0, 1, 10, 250, 1_000, 10_000, 250_000]) {
      expect(stockPromotionMult(charges)).toBeCloseTo(upstreamMult(charges), 12);
    }
    expect(stockPromotionMult(0)).toBe(1);
    // Two saturating exponentials, weighted 1 and 2: the ceiling is 1 + 1 + 2,
    // approached from below and reached only once the exponentials underflow.
    expect(stockPromotionMult(20_000)).toBeLessThan(4);
    expect(stockPromotionMult(1e9)).toBe(4);
    // Monotonic, so more propaganda is never worth less.
    let previous = 0;
    for (const charges of [0, 1, 100, 1_000, 50_000]) {
      const mult = stockPromotionMult(charges);
      expect(mult).toBeGreaterThan(previous);
      previous = mult;
    }
  });

  test("the wait, the charges and the charisma XP match upstream", () => {
    // waitTime = max(8000 * (600 / (600 + cha)), 200)
    expect(promoteStockWaitMs(0)).toBe(8_000);
    expect(promoteStockWaitMs(600)).toBe(4_000);
    // Charisma can only ever buy it down to the 200 ms floor.
    expect(promoteStockWaitMs(1e9)).toBe(200);
    expect(promoteStockWaitMs(24_000)).toBe(200);

    // promotionAmount = threads * ((500 + cha) / 500)
    expect(promoteStockCharges(1, 0)).toBe(1);
    expect(promoteStockCharges(10, 500)).toBe(20);
    // chaXp = charisma_exp * threads * 10 * ((200 + cha) / 200)
    expect(promoteStockCharismaExp(1, 0, 1)).toBe(10);
    expect(promoteStockCharismaExp(4, 200, 2)).toBe(160);
  });

  test("a promoted symbol moves further per tick, and the price engine sees it", () => {
    const { world, market } = makeMarket(11);
    const promotions = new Map<string, number>();
    setDarknetContext({
      volatilityMult: (symbol) => stockPromotionMult(promotions.get(symbol) ?? 0),
      scaleIncreases: (scalar) => {
        for (const [symbol, charges] of promotions) promotions.set(symbol, charges * scalar);
      },
    });
    try {
      const stock = market.stock("ECP")!;
      // `mv` is immutable — the boost is applied at the tick, not to the stock.
      const baseMv = stock.mv;
      promotions.set("ECP", 5_000);
      expect(stock.mv).toBe(baseMv);

      // The engine's own step is `stock.mv * getDarknetVolatilityMult(symbol)`.
      // Compare the realised log-step against an unpromoted control on the SAME
      // shared roll: `v` is drawn once per tick for every symbol, so the ratio
      // of the two symbols' steps isolates the boost exactly.
      const control = market.stock("MGCP")!;
      const boosted: number[] = [];
      const plain: number[] = [];
      for (let i = 0; i < 40; i++) {
        const beforeStock = stock.price;
        const beforeControl = control.price;
        tick(world, market);
        boosted.push(Math.abs(Math.log(stock.price / beforeStock)));
        plain.push(Math.abs(Math.log(control.price / beforeControl)));
      }
      const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
      const expected = (baseMv * stockPromotionMult(5_000)) / control.mv;
      expect(mean(boosted) / mean(plain)).toBeCloseTo(expected, 1);
    } finally {
      resetDarknetContext();
    }
  });

  test("charges decay 0.4x per market CYCLE, not per tick", () => {
    const { world, market } = makeMarket(5);
    const promotions = new Map<string, number>([["ECP", 1_000]]);
    let scaleCalls = 0;
    setDarknetContext({
      volatilityMult: (symbol) => stockPromotionMult(promotions.get(symbol) ?? 0),
      scaleIncreases: (scalar) => {
        scaleCalls++;
        for (const [symbol, charges] of promotions) {
          if (charges > 0) promotions.set(symbol, charges * scalar);
        }
      },
    });
    try {
      // Ticks alone must not decay anything: only stockMarketCycle scales.
      const untilCycle = market.ticksUntilCycle;
      for (let i = 0; i < untilCycle - 1; i++) tick(world, market);
      expect(scaleCalls).toBe(0);
      expect(promotions.get("ECP")).toBe(1_000);

      tick(world, market);
      expect(scaleCalls).toBe(1);
      expect(promotions.get("ECP")).toBeCloseTo(400, 9);

      for (let i = 0; i < TICKS_PER_CYCLE; i++) tick(world, market);
      expect(scaleCalls).toBe(2);
      expect(promotions.get("ECP")).toBeCloseTo(160, 9);
    } finally {
      resetDarknetContext();
    }
  });

  test("a market built without dnet is neutral, whatever the last run installed", () => {
    // The hooks are module-global. A StockMarketSystem constructed with no
    // darknet must not inherit the previous world's promotions.
    setDarknetContext({ volatilityMult: () => 3.5, scaleIncreases: () => {} });
    const { market } = makeMarket(3);
    expect(getDarknetVolatilityMult(market.stock("ECP")!.symbol)).toBe(1);
  });
});
