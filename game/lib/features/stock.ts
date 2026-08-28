import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { SYMBOL_BY_HOST } from "../../../shared/features/stocks.ts";
import { linearValueCurve, PRIORITY, type Claim, type ClaimValueCurve } from "../../../shared/strategy/arbiter.ts";
import { usableForecastSec } from "../../../shared/strategy/progression/forecast.ts";
import { secondsForTicks, TICKS_PER_CYCLE } from "../../../shared/strategy/stock/market.ts";
import {
  fundedActions,
  initStockMemory,
  manipulationByHost,
  blindViableBankroll,
  POSITION_CLAIM_ID,
  stepStock,
  WORKING_CAPITAL_CLAIM_ID,
  unlockClaimId,
  type StockAction,
  type StockGrants,
  type StockMemory,
  type StockPlan,
  type StockView,
} from "../../../shared/strategy/stock/decide.ts";
import type { StockManipulation, StockPlan as StockPlanDigest, StockState } from "../../../shared/telemetry/topics/stock.ts";
import { isScriptDeath } from "../errors.ts";
import { moneyRateValue, moneyStepValue } from "../income.ts";
import { merge } from "../state.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

/** The stock driver.
 *
 * Script automation has two levels: the TIX API ($5b) initializes the market
 * and allows scripted positions without WSE, while the
 * 4S Market Data TIX API ($25b x the node's multiplier) supplies the exact
 * forecast. Nothing here is capability-gated, which is why `stock` is an
 * always-playable feature and the ladder is the driver's own job.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Prestige.ts#L163-L168
 *
 * Market probes run every 3 s and that is load-bearing: the market updates
 * every 6 s — 4 s while burning stored cycles, so the sampler must be strictly
 * FASTER than 4 s or a catch-up tick can slip between two samples — while
 * measured volatility and the no-4S forecast estimate come from observing every
 * tick exactly once. A poller slower than the tick cannot count up-ticks
 * reliably. It must also be no slower than the price probe, which declares the
 * same 3 s, or a tick the probe captured would be overwritten before we folded
 * it into the history. The pure driver runs at controller cadence so
 * plan -> claim -> grant and retryable actions do not each wait another market
 * sample. `observeMarket` is idempotent when nothing moved, so those extra
 * evaluations add neither samples nor Netscript calls.
 *
 * The plan/fund split is the other structural rule. `stepStock` sizes a position
 * at full ambition with NO knowledge of the money grant, the claim is posted from
 * that plan, and only then does `fundedActions` cut it to what was granted.
 * Deriving the plan from the grant would be circular: no plan means no claim,
 * and therefore no grant from which to derive a plan. */

let memory: StockMemory = initStockMemory();
let lastPlan: StockPlan | undefined;
let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;
interface StockFlows {
  tradeCashFlow: number;
  tradeFlowSince?: number;
  unlockSpend: number;
}
let stockFlows: StockFlows | undefined;

function flows(): StockFlows {
  return (stockFlows ??= { tradeCashFlow: 0, unlockSpend: 0 });
}

export function resetStockState(): void {
  // An install re-rolls every symbol's price, cap, spread and volatility
  // (prestigeAugmentation -> initStockMarket), so a surviving history describes
  // a market that no longer exists, and a surviving intent commits us to a side
  // of a position that was destroyed.
  memory = initStockMemory();
  lastPlan = undefined;
  lastResult = undefined;
  stockFlows = undefined;
}

/** Hosts the farm could actually drive right now — the other half of the
 * manipulation loop.
 *
 * `hacking` prices price impact into its target score only for a symbol `stock`
 * already holds. Restricting choices to farmable hosts ensures the dispatcher
 * can actually land the influencing operations the stock plan assumes.
 *
 * The same three conditions the target evaluator uses (`isCandidate` plus a skill
 * check), because a host that fails any of them cannot carry an influencing op.
 *
 * WHICH host carries which symbol is NOT one of those conditions. It is a
 * constant — a server's organization is fixed in the game's own server table,
 * and so is a stock's — and `shared/features/stocks.ts` already says so: the
 * mapping is "computed here rather than through the public
 * `ns.stock.getOrganization` API in production". `SYMBOL_BY_HOST` is that
 * constant, and `sim/tests/stock-parity.test.ts` pins it against the vendored
 * `SERVER_METADATA.org`.
 * Only farmability is dynamic, so the join walks the fixed symbol-host mapping
 * rather than probing organizations or scanning the whole network. */
