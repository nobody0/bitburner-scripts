import type { NS } from "@ns";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { usableForecastSec } from "../../../shared/strategy/progression/forecast.ts";
import { manipulationLeverage, secondsForTicks, TICKS_PER_CYCLE } from "../../../shared/strategy/stock/market.ts";
import {
  fundedActions,
  initStockMemory,
  manipulationByHost,
  POSITION_CLAIM_ID,
  stepStock,
  symbolForHost,
  unlockClaimId,
  type StockAction,
  type StockGrants,
  type StockMemory,
  type StockPlan,
  type StockView,
} from "../../../shared/strategy/stock/decide.ts";
import { resetHistory } from "../../../shared/strategy/stock/history.ts";
import type { StockManipulation, StockPlan as StockPlanDigest } from "../../../shared/telemetry/topics/stock.ts";
import { isScriptDeath } from "../errors.ts";
import { merge } from "../state.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

/** The stock driver.
 *
 * Degrades honestly at three levels, because the game gates them separately and
 * every one of them is bought with MONEY rather than granted by a source file: a
 * WSE account ($200m) shows prices, the TIX API ($5b) allows positions, and the
 * 4S Market Data TIX API ($25b x the node's multiplier) supplies the exact
 * forecast. Nothing here is capability-gated, which is why `stock` is an
 * always-playable feature and the ladder is the driver's own job.
 *
 * Cadence is 4 s and that is load-bearing, not a preference: the market updates
 * every 6 s (4 s while burning stored cycles) and the whole no-4S signal —
 * measured volatility, estimated forecast, and the cycle clock — comes from
 * observing every tick exactly once. A poller slower than the tick cannot count
 * up-ticks and cannot see the cycle. It must also be no slower than the price
 * probe, which declares the same 4 s, or a tick the probe captured would be
 * overwritten before we folded it into the history. `observeMarket` is idempotent
 * when nothing moved, so sampling the same tick twice costs nothing.
 *
 * The plan/fund split is the other structural rule. `stepStock` sizes a position
 * at full ambition with NO knowledge of the money grant, the claim is posted from
 * that plan, and only then does `fundedActions` cut it to what was granted.
 * Deriving the plan from the grant is circular — no plan, no claim, no grant, no
 * plan — and that circle is why the previous version never placed a trade. */

/** Worst single dodge step this feature needs, priced from the ns costs rather
 * than guessed (`GetStock` 2 GB, `BuySellStock` 2.5 GB):
 *
 *  - the ACTION batch, at 12 GB: `getPosition` 2 (read inside the trade, so a
 *    buy is idempotent) + `sellStock` 2.5 + `sellShort` 2.5 + one of
 *    `buyStock`/`buyShort` 2.5 + one unlock purchase 2.5. Only one entry side and
 *    one unlock can appear in a plan, which is what bounds it here;
 *  - `stock.tick`, at 10 GB: `getSymbols` + `getAskPrice` + `getBidPrice` +
 *    `getPosition` + `getMaxShares`;
 *  - `stock.forecast`, at 7 GB, and `stock.account` at 0.2 GB.
 *
 * The old declaration was 8 GB, which under-priced the 11.5 GB forecast probe of
 * the time — a home reserve too small for the step it was reserving for. */
const PEAK_STEP_GB = 12;

let memory: StockMemory = initStockMemory();
let lastPlan: StockPlan | undefined;
let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;

export function resetStockState(): void {
  // An install re-rolls every symbol's price, cap, spread and volatility
  // (prestigeAugmentation -> initStockMarket), so a surviving history describes
  // a market that no longer exists, and a surviving intent commits us to a side
  // of a position that was destroyed.
  resetHistory(memory.history);
  memory = initStockMemory();
  lastPlan = undefined;
  lastResult = undefined;
}

/** Exposed for the simulator's strategy tests, which drive the solver directly
 *  against the vendored market without going through a controller pass. */
export function stockMemory(): StockMemory {
  return memory;
}

/** Hosts the farm could actually drive right now — the other half of the
 * manipulation loop.
 *
 * `hacking` prices price impact into its target score, but only for a symbol
 * `stock` already holds. So if `stock` picks on pure edge and lands on a megacorp
 * whose server is out of skill range, the tie-in never engages: the first
 * end-to-end BN8 run held three megacorps, landed 380 grows, and moved no price
 * at all. Reading the same server snapshot the dispatcher does closes it.
 *
 * The same three conditions the target evaluator uses (`isCandidate` plus a skill
 * check), because a host that fails any of them cannot carry an influencing op. */
