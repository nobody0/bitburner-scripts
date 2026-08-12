import { formatNumber, formatScientific } from "../../format.ts";
import {
  NEUROFLUX,
  augCost,
  closePrereqs,
  countSlotWeight,
  estimatedCost,
  scoreAug,
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
 * banks another point of useful favor at install.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/Faction.ts#L77-L85
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L55-L141 */
export type FactionPackage = FactionIntent;

export interface PackageSelection {
  intent?: FactionPackage;
  runnerUp?: FactionPackage;
  /** Complete, non-dominated frontier for review/tests/UI. */
  frontiers: Map<string, FactionPackage[]>;
  foreclosed: { name: string; bannedBy: string }[];
  /** No intent, but only because the planning horizon filtered every raw
   * candidate out — a TRANSIENT state (the node forecast recalibrates), not
   * "nothing left worth pushing for". The install verdict must not read a
   * horizon-starved frontier as concluded: doing so armed premature installs
   * at cycle start whenever the forecast dipped for one 90s dwell. */
  horizonStarved?: boolean;
}

const ROUTE_MANDATORY_VALUE = 100;
/** CashRoot persists across installs and replaces the first $1m plus BruteSSH
 * bootstrap, but remains comparable to an augmentation slot. */
const CASHROOT_BOOTSTRAP_VALUE = 0.5;
/** Favor is a smooth rate multiplier except at the donation crossing. Sampling
 * every integer up to a horizon-derived maximum made one strategy pass grow
 * from milliseconds to seconds when a noisy long-node ETA appeared. Keep the
 * discontinuity exact and approximate the smooth curve with a fixed budget. */
export const MAX_FAVOR_BREAKPOINTS = 8;
// One WorldView is immutable for one strategy pass. Faction frontiers revisit
// the same augmentation hundreds of times (breakpoints, residual runners and
// ordering ties), so scoring its static multiplier vector each time only burns
// the controller's planning budget without changing a decision.
const ROUTE_SCORE_CACHE = new WeakMap<FactionsView, Map<string, number>>();
function cycleCompatible(standing: FactionStanding, standings: readonly FactionStanding[]): boolean {
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L35-L51
  if (standing.joined) return true;
  for (const member of standings) {
    if (!member.joined || member.name === standing.name) continue;
    if (standing.enemies.includes(member.name) || member.enemies.includes(standing.name)) return false;
  }
  return true;
}

function routeAwareScore(aug: AugInfo, view: FactionsView): number {
  let cache = ROUTE_SCORE_CACHE.get(view);
  if (!cache) {
    cache = new Map();
    ROUTE_SCORE_CACHE.set(view, cache);
  }
  const cached = cache.get(aug.name);
  if (cached !== undefined) return cached;
  // The Red Pill's terminal bonus belongs to a faction acquisition route. It
  // must not drag a labyrinth/Bladeburner run through an unrelated faction.
  if (aug.name === "The Red Pill" && view.route && view.route !== "daedalus" && view.route !== "gang") return 0;
  let value = Math.max(0, scoreAug(aug, view.weights));
  if (aug.name === "The Red Pill" && (view.route === "daedalus" || view.route === "gang")) value += ROUTE_MANDATORY_VALUE;
  if (aug.name === "CashRoot Starter Kit" && !view.owned.has(aug.name)) value += CASHROOT_BOOTSTRAP_VALUE;
  cache.set(aug.name, value);
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
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L52-L108
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
  // `closePrereqs` normally removes owned augmentations. NeuroFlux is the
  // exception: the next level remains purchasable after the name is owned,
  // and its 1.14^level + queue-scaled price is the whole cost of this
  // repeatable breakpoint. Treating it as already satisfied made every later
  // NFG package cost $0 with a 1-second ETA, an infinite-looking marginal
  // frontier that could veto installs forever.
  const closureOwned = new Set(view.owned);
  if (augs.some((aug) => aug.name === NEUROFLUX)) closureOwned.delete(NEUROFLUX);
  const order = closePrereqs(augs.map((aug) => aug.name), view.catalog, closureOwned);
  const candidates: PurchaseCandidate[] = order.flatMap((name) => {
    const aug = view.catalog.get(name);
    return aug ? [{ name, aug, faction }] : [];
  });
  // Price the package in the order it will actually be BOUGHT, not the order it
  // was chosen in. `usableAt` sorts by usefulness on purpose; costing that
  // sequence charges the 1.9x queue escalation to whichever items happen to be
  // most valuable, which can overstate a package by a wide margin and lose it a
  // comparison it should win.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/AugmentationHelpers.ts#L24-L38
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

/** Favor only pays after an install. Once the selected route's final-batch
 * policy forbids another partial reset, favor earned now cannot accelerate
 * acquisition of the remaining count package; it activates at the same reset
 * that finishes the gate. This mirrors progression's route-relative half-gate
 * without introducing a BitNode-specific constant. */
function favorCanActivateBeforeGoal(view: FactionsView): boolean {
  return !Number.isFinite(view.targetAugCount)
    || view.requirementView.augCount < Math.ceil(view.targetAugCount / 2);
}

function packageValues(
  augs: readonly AugInfo[],
  allOffered: readonly AugInfo[],
  standing: FactionStanding,
  favorAfterInstall: number,
  view: FactionsView,
  countGoal = remainingGoal(view),
): { total: number; activation: number } {
  // Repeatable NFG levels are multiplier value, not one fresh permanent
  // augmentation apiece. The first level can fill one Daedalus count slot;
  // later levels cannot because the game stores installed NFG as one entry.
  const countable = augs.filter(
    (aug) => aug.name !== NEUROFLUX || (Number.isFinite(view.targetAugCount) && !view.owned.has(NEUROFLUX)),
  ).length;
  // Count is ROUTE progress, not one universal value unit per object. Early
  // in a finite gate it competes at nearly one unit per unique slot; as the
  // gate fills, scarce closing slots should favor multiplier quality. The
  // route's batch policy independently guarantees closure, so selection need
  // not fill the last slots with the cheapest low-value objects. A 1/5 floor
  // keeps count material beside a normal log-multiplier score. Count stays out
  // of activationValue/install cadence. Routes with no finite gate get no flat
  // count bonus at all—the augmentation's real effects are its value there.
  const countWeight = countSlotWeight(view.targetAugCount, countGoal);
  const count = Number.isFinite(countGoal) && countGoal > 0
    ? Math.min(countable, countGoal) * countWeight
    : 0;
  const quality = augs.reduce((sum, aug) => sum + routeAwareScore(aug, view), 0);

  // Favor matters only through future work it can accelerate. Weight the rate
  // improvement by how many residual augmentations this faction could still
  // provide; this makes a favor-only push worthless once the faction is done.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/formulas/reputation.ts#L11-L55
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/formulas/donation.ts#L7-L30
  const acquired = new Set(augs.map((aug) => aug.name));
  const future = allOffered.filter((aug) => !acquired.has(aug.name)).length;
  const beforeRate = 1 + standing.favor / 100;
  const afterRate = 1 + favorAfterInstall / 100;
  const favorUseful = favorCanActivateBeforeGoal(view);
  const futureRateGain = favorUseful ? future * Math.max(0, afterRate / beforeRate - 1) : 0;
  const crossesDonation = favorUseful
    && standing.favor < view.favorToDonate
    && favorAfterInstall >= view.favorToDonate
      ? future * 0.5
      : 0;
  const activation = quality + futureRateGain + crossesDonation;
  return { total: count + activation, activation };
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
  // Favor is a NEXT-cycle accelerator. Before joining a faction it is too
  // speculative to justify the unlock path by itself: doing so can select a
  // zero-augmentation package at a deep faction and starve the permanent
  // augmentations needed by the current route. Unlock an unjoined faction for
  // an actual augmentation first; after membership, favor competes normally.
  if ((standing.joined || standing.invited) && favorCanActivateBeforeGoal(view)) {
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
    const firstFavor = Math.floor(currentAfterInstall) + 1;
    const lastFavor = Math.max(Math.ceil(currentAfterInstall), Math.floor(reachableFavor));
    const span = Math.max(0, lastFavor - firstFavor + 1);
    const sampledFavors = new Set<number>();
    if (span <= MAX_FAVOR_BREAKPOINTS) {
      for (let favor = firstFavor; favor <= lastFavor; favor++) sampledFavors.add(favor);
    } else {
      // The NEAREST breakpoint is the cheapest and soonest one, and therefore
      // the only favor target a package can realistically bank before the
      // install. Sampling from `firstFavor + span/N` upward drops it entirely,
      // leaving the selection to choose between a favor goal an order of
      // magnitude further away and no favor at all. Seed it, then spread the
      // remaining budget over the rest of the reachable span.
      sampledFavors.add(firstFavor);
      for (let sample = 1; sample < MAX_FAVOR_BREAKPOINTS; sample++) {
        sampledFavors.add(Math.round(firstFavor + (lastFavor - firstFavor) * sample / (MAX_FAVOR_BREAKPOINTS - 1)));
      }
    }
    // Donation is the one discontinuity in the otherwise smooth favor curve.
    if (standing.favor < view.favorToDonate && view.favorToDonate >= firstFavor && view.favorToDonate <= lastFavor) {
      sampledFavors.add(view.favorToDonate);
    }
    for (const favor of [...sampledFavors].sort((a, b) => a - b)) {
      const rep = Math.max(0, favorToRep(favor) - favorToRep(standing.favor));
      if (!Number.isFinite(rep) || rep <= standing.rep) continue;
      if (!targets.has(rep)) targets.set(rep, "favor");
    }
  }
  return targets;
}

export function factionPackageFrontier(
  standing: FactionStanding,
  blockers: readonly Blocker[],
  view: FactionsView,
  /** Incremented for every raw candidate the horizon filter drops — lets the
   * selection distinguish "nothing exists" from "nothing fits the horizon". */
  stats?: { horizonDropped: number },
): FactionPackage[] {
  if (!cycleCompatible(standing, view.factions)) return [];
  if (!standing.joined && !standing.invited && !isReachable(blockers)) return [];

  // NFG is a real one-level breakpoint for factions we have already joined:
  // it may be worth earning its escalating reputation before the final sweep.
  // It must not justify unlocking an otherwise-useless faction merely because
  // nearly every ordinary faction sells it. The next refresh naturally offers
  // the next level with the updated 1.14 rep/money costs.
  //
  // One exception is load-bearing for finite count routes. Once NFG is
  // installed it can never fill another distinct slot, so while the projected
  // (owned + end-loaded bank) count is still short it must not consume the
  // player work frontier ahead of distinct augmentations. It remains in the
  // final sweep as a residual cash sink and returns as a work objective once
  // the count gate is complete (or on a route with no finite count gate).
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/Augmentations.ts#L1159-L1209
  const suppressRepeatNfgForCount = Number.isFinite(view.targetAugCount)
    && remainingGoal(view) > 0
    && view.owned.has(NEUROFLUX);
  const offered = [...view.catalog.values()].filter((aug) =>
    aug.factions.includes(standing.name)
    && (aug.name === NEUROFLUX
      ? standing.joined && !suppressRepeatNfgForCount
      : !view.owned.has(aug.name))
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
    const values = packageValues(augs, offered, standing, favorAfterInstall, view);
    const value = values.total;
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
    // The node horizon is itself estimated from the selected route's terminal
    // package. Never let small disagreement between that estimator and this
    // package estimator erase the route objective: doing so creates a circular
    // veto where The Red Pill falls just outside its own horizon, factions
    // switches to optional NFG/favor work, and repeated economic installs move
    // the horizon again without ever advancing the node. Optional packages
    // still have to repay inside the horizon.
    const routeMandatory =
      (view.route === "daedalus" || view.route === "gang")
      && augs.some((aug) => aug.name === "The Red Pill")
      && !view.owned.has("The Red Pill")
      // Before the faction is available, its invite blockers (especially
      // Daedalus's augmentation-count gate) are the route objective. Ignoring
      // the horizon at that point would select Red Pill too early and starve
      // the ordinary packages that satisfy those blockers.
      && (standing.joined || standing.invited);
    if (etaSec > view.horizonSec && !routeMandatory) {
      if (stats) stats.horizonDropped++;
      continue;
    }

    raw.push({
      faction: standing.name,
      repTarget,
      augmentations: augs.map((aug) => aug.name),
      value,
      activationValue: values.activation,
      etaSec,
      marginalRate: 0,
      marginalActivationRate: 0,
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
    const marginalActivationValue = Math.max(
      0,
      (pkg.activationValue ?? 0) - (previous?.activationValue ?? 0),
    );
    const marginalSec = Math.max(1, pkg.etaSec - (previous?.etaSec ?? 0));
    pkg.marginalRate = marginalValue / marginalSec;
    pkg.marginalActivationRate = marginalActivationValue / marginalSec;
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
  const values = packageValues(
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
    value: values.total,
    activationValue: values.activation,
    etaSec,
    purchaseCost,
    totalCost,
    moneySec,
    rate: values.total / etaSec,
    marginalActivationRate: values.activation / etaSec,
  };
}

function bestRunner(
  winnerFaction: string,
  intent: FactionPackage,
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
  residualCache: Map<string, FactionPackage>,
): FactionPackage | undefined {
  const acquired = new Set(intent.augmentations);
  const acquiredKey = [...acquired].sort().join("\0");
  let best: FactionPackage | undefined;
  for (const [faction, frontier] of frontiers) {
    if (faction === winnerFaction) continue;
    for (const candidate of frontier) {
      const cacheKey = `${faction}\0${candidate.repTarget}\0${acquiredKey}`;
      let residual = residualCache.get(cacheKey);
      if (!residual) {
        residual = residualPackage(candidate, acquired, view);
        residualCache.set(cacheKey, residual);
      }
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
  const stats = { horizonDropped: 0 };
  for (const standing of view.factions) {
    const frontier = factionPackageFrontier(standing, blockers.get(standing.name) ?? [], view, stats);
    if (frontier.length === 0) continue;
    frontiers.set(standing.name, frontier);
    const entry = bestEntry(frontier);
    if (entry) entries.push({ faction: standing.name, ...entry });
  }
  entries.sort((a, b) => b.pkg.rate - a.pkg.rate || b.pkg.value - a.pkg.value || (a.faction < b.faction ? -1 : 1));
  const terminalPill =
    (view.route === "daedalus" || view.route === "gang")
    && !view.owned.has("The Red Pill")
      ? [...frontiers.entries()]
          .flatMap(([faction, frontier]) => frontier.map((pkg, index) => ({ faction, pkg, index })))
          .filter((entry) => {
            const standing = view.factions.find((candidate) => candidate.name === entry.faction);
            return (standing?.joined === true || standing?.invited === true)
              && entry.pkg.augmentations.includes("The Red Pill");
          })
          .sort((a, b) => a.pkg.etaSec - b.pkg.etaSec || a.pkg.totalCost - b.pkg.totalCost || (a.faction < b.faction ? -1 : 1))[0]
      : undefined;
  // Once the selected faction-acquisition route has a reachable Red Pill
  // package, it is a route constraint rather than another value/sec bidder.
  // Optional NFG levels remain real frontier candidates and residual-sweep
  // purchases, but they may not indefinitely outrank the augmentation that
  // ends the node merely because the next level is immediately affordable.
  const winner = terminalPill ?? entries[0];
  if (!winner) return { frontiers, foreclosed: [], ...(stats.horizonDropped > 0 ? { horizonStarved: true } : {}) };

  let intent = winner.pkg;
  let intentIndex = winner.index;
  const frontier = frontiers.get(winner.faction)!;
  const residualCache = new Map<string, FactionPackage>();
  // Runner opportunity cost is a stopping threshold, not a new global search
  // at every point on the winner's own concave envelope. Recomputing every
  // competing residual frontier for each extension made one faction decision
  // hundreds of milliseconds. The final runner is recomputed once against
  // the chosen set so shared augmentations are still removed exactly.
  const entryRunner = terminalPill
    ? undefined
    : bestRunner(winner.faction, intent, frontiers, view, residualCache);
  // The raw frontier need not be concave: a small favor breakpoint can sit
  // between two augmentation breakpoints. Comparing only adjacent entries
  // would stop at that weak favor point and never see the valuable augment
  // behind it. Repeatedly take the best secant from the current package; this
  // is the upper concave envelope and is the actual marginal opportunity cost.
  while (!terminalPill && intentIndex + 1 < frontier.length) {
    const runnerRate = entryRunner?.rate ?? 0;
    let bestExtension: { pkg: FactionPackage; index: number; rate: number; activationRate: number } | undefined;
    for (let index = intentIndex + 1; index < frontier.length; index++) {
      const pkg = frontier[index]!;
      const extensionSec = Math.max(1, pkg.etaSec - intent.etaSec);
      const rate = (pkg.value - intent.value) / extensionSec;
      const activationRate = Math.max(0, (pkg.activationValue ?? 0) - (intent.activationValue ?? 0)) / extensionSec;
      if (!bestExtension || rate > bestExtension.rate || (rate === bestExtension.rate && index > bestExtension.index)) {
        bestExtension = { pkg, index, rate, activationRate };
      }
    }
    if (!bestExtension || bestExtension.rate + 1e-12 < runnerRate) break;
    intent = {
      ...bestExtension.pkg,
      marginalRate: bestExtension.rate,
      marginalActivationRate: bestExtension.activationRate,
    };
    intentIndex = bestExtension.index;
  }
  const runner = bestRunner(winner.faction, intent, frontiers, view, residualCache);
  const runnerRate = runner?.rate ?? 0;
  intent = {
    ...intent,
    why: terminalPill
      ? `${intent.why}; The Red Pill is mandatory for the selected ${view.route} route`
      : runner
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