function farmableHosts(ctx: DriverContext): string[] {
  const servers = ctx.state.topics.servers;
  const skill = ctx.state.topics.player?.skills.hacking ?? 0;
  if (!servers) return [];
  const out: string[] = [];
  for (const hostname of Object.keys(SYMBOL_BY_HOST)) {
    const server = servers[hostname];
    if (!server) continue;
    if (!server.hasAdminRights || server.purchasedByPlayer) continue;
    if ((server.moneyMax ?? 0) <= 0) continue;
    if ((server.requiredHackingSkill ?? Infinity) > skill) continue;
    out.push(hostname);
  }
  return out;
}

/** The money grants, read back PER CLAIM.
 *
 * `ctx.grants.money` is the SUM of everything this feature won, which is the
 * right shape for a feature with one money claim and a mis-allocation for a
 * feature with two. Stock posts an unlock claim and a position claim at different
 * priorities, so they are granted independently: a pass where only the cheap
 * position claim won must not look like budget for the $25b unlock, or the entry
 * would be starved by a purchase nobody funded. */
function stockGrants(plan: StockPlan, ctx: DriverContext): StockGrants {
  const granted = (id: string): number => {
    let total = 0;
    for (const grant of ctx.grants.result.grants) {
      if (grant.by === "stock" && grant.resource === "money" && grant.claimId === id) total += grant.amount;
    }
    return total;
  };
  return {
    unlock: plan.unlock ? granted(unlockClaimId(plan.unlock.action)) : 0,
    position: granted(POSITION_CLAIM_ID),
  };
}

/** Exported for tests: the liquidation signal is derived HERE, and deriving it
 *  from the wrong field froze the market for an entire run. */