function farmableHosts(ctx: DriverContext): string[] {
  const servers = ctx.state.topics.servers;
  const skill = ctx.state.topics.player?.skills.hacking ?? 0;
  if (!servers) return [];
  const out: string[] = [];
  for (const server of Object.values(servers)) {
    if (!server.hasAdminRights || server.purchasedByPlayer) continue;
    if ((server.moneyMax ?? 0) <= 0) continue;
    if ((server.requiredHackingSkill ?? Infinity) > skill) continue;
    if (symbolForHost(server.hostname) === undefined) continue;
    out.push(server.hostname);
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
  // trade for the entire run. So it falls back to one regime cycle, which is not
  // a guess about installs but a fact about the MARKET: the forecast a position is
  // opened on is only known to hold until the next cycle boundary, and the solver
  // already caps the hold there anyway. `liquidate` remains the real signal that
  // an install is coming, and it is read from progression's own phase.
  const nodeHorizonSec = usableForecastSec(ctx.horizons.node) ?? 0;
  const positionHorizonSec = usableForecastSec(ctx.horizons.install) ?? secondsForTicks(TICKS_PER_CYCLE);

  // Liquidate on IMMINENCE, not on phase.
  //
  // THE BUG this replaces: `plan.phase === "ending"`. That phase is an economic
  // test — `money > earnedThisRun / 2` with something queued — not a statement that
  // an install is close. On a real BN1 run with $72t banked and a Daedalus route
  // ~525h out it latched on the first tick and never cleared: 9811 progression
  // records, every one of them "ending", and the market sat flat the entire run
  // refusing FSIG at a 0.673 forecast and a 3.4-tick break-even. The phase is the
  // ANNOUNCEMENT that conversion is coming; it is not the moment to convert.
  //
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
  const liquidate = plan?.installWanted === true
    && blockers !== undefined
    && blockers.every((blocker) => blocker.kind === "stock" || blocker.kind === "augmentations");
  const liquidateWhy = "every barrier except the book itself is clear — an install is next";

  const nodeMults = effectiveBitNodeMultipliers(
    ctx.caps.bitNode,
    sfLevel(ctx.caps.sourceFiles, 12),
    progression?.multipliers,
  );

  return {
    symbols: (topic.positions ?? []).map((position) => ({
      sym: position.sym,
      ask: position.ask,
      bid: position.bid,
      maxShares: position.maxShares,
      shares: position.shares,
      avgPx: position.avgPx,
      sharesShort: position.sharesShort,
      avgPxShort: position.avgPxShort,
      ...(signals[position.sym]?.forecast !== undefined ? { forecast: signals[position.sym]!.forecast } : {}),
      ...(signals[position.sym]?.volatility !== undefined ? { volatility: signals[position.sym]!.volatility } : {}),
    })),
    hasWseAccount: topic.hasWseAccount ?? false,
    hasTixApi: topic.hasTixApiAccess ?? false,
    has4SApi: topic.has4SDataApi ?? false,
    // Shorts are BN8 or SF8.2. Emitting one without them throws inside the stub,
    // and the old code did exactly that on every tick a bearish symbol topped
    // the ranking, which blocked every long ranked below it.
    canShort: ctx.caps.bitNode === 8 || (ctx.caps.sourceFiles["8"] ?? 0) >= 2,
    fourSigmaDisabled: ctx.caps.restrictions.disable4SData === true,
    farmableHosts: farmableHosts(ctx),
    ...(nodeMults ? { nodeMults } : {}),
    moneyGranted: ctx.grants.money,
    totalMoney: ctx.state.topics.player?.money ?? 0,
    portfolioValue: topic.portfolioValue ?? 0,
    positionHorizonSec,
    unlockHorizonSec: nodeHorizonSec,
    liquidate,
    ...(liquidate ? { liquidateWhy } : {}),
  };
}

async function execute(ctx: DriverContext, actions: StockAction[], claimId: string): Promise<void> {
  if (actions.length === 0) return;
  const methods = stockMethods(actions);
  const at = Date.now();
  // Every action in ONE stub, and `getPosition` inside it: each trade changes
  // both the money and the position the next one sees, and the position topic is
  // up to 30 s stale. Reading it here is what makes a buy idempotent — without
  // it the 4 s driver re-bought the same symbol until the probe caught up,
  // paying a fresh $200k commission each time.
  //
  // `claimId` is built from the full PLANNED set, not the funded subset:
  // claims() posted the RAM claim under the planned set's id and featureDodge
  // looks the grant up by exact id, so an id derived from `actions` would miss
  // the grant whenever funding trimmed the batch.
  const outcome = await featureDodge(ctx, "stock", claimId, methods, (stubNs: NS) => {
    const out: string[] = [];
    const touched = new Set<string>();
    for (const action of actions) {
      switch (action.type) {
        case "buyWse":
          out.push(stubNs["stock"]["purchaseWseAccount"]() ? "bought WSE account" : "WSE refused");
          break;
        case "buyTix":
          out.push(stubNs["stock"]["purchaseTixApi"]() ? "bought TIX API" : "TIX refused");
          break;
        case "buy4SApi":
          out.push(stubNs["stock"]["purchase4SMarketDataTixApi"]() ? "bought 4S API" : "4S API refused");
          break;
        case "buy": {
          touched.add(action.sym);
          const [long, , short] = stubNs["stock"]["getPosition"](action.sym as never);
          const held = action.short ? short : long;
          if (held > 0) {
            out.push(`already holding ${action.sym}`);
            break;
          }
          const price = action.short
            ? stubNs["stock"]["buyShort"](action.sym as never, action.shares)
            : stubNs["stock"]["buyStock"](action.sym as never, action.shares);
          out.push(price > 0 ? `bought ${action.shares} ${action.sym}` : `buy ${action.sym} refused`);
          break;
        }
        case "sell": {
          touched.add(action.sym);
          // Sell what is actually there: the plan was formed against a stale
          // snapshot, and selling more than we hold is silently clamped upstream
          // but selling a position that already closed pays commission for
          // nothing.
          const [long, , short] = stubNs["stock"]["getPosition"](action.sym as never);
          const held = Math.min(action.shares, action.short ? short : long);
          if (held <= 0) {
            out.push(`${action.sym} already flat`);
            break;
          }
          const price = action.short
            ? stubNs["stock"]["sellShort"](action.sym as never, held)
            : stubNs["stock"]["sellStock"](action.sym as never, held);
          out.push(price > 0 ? `sold ${held} ${action.sym}` : `sell ${action.sym} refused`);
          break;
        }
      }
    }
    return {
      detail: out,
      holdings: Object.fromEntries([...touched].map((sym) => [sym, stubNs["stock"]["getPosition"](sym as never)])),
    };
  });
  if (!outcome.ok) {
    lastResult = { action: actions[0]!.type, ok: false, detail: outcome.reason, at };
    return;
  }
  const holdings = outcome.value.holdings as Record<string, [number, number, number, number]>;
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
  if (Object.keys(holdings).length > 0) {
    merge(ctx.state, "stock", {
      positions,
      portfolioValue: positions.reduce((sum, position) => sum + position.value, 0),
      portfolioCost: positions.reduce((sum, position) => sum + position.costBasis, 0),
    });
  }
  lastResult = { action: actions[0]!.type, ok: true, detail: outcome.value.detail.join("; "), at };
}

const driver: FeatureDriver = {
  id: "stock",
  everyMs: 4_000,
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
      plan: planDigest(decision.plan, actions, view.liquidate),
    });

    try {
      await execute(ctx, actions, stockClaimId(wantedActions(decision.plan)));
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
      why: intent.why,
    };
  }
  return out;
}

