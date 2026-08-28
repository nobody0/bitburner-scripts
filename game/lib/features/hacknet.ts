import type { HacknetServerHashUpgrade } from "@ns";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { formatMoney, formatNumber } from "../../../shared/format.ts";
import { makeHackContext } from "../../../shared/formulas.ts";
import { linearValueCurve, PRIORITY, type Claim, type ClaimValueCurve } from "../../../shared/strategy/arbiter.ts";
import { installHorizonSec } from "../../../shared/strategy/progression/forecast.ts";
import {
  stepHacknet,
  type HacknetMilestone,
  type HacknetMilestoneKind,
  type HacknetView,
  type UpgradeOption,
} from "../../../shared/strategy/hacknet/decide.ts";
import {
  HASH_UPGRADE,
  hashNeedPriority,
  stepHashes,
  targetHashValues,
  type HashDecision,
  type HashGoalCandidate,
} from "../../../shared/strategy/hacknet/hashes.ts";
import {
  freshProduction,
  HASH_SALE_DOLLARS,
  productionDelta,
  productionDeltaWithAddedRamOccupied,
} from "../../../shared/strategy/hacknet/formulas.ts";
import { coarseHorizonSec, scoreInvestment } from "../../../shared/strategy/investment.ts";
import type { NeedUrgency } from "../../../shared/strategy/needs.ts";
import { isScriptDeath } from "../errors.ts";
import { moneyRateValue } from "../income.ts";
import type { HacknetNodeDigest } from "../../../shared/telemetry/topics/hacknet.ts";
import { merge } from "../state.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

/** The hacknet driver.
 *
 * Cheap in every sense: `ns.hacknet.*` costs 0.05-4 GB, so unlike the
 * singularity features this one never fights for RAM. Its real constraint is
 * MONEY, and it competes for that with the augmentation fund — which is why
 * income investments (25) sit deliberately below `factions:aug-fund` (90).
 * Without that ordering hacknet would win every time simply by being cheaper
 * and always ready.
 * API RAM costs: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts */

/** ns.hacknet.* is cheap; this covers the whole read + one purchase. */

let lastResult: { action: string; ok: boolean; detail: string; at: number } | undefined;
let lastHashResult: { action: string; ok: boolean; detail: string; at: number } | undefined;

export function resetHacknetState(): void {
  lastResult = undefined;
  lastHashResult = undefined;
}

type HacknetViewContext = Pick<ClaimContext, "state" | "caps" | "horizons" | "board">;

function milestonePriority(urgency: NeedUrgency): number {
  if (urgency === "blocking") return PRIORITY["hacknet:blocking-need"];
  if (urgency === "wanted") return PRIORITY["hacknet:wanted-need"];
  return PRIORITY["hacknet:nice-need"];
}

function factionMilestones(ctx: HacknetViewContext, topic: NonNullable<HacknetViewContext["state"]["topics"]["hacknet"]>): HacknetMilestone[] {
  // Reached only through `buildView`, which has already refused a topic with
  // no node list; the fallback keeps the totals honest rather than throwing if
  // that ever stops being true.
  const nodes = topic.nodes ?? [];
  const totals = {
    hacknetRam: nodes.reduce((sum, node) => sum + node.ram, 0),
    hacknetCores: nodes.reduce((sum, node) => sum + node.cores, 0),
    hacknetLevels: nodes.reduce((sum, node) => sum + node.level, 0),
  };
  return ctx.board.open
    .filter((need) => need.kind === "hacknetRam" || need.kind === "hacknetCores" || need.kind === "hacknetLevels")
    .map((need) => ({
      kind: need.kind as "hacknetRam" | "hacknetCores" | "hacknetLevels",
      target: need.target,
      have: totals[need.kind as keyof typeof totals],
      priority: milestonePriority(need.urgency),
      urgency: need.urgency,
    }));
}

