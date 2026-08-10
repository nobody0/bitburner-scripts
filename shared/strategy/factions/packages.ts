import { formatNumber, formatScientific } from "../../format.ts";
import {
  NEUROFLUX,
  augCost,
  closePrereqs,
  estimatedCost,
  scoreAug,
  totalCost,
  type AugInfo,
  type PurchaseCandidate,
} from "./augs.ts";
import type { FactionIntent } from "./plan.ts";
import {
  addRepToFavor,
  bestWorkType,
  donationForRep,
  favorToRep,
  repFromDonation,
} from "./rep.ts";
import { combinedEtaSec, estimateBlockerSec, isReachable, type Blocker } from "./requirements.ts";
import { settlingMoney, type FactionStanding, type FactionsView } from "./state.ts";

/** A breakpoint package is the smallest useful planning unit. Reputation is
 * continuous, but decisions only change when it buys another augmentation or
 * banks another point of useful favor at install. */
export type FactionPackage = FactionIntent;

export interface PackageSelection {
  intent?: FactionPackage;
  runnerUp?: FactionPackage;
  /** Complete, non-dominated frontier for review/tests/UI. */
  frontiers: Map<string, FactionPackage[]>;
  foreclosed: { name: string; bannedBy: string }[];
}

const ROUTE_MANDATORY_VALUE = 100;

function cycleCompatible(standing: FactionStanding, standings: readonly FactionStanding[]): boolean {
  if (standing.joined) return true;
  for (const member of standings) {
    if (!member.joined || member.name === standing.name) continue;
    if (standing.enemies.includes(member.name) || member.enemies.includes(standing.name)) return false;
  }
  return true;
}

function routeAwareScore(aug: AugInfo, view: FactionsView): number {
  // The Red Pill's terminal bonus belongs only to the Daedalus acquisition
  // route. It is still allowed to count as an ordinary augmentation elsewhere,
  // but must not drag a labyrinth/Bladeburner run through Daedalus.
  if (aug.name === "The Red Pill" && view.route && view.route !== "daedalus") return 0;
  let value = Math.max(0, scoreAug(aug, view.weights));
  if (aug.name === "The Red Pill" && view.route === "daedalus") value += ROUTE_MANDATORY_VALUE;
  return value;
}

function usableAt(
  repTarget: number,
  offered: readonly AugInfo[],
  owned: ReadonlySet<string>,
  view: FactionsView,
): AugInfo[] {
  const under = offered.filter((aug) => augCost(aug, view.priceContext).repCost <= repTarget);
  const names = new Set(under.map((aug) => aug.name));
  // A package may include its own prerequisites, but it cannot promise a
  // dependent whose prerequisite must first come from another faction.
  return under
    .filter((aug) => aug.prereqs.every((name) => owned.has(name) || names.has(name)))
    // This is policy order, not the price-minimising order. Immediately
    // before an install we walk it from the most useful item downward: buying
    // a lower-priority augmentation is still better than leaving it behind,
    // but it must not jump a better one.
    .sort(
      (a, b) =>
        routeAwareScore(b, view) - routeAwareScore(a, view) ||
        augCost(a, view.priceContext).repCost - augCost(b, view.priceContext).repCost ||
        (a.name < b.name ? -1 : 1),
    );
}

function candidateCost(faction: string, augs: readonly AugInfo[], view: FactionsView): number {
  const order = closePrereqs(augs.map((aug) => aug.name), view.catalog, view.owned);
  const candidates: PurchaseCandidate[] = order.flatMap((name) => {
    const aug = view.catalog.get(name);
    return aug ? [{ name, aug, faction }] : [];
  });
  // Price the package in the order it will actually be BOUGHT, not the order it
  // was chosen in. `usableAt` sorts by usefulness on purpose; costing that
  // sequence charges the 1.9x queue escalation to whichever items happen to be
  // most valuable, which can overstate a package by a wide margin and lose it a
  // comparison it should win.
  //
  // Estimated, not solved: this runs once per (faction, reputation breakpoint) on
  // the frontier, hundreds of times a tick, and the exact ordering DP is
  // exponential — it would cost seconds per decision to sharpen a number that only
  // ever feeds a comparison against another estimate.
  return estimatedCost(candidates, view.priceContext);
}

function remainingGoal(view: FactionsView): number {
  if (!Number.isFinite(view.targetAugCount)) return Infinity;
  return Math.max(0, view.targetAugCount - view.owned.size);
}

