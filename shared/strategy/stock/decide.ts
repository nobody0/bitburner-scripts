/** Stock market allocation.
 *
 * Objective: maximise risk-adjusted return NET of the $100k per-transaction
 * commission and the 4S data cost. The commission is what makes this a real
 * problem rather than a ranking — it is charged on BOTH the buy and the sell,
 * so a $200k round trip has to clear $200k of edge before it earns a cent, and
 * a naive "buy everything above 0.5 forecast" strategy loses money steadily
 * while looking busy.
 *
 * Two decisions, not one:
 *  1. **Whether to buy 4S at all.** Without it there is no forecast, so the
 *     only signal is price history. 4S costs $1b (data) + $25b (API) and is
 *     evaluated as an investment against the remaining horizon, exactly like a
 *     hacknet upgrade.
 *  2. **What to hold**, given whichever signal is available. */

/** Commission per transaction @ v3.0.1 (CONSTANTS.StockMarketCommission). */
export const COMMISSION = 100_000;
/** 4S Market Data costs (src/StockMarket/StockMarket.tsx @ v3.0.1). */
export const FOUR_SIGMA_DATA_COST = 1e9;
export const FOUR_SIGMA_API_COST = 25e9;

export interface StockPosition {
  sym: string;
  price: number;
  ask: number;
  bid: number;
  maxShares: number;
  shares: number;
  avgPx: number;
  sharesShort: number;
  avgPxShort: number;
}

export interface StockSignal {
  /** Probability the next tick is up. 0.5 is no information. Needs 4S. */
  forecast: number;
  /** Per-tick price movement magnitude. Needs 4S. */
  volatility: number;
}

export interface StockView {
  positions: StockPosition[];
  /** Symbol -> signal. Empty without 4S. */
  signals: Record<string, StockSignal>;
  has4SData: boolean;
  has4SDataApi: boolean;
  hasTixApi: boolean;
  /** Money the arbiter granted this feature. */
  moneyGranted: number;
  /** Total liquid money, for the 4S investment decision. */
  totalMoney: number;
  /** Seconds left in the run, to amortise 4S against. */
  horizonSec: number;
  /** Measured money per second from everything else, so the 4S decision can
   *  compare "buy data" against "keep the cash working". */
  incomePerSec: number;
}

export type StockAction =
  | { type: "hold"; why: string }
  | { type: "buy4SData"; cost: number; why: string }
  | { type: "buy4SApi"; cost: number; why: string }
  | { type: "buy"; sym: string; shares: number; short: boolean; why: string }
  | { type: "sell"; sym: string; shares: number; short: boolean; why: string };

export interface StockDecision {
  actions: StockAction[];
  /** Every symbol scored, best edge first. */
  ranked: { sym: string; edge: number; expectedGain: number; why: string }[];
  /** Why the feature is doing nothing, when it is. */
  hold?: string;
  why: string;
}

/** Expected per-tick return of a long position.
 *
 * `forecast` is P(up); the expected move is `(2·forecast − 1)·volatility`.
 * At forecast 0.5 that is exactly zero, which is the point: no information
 * means no edge, and a strategy that bought anyway would pay commission for
 * a coin flip. */
export function edge(signal: StockSignal, short: boolean): number {
  const raw = (2 * signal.forecast - 1) * signal.volatility;
  return short ? -raw : raw;
}

/** Minimum position size that can clear the round trip.
 *
 * Both the buy and the sell are charged, so the position must move by
 * `2 · COMMISSION` before it breaks even. Ignoring this is the single most
 * common way an automated trader loses money while appearing to work. */
export function minProfitableShares(price: number, edgePerTick: number, ticksHeld: number): number {
  const gainPerShare = edgePerTick * price * ticksHeld;
  if (gainPerShare <= 0) return Infinity;
  return (2 * COMMISSION) / gainPerShare;
}

/** Is 4S worth buying?
 *
 * Treated as an investment: the data unlocks a forecast, the forecast is worth
 * some return per second, and the question is whether that return repays the
 * cost before the run ends. With no measured forecast performance yet, the
 * conservative estimate is the fraction of current income it could add. */
