import {
  NEUROFLUX,
  augCost,
  closePurchaseSet,
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
import { pacedSecFor, repCurveResource } from "./pace.ts";
import { DEFAULT_PLANNING_HORIZON_SEC } from "../progression/forecast.ts";
import { settlingMoney, type FactionStanding, type FactionsView } from "./state.ts";

/** A breakpoint package is the smallest useful planning unit. Reputation is
 * continuous, but decisions only change when it buys another augmentation or
 * banks another point of useful favor at install.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/Faction.ts#L77-L85
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L55-L141 */
export type FactionPackage = FactionIntent;


/** Favor is a smooth rate multiplier except at the donation crossing. Sampling
 * every integer up to a horizon-derived maximum made one strategy pass grow
 * from milliseconds to seconds when a noisy long-node ETA appeared. Keep the
 * discontinuity exact and approximate the smooth curve with a fixed budget. */
export const MAX_FAVOR_BREAKPOINTS = 8;
// One WorldView is immutable for one strategy pass. Faction frontiers revisit
// the same augmentation hundreds of times (breakpoints, set members and
// ordering ties), so scoring its static multiplier vector each time only burns
// the controller's planning budget without changing a decision.
const ROUTE_SCORE_CACHE = new WeakMap<FactionsView, Map<string, number>>();
export function cycleCompatible(standing: FactionStanding, standings: readonly FactionStanding[]): boolean {
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L35-L51
  if (standing.joined) return true;
  for (const member of standings) {
    if (!member.joined || member.name === standing.name) continue;
    if (standing.enemies.includes(member.name) || member.enemies.includes(standing.name)) return false;
  }
  return true;
}

export function routeAwareScore(aug: AugInfo, view: FactionsView): number {
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
  let value = Math.max(0, scoreAug(aug, view.weights, view.rates?.worth));
  // The Red Pill is a GATE: the daedalus and gang routes cannot end without
  // it, so what it is worth is the run that cannot otherwise finish. Priced at
  // the planning horizon — in the same BN-seconds as every multiplier beside
  // it, instead of a flat 100 that meant nothing next to them.
  if (aug.name === "The Red Pill" && (view.route === "daedalus" || view.route === "gang")) {
    value += Number.isFinite(view.horizonSec) ? view.horizonSec : DEFAULT_PLANNING_HORIZON_SEC;
  }
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
  const order = closePurchaseSet(augs.map((aug) => aug.name), view.catalog, view.owned);
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

export function remainingGoal(view: FactionsView): number {
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

/** A faction whose shelf carries the route's terminal purchase keeps its
 * donation-unlock favor path alive regardless of the count-phase gate above:
 * crossing favorToDonate there converts the terminal reputation requirement
 * into money, so the favor path must remain eligible. */
export function favorServesRouteTerminal(standing: FactionStanding, offersRedPill: boolean, view: FactionsView): boolean {
  return (view.route === "daedalus" || view.route === "gang")
    && !view.owned.has("The Red Pill")
    && (standing.joined || standing.invited)
    && offersRedPill;
}

export function packageValues(
  augs: readonly AugInfo[],
  allOffered: readonly AugInfo[],
  standing: FactionStanding,
  favorAfterInstall: number,
  view: FactionsView,
  countGoal = remainingGoal(view),
): { total: number; activation: number; count: number; quality: number; favor: number } {
  const count = countValue(augs, view, countGoal);
  const quality = qualityValue(augs, view);

  // Favor matters only through future work it can accelerate. Weight the rate
  // improvement by how many residual augmentations this faction could still
  // provide; this makes a favor-only push worthless once the faction is done.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/formulas/reputation.ts#L11-L55
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/formulas/donation.ts#L7-L30
  const favor = favorValue(
    standing,
    favorAfterInstall,
    allOffered,
    new Set(augs.map((aug) => aug.name)),
    view,
  );
  const activation = quality + favor;
  return { total: count + activation, activation, count, quality, favor };
}

/** Route-count progress a set of augmentations buys, in the same BN-seconds as
 * everything else: the time one slot removes from the count leg.
 *
 * Count stays out of `activation` and so out of the install cadence, which
 * compares rates — a gate is not a rate. Routes with no finite gate, or an
 * unpriced acquisition rate, get nothing; there an augmentation's real effects
 * are its whole value.
 *
 * Shared with the portfolio solver, which computes the same term over the UNION
 * of a whole set. Two copies of the NeuroFlux rule below is exactly the sort of
 * thing that drifts. */
export function countValue(
  augs: readonly AugInfo[],
  view: FactionsView,
  countGoal = remainingGoal(view),
): number {
  // Repeatable NFG levels are multiplier value, not one fresh permanent
  // augmentation apiece. The first level can fill one Daedalus count slot;
  // later levels cannot because the game stores installed NFG as one entry.
  const nfgCountable = Number.isFinite(view.targetAugCount) && !view.owned.has(NEUROFLUX);
  let countable = 0;
  for (const aug of augs) if (aug.name !== NEUROFLUX || nfgCountable) countable++;
  const countWeight = countSlotWeight(view.rates?.worth ?? new Map(), countGoal);
  return Number.isFinite(countGoal) && countGoal > 0
    ? Math.min(countable, countGoal) * countWeight
    : 0;
}

/** What a set of augmentations is worth for its EFFECTS, route-aware. */
export function qualityValue(augs: readonly AugInfo[], view: FactionsView): number {
  return augs.reduce((sum, aug) => sum + routeAwareScore(aug, view), 0);
}

/** The favor term of a push, split out so a PORTFOLIO can recompose value over
 * the union of everything it acquires.
 *
 * `acquired` is deliberately a parameter rather than this package's own
 * augmentations: favor is only worth what the FUTURE work it accelerates is
 * worth, and an augmentation this faction sells that another faction in the
 * same set already supplies is not future work. Computing it against one
 * package alone overstates every faction whose catalogue overlaps another's. */
export function favorValue(
  standing: FactionStanding,
  favorAfterInstall: number,
  allOffered: readonly AugInfo[],
  acquired: ReadonlySet<string>,
  view: FactionsView,
): number {
  // A count, not a list: this runs once per chosen faction per portfolio
  // evaluation, and materialising the survivors just to read `.length` was a
  // measurable slice of the budget sweep. The portfolio path counts the same
  // overlap from the other side (its acquired union is usually the smaller
  // set) and calls `favorValueFromFuture` directly.
  let future = 0;
  for (const aug of allOffered) if (!acquired.has(aug.name)) future++;
  return favorValueFromFuture(
    standing,
    favorAfterInstall,
    future,
    view,
    favorServesRouteTerminal(standing, allOffered.some((aug) => aug.name === "The Red Pill"), view),
  );
}

/** {@link favorValue} with the future-work count already resolved. */
export function favorValueFromFuture(
  standing: FactionStanding,
  favorAfterInstall: number,
  future: number,
  view: FactionsView,
  servesRouteTerminal = false,
): number {
  const beforeRate = 1 + standing.favor / 100;
  const afterRate = 1 + favorAfterInstall / 100;
  const favorUseful = favorCanActivateBeforeGoal(view) || servesRouteTerminal;
  // Favor IS a reputation rate multiplier, so the term is quoted in what a
  // relative reputation-rate increase is worth — the same BN-seconds `quality`
  // is in. Scaled, not reshaped: the `future` weighting and the crossing
  // constant are relative preferences within this term and are unchanged.
  const reputationWorth = view.rates?.worth.get("reputation") ?? 1;
  const futureRateGain = favorUseful
    ? future * Math.max(0, afterRate / beforeRate - 1) * reputationWorth
    : 0;
  const crossesDonation = favorUseful
    && standing.favor < view.favorToDonate
    && favorAfterInstall >= view.favorToDonate
      ? future * 0.5 * reputationWorth
      : 0;
  return futureRateGain + crossesDonation;
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
  if ((standing.joined || standing.invited)
    && (favorCanActivateBeforeGoal(view) || favorServesRouteTerminal(standing, offered.some((aug) => aug.name === "The Red Pill"), view))) {
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
    // Paced, not divided: reputation per second rises with the skill the work
    // type reads, so a spot-rate divide overstates every deep breakpoint. The
    // correction may only shorten (`pace.ts`), so a faction with no curve
    // signal keeps exactly the spot answer.
    const repSpotSec = repGap === 0 ? 0 : work && work.repPerSec > 0 ? repGap / work.repPerSec : Infinity;
    const repSec = work
      ? pacedSecFor(repSpotSec, view.cyclePace, repCurveResource(work.type))
      : repSpotSec;
    const purchaseCost = candidateCost(standing.name, augs, view);
    const workMoneySec = pacedSecFor(
      Math.max(0, purchaseCost - settlingMoney(view)) / Math.max(1, view.incomePerSec),
      view.cyclePace,
      "money",
    );
    // Unlock/player work is sequential; script income continues beneath it.
    const workEta = Math.max(joinSec + repSec, workMoneySec);

    // Donation is a genuine alternate path once current favor permits it.
    // Price the donation and the augmentations together: spending all cash on
    // reputation while leaving nothing to buy the package is not a solution.
    const canDonate = standing.favor >= view.favorToDonate;
    const exactDonation = canDonate
      ? donationForRep(repGap, view.person.mults.faction_rep, view.repContext.factionWorkRepGain)
      : Infinity;
    const donateMoneySec = pacedSecFor(
      Math.max(0, purchaseCost + exactDonation - settlingMoney(view)) / Math.max(1, view.incomePerSec),
      view.cyclePace,
      "money",
    );
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
    // Beyond-horizon packages are discounted, not cliffed: joins, company rep
    // and faction rep persist within the node, so partial progress toward a
    // longer unlock retains the realizable fraction of its value. A package so
    // far out that under half its value is realizable is treated as noise —
    // the estimate has too little evidence at that range to bid against
    // in-horizon work (this also bounds estimator-corruption blast radius).
    const horizonFraction = etaSec > view.horizonSec && !routeMandatory
      ? Math.max(0, Math.min(1, view.horizonSec / etaSec))
      : 1;
    if (horizonFraction < 0.5) {
      if (stats) stats.horizonDropped++;
      continue;
    }

    raw.push({
      faction: standing.name,
      repTarget,
      augmentations: augs.map((aug) => aug.name),
      value: value * horizonFraction,
      activationValue: values.activation * horizonFraction,
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
      rate: value * horizonFraction / etaSec,
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
    frontier.push(pkg);
    bestValue = pkg.value;
  }
  return frontier;
}

/** Every faction's non-dominated frontier, plus whether the horizon filter is
 * what emptied the result.
 *
 * Split out from selection so the SET solver and any review tooling read the
 * same candidate generator. `horizonStarved` distinguishes "nothing left worth
 * pushing for" from "the node forecast dipped for one dwell", which the install
 * verdict must not confuse. */
export function buildFrontiers(
  view: FactionsView,
  blockers: ReadonlyMap<string, readonly Blocker[]>,
): { frontiers: Map<string, FactionPackage[]>; horizonDropped: number } {
  const frontiers = new Map<string, FactionPackage[]>();
  const stats = { horizonDropped: 0 };
  for (const standing of view.factions) {
    const frontier = factionPackageFrontier(standing, blockers.get(standing.name) ?? [], view, stats);
    if (frontier.length === 0) continue;
    frontiers.set(standing.name, frontier);
  }
  return { frontiers, horizonDropped: stats.horizonDropped };
}
