import { formatMoney } from "../../format.ts";

/** The stock market solver.
 *
 * Objective: maximise money at the end of the RUN, not at the end of the
 * position. Those differ, and the difference is the whole shape of this file:
 *
 *  - **An augmentation install destroys the portfolio.** `prestigeAugmentation`
 *    calls `initStockMarket`, which replaces every `Stock` object — shares go to
 *    zero and no money is credited (the game's own install warning lists
 *    "Stocks"). Cash is wiped too, so the only way stock value survives is to be
 *    spent on augmentations BEFORE the install. A position is therefore capital
 *    that must be liquid again by the time `progression` wants to reset, and its
 *    horizon is the INSTALL, not the BitNode.
 *  - **The unlocks survive an install.** `hasWseAccount`, `hasTixApiAccess` and
 *    `has4SDataTixApi` are never cleared by `prestigeAugmentation`; only a
 *    BitNode reset clears them. So they amortize over the whole NODE. Two
 *    different horizons, pulling in opposite directions, and the old single
 *    `horizonSec` was wrong for both.
 *  - **There is no reason to trade on a short horizon.** Every round trip pays
 *    `2 x spreadPerc%` of notional plus $200k, and the expected drift needed to
 *    clear that takes a knowable number of ticks ({@link breakEvenTicks}). If
 *    the horizon is shorter than that number, the trade is a guaranteed loss and
 *    the answer is to hold cash.
 *
 * The signal model lives in ./market.ts (how prices move) and ./history.ts (how
 * to recover volatility and estimate forecast from prices, plus the cycle clock
 * after 4S exposes a boundary). This file spends money.
 *
 * Pure: no clock, no randomness, no ns. `stepStock` returns a PLAN, sized at
 * full ambition and independent of what the arbiter granted; {@link fundedActions}
 * narrows it to what the grant pays for. That split is deliberate — deriving the
 * plan FROM the grant is circular (no plan means no claim means no grant means
 * no plan), which is exactly how the previous version deadlocked and never
 * placed a single trade. */

/** Pinned sources for prestige survival, market access, transactions, and
 * short-sale gates described by this solver:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Prestige.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/StockMarket.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/StockMarket.ts */
import { midpoint, STOCK_METADATA, worstSpreadFraction } from "../../features/stocks.ts";
import {
  breakEvenTicks,
  COMMISSION,
  CYCLE_FLIP_CHANCE,
  effectiveForecast,
  expectedProfit,
  favouredSide,
  manipulationValuePerOp,
  meanLogStep,
  secondsForTicks,
  sideDriftPerTick,
  TICKS_PER_CYCLE,
  ticksInSeconds,
  unlockCosts,
  type PositionSide,
  type StockNodeMults,
  type UnlockCosts,
} from "./market.ts";
import {
  estimateSignal,
  initHistory,
  observeMarket,
  ticksUntilCycle,
  type MarketHistory,
  type PriceSample,
} from "./history.ts";

// --- tuning -----------------------------------------------------------------

/** Stock does not reserve a fixed share of cash. It prices the best available
 * position at full ambition and lets the shared money arbiter compare that
 * marginal return with every other investment. Public `maxShares`, available
 * cash, transaction costs and the profitability gates below are the limits. */
/** Forecast distance from 0.5 required to OPEN a position. 0.6 for a long,
 *  matching the threshold the predecessor scripts settled on
 *  (`bitburner-2023/src/main.ts:761`) — a wide band is what stops the estimator's
 *  noise from paying the spread. */
export const ENTER_BAND = 0.09;
/** Forecast distance required to KEEP one. Narrower than ENTER_BAND on purpose:
 *  the gap is the hysteresis that stops a symbol oscillating around 0.5 from
 *  churning two commissions and two spread crossings per tick. */
export const EXIT_BAND = 0.005;
/** Ticks a fresh position is protected from reversal, however the forecast
 *  moves. Manipulation needs time to accumulate nudges, and a signal that
 *  flipped one tick after we bought is far more likely to be noise than a
 *  regime change. */
export const MIN_HOLD_TICKS = 10;
/** Safety margin on the achievable hold: a position must clear its round trip
 *  with this much room to spare, not exactly at the buzzer. */
export const BREAK_EVEN_MARGIN = 1.5;
/** Forecast deviation to assume when pricing an unlock that cannot be evaluated
 *  from live data yet (no TIX API means no `getSymbols`, so the market is
 *  entirely invisible). Deliberately meek — 0.55 is a quarter of what a good 4S
 *  symbol offers, so an unlock that clears this bar clears it comfortably. */
export const BLIND_FORECAST = 0.55;

// --- view -------------------------------------------------------------------

export interface StockSymbolView {
  sym: string;
  ask: number;
  bid: number;
  maxShares: number;
  shares: number;
  avgPx: number;
  sharesShort: number;
  avgPxShort: number;
  /** 4S forecast, present only with `has4SApi`. */
  forecast?: number;
  /** 4S volatility, present only with `has4SApi`. */
  volatility?: number;
}

export interface StockView {
  symbols: StockSymbolView[];

  hasWseAccount: boolean;
  hasTixApi: boolean;
  /** `has4SDataTixApi` — the ONLY 4S flag that matters to a script. */
  has4SApi: boolean;
  /** Shorts need BN8 or SF8.2. Emitting a short without this throws. */
  canShort: boolean;
  /** `bitNodeOptions.disable4SData`: the forecast cannot be bought at all. */
  fourSigmaDisabled: boolean;
  /** Hostnames the farm can currently drive: rooted, worth money, and within
   *  reach of the player's hacking skill. Empty means a held position cannot
   *  be manipulated yet. */
  farmableHosts: readonly string[];
  /** Hostname -> symbol, derived in the game from public
   * `stock.getOrganization` plus each server's public organization name. */
  symbolByHost: Readonly<Record<string, string>>;