export function buildView(ctx: DriverContext): StockView | undefined {
  const topic = ctx.state.topics.stock;
  if (!topic) return undefined;
  const signals = topic.signals ?? {};
  const progression = ctx.state.topics.progression;
  const plan = progression?.plan;

  // Two horizons, because the two things this feature buys have different
  // lifetimes. A POSITION dies at the next install: prestigeAugmentation zeroes
  // every holding and resets money, so anything not already converted to
  // augmentations is lost. An UNLOCK survives every install and only dies with
  // the BitNode.
  //
  // The two handle an UNKNOWN clock differently, and the asymmetry is deliberate.
  //
  // For an unlock, unknown means refuse: a $25b purchase amortized against a node
  // whose length nobody has estimated is exactly the invented payoff window this
  // codebase does not allow.
  //
  // For a position, unknown means "no install has been forecast", which is NOT
  // the same as "an install is imminent" — with nothing queued there is often no
  // install to forecast at all, and treating that as a zero horizon refuses every
  // trade for the entire run. So it falls back to one market cycle as a bounded
  // risk horizon; forecasts can change inside it, so this is not a persistence
  // guarantee. `liquidate` remains the real signal that
  // an install is coming, and it is read from progression's own phase.
  const nodeHorizonSec = usableForecastSec(ctx.horizons.node) ?? 0;
  const positionHorizonSec = usableForecastSec(ctx.horizons.install) ?? secondsForTicks(TICKS_PER_CYCLE);

  // Liquidate on install imminence, not on a cash-ratio phase; the latter does
  // not establish that conversion is close.
  // What imminence actually means is that nothing is left except the book and what
  // the book will pay for. `factions` still earning reputation, or a paid graft in
  // flight, both mean there is time to keep trading. A `stock` blocker is our own
  // book, and an `augmentations` blocker means cash can still become a permanent
  // multiplier — which is the whole reason to liquidate, so gating on it would
  // deadlock the two against each other.
  //
  // Unsure means keep trading, and that is safe rather than merely optimistic:
  // `progression` will not reset while the book is open (`stockReadyToInstall`
  // requires `plan.flat`), so an install cannot slip past an unliquidated portfolio.
  const blockers = plan?.installBlockers;
  const liquidate = plan?.liquidationWanted === true
    && blockers !== undefined
    && blockers.every((blocker) => blocker === "stock" || blocker === "augmentations");

  const nodeMults = effectiveBitNodeMultipliers(
    ctx.caps.bitNode,
    sfLevel(ctx.caps.sourceFiles, 12),
    progression?.multipliers,
  );
  const measuredIncomePerSec = measuredStockIncomePerSec(topic.portfolioCost ?? 0);
  // Contested = any money bid last pass from a feature that is neither the
  // market nor progression's own install machinery. This arms the
  // viability-floor insurance in planReserve — with no counterparty, the
  // floor's premium is unnecessary in a pure-market world.
  const moneyContested = [
    ...(ctx.state.topics.arbitration?.grants ?? []),
    ...(ctx.state.topics.arbitration?.denied ?? []),
  ].some((row) => row.resource === "money" && row.by !== "stock" && row.by !== "progression");

  return {
    symbols: (topic.positions ?? []).map((position) => ({
      sym: position.sym,
      ask: position.ask,
      bid: position.bid,
      maxShares: position.maxShares,
      shares: position.shares,
      sharesShort: position.sharesShort,
      ...(signals[position.sym]?.forecast !== undefined ? { forecast: signals[position.sym]!.forecast } : {}),
      ...(signals[position.sym]?.volatility !== undefined ? { volatility: signals[position.sym]!.volatility } : {}),
    })),
    hasTixApi: topic.hasTixApiAccess ?? false,
    has4SApi: topic.has4SDataApi ?? false,
    // Shorts require BN8 or SF8.2; emitting one without access throws inside
    // the stub and prevents lower-ranked actionable longs from being considered.
    canShort: ctx.caps.bitNode === 8 || (ctx.caps.sourceFiles["8"] ?? 0) >= 2,
    fourSigmaDisabled: ctx.caps.restrictions.disable4SData === true,
    farmableHosts: farmableHosts(ctx),
    symbolByHost: SYMBOL_BY_HOST,
    ...(nodeMults ? { nodeMults } : {}),
    totalMoney: ctx.state.topics.player?.money ?? 0,
    portfolioValue: topic.portfolioValue ?? 0,
    positionHorizonSec,
    unlockHorizonSec: nodeHorizonSec,
    liquidate,
    moneyContested,
    ...(measuredIncomePerSec !== undefined ? { measuredIncomePerSec } : {}),
  };
}

/** The market's measured rate since its first trade of this install:
 * self-tracked trade cashflow (each batch's after-minus-before, both read
 * inside the same stub) PLUS the current book at mark-to-market. Cashflow
 * alone counts an open position's purchase as money gone, so mid-hold it
 * reads deeply negative exactly while the strategy is working; adding the
 * book back makes the number the market's total wealth contribution per second.
 * Do not combine the 2-minute money-sources probe with a live portfolio value;
 * their sampling times differ. Undefined until positive over a positive
 * interval, so a losing or not-yet-traded book uses closed-form expectations. */
function measuredStockIncomePerSec(portfolioCost: number): number | undefined {
  const ledger = flows();
  if (ledger.tradeFlowSince === undefined) return undefined;
  // Cost basis rather than mark-to-market, matching earnedSinceInstall: the
  // realized-net series is unmoved by opening a position and by price wobble,
  // so the reserve's measured rate cannot vanish mid-hold.
  const contributed = ledger.tradeCashFlow + Math.max(0, portfolioCost);
  if (!(contributed > 0)) return undefined;
  const elapsedSec = Math.max(0, (Date.now() - ledger.tradeFlowSince) / 1_000);
  return elapsedSec > 0 ? contributed / elapsedSec : undefined;
}

