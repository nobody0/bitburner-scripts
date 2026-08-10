/** Signal recovery from price history — what the market tells you for free.
 *
 * The market's tick loop leaks more than it means to, and two of those leaks are
 * worth real money:
 *
 * **The volatility roll is shared.** `const v = Math.random()` is drawn ONCE per
 * tick, outside the per-symbol loop, and every symbol moves by `v * mv / 100`.
 * So in a single tick the magnitudes of all 33 symbols are perfectly correlated
 * and differ only by their own `mv`. Divide one symbol's observed step by its
 * known `mv` range and you have `v`; divide every other symbol's step by that
 * `v` and you have its `mv` — measured, not guessed, WITHOUT 4S.
 *
 * **The sign is a Bernoulli draw on the forecast.** A tick goes up with
 * probability `chc = (50 +/- otlkMag) / 100`, which is exactly what
 * `getForecast()` returns. So the up-tick FREQUENCY is an unbiased estimator of
 * the forecast, again without 4S. An EWMA rather than a flat window because the
 * quantity being estimated is piecewise-constant: it holds steady for up to 75
 * ticks and then may invert, so recency has to win over sample size.
 *
 * **The cycle is periodic.** `ticksUntilCycle` is seeded once at `1..75` and
 * reset to exactly 75 afterwards, so after ONE observed cycle every future
 * regime change is known to the tick. A cycle flips bull/bear for ~45% of
 * symbols at once, and flipping bull/bear moves the absolute forecast from
 * `50 + otlkMag` to `50 - otlkMag` — a jump straight across 0.5. Counting
 * symbols that crossed 0.5 in one tick is therefore a near-exact detector, and
 * ~15 of 33 crossing at once cannot happen any other way.
 *
 * Pure and clock-free: the caller supplies the samples and the tick counter is
 * derived from the samples themselves, so this is directly unit-testable and
 * identical in the sim and the game. Deliberately idempotent under
 * oversampling — the price probe runs faster than the 6 s tick precisely so it
 * cannot MISS one, which means it will often see the same tick twice. */

/** Pinned source for the shared volatility draw, forecast probability, and
 * periodic cycle mechanics described above:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/StockMarket.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/Stock.ts */
import { midpoint, STOCK_METADATA } from "../../features/stocks.ts";
import { TICKS_PER_CYCLE } from "./market.ts";

/** EWMA weight for the forecast estimate. 0.08 gives a ~12-tick memory: fast
 *  enough to notice a cycle flip within a fraction of the 75-tick regime, slow
 *  enough that a run of four heads is not mistaken for an edge. */
export const FORECAST_ALPHA = 0.08;
/** EWMA weight for the measured volatility. Slower: `mv` NEVER changes within a
 *  BitNode, so the only reason to weight recency at all is to shake off the
 *  bootstrap estimate. */
export const VOLATILITY_ALPHA = 0.05;
/** Strength of the Beta(k,k) prior at 0.5. A forecast estimate is shrunk toward
 *  the coin flip by `n / (n + k)`, so it takes real evidence to claim an edge —
 *  the alternative is paying the spread on noise. */
export const FORECAST_PRIOR_STRENGTH = 25;
/** Symbols that must cross 0.5 in one tick to call a cycle boundary. With 33
 *  symbols at a 45% flip chance the mean is 14.9 and the standard deviation
 *  2.9, so 6 is ~3 sd below the mean and far above anything ordinary drift can
 *  produce (`otlkMag` moves ~0.04/tick). */
export const CYCLE_QUORUM = 6;

export interface SymbolHistory {
  /** Price at the last OBSERVED tick. */
  price: number;
  /** Ask/bid at the last observed tick, so the solver always prices a trade off
   *  the same snapshot it formed its opinion from. */
  ask: number;
  bid: number;
  /** Ticks in which this symbol was seen to move. */
  samples: number;
  /** EWMA of the up-tick indicator — the raw forecast estimate before shrinkage. */
  upRate: number;
  /** EWMA of the measured `mv / 100`, i.e. `getVolatility()`'s units. */
  volatility?: number;
  /** Forecast at the previous tick (4S only), for the 0.5-crossing detector. */
  lastForecast?: number;
  /** Direction of the last observed move: +1 up, -1 down. */
  lastMove: number;
}