  /** `FourSigmaMarketData*Cost` scale the unlock; `ScriptHackMoney*` scale what
   *  manipulation is worth against hacking. See market.ts#StockNodeMults. */
  nodeMults?: StockNodeMults;

  /** What the arbiter granted this pass. Used ONLY by fundedActions. */
  moneyGranted: number;
  /** Liquid cash. */
  totalMoney: number;
  /** Mark-to-market value of what is already held. */
  portfolioValue: number;

  /** Seconds until the next augmentation install is expected — the life of a
   *  POSITION, because an install zeroes it. */
  positionHorizonSec: number;
  /** Seconds until the BitNode is expected to end — the life of an UNLOCK,
   *  because WSE/TIX/4S survive installs. */
  unlockHorizonSec: number;
  /** progression wants the book flat: reset imminent. Overrides everything. */
  liquidate: boolean;
  /** Why, for the digest. */
  liquidateWhy?: string;

  // No `incomePerSec` here, deliberately. An unlock's opportunity cost — what the
  // cash would earn elsewhere — is not this feature's judgement to make: the
  // arbiter compares `income:investment` claims by `returnPerDollarSec`, so
  // hacknet, home RAM and the 4S API are ranked against each other on one scale.
  // Folding a guess at that comparison in here would double-count it.
}

// --- memory -----------------------------------------------------------------

export interface StockMemory {
  history: MarketHistory;
  /** sym -> the side we committed to and the market tick we committed at. The
   *  point of persisting this is that manipulation is SLOW: nudges accumulate at
   *  0.1 per influencing op on a 0..100 scale, so a controller that re-derives
   *  its direction from scratch every 5 s would thrash the position and never
   *  let the manipulation converge. The predecessor scripts got this right with
   *  a sticky `wantedPosType` (`bitburner-2023/src/main.ts:694`) and it is the
   *  one design of theirs worth keeping verbatim. */
  intent: Record<string, { side: PositionSide; sinceTick: number }>;
}

export function initStockMemory(): StockMemory {
  return { history: initHistory(), intent: {} };
}

/** Full liquid cash offered to the shared investment arbiter. */
export function positionBudget(view: Pick<StockView, "totalMoney">): number {
  return Math.max(0, view.totalMoney);
}

// --- plan -------------------------------------------------------------------

export type StockAction =
  | { type: "buyWse"; cost: number; why: string }
  | { type: "buyTix"; cost: number; why: string }
  | { type: "buy4SApi"; cost: number; why: string }
  | { type: "buy"; sym: string; shares: number; short: boolean; why: string }
  | { type: "sell"; sym: string; shares: number; short: boolean; why: string };

export interface RankedSymbol {
  sym: string;
  side: PositionSide;
  forecast: number;
  volatility: number;
  /** Exact (4S) or estimated from price history. */
  exact: boolean;
  /** Expected log return per tick on the favoured side. */
  drift: number;
  /** The farm can drive at least one of this symbol's hosts, so a position in it
   *  can be pushed rather than merely waited on. */
  manipulable: boolean;
  /** Ticks this position needs to clear its round trip. */
  breakEvenTicks: number;
  /** Expected $ over the achievable hold, net of commission and spread. */
  expectedProfit: number;
  /** Notional we would deploy. */
  notional: number;
  why: string;
}

export interface PositionTarget {
  sym: string;
  side: PositionSide;
  /** Shares at full ambition — what unlimited money would buy. Divisible. */
  shares: number;
  /** Cash for those shares, commission included. */
  cost: number;
  expectedProfit: number;
  /** EXPECTED hold, including the geometric tail of surviving cycle boundaries.
   *  What `expectedProfit` was integrated over. */
  holdTicks: number;
  /** GUARANTEED hold — this regime's remaining ticks, or the horizon. What the
   *  break-even gate must clear, and what a partially funded entry is re-checked
   *  against. */
  guaranteedTicks: number;
  breakEvenTicks: number;
  /** The quotes and signal the target was priced from, carried so a partially
   *  funded entry can be RE-priced at its smaller size rather than assumed to
   *  scale. It does not scale: commission is fixed, so cutting a position to a
   *  quarter pays the same $200k against a quarter of the drift. */
  ask: number;
  bid: number;
  forecast: number;
  volatility: number;
  why: string;
}

export interface UnlockPurchase {
  action: StockAction;
  /** Cash this action spends now. */
  cost: number;
  /** Full capital required to realize the quoted gain. For WSE this includes
   * the still-unbought TIX API; advertising the pair's gain against WSE's
   * $200m action cost would overstate its ROI by 26x in the shared arbiter. */
  investmentCost: number;
  /** $/sec the unlock is expected to add. */
  gainPerSec: number;
  paybackSec: number;
  netOverHorizon: number;
  why: string;
}

/** What we want the farm to do to a symbol's price, and what that is worth.
 *
 * `hacking` reads this to price manipulation into its `$/GB/sec` target score
 * and to set `stock: true` on the right op. The direction is not symmetric:
 * `hack` lowers the second-order forecast and `grow` raises it, so a LONG is
 * driven by grows and a SHORT by hacks. Setting the flag on both sides of an
 * HWGW batch would cancel out — the hack takes what the grow puts back, so the
 * two nudges are equal and opposite. */
