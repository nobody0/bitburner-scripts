/** Stock feature — BN8's theme. Problem: allocate capital across symbols to
 * maximise money AT THE END OF THE RUN, given the spread, the commission, the
 * 75-tick regime cycle, and the fact that an augmentation install destroys every
 * open position outright.
 *
 * NOT isolated from the rest of the game, which is the interesting part:
 * `hack(host, {stock: true})` pushes a symbol down and `grow(host, {stock: true})`
 * pushes it up, so the market and the HWGW farm contend for the same targets.
 * `manipulation` below is that channel. */

export interface StockPosition {
  sym: string;
  price: number;
  /** Real quotes, not `price` twice: the round trip crosses the spread on both
   *  legs, which on a wide symbol costs 4% of notional against $200k of
   *  commission. Pricing a trade at the mid understates its cost by 10x-200x. */
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
 * fields on StockPosition: the 4S probe is gated on a different flag from the
 * price probe, so writing into `positions` would replace real prices with
 * signal-only stubs on every merge. */
export interface StockSignal {
  forecast?: number;
  volatility?: number;
}

/** What the price history has recovered, and where we are in the cycle.
 *
 * The cycle clock is the single most valuable derived number here: the market
 * flips ~45% of symbols' bull/bear state every 75 ticks EXACTLY, so once one
 * boundary has been observed every future regime change is known, and a position
 * can be sized to close before one lands. */
export interface StockMarketClock {
  /** Market ticks observed. Not wall time — the tick interval varies with the
   *  stored-cycle catch-up, and the cycle is counted in ticks. */
  tick: number;
  ticksUntilCycle?: number;
  cyclesSeen: number;
  /** Symbols whose forecast crossed 0.5 at the last tick. ~15 of 33 at once is
   *  a cycle boundary and cannot be anything else. */
  lastFlipCount: number;
  /** The recovered shared volatility roll of the last tick, in [0,1]. */
  lastV?: number;
}

export interface StockState {
  hasWseAccount: boolean;
  hasTixApiAccess: boolean;
  /** `has4SDataTixApi` — the only 4S flag a script can use. Probed directly at
   *  0.05 GB rather than inferred from whether `getForecast` threw, which
   *  conflated it with the useless $1b `has4SData`. */
  has4SData?: boolean;
  has4SDataApi?: boolean;
  /** Owned by `stock.tick`, which is gated on the TIX API — so a market we can
   *  see but not trade publishes the flags above and nothing else. Optional for
   *  that reason: the account probe runs unconditionally and creates the topic
   *  long before there is anything to put in these. */
  positions?: StockPosition[];
  /** Symbol -> 4S signal. Owned solely by the `stock.forecast` probe. */
  signals?: Record<string, StockSignal>;
  portfolioValue?: number;
  portfolioCost?: number;
  /** Open limit/stop orders — 4S/BN8 only. */
  orders?: Record<string, { type: string; position: string; shares: number; price: number }[]>;
  market?: StockMarketClock;
  /** hostname -> what the farm should do to that host's symbol, and what one
   *  influencing op is worth. Read by `hacking`; see spec/targeting.md. */
  manipulation?: Record<string, StockManipulation>;
  /** The decision digest. */
  plan?: StockPlan;
}

export interface StockManipulation {
  sym: string;
  side: "long" | "short";
  /** Dollars of stock profit one `{stock: true}` op is worth at a steal fraction
   *  of 1. `hacking` scales by its own solved steal fraction. */
  valuePerOp: number;
  notional: number;
}

/** The decision digest: what was traded and what was ranked. Candidate edge,
 * spread, horizon and affordability expose a hold without narration. */
export interface StockPlan {
  actions: { type: string; sym?: string; shares?: number; short?: boolean; cost?: number }[];
  ranked: {
    sym: string;
    side: string;
    forecast: number;
    volatility: number;
    /** From 4S rather than estimated from price history. */
    exact: boolean;
    breakEvenTicks: number;
    expectedProfit: number;
  }[];
  entry?: {
    sym: string;
    side: string;
    shares: number;
    cost: number;
    expectedProfit: number;
    holdTicks: number;
    breakEvenTicks: number;
  };
  unlock?: { type: string; cost: number; gainPerSec: number; paybackSec: number; netOverHorizon: number };
  /** Nothing held, nothing pending, nothing wanted. `progression` reads THIS as
   *  its install barrier rather than scanning `positions`: a snapshot says nothing
   *  about intent, and a position about to be opened or an exit not yet executed
   *  are both invisible in it. Owned by this feature, like factions.recommendInstall. */
  flat: boolean;
  /** True while the book is being converted to cash for an imminent install — NOT
   *  merely while `progression` is in its `ending` phase, which is an economic test
   *  that can hold for an entire run. */
  liquidate?: boolean;
  /** Something outside our control: no WSE account, 4S disabled by the node's
   *  options, shorts without SF8.2. Distinct from `hold`, which is a choice. */
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}
