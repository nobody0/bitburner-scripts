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
  /** Hostname -> symbol. A constant: both halves of the join — a server's
   * organization and a stock's — are fixed game data, so the driver passes
   * `SYMBOL_BY_HOST` (shared/features/stocks.ts). Injected rather than imported
   * so a test can hand the solver a different world. */
  symbolByHost: Readonly<Record<string, string>>;

  /** `FourSigmaMarketData*Cost` scale the unlock; `ScriptHackMoney*` scale what
   *  manipulation is worth against hacking. See market.ts#StockNodeMults. */
  nodeMults?: StockNodeMults;

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

  /** The market's MEASURED realized rate since the last install, when one
   *  exists: `getMoneySources().sinceInstall.stock / elapsed` — buys are
   *  negative and sells positive in the game's own ledger, so this is net
   *  realized profit per second. The reserve bids it in preference to the
   *  closed-form expectations: a bankroll demonstrably producing X $/s must
   *  not defend itself with a meeker model of X, or any claim priced off the
   *  market's own success (a manipulation-boosted farm score, say) outbids
   *  the capital that success runs on. */
  measuredIncomePerSec?: number;

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
  | { type: "buyWse"; cost: number }
  | { type: "buyTix"; cost: number }
  | { type: "buy4SApi"; cost: number }
  | { type: "buy"; sym: string; shares: number; short: boolean }
  | { type: "sell"; sym: string; shares: number; short: boolean };

export interface RankedSymbol {
  sym: string;
  side: PositionSide;
  forecast: number;
  volatility: number;
  /** Exact (4S) or estimated from price history. */
  exact: boolean;
  /** Enough samples behind a non-exact estimate to act on it
   *  (`ForecastEstimate.confident`). Always true for exact signals. */
  confident: boolean;
  /** The estimator's shrink factor `n / (n + k)` (1 when exact). The known
   *  inverse fourSigmaGainPerSec uses to recover the un-shrunk forecast. */
  shrink: number;
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
}

export interface StockPlan {
  /** Exits. Need no money, so they are never gated on a grant. */
  exits: StockAction[];
  /** The single next unlock worth buying, cheapest-first up the ladder. */
  unlock?: UnlockPurchase;
  /** The position to open, at full ambition. */
  entry?: PositionTarget;
  /** Working capital wanted while NO entry is actionable this pass.
   *
   * The market's value does not vanish between entries: an estimator still
   * gathering its samples, or a ranking whose best edge is momentarily inside
   * the band, is hours of future trades away from worthless. Without a
   * standing claim the arbiter reads the bankroll as idle and any OTHER
   * feature with a measurable value — however small — takes it unopposed,
   * which is how BN8's only income source was defunded by experience-priced
   * fleet RAM before it could place its first trade.
   *
   * `ratePerSec` is a calculation, not an assertion: the larger of the
   * closed-form blind trading rate (vendored generation ranges at the meek
   * BLIND_FORECAST) and the best currently-ranked candidate's expectation.
   * The driver posts it as a `mode: "reserve"` claim — money sequestered, not
   * spent — so a competitor must out-price the market's expected return to
   * take the cash, and the reserve becomes the spend budget the moment an
   * entry clears its gates. */
  reserve?: { amount: number; ratePerSec: number };
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

  // Which symbols a farm could actually influence, inverted ONCE. Asking it per
  // symbol — `Object.entries(symbolByHost).some(...)` inside rankSymbol — walked
  // every server 33 times a pass, at controller cadence, for the whole run: it
  // was the single largest allocation source in a BN8 profile. `farmableHosts`
  // already drops any host with no symbol, so the inversion is total.
  const manipulableSymbols = new Set<string>();
  for (const hostname of view.farmableHosts) {
    const sym = view.symbolByHost[hostname];
    if (sym !== undefined) manipulableSymbols.add(sym);
  }
  const ranked: RankedSymbol[] = [];
  const perSymbol = new Map<string, { view: StockSymbolView; ranked: RankedSymbol }>();
  const cashBudget = positionBudget(view);