export interface ManipulationIntent {
  sym: string;
  hostname: string;
  side: PositionSide;
  /** Dollars of stock profit one influencing op is worth, at the position size
   *  we can actually fund and the hold we can actually achieve. */
  valuePerOp: number;
  /** Notional the value is measured against. */
  notional: number;
  why: string;
}

export interface StockPlan {
  /** Exits. Need no money, so they are never gated on a grant. */
  exits: StockAction[];
  /** The single next unlock worth buying, cheapest-first up the ladder. */
  unlock?: UnlockPurchase;
  /** The position to open, at full ambition. */
  entry?: PositionTarget;
  ranked: RankedSymbol[];
  /** hostname -> manipulation intent, for the hacking evaluator. */
  manipulation: ManipulationIntent[];
  /** Ticks until the next regime change, once one has been observed. */
  ticksUntilCycle?: number;
  /** Market ticks observed. Below FORECAST_PRIOR_STRENGTH the no-4S estimator
   *  has no opinion yet, and saying so beats trading on four samples. */
  observedTicks: number;
  /** Nothing held, nothing pending, nothing wanted — the market's own answer to
   * "may an augmentation install destroy the book without losing anything?".
   *
   * This feature OWNS that answer, the same way `factions` owns
   * `recommendInstall`. `progression` reading a raw position array instead would
   * be inferring readiness from a snapshot that says nothing about intent: a
   * position we are about to open on the next pass, or an exit we decided on and
   * have not yet been granted the RAM to execute, are both invisible in it and
   * both mean the book is not flat.
   *
   * All three conditions are necessary:
   *  - no shares on either side of any symbol;
   *  - no exits outstanding in this plan;
   *  - no entry wanted. In the `ending` phase there never is, but publishing
   *    "flat" while still intending to buy would let an install land on a
   *    position opened one pass later. */
  flat: boolean;
  why: string;
  /** Set when the feature is deliberately doing nothing. A stock feature that
   *  holds because no edge clears the spread is WORKING. */
  hold?: string;
  /** Set when something outside our control stops us: no WSE account, 4S
   *  disabled by the node's options, shorts unavailable. */
  blocker?: string;
}

export interface StockDecision {
  plan: StockPlan;
  memory: StockMemory;
}

// --- the solver -------------------------------------------------------------

export function stepStock(view: StockView, memory: StockMemory): StockDecision {
  const costs = unlockCosts(view.nodeMults);

  if (!view.hasWseAccount) {
    return blocked(memory, unlockLadder(view, costs), "no WSE account — the market is invisible");
  }
  if (!view.hasTixApi) {
    return blocked(memory, unlockLadder(view, costs), "no TIX API — prices are visible but positions are not");
  }

  // Fold the sample into history first: the forecast estimator and measured
  // volatility come from prices, while 4S samples can additionally establish
  // the periodic cycle clock.
  observeMarket(memory.history, view.symbols.map(toSample));
  const cycleTicks = ticksUntilCycle(memory.history);
  const observedTicks = memory.history.tick;

  // Two different hold lengths, because two different questions are being asked.
  //
  // GUARANTEED: how long the current regime is certain to last. Bounded by the
  // install (which zeroes the position) and by the next cycle boundary, where
  // this symbol has a 45% chance of having its forecast inverted. This is what
  // the break-even gate is measured against — a position that only clears its
  // round trip on the far side of a coin flip has not cleared it.
  //
  // EXPECTED: how long it will actually be held. A cycle boundary is not an exit;
  // it is a 45% chance of one. Surviving it buys another full cycle, and
  // surviving that another, so the expectation adds a geometric tail of
  // `survival / (1 - survival)` cycles. Truncating the profit estimate at the
  // next boundary understates a good position by roughly half and is what made
  // the solver refuse trades a naive threshold rule was right to take.
  const horizonTicks = ticksInSeconds(view.positionHorizonSec);
  // Cycle phase unknown (no boundary observed yet — without 4S the flip
  // detector never fires, so this is the no-4S steady state): the next
  // boundary is uniformly distributed over the cycle, so claim only the
  // EXPECTED distance to it, not the full cycle. Claiming all 75 ticks lets
  // the break-even gate open positions one tick before a 45% coin flip — the
  // exact trade it exists to refuse.
  const regimeTicks = cycleTicks ?? (TICKS_PER_CYCLE + 1) / 2;
  const guaranteedTicks = Math.max(0, Math.min(horizonTicks, regimeTicks));
  const survival = 1 - CYCLE_FLIP_CHANCE;
  const tail = (survival / (1 - survival)) * TICKS_PER_CYCLE;
  const holdTicks = Math.max(0, Math.min(horizonTicks, guaranteedTicks + tail));

  const farmable = new Set(view.farmableHosts);
  const ranked: RankedSymbol[] = [];
  const perSymbol = new Map<string, { view: StockSymbolView; ranked: RankedSymbol }>();
  const cashBudget = positionBudget(view);

  for (const symbol of view.symbols) {
    const signal = estimateSignal(memory.history, symbol.sym, symbol.forecast);
    const side = favouredSide(signal.forecast);
    const entry = rankSymbol({ symbol, signal, side, holdTicks, cashBudget, farmable, symbolByHost: view.symbolByHost });
    ranked.push(entry);
    perSymbol.set(symbol.sym, { view: symbol, ranked: entry });
  }
  // Ranked by RETURN ON CAPITAL, not by absolute profit.
  //
  // Capital is allocated by the arbiter, so rank the claim by return on each
  // dollar requested. Absolute profit is the tie-break, and the symbol name the
  // final one, so the order is total.
  ranked.sort(
    (a, b) =>
      returnOnCapital(b) - returnOnCapital(a) ||
      b.expectedProfit - a.expectedProfit ||
      (a.sym < b.sym ? -1 : 1),
  );
  const exits = planExits(view, memory, perSymbol, guaranteedTicks);
  const held = view.symbols.filter((s) => s.shares > 0 || s.sharesShort > 0);
  const exiting = new Set(exits.map((action) => (action as { sym: string }).sym));

  // Liquidation is absolute. There is no reason to hold an asset past an
  // install: the shares are destroyed and the money is reset, so anything not
  // converted to augmentations first is simply lost.
  if (view.liquidate) {
    return {
      memory: forgetIntent(memory, held.map((s) => s.sym)),
      plan: {
        exits,
        ranked,
        manipulation: [],
        ...(cycleTicks !== undefined ? { ticksUntilCycle: cycleTicks } : {}),
        observedTicks,
        flat: held.length === 0 && exits.length === 0,
        why: exits.length > 0 ? `liquidating ${exits.length} position(s)` : "flat",
        hold: view.liquidateWhy ?? "an install is imminent; the portfolio must be cash before it lands",
      },
    };
  }

  const entry = planEntry({
    view,
    memory,
    ranked,
    perSymbol,
    holdTicks,
    guaranteedTicks,
    exiting,
    cashBudget,
  });
  if (entry) {
    memory.intent[entry.sym] = { side: entry.side, sinceTick: memory.history.tick };
  }

  const unlock = unlockLadder(view, costs, ranked, holdTicks);
  const manipulation = planManipulation({ view, perSymbol, holdTicks, exiting });

  const actions = exits.length + (entry ? 1 : 0) + (unlock ? 1 : 0);
  const best = ranked[0];
  return {
    memory,
    plan: {
      exits,
      ...(unlock ? { unlock } : {}),
      ...(entry ? { entry } : {}),
      ranked,
      manipulation,
      ...(cycleTicks !== undefined ? { ticksUntilCycle: cycleTicks } : {}),
      observedTicks,
      flat: held.length === 0 && exits.length === 0 && entry === undefined,
      why: actions > 0 ? `${actions} action(s)` : "holding",
      ...(actions === 0 ? { hold: holdReason(view, best, guaranteedTicks, observedTicks) } : {}),
      ...(!view.canShort && best && best.side === "short"
        ? { blocker: "the best edge is a short, and shorts need BN8 or SF8.2" }
        : {}),
    },
  };
}

