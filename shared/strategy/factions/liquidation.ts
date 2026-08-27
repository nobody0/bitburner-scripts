import {
  augCost,
  closePrereqs,
  NEUROFLUX,
  orderPurchases,
  totalCost,
  type AugInfo,
  type PriceContext,
  type PurchaseCandidate,
} from "./augs.ts";
import {
  addRepToFavor,
  donationForRep,
  favorToRep,
  MAX_FAVOR,
  repFromDonation,
} from "./rep.ts";

/** The standing fields needed to decide whether reputation can be bought. */
export interface LiquidationStanding {
  name: string;
  joined: boolean;
  rep: number;
  favor: number;
}

interface PlannedDonation {
  faction: string;
  /** Reputation the faction must have before its assigned purchases. */
  repTarget: number;
  amount: number;
}

interface DonationAwarePurchasePlan {
  order: PurchaseCandidate[];
  totalCost: number;
  requiredFunded: boolean;
}

interface DonationPackage {
  faction: string;
  target: number;
  cost: number;
  mask: number;
}

function donationPackages(
  augs: readonly AugInfo[],
  standings: readonly LiquidationStanding[],
  favorToDonate: number,
  factionRepMult: number,
  factionWorkRepGain: number,
  ctx: PriceContext,
): DonationPackage[] {
  const packages: DonationPackage[] = [];
  for (const standing of standings) {
    if (!standing.joined) continue;
    const targets = new Set<number>();
    for (const aug of augs) if (aug.factions.includes(standing.name)) targets.add(augCost(aug, ctx).repCost);
    for (const target of [...targets].sort((a, b) => a - b)) {
      if (standing.rep < target && standing.favor < favorToDonate) continue;
      let mask = 0;
      for (let i = 0; i < augs.length; i++) {
        const aug = augs[i]!;
        if (aug.factions.includes(standing.name) && augCost(aug, ctx).repCost <= target) mask |= 1 << i;
      }
      const cost = donationForRep(
        Math.max(0, target - standing.rep),
        factionRepMult,
        factionWorkRepGain,
      );
      packages.push({ faction: standing.name, target, cost, mask });
    }
  }
  return packages;
}

/** Minimum donation assignment for a fixed one-shot set.
 *
 * One donation to a faction satisfies every lower reputation target there, so
 * donation costs are maxima per faction, not a sum per augmentation. Up to the
 * purchase solver's existing exact-set limit this is an exact weighted set
 * cover over augmentation masks; larger liquidation boards use a deterministic
 * incremental fallback and then consolidate each faction at its highest target. */
export function assignDonationSellers(input: {
  augs: readonly AugInfo[];
  standings: readonly LiquidationStanding[];
  favorToDonate: number;
  factionRepMult: number;
  factionWorkRepGain: number;
  ctx: PriceContext;
}): { candidates: PurchaseCandidate[]; donations: PlannedDonation[]; cost: number } | undefined {
  const { augs } = input;
  if (augs.length === 0) return { candidates: [], donations: [], cost: 0 };
  const packages = donationPackages(
    augs,
    input.standings,
    input.favorToDonate,
    input.factionRepMult,
    input.factionWorkRepGain,
    input.ctx,
  );
  if (packages.length === 0) return undefined;

  const targetByFaction = new Map<string, number>();
  if (augs.length <= 16) {
    const size = 1 << augs.length;
    const best = new Float64Array(size).fill(Infinity);
    const fromMask = new Int32Array(size).fill(-1);
    const fromPackage = new Int32Array(size).fill(-1);
    best[0] = 0;
    for (let mask = 0; mask < size; mask++) {
      if (!Number.isFinite(best[mask]!)) continue;
      for (let p = 0; p < packages.length; p++) {
        const next = mask | packages[p]!.mask;
        if (next === mask) continue;
        const cost = best[mask]! + packages[p]!.cost;
        if (cost < best[next]! - 1e-9) {
          best[next] = cost;
          fromMask[next] = mask;
          fromPackage[next] = p;
        }
      }
    }
    let mask = size - 1;
    if (!Number.isFinite(best[mask]!)) return undefined;
    while (mask !== 0) {
      const p = fromPackage[mask]!;
      if (p < 0) return undefined;
      const pkg = packages[p]!;
      targetByFaction.set(pkg.faction, Math.max(targetByFaction.get(pkg.faction) ?? 0, pkg.target));
      mask = fromMask[mask]!;
    }
  } else {
    for (const aug of augs) {
      let best: { standing: LiquidationStanding; incremental: number } | undefined;
      for (const standing of input.standings) {
        if (!standing.joined || !aug.factions.includes(standing.name)) continue;
        const repCost = augCost(aug, input.ctx).repCost;
        if (standing.rep < repCost && standing.favor < input.favorToDonate) continue;
        const before = targetByFaction.get(standing.name) ?? standing.rep;
        const after = Math.max(before, repCost);
        const incremental = donationForRep(
          Math.max(0, after - standing.rep), input.factionRepMult, input.factionWorkRepGain,
        ) - donationForRep(
          Math.max(0, before - standing.rep), input.factionRepMult, input.factionWorkRepGain,
        );
        if (!best || incremental < best.incremental || (incremental === best.incremental && standing.name < best.standing.name)) {
          best = { standing, incremental };
        }
      }
      if (!best) return undefined;
      targetByFaction.set(
        best.standing.name,
        Math.max(targetByFaction.get(best.standing.name) ?? 0, augCost(aug, input.ctx).repCost),
      );
    }
  }

  const donations: PlannedDonation[] = [...targetByFaction]
    .map(([faction, repTarget]) => {
      const standing = input.standings.find((entry) => entry.name === faction)!;
      return {
        faction,
        repTarget,
        amount: donationForRep(
          Math.max(0, repTarget - standing.rep), input.factionRepMult, input.factionWorkRepGain,
        ),
      };
    })
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => a.faction.localeCompare(b.faction));

  const candidates: PurchaseCandidate[] = [];
  for (const aug of augs) {
    const seller = [...targetByFaction]
      .filter(([faction, target]) => target >= augCost(aug, input.ctx).repCost && aug.factions.includes(faction))
      .map(([faction]) => input.standings.find((entry) => entry.name === faction)!)
      .sort((a, b) => b.rep - a.rep || b.favor - a.favor || a.name.localeCompare(b.name))[0];
    if (!seller) return undefined;
    candidates.push({ name: aug.name, aug, faction: seller.name });
  }
  return {
    candidates,
    donations,
    cost: donations.reduce((sum, entry) => sum + entry.amount, 0),
  };
}