async function execute(ctx: DriverContext, actions: StockAction[]): Promise<void> {
  if (actions.length === 0) return;
  const at = Date.now();
  // `getPosition` is read HERE rather than taken from the topic: each trade
  // changes both the money and the position the next one sees, and the position
  // topic is up to 30 s stale. Reading it live is what makes a buy idempotent —
  // without it the 4 s driver re-bought the same symbol until the probe caught
  // up, paying a fresh $100k entry commission each time. Cash is read before
  // and after each trade for the same reason: the whole batch runs on one
  // resident, so the two reads bracket exactly this batch's own movement.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/data/Constants.ts#L3-L12
  const out: string[] = [];
  const touched = new Set<string>();
  const access: Partial<Pick<StockState, "hasTixApiAccess" | "has4SDataApi">> = {};
  const cashBefore = await ctx.nsp("getServerMoneyAvailable", "home");
  // Trade-only cash movement, measured around each buy/sell. Gating the whole
  // batch on "no unlock present" instead dropped the trade's cost from the
  // cashflow while the position's cost basis still entered portfolioCost — a
  // PERMANENT +cost skew in earnedSinceInstall for every mixed unlock+trade
  // batch, not the "one lost sample" it looked like.
  let tradeDelta = 0;
  let ok = true;
  for (const action of actions) {
    switch (action.type) {
      case "buyTix": {
        const bought = await ctx.nsp("stock.purchaseTixApi");
        if (bought) access.hasTixApiAccess = true;
        else ok = false;
        out.push(bought ? "bought TIX API" : "TIX refused");
        break;
      }
      case "buy4SApi": {
        const bought = await ctx.nsp("stock.purchase4SMarketDataTixApi");
        if (bought) access.has4SDataApi = true;
        else ok = false;
        out.push(bought ? "bought 4S API" : "4S API refused");
        break;
      }
      case "buy": {
        touched.add(action.sym);
        const [long, , short] = await ctx.nsp("stock.getPosition", action.sym);
        const held = action.short ? short : long;
        const opposite = action.short ? long : short;
        if (held > 0) {
          out.push(`already holding ${action.sym}`);
          break;
        }
        if (opposite > 0) {
          ok = false;
          out.push(`opposite ${action.sym} position already held`);
          break;
        }
        const before = await ctx.nsp("getServerMoneyAvailable", "home");
        const price = action.short
          ? await ctx.nsp("stock.buyShort", action.sym, action.shares)
          : await ctx.nsp("stock.buyStock", action.sym, action.shares);
        tradeDelta += await ctx.nsp("getServerMoneyAvailable", "home") - before;
        if (!(price > 0)) ok = false;
        out.push(price > 0 ? `bought ${action.shares} ${action.sym}` : `buy ${action.sym} refused`);
        break;
      }
      case "sell": {
        touched.add(action.sym);
        // Sell what is actually there: the plan was formed against a stale
        // snapshot. Upstream clamps an oversized sale to the live holding and
        // refuses a zero-share sale; reading the holding here also lets us
        // distinguish "already flat" from a generic refusal.
        // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/BuyingAndSelling.tsx#L139-L168 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/BuyingAndSelling.tsx#L316-L344
        const [long, , short] = await ctx.nsp("stock.getPosition", action.sym);
        const held = Math.min(action.shares, action.short ? short : long);
        if (held <= 0) {
          out.push(`${action.sym} already flat`);
          break;
        }
        const before = await ctx.nsp("getServerMoneyAvailable", "home");
        const price = action.short
          ? await ctx.nsp("stock.sellShort", action.sym, held)
          : await ctx.nsp("stock.sellStock", action.sym, held);
        tradeDelta += await ctx.nsp("getServerMoneyAvailable", "home") - before;
        if (!(price > 0)) ok = false;
        out.push(price > 0 ? `sold ${held} ${action.sym}` : `sell ${action.sym} refused`);
        break;
      }
    }
  }
  const holdings: Record<string, [number, number, number, number]> = {};
  for (const sym of touched) holdings[sym] = await ctx.nsp("stock.getPosition", sym);
  const cash = await ctx.nsp("getServerMoneyAvailable", "home");
  // Advance the held balance now, exactly as executeInfrastructure does after
  // a purchase: the stub read the REAL post-trade cash, and the player topic's
  // sweep sample is up to seconds stale. Without this, a sale's proceeds land
  // in the arbiter's pool while this feature's own next plan still reads the
  // pre-sale pocket change — too small to post the working-capital reserve —
  // and the passes before the sweep catches up allow another standing claim
  // to spend the released bankroll.
  if (ctx.state.topics.player) {
    merge(ctx.state, "player", { money: cash });
  }
  // Unlock purchases (TIX/4S) are spends, not trading cashflow. The
  // trade-only delta was measured around each buy/sell, so a mixed batch
  // (fundedActions concatenates the funded claims) records its trades exactly
  // and the remainder of the batch's cash movement is the unlock spend —
  // which earnedSinceInstall must still count, because the game's own ledger
  // debits unlocks under the "stock" source the correction strips out.
  const traded = actions.some((action) => action.type === "buy" || action.type === "sell");
  const unlocked = actions.some(
    (action) => action.type === "buyTix" || action.type === "buy4SApi",
  );
  const ledger = flows();
  if (traded) {
    ledger.tradeCashFlow += tradeDelta;
    ledger.tradeFlowSince ??= at;
  }
  if (unlocked) {
    ledger.unlockSpend += Math.max(0, cashBefore - cash + tradeDelta);
  }
  const positions = (ctx.state.topics.stock?.positions ?? []).map((position) => {
    const current = holdings[position.sym];
    if (!current) return position;
    const [shares, avgPx, sharesShort, avgPxShort] = current;
    return {
      ...position,
      shares,
      avgPx,
      sharesShort,
      avgPxShort,
      value: shares * position.bid + sharesShort * (2 * avgPxShort - position.ask),
      costBasis: shares * avgPx + sharesShort * avgPxShort,
    };
  });
  const portfolioValue = positions.reduce((sum, position) => sum + position.value, 0);
  merge(ctx.state, "stock", {
    ...access,
    tradeCashFlow: ledger.tradeCashFlow,
    unlockSpend: ledger.unlockSpend,
    wealth: cash + portfolioValue,
    ...(Object.keys(holdings).length > 0 ? {
      positions,
      portfolioValue,
      portfolioCost: positions.reduce((sum, position) => sum + position.costBasis, 0),
    } : {}),
  });
  lastResult = { action: actions[0]!.type, ok, detail: out.join("; "), at };
}