/** Expected profit per dollar deployed. Zero notional means nothing can be
 *  deployed, which is worth nothing however good the forecast. */
function returnOnCapital(entry: RankedSymbol): number {
  return entry.notional > 0 ? entry.expectedProfit / entry.notional : -Infinity;
}

function toSample(symbol: StockSymbolView): PriceSample {
  return {
    sym: symbol.sym,
    ask: symbol.ask,
    bid: symbol.bid,
    ...(symbol.forecast !== undefined ? { forecast: symbol.forecast } : {}),
    ...(symbol.volatility !== undefined ? { volatility: symbol.volatility } : {}),
  };
}

function blocked(memory: StockMemory, unlock: UnlockPurchase | undefined, blocker: string): StockDecision {
  return {
    memory,
    plan: {
      exits: [],
      ...(unlock ? { unlock } : {}),
      ranked: [],
      manipulation: [],
      observedTicks: memory.history.tick,
      flat: true,
      why: unlock ? unlock.why : "locked",
      blocker,
    },
  };
}

function forgetIntent(memory: StockMemory, symbols: readonly string[]): StockMemory {
  for (const sym of symbols) delete memory.intent[sym];
  return memory;
}

// --- ranking ----------------------------------------------------------------

function rankSymbol(params: {
  symbol: StockSymbolView;
  signal: { forecast: number; volatility: number; exact: boolean; samples: number };
  side: PositionSide;
  holdTicks: number;
  cashBudget: number;
  farmable: ReadonlySet<string>;
  symbolByHost: Readonly<Record<string, string>>;
}): RankedSymbol {
  const { symbol, signal, side, holdTicks, cashBudget, farmable, symbolByHost } = params;
  const price = side === "short" ? symbol.bid : symbol.ask;
  const held = symbol.shares + symbol.sharesShort;
  const room = Math.max(0, symbol.maxShares - held);
  const affordable = price > 0 ? Math.floor(Math.max(0, cashBudget - COMMISSION) / price) : 0;
  const shares = Math.min(room, affordable);
  const meta = STOCK_METADATA[symbol.sym];
  const shareTx = meta ? midpoint(meta.shareTxForMovement) : Infinity;

  // The forecast the position will actually experience: a large trade drags the
  // outlook back toward neutral, so the quoted forecast is not the one we get.
  const forecast = effectiveForecast(signal.forecast, shares, shareTx);
  const drift = sideDriftPerTick(forecast, signal.volatility, side);
  const be = breakEvenTicks({
    shares,
    ask: symbol.ask,
    bid: symbol.bid,
    forecast,
    volatility: signal.volatility,
    side,
  });
  const profit = expectedProfit({
    shares,
    ask: symbol.ask,
    bid: symbol.bid,
    forecast,
    volatility: signal.volatility,
    side,
    ticks: holdTicks,
  });
  return {
    sym: symbol.sym,
    side,
    forecast: signal.forecast,
    volatility: signal.volatility,
    exact: signal.exact,
    drift,
    manipulable: Object.entries(symbolByHost).some(([host, sym]) => sym === symbol.sym && farmable.has(host)),
    breakEvenTicks: be,
    expectedProfit: profit,
    notional: shares * price,
    why: signal.exact
      ? `4S forecast ${signal.forecast.toFixed(3)}, volatility ${signal.volatility.toFixed(4)}`
      : `estimated ${signal.forecast.toFixed(3)} from ${signal.samples} ticks, volatility ${signal.volatility.toFixed(4)}`,
  };
}

