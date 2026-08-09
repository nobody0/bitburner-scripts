import { beforeEach, describe, expect, test } from "bun:test";
import { STOCK_METADATA } from "../../shared/features/stocks.ts";
import {
  fundedActions,
  initStockMemory,
  manipulationByHost,
  MAX_PORTFOLIO_FRACTION,
  MAX_SYMBOL_FRACTION,
  stepStock,
  type StockAction,
  type StockMemory,
  type StockSymbolView,
  type StockView,
} from "../../shared/strategy/stock/decide.ts";
import { stepProgression } from "../../shared/strategy/progression/decide.ts";
import { mulberry32 } from "../core/rng.ts";
import { StockMarketSystem } from "../features/stock.ts";
import { replaceCurrentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { SimWorld } from "../world.ts";

/** The solver against the real market.
 *
 * `sim/tests/stock-parity.test.ts` checks that the transcription matches the
 * source; `stock-market.test.ts` checks that the model's claims about the
 * mechanics hold. This one asks the only question that finally matters: does the
 * strategy make money, and does it beat the alternatives?
 *
 * The baselines are deliberately the ones this replaces. `naive` is the rule the
 * predecessor scripts used (`bitburner-2023/src/main.ts:761`) and the shape the
 * previous solver had: buy anything forecast above a threshold, sell when it
 * turns, with no model of the spread, the commission, or the regime cycle.
 * `hold` is buy-and-hold, which is what "the market goes up on average" would
 * predict. */

const CYCLES_PER_TICK = 30;

/** Every host any symbol owns — the stand-in farm has no skill or rooting limit. */
const FARMABLE_HOSTS: readonly string[] = Object.values(STOCK_METADATA).flatMap((meta) => meta.hosts);

type Strategy = "solver" | "naive" | "hold" | "cash";

interface RunResult {
  /** Cash plus mark-to-market, which is the only figure that matters at the end
   *  of a run — an unsold position is worth nothing once an install lands. */
  net: number;
  cash: number;
  portfolio: number;
  trades: number;
  commission: number;
}

interface RunOptions {
  seed: number;
  ticks: number;
  money: number;
  strategy: Strategy;
  has4S?: boolean;
  /** Influencing ops per tick per intent host — a stand-in for the HWGW farm. */
  manipulationOps?: number;
  /** Tick at which progression enters its `ending` phase. */
  liquidateAt?: number;
  /** Fire a prestige at the end, to measure what survives an install. */
  prestige?: boolean;
}

function advance(world: SimWorld, ms: number): void {
  const target = world.clock.now() + ms;
  world.clock.at(target, () => {});
  world.clock.run(() => false, target);
}

function symbolViews(market: StockMarketSystem, has4S: boolean): StockSymbolView[] {
  return market.symbols().map((sym) => {
    const stock = market.stock(sym)!;
    return {
      sym,
      ask: stock.getAskPrice(),
      bid: stock.getBidPrice(),
      maxShares: stock.maxShares,
      shares: stock.playerShares,
      avgPx: stock.playerAvgPx,
      sharesShort: stock.playerShortShares,
      avgPxShort: stock.playerAvgShortPx,
      // Exactly the gate the game applies: getForecast/getVolatility read
      // has4SDataTixApi and nothing else.
      ...(has4S ? { forecast: stock.getAbsoluteForecast() / 100, volatility: stock.mv / 100 } : {}),
    };
  });
}

function apply(market: StockMarketSystem, actions: readonly StockAction[]): void {
  for (const action of actions) {
    switch (action.type) {
      case "buy":
        if (action.short) market.buyShort(action.sym, action.shares);
        else market.buyStock(action.sym, action.shares);
        break;
      case "sell":
        if (action.short) market.sellShort(action.sym, action.shares);
        else market.sellStock(action.sym, action.shares);
        break;
      case "buyWse":
        market.purchaseWseAccount();
        break;
      case "buyTix":
        market.purchaseTixApi();
        break;
      case "buy4SApi":
        market.purchase4SMarketDataTixApi();
        break;
    }
  }
}

/** The predecessor's rule, and the previous solver's shape: rank by forecast, buy
 * the best above 0.6, exit below 0.5. Blind to the spread, to the commission, and
 * to the regime cycle.
 *
 * Given the SAME capital policy as the solver, deliberately. Without that the
 * comparison measures exposure rather than judgement: an uncapped naive book ends
 * ~98% invested against the solver's 60%, and in a market with positive drift the
 * more-invested book wins on raw wealth whatever it holds. The 40% held back is
 * the augmentation fund — a policy choice about what money is FOR, not a
 * limitation of the decision rule — so it is held constant across both arms and
 * the difference that remains is strategy. */
function naiveStep(market: StockMarketSystem, cash: number, portfolioCap: number): void {
  const ranked = market
    .symbols()
    .map((sym) => ({ sym, stock: market.stock(sym)! }))
    .sort((a, b) => b.stock.getAbsoluteForecast() - a.stock.getAbsoluteForecast());
  for (const { sym, stock } of ranked) {
    const forecast = stock.getAbsoluteForecast() / 100;
    if (stock.playerShares > 0 && forecast < 0.5) market.sellStock(sym, stock.playerShares);
  }
  const room = portfolioCap - market.portfolioValue();
  if (room <= 0) return;
  for (const { sym, stock } of ranked) {
    if (stock.playerShares > 0) continue;
    if (stock.getAbsoluteForecast() / 100 <= 0.6) continue;
    const budget = Math.min(room, cash, portfolioCap * (MAX_SYMBOL_FRACTION / MAX_PORTFOLIO_FRACTION));
    const shares = Math.min(stock.maxShares, Math.floor(budget / stock.getAskPrice()));
    if (shares > 0) market.buyStock(sym, shares);
    break;
  }
}

function tradeRun(options: RunOptions): RunResult {
  const { seed, ticks, money, strategy } = options;
  const has4S = options.has4S ?? true;
  const world = new SimWorld({ seed, network: [] });
  const market = new StockMarketSystem(world, world.player, mulberry32(seed + 7), {
    hasWseAccount: true,
    hasTixApiAccess: true,
    has4SDataTixApi: has4S,
  });
  world.stockSystem = market;
  world.player.money = money;

  const memory: StockMemory = initStockMemory();
  let held = false;

  for (let tick = 0; tick < ticks; tick++) {
    advance(world, 6_000);
    market.processPrices(CYCLES_PER_TICK);
    const liquidate = options.liquidateAt !== undefined && tick >= options.liquidateAt;

    if (strategy === "solver") {
      const remainingTicks = Math.max(0, (options.liquidateAt ?? ticks) - tick);
      const view: StockView = {
        symbols: symbolViews(market, has4S),
        hasWseAccount: true,
        hasTixApi: true,
        has4SApi: has4S,
        canShort: false,
        fourSigmaDisabled: false,
        // The stand-in farm can drive every symbol that has a host, so the
        // manipulation preference is exercised rather than bypassed.
        farmableHosts: options.manipulationOps ? FARMABLE_HOSTS : [],
        moneyGranted: world.player.money,
        totalMoney: world.player.money,
        portfolioValue: market.portfolioValue(),
        positionHorizonSec: remainingTicks * 6,
        unlockHorizonSec: remainingTicks * 6,
        liquidate,
      };
      const decision = stepStock(view, memory);
      // Both claims funded: the arbiter is not in this harness, and the point here is
      // the market's response to the solver, not the allocation between its claims.
      apply(market, fundedActions(decision.plan, { unlock: world.player.money, position: world.player.money }));

      // Stand in for the HWGW farm: every host the plan wants manipulated gets
      // `manipulationOps` influencing grows this tick. A long is driven by GROW,
      // which is the direction the dispatcher flags.
      if (options.manipulationOps) {
        for (const intent of Object.values(manipulationByHost(decision.plan.manipulation))) {
          if (intent.side !== "long") continue;
          const meta = STOCK_METADATA[intent.sym]!;
          for (let op = 0; op < options.manipulationOps; op++) {
            // Half the server's max money per op — a typical HWGW steal fraction.
            market.influenceGrow({ organizationName: meta.organization, moneyMax: 1e9 }, 0.5e9);
          }
        }
      }
    } else if (strategy === "naive" && !liquidate) {
      const bankroll = world.player.money + market.portfolioValue();
      naiveStep(market, world.player.money, bankroll * MAX_PORTFOLIO_FRACTION);
    } else if (strategy === "naive" && liquidate) {
      for (const sym of market.symbols()) {
        const stock = market.stock(sym)!;
        if (stock.playerShares > 0) market.sellStock(sym, stock.playerShares);
      }
    } else if (strategy === "hold" && !held) {
      // Buy-and-hold the largest cap and never touch it again.
      const shares = Math.floor((money * 0.5) / market.stock("ECP")!.getAskPrice());
      if (shares > 0) market.buyStock("ECP", shares);
      held = true;
    }
  }

  if (options.prestige) market.prestige();
  const portfolio = market.portfolioValue();
  return {
    net: world.player.money + portfolio,
    cash: world.player.money,
    portfolio,
    trades: market.tradesMade,
    commission: market.commissionPaid,
  };
}

/** Median across seeds — one seed of a stochastic market is an anecdote. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7];
const START = 1e10;

beforeEach(() => {
  replaceCurrentNodeMults(getBitNodeMultipliers(1, 1));
});

describe("the solver against the real market", () => {
  test("with 4S it makes money, and beats buy-and-hold", () => {
    const solver = median(SEEDS.map((seed) => tradeRun({ seed, ticks: 400, money: START, strategy: "solver" }).net));
    const hold = median(SEEDS.map((seed) => tradeRun({ seed, ticks: 400, money: START, strategy: "hold" }).net));
    const cash = median(SEEDS.map((seed) => tradeRun({ seed, ticks: 400, money: START, strategy: "cash" }).net));
    expect(cash).toBe(START); // sanity: doing nothing changes nothing
    expect(solver).toBeGreaterThan(START);
    expect(solver).toBeGreaterThan(hold);
  });

  test("it beats the naive forecast>0.6 rule, and churns far less", () => {
    // The rule the predecessor used and the previous solver's shape. It is not
    // stupid — a 0.6 forecast IS an edge — it just pays the spread and the
    // commission often enough to give the edge back.
    const solver = SEEDS.map((seed) => tradeRun({ seed, ticks: 400, money: START, strategy: "solver" }));
    const naive = SEEDS.map((seed) => tradeRun({ seed, ticks: 400, money: START, strategy: "naive" }));
    expect(median(solver.map((r) => r.net))).toBeGreaterThan(median(naive.map((r) => r.net)));
    expect(median(solver.map((r) => r.commission))).toBeLessThan(median(naive.map((r) => r.commission)));
  });

  test("without 4S it still makes money from price history alone", () => {
    // No forecast and no volatility from the API: everything comes from the
    // up-tick frequency and the shared per-tick roll. Slower to start (the
    // estimator has to accumulate evidence before it will trade at all), so this
    // gets a longer run.
    const solver = median(
      SEEDS.map((seed) => tradeRun({ seed, ticks: 900, money: START, strategy: "solver", has4S: false }).net),
    );
    expect(solver).toBeGreaterThan(START);
  });

  test("4S is worth more than no 4S over the same market", () => {
    const withApi = median(SEEDS.map((seed) => tradeRun({ seed, ticks: 900, money: START, strategy: "solver" }).net));
    const without = median(
      SEEDS.map((seed) => tradeRun({ seed, ticks: 900, money: START, strategy: "solver", has4S: false }).net),
    );
    expect(withApi).toBeGreaterThan(without);
  });

  test("it holds the portfolio cap, leaving the rest liquid for augmentations", () => {
    // The cap is the feature, not a shortfall. It is also why the naive baseline
    // above is given the same policy: measured on raw wealth, an uncapped book at
    // ~98% exposure beats a capped one at 60% in a market with positive drift
    // whatever either of them holds, so an unmatched comparison would be
    // measuring the capital policy and calling it strategy.
    for (const seed of SEEDS) {
      const result = tradeRun({ seed, ticks: 400, money: START, strategy: "solver" });
      const exposure = result.portfolio / result.net;
      // The cap binds at ENTRY. A winner then appreciates past it, and the right
      // response is to leave it alone: force-selling to rebalance would pay a
      // round trip to reduce a position the forecast still favours. So the
      // tolerance is real drift, not slack in the check.
      expect(exposure, `seed ${seed}`).toBeLessThanOrEqual(MAX_PORTFOLIO_FRACTION * 1.25);
      // And it does deploy: a cap nobody reaches would be a different bug.
      expect(exposure, `seed ${seed}`).toBeGreaterThan(0.2);
    }
  });

  test("it refuses to trade at all on a horizon too short to clear a round trip", () => {
    // Two ticks cannot recover the spread on anything, at any size.
    const result = tradeRun({ seed: 1, ticks: 2, money: START, strategy: "solver" });
    expect(result.trades).toBe(0);
    expect(result.net).toBe(START);
  });

  test("a short-but-viable horizon IS traded, and the naive rule loses money on it", () => {
    // The rule is not "short horizon means no trade" — it is "the hold must clear
    // the round trip". Twelve ticks is enough for a large position on a tight
    // spread, and the solver takes it; the naive rule, which cannot tell, churns.
    const solver = median(SEEDS.map((seed) => tradeRun({ seed, ticks: 12, money: START, strategy: "solver" }).net));
    const naive = median(SEEDS.map((seed) => tradeRun({ seed, ticks: 12, money: START, strategy: "naive" }).net));
    expect(solver).toBeGreaterThan(naive);
  });
});

describe("liquidation before an install", () => {
  test("the solver ends FLAT, so nothing is destroyed by the prestige", () => {
    // prestigeAugmentation -> initStockMarket zeroes every holding and credits no
    // money. A run that ends holding stock loses that value outright, which is
    // what makes this the single most valuable rule in the feature.
    for (const seed of SEEDS) {
      const result = tradeRun({
        seed,
        ticks: 400,
        money: START,
        strategy: "solver",
        liquidateAt: 340,
        prestige: true,
      });
      expect(result.portfolio, `seed ${seed} held stock through the install`).toBe(0);
      expect(result.cash).toBeGreaterThan(0);
    }
  });

  test("holding through an install destroys the position — the baseline that proves the point", () => {
    // Same market, same trades, no liquidation phase.
    const kept = tradeRun({ seed: 1, ticks: 400, money: START, strategy: "hold", prestige: false });
    const lost = tradeRun({ seed: 1, ticks: 400, money: START, strategy: "hold", prestige: true });
    expect(kept.portfolio).toBeGreaterThan(0);
    expect(lost.portfolio).toBe(0);
    expect(lost.net).toBeLessThan(kept.net);
    // And nothing was credited for it: the cash is identical either way.
    expect(lost.cash).toBe(kept.cash);
  });

  test("a solver that liquidates beats one that does not, once the install lands", () => {
    const liquidating = median(
      SEEDS.map(
        (seed) => tradeRun({ seed, ticks: 400, money: START, strategy: "solver", liquidateAt: 340, prestige: true }).net,
      ),
    );
    const holding = median(
      SEEDS.map((seed) => tradeRun({ seed, ticks: 400, money: START, strategy: "solver", prestige: true }).net),
    );
    expect(liquidating).toBeGreaterThan(holding);
  });
});

describe("the install barrier", () => {
  /** Drive the solver against the real market, then run progression's barrier
   *  over the plan it published — the same conjunction the controller uses. */
  function barrier(options: RunOptions): { flat: boolean; blockers: string[]; portfolio: number } {
    const world = new SimWorld({ seed: options.seed, network: [] });
    const market = new StockMarketSystem(world, world.player, mulberry32(options.seed + 7), {
      hasWseAccount: true,
      hasTixApiAccess: true,
      has4SDataTixApi: true,
    });
    world.stockSystem = market;
    world.player.money = options.money;
    const memory = initStockMemory();
    let plan = stepStock(
      { ...baseView(market, world, options, 0, false), symbols: symbolViews(market, true) },
      memory,
    ).plan;

    for (let tick = 0; tick < options.ticks; tick++) {
      advance(world, 6_000);
      market.processPrices(CYCLES_PER_TICK);
      const liquidate = options.liquidateAt !== undefined && tick >= options.liquidateAt;
      plan = stepStock(baseView(market, world, options, tick, liquidate), memory).plan;
      apply(market, fundedActions(plan, { unlock: world.player.money, position: world.player.money }));
    }

    // progression's own decision, fed the market's published answer.
    const decision = stepProgression({
      queued: ["Some Augmentation"],
      affordableValueProduct: 3,
      factionWorkInProgress: false,
      factionsReadyToInstall: true,
      stockReadyToInstall: plan.flat,
      graftInProgress: false,
      money: world.player.money,
      earnedThisRun: 100,
      factions: {},
      favorToDonate: 150,
      homeRam: 8,
      homeRamUpgradeCost: Infinity,
      runSec: 10_000,
    });
    return {
      flat: plan.flat,
      blockers: decision.installBlockers.map((blocker) => blocker.kind),
      portfolio: market.portfolioValue(),
    };
  }

  function baseView(
    market: StockMarketSystem,
    world: SimWorld,
    options: RunOptions,
    tick: number,
    liquidate: boolean,
  ): StockView {
    const remaining = Math.max(0, (options.liquidateAt ?? options.ticks) - tick);
    return {
      symbols: symbolViews(market, true),
      hasWseAccount: true,
      hasTixApi: true,
      has4SApi: true,
      canShort: false,
      fourSigmaDisabled: false,
      farmableHosts: [],
      moneyGranted: world.player.money,
      totalMoney: world.player.money,
      portfolioValue: market.portfolioValue(),
      positionHorizonSec: remaining * 6,
      unlockHorizonSec: remaining * 6,
      liquidate,
    };
  }

  test("while holding, the barrier blocks the reset", () => {
    const held = barrier({ seed: 1, ticks: 200, money: START, strategy: "solver" });
    expect(held.portfolio).toBeGreaterThan(0);
    expect(held.flat).toBe(false);
    expect(held.blockers).toEqual(["stock"]);
  });

  test("once liquidated the barrier clears, with nothing left to destroy", () => {
    // The whole point: by the time progression is allowed to reset, the book is
    // already cash. Same market, same trades, a liquidation phase at the end.
    for (const seed of SEEDS) {
      const done = barrier({ seed, ticks: 200, money: START, strategy: "solver", liquidateAt: 150 });
      expect(done.portfolio, `seed ${seed}`).toBe(0);
      expect(done.flat, `seed ${seed}`).toBe(true);
      expect(done.blockers, `seed ${seed}`).toEqual([]);
    }
  });
});

describe("manipulation", () => {
  test("driving the farm at the position pays more than trading alone", () => {
    // The hacking tie-in, end to end: the solver publishes a long intent, the
    // (stand-in) farm grows that organization's server with `stock: true`, the
    // second-order forecast rises, the forecast follows it, and the position
    // gains. Same seeds and the same market both ways — the ONLY difference is
    // whether the influencing ops land.
    const withFarm = median(
      SEEDS.map((seed) => tradeRun({ seed, ticks: 500, money: START, strategy: "solver", manipulationOps: 40 }).net),
    );
    const without = median(
      SEEDS.map((seed) => tradeRun({ seed, ticks: 500, money: START, strategy: "solver" }).net),
    );
    expect(withFarm).toBeGreaterThan(without);
  });

  test("more influencing ops per tick is worth more, up to saturation", () => {
    const light = median(
      SEEDS.map((seed) => tradeRun({ seed, ticks: 500, money: START, strategy: "solver", manipulationOps: 5 }).net),
    );
    const heavy = median(
      SEEDS.map((seed) => tradeRun({ seed, ticks: 500, money: START, strategy: "solver", manipulationOps: 60 }).net),
    );
    expect(heavy).toBeGreaterThan(light);
  });
});