  for (const symbol of view.symbols) {
    const signal = estimateSignal(memory.history, symbol.sym, symbol.forecast);
    const side = favouredSide(signal.forecast);
    const entry = rankSymbol({
      symbol,
      signal,
      side,
      holdTicks,
      cashBudget,
      manipulable: manipulableSymbols.has(symbol.sym),
    });
    ranked.push(entry);
    perSymbol.set(symbol.sym, { view: symbol, ranked: entry });
  }
  // Ranked by RETURN ON CAPITAL, not by absolute profit.
  //
  // Capital is allocated by the arbiter, so rank the claim by return on each
  // dollar requested. A manipulable symbol wins genuine ties — a position the
  // farm can PUSH carries optionality a pure-drift twin does not, and at equal
  // calculated return the option is free. Deliberately only a tie-break: the
  // push's dollar value per op is priced (manipulationValuePerOp), but the
  // OPS-PER-SECOND the farm would deliver to a prospective position is not yet
  // a measured quantity, and folding an invented rate into the ranking is how
  // an estimator starts trading on its own guesses. Absolute profit and the
  // symbol name complete the total order.
  ranked.sort(
    (a, b) =>
      returnOnCapital(b) - returnOnCapital(a) ||
      Number(b.manipulable) - Number(a.manipulable) ||
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
    // Liquidation converts the book to cash FOR THE INSTALL — it does not
    // donate it. The reserve therefore STANDS during liquidation: progression's
    // own install claims outrank it, so the conversion is never blocked, but a
    // peer feature must still out-bid the working capital to take the
    // proceeds. Without this, a liquidation ordered for a pocket-change
    // install freed a $247m book, the no-reserve state held for the whole
    // conversion window, and infrastructure claims ate the node's entire
    // economy at zero opposition (bn8-full seed 1, t≈56 min: terminal wealth
    // $38k, no install ever performed, no further trade possible for the
    // remaining twenty-three hours).
    const liquidationReserve = planReserve(view, ranked, holdTicks, cashBudget);
    return {
      memory: forgetIntent(memory, held.map((s) => s.sym)),
      plan: {
        exits,
        ...(liquidationReserve ? { reserve: liquidationReserve } : {}),
        ranked,
        manipulation: [],
        ...(cycleTicks !== undefined ? { ticksUntilCycle: cycleTicks } : {}),
        observedTicks,
        flat: held.length === 0 && exits.length === 0,
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
  // The reserve is ALWAYS posted, covering whatever part of the bankroll the
  // other claims do not: the entry claim defends its own cost and the unlock
  // ladder proposes a purchase only when its net gain over the node horizon is
  // positive, so the reserve bids the remainder. Skipping it on entry passes
  // left the rest of the bankroll — and the book about to become proceeds —
  // undefended for exactly those passes, and a competitor's standing claim
  // took $318m of working capital through that one-pass hole.
  const reserve = planReserve(
    view,
    ranked,
    holdTicks,
    Math.max(0, cashBudget - (unlock?.cost ?? 0) - (entry?.cost ?? 0)),
  );

  const best = ranked[0];
  return {
    memory,
    plan: {
      exits,
      ...(unlock ? { unlock } : {}),
      ...(entry ? { entry } : {}),
      ...(reserve ? { reserve } : {}),
      ranked,
      manipulation,
      ...(cycleTicks !== undefined ? { ticksUntilCycle: cycleTicks } : {}),
      observedTicks,
      flat: held.length === 0 && exits.length === 0 && entry === undefined,
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
  signal: { forecast: number; volatility: number; exact: boolean; confident: boolean; shrink: number };
  side: PositionSide;
  holdTicks: number;
  cashBudget: number;
  /** Whether any farmable host carries this symbol's organization. */
  manipulable: boolean;
}): RankedSymbol {
  const { symbol, signal, side, holdTicks, cashBudget, manipulable } = params;
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
    confident: signal.confident,
    shrink: signal.shrink,
    drift,
    manipulable,
    breakEvenTicks: be,
    expectedProfit: profit,
    notional: shares * price,
  };
}

/** `symbolByHost` inverted, cached on the mapping's identity.
 *
 * Both halves of the join are fixed facts about the game — a server's
 * organization and a stock's — so the driver passes the module-level constant
 * and this inverts it exactly once for the life of the process. Keying on
 * identity rather than assuming the constant keeps the mapping genuinely
 * injectable: a caller that supplies a different one gets a rebuild, and a
 * caller that supplies the same one gets a pointer compare.
 *
 * Rebuilding it per call cost real time. Scanning it per SYMBOL, which is what
 * `rankSymbol` and this function both used to do, cost that much again times
 * thirty-three, at controller cadence, for the whole run. */
let hostsForSymbolsCache: { source: Readonly<Record<string, string>>; hosts: Map<string, string[]> } | undefined;

function hostsForSymbols(symbolByHost: Readonly<Record<string, string>>): ReadonlyMap<string, string[]> {
  if (hostsForSymbolsCache?.source === symbolByHost) return hostsForSymbolsCache.hosts;
  const hosts = new Map<string, string[]>();
  for (const [hostname, sym] of Object.entries(symbolByHost)) {
    const bucket = hosts.get(sym);
    if (bucket) bucket.push(hostname);
    else hosts.set(sym, [hostname]);
  }
  hostsForSymbolsCache = { source: symbolByHost, hosts };
  return hosts;
}

// --- exits ------------------------------------------------------------------

function planExits(
  view: StockView,
  memory: StockMemory,
  perSymbol: Map<string, { view: StockSymbolView; ranked: RankedSymbol }>,
  guaranteedTicks: number,
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

    // Liquidation, or a guaranteed hold too short to clear the round trip:
    // either way every further tick held is risk taken for a payoff that
    // cannot arrive.
    if (view.liquidate || guaranteedTicks <= 0) {
      if (long > 0) exits.push(sell(symbol.sym, long, false));
      if (short > 0) exits.push(sell(symbol.sym, short, true));
      continue;
    }

    // Hysteresis: exit only once the forecast has crossed to the wrong side by
    // EXIT_BAND, and never inside MIN_HOLD_TICKS. Both guards exist to stop a
    // symbol sitting near 0.5 from churning a round trip every tick.
    if (heldTicks < MIN_HOLD_TICKS) continue;
    if (long > 0 && forecast < 0.5 - EXIT_BAND) {
      exits.push(sell(symbol.sym, long, false));
    }
    if (short > 0 && forecast > 0.5 + EXIT_BAND) {
      exits.push(sell(symbol.sym, short, true));
    }
  }
  return exits;
}

function sell(sym: string, shares: number, short: boolean): StockAction {
  return { type: "sell", sym, shares, short };
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
    // A no-4S estimate is only actionable once it has evidence behind it. The
    // shrinkage in estimateSignal already pulls a thin estimate toward 0.5;
    // `confident` (samples >= FORECAST_PRIOR_STRENGTH) is the second guard, so
    // an estimate that clears ENTER_BAND has both a real edge and real samples.
    if (!candidate.exact && (!candidate.confident || !(candidate.volatility > 0))) continue;

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
    };
  }
  return undefined;
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
      { type: "buyWse", cost: costs.wseAccount },
      costs.wseAccount,
      gain,
      horizon,
      pair,
      view,
    );
  }

  if (!view.hasTixApi) {
    const gain = blindRatePerSec(view);
    return propose(
      { type: "buyTix", cost: costs.tixApi },
      costs.tixApi,
      gain,
      horizon,
      costs.tixApi,
      view,
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
      { type: "buy4SApi", cost: costs.fourSigmaApi },
      costs.fourSigmaApi,
      gain,
      horizon,
      costs.fourSigmaApi,
      view,
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
  };
}