// --- exits ------------------------------------------------------------------

function planExits(
  view: StockView,
  memory: StockMemory,
  perSymbol: Map<string, { view: StockSymbolView; ranked: RankedSymbol }>,
  holdTicks: number,
): StockAction[] {
  const exits: StockAction[] = [];
  for (const symbol of view.symbols) {
    const long = symbol.shares;
    const short = symbol.sharesShort;
    if (long <= 0 && short <= 0) continue;
    const entry = perSymbol.get(symbol.sym);
    const forecast = entry?.ranked.forecast ?? 0.5;
    const committed = memory.intent[symbol.sym];
    const heldTicks = committed ? memory.history.tick - committed.sinceTick : Infinity;

    if (view.liquidate) {
      if (long > 0) exits.push(sell(symbol.sym, long, false, "liquidating before the install"));
      if (short > 0) exits.push(sell(symbol.sym, short, true, "liquidating before the install"));
      continue;
    }

    // The horizon closing is a reason to sell that has nothing to do with the
    // forecast: if what is left cannot clear the round trip, every further tick
    // held is risk taken for a payoff that can no longer arrive.
    const stranded = holdTicks <= 0;
    if (stranded) {
      if (long > 0) exits.push(sell(symbol.sym, long, false, "no hold left to clear the round trip"));
      if (short > 0) exits.push(sell(symbol.sym, short, true, "no hold left to clear the round trip"));
      continue;
    }

    // Hysteresis: exit only once the forecast has crossed to the wrong side by
    // EXIT_BAND, and never inside MIN_HOLD_TICKS. Both guards exist to stop a
    // symbol sitting near 0.5 from churning a round trip every tick.
    if (heldTicks < MIN_HOLD_TICKS) continue;
    if (long > 0 && forecast < 0.5 - EXIT_BAND) {
      exits.push(sell(symbol.sym, long, false, `forecast ${forecast.toFixed(3)} turned against the long`));
    }
    if (short > 0 && forecast > 0.5 + EXIT_BAND) {
      exits.push(sell(symbol.sym, short, true, `forecast ${forecast.toFixed(3)} turned against the short`));
    }
  }
  return exits;
}

function sell(sym: string, shares: number, short: boolean, why: string): StockAction {
  return { type: "sell", sym, shares, short, why };
}

// --- entry ------------------------------------------------------------------

function planEntry(params: {
  view: StockView;
  memory: StockMemory;
  ranked: readonly RankedSymbol[];
  perSymbol: Map<string, { view: StockSymbolView; ranked: RankedSymbol }>;
  holdTicks: number;
  guaranteedTicks: number;
  exiting: Set<string>;
  cashBudget: number;
}): PositionTarget | undefined {
  const { view, ranked, perSymbol, holdTicks, guaranteedTicks, exiting, cashBudget } = params;
  if (guaranteedTicks <= 0 || cashBudget <= COMMISSION) return undefined;

  // Walk the ranking rather than taking only the head: the top candidate may be
  // a short we cannot open, already held, or too small to clear its spread, and
  // stopping there would leave every tradeable symbol below it untouched. That
  // single `break` is what let one bearish symbol block all trading before.
  for (const candidate of ranked) {
    if (exiting.has(candidate.sym)) continue;
    if (candidate.side === "short" && !view.canShort) continue;
    const symbol = perSymbol.get(candidate.sym)?.view;
    if (!symbol) continue;
    // Already in it. Averaging up is not modelled: it would re-pay the spread
    // on the whole new tranche for the same signal we already own.
    const held = candidate.side === "short" ? symbol.sharesShort : symbol.shares;
    if (held > 0) continue;
    // Never both sides of one symbol — they cancel, and both pay commission.
    if (symbol.shares > 0 || symbol.sharesShort > 0) continue;
    // Manipulation is additive: merely having a reachable farm target must not
    // make the base trader reject a position it would otherwise take. The
    // overlay is enabled only after the position exists and only in its
    // favorable direction (planManipulation below).
    if (Math.abs(candidate.forecast - 0.5) < ENTER_BAND) continue;
    if (!candidate.exact && !isConfident(candidate)) continue;

    const price = candidate.side === "short" ? symbol.bid : symbol.ask;
    if (!(price > 0)) continue;
    const room = Math.max(0, symbol.maxShares - symbol.shares - symbol.sharesShort);
    const shares = Math.min(room, Math.floor(Math.max(0, cashBudget - COMMISSION) / price));
    if (shares <= 0) continue;

    const meta = STOCK_METADATA[candidate.sym];
    const shareTx = meta ? midpoint(meta.shareTxForMovement) : Infinity;
    const forecast = effectiveForecast(candidate.forecast, shares, shareTx);
    const priced = {
      shares,
      ask: symbol.ask,
      bid: symbol.bid,
      forecast,
      volatility: candidate.volatility,
      side: candidate.side,
    };
    // The margin is the point: a position that only breaks even at the very last
    // tick of the horizon is a coin flip on the timing, not an investment. And it
    // is measured against the GUARANTEED hold — clearing the round trip only on
    // the far side of a 45% coin flip is not clearing it.
    const be = breakEvenTicks(priced);
    if (!(be * BREAK_EVEN_MARGIN <= guaranteedTicks)) continue;
    // Profit, though, is integrated over the EXPECTED hold: surviving a boundary
    // buys another cycle, so truncating there understates a good position.
    const profit = expectedProfit({ ...priced, ticks: holdTicks });
    if (!(profit > 0)) continue;

    return {
      sym: candidate.sym,
      side: candidate.side,
      shares,
      cost: shares * price + COMMISSION,
      expectedProfit: profit,
      holdTicks,
      guaranteedTicks,
      breakEvenTicks: be,
      ask: symbol.ask,
      bid: symbol.bid,
      forecast,
      volatility: candidate.volatility,
      why:
        `${candidate.side} ${candidate.sym} at forecast ${candidate.forecast.toFixed(3)}: ` +
        `breaks even in ${be.toFixed(1)} ticks of ${guaranteedTicks} guaranteed (${Math.round(holdTicks)} expected), ` +
        `expected ${formatMoney(profit)}`,
    };
  }
  return undefined;
}

