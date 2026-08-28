import { sfLevel } from "../../../shared/features/unlock.ts";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { CORP_COST, stepCorp, type CorpAction, type CorpView } from "../../../shared/strategy/corp/decide.ts";
import { isScriptDeath } from "../errors.ts";
import { signalGateRecheck } from "../gate-signal.ts";
import { merge, type GameState } from "../state.ts";
import type { DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

type Result = { action: string; ok: boolean; detail: string; at: number };
let lastResults: Result[] = [];
let lastActedObservation: string | undefined;

function result(action: string, ok: boolean, detail: string): void {
  lastResults.push({ action, ok, detail, at: Date.now() });
}

function buildView(ctx: DriverContext): CorpView | undefined {
  const capability = ctx.caps.corporation;
  const topic = ctx.state.topics.corp;
  if (capability.exists === "yes" && !topic) return undefined;
  return {
    hasCorporation: capability.exists === "yes",
    bitNode: ctx.caps.bitNode,
    sf3Level: sfLevel(ctx.caps.sourceFiles, 3),
    selfFundCheck: capability.selfFundCheck,
    seedFundCheck: capability.seedFundCheck,
    moneyGranted: ctx.grants.money,
    funds: topic?.funds ?? 0,
    revenue: topic?.revenue ?? 0,
    expenses: topic?.expenses ?? 0,
    unlocks: topic?.unlocks ?? { officeApi: false, warehouseApi: false, smartSupply: false },
    divisions: (topic?.divisions ?? []).map((division) => ({
      name: division.name,
      industry: division.industry,
      cities: division.cities,
      offices: division.offices ?? [],
      warehouses: division.warehouses ?? [],
    })),
  };
}

async function execute(ctx: DriverContext, action: CorpAction): Promise<boolean> {
  try {
    switch (action.type) {
      case "createCorporation": {
        const ok = await ctx.nsp("corporation.createCorporation", action.name, action.selfFund);
        result(action.type, ok, ok ? `created ${action.name}` : "creation refused");
        if (ok) signalGateRecheck();
        return ok;
      }
      case "purchaseUnlock":
        await ctx.nsp("corporation.purchaseUnlock", action.unlock);
        result(action.type, true, `${action.unlock} issued; awaiting probe`);
        return true;
      case "expandIndustry":
        await ctx.nsp("corporation.expandIndustry", action.industry, action.division);
        result(action.type, true, `${action.division} issued; awaiting probe`);
        return true;
      case "expandCity":
        await ctx.nsp("corporation.expandCity", action.division, action.city as never);
        result(action.type, true, `${action.division}/${action.city} issued; awaiting probe`);
        return true;
      case "purchaseWarehouse":
        await ctx.nsp("corporation.purchaseWarehouse", action.division, action.city as never);
        result(action.type, true, `${action.division}/${action.city} issued; awaiting probe`);
        return true;
      case "hireEmployee": {
        const ok = await ctx.nsp("corporation.hireEmployee", action.division, action.city as never, action.position);
        result(action.type, ok, `${action.division}/${action.city} ${action.position}${ok ? "" : " refused"}`);
        return ok;
      }
      case "setSmartSupply":
        await ctx.nsp("corporation.setSmartSupply", action.division, action.city as never, action.enabled);
        result(action.type, true, `${action.division}/${action.city} issued; awaiting probe`);
        return true;
      case "sellMaterial":
        await ctx.nsp(
          "corporation.sellMaterial",
          action.division,
          action.city as never,
          action.material,
          action.amount,
          action.price,
        );
        result(action.type, true, `${action.division}/${action.city} ${action.material} issued; awaiting probe`);
        return true;
    }
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    result(action.type, false, String(error));
    return false;
  }
}

const driver: FeatureDriver = {
  id: "corp",
  everyMs: 30_000,
  requires: "corp",
  async tick(ctx) {
    const view = buildView(ctx);
    if (!view) return;
    const decision = stepCorp(view);
    let issued = false;
    const observation = JSON.stringify(view);
    if (decision.actions.length > 0 && lastActedObservation !== observation) {
      lastResults = [];
      for (const action of decision.actions) {
        const ok = await execute(ctx, action);
        if (!ok) break;
        issued = true;
      }
      if (issued) lastActedObservation = observation;
    }
    if (!ctx.state.topics.corp) return;
    merge(ctx.state, "corp", {
      plan: {
        stage: decision.stage,
        status: decision.status,
        detail: decision.detail,
        actions: decision.actions,
        ...(lastResults.length > 0 ? { lastResults: [...lastResults] } : {}),
      },
    });
  },
};

export const corpModule: FeatureModule = {
  driver,
  claims: (ctx): Claim[] => {
    const capability = ctx.caps.corporation;
    if (
      capability.exists !== "no" ||
      ctx.caps.bitNode === 3 ||
      sfLevel(ctx.caps.sourceFiles, 3) !== 3 ||
      capability.selfFundCheck !== "Success"
    ) return [];
    return [{
      by: "corp",
      id: "found",
      resource: "money",
      amount: CORP_COST.selfFund,
      priority: PRIORITY["corp:found"],
      mode: "spend",
      shape: "step",
      pricing: "hard",
      value: { state: "unknown", reason: "one-time corporation founding cost" },
    }];
  },
  reset(state: GameState) {
    lastResults = [];
    lastActedObservation = undefined;
    delete state.topics.corp;
  },
};