function packageValue(
  augs: readonly AugInfo[],
  allOffered: readonly AugInfo[],
  standing: FactionStanding,
  favorAfterInstall: number,
  view: FactionsView,
  countGoal = remainingGoal(view),
): number {
  const count = Math.min(augs.length, countGoal);
  const quality = augs.reduce((sum, aug) => sum + routeAwareScore(aug, view), 0);

  // Favor matters only through future work it can accelerate. Weight the rate
  // improvement by how many residual augmentations this faction could still
  // provide; this makes a favor-only push worthless once the faction is done.
  const acquired = new Set(augs.map((aug) => aug.name));
  const future = allOffered.filter((aug) => !acquired.has(aug.name)).length;
  const beforeRate = 1 + standing.favor / 100;
  const afterRate = 1 + favorAfterInstall / 100;
  const futureRateGain = future * Math.max(0, afterRate / beforeRate - 1);
  const crossesDonation =
    standing.favor < view.favorToDonate && favorAfterInstall >= view.favorToDonate ? future * 0.5 : 0;
  return count + quality + futureRateGain + crossesDonation;
}

function targetCandidates(standing: FactionStanding, offered: readonly AugInfo[], view: FactionsView): Map<number, "augmentations" | "favor"> {
  const targets = new Map<number, "augmentations" | "favor">();
  let highestAugRep = 0;
  for (const aug of offered) {
    const rep = augCost(aug, view.priceContext).repCost;
    if (Number.isFinite(rep)) {
      targets.set(rep, "augmentations");
      highestAugRep = Math.max(highestAugRep, rep);
    }
  }

  // Generate the favor frontier from the exact inverse formula. These are not
  // fixed heuristic steps: every reachable integer favor point is considered
  // and dominance pruning removes the ones that buy too little. The bound is
  // relative, not "always stop at donation favor": it is the smaller of the
  // remaining augmentation ladder and what work/donation can reach inside the
  // current horizon. This lets a dominant faction earn favor beyond donation
  // unlock, but makes the exponential rep curve penalise every extra point.
  const currentAfterInstall = addRepToFavor(standing.favor, standing.rep);
  const work = bestWorkType(standing.offers, view.person, standing.favor, view.repContext, true);
  const workReach = standing.rep + (work?.repPerSec ?? 0) * view.horizonSec;
  const donationReach = standing.favor >= view.favorToDonate
    ? standing.rep + repFromDonation(
        settlingMoney(view),
        view.person.mults.faction_rep,
        view.repContext.factionWorkRepGain,
      )
    : standing.rep;
  const reachableRep = Math.min(highestAugRep, Math.max(workReach, donationReach));
  const reachableFavor = addRepToFavor(standing.favor, reachableRep);
  const lastFavor = Math.max(Math.ceil(currentAfterInstall), Math.floor(reachableFavor));
  for (let favor = Math.floor(currentAfterInstall) + 1; favor <= lastFavor; favor++) {
    const rep = Math.max(0, favorToRep(favor) - favorToRep(standing.favor));
    if (!Number.isFinite(rep) || rep <= standing.rep) continue;
    if (!targets.has(rep)) targets.set(rep, "favor");
  }
  return targets;
}