function hashGoals(ctx: HacknetViewContext): HashGoalCandidate[] {
  const state = ctx.state.topics;
  const topic = state.hacknet;
  if (!topic?.servers || !topic.hashes) return [];
  const goals: HashGoalCandidate[] = [];

  // Target mutations are economic investments: compare their exact target
  // solve over the remaining horizon against selling the same hashes.
  const targetName = state.farm?.target;
  const target = targetName ? state.servers?.[targetName] : undefined;
  const player = state.player;
  if (target && player && (state.farm?.moneyPerSecPerGb ?? 0) > 0) {
    const mults = player.mults;
    const hackCtx = makeHackContext({
      skill: player.skills.hacking,
      intelligence: player.skills.intelligence,
      mults: {
        hacking_exp: mults.hacking_exp,
        hacking_money: mults.hacking_money,
        hacking_grow: mults.hacking_grow,
        hacking_speed: mults.hacking_speed,
        hacking_chance: mults.hacking_chance,
      },
    }, effectiveBitNodeMultipliers(
      ctx.caps.bitNode,
      ctx.caps.sourceFiles["12"] ?? 0,
      state.progression?.multipliers,
    ) ?? {});
    const fleetGb = Math.max(0, state.fleet?.maxRam ?? 0);
    const largest = Math.max(0, ...Object.values(state.servers ?? {}).map((server) => server.hasAdminRights ? server.maxRam : 0));
    const values = targetHashValues(hackCtx, {
      hostname: target.hostname,
      minDifficulty: target.minDifficulty ?? 1,
      moneyMax: target.moneyMax ?? 0,
      requiredHackingSkill: target.requiredHackingSkill ?? Infinity,
      serverGrowth: target.serverGrowth ?? 0,
      baseDifficulty: target.baseDifficulty ?? 1,
    }, { batchGb: fleetGb, hackBlockGb: largest, growBlockGb: largest }, fleetGb, installHorizonSec(ctx.horizons));
    goals.push(
      { name: HASH_UPGRADE.maxMoney, target: targetName, priority: 30, valueDollars: values.maxMoney },
      { name: HASH_UPGRADE.minSecurity, target: targetName, priority: 30, valueDollars: values.minSecurity },
    );
  }

  for (const need of ctx.board.open) {
    if (need.kind === "bladeburnerRank" && state.bladeburner) {
      goals.push({ name: HASH_UPGRADE.bladeRank, priority: hashNeedPriority(need), urgency: need.urgency });
    } else if (need.kind === "companyRep" && need.subject) {
      goals.push({ name: HASH_UPGRADE.companyFavor, target: need.subject, priority: hashNeedPriority(need), urgency: need.urgency });
    } else if ((need.kind === "combatSkills" || need.kind === "skill") && state.career?.currentWork?.type === "CLASS") {
      const combat = need.kind === "combatSkills" || ["strength", "defense", "dexterity", "agility"].includes(need.subject ?? "");
      goals.push({ name: combat ? HASH_UPGRADE.gym : HASH_UPGRADE.study, priority: hashNeedPriority(need), urgency: need.urgency });
    }
  }

  const route = state.progression?.plan?.route;
  if (route === "bladeburner" && state.bladeburner) {
    if (state.bladeburner.nextBlackOp && state.bladeburner.rank < state.bladeburner.nextBlackOp.rank) {
      goals.push({ name: HASH_UPGRADE.bladeRank, priority: 58 });
    }
    if (state.bladeburner.plan?.action.type === "upgrade") {
      goals.push({ name: HASH_UPGRADE.bladeSp, priority: 60 });
    }
  }
  if (state.corp?.plan && state.corp.plan.action.type !== "idle") {
    goals.push({ name: HASH_UPGRADE.corpFunds, priority: 55 });
  }
  if (state.corp?.plan?.stage.toLowerCase().includes("research")) {
    goals.push({ name: HASH_UPGRADE.corpResearch, priority: 55 });
  }
  return goals;
}