/** A no-4S estimate is only actionable once it has evidence behind it. The
 *  shrinkage in estimateSignal already pulls a thin estimate toward 0.5, so this
 *  is the second guard: an estimate that survives shrinkage AND clears
 *  ENTER_BAND has both a real edge and real samples. */
function isConfident(candidate: RankedSymbol): boolean {
  return Math.abs(candidate.forecast - 0.5) >= ENTER_BAND && candidate.volatility > 0;
}

// --- the unlock ladder ------------------------------------------------------

/** WSE ($200m) -> TIX API ($5b) -> 4S Market Data TIX API ($25b x node mult).
 *
 * **4S Market Data itself ($1b) is deliberately never bought.** It unlocks the
 * in-game ticker UI, not the script API: `getForecast` and `getVolatility` check
 * `has4SDataTixApi`, and `purchase4SMarketDataTixApi` does NOT require
 * `has4SData` first (NetscriptFunctions/StockMarket.ts @ v3.0.1). So the $1b buys
 * an automated player exactly nothing, and the previous version's only unlock
 * purchase was the one purchase with no value.
 *
 * Everything here amortizes against `unlockHorizonSec`, the NODE horizon, not the
 * install horizon — none of these three flags is cleared by
 * `prestigeAugmentation`. Pricing them against the install cadence (as the old
 * shared `horizonSec` did) made the highest-leverage purchase in the feature look
 * unaffordable at any bankroll below ~$100b, which in BN8 is unreachable without
 * it: a deadlock dressed as prudence.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/StockMarket.ts
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Prestige.ts */
function unlockLadder(
  view: StockView,
  costs: UnlockCosts,
  ranked?: readonly RankedSymbol[],
  holdTicks?: number,
): UnlockPurchase | undefined {
  const horizon = view.unlockHorizonSec;
  if (horizon <= 0) return undefined;

  if (!view.hasWseAccount) {
    // WSE alone is worth nothing — `getSymbols` needs the TIX API — so it is
    // only ever bought as the first half of a pair, and priced as the pair.
    const pair = costs.wseAccount + costs.tixApi;
    const gain = blindRatePerSec(view);
    return propose(
      { type: "buyWse", cost: costs.wseAccount, why: "WSE account, the first half of TIX API access" },
      costs.wseAccount,
      gain,
      horizon,
      pair,
      view,
      "a WSE account is useless without the TIX API, so both are priced together",
    );
  }

  if (!view.hasTixApi) {
    const gain = blindRatePerSec(view);
    return propose(
      { type: "buyTix", cost: costs.tixApi, why: "TIX API — no positions without it" },
      costs.tixApi,
      gain,
      horizon,
      costs.tixApi,
      view,
      "positions are impossible without the TIX API",
    );
  }

  if (!view.has4SApi) {
    if (view.fourSigmaDisabled) return undefined;
    // Priced from the live market rather than a guess: what the current ranking
    // earns on estimated forecasts, against what the same ranking would earn on
    // exact ones. That difference IS the value of 4S, and it scales with the
    // bankroll and the market's current state instead of asserting a rate.
    const gain = fourSigmaGainPerSec(view, ranked ?? [], holdTicks ?? TICKS_PER_CYCLE);
    return propose(
      { type: "buy4SApi", cost: costs.fourSigmaApi, why: "4S Market Data TIX API — exact forecasts" },
      costs.fourSigmaApi,
      gain,
      horizon,
      costs.fourSigmaApi,
      view,
      "4S turns an estimate shrunk toward the coin flip into the exact forecast",
    );
  }
  return undefined;
}

function propose(
  action: StockAction,
  cost: number,
  gainPerSec: number,
  horizonSec: number,
  investmentCost: number,
  view: StockView,
  rationale: string,
): UnlockPurchase | undefined {
  if (!(gainPerSec > 0)) return undefined;
  // Spending the whole bankroll on the unlock leaves nothing to trade with,
  // which makes the purchase worthless the instant it completes. Twice the cash
  // needed is the minimum that leaves a working position behind.
  if (view.totalMoney < investmentCost * 2) return undefined;
  const netOverHorizon = gainPerSec * horizonSec - investmentCost;
  if (!(netOverHorizon > 0)) return undefined;
  const paybackSec = investmentCost / gainPerSec;
  if (paybackSec > horizonSec) return undefined;
  return {
    action,
    cost,
    investmentCost,
    gainPerSec,
    paybackSec,
    netOverHorizon,
    why:
      `${rationale}; ${formatMoney(gainPerSec)}/sec pays back ` +
      `${formatMoney(investmentCost)} in ${Math.round(paybackSec)}s of ${Math.round(horizonSec)}s left`,
  };
}