/** Select a jointly affordable one-shot batch in value order. Required names
 * are closed and accepted first; optional names can never displace them. */
export function selectDonationAwareBatch(input: {
  valueOrder: readonly string[];
  required: readonly string[];
  catalog: ReadonlyMap<string, AugInfo>;
  standings: readonly LiquidationStanding[];
  owned: ReadonlySet<string>;
  ctx: PriceContext;
  money: number;
  favorToDonate: number;
  factionRepMult: number;
  factionWorkRepGain: number;
}): DonationAwarePurchasePlan {
  const priced = (augs: readonly AugInfo[]) => {
    const assignment = assignDonationSellers({ ...input, augs });
    if (!assignment) return undefined;
    const order = orderPurchases(assignment.candidates, input.ctx);
    const purchaseCost = totalCost(order, input.ctx);
    return {
      order,
      totalCost: purchaseCost + assignment.cost,
    };
  };

  const requiredNames = closePrereqs(input.required, input.catalog, input.owned);
  const requiredAugs: AugInfo[] = [];
  for (const name of requiredNames) {
    const aug = input.catalog.get(name);
    if (!aug) return { order: [], totalCost: 0, requiredFunded: false };
    requiredAugs.push(aug);
  }
  const requiredPlan = priced(requiredAugs);
  if (!requiredPlan || requiredPlan.totalCost > input.money) {
    return { order: [], totalCost: 0, requiredFunded: false };
  }

  const accepted = [...requiredAugs];
  const acceptedNames = new Set(requiredNames);
  let plan = requiredPlan;
  const optional = closePrereqs(
    input.valueOrder,
    input.catalog,
    new Set([...input.owned, ...requiredNames]),
  );
  for (const name of optional) {
    if (acceptedNames.has(name) || (name !== NEUROFLUX && input.owned.has(name))) continue;
    const aug = input.catalog.get(name);
    if (!aug || aug.prereqs.some((prereq) => !input.owned.has(prereq) && !acceptedNames.has(prereq))) continue;
    const trial = priced([...accepted, aug]);
    if (!trial || trial.totalCost > input.money) continue;
    accepted.push(aug);
    acceptedNames.add(name);
    plan = trial;
  }

  return { ...plan, requiredFunded: true };
}

/** Cheapest jointly funded closure that adds at least `wanted` distinct names. */
export function selectDonationAwareCountClosure(input: {
  catalog: ReadonlyMap<string, AugInfo>;
  standings: readonly LiquidationStanding[];
  owned: ReadonlySet<string>;
  wanted: number;
  ctx: PriceContext;
  money: number;
  favorToDonate: number;
  factionRepMult: number;
  factionWorkRepGain: number;
  /** Higher-value closure wins when two additions have the same total cost. */
  tieValue?: (aug: AugInfo) => number;
}): DonationAwarePurchasePlan {
  const selected = new Set<string>();
  let funded: DonationAwarePurchasePlan = {
    order: [],
    totalCost: 0,
    requiredFunded: input.wanted <= 0,
  };

  while (selected.size < input.wanted) {
    let bestNames: string[] | undefined;
    let bestPlan: DonationAwarePurchasePlan | undefined;
    let bestValue = -Infinity;
    const base = new Set([...input.owned, ...selected]);
    for (const name of input.catalog.keys()) {
      if (selected.has(name)) continue;
      const adding = closePrereqs([name], input.catalog, base);
      if (adding.length === 0) continue;
      const trial = selectDonationAwareBatch({
        ...input,
        valueOrder: [],
        required: [...selected, ...adding],
      });
      if (!trial.requiredFunded) continue;
      const value = adding.reduce(
        (sum, candidate) => sum + (input.tieValue?.(input.catalog.get(candidate)!) ?? 0),
        0,
      );
      if (!bestPlan || trial.totalCost < bestPlan.totalCost || (trial.totalCost === bestPlan.totalCost && value > bestValue)) {
        bestNames = adding;
        bestPlan = trial;
        bestValue = value;
      }
    }
    if (!bestNames || !bestPlan) break;
    for (const name of bestNames) selected.add(name);
    funded = bestPlan;
  }

  return selected.size >= input.wanted
    ? funded
    : { order: [], totalCost: 0, requiredFunded: false };
}

