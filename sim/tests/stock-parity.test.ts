import { describe, expect, test } from "bun:test";
import { midpoint, STOCK_METADATA, STOCK_SYMBOLS } from "../../shared/features/stocks.ts";
import {
  COMMISSION,
  CYCLE_FLIP_CHANCE,
  FORECAST_CHANGE_PER_MOVEMENT,
  FORECAST_GAP_CLAMP,
  FORECAST_INFLUENCE_LIMIT,
  FORECAST_NUDGE_PER_OP,
  FOUR_SIGMA_API_COST,
  FOUR_SIGMA_DATA_COST,
  MS_PER_TICK,
  MS_PER_TICK_MIN,
  SHARE_TX_RECOVERY_PER_TICK,
  TICKS_PER_CYCLE,
  TIX_API_COST,
  unlockCosts,
  WSE_ACCOUNT_COST,
} from "../../shared/strategy/stock/market.ts";
import { replaceCurrentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { SERVER_METADATA } from "../vendor/bitburner/src/Server/data/ServerMetadata.ts";
import { StockSymbol } from "../vendor/bitburner/src/StockMarket/Enums.ts";
import { StockMarketConstants } from "../vendor/bitburner/src/StockMarket/data/Constants.ts";
import { InitStockMetadata } from "../vendor/bitburner/src/StockMarket/data/InitStockMetadata.ts";
import { StockForecastInfluenceLimit } from "../vendor/bitburner/src/StockMarket/Stock.ts";
import { forecastChangePerPriceMovement } from "../vendor/bitburner/src/StockMarket/StockMarketHelpers.ts";
import { forecastForecastChangeFromHack } from "../vendor/bitburner/src/StockMarket/PlayerInfluence.ts";
import {
  getStockMarket4SDataCost,
  getStockMarket4STixApiCost,
  getStockMarketTixApiCost,
  getStockMarketWseCost,
} from "../vendor/bitburner/src/StockMarket/StockMarketCosts.ts";

/** Parity between the SHIPPED transcription and the vendored game source.
 *
 * `shared/features/stocks.ts` and `shared/strategy/stock/market.ts` are hand
 * transcriptions, because they ship inside the game bundle and `game/` may not
 * import the vendored copy (tests/boundaries.test.ts). This is the suite that
 * keeps them honest, and it lives in `sim/` — the one place allowed to read both
 * sides. See the table in spec/game-source.md.
 *
 * After a vendor bump a failure here is the EXPECTED signal, not a regression:
 * update the transcription to match the new game data. */

/** Upstream declares each field as a number or an `{min, max, divisor}`; the
 *  shared table stores the already-divided range. */
function range(value: unknown): [number, number] {
  if (typeof value === "number") return [value, value];
  const bag = value as { min: number; max: number; divisor?: number };
  const divisor = bag.divisor ?? 1;
  return [bag.min / divisor, bag.max / divisor];
}

describe("stock metadata parity", () => {
  test("every symbol, with every generation range", () => {
    expect(STOCK_SYMBOLS).toHaveLength(InitStockMetadata.length);
    for (const upstream of InitStockMetadata) {
      const symbol = (StockSymbol as Record<string, string>)[upstream.name];
      expect(symbol, `no symbol for ${upstream.name}`).toBeDefined();
      const ours = STOCK_METADATA[symbol!];
      expect(ours, `${symbol} missing from STOCK_METADATA`).toBeDefined();
      expect(ours!.organization).toBe(upstream.name);
      expect(ours!.marketCap).toBe(upstream.marketCap);
      expect(ours!.otlkMag).toBe(upstream.otlkMag);
      expect(ours!.bull).toBe(upstream.b);
      expect([...ours!.initPrice], `${symbol} initPrice`).toEqual(range(upstream.initPrice));
      expect([...ours!.mv], `${symbol} mv`).toEqual(range(upstream.mv));
      expect([...ours!.spreadPerc], `${symbol} spreadPerc`).toEqual(range(upstream.spreadPerc));
      expect([...ours!.shareTxForMovement], `${symbol} shareTxForMovement`).toEqual(range(upstream.shareTxForMovement));
    }
  });

  test("the symbol/host mapping matches organizationName exactly", () => {
    // This is the join key stock influence uses (PlayerInfluencing.ts looks the
    // Stock up by server.organizationName), so a stale mapping would silently
    // manipulate the wrong symbol — or none.
    const expected = new Map<string, string[]>();
    for (const server of Object.values(SERVER_METADATA)) {
      const symbol = (StockSymbol as Record<string, string>)[server.org];
      if (!symbol) continue;
      expected.set(symbol, [...(expected.get(symbol) ?? []), server.host]);
    }
    for (const symbol of STOCK_SYMBOLS) {
      expect([...STOCK_METADATA[symbol]!.hosts], `${symbol} hosts`).toEqual(expected.get(symbol) ?? []);
    }
  });

});

describe("market constant parity", () => {
  test("the tick, the cycle and the commission", () => {
    expect(MS_PER_TICK).toBe(StockMarketConstants.msPerStockUpdate);
    expect(MS_PER_TICK_MIN).toBe(StockMarketConstants.msPerStockUpdateMin);
    expect(TICKS_PER_CYCLE).toBe(StockMarketConstants.TicksPerCycle);
    expect(COMMISSION).toBe(StockMarketConstants.StockMarketCommission);
  });

  test("the unlock prices, at their BN1 values", () => {
    expect(WSE_ACCOUNT_COST).toBe(StockMarketConstants.WseAccountCost);
    expect(TIX_API_COST).toBe(StockMarketConstants.TixApiCost);
    expect(FOUR_SIGMA_DATA_COST).toBe(StockMarketConstants.MarketData4SCost);
    expect(FOUR_SIGMA_API_COST).toBe(StockMarketConstants.MarketDataTixApi4SCost);
  });

  test("the forecast influence constants", () => {
    expect(FORECAST_INFLUENCE_LIMIT).toBe(StockForecastInfluenceLimit);
    expect(FORECAST_CHANGE_PER_MOVEMENT).toBe(forecastChangePerPriceMovement);
    expect(FORECAST_NUDGE_PER_OP).toBe(forecastForecastChangeFromHack);
  });

  test("the constants read straight out of the price engine's source text", () => {
    // These three are inline literals in processStockPrices / stockMarketCycle /
    // getForecastIncreaseChance rather than named exports, so the vendored SOURCE
    // is what pins them. Reading the text is uglier than importing a constant and
    // it is the only way to notice upstream changing 0.45 to 0.4.
    const engine = Bun.file(
      new URL("../vendor/bitburner/src/StockMarket/StockPrices.ts", import.meta.url),
    ).text();
    return engine.then((text) => {
      expect(text).toContain(`if (roll < ${CYCLE_FLIP_CHANCE})`);
      expect(text).toContain(`stock.shareTxUntilMovement + ${SHARE_TX_RECOVERY_PER_TICK}`);
    });
  });

  test("the second-order forecast gap clamp", async () => {
    const stock = await Bun.file(new URL("../vendor/bitburner/src/StockMarket/Stock.ts", import.meta.url)).text();
    expect(stock).toContain(`Math.min(Math.max(diff, -${FORECAST_GAP_CLAMP}), ${FORECAST_GAP_CLAMP})`);
  });
});

describe("BitNode-multiplied unlock costs", () => {
  test("BN1 leaves every price alone", () => {
    replaceCurrentNodeMults(getBitNodeMultipliers(1, 1));
    const ours = unlockCosts({ FourSigmaMarketDataCost: 1, FourSigmaMarketDataApiCost: 1 });
    expect(ours.wseAccount).toBe(getStockMarketWseCost());
    expect(ours.tixApi).toBe(getStockMarketTixApiCost());
    expect(ours.fourSigmaData).toBe(getStockMarket4SDataCost());
    expect(ours.fourSigmaApi).toBe(getStockMarket4STixApiCost());
  });

  test("BN9 multiplies the 4S prices and nothing else", () => {
    // 5x the data and 4x the API. This is the difference between "buy the
    // forecast" and "never afford it", and it is why the solver reads the
    // multipliers instead of the base constants.
    const mults = getBitNodeMultipliers(9, 1);
    replaceCurrentNodeMults(mults);
    const ours = unlockCosts({
      FourSigmaMarketDataCost: mults.FourSigmaMarketDataCost,
      FourSigmaMarketDataApiCost: mults.FourSigmaMarketDataApiCost,
    });
    expect(ours.fourSigmaData).toBe(getStockMarket4SDataCost());
    expect(ours.fourSigmaApi).toBe(getStockMarket4STixApiCost());
    expect(ours.fourSigmaData).toBeGreaterThan(FOUR_SIGMA_DATA_COST);
    expect(ours.fourSigmaApi).toBeGreaterThan(FOUR_SIGMA_API_COST);
    expect(ours.wseAccount).toBe(WSE_ACCOUNT_COST);
    expect(ours.tixApi).toBe(TIX_API_COST);
    replaceCurrentNodeMults(getBitNodeMultipliers(1, 1));
  });

  test("BN8 zeroes the player's hacking cut but not the drain rate", () => {
    // The asymmetry the whole manipulation model rests on: ScriptHackMoneyGain 0
    // means hacking earns nothing, ScriptHackMoney 0.3 means it still drains 30%
    // of what it would — and influence rolls against the DRAIN.
    const mults = getBitNodeMultipliers(8, 1);
    expect(mults.ScriptHackMoneyGain).toBe(0);
    expect(mults.ScriptHackMoney).toBe(0.3);
  });
});

describe("volatility units", () => {
  test("the metadata percent divided by 100 is what getVolatility returns", () => {
    // mv is a PERCENT upstream; ns.stock.getVolatility() returns mv/100. Getting
    // this wrong by 100x would make every position look 100x more profitable.
    for (const upstream of InitStockMetadata) {
      const symbol = (StockSymbol as Record<string, string>)[upstream.name]!;
      const ours = midpoint(STOCK_METADATA[symbol]!.mv) / 100;
      const [min, max] = range(upstream.mv);
      expect(ours).toBeGreaterThanOrEqual(min / 100);
      expect(ours).toBeLessThanOrEqual(max / 100);
    }
  });
});
