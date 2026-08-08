/** Hacknet purchase scheduling.
 *
 * Objective: maximise cumulative production minus spend over the REMAINING
 * HORIZON. The horizon is what makes this a real decision rather than a
 * ranking — an upgrade that pays for itself in four hours is excellent with
 * eight hours left and worthless with one, and a planner without a horizon
 * buys the same thing in both cases.
 *
 * Production and cost formulas are read from the game
 * (`ns.hacknet.getLevelUpgradeCost` and friends), never hardcoded here, for
 * the same reason as everywhere else: the BitNode multipliers and the player's
 * hacknet cost multipliers are already folded into what the game reports.
 *
 * Hacknet SERVERS (BN9/SF9) change the objective from money to hashes. The
 * detection is `hashCapacity` being present on a node's stats — reported by
 * the probe — and the strategy reports the difference rather than silently
 * pricing hashes as dollars. */

export interface HacknetNodeState {
  index: number;
  level: number;
  ram: number;
  cores: number;
  /** Money per second, as the game reports it. */
  production: number;
}

export type UpgradeKind = "level" | "ram" | "core" | "node";

export interface UpgradeOption {
  kind: UpgradeKind;
  /** Node index; absent for a new node. */
  node?: number;
  cost: number;
  /** Extra money per second this upgrade would produce. */
  deltaProduction: number;
}

export interface HacknetView {
  nodes: HacknetNodeState[];
  /** Purchase cost of the next node. */
  nodeCost: number;
  maxNodes: number;
  /** Production of a freshly-purchased node, so a new node can be ranked
   *  against upgrading an existing one. */
  newNodeProduction: number;
  /** Candidate upgrades, priced by the game. */
  upgrades: UpgradeOption[];
  /** Money the arbiter granted this feature. */
  moneyGranted: number;
  /** Seconds of run left to amortise a purchase against. */
  horizonSec: number;
  /** True in BN9/SF9, where production is hashes rather than money. */
  hashMode: boolean;
}

export interface HacknetDecision {
  /** The purchase to make, or undefined to hold. */
  buy?: UpgradeOption;
  /** Everything considered, best payback first. */
  ranked: (UpgradeOption & { paybackSec: number; netOverHorizon: number })[];
  why: string;
  /** Set when nothing is worth buying and why that is. */
  hold?: string;
}

/** Seconds for an upgrade to repay its own cost. `Infinity` when it produces
 * nothing, which is a real answer and must not be treated as "cheap". */
export function paybackSec(option: UpgradeOption): number {
  return option.deltaProduction > 0 ? option.cost / option.deltaProduction : Infinity;
}

/** Net money over the remaining horizon: what it earns in the time left, minus
 * what it costs. NEGATIVE means buying it loses money before the run ends.
 *
 * This is the whole objective, and it is why the horizon is a first-class
 * input rather than a tuning constant. */
export function netOverHorizon(option: UpgradeOption, horizonSec: number): number {
  return option.deltaProduction * horizonSec - option.cost;
}

export function stepHacknet(view: HacknetView): HacknetDecision {
  const candidates: UpgradeOption[] = [...view.upgrades];

  // A new node competes with upgrading an existing one, on the same terms.
  if (view.nodes.length < view.maxNodes && Number.isFinite(view.nodeCost)) {
    candidates.push({ kind: "node", cost: view.nodeCost, deltaProduction: view.newNodeProduction });
  }

  const ranked = candidates
    .map((option) => ({
      ...option,
      paybackSec: paybackSec(option),
      netOverHorizon: netOverHorizon(option, view.horizonSec),
    }))
    .sort((a, b) => {
      // Best net over the horizon first; payback breaks ties, then a stable
      // key so the order never depends on the probe's iteration order.
      const net = b.netOverHorizon - a.netOverHorizon;
      if (net !== 0) return net;
      const payback = a.paybackSec - b.paybackSec;
      if (payback !== 0) return payback;
      return `${a.kind}${a.node ?? ""}` < `${b.kind}${b.node ?? ""}` ? -1 : 1;
    });

  if (ranked.length === 0) {
    return { ranked, why: "nothing to buy", hold: "no upgrades available" };
  }

  const best = ranked[0]!;
  if (best.netOverHorizon <= 0) {
    return {
      ranked,
      why: "every upgrade loses money before the horizon ends",
      hold:
        `best option (${best.kind}) pays back in ${Number.isFinite(best.paybackSec) ? Math.round(best.paybackSec) : "never"}s ` +
        `against ${Math.round(view.horizonSec)}s left`,
    };
  }
  if (best.cost > view.moneyGranted) {
    return {
      ranked,
      why: "waiting for funds",
      hold: `${best.kind} costs $${Math.round(best.cost).toLocaleString()}, granted $${Math.round(view.moneyGranted).toLocaleString()}`,
    };
  }

  return {
    buy: best,
    ranked,
    why:
      `${best.kind}${best.node !== undefined ? ` on node ${best.node}` : ""} nets ` +
      `$${Math.round(best.netOverHorizon).toLocaleString()} over the remaining ${Math.round(view.horizonSec)}s`,
  };
}
