// Vendored from bitburner-src v3.0.1:src/StockMarket/StockMarket.ts (5 symbols, extracted by
// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT
import { CONSTANTS } from "../Constants";
import { StockMarketConstants } from "./data/Constants";
import { InitStockMetadata } from "./data/InitStockMetadata";
import { OrderType, PositionType, StockSymbol } from "./Enums";
import { Stock } from "./Stock";
import {
  getDarknetVolatilityMult,
  getRandomIntInclusive,
  processOrders,
  scaleDarknetVolatilityIncreases,
  StockMarket,
  StockMarketPromise,
  stockNow,
  stockRandom,
  SymbolToStockMap,
  type IOrderBook,
} from "./MarketAdapter";

export function initStockMarket(): void {
  for (const stockName of Object.getOwnPropertyNames(StockMarket)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete StockMarket[stockName];
  }

  for (const metadata of InitStockMetadata) {
    const name = metadata.name;
    StockMarket[name] = new Stock(metadata);
  }

  const orders: IOrderBook = {};
  for (const name of Object.keys(StockMarket)) {
    const stock = StockMarket[name];
    if (!(stock instanceof Stock)) continue;
    orders[stock.symbol] = [];
  }
  StockMarket.Orders = orders;

  StockMarket.storedCycles = 0;
  StockMarket.lastUpdate = stockNow();
  StockMarket.ticksUntilCycle = getRandomIntInclusive(1, StockMarketConstants.TicksPerCycle);
  initSymbolToStockMap();
}

export function initSymbolToStockMap(): void {
  for (const [name, symbol] of Object.entries(StockSymbol)) {
    const stock = StockMarket[name];
    if (stock == null) {
      console.error(`Could not find Stock for ${name}`);
      continue;
    }
    SymbolToStockMap[symbol] = stock;
  }
}

function stockMarketCycle(): void {
  for (const name of Object.keys(StockMarket)) {
    const stock = StockMarket[name];
    if (!(stock instanceof Stock)) continue;

    const roll = stockRandom();
    if (roll < 0.45) {
      stock.b = !stock.b;
      stock.flipForecastForecast();
    }
    StockMarket.ticksUntilCycle = StockMarketConstants.TicksPerCycle;
  }
  scaleDarknetVolatilityIncreases(0.4);
}

const cyclesPerStockUpdate = StockMarketConstants.msPerStockUpdate / CONSTANTS.MilliPerCycle;

export function processStockPrices(numCycles = 1): void {
  if (StockMarket.storedCycles == null || isNaN(StockMarket.storedCycles)) {
    StockMarket.storedCycles = 0;
  }
  StockMarket.storedCycles += numCycles;

  if (StockMarket.storedCycles < cyclesPerStockUpdate) {
    return;
  }

  // We can process the update every 4 seconds as long as there are enough
  // stored cycles. This lets us account for offline time
  const timeNow = stockNow();
  if (timeNow - StockMarket.lastUpdate < StockMarketConstants.msPerStockUpdateMin) return;

  StockMarket.lastUpdate = timeNow;
  StockMarket.storedCycles -= cyclesPerStockUpdate;

  // Cycle
  if (StockMarket.ticksUntilCycle == null || typeof StockMarket.ticksUntilCycle !== "number") {
    StockMarket.ticksUntilCycle = StockMarketConstants.TicksPerCycle;
  }
  --StockMarket.ticksUntilCycle;
  if (StockMarket.ticksUntilCycle <= 0) stockMarketCycle();

  const v = stockRandom();
  for (const name of Object.keys(StockMarket)) {
    const stock = StockMarket[name];
    if (!(stock instanceof Stock)) continue;
    const volatility = stock.mv * getDarknetVolatilityMult(stock.symbol);
    let av = (v * volatility) / 100;
    if (isNaN(av)) {
      av = 0.02;
    }

    let chc = 50;
    if (stock.b) {
      chc = (chc + stock.otlkMag) / 100;
    } else {
      chc = (chc - stock.otlkMag) / 100;
    }
    if (stock.price >= stock.cap) {
      chc = 0.1; // "Soft Limit" on stock price. It could still go up but its unlikely
      stock.b = false;
    }
    if (isNaN(chc)) {
      chc = 0.5;
    }

    const c = stockRandom();
    const processOrderRefs = {
      stockMarket: StockMarket,
      symbolToStockMap: SymbolToStockMap,
    };
    if (c < chc) {
      stock.changePrice(stock.price * (1 + av));
      processOrders(stock, OrderType.LimitBuy, PositionType.Short, processOrderRefs);
      processOrders(stock, OrderType.LimitSell, PositionType.Long, processOrderRefs);
      processOrders(stock, OrderType.StopBuy, PositionType.Long, processOrderRefs);
      processOrders(stock, OrderType.StopSell, PositionType.Short, processOrderRefs);
    } else {
      stock.changePrice(stock.price / (1 + av));
      processOrders(stock, OrderType.LimitBuy, PositionType.Long, processOrderRefs);
      processOrders(stock, OrderType.LimitSell, PositionType.Short, processOrderRefs);
      processOrders(stock, OrderType.StopBuy, PositionType.Short, processOrderRefs);
      processOrders(stock, OrderType.StopSell, PositionType.Long, processOrderRefs);
    }

    let otlkMagChange = stock.otlkMag * av;
    if (stock.otlkMag < 5) {
      if (stock.otlkMag <= 1) {
        otlkMagChange = 1;
      } else {
        otlkMagChange *= 10;
      }
    }
    stock.cycleForecast(otlkMagChange);
    stock.cycleForecastForecast(otlkMagChange / 2);

    // Shares required for price movement gradually approaches max over time
    stock.shareTxUntilMovement = Math.min(stock.shareTxUntilMovement + 10, stock.shareTxForMovement);
  }
  // Handle "nextUpdate" resolver after this update
  if (StockMarketPromise.resolve) {
    StockMarketPromise.resolve(StockMarketConstants.msPerStockUpdate);
    StockMarketPromise.resolve = null;
    StockMarketPromise.promise = null;
  }
}
