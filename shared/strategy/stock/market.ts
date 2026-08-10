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
 *    {@link roundTripCostFraction}.
 * 3. **The forecast is persistent, and the regime change is SCHEDULED.**
 *    `otlkMag` drifts by `otlkMag * av` — a few points over a whole 75-tick
 *    cycle — so a forecast is nearly constant within a cycle. What ends it is
 *    the cycle boundary, which arrives every 75 ticks EXACTLY once the first
 *    random offset has passed. That makes it observable and plannable
 *    (shared/strategy/stock/history.ts).
 * 4. **`otlkMagForecast` leads `forecast`.** `getForecastIncreaseChance` pulls
 *    the forecast toward the second-order forecast at up to 95%/tick, so the
 *    forecast converges on `otlkMagForecast / 100`. That is also the ONLY
 *    quantity hack/grow can move, which is what makes manipulation work.
 * 5. **Trading degrades your own signal.** Every `shareTxForMovement` shares
 *    transacted drags `otlkMag` toward a floor of 5 and `otlkMagForecast` toward
 *    50. Size is not free. See {@link selfInfluenceCost}.
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
/** `WseAccountCost` / `TixApiCost` / `MarketData4SCost` / `MarketDataTixApi4SCost`. */
export const WSE_ACCOUNT_COST = 200e6;
export const TIX_API_COST = 5e9;
export const FOUR_SIGMA_DATA_COST = 1e9;
export const FOUR_SIGMA_API_COST = 25e9;
/** `Stock.StockForecastInfluenceLimit` — trading cannot push `otlkMag` below 5. */
export const FORECAST_INFLUENCE_LIMIT = 5;
/** `forecastChangePerPriceMovement`. */
export const FORECAST_CHANGE_PER_MOVEMENT = 0.006;
/** `forecastForecastChangeFromHack` — the nudge one influencing hack or grow
 *  lands, on `otlkMagForecast`'s 0..100 scale. */
export const FORECAST_NUDGE_PER_OP = 0.1;
/** Shares of headroom `shareTxUntilMovement` recovers per tick. */
export const SHARE_TX_RECOVERY_PER_TICK = 10;
/** `getForecastIncreaseChance` clamps the second-order gap to +/-45, so the
 *  forecast converges on `otlkMagForecast` at up to 95% of ticks. */
export const FORECAST_GAP_CLAMP = 45;

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

/** Expected log return per tick of a LONG position: `(2f - 1) * meanLogStep`.
 *
 * At forecast 0.5 this is exactly zero, which is the point — no information
 * means no edge, and a trader who bought anyway would pay the spread for a coin
 * flip. Negative values are the short's edge, with the sign flipped. */
export function driftPerTick(forecast: number, volatility: number): number {
  return (2 * forecast - 1) * meanLogStep(volatility);
}

/** Expected log return per tick of a position on the given side. */
export function sideDriftPerTick(forecast: number, volatility: number, side: PositionSide): number {
  const drift = driftPerTick(forecast, volatility);
  return side === "short" ? -drift : drift;
}

export type PositionSide = "long" | "short";

/** Which side the forecast favours, and by how much. */
export function favouredSide(forecast: number): PositionSide {
  return forecast >= 0.5 ? "long" : "short";
}

// --- transaction costs ------------------------------------------------------

/** Round-trip cost as a FRACTION of notional, from the live ask/bid.
 *
 * Both legs cross the spread: you buy at ask and sell at bid, so the loss is
 * `(ask - bid) / ask` of the position before any price movement. This is the
 * number the old sizing logic omitted entirely, and it is 10x-200x the
 * commission on a position large enough to be worth opening. */
export function roundTripCostFraction(ask: number, bid: number): number {
  if (!(ask > 0) || !(bid > 0)) return Infinity;
  return Math.max(0, (ask - bid) / ask);
}

/** Total round-trip cost in dollars: both commissions plus the spread crossing. */
export function roundTripCost(shares: number, ask: number, bid: number): number {
  return 2 * COMMISSION + shares * Math.max(0, ask - bid);
}

/** Ticks a position must be held before the expected drift clears its round
 * trip. Infinite when the drift is the wrong sign or zero.
 *
 * This is the honest replacement for the old code's "assume 10 ticks": rather
 * than assert a hold length and size against it, derive the hold length the
 * position actually requires and refuse the trade if the horizon is shorter. */