export function factionPackageFrontier(
  standing: FactionStanding,
  blockers: readonly Blocker[],
  view: FactionsView,
): FactionPackage[] {
  if (!cycleCompatible(standing, view.factions)) return [];
  if (!standing.joined && !standing.invited && !isReachable(blockers)) return [];

  // NeuroFlux is deliberately not an unlock objective: nearly every faction
  // offers it, so counting it here makes every otherwise-empty faction appear
  // valuable. It belongs in the final repeatable purchase sweep.
  const offered = [...view.catalog.values()].filter(
    (aug) => aug.name !== NEUROFLUX && !view.owned.has(aug.name) && aug.factions.includes(standing.name),
  );
  if (offered.length === 0) return [];

  const joinSec = standing.joined || standing.invited
    ? 0
    : combinedEtaSec(blockers, (blocker) => estimateBlockerSec(blocker, view.incomePerSec));
  const work = bestWorkType(standing.offers, view.person, standing.favor, view.repContext, true);
  const targets = [...targetCandidates(standing, offered, view).entries()].sort((a, b) => a[0] - b[0]);
  const raw: FactionPackage[] = [];

  for (const [repTarget, purpose] of targets) {
    const augs = usableAt(repTarget, offered, view.owned, view);
    const favorAfterInstall = addRepToFavor(standing.favor, Math.max(standing.rep, repTarget));
    const value = packageValue(augs, offered, standing, favorAfterInstall, view);
    if (value <= 0) continue;

    const repGap = Math.max(0, repTarget - standing.rep);
    const repSec = repGap === 0 ? 0 : work && work.repPerSec > 0 ? repGap / work.repPerSec : Infinity;
    const purchaseCost = candidateCost(standing.name, augs, view);
    const workMoneySec = Math.max(0, purchaseCost - settlingMoney(view)) / Math.max(1, view.incomePerSec);
    // Unlock/player work is sequential; script income continues beneath it.
    const workEta = Math.max(joinSec + repSec, workMoneySec);

    // Donation is a genuine alternate path once current favor permits it.
    // Price the donation and the augmentations together: spending all cash on
    // reputation while leaving nothing to buy the package is not a solution.
    const canDonate = standing.favor >= view.favorToDonate;
    const exactDonation = canDonate
      ? donationForRep(repGap, view.person.mults.faction_rep, view.repContext.factionWorkRepGain)
      : Infinity;
    const donateMoneySec = Math.max(0, purchaseCost + exactDonation - settlingMoney(view)) / Math.max(1, view.incomePerSec);
    const donateEta = canDonate ? Math.max(joinSec, donateMoneySec) : Infinity;
    const useDonation = donateEta < workEta;
    const donationCost = useDonation ? exactDonation : 0;
    const moneySec = useDonation ? donateMoneySec : workMoneySec;
    const totalCost = purchaseCost + donationCost;
    const etaSec = Math.max(1, Math.min(workEta, donateEta));
    if (etaSec > view.horizonSec) continue;

    raw.push({
      faction: standing.name,
      repTarget,
      augmentations: augs.map((aug) => aug.name),
      value,
      etaSec,
      marginalRate: 0,
      favorAfterInstall,
      purpose,
      unlockSec: joinSec,
      repSec,
      moneySec,
      totalCost,
      purchaseCost,
      donationCost,
      rate: value / etaSec,
      why: "",
    });
  }

  // Increasing reputation must buy strictly more terminal value. This is the
  // Pareto frontier over (rep target, value); dominated pushes disappear.
  const frontier: FactionPackage[] = [];
  let bestValue = 0;
  for (const pkg of raw) {
    if (pkg.value <= bestValue + 1e-12) continue;
    const previous = frontier.at(-1);
    const marginalValue = pkg.value - (previous?.value ?? 0);
    const marginalSec = Math.max(1, pkg.etaSec - (previous?.etaSec ?? 0));
    pkg.marginalRate = marginalValue / marginalSec;
    pkg.why = previous
      ? `${pkg.augmentations.length} augmentation(s) by ${formatNumber(pkg.repTarget)} rep; marginal ${formatScientific(pkg.marginalRate)} value/sec`
      : `${pkg.augmentations.length} augmentation(s) in ${Math.round(pkg.etaSec)}s; ${formatScientific(pkg.rate)} value/sec`;
    frontier.push(pkg);
    bestValue = pkg.value;
  }
  return frontier;
}

function bestEntry(frontier: readonly FactionPackage[]): { pkg: FactionPackage; index: number } | undefined {
  let best: { pkg: FactionPackage; index: number } | undefined;
  for (let index = 0; index < frontier.length; index++) {
    const pkg = frontier[index]!;
    if (!best || pkg.rate > best.pkg.rate || (pkg.rate === best.pkg.rate && pkg.value > best.pkg.value)) {
      best = { pkg, index };
    }
  }
  return best;
}

/** Revalue another faction after the current package has already supplied its
 * shared augmentations. This is the uniqueness term: an augmentation sold by
 * both factions is valuable once, not once per seller. We retain genuine
 * favor utility, but remove duplicated count and multiplier utility. */
function residualPackage(
  pkg: FactionPackage,
  acquired: ReadonlySet<string>,
  view: FactionsView,
): FactionPackage {
  const standing = view.factions.find((entry) => entry.name === pkg.faction)!;
  const residualOffered = [...view.catalog.values()].filter(
    (aug) =>
      aug.name !== NEUROFLUX &&
      !view.owned.has(aug.name) &&
      !acquired.has(aug.name) &&
      aug.factions.includes(pkg.faction),
  );
  const residualAugs = pkg.augmentations
    .filter((name) => !acquired.has(name))
    .map((name) => view.catalog.get(name))
    .filter((aug): aug is AugInfo => Boolean(aug));
  const value = packageValue(
    residualAugs,
    residualOffered,
    standing,
    pkg.favorAfterInstall,
    view,
    Math.max(0, remainingGoal(view) - acquired.size),
  );
  const purchaseCost = candidateCost(pkg.faction, residualAugs, view);
  const totalCost = purchaseCost + pkg.donationCost;
  const moneySec = Math.max(0, totalCost - settlingMoney(view)) / Math.max(1, view.incomePerSec);
  const effortSec = pkg.unlockSec + (pkg.donationCost > 0 ? 0 : pkg.repSec);
  const etaSec = Math.max(1, effortSec, moneySec);
  return {
    ...pkg,
    augmentations: residualAugs.map((aug) => aug.name),
    value,
    etaSec,
    purchaseCost,
    totalCost,
    moneySec,
    rate: value / etaSec,
  };
}

