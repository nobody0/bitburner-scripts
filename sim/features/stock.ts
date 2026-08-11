import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import type { SaveStockMarket } from "../../shared/save/snapshot.ts";
import { PositionType } from "../vendor/bitburner/src/StockMarket/Enums.ts";
import { setMarketContext, StockMarket, SymbolToStockMap } from "../vendor/bitburner/src/StockMarket/MarketAdapter.ts";
import {
  influenceStockThroughServerGrow,
  influenceStockThroughServerHack,
} from "../vendor/bitburner/src/StockMarket/PlayerInfluence.ts";
import { Stock } from "../vendor/bitburner/src/StockMarket/Stock.ts";
import { initStockMarket, processStockPrices } from "../vendor/bitburner/src/StockMarket/StockPrices.ts";
import { StockMarketConstants } from "../vendor/bitburner/src/StockMarket/data/Constants.ts";
import {
  getBuyTransactionCost,
  getSellTransactionGain,
  processTransactionForecastMovement,
} from "../vendor/bitburner/src/StockMarket/StockMarketHelpers.ts";
import {
  getStockMarket4SDataCost,
  getStockMarket4STixApiCost,
  getStockMarketTixApiCost,
  getStockMarketWseCost,
} from "../vendor/bitburner/src/StockMarket/StockMarketCosts.ts";

/** The World Stock Exchange.
 *
 * Almost none of this is ours. The price engine (`processStockPrices`), the
 * world generator (`initStockMarket`), the `Stock` class with its forecast
 * dynamics, the per-symbol metadata, the transaction cost/gain helpers, the
 * self-influence of a large trade, the BitNode-multiplied unlock prices and the
 * hack/grow manipulation are all the real v3.0.1 source, vendored (see
 * tools/vendor.ts). That is deliberate and it is the whole point: the strategy in
 * `shared/strategy/stock/` is a hand-crafted MODEL of these mechanics, and a
 * simulator built from the same transcription would only ever confirm the
 * transcription. `sim/tests/stock-parity.test.ts` checks the two against each
 * other; this file makes the model face the real thing.
 *
 * Three substitutions, all in MarketAdapter and all forced by the simulator's
 * requirements rather than by convenience:
 *  - the module-level `StockMarket` singleton (one market per process),
 *  - `Math.random` (reproducible seeds),
 *  - `new Date().getTime()` (virtual time).
 *
 * What is genuinely NOT modelled: limit/stop orders (`processOrders` is a no-op
 * and `ns.stock.placeOrder` reports itself unmodelled), and the BN15 darknet
 * volatility boost (a neutral 1x, because `dnet` has no model to drive it).
 *
 * Only four things below are ours, transcribed from `BuyingAndSelling.tsx` —
 * which cannot be vendored because it is a `.tsx` file whose imports reach the
 * live Player and the React dialog box. They are the money side of a trade, and
 * every number in them comes from the vendored helpers. */
export class StockMarketSystem {
  #world: SimWorld;
  #player: SimPlayer;
  /** Cycles buffered by processStockPrices itself — it owns its own
   *  `storedCycles`, so unlike gang or corp this needs no CycleBuffer. */
  hasWseAccount: boolean;
  hasTixApiAccess: boolean;
  has4SData = false;
  has4SDataTixApi = false;
  /** BitNodeOptions.disable4SData — the forecast cannot be bought at all. */
  readonly fourSigmaDisabled: boolean;
  /** Rolled forward by every trade, for the run summary. */
  commissionPaid = 0;
  tradesMade = 0;
  realizedProfit = 0;