const driver: FeatureDriver = {
  id: "stock",
  everyMs: 500,
  async tick(ctx: DriverContext) {
    const view = buildView(ctx);
    if (!view) return;
    const decision = stepStock(view, memory);
    memory = decision.memory;
    lastPlan = decision.plan;

    const actions = fundedActions(decision.plan, stockGrants(decision.plan, ctx));
    merge(ctx.state, "stock", {
      market: {
        tick: decision.plan.observedTicks,
        ...(decision.plan.ticksUntilCycle !== undefined ? { ticksUntilCycle: decision.plan.ticksUntilCycle } : {}),
        cyclesSeen: memory.history.cyclesSeen,
        lastFlipCount: memory.history.lastFlipCount,
        ...(memory.history.lastV !== undefined ? { lastV: memory.history.lastV } : {}),
      },
      manipulation: manipulationDigest(decision.plan),
      plan: planDigest(decision.plan, actions, view),
    });

    try {
      await execute(ctx, actions);
    } catch (error) {
      if (isScriptDeath(error)) throw error;
      lastResult = { action: "trade", ok: false, detail: String(error), at: Date.now() };
    }
  },
};

function manipulationDigest(plan: StockPlan): Record<string, StockManipulation> {
  const byHost = manipulationByHost(plan.manipulation);
  const out: Record<string, StockManipulation> = {};
  for (const [hostname, intent] of Object.entries(byHost)) {
    out[hostname] = {
      sym: intent.sym,
      side: intent.side,
      valuePerOp: intent.valuePerOp,
      notional: intent.notional,
    };
  }
  return out;
}