function decideHashes(ctx: HacknetViewContext): HashDecision | undefined {
  const topic = ctx.state.topics.hacknet;
  if (!topic?.servers || !topic.hashes) return undefined;
  return stepHashes({
    current: topic.hashes.current,
    capacity: topic.hashes.capacity,
    productionPerSec: topic.productionPerSec,
    upgrades: topic.hashUpgrades ?? [],
    goals: hashGoals(ctx),
  });
}

export interface HacknetBasis {
  hashMode: boolean;
  /** Dollars one hash is worth, from the observed "Sell for Money" quote.
   * Production above the bank's capacity is auto-sold upstream at exactly this
   * rate, so this stays the correct valuation even with a full bank.
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacknet/HacknetHelpers.tsx#L419-L429 */
  hashDollarValue: number;
  fleetUtilization: number;
  fleetDemanded: boolean;
}

/** The quantities every hacknet decision depends on, derived ONCE per pass so
 * the view, the executed purchase and the published digest cannot disagree.
 *
 * `undefined` means we must not decide yet. In hash mode that includes "the
 * sale quote has not been observed": valuing a hash at zero there would score
 * every upgrade at zero production, publish an all-zero table and silently
 * freeze purchasing — which reads exactly like a considered hold. */
export function hacknetBasis(ctx: HacknetViewContext): HacknetBasis | undefined {
  const topic = ctx.state.topics.hacknet;
  if (!topic) return undefined;
  const hashMode =
    ctx.caps.restrictions.disableHacknetServer !== true &&
    (ctx.caps.bitNode === 9 || (ctx.caps.sourceFiles["9"] ?? 0) > 0);
  const saleCost = topic.hashes?.sellForMoneyCost ?? 0;
  if (hashMode && !(saleCost > 0)) return undefined;
  const fleet = ctx.state.topics.fleet;
  const fleetUtilization = fleet && fleet.maxRam > 0 ? fleet.usedRam / fleet.maxRam : 0;
  return {
    hashMode,
    hashDollarValue: hashMode ? HASH_SALE_DOLLARS / saleCost : 1,
    fleetUtilization,
    fleetDemanded: (ctx.state.topics.farm?.moneyPerSecPerGb ?? 0) > 0 && fleetUtilization >= 0.8,
  };
}

export interface UpgradeValuation {
  /** Dollars per second the upgrade adds. */
  value: number;
  /** Which use of the new GB won, for hacknet-server RAM only. Published so
   * the panel can say WHY a RAM upgrade is worth what it is. */
  ramBasis?: "idle" | "occupied";
}

/** Dollars per second one upgrade adds — the same unit for every kind. */
export function upgradeValue(
  node: HacknetNodeDigest,
  kind: string,
  basis: HacknetBasis,
  farmPerGb: number,
): UpgradeValuation {
  // Cache buys hash CAPACITY, never production. Only a capacity milestone can
  // justify it; crediting it with production would corrupt every payback.
  if (kind === "cache") return { value: 0 };
  const shape = {
    level: node.level,
    ram: node.ram,
    cores: node.cores,
    production: node.production,
    ramUsed: node.ramUsed,
  };
  const idle = productionDelta(shape, kind as "level" | "ram" | "core", basis.hashMode) * basis.hashDollarValue;
  if (!basis.hashMode || kind !== "ram") return { value: idle };

  // Hacknet-server RAM is hash capacity and fleet RAM at once, and the two are
  // mutually exclusive: idle RAM raises the free-RAM hash multiplier, occupied
  // RAM earns hacking money but produces FEWER hashes. Adding both would count
  // the same GB twice. Which one happens is the scheduler's call, so take the
  // better of the two rather than switching on a utilization threshold — a
  // threshold quotes the idle case while the scheduler fills the RAM anyway,
  // and jumps discontinuously the moment the fleet crosses it.
  const occupied = productionDeltaWithAddedRamOccupied(shape) * basis.hashDollarValue + node.ram * farmPerGb;
  return occupied > idle ? { value: occupied, ramBasis: "occupied" } : { value: idle, ramBasis: "idle" };
}