/** Conservative trading-rate estimate while the market is entirely invisible.
 * Uses known upstream generation ranges, never a live hidden value. */
function blindRatePerSec(view: StockView): number {
  const bankroll = view.totalMoney + view.portfolioValue;
  if (!(bankroll > 0)) return 0;
  const volatilities = Object.keys(STOCK_METADATA)
    .map((sym) => midpoint(STOCK_METADATA[sym]!.mv) / 100)
    .sort((a, b) => a - b);
  const median = volatilities[volatilities.length >> 1] ?? 0;
  const drift = (2 * BLIND_FORECAST - 1) * meanLogStep(median);
  if (!(drift > 0)) return 0;
  const spread = Object.keys(STOCK_METADATA)
    .map((sym) => worstSpreadFraction(sym))
    .sort((a, b) => a - b)[Math.floor(Object.keys(STOCK_METADATA).length / 2)] ?? 0;
  const gross = bankroll * Math.expm1(drift * TICKS_PER_CYCLE);
  const net = gross - bankroll * spread - 2 * COMMISSION;
  return net > 0 ? net / secondsForTicks(TICKS_PER_CYCLE) : 0;
}

/** What the exact forecast adds over the estimated one, in $/sec.
 *
 * Both sides are the SAME ranking function over the SAME market, differing only
 * in the forecast fed to it — so this is a measurement of the shrinkage penalty,
 * not an assertion about 4S. The estimated side is already in `ranked`; the exact
 * side is unknowable before the purchase, so the estimate's own distance from 0.5
 * is un-shrunk to recover the forecast it is a shrunken view OF. */
function fourSigmaGainPerSec(view: StockView, ranked: readonly RankedSymbol[], holdTicks: number): number {
  if (holdTicks <= 0) return 0;
  let remaining = Math.max(0, view.totalMoney);
  if (!(remaining > COMMISSION)) return 0;
  let estimated = 0;
  let exact = 0;
  for (const candidate of ranked) {
    if (remaining <= COMMISSION) break;
    const symbol = view.symbols.find((s) => s.sym === candidate.sym);
    if (!symbol) continue;
    const price = candidate.side === "short" ? symbol.bid : symbol.ask;
    if (!(price > 0)) continue;
    const room = Math.max(0, symbol.maxShares - symbol.shares - symbol.sharesShort);
    const shares = Math.min(room, Math.floor((remaining - COMMISSION) / price));
    if (shares <= 0) continue;
    const common = { shares, ask: symbol.ask, bid: symbol.bid, volatility: candidate.volatility, side: candidate.side, ticks: holdTicks };
    estimated += Math.max(0, expectedProfit({ ...common, forecast: candidate.forecast }));
    // Un-shrink: the estimator reports 0.5 + (true - 0.5) * n/(n+k), so the
    // observed deviation understates the true one by that same factor. Doubling
    // it is the conservative inverse (it assumes n = k, the halfway point).
    const unshrunk = 0.5 + (candidate.forecast - 0.5) * 2;
    exact += Math.max(0, expectedProfit({ ...common, forecast: Math.min(1, Math.max(0, unshrunk)) }));
    remaining -= shares * price + COMMISSION;
  }
  const delta = exact - estimated;
  if (!(delta > 0)) return 0;
  return delta / secondsForTicks(holdTicks);
}

// --- manipulation -----------------------------------------------------------

/** What we want the farm to do, per host.
 *
 * The value is per INFLUENCING OP, which is the unit `hacking` can price: one
 * grow (long) or one hack (short) with `stock: true` moves the second-order
 * forecast with probability equal to the fraction of `moneyMax` it moved. Because
 * that probability is a FRACTION, `moneyMax` cancels out of the rate entirely —
 * so the cheapest manipulator for a symbol is whichever of its hosts has the
 * shortest op time and the highest steal per thread, NOT the richest one. That
 * inversion is the whole reason this has to be priced rather than assumed. */
function planManipulation(params: {
  view: StockView;
  perSymbol: Map<string, { view: StockSymbolView; ranked: RankedSymbol }>;
  holdTicks: number;
  exiting: Set<string>;
}): ManipulationIntent[] {
  const { view, perSymbol, holdTicks, exiting } = params;
  if (holdTicks <= 0) return [];
  const out: ManipulationIntent[] = [];

  // Only hosts the farm can actually work: rooted, skill-reachable, present in
  // THIS world. Publishing the full metadata host list broadcast intents for
  // servers that did not exist in the run's network, and the "manipulation"
  // profile spent the whole run influencing nobody (measured: influence keys
  // fulcrumassets/4sigma/... against a network whose only symbol hosts were
  // foodnstuff, sigma-cosmetics and joesguns).
  const farmable = new Set(view.farmableHosts);
  const consider = (sym: string, side: PositionSide, notional: number): void => {
    const entryView = perSymbol.get(sym);
    if (!entryView || notional <= 0) return;
    const hosts = Object.entries(view.symbolByHost)
      .filter(([, mapped]) => mapped === sym)
      .map(([host]) => host);
    if (hosts.length === 0) return;
    const forecast = entryView.ranked.forecast;
    const volatility = entryView.ranked.volatility;
    // Manipulation is positive feedback, not a substitute for an edge. Once
    // the public signal no longer favours the held side, stop feeding it: a
    // small farm can otherwise mask a regime reversal just long enough to
    // delay the exit while being far too weak to overcome the new drift.
    if (side === "long" ? forecast <= 0.5 : forecast >= 0.5) return;
    for (const hostname of hosts) {
      if (!farmable.has(hostname)) continue;
      // stealFraction 1 is the per-op UNIT: `hacking` scales by the steal
      // fraction its own solved batch achieves, which it knows and we do not.
      const valuePerOp = manipulationValuePerOp({
        stealFraction: 1,
        notional,
        volatility,
        ticks: holdTicks,
        forecast,
        side,
      });
      if (!(valuePerOp > 0)) continue;
      out.push({
        sym,
        hostname,
        side,
        valuePerOp,
        notional,
        why:
          `${side === "long" ? "grow" : "hack"} ${hostname} to push ${sym} ` +
          `${side === "long" ? "up" : "down"} for a ${formatMoney(notional)} position`,
      });
    }
  };

  for (const symbol of view.symbols) {
    if (exiting.has(symbol.sym)) continue;
    // Both sides at the LIVE price: the nudges act on the position's current
    // exposure, and an entry price from before a move misstates it by exactly
    // that move.
    if (symbol.shares > 0) consider(symbol.sym, "long", symbol.shares * symbol.bid);
    else if (symbol.sharesShort > 0) consider(symbol.sym, "short", symbol.sharesShort * symbol.ask);
  }
  out.sort((a, b) => b.valuePerOp - a.valuePerOp || (a.hostname < b.hostname ? -1 : 1));
  return out;
}

