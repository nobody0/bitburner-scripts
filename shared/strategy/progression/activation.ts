import type { ChannelWorth } from "../income.ts";
/** Reset-activated value of the current bankroll.
 *
 * Cadence has to answer two questions about a pile of cash that has NOT been
 * spent (purchases are deliberately end-loaded): what would an install
 * actually activate if the cycle ended now, and — on a route with a finite
 * installed-count gate — can that pile close the gate at all. Both are the
 * same search: order candidates, close prerequisites, price the set at the
 * escalating queue multiplier, and stop when the money runs out. They live
 * here, beside the install verdict they feed, so the answer is a pure
 * function of a view rather than something only a whole simulated node can
 * exercise.
 *
 * The pricing model is `augs.ts`'s transcription of the upstream formula, not
 * the offers' reported prices: a reported price is what the NEXT purchase
 * costs, and a set of n purchases pays n escalating prices. */

import { AUGMENTATIONS } from "../../features/augmentations.ts";
import {
  countSlotWeight,
  NEUROFLUX,
  scoreAug,
  type AugInfo,
  type ObjectiveWeights,
  type PriceContext,
  type PurchaseCandidate,
} from "../factions/augs.ts";
import {
  selectDonationAwareBatch,
  selectDonationAwareCountClosure,
  type LiquidationStanding,
} from "../factions/liquidation.ts";
import { DAEDALUS_FINAL_BATCH_FRACTION } from "./endgame.ts";
import { earlyCountBatchAllowed, routeCountInstallValue } from "./decide.ts";

interface ActivationDonationContext {
  standings: readonly LiquidationStanding[];
  favorToDonate: number;
  factionRepMult: number;
  factionWorkRepGain: number;
}

/** AugInfo view of the shared augmentation table for a set of names. */
function activationCatalog(
  names: Iterable<string>,
  options: { includeNeuroflux?: boolean } = {},
): Map<string, AugInfo> {
  const catalog = new Map<string, AugInfo>();
  for (const name of names) {
    const aug = AUGMENTATIONS[name];
    if (!aug) continue;
    if (name === NEUROFLUX && !options.includeNeuroflux) continue;
    catalog.set(name, {
      name,
      baseCost: aug.cost,
      baseRepRequirement: aug.rep,
      factions: [...aug.factions],
      prereqs: [...(aug.prereqs ?? [])],
      mults: { ...(aug.mults ?? {}) },
      ...(aug.multsUnknown ? { multsUnknown: true } : {}),
    });
  }
  return catalog;
}

/** The one-shot set this bankroll could actually convert at install.
 *
 * "Every item fits on its own" is not a funded set: the second and later
 * purchases pay the queue escalation. Summing individually affordable offers
 * fabricates reset value whenever the priced queue can buy fewer candidates
 * than the independent checks admit. Selection uses the
 * same value-order / payment-order split as the transaction boundary, so the
 * value cadence sees is the value the sweep would really buy. */
export function fundedActivationBatch(input: {
  /** Unowned, prerequisite-reachable names sold by a joined faction. */
  realizable: Iterable<string>;
  /** Owned, queued and already-pending names — the closure's base. */
  owned: ReadonlySet<string>;
  weights: ObjectiveWeights;
  /** Flat route value of one distinct count slot, or 0 off a count route. */
  countSlotValue: number;
  /** Include the first NeuroFlux level when it can still add the one distinct
   * name the installed-count gate observes. Later repeat levels never do. */
  neurofluxCountable?: boolean;
  ctx: PriceContext;
  money: number;
  donation: ActivationDonationContext;
}): PurchaseCandidate[] {
  const catalog = activationCatalog(input.realizable, {
    includeNeuroflux: input.neurofluxCountable === true,
  });
  // Cheapest value first, so a bankroll that cannot buy everything buys the
  // most activation per dollar. The count slot is worth the same on every
  // candidate, so it enters the denominator rather than the ranking.
  const valueOrder = [...catalog.values()]
    .sort((a, b) => {
      const aValue = Math.max(1e-9, scoreAug(a, input.weights) + input.countSlotValue);
      const bValue = Math.max(1e-9, scoreAug(b, input.weights) + input.countSlotValue);
      return a.baseCost / aValue - b.baseCost / bValue
        || scoreAug(b, input.weights) - scoreAug(a, input.weights)
        || (a.name < b.name ? -1 : 1);
    })
    .map((aug) => aug.name);
  return selectDonationAwareBatch({
    valueOrder,
    required: [],
    catalog,
    standings: input.donation.standings,
    owned: input.owned,
    ctx: input.ctx,
    money: input.money,
    favorToDonate: input.donation.favorToDonate,
    factionRepMult: input.donation.factionRepMult,
    factionWorkRepGain: input.donation.factionWorkRepGain,
  }).order;
}