function planDigest(
  plan: StockPlan,
  actions: readonly StockAction[],
  view: Pick<StockView, "liquidate" | "positionHorizonSec" | "unlockHorizonSec">,
): StockPlanDigest {
  const liquidate = view.liquidate;
  return {
    horizons: { positionSec: view.positionHorizonSec, unlockSec: view.unlockHorizonSec },
    actions: actions.map((action) => ({
      type: action.type,
      ...(action.type === "buy" || action.type === "sell" ? { sym: action.sym, shares: action.shares, short: action.short } : {}),
      ...(action.type === "buy4SApi" ? { cost: action.cost } : {}),
    })),
    ranked: plan.ranked.slice(0, 8).map((entry) => ({
      sym: entry.sym,
      side: entry.side,
      forecast: entry.forecast,
      volatility: entry.volatility,
      exact: entry.exact,
      manipulable: entry.manipulable,
      breakEvenTicks: Number.isFinite(entry.breakEvenTicks) ? entry.breakEvenTicks : -1,
      expectedProfit: entry.expectedProfit,
    })),
    ...(plan.entry
      ? {
          entry: {
            sym: plan.entry.sym,
            side: plan.entry.side,
            shares: plan.entry.shares,
            cost: plan.entry.cost,
            expectedProfit: plan.entry.expectedProfit,
            holdTicks: plan.entry.holdTicks,
            breakEvenTicks: plan.entry.breakEvenTicks,
          },
        }
      : {}),
    ...(plan.unlock
      ? {
          unlock: {
            type: plan.unlock.action.type,
            cost: plan.unlock.cost,
            investmentCost: plan.unlock.investmentCost,
            gainPerSec: plan.unlock.gainPerSec,
            paybackSec: plan.unlock.paybackSec,
            netOverHorizon: plan.unlock.netOverHorizon,
          },
        }
      : {}),
    ...(plan.reserve ? { reserve: plan.reserve } : {}),
    flat: plan.flat,
    // Published because `factions` has to tell a liquidation that is actually
    // HAPPENING from a book that merely exists: it waits for the proceeds before
    // committing a purchase order, and waiting on money nobody is converting is a
    // livelock rather than patience.
    liquidate,
    ...(lastResult ? { lastResult } : {}),
  };
}

/** Claims are posted from the PUBLISHED PLAN, never from what was executed last
 * pass. That is the whole fix for the deadlock: `stepStock` sizes an entry with
 * no reference to the grant, so a claim exists on the very first pass and the
 * grant it wins funds the same entry on the next one. */
function claims(ctx: ClaimContext): Claim[] {
  const plan = lastPlan;
  const out: Claim[] = [];
  if (!plan) return out;

  if (plan.unlock) {
    out.push({
      by: "stock",
      id: unlockClaimId(plan.unlock.action),
      resource: "money",
      amount: plan.unlock.cost,
      priority: PRIORITY["income:investment"],
      mode: "spend",
      // Indivisible: half a TIX API is nothing. Unlike a position, there is no
      // smaller version of this purchase.
      shape: "step",
      pricing: "economic",
      value: moneyStepValue(ctx.state, plan.unlock.gainPerSec, ctx.now),
      ratePerSec: plan.unlock.gainPerSec,
      returnPerDollarSec: plan.unlock.gainPerSec / Math.max(1, plan.unlock.investmentCost),
    });
  }

  if (plan.entry) {
    const holdSec = Math.max(1, secondsForTicks(plan.entry.holdTicks));
    out.push({
      by: "stock",
      id: POSITION_CLAIM_ID,
      resource: "money",
      amount: plan.entry.cost,
      // Stocks, market unlocks and every other income investment share one
      // band. The arbiter compares their marginal return; BN8 needs no priority
      // override because competing income returns are naturally near zero.
      priority: PRIORITY["income:investment"],
      mode: "spend",
      // Divisible: a position is continuous, and fundedActions re-checks that
      // the reduced size still clears its round trip before buying it.
      shape: "continuous",
      ratePerSec: plan.entry.expectedProfit / holdSec,
      returnPerDollarSec:
        plan.entry.expectedProfit / (Math.max(1, plan.entry.cost) * holdSec),
    });
  }
  if (plan.reserve) {
    // The standing working-capital reserve, ALWAYS posted alongside whatever
    // else the plan claims: the entry claim defends its own cost and this
    // defends the rest of the bankroll (including the book about to become
    // sale proceeds). The arbiter's auction — via valueCurve — decides each
    // pass whether the market's expected return still beats every other
    // bidder for the cash. `mode: "reserve"` sequesters, it never spends —
    // the money is simply still there when an entry clears its gates.
    // The rate is refreshed HERE, at the auction boundary, not taken from the
    // plan alone: claims are collected from `lastPlan`, up to one driver tick
    // stale, and a sale's realized profit raises the MEASURED income in the
    // same pass its proceeds enter the pool — a reserve bidding the pre-sale
    // rate against post-sale income undervalues the claim for that window.
    // NOTE: this narrows the window but does not close it — bn8-manipulation
    // seed 2 still loses one $318m rung auction at a sale boundary
    // (byte-identical with and without the refresh), so the remaining gap is
    // upstream of the rate: the arbitration that grants the rung sees a pool
    // with the proceeds while some input still predates them. That single
    // marginal purchase (the run stays above the node grant) is the tuning
    // step's open case, with the lane as its instrument.
    const rate = Math.max(
      plan.reserve.ratePerSec,
      measuredStockIncomePerSec(ctx.state.topics.stock?.portfolioCost ?? 0) ?? 0,
    );
    out.push({
      by: "stock",
      id: WORKING_CAPITAL_CLAIM_ID,
      resource: "money",
      amount: plan.reserve.amount,
      priority: PRIORITY["income:investment"],
      mode: "reserve",
      shape: "continuous",
      ratePerSec: rate,
      returnPerDollarSec: rate / Math.max(1, plan.reserve.amount),
    });
  }
  return out;
}