export interface MarketHistory {
  /** Ticks observed since this history was created. Our own clock, in the
   *  market's own unit — the only one the cycle can be counted in, since wall
   *  time per tick varies with stored cycles. */
  tick: number;
  /** Our tick index at the last detected cycle boundary. */
  lastCycleTick?: number;
  /** How many boundaries we have seen. Two or more means the period is
   *  confirmed rather than inferred from a single event. */
  cyclesSeen: number;
  /** Symbols that crossed 0.5 at the last observed tick, for reporting. */
  lastFlipCount: number;
  /** The recovered common volatility roll of the last observed tick. */
  lastV?: number;
  symbols: Record<string, SymbolHistory>;
}

export function initHistory(): MarketHistory {
  return { tick: 0, cyclesSeen: 0, lastFlipCount: 0, symbols: {} };
}

export interface PriceSample {
  sym: string;
  ask: number;
  bid: number;
  /** 4S forecast, when the API is owned. */
  forecast?: number;
  /** 4S volatility, when the API is owned. Overrides the measurement. */
  volatility?: number;
}

/** Mid price. The market moves `Stock.price`; ask and bid are that price with
 *  the spread applied symmetrically, so their mean recovers it exactly. */
export function midPrice(sample: { ask: number; bid: number }): number {
  return (sample.ask + sample.bid) / 2;
}

/** Fold one sample of the whole market into the history.
 *
 * Returns whether a NEW tick was observed. A sample where no price moved is the
 * same tick seen twice and changes nothing — which is what makes it safe to
 * sample faster than the market updates. */
export function observeMarket(history: MarketHistory, samples: readonly PriceSample[]): boolean {
  const moved: { sample: PriceSample; price: number; step: number; up: boolean }[] = [];
  for (const sample of samples) {
    const price = midPrice(sample);
    if (!(price > 0)) continue;
    const prior = history.symbols[sample.sym];
    if (!prior) {
      history.symbols[sample.sym] = {
        price,
        ask: sample.ask,
        bid: sample.bid,
        samples: 0,
        upRate: 0.5,
        lastMove: 0,
        ...(sample.volatility !== undefined ? { volatility: sample.volatility } : {}),
        ...(sample.forecast !== undefined ? { lastForecast: sample.forecast } : {}),
      };
      continue;
    }
    // The price is multiplied or divided by (1 + av), so the log step is the
    // symmetric measure: an up and a down of the same `av` are equal and
    // opposite in log space, which is what makes the shared-`v` inversion work.
    const ratio = price / prior.price;
    if (ratio === 1) continue;
    moved.push({ sample, price, step: Math.abs(Math.log(ratio)), up: ratio > 1 });
  }

  if (moved.length === 0) {
    // No movement: same tick. Still refresh quotes — the spread does not change
    // but a fresh ask/bid costs nothing and keeps the snapshot self-consistent.
    for (const sample of samples) {
      const entry = history.symbols[sample.sym];
      if (entry) {
        entry.ask = sample.ask;
        entry.bid = sample.bid;
      }
    }
    return false;
  }

  history.tick++;
  const v = recoverCommonRoll(history, moved);
  history.lastV = v;

  let flips = 0;
  for (const { sample, price, step, up } of moved) {
    const entry = history.symbols[sample.sym]!;
    entry.price = price;
    entry.ask = sample.ask;
    entry.bid = sample.bid;
    entry.samples++;
    entry.lastMove = up ? 1 : -1;
    entry.upRate = entry.upRate + FORECAST_ALPHA * ((up ? 1 : 0) - entry.upRate);

    // Measured volatility: step = ln(1 + v * mv/100)  =>  mv/100 = expm1(step)/v.
    // 4S, when present, is exact and simply wins.
    if (sample.volatility !== undefined) {
      entry.volatility = sample.volatility;
    } else if (v !== undefined && v > 0) {
      const measured = Math.expm1(step) / v;
      entry.volatility =
        entry.volatility === undefined ? measured : entry.volatility + VOLATILITY_ALPHA * (measured - entry.volatility);
    }

    if (sample.forecast !== undefined) {
      const previous = entry.lastForecast;
      // A bull/bear flip moves the forecast from 50+otlkMag to 50-otlkMag, so it
      // crosses 0.5. Ordinary drift moves ~0.0004/tick and effectively never
      // does, except for a symbol sitting exactly at neutral — hence the
      // magnitude floor, which keeps otlkMag~0 symbols out of the vote.
      if (previous !== undefined && Math.abs(previous - 0.5) > 0.01 && Math.abs(sample.forecast - 0.5) > 0.01) {
        if (previous > 0.5 !== sample.forecast > 0.5) flips++;
      }
      entry.lastForecast = sample.forecast;
    }
  }
  history.lastFlipCount = flips;

  if (flips >= CYCLE_QUORUM) {
    history.lastCycleTick = history.tick;
    history.cyclesSeen++;
  }
  return true;
}