/** Working capital wanted between entries (see StockPlan.reserve).
 *
 * Measured beats modeled: once the market has a realized rate since the last
 * install, the reserve bids THAT. Before any history, two closed-form
 * expectations remain — the blind rate prices the bankroll from the vendored
 * generation ranges alone, and the ranked head prices it from the live
 * (shrunk) signal when that is already better. A candidate whose side cannot
 * be opened is not an expectation this run can realize, so shorts are skipped
 * without SF8.2/BN8. */
function planReserve(
  view: StockView,
  ranked: readonly RankedSymbol[],
  holdTicks: number,
  cashBudget: number,
): StockPlan["reserve"] {
  // The working capital is the BANKROLL — cash plus the book at liquidation
  // value — not merely what happens to be liquid this pass. A position's sale
  // proceeds land between two driver ticks, and a reserve sized on the
  // pre-sale cash leaves them undefended for exactly that gap: measured on
  // bn8-manipulation seed 1, a $390m sale was scooped by a $318m RAM rung in
  // the 500 ms before the next stock plan existed. Claims are full-ambition
  // requests (the arbiter reserves only what the pool actually holds), so
  // sizing over the book is free while nothing lands and exactly right the
  // instant something does.
  const bankroll = cashBudget + Math.max(0, view.portfolioValue);
  if (!(bankroll > COMMISSION)) return undefined;
  // `holdTicks` guards only the ranked-rate division, NOT the reserve itself:
  // during a liquidation the install forecast decays below one 6 s market tick
  // (holdTicks = 0) for the last seconds of every recalibration window, and a
  // reserve gated on it vanished exactly while the freed book's proceeds most
  // needed defending — "the reserve STANDS during liquidation" was false for
  // those passes. The blind and measured rates are horizon-independent.
  const best = ranked.find((candidate) =>
    candidate.expectedProfit > 0 && (view.canShort || candidate.side === "long"));
  const rankedRate = best && holdTicks > 0 ? best.expectedProfit / secondsForTicks(holdTicks) : 0;
  const rate = Math.max(blindRatePerSec(view), rankedRate, view.measuredIncomePerSec ?? 0);
  return rate > 0 ? { amount: bankroll, ratePerSec: rate } : undefined;
}