interface ResidualDonationAllocation {
  faction: string;
  amount: number;
  repTarget: number;
}

/** Bound the exact point-by-point water fill. Beyond this many favor points,
 * the remaining cash goes to the best current marginal destination. This path
 * runs inside the controller at the install boundary; a corrupted/astronomical
 * balance must not turn the final sweep into millions of planner iterations. */
const MAX_RESIDUAL_FAVOR_STEPS = 8_192;

/** Split a final pure-favor donation over exact integer favor breakpoints.
 * Every faction's next point gets its exact dollar cost and time-saving value;
 * the best marginal point is taken until no whole point fits. The fractional
 * remainder goes to the best current marginal destination. */
export function allocateResidualDonations(input: {
  money: number;
  standings: readonly LiquidationStanding[];
  favorToDonate: number;
  factionRepMult: number;
  factionWorkRepGain: number;
  /** Future faction-work seconds that another unit of favor can accelerate. */
  futureWorkSec: Readonly<Record<string, number>>;
}): ResidualDonationAllocation[] {
  let remaining = Math.max(0, input.money);
  if (!(remaining > 0)) return [];
  const eligible = input.standings.filter((entry) => entry.joined && entry.favor >= input.favorToDonate);
  if (eligible.length === 0) return [];
  const allocated = new Map<string, number>();
  const repRate = (amount: number) => repFromDonation(amount, input.factionRepMult, input.factionWorkRepGain);
  const favorAfter = (standing: LiquidationStanding, amount: number) =>
    addRepToFavor(standing.favor, standing.rep + repRate(amount));
  const utility = (standing: LiquidationStanding, amount: number) => {
    const work = Math.max(0, input.futureWorkSec[standing.name] ?? 0);
    const before = 1 + addRepToFavor(standing.favor, standing.rep) / 100;
    const after = 1 + favorAfter(standing, amount) / 100;
    return work * Math.max(0, 1 - before / after);
  };

  // Favor is capped; each iteration buys one exact point. In realistic saves
  // the exponential rep curve keeps this in the hundreds, but retain the game
  // cap as the hard termination proof.
  for (let steps = 0; steps < Math.min(MAX_FAVOR * eligible.length, MAX_RESIDUAL_FAVOR_STEPS); steps++) {
    let best: { standing: LiquidationStanding; cost: number; rate: number } | undefined;
    for (const standing of eligible) {
      const have = allocated.get(standing.name) ?? 0;
      const currentFavor = favorAfter(standing, have);
      const nextFavor = Math.floor(currentFavor) + 1;
      if (nextFavor > MAX_FAVOR) continue;
      const targetRep = Math.max(0, favorToRep(nextFavor) - favorToRep(standing.favor));
      const total = donationForRep(
        Math.max(0, targetRep - standing.rep), input.factionRepMult, input.factionWorkRepGain,
      );
      const cost = Math.max(0, total - have);
      if (!(cost > 0) || cost > remaining) continue;
      const gain = utility(standing, have + cost) - utility(standing, have);
      const rate = gain / cost;
      if (!best || rate > best.rate || (rate === best.rate && (standing.rep > best.standing.rep || (standing.rep === best.standing.rep && standing.name < best.standing.name)))) {
        best = { standing, cost, rate };
      }
    }
    if (!best) break;
    allocated.set(best.standing.name, (allocated.get(best.standing.name) ?? 0) + best.cost);
    remaining -= best.cost;
  }

  if (remaining > 0) {
    const destination = [...eligible].sort((a, b) => {
      const quantum = Math.max(1, remaining * 1e-6);
      const aHave = allocated.get(a.name) ?? 0;
      const bHave = allocated.get(b.name) ?? 0;
      const aRate = (utility(a, aHave + quantum) - utility(a, aHave)) / quantum;
      const bRate = (utility(b, bHave + quantum) - utility(b, bHave)) / quantum;
      return bRate - aRate || b.rep - a.rep || b.favor - a.favor || a.name.localeCompare(b.name);
    })[0]!;
    allocated.set(destination.name, (allocated.get(destination.name) ?? 0) + remaining);
    remaining = 0;
  }

  return [...allocated]
    .filter(([, amount]) => amount > 0)
    .map(([faction, amount]) => {
      const standing = eligible.find((entry) => entry.name === faction)!;
      return {
        faction,
        amount,
        repTarget: standing.rep + repRate(amount),
      };
    })
    .sort((a, b) => a.faction.localeCompare(b.faction));
}