function bestRunner(
  winnerFaction: string,
  intent: FactionPackage,
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
): FactionPackage | undefined {
  const acquired = new Set(intent.augmentations);
  let best: FactionPackage | undefined;
  for (const [faction, frontier] of frontiers) {
    if (faction === winnerFaction) continue;
    for (const candidate of frontier) {
      const residual = residualPackage(candidate, acquired, view);
      if (residual.value <= 0) continue;
      if (
        !best ||
        residual.rate > best.rate ||
        (residual.rate === best.rate && residual.value > best.value) ||
        (residual.rate === best.rate && residual.value === best.value && residual.faction < best.faction)
      ) {
        best = residual;
      }
    }
  }
  return best;
}

/** Choose one faction and how far to push it. The best alternative's entry
 * rate is the opportunity cost: continue extending the winner only while its
 * next marginal package still beats switching. */
export function selectFactionPackage(
  view: FactionsView,
  blockers: ReadonlyMap<string, readonly Blocker[]>,
): PackageSelection {
  const frontiers = new Map<string, FactionPackage[]>();
  const entries: { faction: string; pkg: FactionPackage; index: number }[] = [];
  for (const standing of view.factions) {
    const frontier = factionPackageFrontier(standing, blockers.get(standing.name) ?? [], view);
    if (frontier.length === 0) continue;
    frontiers.set(standing.name, frontier);
    const entry = bestEntry(frontier);
    if (entry) entries.push({ faction: standing.name, ...entry });
  }
  entries.sort((a, b) => b.pkg.rate - a.pkg.rate || b.pkg.value - a.pkg.value || (a.faction < b.faction ? -1 : 1));
  const winner = entries[0];
  if (!winner) return { frontiers, foreclosed: [] };

  let intent = winner.pkg;
  let intentIndex = winner.index;
  const frontier = frontiers.get(winner.faction)!;
  // The raw frontier need not be concave: a small favor breakpoint can sit
  // between two augmentation breakpoints. Comparing only adjacent entries
  // would stop at that weak favor point and never see the valuable augment
  // behind it. Repeatedly take the best secant from the current package; this
  // is the upper concave envelope and is the actual marginal opportunity cost.
  while (intentIndex + 1 < frontier.length) {
    const runner = bestRunner(winner.faction, intent, frontiers, view);
    const runnerRate = runner?.rate ?? 0;
    let bestExtension: { pkg: FactionPackage; index: number; rate: number } | undefined;
    for (let index = intentIndex + 1; index < frontier.length; index++) {
      const pkg = frontier[index]!;
      const rate = (pkg.value - intent.value) / Math.max(1, pkg.etaSec - intent.etaSec);
      if (!bestExtension || rate > bestExtension.rate || (rate === bestExtension.rate && index > bestExtension.index)) {
        bestExtension = { pkg, index, rate };
      }
    }
    if (!bestExtension || bestExtension.rate + 1e-12 < runnerRate) break;
    intent = { ...bestExtension.pkg, marginalRate: bestExtension.rate };
    intentIndex = bestExtension.index;
  }
  const runner = bestRunner(winner.faction, intent, frontiers, view);
  const runnerRate = runner?.rate ?? 0;
  intent = {
    ...intent,
    why: runner
      ? `${intent.why}; stop before the next extension falls below ${runner.faction} at ${formatScientific(runnerRate)} value/sec`
      : `${intent.why}; no competing faction package fits the horizon`,
  };

  const winnerStanding = view.factions.find((standing) => standing.name === winner.faction)!;
  const enemies = new Set(winnerStanding.enemies);
  const foreclosed = view.factions
    .filter((standing) =>
      standing.name !== winner.faction &&
      (enemies.has(standing.name) || standing.enemies.includes(winner.faction)) &&
      !standing.joined,
    )
    .map((standing) => ({ name: standing.name, bannedBy: winner.faction }));
  return { intent, ...(runner ? { runnerUp: runner } : {}), frontiers, foreclosed };
}