export function breakEvenTicks(params: {
  shares: number;
  ask: number;
  bid: number;
  forecast: number;
  volatility: number;
  side: PositionSide;
}): number {
  const { shares, ask, bid, forecast, volatility, side } = params;
  const drift = sideDriftPerTick(forecast, volatility, side);
  if (!(drift > 0) || !(shares > 0)) return Infinity;
  const notional = shares * (side === "short" ? bid : ask);
  if (!(notional > 0)) return Infinity;
  return roundTripCost(shares, ask, bid) / (notional * drift);
}

/** Expected profit in dollars from holding `shares` for `ticks`, net of the
 * round trip. Uses the log drift compounded over the hold, which is the correct
 * shape — the game multiplies and divides the price, it does not add. */
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
  if (!(shares > 0) || !(ticks > 0)) return 0;
  const drift = sideDriftPerTick(forecast, volatility, side);
  const notional = shares * (side === "short" ? bid : ask);
  const gross = notional * Math.expm1(drift * ticks);
  return gross - roundTripCost(shares, ask, bid);
}

/** The forecast damage a trade of this size does to itself.
 *
 * Every `shareTxForMovement` shares transacted calls `influenceForecast`, which
 * moves `otlkMag` `FORECAST_CHANGE_PER_MOVEMENT` toward the floor of 5. So a
 * position of N shares costs roughly `0.006 * N / shareTxForMovement` points of
 * outlook magnitude — for ECP's full 21.8M-share allocation, ~2.2 points off a
 * 19-point outlook.
 *
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

/** Fraction of a nudge's theoretical value that is actually realized.
 *
 * A nudge moves `otlkMagForecast` immediately, but `forecast` only walks toward
 * it at `otlkMag * av` per tick — so the price impact arrives gradually over the
 * hold rather than at once. Half credit is the conservative midpoint of that
 * ramp, and it is a named parameter precisely so the simulator can measure the
 * right value instead of us asserting one. */
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

/** The BitNode multipliers that change what the market is worth.
 *
 * The market's own mechanics are NOT multiplied by anything — no BitNode scales
 * a stock's price, forecast or volatility. Only two things move:
 *
 *  - **the unlock prices**, via `FourSigmaMarketDataCost` /
 *    `FourSigmaMarketDataApiCost` (BN9 charges 5x/4x, and the option to disable
 *    4S entirely exists), which is what decides whether the forecast is
 *    affordable at all; and
 *  - **the manipulation trade-off**, via `ScriptHackMoney` (scales the drained
 *    fraction, so it scales nudges per op) and `ScriptHackMoneyGain` (scales
 *    only the player's cut, so it scales what hacking gives up to manipulate).
 *
 * That asymmetry is the whole of BN8: `ScriptHackMoneyGain: 0` makes hacked
 * money worth zero while `ScriptHackMoney: 0.3` leaves manipulation at 30%
 * strength, so the market stops being one income source among several and
 * becomes the only one. */
export interface StockNodeMults {
  FourSigmaMarketDataCost?: number;
  FourSigmaMarketDataApiCost?: number;
  ScriptHackMoney?: number;
  ScriptHackMoneyGain?: number;
}

export interface UnlockCosts {
  wseAccount: number;
  tixApi: number;
  fourSigmaData: number;
  fourSigmaApi: number;
}

/** `getStockMarket4SDataCost` and friends: the base cost times the node's
 *  multiplier. WSE and TIX are NOT multiplied by anything upstream.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/StockMarket.ts */
export function unlockCosts(mults: StockNodeMults | undefined): UnlockCosts {
  return {
    wseAccount: WSE_ACCOUNT_COST,
    tixApi: TIX_API_COST,
    fourSigmaData: FOUR_SIGMA_DATA_COST * (mults?.FourSigmaMarketDataCost ?? 1),
    fourSigmaApi: FOUR_SIGMA_API_COST * (mults?.FourSigmaMarketDataApiCost ?? 1),
  };
}

/** How much the market matters relative to hacking, in this node.
 *
 * `1` means hacked money arrives at full value and the market competes with it
 * on the merits. `Infinity` means hacking earns nothing and every dollar has to
 * come from somewhere else — BN8. Used to decide how hard `stock` bids for money
 * and how much of the farm it may commandeer for manipulation. */
export function manipulationLeverage(mults: StockNodeMults | undefined): number {
  const gain = mults?.ScriptHackMoneyGain ?? 1;
  if (gain <= 0) return Infinity;
  return 1 / gain;
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
