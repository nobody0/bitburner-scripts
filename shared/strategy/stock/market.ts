/** How the market actually moves — the model every stock decision is built on.
 *
 * Transcribed from `bitburner-src v3.0.1 src/StockMarket/StockMarket.ts`,
 * `Stock.ts`, `StockMarketHelpers.ts` and `PlayerInfluencing.ts`. `game/` ships
 * in the bundle and may not import the vendored copy, so this is a
 * transcription, pinned constant-by-constant by `sim/tests/stock-parity.test.ts`
 * (see the table in spec/game-source.md).
 *
 * Pinned upstream sources:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/StockMarket.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/Stock.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/StockMarketHelpers.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/PlayerInfluencing.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/data/Constants.ts
 *
 * The tick, in full:
 *
 * ```
 * every 6 s (4 s floor when catching up on stored cycles):
 *   v   = random()                      // ONE draw, shared by ALL 33 symbols
 *   av  = v * mv / 100                  // per-symbol magnitude
 *   chc = (50 +/- otlkMag) / 100        // + when bull, - when bear
 *   price *= (1 + av)  with probability chc, else price /= (1 + av)
 *   otlkMag         += ±(otlkMag * av)      // x10 when otlkMag<5; =1 when <=1
 *   otlkMagForecast += ±(otlkMag * av / 2)  // 50/50 coin flip
 * every 75 ticks: each symbol independently has a 45% chance to flip bull/bear
 *   AND mirror its second-order forecast (100 - x)
 * ```
 *
 * Five consequences drive the whole strategy, and each is a thing a naive
 * "buy above 0.5 forecast" trader gets wrong:
 *
 * 1. **`getVolatility()` is the CEILING, not the mean.** The realized magnitude
 *    is `v * mv / 100` with `v ~ U(0,1)`, so the expected move is HALF the
 *    reported volatility. Sizing against the reported figure doubles every
 *    expected-profit estimate. See {@link meanLogStep}.
 * 2. **Spread dominates commission.** A round trip pays `2 * spreadPerc%` of
 *    notional (up to 4% for NTLK) on top of $200k. On any position big enough
 *    to matter, the fixed fee is noise and the spread is the real hurdle. See
 *    {@link expectedProfit}.
 * 3. **The market cycle is periodic, not a guaranteed signal window.** The
 *    boundary repeats every 75 ticks after the initial random offset, but
 *    `cycleForecast` may also flip a symbol between boundaries. The observed
 *    phase is useful for risk bounds, not certainty.
 * 4. **`otlkMagForecast` leads `forecast`.** `getForecastIncreaseChance` pulls
 *    the forecast toward the second-order forecast at up to 95%/tick, so the
 *    forecast converges on `otlkMagForecast / 100`. That is also the ONLY
 *    quantity hack/grow can move, which is what makes manipulation work.
 * 5. **Trading degrades your own signal.** Every `shareTxForMovement` shares
 *    transacted drags `otlkMag` toward a floor of 5 and `otlkMagForecast` toward
 *    50. Size is not free. See {@link selfInfluenceCost}. The price engine also
 *    forces only a 10% up chance above its soft cap, so fixed-signal profit is
 *    an entry model rather than a promise about an arbitrary future price.
 */

// --- constants (v3.0.1) -----------------------------------------------------
// Sources: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/data/Constants.ts
// https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/Stock.ts
// https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/StockMarket.ts
// https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/PlayerInfluencing.ts

/** `StockMarketConstants.msPerStockUpdate`. */
export const MS_PER_TICK = 6_000;
/** `msPerStockUpdateMin` — the floor when stored cycles are being burned, so a
 *  sampler must run faster than this to be sure of seeing every tick. */
export const MS_PER_TICK_MIN = 4_000;
/** `TicksPerCycle`. 75 ticks x 6 s = 7.5 minutes between regime changes. */
export const TICKS_PER_CYCLE = 75;
/** `stockMarketCycle`: per-symbol chance to flip bull/bear at a cycle. */
export const CYCLE_FLIP_CHANCE = 0.45;
/** `StockMarketCommission`, charged on BOTH the buy and the sell. */
export const COMMISSION = 100_000;
/** Script automation unlock costs used by the strategy. */
export const TIX_API_COST = 5e9;
export const FOUR_SIGMA_API_COST = 25e9;
/** `Stock.StockForecastInfluenceLimit` — trading cannot push `otlkMag` below 5. */
export const FORECAST_INFLUENCE_LIMIT = 5;
/** `forecastChangePerPriceMovement`. */
export const FORECAST_CHANGE_PER_MOVEMENT = 0.006;
/** `forecastForecastChangeFromHack` — the nudge one influencing hack or grow
 *  lands, on `otlkMagForecast`'s 0..100 scale. */
export const FORECAST_NUDGE_PER_OP = 0.1;
// --- price movement ---------------------------------------------------------