export function evaluate4S(view: StockView): { buy: boolean; why: string; cost: number } {
  if (view.has4SData) return { buy: false, why: "already owned", cost: 0 };
  const cost = FOUR_SIGMA_DATA_COST;
  if (view.totalMoney < cost * 2) {
    // Spending half the bankroll on data leaves nothing to trade with, which
    // is how the purchase becomes worthless the moment it completes.
    return { buy: false, why: `needs $${(cost * 2).toExponential(1)} to buy data AND still have capital`, cost };
  }
  // A forecast typically converts a coin flip into a small positive edge. Even
  // a conservative 1% of holdings per hour has to beat the horizon.
  const estimatedGainPerSec = view.totalMoney * 0.01 / 3600;
  const net = estimatedGainPerSec * view.horizonSec - cost;
  return net > 0
    ? { buy: true, why: `4S data nets ~$${Math.round(net).toLocaleString()} over the remaining horizon`, cost }
    : { buy: false, why: `4S data would not repay $${cost.toExponential(1)} in ${Math.round(view.horizonSec)}s`, cost };
}

export function stepStock(view: StockView): StockDecision {
  const actions: StockAction[] = [];
  const ranked: StockDecision["ranked"] = [];

  if (!view.hasTixApi) {
    return {
      actions,
      ranked,
      why: "no TIX API",
      hold: "positions need TIX API access; the WSE account alone only shows prices",
    };
  }

  // Without a forecast there is no edge to trade on, and paying $200k a round
  // trip to guess is strictly worse than holding cash. So the ONLY decision
  // available is whether to buy the data.
  if (!view.has4SData) {
    const verdict = evaluate4S(view);
    if (verdict.buy && verdict.cost <= view.moneyGranted) {
      actions.push({ type: "buy4SData", cost: verdict.cost, why: verdict.why });
      return { actions, ranked, why: verdict.why };
    }
    return {
      actions,
      ranked,
      why: "no forecast available",
      hold: `${verdict.why} — trading without a forecast pays $${(2 * COMMISSION).toLocaleString()} per round trip to guess`,
    };
  }

  // Rank every symbol by its edge.
  for (const position of view.positions) {
    const signal = view.signals[position.sym];
    if (!signal) continue;
    const longEdge = edge(signal, false);
    const short = longEdge < 0;
    const best = Math.abs(longEdge);
    ranked.push({
      sym: position.sym,
      edge: short ? -best : best,
      expectedGain: best * position.price,
      why: `forecast ${signal.forecast.toFixed(3)}, volatility ${signal.volatility.toFixed(4)}`,
    });
  }
  ranked.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge) || (a.sym < b.sym ? -1 : 1));

  // Exit anything whose edge has turned against the position we hold.
  for (const position of view.positions) {
    const signal = view.signals[position.sym];
    if (!signal) continue;
    const longEdge = edge(signal, false);
    if (position.shares > 0 && longEdge <= 0) {
      actions.push({
        type: "sell",
        sym: position.sym,
        shares: position.shares,
        short: false,
        why: `forecast turned against a long (${signal.forecast.toFixed(3)})`,
      });
    }
    if (position.sharesShort > 0 && longEdge >= 0) {
      actions.push({
        type: "sell",
        sym: position.sym,
        shares: position.sharesShort,
        short: true,
        why: `forecast turned against a short (${signal.forecast.toFixed(3)})`,
      });
    }
  }

  // Enter the best remaining opportunity, if it clears the commission.
  const budget = view.moneyGranted;
  for (const entry of ranked) {
    if (budget <= 0) break;
    const position = view.positions.find((p) => p.sym === entry.sym)!;
    const short = entry.edge < 0;
    const held = short ? position.sharesShort : position.shares;
    if (held > 0) continue; // already in it
    const price = short ? position.bid : position.ask;
    if (price <= 0) continue;

    // Held long enough to matter: a position is re-evaluated every tick, so
    // assume a conservative 10-tick hold when sizing against commission.
    const minShares = minProfitableShares(price, Math.abs(entry.edge), 10);
    const affordable = Math.floor((budget - COMMISSION) / price);
    const shares = Math.min(affordable, position.maxShares - held);
    if (!Number.isFinite(minShares) || shares < minShares || shares <= 0) continue;

    actions.push({
      type: "buy",
      sym: entry.sym,
      shares,
      short,
      why: `${short ? "short" : "long"} edge ${Math.abs(entry.edge).toExponential(2)}/tick, ${shares} shares clears the $${(2 * COMMISSION).toLocaleString()} round trip`,
    });
    break; // one entry per tick, so each is re-evaluated against fresh prices
  }

  if (actions.length === 0) {
    return {
      actions,
      ranked,
      why: "no position worth taking",
      hold:
        ranked.length > 0
          ? `best edge ${Math.abs(ranked[0]!.edge).toExponential(2)}/tick does not clear the $${(2 * COMMISSION).toLocaleString()} round trip`
          : "no forecast data for any symbol",
    };
  }
  return { actions, ranked, why: `${actions.length} action(s)` };
}