/** Conservative trading-rate estimate while the market is entirely invisible.
 * Uses known upstream generation ranges, never a live hidden value. */
function blindRatePerSec(view: StockView): number {
  return blindBankrollRatePerSec(view.totalMoney + view.portfolioValue);
}

/** The same closed-form blind expectation as a pure function of the bankroll,
 * exported because it is also the honest ROUTE-LEVEL prior for money income in
 * a node whose other channels are zeroed by its own multipliers (BN8): before
 * any income is measured, "what could this bankroll earn traded blind" is a
 * declared calculation over the vendored generation ranges, where a flat
 * hacking-era fallback rate is simply the wrong node's number. */
export function blindBankrollRatePerSec(bankroll: number): number {
  if (!(bankroll > 0)) return 0;
  const { cycleEdge } = blindMarketShape();
  if (!(cycleEdge > 0)) return 0;
  const net = bankroll * cycleEdge - 2 * COMMISSION;
  return net > 0 ? net / secondsForTicks(TICKS_PER_CYCLE) : 0;
}

/** The blind model's per-cycle edge: median-volatility drift at BLIND_FORECAST
 * minus the median round-trip spread, both from the vendored generation
 * ranges. The one shape every blind-bankroll figure derives from. A pure
 * function of static metadata, memoized because its callers sit on hot paths
 * (every stock plan, every working-capital value curve, every sampledRates
 * pass) and the two 33-symbol sorts never produce a different answer. */
