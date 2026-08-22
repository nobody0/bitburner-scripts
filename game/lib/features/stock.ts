import type { NS } from "@ns";
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
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { FeatureClaim } from "./claims.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

/** The stock driver.
 *
 * Degrades honestly at three levels, because the game gates them separately and
 * the first two may also be granted by BN8/SF8: a WSE account ($200m) exposes
 * the exchange UI, the TIX API ($5b) allows scripted positions, and the
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
 * Deriving the plan from the grant is circular — no plan, no claim, no grant, no
 * plan — and that circle is why the previous version never placed a trade. */

/** Worst single dodge step this feature needs, priced from the ns costs rather
 * than guessed (`GetStock` 2 GB, `BuySellStock` 2.5 GB):
 *
 *  - the ACTION batch, at 12.1 GB: `getPosition` 2 (read inside the trade, so a
 *    buy is idempotent) + `sellStock` 2.5 + `sellShort` 2.5 + one of
 *    `buyStock`/`buyShort` 2.5 + one unlock purchase 2.5. Only one entry side and
 *    one unlock can appear in a plan, which is what bounds it here, plus the
 *    0.1 GB cash read that keeps wealth coherent;
 *  - `stock.tick`, at 10.1 GB: `getSymbols` + `getAskPrice` + `getBidPrice` +
 *    `getPosition` + `getMaxShares` + the same cash read;
 *  - `stock.forecast`, at 7 GB, and `stock.account` at 0.2 GB.
 *
 * The old declaration was 8 GB, which under-priced the 11.5 GB forecast probe of
 * the time — a home reserve too small for the step it was reserving for. */

let memory: StockMemory = initStockMemory();
let lastPlan: StockPlan | undefined;
let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;
/** Cumulative cash moved by OUR trades — each batch's (after − before), both
 * read inside the same dodge stub, so the two samples cannot skew. Together
 * with the live book this is the market's measured wealth contribution:
 * `tradeCashFlow + portfolioValue` = realized net + mark-to-market, with no
 * dependency on the 2-minute money-sources probe whose stale mid-hold
 * snapshots read deeply negative exactly while the strategy is working. */
let tradeCashFlow = 0;
let tradeFlowSince: number | undefined;
/** Cumulative cash spent on unlock purchases (WSE/TIX/4S) since the install.
 * Tracked apart from `tradeCashFlow` because the two feed different consumers:
 * the trading RATE must exclude unlocks (a $25b purchase is not a trading
 * loss), while cumulative EARNINGS must still count the spend — the game's
 * own ledger records unlocks under the "stock" source, so the correction in
 * earnedSinceInstall would otherwise erase them entirely. */
let unlockSpend = 0;

export function resetStockState(): void {
  // An install re-rolls every symbol's price, cap, spread and volatility
  // (prestigeAugmentation -> initStockMarket), so a surviving history describes
  // a market that no longer exists, and a surviving intent commits us to a side
  // of a position that was destroyed.
  memory = initStockMemory();
  lastPlan = undefined;
  lastResult = undefined;
  tradeCashFlow = 0;
  tradeFlowSince = undefined;
  unlockSpend = 0;
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
 * check), because a host that fails any of them cannot carry an influencing op.
 *
 * WHICH host carries which symbol is NOT one of those conditions. It is a
 * constant — a server's organization is fixed in the game's own server table,
 * and so is a stock's — and `shared/features/stocks.ts` already says so: the
 * mapping is "computed here rather than through the public
 * `ns.stock.getOrganization` API in production". `SYMBOL_BY_HOST` is that
 * constant, and `sim/tests/stock-parity.test.ts` pins it against the vendored
 * `SERVER_METADATA.org`.
 *
 * This used to re-derive it every pass anyway, from the live server topic joined
 * against a `stock.organizations` probe — an `Object.values(servers)` scan plus
 * a Map build at controller cadence, for an answer that cannot change. The probe
 * existed only to feed that join, and paid `getOrganization` RAM for data the
 * bundle ships, which is exactly what the `stock.forecast` probe already refuses
 * to do; it is gone. Only the FARMABLE half is dynamic, and it now walks the 33
 * hosts that carry a symbol rather than the whole network. */
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
  // trade for the entire run. So it falls back to one regime cycle, which is not
  // a guess about installs but a fact about the MARKET: the forecast a position is
  // opened on is only known to hold until the next cycle boundary, and the solver
  // already caps the hold there anyway. `liquidate` remains the real signal that
  // an install is coming, and it is read from progression's own phase.
  const nodeHorizonSec = usableForecastSec(ctx.horizons.node) ?? 0;
  const positionHorizonSec = usableForecastSec(ctx.horizons.install) ?? secondsForTicks(TICKS_PER_CYCLE);

  // Liquidate on IMMINENCE, not on phase.
  //
  // THE BUG this replaces: `plan.phase === "ending"`. That legacy cash-ratio
  // phase was not a statement that an install was close. On a real BN1 run
  // with $72t banked and a Daedalus route
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
  // floor's premium is pure drag on a pure-market world (measured: a 7%
  // median shortfall over the isolation ladder's hour).
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
 * book back makes the number what it claims to be — the market's total
 * wealth contribution per second. Deliberately NOT the 2-minute money-sources
 * probe: its stale mid-hold snapshots mixed with a live portfolio value made
 * the measurement vanish at precisely the post-sale pass the reserve most
 * needs it. Undefined until positive over a positive interval — a losing or
 * not-yet-traded book falls back to the solver's closed-form expectations. */