function planDigest(plan: StockPlan, actions: readonly StockAction[], liquidate: boolean): StockPlanDigest {
  return {
    actions: actions.map((action) => ({ type: action.type, why: action.why })),
    ranked: plan.ranked.slice(0, 8).map((entry) => ({
      sym: entry.sym,
      side: entry.side,
      forecast: entry.forecast,
      volatility: entry.volatility,
      exact: entry.exact,
      breakEvenTicks: Number.isFinite(entry.breakEvenTicks) ? entry.breakEvenTicks : -1,
      expectedProfit: entry.expectedProfit,
      why: entry.why,
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
            gainPerSec: plan.unlock.gainPerSec,
            paybackSec: plan.unlock.paybackSec,
            netOverHorizon: plan.unlock.netOverHorizon,
            why: plan.unlock.why,
          },
        }
      : {}),
    flat: plan.flat,
    // Published because `factions` has to tell a liquidation that is actually
    // HAPPENING from a book that merely exists: it waits for the proceeds before
    // committing a purchase order, and waiting on money nobody is converting is a
    // livelock rather than patience.
    liquidate,
    why: plan.why,
    ...(plan.hold ? { hold: plan.hold } : {}),
    ...(plan.blocker ? { blocker: plan.blocker } : {}),
    ...(lastResult ? { lastResult } : {}),
  };
}

