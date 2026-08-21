import type { Need, NeedUrgency } from "../needs.ts";
import type { HackContext } from "../../formulas.ts";
import { solveCycle, type RamCaps, type TargetStatics } from "../targeting.ts";
import { HASH_SALE_DOLLARS } from "./formulas.ts";

/** Pinned v3.0.1 registry for hash upgrade names, costs, targets, and effects:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacknet/HashUpgrades.ts
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Hacknet.ts */

export const HASH_UPGRADE = {
  money: "Sell for Money",
  corpFunds: "Sell for Corporation Funds",
  minSecurity: "Reduce Minimum Security",
  maxMoney: "Increase Maximum Money",
  study: "Improve Studying",
  gym: "Improve Gym Training",
  corpResearch: "Exchange for Corporation Research",
  bladeRank: "Exchange for Bladeburner Rank",
  bladeSp: "Exchange for Bladeburner SP",
  contract: "Generate Coding Contract",
  companyFavor: "Company Favor",
} as const;

export interface HashUpgradeQuote {
  name: string;
  level: number;
  cost: number;
}

export interface HashGoalCandidate {
  name: string;
  target?: string;
  /** Goal band. The baseline money conversion is zero. */
  priority: number;
  /** Economic value over the remaining run, when it can be estimated. */
  valueDollars?: number;
  urgency?: NeedUrgency;
}

export interface HashView {
  current: number;
  capacity: number;
  productionPerSec: number;
  upgrades: readonly HashUpgradeQuote[];
  goals: readonly HashGoalCandidate[];
}

export interface RankedHashAction extends HashGoalCandidate {
  cost: number;
  level: number;
  affordable: boolean;
  fitsCapacity: boolean;
  /** Cash obtainable by selling the hashes consumed by this action. */
  saleValueDollars: number;
  netDollars?: number;
  /** False when selling the same hashes is worth more over this horizon. */
  eligible: boolean;
}

export interface HashDecision {
  spend?: { name: string; target?: string; count: number; cost: number };
  /** A goal worth saving for. Hashes must not be sold while this is set. */
  reserve?: { name: string; target?: string; cost: number; missing: number };
  /** Required total capacity when the selected goal cannot fit in the bank. */
  capacityTarget?: number;
  ranked: RankedHashAction[];
}

const urgencyValue: Record<NeedUrgency, number> = { blocking: 90, wanted: 65, nice: 40 };

export function hashNeedPriority(need: Pick<Need, "urgency" | "weight">): number {
  return urgencyValue[need.urgency] + Math.min(9, Math.max(0, need.weight));
}

export function moneyMaxAfterHash(current: number): number {
  if (!(current > 0)) return current;
  const softCap = 10e12;
  let multiplier = 1.02;
  if (current > softCap) {
    multiplier = 1 + 0.02 / Math.log(current - softCap) / Math.log(8);
  }
  return current * multiplier;
}

/** Dollar value over the remaining horizon of the two target-mutating hash
 * actions, using the same exact cycle solver that selected the farm target. */
export function targetHashValues(
  ctx: HackContext,
  target: TargetStatics,
  caps: RamCaps,
  fleetGb: number,
  horizonSec: number,
): { minSecurity: number; maxMoney: number } {
  const base = solveCycle(ctx, target, 1, caps)?.score ?? 0;
  const minSecurity = solveCycle(ctx, {
    ...target,
    minDifficulty: Math.max(1, target.minDifficulty * 0.98),
  }, 1, caps)?.score ?? base;
  const maxMoney = solveCycle(ctx, {
    ...target,
    moneyMax: moneyMaxAfterHash(target.moneyMax),
  }, 1, caps)?.score ?? base;
  const seconds = Math.max(0, horizonSec);
  return {
    minSecurity: Math.max(0, minSecurity - base) * Math.max(0, fleetGb) * seconds,
    maxMoney: Math.max(0, maxMoney - base) * Math.max(0, fleetGb) * seconds,
  };
}

/** Goal-aware hash spending. Availability comes entirely from the observed
 * getHashUpgrades/hashCost menu, so BN9/SF9 and version-specific availability
 * are authoritative. Effects whose target subsystem is locked never enter
 * `goals` in the first place. */
export function stepHashes(view: HashView): HashDecision {
  const quotes = new Map(view.upgrades.map((quote) => [quote.name, quote]));
  const sell = quotes.get(HASH_UPGRADE.money);
  const ranked: RankedHashAction[] = [];

  for (const goal of view.goals) {
    const quote = quotes.get(goal.name);
    if (!quote || !Number.isFinite(quote.cost) || quote.cost <= 0) continue;
    const lostSaleValue = sell && sell.cost > 0 ? (quote.cost / sell.cost) * HASH_SALE_DOLLARS : 0;
    const netDollars = goal.valueDollars === undefined ? undefined : goal.valueDollars - lostSaleValue;
    ranked.push({
      ...goal,
      cost: quote.cost,
      level: quote.level,
      affordable: view.current >= quote.cost,
      fitsCapacity: view.capacity >= quote.cost,
      saleValueDollars: lostSaleValue,
      eligible: netDollars === undefined || netDollars > 0,
      ...(netDollars !== undefined ? { netDollars } : {}),
    });
  }

  ranked.sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) ||
    b.priority - a.priority ||
    (b.netDollars ?? 0) - (a.netDollars ?? 0) ||
    a.cost - b.cost ||
    `${a.name}:${a.target ?? ""}`.localeCompare(`${b.name}:${b.target ?? ""}`),
  );

  const goal = ranked.find((candidate) => candidate.eligible);
  if (goal) {
    if (!goal.fitsCapacity) {
      return {
        ranked,
        reserve: { name: goal.name, target: goal.target, cost: goal.cost, missing: Math.max(0, goal.cost - view.current) },
        capacityTarget: goal.cost,
      };
    }
    if (!goal.affordable) {
      return {
        ranked,
        reserve: { name: goal.name, target: goal.target, cost: goal.cost, missing: goal.cost - view.current },
      };
    }
    return {
      ranked,
      spend: { name: goal.name, target: goal.target, count: 1, cost: goal.cost },
    };
  }

  if (sell && sell.cost > 0) {
    const count = Math.floor(view.current / sell.cost);
    if (count > 0) {
      return {
        ranked,
        spend: { name: sell.name, count, cost: sell.cost * count },
      };
    }
  }
  return { ranked };
}