/** hostname -> intent, the shape the hacking evaluator wants. Highest value per
 *  host wins when two symbols somehow name the same host (they cannot today). */
export function manipulationByHost(intents: readonly ManipulationIntent[]): Record<string, ManipulationIntent> {
  const byHost: Record<string, ManipulationIntent> = {};
  for (const intent of intents) {
    const existing = byHost[intent.hostname];
    if (!existing || intent.valuePerOp > existing.valuePerOp) byHost[intent.hostname] = intent;
  }
  return byHost;
}

// --- funding ----------------------------------------------------------------

/** What the arbiter granted, PER CLAIM.
 *
 * Two separate money claims — the unlock and the position — at different
 * priorities, so they are granted independently and a single total cannot be
 * divided between them after the fact. `grantedAmount` sums a feature's grants,
 * which for one claim is the same number and for two is a mis-allocation waiting
 * to happen: a pass where only the cheap position claim won would otherwise look
 * like budget for the $25b unlock, and the entry would be starved by a purchase
 * nobody funded. */
export interface StockGrants {
  /** Granted against the `unlock:*` claim. */
  unlock: number;
  /** Granted against the `position` claim. */
  position: number;
}

/** The two money claim ids this feature posts. Shared with the driver so the
 *  claim it posts and the grant it reads back cannot drift apart. */
export const POSITION_CLAIM_ID = "position";
export function unlockClaimId(action: StockAction): string {
  return `unlock:${action.type}`;
}

/** Narrow a plan to what the money grants actually pay for.
 *
 * Exits first and unconditionally: selling RAISES money, and a liquidation that
 * waited on a grant would be exactly backwards. Then the unlock (indivisible —
 * half a TIX API is nothing), then the entry, scaled down to fit and re-checked
 * against its round trip at the smaller size. That re-check matters: commission
 * is fixed, so a position cut to a quarter pays the same $200k against a quarter
 * of the drift and can flip from profitable to guaranteed loss.
 *
 * The two budgets never cross-subsidise. Money the arbiter set aside for a
 * position is not available to the unlock, and vice versa — each was won on its
 * own priority against every other feature's claims. */
export function fundedActions(plan: StockPlan, grants: StockGrants): StockAction[] {
  const actions: StockAction[] = [...plan.exits];

  if (plan.unlock && plan.unlock.cost <= Math.max(0, grants.unlock)) {
    actions.push(plan.unlock.action);
  }

  const budget = Math.max(0, grants.position);
  const entry = plan.entry;
  if (entry && budget > COMMISSION) {
    const perShare = (entry.cost - COMMISSION) / entry.shares;
    const shares = Math.min(entry.shares, Math.floor((budget - COMMISSION) / perShare));
    if (shares > 0) {
      const scaled = breakEvenTicks({
        shares,
        ask: entry.ask,
        bid: entry.bid,
        forecast: entry.forecast,
        volatility: entry.volatility,
        side: entry.side,
      });
      if (scaled * BREAK_EVEN_MARGIN <= entry.guaranteedTicks) {
        actions.push({
          type: "buy",
          sym: entry.sym,
          shares,
          short: entry.side === "short",
          why: shares === entry.shares ? entry.why : `${entry.why} (funded ${shares} of ${entry.shares} shares)`,
        });
      }
    }
  }
  return actions;
}

// --- reporting --------------------------------------------------------------

function holdReason(view: StockView, best: RankedSymbol | undefined, holdTicks: number, observedTicks: number): string {
  if (holdTicks <= 0) {
    return `${Math.round(view.positionHorizonSec)}s left before the install — too short for any round trip to clear`;
  }
  if (!best) return "no symbols visible yet";
  if (!best.exact && observedTicks < 25) {
    return `watching the market: ${observedTicks} ticks observed, no forecast worth trading on yet`;
  }
  if (Math.abs(best.forecast - 0.5) < ENTER_BAND) {
    return `best forecast ${best.forecast.toFixed(3)} is inside the ${ENTER_BAND} entry band — no edge to pay the spread with`;
  }
  if (best.breakEvenTicks * BREAK_EVEN_MARGIN > holdTicks) {
    return `${best.sym} needs ${best.breakEvenTicks.toFixed(1)} ticks to clear its round trip, ${holdTicks} available`;
  }
  return `best expected profit ${formatMoney(best.expectedProfit)} does not clear the round trip`;
}