/** Progress toward the non-income milestones. RAM and cache both DOUBLE, so
 * each adds exactly what the node already has. */
function upgradeProgress(node: HacknetNodeDigest, kind: string): Partial<Record<HacknetMilestoneKind, number>> {
  if (kind === "ram") return { hacknetRam: node.ram };
  if (kind === "core") return { hacknetCores: 1 };
  if (kind === "level") return { hacknetLevels: 1 };
  if (kind === "cache") return { hashCapacity: node.hashCapacity ?? 0 };
  return {};
}

export function buildView(
  ctx: HacknetViewContext,
  moneyGranted: number,
  basis: HacknetBasis,
  hashes: HashDecision | undefined,
): HacknetView | undefined {
  const topic = ctx.state.topics.hacknet;
  // `nextUpgrades` arrives from a PARTIAL emission, so the topic can exist
  // holding prices and no node list. Nothing can be valued without the nodes.
  if (!topic?.nodes) return undefined;

  const nodes = topic.nodes.map((node, index) => ({
    index,
    level: node.level,
    ram: node.ram,
    cores: node.cores,
    production: node.production * basis.hashDollarValue,
    ramUsed: node.ramUsed,
  }));

  const farmPerGb = ctx.state.topics.farm?.moneyPerSecPerGb ?? 0;
  const upgrades: UpgradeOption[] = (topic.nextUpgrades ?? []).flatMap((upgrade) => {
    const node = topic.nodes[upgrade.node];
    if (!node) return [];
    const valued = upgradeValue(node, upgrade.kind, basis, farmPerGb);
    return [{
      kind: upgrade.kind as UpgradeOption["kind"],
      node: upgrade.node,
      cost: upgrade.cost,
      deltaProduction: valued.value,
      progress: upgradeProgress(node, upgrade.kind),
      ...(valued.ramBasis ? { ramBasis: valued.ramBasis } : {}),
    }];
  });

  const sf12 = ctx.caps.sourceFiles["12"] ?? 0;
  // The same multiplier source as every other hacknet estimate, BitNode-option
  // overrides included. Defaulting to 1 rather than 0 is load-bearing: a
  // missing row must not read as "a fresh node earns nothing", which would
  // stop the very first node from ever being bought.
  const nodeMult = effectiveBitNodeMultipliers(
    ctx.caps.bitNode,
    sf12,
    ctx.state.topics.progression?.multipliers,
  )?.HacknetNodeMoney ?? 1;
  const playerMult = ctx.state.topics.player?.mults.hacknet_node_money ?? 1;
  const freshNative = freshProduction(basis.hashMode, playerMult, nodeMult);
  const milestones = factionMilestones(ctx, topic);
  if (hashes?.capacityTarget !== undefined) {
    const selectedHashGoal = hashes.ranked[0];
    milestones.push({
      kind: "hashCapacity",
      target: hashes.capacityTarget,
      have: topic.hashes?.capacity ?? 0,
      // Hash ranking priorities are internal utility scores, not arbiter
      // priorities. Map explicit faction urgency onto the shared money bands;
      // route/economic goals use the ordinary wanted band.
      priority: selectedHashGoal?.urgency
        ? milestonePriority(selectedHashGoal.urgency)
        : PRIORITY["hacknet:wanted-need"],
      urgency: selectedHashGoal?.urgency ?? "wanted",
    });
  }

  return {
    nodes,
    nodeCost: topic.purchaseNodeCost ?? Infinity,
    maxNodes: topic.maxNumNodes ?? Infinity,
    // A fresh Hacknet Server has 1 GB and cannot fit our 1.7 GB worker. It is
    // hash production first; its later RAM upgrades enter the fleet valuation.
    newNodeProduction: freshNative * basis.hashDollarValue,
    ...(basis.hashMode ? { newNodeHashCapacity: 64 } : {}),
    upgrades,
    moneyGranted,
    // Expected remaining run time from the endgame route decision. This is
    // the number that makes "worth buying?" a real question: an upgrade that
    // cannot repay itself before the run ends is a loss, not an investment.
    horizonSec: installHorizonSec(ctx.horizons),
    hashMode: basis.hashMode,
    milestones,
  };
}