/** Expected per-tick log price step magnitude, `E[ln(1 + v * volatility)]` over
 * `v ~ U(0,1)`.
 *
 * Exact rather than the `volatility / 2` first-order approximation: closed form
 * `((1+c)ln(1+c) - c) / c`. It matters at the wide end — NTLK's volatility can
 * reach 0.04, where the approximation is off by ~1% per tick and compounds over
 * a 75-tick hold.
 *
 * @param volatility as `ns.stock.getVolatility()` reports it (`mv / 100`).
 */
export function meanLogStep(volatility: number): number {
  if (!(volatility > 0)) return 0;
  return ((1 + volatility) * Math.log1p(volatility) - volatility) / volatility;
}

export type PositionSide = "long" | "short";

/** Which side the forecast favours, and by how much. */
export function favouredSide(forecast: number): PositionSide {
  return forecast >= 0.5 ? "long" : "short";
}

// --- transaction costs ------------------------------------------------------

/** Total round-trip cost in dollars: both commissions plus the spread crossing. */
export function roundTripCost(shares: number, ask: number, bid: number): number {
  return 2 * COMMISSION + shares * Math.max(0, ask - bid);
}

/** Expected underlying-price multiplier for one tick while forecast and
 * volatility remain fixed. Upstream multiplies by `1 + v * volatility` on an
 * up move and divides by it on a down move, with `v` uniform on [0, 1]. This
 * excludes forecast evolution and the soft price cap. */
export function expectedPriceFactor(forecast: number, volatility: number): number {
  if (!(volatility > 0)) return 1;
  const chanceUp = Math.min(1, Math.max(0, forecast));
  const up = 1 + volatility / 2;
  const down = Math.log1p(volatility) / volatility;
  return chanceUp * up + (1 - chanceUp) * down;
}

/** Ticks until fixed-signal expected settlement clears spread and commission.
 * Infinite when the selected side cannot break even. */
export function breakEvenTicks(params: {
  shares: number;
  ask: number;
  bid: number;
  forecast: number;
  volatility: number;
  side: PositionSide;
}): number {
  const { shares, ask, bid, forecast, volatility, side } = params;
  if (!(shares > 0) || !(ask > 0) || !(bid > 0)) return Infinity;
  const factor = expectedPriceFactor(forecast, volatility);
  if (side === "long") {
    if (!(factor > 1)) return Infinity;
    const target = (ask + (2 * COMMISSION) / shares) / bid;
    return target > 1 ? Math.log(target) / Math.log(factor) : 0;
  }
  if (!(factor < 1)) return Infinity;
  const proceedsAfterFees = bid - (2 * COMMISSION) / shares;
  if (!(proceedsAfterFees > 0)) return Infinity;
  const target = proceedsAfterFees / ask;
  return target < 1 ? Math.log(target) / Math.log(factor) : 0;
}

/** Fixed-signal expected settlement. Longs enter at ask and leave at future
 * bid; shorts enter at bid and cover at future ask. */
export function expectedProfit(params: {
  shares: number;
  ask: number;
  bid: number;
  forecast: number;
  volatility: number;
  side: PositionSide;
  ticks: number;
}): number {
  const { shares, ask, bid, forecast, volatility, side, ticks } = params;
  if (!(shares > 0) || !(ask > 0) || !(bid > 0)) return 0;
  const priceFactor = expectedPriceFactor(forecast, volatility) ** Math.max(0, ticks);
  const gross = side === "long"
    ? shares * (bid * priceFactor - ask)
    : shares * (bid - ask * priceFactor);
  return gross - 2 * COMMISSION;
}

/** Estimate of the forecast damage caused by a trade.
 *
 * Every `shareTxForMovement` shares transacted calls `influenceForecast`, which
 * moves `otlkMag` `FORECAST_CHANGE_PER_MOVEMENT` toward the floor of 5. So a
 * position of N shares costs roughly `0.006 * N / shareTxForMovement` points of
 * outlook magnitude — for ECP's full 21.8M-share allocation, ~2.2 points off a
 * 19-point outlook.
 *
 * The live movement threshold and its accumulated headroom are hidden, so the
 * metadata midpoint estimates rather than reproduces the exact transaction.
 * Returned in FORECAST units (0..1) so it can be subtracted from a forecast
 * directly, and clamped by the influence floor: a symbol already at or below
 * `otlkMag = 5` (forecast 0.55 / 0.45) cannot be damaged further. */
export function selfInfluenceCost(shares: number, shareTxForMovement: number, forecast: number): number {
  if (!(shares > 0) || !(shareTxForMovement > 0)) return 0;
  // The epsilon is not cosmetic: `|0.55 - 0.5| * 100` is 5.000000000000004 in
  // binary floating point, so an exact comparison lets a symbol sitting exactly
  // on the floor report a (meaningless) 4e-17 of damage.
  const magnitude = Math.abs(forecast - 0.5) * 100;
  if (magnitude <= FORECAST_INFLUENCE_LIMIT + 1e-9) return 0;
  const movements = shares / shareTxForMovement;
  const points = Math.min(magnitude - FORECAST_INFLUENCE_LIMIT, FORECAST_CHANGE_PER_MOVEMENT * movements);
  return points / 100;
}