/** Claims are posted from the PUBLISHED PLAN, never from what was executed last
 * pass. That is the whole fix for the deadlock: `stepStock` sizes an entry with
 * no reference to the grant, so a claim exists on the very first pass and the
 * grant it wins funds the same entry on the next one. */
/** The full planned action set — what claims() prices the RAM claim from, and
 * therefore the set execute()'s claim id must be derived from too. */
function wantedActions(plan: StockPlan): StockAction[] {
  return [
    ...plan.exits,
    ...(plan.unlock ? [plan.unlock.action] : []),
    ...(plan.entry
      ? [{ type: "buy" as const, sym: plan.entry.sym, shares: plan.entry.shares, short: plan.entry.side === "short", why: plan.entry.why }]
      : []),
  ];
}

function claims(ctx: ClaimContext): Claim[] {
  const plan = lastPlan;
  const out: Claim[] = [];
  if (!plan) return out;

  const wanted = wantedActions(plan);
  const methods = stockMethods(wanted);
  if (methods.length > 0) {
    out.push(actionRamClaim(ctx, "stock", stockClaimId(wanted), methods, "stock action batch"));
  }

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
      divisible: false,
      ratePerSec: plan.unlock.gainPerSec,
      returnPerDollarSec: plan.unlock.gainPerSec / Math.max(1, plan.unlock.cost),
      why: plan.unlock.why,
    });
  }

  if (plan.entry) {
    const leverage = manipulationLeverage(effectiveBitNodeMultipliers(
      ctx.caps.bitNode,
      sfLevel(ctx.caps.sourceFiles, 12),
      ctx.state.topics.progression?.multipliers,
    ));
    out.push({
      by: "stock",
      id: POSITION_CLAIM_ID,
      resource: "money",
      amount: plan.entry.cost,
      // In a node where hacked money arrives at zero value (BN8's
      // ScriptHackMoneyGain: 0) the market is not one income source among
      // several, it is the ONLY one, and a hacknet upgrade must not outbid it.
      // The augmentation fund still wins — in BN8 as everywhere else, the money
      // exists to become permanent multipliers.
      priority: Number.isFinite(leverage) ? PRIORITY["stock:position"] : PRIORITY["stock:sole-income"],
      mode: "spend",
      // Divisible: a position is continuous, and fundedActions re-checks that
      // the reduced size still clears its round trip before buying it.
      divisible: true,
      ratePerSec: plan.entry.expectedProfit / Math.max(1, plan.entry.holdTicks * 6),
      why: plan.entry.why,
    });
  }
  return out;
}

function stockClaimId(actions: readonly StockAction[]): string {
  return `action:${[...new Set(actions.map((action) =>
    action.type === "buy" || action.type === "sell" ? `${action.type}:${action.short ? "short" : "long"}` : action.type,
  ))].sort().join("+")}`;
}

function stockMethods(actions: readonly StockAction[]): readonly string[] {
  const methods = new Set<string>();
  for (const action of actions) {
    switch (action.type) {
      case "buyWse":
        methods.add("stock.purchaseWseAccount");
        break;
      case "buyTix":
        methods.add("stock.purchaseTixApi");
        break;
      case "buy4SApi":
        methods.add("stock.purchase4SMarketDataTixApi");
        break;
      case "buy":
        methods.add("stock.getPosition");
        methods.add(action.short ? "stock.buyShort" : "stock.buyStock");
        break;
      case "sell":
        methods.add("stock.getPosition");
        methods.add(action.short ? "stock.sellShort" : "stock.sellStock");
        break;
    }
  }
  return [...methods];
}

/** The plan, for the simulator's strategy tests and the UI's replay. */
export function stockPlan(): StockPlan | undefined {
  return lastPlan;
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
  peakStepGb: PEAK_STEP_GB,
};