/** The game's own answer to "did the purchase happen?". `purchaseNode` reports
 * the new node's index and -1 for a refusal; the four upgrades report a plain
 * boolean. */
async function buyUpgrade(ctx: DriverContext, buy: UpgradeOption): Promise<boolean> {
  switch (buy.kind) {
    case "node":
      return await ctx.nsp("hacknet.purchaseNode") >= 0;
    case "level":
      return await ctx.nsp("hacknet.upgradeLevel", buy.node!, 1);
    case "ram":
      return await ctx.nsp("hacknet.upgradeRam", buy.node!, 1);
    case "core":
      return await ctx.nsp("hacknet.upgradeCore", buy.node!, 1);
    case "cache":
      return await ctx.nsp("hacknet.upgradeCache", buy.node!, 1);
  }
}

async function execute(ctx: DriverContext, buy: UpgradeOption): Promise<void> {
  const at = Date.now();
  const ok = await buyUpgrade(ctx, buy);
  lastResult = {
    action: buy.kind,
    ok,
    detail: ok ? `bought ${buy.kind} for ${formatMoney(buy.cost)}` : "purchase refused",
    at,
  };
  const publishedPlan = ctx.state.topics.hacknet?.plan;
  if (publishedPlan) merge(ctx.state, "hacknet", { plan: { ...publishedPlan, lastResult } });
  if (ok) {
    // Every price/production delta was quoted for the pre-purchase state.
    // Invalidate the menu so a later tick cannot spend against that stale
    // grant; the unconditional probes repopulate it with authoritative data.
    merge(ctx.state, "hacknet", { nextUpgrades: [], purchaseNodeCost: Infinity });
  }
}

async function spendHashes(ctx: DriverContext, decision: HashDecision): Promise<void> {
  const hashes = ctx.state.topics.hacknet?.hashes;
  const spend = decision.spend;
  if (!hashes || !spend) return;
  const at = Date.now();
  const ok = await ctx.nsp("hacknet.spendHashes", spend.name as HacknetServerHashUpgrade, spend.target ?? "", spend.count);
  lastHashResult = {
    action: spend.name,
    ok,
    detail: ok
      ? `spent ${formatNumber(spend.cost)} hashes on ${spend.name}${spend.target ? ` for ${spend.target}` : ""}`
      : "hash spend refused",
    at,
  };
  if (ok) {
    // Both the balance and every escalating quote are stale after a spend.
    merge(ctx.state, "hacknet", {
      hashes: { ...hashes, current: Math.max(0, hashes.current - spend.cost) },
      hashUpgrades: [],
    });
  }
  const publishedPlan = ctx.state.topics.hacknet?.plan;
  if (publishedPlan?.hashes) {
    merge(ctx.state, "hacknet", {
      plan: { ...publishedPlan, hashes: { ...publishedPlan.hashes, lastResult: lastHashResult } },
    });
  }
}