/** A position's expected profit is linear in deployed dollars at the selected
 * symbol/side. Convert that $/sec/$ slope to BN-sec/$ with progression's
 * measured money-rate marginal. An absent rate stays absent; a measured zero
 * returns a real zero-value curve. */
function valueCurve(claim: Claim, ctx: ClaimContext): ClaimValueCurve | undefined {
  if (
    (claim.id !== POSITION_CLAIM_ID && claim.id !== WORKING_CAPITAL_CLAIM_ID)
    || claim.resource !== "money"
    || claim.shape !== "continuous"
  ) return undefined;
  if (!(claim.amount > 0)) return { demandAt: () => 0 };
  const marginalIncomePerDollar = (claim.ratePerSec ?? 0) / claim.amount;
  const value = moneyRateValue(ctx.state, marginalIncomePerDollar, ctx.now);
  if (value.state === "unknown") return undefined;
  // A zero marginal is evidence for zero demand, not an absent measurement and
  // not linearValueCurve(0), whose inclusive lambda=0 boundary means "take all".
  if (!(value.value > 0)) return { demandAt: () => 0 };
  if (claim.id === WORKING_CAPITAL_CLAIM_ID) {
    // Working capital is NOT flat-marginal: the closed form the rate itself
    // comes from has two fixed $100k commissions per round trip, so the rate
    // reaches zero at a computable bankroll floor — below it the market can
    // never rebuild, and in a node with no other income that is the end of
    // the economy, not a reallocation. Price
    // the q-th dollar hyperbolically against that floor: the marginal at the
    // full amount is the measured average, and it rises toward
    // value x (1 + amount/floor) as the remaining capital approaches the
    // floor — so taking the LAST viable dollars must out-bid the whole
    // enterprise, by the model's own arithmetic rather than a veto.
    const floor = blindViableBankroll();
    if (Number.isFinite(floor) && floor > 0) {
      const amount = claim.amount;
      const v = value.value;
      return {
        marginalValueAt: (granted: number) =>
          v * (floor + amount) / (floor + Math.min(Math.max(0, granted), amount)),
      };
    }
  }
  return linearValueCurve(value.value, claim.amount);
}

export const stockModule: FeatureModule = {
  driver,
  reset: (state) => {
    resetStockState();
    // Positions, prices, account flags and the recovered market clock from the
    // ended node.
    delete state.topics.stock;
  },
  claims,
  valueCurve,
};