/** Invert `step = ln(1 + v * mv/100)` across the basket to recover the tick's
 * shared roll.
 *
 * The median rather than the mean: a symbol whose price hit its soft cap had its
 * direction forced, and a symbol whose measured `mv` is still the metadata
 * midpoint carries up to ~12% of error. One robust statistic over 30-odd
 * estimates beats any single symbol. */
function recoverCommonRoll(
  history: MarketHistory,
  moved: readonly { sample: PriceSample; step: number }[],
): number | undefined {
  const estimates: number[] = [];
  for (const { sample, step } of moved) {
    const known = history.symbols[sample.sym]?.volatility ?? metadataVolatility(sample.sym);
    if (!(known > 0)) continue;
    const estimate = Math.expm1(step) / known;
    if (estimate > 0 && estimate <= 1.5) estimates.push(estimate);
  }
  if (estimates.length === 0) return undefined;
  estimates.sort((a, b) => a - b);
  const mid = estimates.length >> 1;
  const median = estimates.length % 2 === 1 ? estimates[mid]! : (estimates[mid - 1]! + estimates[mid]!) / 2;
  // v is a U(0,1) draw; an estimate outside that says the inputs are wrong, and
  // clamping is better than propagating a volatility measurement built on it.
  return Math.min(1, median);
}

function metadataVolatility(sym: string): number {
  const meta = STOCK_METADATA[sym];
  return meta ? midpoint(meta.mv) / 100 : 0;
}

/** The forecast we are willing to act on, and how much of it is evidence.
 *
 * Without 4S this is the shrunk up-tick frequency; with 4S it is the exact
 * value. The `confident` flag is what the solver gates on — an unshrunk
 * estimate off four samples would happily claim a 0.75 forecast, and paying the
 * spread on that is how an automated trader loses money while looking busy. */
export interface ForecastEstimate {
  forecast: number;
  volatility: number;
  /** True when 4S supplied the value outright. */
  exact: boolean;
  /** Enough evidence to open a position on. */
  confident: boolean;
  samples: number;
}

export function estimateSignal(history: MarketHistory, sym: string, exactForecast?: number): ForecastEstimate {
  const entry = history.symbols[sym];
  const volatility = entry?.volatility ?? metadataVolatility(sym);
  if (exactForecast !== undefined) {
    return { forecast: exactForecast, volatility, exact: true, confident: true, samples: entry?.samples ?? 0 };
  }
  if (!entry || entry.samples === 0) {
    return { forecast: 0.5, volatility, exact: false, confident: false, samples: 0 };
  }
  // Effective sample size of an EWMA saturates at 1/alpha, so evidence stops
  // accumulating however long we watch — which is correct, because the thing
  // being estimated changes every 75 ticks anyway.
  const effective = Math.min(entry.samples, 1 / FORECAST_ALPHA);
  const shrunk = 0.5 + (entry.upRate - 0.5) * (effective / (effective + FORECAST_PRIOR_STRENGTH));
  return {
    forecast: shrunk,
    volatility,
    exact: false,
    confident: entry.samples >= FORECAST_PRIOR_STRENGTH,
    samples: entry.samples,
  };
}

/** Ticks until the next regime change, or undefined until one has been seen.
 *
 * This is the position size limiter that matters: a long opened 3 ticks before a
 * cycle has a 45% chance of having its forecast inverted before it can clear the
 * spread, and no amount of edge fixes that. */
export function ticksUntilCycle(history: MarketHistory): number | undefined {
  if (history.lastCycleTick === undefined) return undefined;
  const elapsed = history.tick - history.lastCycleTick;
  const into = elapsed % TICKS_PER_CYCLE;
  return TICKS_PER_CYCLE - into;
}

/** Drop everything derived from a market that no longer exists. An augmentation
 *  install re-rolls every symbol (`prestigeAugmentation` -> `initStockMarket`),
 *  so a history that survived it describes prices, spreads and volatilities that
 *  were all thrown away. */
export function resetHistory(history: MarketHistory): void {
  history.tick = 0;
  delete history.lastCycleTick;
  history.cyclesSeen = 0;
  history.lastFlipCount = 0;
  delete history.lastV;
  history.symbols = {};
}
