/** Stock feature — BN8's theme. Problem: allocate capital across symbols from
 * forecast and volatility to maximise risk-adjusted return, given commission
 * and the 4S data cost decision. Isolated cleanly: the market ignores every
 * other feature. */

export interface StockPosition {
  sym: string;
  organization?: string;
  price: number;
  ask: number;
  bid: number;
  maxShares: number;
  /** [shares, avgPx, sharesShort, avgPxShort] from ns.stock.getPosition. */
  shares: number;
  avgPx: number;
  sharesShort: number;
  avgPxShort: number;
  /** 4S-only; undefined without market data access. */
  forecast?: number;
  volatility?: number;
  /** Mark-to-market value of the held position at bid/ask. */
  value: number;
  costBasis: number;
}

export interface StockState {
  hasWseAccount: boolean;
  hasTixApiAccess: boolean;
  has4SData: boolean;
  has4SDataApi: boolean;
  positions: StockPosition[];
  portfolioValue: number;
  portfolioCost: number;
  /** Open limit/stop orders — 4S/BN8 only. */
  orders?: Record<string, { type: string; position: string; shares: number; price: number }[]>;
}