/** Can this bankroll buy `wanted` more DISTINCT augmentations, prerequisites
 * included?
 *
 * On Daedalus's final batch an empty queue is expected, because purchases are
 * end-loaded. Answering yes promotes the reset from "optional" to
 * route-required, which is what lets the hold-at-2/3 policy finish rather
 * than deadlocking before the sweep that would have created its queue.
 *
 * Greedy on marginal set cost: each round takes the prerequisite closure that
 * raises the priced total least. Filling a count gate is a min-cost cover, and
 * a cheap augmentation behind an expensive prerequisite is not cheap — pricing
 * whole closures rather than single items is what makes the greedy step
 * honest. */
export function countClosureAffordable(input: {
  realizable: Iterable<string>;
  owned: ReadonlySet<string>;
  wanted: number;
  /** A repeatable NeuroFlux level fills a count slot as well as any one-shot,
   * but only while the gate has not already counted one this run. */
  neurofluxCountable: boolean;
  ctx: PriceContext;
  money: number;
  donation: ActivationDonationContext;
}): boolean {
  if (input.wanted <= 0) return true;
  const catalog = activationCatalog(input.realizable, { includeNeuroflux: input.neurofluxCountable });
  return selectDonationAwareCountClosure({
    catalog,
    standings: input.donation.standings,
    owned: input.owned,
    wanted: input.wanted,
    ctx: input.ctx,
    money: input.money,
    favorToDonate: input.donation.favorToDonate,
    factionRepMult: input.donation.factionRepMult,
    factionWorkRepGain: input.donation.factionWorkRepGain,
  }).requiredFunded;
}

/** Whether a count-gated route may install now, and what the partial tranche
 * is worth to it. Count slots pay at the gate rather than accelerating the
 * next cycle, but a large enough tranche has persistent route value: it avoids
 * forcing every remaining slot through one exponential transaction. Below the
 * consolidation policy's bar, count contributes nothing. */
export function routeCountVerdict(input: {
  required: number;
  installed: number;
  /** Distinct unowned augmentations the queue plus this bankroll would add. */
  affordableDistinct: number;
  /** The route's own optional-install policy, consulted once consolidation
   * has begun; before that the target-relative tranche rule applies. */
  consolidationAllowed: boolean;
  /** What the route measured an acquisition-rate increase to save. */
  worth?: ChannelWorth;
}): { ready: boolean; value: number } {
  const beforeConsolidation =
    input.installed < Math.ceil(input.required * DAEDALUS_FINAL_BATCH_FRACTION);
  const batchAllowed = beforeConsolidation
    ? earlyCountBatchAllowed(input.required, input.installed, input.affordableDistinct)
    : input.consolidationAllowed;
  return {
    ready: input.installed >= input.required || batchAllowed,
    value: routeCountInstallValue({
      required: input.required,
      installed: input.installed,
      affordableDistinct: input.affordableDistinct,
      batchAllowed,
      ...(input.worth ? { worth: input.worth } : {}),
    }),
  };
}

/** BN-seconds one distinct count slot is worth, for {@link fundedActivationBatch}. */
export function countSlotValueFor(worth: ChannelWorth, target: number, installed: number): number {
  if (!Number.isFinite(target)) return 0;
  return countSlotWeight(worth, Math.max(0, target - installed));
}