const driver: FeatureDriver = {
  id: "hacknet",
  everyMs: 10_000,
  async tick(ctx: DriverContext) {
    const basis = hacknetBasis(ctx);
    if (!basis) return;
    // ONE hash decision per pass. It runs the exact cycle solver three times
    // over inside `targetHashValues`, so recomputing it for the view, the
    // digest and the spend would triple that for an identical answer.
    const hashDecision = decideHashes(ctx);
    const view = buildView(ctx, ctx.grants.money, basis, hashDecision);
    if (!view) return;
    const decision = stepHacknet(view);

    const topic = ctx.state.topics.hacknet!;
    const { hashDollarValue, fleetUtilization, fleetDemanded } = basis;
    const candidate = decision.ranked[0];
    const evaluatedAt = Date.now();

    // The top of the ranking, plus the rung actually bought when the grant
    // forced a fall-through past it. Without that the panel would show no
    // highlighted row at all while `buy` reports a purchase.
    const shown = decision.ranked.slice(0, 6);
    if (decision.buy && !shown.includes(decision.buy)) shown.push(decision.buy);

    merge(ctx.state, "hacknet", {
      plan: {
        evaluatedAt,
        // Coarse for the digest — the raw forecast ticks every second.
        horizonSec: coarseHorizonSec(installHorizonSec(ctx.horizons)),
        moneyAvailable: ctx.state.topics.player?.money ?? 0,
        moneyGranted: ctx.grants.money,
        hashDollarValue,
        fleetUtilization,
        fleetDemanded,
        ...(candidate ? { candidate: { kind: candidate.kind, node: candidate.node, cost: candidate.cost } } : {}),
        ...(decision.buy ? { buy: { kind: decision.buy.kind, node: decision.buy.node, cost: decision.buy.cost } } : {}),
        rankedTotal: decision.ranked.length,
        ranked: shown.map((entry, index) => ({
          kind: entry.kind,
          ...(entry.node !== undefined ? { node: entry.node } : {}),
          label: `${entry.kind}${entry.node !== undefined ? ` #${entry.node}` : ""}`,
          cost: entry.cost,
          deltaProduction: entry.deltaProduction,
          returnPerDollarSec: entry.cost > 0 ? entry.deltaProduction / entry.cost : 0,
          paybackSec: entry.paybackSec,
          netOverHorizon: entry.netOverHorizon,
          worthBuying: Boolean(entry.milestone) || entry.netOverHorizon > 0,
          // Which use of a server RAM upgrade's new GB set its value — the
          // one part of the valuation that is not visible from cost and rate.
          // Carried from the ranking, never recomputed, so the panel cannot
          // quote a basis the decision did not use.
          ...(entry.ramBasis ? { ramBasis: entry.ramBasis } : {}),
          // The purchase, not the leader: when the leader costs more than the
          // grant the driver falls through to the best affordable rung, and
          // highlighting the leader would misreport what was bought.
          selected: decision.buy ? entry === decision.buy : index === 0,
          ...(entry.milestone ? { milestone: {
            kind: entry.milestone.kind,
            target: entry.milestone.target,
            have: entry.milestone.have,
            delta: entry.milestone.delta,
            priority: entry.milestone.priority,
          } } : {}),
        })),
        ...(lastResult ? { lastResult } : {}),
        ...(hashDecision ? { hashes: {
          current: topic.hashes?.current ?? 0,
          capacity: topic.hashes?.capacity ?? 0,
          productionPerSec: topic.productionPerSec,
          sellForMoneyCost: topic.hashes?.sellForMoneyCost ?? 0,
          ...(hashDecision.spend ? { spend: {
            name: hashDecision.spend.name,
            ...(hashDecision.spend.target ? { target: hashDecision.spend.target } : {}),
            count: hashDecision.spend.count,
            cost: hashDecision.spend.cost,
          } } : {}),
          ...(hashDecision.reserve ? { reserve: {
            name: hashDecision.reserve.name,
            ...(hashDecision.reserve.target ? { target: hashDecision.reserve.target } : {}),
            cost: hashDecision.reserve.cost,
            missing: hashDecision.reserve.missing,
          } } : {}),
          ...(hashDecision.capacityTarget !== undefined ? { capacityTarget: hashDecision.capacityTarget } : {}),
          rankedTotal: hashDecision.ranked.length,
          ranked: hashDecision.ranked.slice(0, 8).map((entry) => ({
            name: entry.name,
            ...(entry.target ? { target: entry.target } : {}),
            cost: entry.cost,
            priority: entry.priority,
            affordable: entry.affordable,
            fitsCapacity: entry.fitsCapacity,
            ...(entry.valueDollars !== undefined ? { valueDollars: entry.valueDollars } : {}),
            saleValueDollars: entry.saleValueDollars,
            ...(entry.netDollars !== undefined ? { netDollars: entry.netDollars } : {}),
            eligible: entry.eligible,
            selected: entry.eligible && (
              (hashDecision.spend?.name === entry.name && hashDecision.spend.target === entry.target) ||
              (hashDecision.reserve?.name === entry.name && hashDecision.reserve.target === entry.target)
            ),
          })),
          ...(lastHashResult ? { lastResult: lastHashResult } : {}),
        } } : {}),
      },
    });

    // Each action reports its OWN failure. Sharing one catch attributed a
    // failed hash spend to the purchase whenever both ran in the same pass.
    if (decision.buy) {
      try {
        await execute(ctx, decision.buy);
      } catch (error) {
        if (isScriptDeath(error)) throw error;
        lastResult = { action: decision.buy.kind, ok: false, detail: String(error), at: Date.now() };
      }
    }
    if (hashDecision) {
      try {
        await spendHashes(ctx, hashDecision);
      } catch (error) {
        if (isScriptDeath(error)) throw error;
        lastHashResult = { action: hashDecision.spend?.name ?? "hashes", ok: false, detail: String(error), at: Date.now() };
      }
    }
  },
};