function measuredStockIncomePerSec(portfolioCost: number): number | undefined {
  if (tradeFlowSince === undefined) return undefined;
  // Cost basis rather than mark-to-market, matching earnedSinceInstall: the
  // realized-net series is unmoved by opening a position and by price wobble,
  // so the reserve's measured rate cannot vanish mid-hold.
  const contributed = tradeCashFlow + Math.max(0, portfolioCost);
  if (!(contributed > 0)) return undefined;
  const elapsedSec = Math.max(0, (Date.now() - tradeFlowSince) / 1_000);
  return elapsedSec > 0 ? contributed / elapsedSec : undefined;
}

async function execute(ctx: DriverContext, actions: StockAction[], claimId: string): Promise<void> {
  if (actions.length === 0) return;
  const methods = stockMethods(actions);
  const at = Date.now();
  // Every action in ONE stub, and `getPosition` inside it: each trade changes
  // both the money and the position the next one sees, and the position topic is
  // up to 30 s stale. Reading it here is what makes a buy idempotent — without
  // it the 4 s driver re-bought the same symbol until the probe caught up,
  // paying a fresh $100k entry commission each time.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/data/Constants.ts#L3-L12
  //
  // `claimId` is built from the full PLANNED set, not the funded subset:
  // claims() posted the RAM claim under the planned set's id and featureDodge
  // looks the grant up by exact id, so an id derived from `actions` would miss
  // the grant whenever funding trimmed the batch.
  const outcome = await featureDodge(ctx, "stock", claimId, methods, (stubNs: NS) => {
    const out: string[] = [];
    const touched = new Set<string>();
    const access: Partial<Pick<StockState, "hasWseAccount" | "hasTixApiAccess" | "has4SDataApi">> = {};
    const cashBefore = stubNs["getServerMoneyAvailable"]("home");
    // Trade-only cash movement, measured around each buy/sell inside the same
    // stub. Gating the whole batch on "no unlock present" instead dropped the
    // trade's cost from the cashflow while the position's cost basis still
    // entered portfolioCost — a PERMANENT +cost skew in earnedSinceInstall for
    // every mixed unlock+trade batch, not the "one lost sample" it looked like.
    let tradeDelta = 0;
    for (const action of actions) {
      switch (action.type) {
        case "buyWse": {
          const bought = stubNs["stock"]["purchaseWseAccount"]();
          if (bought) access.hasWseAccount = true;
          out.push(bought ? "bought WSE account" : "WSE refused");
          break;
        }
        case "buyTix": {
          const bought = stubNs["stock"]["purchaseTixApi"]();
          if (bought) access.hasTixApiAccess = true;
          out.push(bought ? "bought TIX API" : "TIX refused");
          break;
        }
        case "buy4SApi": {
          const bought = stubNs["stock"]["purchase4SMarketDataTixApi"]();
          if (bought) access.has4SDataApi = true;
          out.push(bought ? "bought 4S API" : "4S API refused");
          break;
        }
        case "buy": {
          touched.add(action.sym);
          const [long, , short] = stubNs["stock"]["getPosition"](action.sym as never);
          const held = action.short ? short : long;
          if (held > 0) {
            out.push(`already holding ${action.sym}`);
            break;
          }
          const before = stubNs["getServerMoneyAvailable"]("home");
          const price = action.short
            ? stubNs["stock"]["buyShort"](action.sym as never, action.shares)
            : stubNs["stock"]["buyStock"](action.sym as never, action.shares);
          tradeDelta += stubNs["getServerMoneyAvailable"]("home") - before;
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
          const [long, , short] = stubNs["stock"]["getPosition"](action.sym as never);
          const held = Math.min(action.shares, action.short ? short : long);
          if (held <= 0) {
            out.push(`${action.sym} already flat`);
            break;
          }
          const before = stubNs["getServerMoneyAvailable"]("home");
          const price = action.short
            ? stubNs["stock"]["sellShort"](action.sym as never, held)
            : stubNs["stock"]["sellStock"](action.sym as never, held);
          tradeDelta += stubNs["getServerMoneyAvailable"]("home") - before;
          out.push(price > 0 ? `sold ${held} ${action.sym}` : `sell ${action.sym} refused`);
          break;
        }
      }
    }
    return {
      detail: out,
      access,
      holdings: Object.fromEntries([...touched].map((sym) => [sym, stubNs["stock"]["getPosition"](sym as never)])),
      cashBefore,
      tradeDelta,
      cash: stubNs["getServerMoneyAvailable"]("home"),
    };
  });
  if (!outcome.ok) {
    lastResult = { action: actions[0]!.type, ok: false, detail: outcome.reason, at };
    return;
  }
  // Advance the held balance now, exactly as executeInfrastructure does after
  // a purchase: the stub read the REAL post-trade cash, and the player topic's
  // sweep sample is up to seconds stale. Without this, a sale's proceeds land
  // in the arbiter's pool while this feature's own next plan still reads the
  // pre-sale pocket change — too small to post the working-capital reserve —
  // and the one or two passes before the sweep catches up are exactly enough
  // for another feature's standing claim to spend the entire bankroll
  // (measured: a $390m liquidation scooped by a $318m home-RAM rung).
  if (ctx.state.topics.player) {
    merge(ctx.state, "player", { money: outcome.value.cash });
  }
  // Unlock purchases (WSE/TIX/4S) are spends, not trading cashflow. The stub
  // measured the trade-only delta around each buy/sell, so a mixed batch
  // (fundedActions concatenates the funded claims) records its trades exactly
  // and the remainder of the batch's cash movement is the unlock spend —
  // which earnedSinceInstall must still count, because the game's own ledger
  // debits unlocks under the "stock" source the correction strips out.
  const traded = actions.some((action) => action.type === "buy" || action.type === "sell");
  const unlocked = actions.some(
    (action) => action.type === "buyWse" || action.type === "buyTix" || action.type === "buy4SApi",
  );
  const tradeDelta = outcome.value.tradeDelta as number;
  if (traded) {
    tradeCashFlow += tradeDelta;
    tradeFlowSince ??= at;
  }
  if (unlocked) {
    unlockSpend += Math.max(
      0,
      (outcome.value.cashBefore as number) - outcome.value.cash + tradeDelta,
    );
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
  const portfolioValue = positions.reduce((sum, position) => sum + position.value, 0);
  merge(ctx.state, "stock", {
    ...outcome.value.access,
    tradeCashFlow,
    unlockSpend,
    wealth: outcome.value.cash + portfolioValue,
    ...(Object.keys(holdings).length > 0 ? {
      positions,
      portfolioValue,
      portfolioCost: positions.reduce((sum, position) => sum + position.costBasis, 0),
    } : {}),
  });
  lastResult = { action: actions[0]!.type, ok: true, detail: outcome.value.detail.join("; "), at };
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
/** The full planned action set — what claims() prices the RAM claim from, and
 * therefore the set execute()'s claim id must be derived from too. */
function wantedActions(plan: StockPlan): StockAction[] {
  return [
    ...plan.exits,
    ...(plan.unlock ? [plan.unlock.action] : []),
    ...(plan.entry
      ? [{ type: "buy" as const, sym: plan.entry.sym, shares: plan.entry.shares, short: plan.entry.side === "short" }]
      : []),
  ];
}

function claims(ctx: ClaimContext): FeatureClaim[] {
  const plan = lastPlan;
  const out: FeatureClaim[] = [];
  if (!plan) return out;

  const wanted = wantedActions(plan);
  const methods = stockMethods(wanted);
  if (methods.length > 0) {
    out.push(actionRamClaim(ctx, "stock", stockClaimId(wanted), methods));
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
      shape: "step",
      pricing: "economic",
      value: moneyStepValue(ctx.state, plan.unlock.gainPerSec, ctx.now),
      ratePerSec: plan.unlock.gainPerSec,
      returnPerDollarSec: plan.unlock.gainPerSec / Math.max(1, plan.unlock.investmentCost),
    });
  }

  if (plan.entry) {
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
      ratePerSec: plan.entry.expectedProfit / Math.max(1, plan.entry.holdTicks * 6),
      returnPerDollarSec:
        plan.entry.expectedProfit / Math.max(1, plan.entry.cost * plan.entry.holdTicks * 6),
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
    // the economy, not a reallocation (measured: a bn8-full run drained to
    // $38k placed zero further trades for twenty-three virtual hours). Price
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

function stockClaimId(actions: readonly StockAction[]): string {
  return `action:${[...new Set(actions.map((action) =>
    action.type === "buy" || action.type === "sell" ? `${action.type}:${action.short ? "short" : "long"}` : action.type,
  ))].sort().join("+")}`;
}

function stockMethods(actions: readonly StockAction[]): readonly string[] {
  const methods = new Set<string>();
  if (actions.length > 0) methods.add("getServerMoneyAvailable");
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
  // Outside BN8, the base reserve already fits account observation and either
  // half of WSE/TIX acquisition. The 12.1 GB market/trade reserve has value
  // only after TIX exists. BN8 keeps it from the first pass because TIX is a
  // node starting condition that may not have reached the topic yet.
};