  constructor(
    world: SimWorld,
    player: SimPlayer,
    rng: () => number,
    opts: {
      hasWseAccount?: boolean;
      hasTixApiAccess?: boolean;
      has4SData?: boolean;
      has4SDataTixApi?: boolean;
      disable4SData?: boolean;
      seed?: SaveStockMarket;
    } = {},
  ) {
    this.#world = world;
    this.#player = player;
    this.hasWseAccount = opts.hasWseAccount ?? false;
    this.hasTixApiAccess = opts.hasTixApiAccess ?? false;
    this.has4SData = opts.has4SData ?? false;
    this.has4SDataTixApi = opts.has4SDataTixApi ?? false;
    this.fourSigmaDisabled = opts.disable4SData ?? false;
    // Both injections before initStockMarket: the constructor of every Stock
    // rolls its price, cap, spread, volatility and shareTxForMovement, and
    // `lastUpdate` is stamped from the clock.
    setMarketContext({ random: rng, now: () => world.clock.now() });
    if (this.hasWseAccount || this.hasTixApiAccess) {
      initStockMarket();
      if (opts.seed) this.#restore(opts.seed);
    }
  }

  #restore(seed: SaveStockMarket): void {
    for (const [name, state] of Object.entries(seed.stocks)) {
      const stock = StockMarket[name];
      if (!(stock instanceof Stock)) throw new Error(`save stock market contains unknown stock ${name}`);
      Object.assign(stock, state);
    }
    StockMarket.storedCycles = seed.storedCycles;
    StockMarket.ticksUntilCycle = seed.ticksUntilCycle;
    // A run starts at virtual t=0. Preserve buffered/cycle state, but rebase
    // the wall-clock gate exactly as loading into a new runtime does.
    StockMarket.lastUpdate = this.#world.clock.now();
  }

  /** Engine hook, in updateGame's real order (second, right after processWork).
   *  Buffering, the 4 s floor and the 75-tick cycle all live inside the vendored
   *  function — this only forwards the cycles. */
  processPrices(cycles: number): void {
    if (!this.hasWseAccount && !this.hasTixApiAccess) return;
    processStockPrices(cycles);
  }

  symbols(): string[] {
    return Object.keys(SymbolToStockMap);
  }

  stock(symbol: string): Stock | undefined {
    const found = SymbolToStockMap[symbol];
    return found instanceof Stock ? found : undefined;
  }

  /** `initStockMarket` re-rolls every symbol and zeroes every holding — which is
   * exactly what an augmentation install does (`prestigeAugmentation` calls it),
   * and the single most important fact the strategy has to respect: a position
   * held through an install is destroyed, not sold. */
  prestige(): void {
    if (this.hasWseAccount || this.hasTixApiAccess) initStockMarket();
  }

  // --- transactions (transcribed from BuyingAndSelling.tsx @ v3.0.1) --------

  buyStock(symbol: string, shares: number): number {
    const stock = this.stock(symbol);
    shares = Math.round(shares);
    if (!stock || shares <= 0) return 0;
    const totalPrice = getBuyTransactionCost(stock, shares, PositionType.Long);
    if (totalPrice == null || this.#player.money < totalPrice) return 0;
    if (shares + stock.playerShares + stock.playerShortShares > stock.maxShares) return 0;

    const origTotal = stock.playerShares * stock.playerAvgPx;
    this.#player.money -= totalPrice;
    this.#world.recordMoney("stock", -totalPrice);
    const newTotal = origTotal + totalPrice - StockMarketConstants.StockMarketCommission;
    stock.playerShares = Math.round(stock.playerShares + shares);
    stock.playerAvgPx = newTotal / stock.playerShares;
    // A large trade drags its own forecast back toward neutral. Modelling the
    // buy without this would make big positions look free.
    processTransactionForecastMovement(stock, shares);
    this.#record(symbol, "buy", shares, totalPrice);
    return stock.getAskPrice();
  }

  sellStock(symbol: string, shares: number): number {
    const stock = this.stock(symbol);
    if (!stock || shares < 0) return 0;
    shares = Math.min(Math.round(shares), stock.playerShares);
    if (shares === 0) return 0;
    const gains = getSellTransactionGain(stock, shares, PositionType.Long);
    if (gains == null) return 0;
    const netProfit = gains - stock.playerAvgPx * shares;
    this.#player.money += gains;
    this.#world.recordMoney("stock", gains);
    this.#credit(netProfit);
    stock.playerShares = Math.round(stock.playerShares - shares);
    if (stock.playerShares === 0) stock.playerAvgPx = 0;
    processTransactionForecastMovement(stock, shares);
    this.#record(symbol, "sell", shares, gains);
    return stock.getBidPrice();
  }

  buyShort(symbol: string, shares: number): number {
    const stock = this.stock(symbol);
    shares = Math.round(shares);
    if (!stock || shares <= 0) return 0;
    const totalPrice = getBuyTransactionCost(stock, shares, PositionType.Short);
    if (totalPrice == null || this.#player.money < totalPrice) return 0;
    if (shares + stock.playerShares + stock.playerShortShares > stock.maxShares) return 0;

    const origTotal = stock.playerShortShares * stock.playerAvgShortPx;
    this.#player.money -= totalPrice;
    this.#world.recordMoney("stock", -totalPrice);
    const newTotal = origTotal + totalPrice - StockMarketConstants.StockMarketCommission;
    stock.playerShortShares = Math.round(stock.playerShortShares + shares);
    stock.playerAvgShortPx = newTotal / stock.playerShortShares;
    processTransactionForecastMovement(stock, shares);
    this.#record(symbol, "short", shares, totalPrice);
    return stock.getBidPrice();
  }

  sellShort(symbol: string, shares: number): number {
    const stock = this.stock(symbol);
    if (!stock || shares < 0) return 0;
    shares = Math.min(Math.round(shares), stock.playerShortShares);
    if (shares === 0) return 0;
    const origCost = shares * stock.playerAvgShortPx;
    const totalGain = getSellTransactionGain(stock, shares, PositionType.Short);
    if (totalGain == null || isNaN(totalGain)) return 0;
    const profit = totalGain - origCost;
    this.#player.money += totalGain;
    this.#world.recordMoney("stock", totalGain);
    this.#credit(profit);
    stock.playerShortShares = Math.round(stock.playerShortShares - shares);
    if (stock.playerShortShares === 0) stock.playerAvgShortPx = 0;
    processTransactionForecastMovement(stock, shares);
    this.#record(symbol, "closeShort", shares, totalGain);
    return stock.getAskPrice();
  }

  /** Realized P/L into the world's earnings ledger — NET profit, not the gross
   * proceeds.
   *
   * Gross would count the principal we already had as income, so a run that
   * bought and sold at the same price would look like it earned the whole
   * position. Net is also what makes an `earn:` goal meaningful in BN8, where the
   * market is the only income and `Player.gainMoney(gains, "stock")` is the
   * game's own accounting of it. A losing trade reduces the ledger, which is the
   * honest direction. */
  #credit(profit: number): void {
    if (!Number.isFinite(profit)) return;
    this.realizedProfit += profit;
    this.#world.moneyEarned += profit;
  }

  #record(symbol: string, kind: string, shares: number, money: number): void {
    this.tradesMade++;
    this.commissionPaid += StockMarketConstants.StockMarketCommission;
    this.#world.emit({ kind: "event", name: "stock.trade", data: { symbol, kind, shares, money } });
  }

  /** Cash obtainable by closing the live book at current public quotes. Uses
   * the same vendored transaction helper as an actual sale, including the
   * final commission and short cost basis, but has no side effects. */
  liquidationValue(): number {
    let total = 0;
    for (const symbol of this.symbols()) {
      const stock = this.stock(symbol);
      if (!stock) continue;
      if (stock.playerShares > 0) {
        total += getSellTransactionGain(stock, stock.playerShares, PositionType.Long) ?? 0;
      }
      if (stock.playerShortShares > 0) {
        total += getSellTransactionGain(stock, stock.playerShortShares, PositionType.Short) ?? 0;
      }
    }
    return total;
  }

  // --- unlocks --------------------------------------------------------------

  costs(): { wse: number; tix: number; fourSigmaData: number; fourSigmaApi: number } {
    return {
      wse: getStockMarketWseCost(),
      tix: getStockMarketTixApiCost(),
      fourSigmaData: getStockMarket4SDataCost(),
      fourSigmaApi: getStockMarket4STixApiCost(),
    };
  }

  purchaseWseAccount(): boolean {
    if (this.hasWseAccount) return true;
    const cost = getStockMarketWseCost();
    if (this.#player.money < cost) return false;
    this.hasWseAccount = true;
    // Upstream initialises the market on purchase, which is also when every
    // symbol's price, cap and spread are first rolled.
    initStockMarket();
    this.#player.money -= cost;
    this.#world.recordMoney("stock", -cost);
    this.#world.emit({ kind: "event", name: "stock.unlock", data: { what: "wse", cost } });
    return true;
  }

  purchaseTixApi(): boolean {
    if (this.hasTixApiAccess) return true;
    const cost = getStockMarketTixApiCost();
    if (this.#player.money < cost) return false;
    this.hasTixApiAccess = true;
    if (this.symbols().length === 0) initStockMarket();
    this.#player.money -= cost;
    this.#world.recordMoney("stock", -cost);
    this.#world.emit({ kind: "event", name: "stock.unlock", data: { what: "tix", cost } });
    return true;
  }

  purchase4SMarketData(): boolean {
    if (this.fourSigmaDisabled) return false;
    if (this.has4SData) return true;
    if (!this.hasWseAccount) return false;
    const cost = getStockMarket4SDataCost();
    if (this.#player.money < cost) return false;
    this.has4SData = true;
    this.#player.money -= cost;
    this.#world.recordMoney("stock", -cost);
    this.#world.emit({ kind: "event", name: "stock.unlock", data: { what: "4sData", cost } });
    return true;
  }

  /** The one 4S purchase that matters to a script: `getForecast` and
   *  `getVolatility` check THIS flag, and it does not require `has4SData` first. */
  purchase4SMarketDataTixApi(): boolean {
    if (this.fourSigmaDisabled) return false;
    if (this.has4SDataTixApi) return true;
    const cost = getStockMarket4STixApiCost();
    if (this.#player.money < cost) return false;
    this.has4SDataTixApi = true;
    this.#player.money -= cost;
    this.#world.recordMoney("stock", -cost);
    this.#world.emit({ kind: "event", name: "stock.unlock", data: { what: "4sApi", cost } });
    return true;
  }

  // --- manipulation ---------------------------------------------------------

  /** `hack(host, {stock: true})`. `moneyDrained` is the PRE-`ScriptHackMoneyGain`
   *  figure, which is why BN8's zero player-cut leaves manipulation at full
   *  strength — the roll is against the fraction of `moneyMax` removed. */
  influenceHack(server: { organizationName: string; moneyMax: number }, moneyDrained: number): void {
    if (!this.hasWseAccount && !this.hasTixApiAccess) return;
    influenceStockThroughServerHack(server, moneyDrained);
  }

  /** `grow(host, {stock: true})`. */
  influenceGrow(server: { organizationName: string; moneyMax: number }, moneyGrown: number): void {
    if (!this.hasWseAccount && !this.hasTixApiAccess) return;
    influenceStockThroughServerGrow(server, moneyGrown);
  }

  // --- reporting ------------------------------------------------------------

  /** Mark-to-market: a long exits at the bid, a short at the ask. */
  portfolioValue(): number {
    let total = 0;
    for (const symbol of this.symbols()) {
      const stock = this.stock(symbol);
      if (!stock) continue;
      total += stock.playerShares * stock.getBidPrice();
      total += stock.playerShortShares * (2 * stock.playerAvgShortPx - stock.getAskPrice());
    }
    return total;
  }

  /** Ticks the market has processed, for the cycle-detection tests. */
  get ticksUntilCycle(): number {
    return StockMarket.ticksUntilCycle;
  }
}
