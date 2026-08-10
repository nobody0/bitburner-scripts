import type { Need, NeedUrgency } from "../needs.ts";
import type { HackContext } from "../../formulas.ts";
import { formatNumber } from "../../format.ts";
import { solveCycle, type RamCaps, type TargetStatics } from "../targeting.ts";

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

export type HashUpgradeName = (typeof HASH_UPGRADE)[keyof typeof HASH_UPGRADE];

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
  why: string;
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
  spend?: { name: string; target?: string; count: number; cost: number; why: string };
  /** A goal worth saving for. Hashes must not be sold while this is set. */
  reserve?: { name: string; target?: string; cost: number; missing: number; why: string };
  /** Required total capacity when the selected goal cannot fit in the bank. */
  capacityTarget?: number;
  ranked: RankedHashAction[];
  why: string;
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
    const lostSaleValue = sell && sell.cost > 0 ? (quote.cost / sell.cost) * 1_000_000 : 0;
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
        reserve: { name: goal.name, target: goal.target, cost: goal.cost, missing: Math.max(0, goal.cost - view.current), why: goal.why },
        capacityTarget: goal.cost,
        why: `${goal.name} serves the highest-value goal but needs ${formatNumber(Math.ceil(goal.cost))} hash capacity`,
      };
    }
    if (!goal.affordable) {
      return {
        ranked,
        reserve: { name: goal.name, target: goal.target, cost: goal.cost, missing: goal.cost - view.current, why: goal.why },
        why: `saving ${formatNumber(Math.ceil(goal.cost - view.current))} more hashes for ${goal.name}`,
      };
    }
    return {
      ranked,
      spend: { name: goal.name, target: goal.target, count: 1, cost: goal.cost, why: goal.why },
      why: goal.why,
    };
  }

  if (sell && sell.cost > 0) {
    const count = Math.floor(view.current / sell.cost);
    if (count > 0) {
      return {
        ranked,
        spend: { name: sell.name, count, cost: sell.cost * count, why: "no higher-value hash goal; realize cash" },
        why: "no higher-value hash goal; selling hashes for money",
      };
    }
  }
  return { ranked, why: view.productionPerSec > 0 ? "accumulating hashes" : "hash production is unavailable" };
}