/** The forecast a position of this size will actually experience, after paying
 *  for its own market impact. Always closer to 0.5 than the quoted forecast. */
export function effectiveForecast(forecast: number, shares: number, shareTxForMovement: number): number {
  const cost = selfInfluenceCost(shares, shareTxForMovement, forecast);
  return forecast >= 0.5 ? forecast - cost : forecast + cost;
}

// --- manipulation -----------------------------------------------------------

/** Expected `otlkMagForecast` nudges from ONE influencing op.
 *
 * `influenceStockThroughServerHack/Grow` roll once per call with probability
 * `moneyMoved / server.moneyMax` and, on success, move the second-order
 * forecast by `FORECAST_NUDGE_PER_OP`. So the expected nudge is
 * `stealFraction * 0.1` — and crucially `moneyMax` CANCELS: manipulating a
 * symbol through `joesguns` moves it exactly as fast as through `ecorp`, for a
 * fraction of the threads and a fraction of the batch time.
 *
 * Note `moneyDrained` is measured BEFORE `ScriptHackMoneyGain` is applied, so
 * BN8's `ScriptHackMoneyGain: 0` leaves manipulation at full strength while
 * hacking earns nothing. `ScriptHackMoney` DOES scale it, because it scales the
 * drained fraction itself. */
export function nudgesPerOp(stealFraction: number): number {
  return Math.min(1, Math.max(0, stealFraction)) * FORECAST_NUDGE_PER_OP;
}

/** Calibrated fraction of a nudge's theoretical value realized during a hold.
 *
 * A nudge moves `otlkMagForecast` immediately, but `forecast` only walks toward
 * it at `otlkMag * av` per tick — so the price impact arrives gradually over the
 * hold rather than at once. The bounded manipulation lanes calibrate this
 * heuristic; it is not an upstream constant. */
export const NUDGE_CONVERGENCE = 0.5;

/** Dollars one `otlkMagForecast` nudge is worth, given the position it will be
 * realized against.
 *
 * A nudge is 0.1 on a 0..100 scale, so it moves the equilibrium forecast by
 * 0.001 and the per-tick log drift by `2 * 0.001 * meanLogStep`. Over `ticks`
 * remaining hold on `notional` dollars, discounted for the convergence ramp.
 *
 * Saturates as the forecast approaches the extreme it is being pushed toward:
 * `changeForecastForecast` clamps at 0 and 100, so nudging a symbol already
 * forecast at 0.95 buys almost nothing. `forecast` is the observable proxy for
 * where `otlkMagForecast` already is. */
export function nudgeValue(params: {
  notional: number;
  volatility: number;
  ticks: number;
  forecast: number;
  side: PositionSide;
  convergence?: number;
}): number {
  const { notional, volatility, ticks, forecast, side } = params;
  if (!(notional > 0) || !(ticks > 0)) return 0;
  const headroom = side === "long" ? Math.max(0, 1 - forecast) : Math.max(0, forecast);
  if (headroom <= 0) return 0;
  const driftPerNudge = 2 * (FORECAST_NUDGE_PER_OP / 100) * meanLogStep(volatility);
  return notional * driftPerNudge * ticks * (params.convergence ?? NUDGE_CONVERGENCE) * Math.min(1, headroom / 0.5);
}

/** Dollars of stock profit ONE influencing op is worth — the number the hacking
 * evaluator adds to a target's income so `$/GB/sec` prices manipulation and
 * hacked money on the same scale. */
export function manipulationValuePerOp(params: {
  stealFraction: number;
  notional: number;
  volatility: number;
  ticks: number;
  forecast: number;
  side: PositionSide;
  convergence?: number;
}): number {
  return nudgesPerOp(params.stealFraction) * nudgeValue(params);
}

// --- BitNode-adjusted costs -------------------------------------------------

/** BitNode multiplier that affects the automation unlock bought here. */
export interface StockNodeMults {
  FourSigmaMarketDataApiCost?: number;
}

export interface UnlockCosts {
  tixApi: number;
  fourSigmaApi: number;
}

/** TIX is fixed; the 4S TIX API uses the node multiplier.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/StockMarket.ts */
export function unlockCosts(mults: StockNodeMults | undefined): UnlockCosts {
  return {
    tixApi: TIX_API_COST,
    fourSigmaApi: FOUR_SIGMA_API_COST * (mults?.FourSigmaMarketDataApiCost ?? 1),
  };
}

// --- ticks and horizons -----------------------------------------------------

/** Ticks that fit in a horizon. The strategy thinks in ticks (the market's own
 *  unit) and every horizon arrives in seconds, so this is the one conversion. */
export function ticksInSeconds(seconds: number): number {
  return Math.max(0, Math.floor((seconds * 1000) / MS_PER_TICK));
}

export function secondsForTicks(ticks: number): number {
  return (ticks * MS_PER_TICK) / 1000;
}