function claims(ctx: ClaimContext): Claim[] {
  const basis = hacknetBasis(ctx);
  if (!basis) return [];
  // One hash decision, shared with the view below — see the note in `tick`.
  const hashes = decideHashes(ctx);
  const view = buildView(ctx, Infinity, basis, hashes);
  const decision = view ? stepHacknet(view) : undefined;
  const best = decision?.buy;
  const out: Claim[] = [];
  if (best) {
    const scored = scoreInvestment(
      { cost: best.cost, incomePerSec: best.deltaProduction },
      installHorizonSec(ctx.horizons),
    );
    const priority = best.milestone?.priority ?? PRIORITY["income:investment"];
    out.push({
      by: "hacknet",
      id: "upgrade",
      resource: "money",
      amount: best.cost,
      priority,
      mode: "spend",
      // Value is continuous in deployed dollars; stepHacknet still requires a
      // complete grant before executing the atomic game purchase. Splitting a
      // tied waterline can therefore delay a rung by one pass, which is the
      // deliberate execution-only lumpiness of this model.
      shape: "continuous",
      ratePerSec: best.deltaProduction,
      returnPerDollarSec: scored.returnPerDollarSec,
    });
  }
  return out;
}

/** Convert an ordinary income upgrade's $/sec/$ slope through progression's
 * measured money marginal. Non-income milestones stay governed by their hard
 * priority band and retain the legacy unpriced continuous fallback. */
function valueCurve(claim: Claim, ctx: ClaimContext): ClaimValueCurve | undefined {
  if (
    claim.by !== "hacknet"
    || claim.id !== "upgrade"
    || claim.resource !== "money"
    || claim.shape !== "continuous"
    || claim.priority !== PRIORITY["income:investment"]
  ) return undefined;
  if (!(claim.amount > 0)) return { demandAt: () => 0 };
  const value = moneyRateValue(ctx.state, (claim.ratePerSec ?? 0) / claim.amount, ctx.now);
  if (value.state === "unknown") return undefined;
  return value.value > 0 ? linearValueCurve(value.value, claim.amount) : { demandAt: () => 0 };
}

export const hacknetModule: FeatureModule = {
  driver,
  reset: (state) => {
    resetHacknetState();
    // Nodes and upgrade prices from the ended node.
    delete state.topics.hacknet;
  },
  claims,
  valueCurve,
};
