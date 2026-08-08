import type { NS } from "@ns";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { stepStock, type StockAction, type StockDecision, type StockView } from "../../../shared/strategy/stock/decide.ts";
import { isScriptDeath } from "../errors.ts";
import { merge } from "../state.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

/** The stock driver.
 *
 * Degrades honestly at three levels, because the game gates them separately:
 * a WSE account shows prices, TIX API allows positions, and 4S supplies the
 * forecast. Without a forecast the strategy REFUSES to trade rather than
 * guessing — a $200k round-trip commission against a coin flip is a reliable
 * way to lose money while looking busy. */

const PEAK_STEP_GB = 8;

let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;
let lastActions: StockAction[] = [];

export function resetStockState(): void {
  lastResult = undefined;
  lastActions = [];
}

function buildView(ctx: DriverContext): StockView | undefined {
  const topic = ctx.state.topics.stock;
  if (!topic) return undefined;
  return {
    positions: (topic.positions ?? []).map((position) => ({
      sym: position.sym,
      price: position.price,
      ask: position.ask,
      bid: position.bid,
      maxShares: position.maxShares,
      shares: position.shares,
      avgPx: position.avgPx,
      sharesShort: position.sharesShort,
      avgPxShort: position.avgPxShort,
    })),
    signals: Object.fromEntries(
      Object.entries(topic.signals ?? {}).map(([sym, signal]) => [
        sym,
        { forecast: signal.forecast ?? 0.5, volatility: signal.volatility ?? 0 },
      ]),
    ),
    has4SData: topic.has4SData ?? false,
    has4SDataApi: topic.has4SDataApi ?? false,
    hasTixApi: topic.hasTixApiAccess ?? false,
    moneyGranted: ctx.grants.money,
    totalMoney: ctx.state.topics.player?.money ?? 0,
    horizonSec: 3_600,
    incomePerSec: 0,
  };
}

async function execute(_ns: NS, ctx: DriverContext, actions: StockAction[]): Promise<void> {
  if (actions.length === 0) return;
  const methods = stockMethods(actions);
  const at = Date.now();
  // Every action in ONE stub: each trade changes the money available to the
  // next, so they must see each other's effects.
  const outcome = await featureDodge(
    ctx,
    "stock",
    stockClaimId(actions),
    methods,
    (stubNs: NS) => {
      const out: string[] = [];
      for (const action of actions) {
        switch (action.type) {
          case "hold":
            break;
          case "buy4SData":
            out.push(stubNs["stock"]["purchase4SMarketData"]() ? "bought 4S data" : "4S data refused");
            break;
          case "buy4SApi":
            out.push(stubNs["stock"]["purchase4SMarketDataTixApi"]() ? "bought 4S API" : "4S API refused");
            break;
          case "buy": {
            const price = action.short
              ? stubNs["stock"]["buyShort"](action.sym as never, action.shares)
              : stubNs["stock"]["buyStock"](action.sym as never, action.shares);
            out.push(price > 0 ? `bought ${action.shares} ${action.sym}` : `buy ${action.sym} refused`);
            break;
          }
          case "sell": {
            const price = action.short
              ? stubNs["stock"]["sellShort"](action.sym as never, action.shares)
              : stubNs["stock"]["sellStock"](action.sym as never, action.shares);
            out.push(price > 0 ? `sold ${action.shares} ${action.sym}` : `sell ${action.sym} refused`);
            break;
          }
        }
      }
      return out;
    },
  );
  if (!outcome.ok) {
    lastResult = { action: actions[0]!.type, ok: false, detail: outcome.reason, at };
    return;
  }
  const results = outcome.value;
  lastResult = { action: actions[0]!.type, ok: true, detail: results.join("; "), at };
}

const driver: FeatureDriver = {
  id: "stock",
  everyMs: 5_000,
  requires: "stock",
  async tick(ctx: DriverContext) {
    const view = buildView(ctx);
    if (!view) return;
    const decision: StockDecision = stepStock(view);
    lastActions = decision.actions;

    merge(ctx.state, "stock", {
      plan: {
        actions: decision.actions.map((action) => ({ type: action.type, why: action.why })),
        ranked: decision.ranked.slice(0, 8),
        why: decision.why,
        ...(decision.hold ? { hold: decision.hold } : {}),
        ...(lastResult ? { lastResult } : {}),
      },
    });

    try {
      await execute(ctx.ns, ctx, decision.actions);
    } catch (error) {
      if (isScriptDeath(error)) throw error;
      lastResult = { action: "trade", ok: false, detail: String(error), at: Date.now() };
    }
  },
};

function claims(ctx: ClaimContext): Claim[] {
  const out: Claim[] = [];
  const methods = stockMethods(lastActions);
  if (methods.length > 0) {
    out.push(actionRamClaim(ctx, "stock", stockClaimId(lastActions), methods, "stock action batch"));
  }
  const buying = lastActions.some((action) => action.type === "buy" || action.type.startsWith("buy4S"));
  if (buying) {
    out.push({
      by: "stock",
      id: "position",
      resource: "money",
      // Deliberately capped: stock must never drain the augmentation fund, and
      // a position is divisible, so a partial grant still buys fewer shares.
      amount: (ctx.state.topics.player?.money ?? 0) * 0.25,
      priority: PRIORITY["stock:position"],
      mode: "spend",
      divisible: true,
      why: "opening or funding a position",
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
    if (action.type === "buy4SData") methods.add("stock.purchase4SMarketData");
    else if (action.type === "buy4SApi") methods.add("stock.purchase4SMarketDataTixApi");
    else if (action.type === "buy") methods.add(action.short ? "stock.buyShort" : "stock.buyStock");
    else if (action.type === "sell") methods.add(action.short ? "stock.sellShort" : "stock.sellStock");
  }
  return [...methods];
}

export const stockModule: FeatureModule = {
  driver,
  reset: resetStockState,
  claims,
  peakStepGb: PEAK_STEP_GB,
};
