import type { NS } from "@ns";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { stepHacknet, type HacknetDecision, type HacknetView, type UpgradeOption } from "../../../shared/strategy/hacknet/decide.ts";
import { isScriptDeath } from "../errors.ts";
import { merge } from "../state.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

/** The hacknet driver.
 *
 * Cheap in every sense: `ns.hacknet.*` costs 0.05-4 GB, so unlike the
 * singularity features this one never fights for RAM. Its real constraint is
 * MONEY, and it competes for that with the augmentation fund — which is why
 * `hacknet:upgrade` (25) sits deliberately below `factions:aug-fund` (90).
 * Without that ordering hacknet would win every time simply by being cheaper
 * and always ready. */

/** ns.hacknet.* is cheap; this covers the whole read + one purchase. */
const PEAK_STEP_GB = 5;

let lastDecision: HacknetDecision | undefined;
let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;

export function resetHacknetState(): void {
  lastDecision = undefined;
  lastResult = undefined;
}

function buildView(ctx: DriverContext): HacknetView | undefined {
  const topic = ctx.state.topics.hacknet;
  if (!topic) return undefined;

  const nodes = (topic.nodes ?? []).map((node, index) => ({
    index,
    level: node.level,
    ram: node.ram,
    cores: node.cores,
    production: node.production,
  }));

  const upgrades: UpgradeOption[] = (topic.nextUpgrades ?? []).map((upgrade) => ({
    kind: upgrade.kind as UpgradeOption["kind"],
    node: upgrade.node,
    cost: upgrade.cost,
    // The probe reports the cost; the production delta is derived from the
    // node's current production and the known shape of each upgrade.
    deltaProduction: deltaFor(upgrade.kind, nodes[upgrade.node ?? 0]),
  }));

  return {
    nodes,
    nodeCost: topic.purchaseNodeCost ?? Infinity,
    maxNodes: topic.maxNumNodes ?? 0,
    // A fresh node is level 1 / 1 GB / 1 core. Rather than re-derive its
    // production from the formulas, use the weakest existing node as the
    // estimate, falling back to the observed per-node average.
    newNodeProduction: nodes.length > 0 ? Math.min(...nodes.map((node) => node.production)) : (topic.productionPerSec ?? 0),
    upgrades,
    moneyGranted: ctx.grants.money,
    // Expected remaining run time from the endgame route decision. This is
    // the number that makes "worth buying?" a real question: an upgrade that
    // cannot repay itself before the run ends is a loss, not an investment.
    horizonSec: ctx.horizonSec,
    hashMode: topic.servers === true,
  };
}

/** Production delta for one upgrade step, from the game's own shape:
 * `level x 1.5/level`, `ram x 1.035^(ram-1)`, `cores x (cores+5)/6`. Derived
 * from the node's CURRENT production so the player's multipliers and the
 * BitNode's HacknetNodeMoney are already folded in. */
function deltaFor(kind: string, node: { level: number; ram: number; cores: number; production: number } | undefined): number {
  if (!node || node.production <= 0) return 0;
  switch (kind) {
    case "level":
      return node.production * ((node.level + 1) / node.level - 1);
    case "ram":
      return node.production * (Math.pow(1.035, node.ram * 2 - 1) / Math.pow(1.035, node.ram - 1) - 1);
    case "core":
      return node.production * ((node.cores + 6) / (node.cores + 5) - 1);
    default:
      return 0;
  }
}

async function execute(_ns: NS, ctx: DriverContext, buy: UpgradeOption): Promise<void> {
  const methods = hacknetMethods(buy.kind);
  const at = Date.now();
  const outcome = await featureDodge(
    ctx,
    "hacknet",
    hacknetClaimId(buy.kind),
    methods,
    (stubNs: NS) => {
      switch (buy.kind) {
        case "node":
          return stubNs["hacknet"]["purchaseNode"]() >= 0;
        case "level":
          return stubNs["hacknet"]["upgradeLevel"](buy.node!, 1);
        case "ram":
          return stubNs["hacknet"]["upgradeRam"](buy.node!, 1);
        case "core":
          return stubNs["hacknet"]["upgradeCore"](buy.node!, 1);
      }
    },
  );
  if (!outcome.ok) {
    lastResult = { action: buy.kind, ok: false, detail: outcome.reason, at };
    return;
  }
  const ok = outcome.value;
  lastResult = {
    action: buy.kind,
    ok: Boolean(ok),
    detail: ok ? `bought ${buy.kind} for $${Math.round(buy.cost).toLocaleString()}` : "purchase refused",
    at,
  };
}

const driver: FeatureDriver = {
  id: "hacknet",
  everyMs: 10_000,
  async tick(ctx: DriverContext) {
    const view = buildView(ctx);
    if (!view) return;
    const decision = stepHacknet(view);
    lastDecision = decision;

    merge(ctx.state, "hacknet", {
      plan: {
        ...(decision.buy ? { buy: { kind: decision.buy.kind, node: decision.buy.node, cost: decision.buy.cost } } : {}),
        why: decision.why,
        ...(decision.hold ? { hold: decision.hold } : {}),
        ranked: decision.ranked.slice(0, 6).map((entry) => ({
          label: `${entry.kind}${entry.node !== undefined ? ` #${entry.node}` : ""}`,
          cost: entry.cost,
          deltaProduction: entry.deltaProduction,
          paybackSec: entry.paybackSec,
          netOverHorizon: entry.netOverHorizon,
        })),
        ...(lastResult ? { lastResult } : {}),
      },
    });

    if (!decision.buy) return;
    try {
      await execute(ctx.ns, ctx, decision.buy);
    } catch (error) {
      if (isScriptDeath(error)) throw error;
      lastResult = { action: decision.buy.kind, ok: false, detail: String(error), at: Date.now() };
    }
  },
};

function claims(ctx: ClaimContext): Claim[] {
  const plan = ctx.state.topics.hacknet?.plan;
  const out: Claim[] = [];
  if (plan?.buy) {
    out.push(actionRamClaim(ctx, "hacknet", hacknetClaimId(plan.buy.kind), hacknetMethods(plan.buy.kind), `hacknet ${plan.buy.kind}`));
  }
  const best = plan?.ranked?.[0];
  if (best && best.netOverHorizon > 0) {
    out.push({
      by: "hacknet",
      id: "upgrade",
      resource: "money",
      amount: best.cost,
      priority: PRIORITY["hacknet:upgrade"],
      mode: "spend",
      // Divisible: buying a cheaper upgrade than the best one is still
      // progress, unlike an augmentation.
      divisible: false,
      ratePerSec: best.deltaProduction,
      why: `${best.label} pays back in ${Math.round(best.paybackSec)}s`,
    });
  }
  return out;
}

function hacknetClaimId(kind: string): string { return `action:${kind}`; }
function hacknetMethods(kind: string): readonly string[] {
  switch (kind) {
    case "node": return ["hacknet.purchaseNode"];
    case "level": return ["hacknet.upgradeLevel"];
    case "ram": return ["hacknet.upgradeRam"];
    case "core": return ["hacknet.upgradeCore"];
    default: return [];
  }
}

export function hacknetDecision(): HacknetDecision | undefined {
  return lastDecision;
}

export const hacknetModule: FeatureModule = {
  driver,
  reset: (state) => {
    resetHacknetState();
    // Nodes and upgrade prices from the ended node.
    delete state.topics.hacknet;
  },
  claims,
  peakStepGb: PEAK_STEP_GB,
};
