/** Stock feature — BN8's theme. Problem: allocate capital across symbols from
 * forecast and volatility to maximise risk-adjusted return, given commission
 * and the 4S data cost decision. Isolated cleanly: the market ignores every
 * other feature. */

export interface StockPosition {
  sym: string;
  price: number;
  ask: number;
  bid: number;
  maxShares: number;
  /** [shares, avgPx, sharesShort, avgPxShort] from ns.stock.getPosition. */
  shares: number;
  avgPx: number;
  sharesShort: number;
  avgPxShort: number;
  /** Mark-to-market value of the held position at bid/ask. */
  value: number;
  costBasis: number;
}

/** 4S market data, keyed by symbol. Deliberately a SEPARATE field rather than
 * fields on StockPosition: the 4S probe runs half as often as the price probe
 * and cannot afford the position getters, so writing into `positions` would
 * replace real prices with signal-only stubs on every merge. */
export interface StockSignal {
  organization?: string;
  forecast?: number;
  volatility?: number;
}

export interface StockState {
  hasWseAccount: boolean;
  hasTixApiAccess: boolean;
  /** Owned by the `stock.forecast` probe — it is the only one that can tell
   *  whether 4S data answers. `stock.core` runs twice as often and must not
   *  write these, or the flags would flip on every merge. */
  has4SData?: boolean;
  has4SDataApi?: boolean;
  positions: StockPosition[];
  /** Symbol -> 4S signal. Owned solely by the `stock.forecast` probe. */
  signals?: Record<string, StockSignal>;
  portfolioValue: number;
  portfolioCost: number;
  /** Open limit/stop orders — 4S/BN8 only. */
  orders?: Record<string, { type: string; position: string; shares: number; price: number }[]>;
}
