import { scoreInvestment } from "../investment.ts";

/** Hacknet purchase scheduling.
 *
 * Objective: reject anything that cannot repay over the REMAINING HORIZON,
 * then buy the surviving option with the fastest ROI. The horizon is what
 * makes it a real decision: an upgrade that pays for itself in four hours is excellent with
 * eight hours left and worthless with one, and a planner without a horizon
 * buys the same thing in both cases.
 *
 * Production and cost formulas are read from the game
 * (`ns.hacknet.getLevelUpgradeCost` and friends), never hardcoded here, for
 * the same reason as everywhere else: the BitNode multipliers and the player's
 * hacknet cost multipliers are already folded into what the game reports.
 *
 * Hacknet Servers are converted to dollars/sec through the observed
 * "Sell for Money" hash price before they reach this pure decision.
 * Pinned upstream API and formula sources:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Hacknet.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacknet/HacknetHelpers.tsx
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacknet/formulas/HacknetNodes.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacknet/formulas/HacknetServers.ts */

export interface HacknetNodeState {
  index: number;
  level: number;
  ram: number;
  cores: number;
  /** Money per second, as the game reports it. */
  production: number;
}

export type UpgradeKind = "level" | "ram" | "core" | "cache" | "node";

export type HacknetMilestoneKind = "hacknetRam" | "hacknetCores" | "hacknetLevels" | "hashCapacity";

export interface HacknetMilestone {
  kind: HacknetMilestoneKind;
  target: number;
  have: number;
  priority: number;
}

export interface UpgradeOption {
  kind: UpgradeKind;
  /** Node index; absent for a new node. */
  node?: number;
  cost: number;
  /** Extra money per second this upgrade would produce. */
  deltaProduction: number;
  /** Progress toward a non-income milestone, filled by the driver from the
   * observed node state. Cache upgrades use hash-capacity units. */
  progress?: Partial<Record<HacknetMilestoneKind, number>>;
}

export interface HacknetView {
  nodes: HacknetNodeState[];
  /** Purchase cost of the next node. */
  nodeCost: number;
  maxNodes: number;
  /** Production of a freshly-purchased node, so a new node can be ranked
   *  against upgrading an existing one. */
  newNodeProduction: number;
  /** Initial capacity of a fresh Hacknet Server; zero for ordinary nodes. */
  newNodeHashCapacity?: number;
  /** Candidate upgrades, priced by the game. */
  upgrades: UpgradeOption[];
  /** Money the arbiter granted this feature. */
  moneyGranted: number;
  /** Seconds of run left to amortise a purchase against. */
  horizonSec: number;
  /** True in BN9/SF9, where production is hashes rather than money. */
  hashMode: boolean;
  milestones?: HacknetMilestone[];
}

export interface RankedUpgrade extends UpgradeOption {
  paybackSec: number;
  netOverHorizon: number;
  milestone?: HacknetMilestone & { delta: number; completion: number };
}

export interface HacknetDecision {
  /** The purchase to make, or undefined to hold. */
  buy?: RankedUpgrade;
  /** Everything considered, best payback first. */
  ranked: RankedUpgrade[];
}

/** Seconds for an upgrade to repay its own cost. `Infinity` when it produces
 * nothing, which is a real answer and must not be treated as "cheap". */
export function paybackSec(option: UpgradeOption): number {
  return scoreInvestment({ cost: option.cost, incomePerSec: option.deltaProduction }, Infinity).paybackSec;
}

/** Net money over the remaining horizon: what it earns in the time left, minus
 * what it costs. NEGATIVE means buying it loses money before the run ends.
 *
 * This is the whole objective, and it is why the horizon is a first-class
 * input rather than a tuning constant. */
export function netOverHorizon(option: UpgradeOption, horizonSec: number): number {
  return scoreInvestment({ cost: option.cost, incomePerSec: option.deltaProduction }, horizonSec).netOverHorizon;
}

export function stepHacknet(view: HacknetView): HacknetDecision {
  const candidates: UpgradeOption[] = [...view.upgrades];

  // A new node competes with upgrading an existing one, on the same terms.
  if (view.nodes.length < view.maxNodes && Number.isFinite(view.nodeCost)) {
    candidates.push({
      kind: "node",
      cost: view.nodeCost,
      deltaProduction: view.newNodeProduction,
      progress: {
        hacknetRam: 1,
        hacknetCores: 1,
        hacknetLevels: 1,
        ...(view.newNodeHashCapacity ? { hashCapacity: view.newNodeHashCapacity } : {}),
      },
    });
  }

  const ranked = candidates
    .map((option): RankedUpgrade => {
      let milestone: RankedUpgrade["milestone"];
      for (const wanted of view.milestones ?? []) {
        const delta = Math.max(0, option.progress?.[wanted.kind] ?? 0);
        if (delta <= 0 || wanted.have >= wanted.target) continue;
        const remaining = wanted.target - wanted.have;
        const candidate = { ...wanted, delta, completion: Math.min(1, delta / remaining) };
        if (!milestone || candidate.priority > milestone.priority ||
          (candidate.priority === milestone.priority && candidate.completion / option.cost > milestone.completion / option.cost)) {
          milestone = candidate;
        }
      }
      return {
        ...option,
        paybackSec: paybackSec(option),
        netOverHorizon: netOverHorizon(option, view.horizonSec),
        ...(milestone ? { milestone } : {}),
      };
    })
    .sort((a, b) => {
      const ap = a.milestone?.priority ?? 0;
      const bp = b.milestone?.priority ?? 0;
      if (ap !== bp) return bp - ap;
      if (ap > 0 && bp > 0) {
        const av = a.milestone!.completion / a.cost;
        const bv = b.milestone!.completion / b.cost;
        if (av !== bv) return bv - av;
      }
      // The horizon is an eligibility gate. Among investments which can repay
      // in time, fastest ROI wins. Net value only breaks an equal payback.
      const aViable = a.netOverHorizon > 0;
      const bViable = b.netOverHorizon > 0;
      if (aViable !== bViable) return bViable ? 1 : -1;
      const payback = a.paybackSec - b.paybackSec;
      if (payback !== 0) return payback;
      const net = b.netOverHorizon - a.netOverHorizon;
      if (net !== 0) return net;
      return `${a.kind}${a.node ?? ""}` < `${b.kind}${b.node ?? ""}` ? -1 : 1;
    });

  // Hold when there is nothing to buy, the best candidate loses money before
  // the horizon without a milestone to justify it, or the grant does not
  // cover it yet.
  const best = ranked[0];
  if (!best || (!best.milestone && best.netOverHorizon <= 0) || best.cost > view.moneyGranted) {
    return { ranked };
  }

  return { buy: best, ranked };
}