let blindMarketShapeMemo: { cycleEdge: number } | undefined;
function blindMarketShape(): { cycleEdge: number } {
  if (blindMarketShapeMemo) return blindMarketShapeMemo;
  blindMarketShapeMemo = computeBlindMarketShape();
  return blindMarketShapeMemo;
}

function computeBlindMarketShape(): { cycleEdge: number } {
  const volatilities = Object.keys(STOCK_METADATA)
    .map((sym) => midpoint(STOCK_METADATA[sym]!.mv) / 100)
    .sort((a, b) => a - b);
  const median = volatilities[volatilities.length >> 1] ?? 0;
  const drift = (2 * BLIND_FORECAST - 1) * meanLogStep(median);
  const spread = Object.keys(STOCK_METADATA)
    .map((sym) => worstSpreadFraction(sym))
    .sort((a, b) => a - b)[Math.floor(Object.keys(STOCK_METADATA).length / 2)] ?? 0;
  return { cycleEdge: Math.expm1(Math.max(0, drift) * TICKS_PER_CYCLE) - spread };
}

/** The smallest bankroll blind trading can grow at all: below this, the two
 * fixed $100k commissions per round trip eat the whole per-cycle edge and the
 * closed form's net is <= 0. The same break-even the rate formula encodes,
 * solved for the bankroll — in a node whose only income is the market,
 * spending below this line is not a trade-off, it is the end of the economy
 * (measured on bn8-full: a run drained to $38k placed zero further trades for
 * twenty-three virtual hours, because no position clears its commission). */
export function blindViableBankroll(): number {
  const { cycleEdge } = blindMarketShape();
  return cycleEdge > 0 ? (2 * COMMISSION) / cycleEdge : Infinity;
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
  const bySym = new Map(view.symbols.map((symbol) => [symbol.sym, symbol]));
  let estimated = 0;
  let exact = 0;
  for (const candidate of ranked) {
    if (remaining <= COMMISSION) break;
    const symbol = bySym.get(candidate.sym);
    if (!symbol) continue;
    const price = candidate.side === "short" ? symbol.bid : symbol.ask;
    if (!(price > 0)) continue;
    const room = Math.max(0, symbol.maxShares - symbol.shares - symbol.sharesShort);
    const shares = Math.min(room, Math.floor((remaining - COMMISSION) / price));
    if (shares <= 0) continue;
    const common = { shares, ask: symbol.ask, bid: symbol.bid, volatility: candidate.volatility, side: candidate.side, ticks: holdTicks };
    estimated += Math.max(0, expectedProfit({ ...common, forecast: candidate.forecast }));
    // Un-shrink with the estimator's OWN factor: it reports
    // 0.5 + (true - 0.5) * shrink, so dividing the observed deviation by that
    // shrink recovers the forecast the estimate is a shrunken view of. A symbol
    // with no samples (shrink 0) has no deviation to un-shrink.
    const unshrunk = candidate.shrink > 0
      ? 0.5 + (candidate.forecast - 0.5) / candidate.shrink
      : candidate.forecast;
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
  const hostsBySymbol = hostsForSymbols(view.symbolByHost);
  const consider = (sym: string, side: PositionSide, notional: number): void => {
    const entryView = perSymbol.get(sym);
    if (!entryView || notional <= 0) return;
    const hosts = hostsBySymbol.get(sym);
    if (!hosts || hosts.length === 0) return;
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

/** The money claim ids this feature posts. Shared with the driver so the
 *  claim it posts and the grant it reads back cannot drift apart. */
export const POSITION_CLAIM_ID = "position";
/** The standing working-capital reserve (see StockPlan.reserve). Its own id
 *  because it must COEXIST with the position claim: an entry pass that
 *  replaced the reserve left the rest of the bankroll undefended for exactly
 *  that pass. `fundedActions` never reads its grants — reserves sequester,
 *  they do not spend. */
export const WORKING_CAPITAL_CLAIM_ID = "working-capital";
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
        });
      }
    }
  }
  return actions;
}
