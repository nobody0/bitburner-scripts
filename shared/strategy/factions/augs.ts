import type { ChannelWorth } from "../income.ts";
import { BASE_FOCUS_BONUS } from "./rep.ts";
import { fieldChannelResponse, VALUED_FIELDS } from "../multipliers.ts";

/** Augmentation valuation, prerequisite closure and purchase ordering.
 *
 * Three facts from v3.0.1 shape everything here, and all three are easy to get
 * backwards:
 *
 *  1. **Reputation requirements do NOT scale with the purchase queue.** Only
 *     money does (`1.9^queuedNonSoA`). So a faction's rep target is fixed
 *     regardless of buying order, and the order matters ONLY for price.
 *  2. **Therefore buy most-expensive-first.** The escalation multiplies the
 *     price of each SUBSEQUENT purchase, so the cheapest augmentation should
 *     absorb the largest multiplier. This is provable, not a heuristic, and
 *     `tests/factions.test.ts` checks it against brute force over all
 *     permutations.
 *  3. **Two augmentation families price differently.** NeuroFlux Governor
 *     scales `1.14^level` on BOTH rep and money (and then also takes the queue
 *     multiplier), while the Shadows-of-Anarchy set uses `7^ownedSoA` /
 *     `1.3^ownedSoA` and is EXCLUDED from the queue count entirely — so buying
 *     SoA augmentations does not inflate anything else.
 *
 * Pinned upstream pricing and purchase rules:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Constants.ts#L25-L43
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Constants.ts#L94-L105
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/AugmentationHelpers.ts#L24-L161
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L55-L141 */

/** CONSTANTS @ v3.0.1. */
export const MULTIPLE_AUG_MULTIPLIER = 1.9;
export const NEUROFLUX_LEVEL_MULT = 1.14;
export const SOA_COST_MULT = 7;
export const SOA_REP_MULT = 1.3;
export const NEUROFLUX = "NeuroFlux Governor";

/** SF11 discounts the queue escalation. Index by SF11 level, capped at 3. */
const SF11_DISCOUNT = [1, 0.96, 0.94, 0.93];

/** One probed offer, as `factions.offers` carries it. */
export interface PurchasableOffer {
  name: string;
  faction: string;
  /** Price at the CURRENT queue depth. */
  price: number;
  affordableRep: boolean;
  owned: boolean;
}

/** The cheapest augmentation that could ACTUALLY be bought right now.
 *
 * This is `progression`'s install barrier — "do not reset while a dollar could
 * still become a permanent multiplier".
 *
 * IT IS NOT WHAT FACTIONS BUYS, and the difference is the interesting part. The
 * drain decides through `nextPurchase` over the augmentation catalogue and the
 * GRANTED budget; this reads the probed offers and cash on hand. Two predicates
 * that must not disagree permanently, because a barrier blocking on something
 * factions declines to buy is a deadlock. They converge rather than match
 * exactly: the drain freezes a funded order, then removes each completed
 * purchase from that order. Any change here has to preserve that convergence,
 * not just the field list.
 *
 * `offers` spans every faction the NODE defines, joined or not. Owned
 * non-repeatables are filtered while repeatable NeuroFlux remains, so
 * "affordable by price" is nowhere near "can be bought". Four
 * conditions:
 *  - the offering faction is joined;
 *  - reputation is met there;
 *  - every prerequisite is owned;
 *  - the price is within `money`.
 *
 * **NeuroFlux Governor is exempt from the OWNED test and nothing else**, because
 * it is bought again at the next level where everything else is bought once. It
 * still terminates: `getAugCost` scales its price AND its reputation requirement
 * by {@link NEUROFLUX_LEVEL_MULT} per level on top of the queue escalation, so
 * every level makes the next strictly dearer in both currencies and the affordable
 * set runs out. Draining cash into NFG levels before a reset is the single most
 * valuable thing to do with money that is about to be deleted.
 *
 * Cheapest first, so a drain buys the most levels the cash allows rather than one
 * expensive item and then nothing. */
export function nextPurchasableAugmentation(input: {
  offers: readonly PurchasableOffer[];
  joined: ReadonlySet<string>;
  owned: ReadonlySet<string>;
  /** Augmentation -> prerequisites, when known. */
  prereqs?: (name: string) => readonly string[];
  /** Cash to test against. `Infinity` asks "what WOULD we buy", which is what a
   *  claim needs — the arbiter decides what it can actually fund. */
  money: number;
}): PurchasableOffer | undefined {
  let best: PurchasableOffer | undefined;
  for (const offer of input.offers) {
    if (offer.name !== NEUROFLUX && (offer.owned || input.owned.has(offer.name))) continue;
    if (!input.joined.has(offer.faction)) continue;
    if (!offer.affordableRep) continue;
    if (offer.price > input.money) continue;
    if ((input.prereqs?.(offer.name) ?? []).some((prereq) => !input.owned.has(prereq))) continue;
    if (!best || offer.price < best.price) best = offer;
  }
  return best;
}

/** The nine Shadows of Anarchy augmentations, which price on their own curve. */
export const SOA_AUGMENTATIONS: readonly string[] = [
  "Beauty of Aphrodite",
  "Chaos of Dionysus",
  "Flood of Poseidon",
  "Hunt of Artemis",
  "Knowledge of Apollo",
  "Might of Ares",
  "Trickery of Hermes",
  "WKS Harmonizer",
  "Wisdom of Athena",
];

const SOA_SET = new Set(SOA_AUGMENTATIONS);

export function isSoA(name: string): boolean {
  return SOA_SET.has(name);
}

export interface AugInfo {
  name: string;
  baseCost: number;
  baseRepRequirement: number;
  factions: string[];
  prereqs: string[];
  mults: Record<string, number>;
  /** Upstream randomises these at load time; they must not be scored.
   * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/CircadianModulator.ts#L9-L117 */
  multsUnknown?: boolean;
}

export interface PriceContext {
  /** Non-SoA augmentation purchases already queued this run. Every NeuroFlux
   * purchase is a separate queue entry and contributes to the exponent.
   * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObjectGeneralMethods.ts#L473-L496 */
  queuedNonSoA: number;
  /** SoA augmentations already OWNED. */
  ownedSoA: number;
  /** Current NeuroFlux level. */
  neurofluxLevel: number;
  sf11Level: number;
  /** currentNodeMults.AugmentationMoneyCost / AugmentationRepCost. */
  augMoneyCost: number;
  augRepCost: number;
}

export function basePriceMultiplier(sf11Level: number): number {
  return MULTIPLE_AUG_MULTIPLIER * (SF11_DISCOUNT[Math.min(3, Math.max(0, sf11Level))] ?? 1);
}

/** `getAugCost` @ v3.0.1, transcribed. `queuedOffset` lets a planner ask "what
 * would this cost as the Nth purchase" without mutating the context.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/AugmentationHelpers.ts#L120-L161 */
export function augCost(
  aug: AugInfo,
  ctx: PriceContext,
  queuedOffset = 0,
): { moneyCost: number; repCost: number } {
  const moneyCost = augMoneyCost(aug, ctx, queuedOffset, ctx.neurofluxLevel);
  if (aug.name === NEUROFLUX) {
    return {
      repCost: aug.baseRepRequirement * Math.pow(NEUROFLUX_LEVEL_MULT, ctx.neurofluxLevel) * ctx.augRepCost,
      moneyCost,
    };
  }
  if (isSoA(aug.name)) {
    return { moneyCost, repCost: aug.baseRepRequirement * Math.pow(SOA_REP_MULT, ctx.ownedSoA) };
  }
  return { moneyCost, repCost: aug.baseRepRequirement * ctx.augRepCost };
}

/** The money half of {@link augCost} as a bare number, with the NeuroFlux
 * level as a parameter instead of a context field. The batch-cost walks below
 * advance the level per item, and building a `{...ctx}` (or an `augCost`
 * result object) per item made those walks — 300k+ estimate calls per virtual
 * hour, each over a dozen items — a top allocation site of a BN1 run. Shared
 * by `augCost` so the two formulas cannot drift. */
export function augMoneyCost(
  aug: AugInfo,
  ctx: PriceContext,
  queuedOffset = 0,
  neurofluxLevel = ctx.neurofluxLevel,
): number {
  const queued = ctx.queuedNonSoA + queuedOffset;
  const generic = Math.pow(basePriceMultiplier(ctx.sf11Level), queued);
  if (aug.name === NEUROFLUX) {
    return aug.baseCost * Math.pow(NEUROFLUX_LEVEL_MULT, neurofluxLevel) * ctx.augMoneyCost * generic;
  }
  if (isSoA(aug.name)) return aug.baseCost * Math.pow(SOA_COST_MULT, ctx.ownedSoA);
  return aug.baseCost * generic * ctx.augMoneyCost;
}

// --- valuation -------------------------------------------------------------

/** What one unit of `ln(mult)` on each multiplier field is worth, in BN-seconds
 * off the route. `scoreAug` sums `weight · ln(mult)`, so an augmentation's score
 * comes out in the same seconds the work slot, the needs board and the install
 * cadence are all denominated in.
 * Values are derived from route marginals rather than unitless tuning weights;
 * see `weightsFromMarginals`. */
export type ObjectiveWeights = Record<string, number>;

export interface RouteWeightContext {
  /** Route skill levels that installed augmentations must make reachable. */
  hackingTarget?: number;
  combatTarget?: number;
  /** The labyrinth's highest remaining charisma gate, where that route is
   * live — charisma shares the exact skill curve, so a direct charisma
   * multiplier near a gate earns the same nonlinear response hacking does. */
  charismaTarget?: number;
  /** Already-active stat multipliers. The marginal value of another direct
   * multiplier falls as this base grows (notably across SF12 stress levels). */
  multipliers?: Readonly<Record<string, number>>;
  /** Each income source's measured share of total money production, so a
   * multiplier on one source is valued at what that source actually earns. */
  incomeShares?: Readonly<Record<string, number>>;
}

/** Effects the multiplier table does not express at all, in BN-seconds.
 *
 * Only effects expressible as a rate on a priced channel belong here. One-off
 * opener and cash effects are priced where they land, while Neurolink's hacking
 * effects arrive through its multiplier table.
 *
 * THE RED PILL is not here either, and deliberately: it is a route GATE, not a
 * rate. Its worth is "the run cannot end without it", which belongs to the
 * route that requires it — see `packages.ts#routeAwareScore`, where it is
 * valued at the horizon it unblocks. Keeping it here would also leak it into
 * `scoreAugMults`, which the install cadence compares against a rate. */
export function augBonusSec(name: string, worth: ChannelWorth): number {
  if (name !== "Neuroreceptor Management Implant") return 0;
  // Removes the unfocused work penalty, so every second the work slot spends
  // unfocused earns full rate instead of 80% of it. That is a multiplier on
  // whatever the slot is earning, which is reputation.
  return Math.log(1 / BASE_FOCUS_BONUS) * (worth.get("reputation") ?? 0);
}

/** A multiplier on experience is worth less than the same stat multiplier
 * because skill grows as a fractional power of experience. The square-root
 * response is a factor of 0.5 in log space.
 * Reference: `bitburner-2023/src/_lib/augmentations.ts` at commit 43e8585. */
const EXP_DISCOUNT = 0.5;

/** BN-seconds one distinct slot in a finite installed-augmentation gate is
 * worth.
 *
 * DERIVED, not shaped. The count leg finishes in `remaining / augsPerSec`
 * seconds, so acquiring one slot now removes `1 / augsPerSec` of them —
 * `worth / remaining`, where `worth` is what progression measured a relative
 * increase in the acquisition rate to save. Slots therefore get MORE valuable
 * as the gate closes, because the last one really does unblock the whole gate.
 *
 * Filler and multipliers are quoted in the same seconds and compete directly;
 * infinite or unpriced count routes get nothing. */
export function countSlotWeight(worth: ChannelWorth, remaining: number): number {
  const total = worth.get("augmentations") ?? 0;
  if (!(total > 0) || !Number.isFinite(remaining) || remaining <= 0) return 0;
  return total / remaining;
}

/** Fields multiplied by CONSTANTS.EntropyEffect for each completed graft in
 * v3.0.1's `calculateEntropy`.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Grafting/EntropyAccumulation.ts#L6-L47 */
const ENTROPY_FIELDS = new Set([
  "hacking_chance", "hacking_speed", "hacking_money", "hacking_grow",
  "hacking", "strength", "defense", "dexterity", "agility", "charisma",
  "hacking_exp", "strength_exp", "defense_exp", "dexterity_exp", "agility_exp", "charisma_exp",
  "company_rep", "faction_rep", "crime_money", "crime_success", "dnet_money",
  "hacknet_node_money", "work_money", "bladeburner_max_stamina", "bladeburner_stamina_gain",
  "bladeburner_analysis", "bladeburner_success_chance",
]);

/** Marginal objective loss from one entropy stack. Existing stack count does
 * not change this in log space; the violet Congruity Implant removes it. */
export function entropyCost(weights: ObjectiveWeights, effect = 0.98): number {
  let weighted = 0;
  for (const [field, weight] of Object.entries(weights)) {
    if (!ENTROPY_FIELDS.has(field) || weight <= 0) continue;
    weighted += weight * (field.endsWith("_exp") ? EXP_DISCOUNT : 1);
  }
  return weighted * -Math.log(effect);
}

function contributionOf(field: string, multiplier: number, weights: ObjectiveWeights): number {
  const weight = weights[field] ?? 0;
  if (weight === 0) return 0;
  const discount = field.endsWith("_exp") ? EXP_DISCOUNT : 1;
  return weight * discount * Math.log(multiplier);
}

/** Score one augmentation, in BN-seconds off the route.
 *
 * `Σ w_k · ln(mult_k)`, because the multipliers COMPOSE MULTIPLICATIVELY: in
 * log space "which set of augmentations is best" becomes an additive set
 * problem, which is what makes the purchase planning tractable at all. With
 * `w` measured (`weightsFromMarginals`) the sum comes out in the same seconds
 * the work slot, the needs board and the install cadence all use.
 *
 * `worth` is only needed for the named effects the multiplier table cannot
 * express — see `augBonusSec`. Omitting it scores the multipliers alone, which
 * is what a caller comparing pure rates wants.
 *
 * An augmentation whose multipliers upstream randomises scores 0 rather than
 * being guessed at — see AUGMENTATION_TABLE.multsUnknown.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/CircadianModulator.ts#L9-L117 */
export function scoreAug(aug: AugInfo, weights: ObjectiveWeights, worth?: ChannelWorth): number {
  return augBonusSec(aug.name, worth ?? new Map()) + scoreAugMults(aug, weights);
}

/** Multiplier-only score: the log-mult contributions WITHOUT the flat bonuses.
 * The install-vs-push rule compares value STREAMS, and a gate is not a rate —
 * leaking route necessity into a rate comparison makes any package containing
 * The Red Pill look infinitely worth pushing for. */
export function scoreAugMults(aug: AugInfo, weights: ObjectiveWeights): number {
  if (aug.multsUnknown) return 0;
  let score = 0;
  for (const [field, value] of Object.entries(aug.mults)) {
    if (value <= 0) continue;
    score += contributionOf(field, value, weights);
  }
  return score;
}

/** What each multiplier field is worth, derived from the measured route.
 *
 * `worth(channel)` is BN-seconds saved by a 100% relative increase in that
 * channel's rate — progression's own measurement, the same table the work-slot
 * auction prices claims with. A field's weight is that worth times how much of
 * a relative rate increase the multiplier actually buys, with a single-source
 * income multiplier's MONEY channel scaled by that source's share of what we
 * earn — see `fieldChannelResponse`.
 *
 * THE HAND-TUNED TABLE THIS REPLACES said `faction_rep: 2` and
 * `crime_money: 0.2` in every node, forever. Both are wrong in the same run:
 * mid-BN12 with the farm earning four orders of magnitude more than crime, a
 * crime-money multiplier is worth nothing at all, while reputation is the only
 * binding part of the route. Neither fact is expressible as a constant, and
 * both fall out of the measurement. */
export function weightsFromMarginals(worth: ChannelWorth, context?: RouteWeightContext): ObjectiveWeights {
  const weights: ObjectiveWeights = {};
  for (const field of VALUED_FIELDS) {
    let value = 0;
    for (const [channel, response] of Object.entries(fieldChannelResponse(field, context?.incomeShares))) {
      value += (worth.get(channel) ?? 0) * response;
    }
    if (value > 0) weights[field] = value;
  }

  // These nonlinear sensitivities are formula-derived, not policy weights.
  //
  // skill = m · (32·ln(exp + 534.6) − 200), so around a high target
  // −d ln(requiredExp) / d ln(m) = target / (32m): a direct skill multiplier
  // buys exponentially more than an ordinary output multiplier near the gate,
  // and the effect declines by itself as m grows.
  if (context?.hackingTarget !== undefined && (worth.get("hacking") ?? 0) > 0) {
    const active = Math.max(1e-9, context.multipliers?.["hacking"] ?? 1);
    const response = context.hackingTarget / (32 * active);
    weights["hacking"] = Math.max(weights["hacking"] ?? 0, (worth.get("hacking") ?? 0) * response);
  }
  if (context?.charismaTarget !== undefined && (worth.get("charisma") ?? 0) > 0) {
    const active = Math.max(1e-9, context.multipliers?.["charisma"] ?? 1);
    const response = context.charismaTarget / (32 * active);
    weights["charisma"] = Math.max(weights["charisma"] ?? 0, (worth.get("charisma") ?? 0) * response);
  }
  if (context?.combatTarget !== undefined && (worth.get("combat") ?? 0) > 0) {
    // The four stats are trained sequentially to one gate, so each carries a
    // quarter of the same sensitivity: an augmentation covering several stats
    // earns the combined value, and a one-stat augmentation cannot masquerade
    // as clearing the gate.
    for (const skill of ["strength", "defense", "dexterity", "agility"] as const) {
      const active = Math.max(1e-9, context.multipliers?.[skill] ?? 1);
      const response = context.combatTarget / (128 * active);
      weights[skill] = Math.max(weights[skill] ?? 0, (worth.get("combat") ?? 0) * response);
    }
  }
  // Do not renormalise: these values are seconds, so a larger total represents
  // a genuinely more valuable package and must affect install cadence.
  return weights;
}

// --- prerequisite closure ---------------------------------------------------

/** Expand a wanted set to include every prerequisite, transitively.
 *
 * Order matters in the RESULT: a prerequisite must be buyable before its
 * dependant, so the closure is returned in dependency order. A cycle is
 * impossible in the real data (the vendor step verifies prereqs resolve) but
 * is guarded anyway — an infinite loop inside the game's 200 ms tick would
 * hang the controller, not just this feature. */
/** Prerequisite closure for a set that is about to be BOUGHT.
 *
 * `closePrereqs` treats an owned augmentation as satisfied, and NeuroFlux is
 * the exception that rule cannot see: the next level stays purchasable after
 * the name is owned, and its `1.14^level` price is the whole cost of that
 * breakpoint. Counting it as satisfied made every later NeuroFlux package cost
 * $0 with a 1-second ETA — an infinite-looking marginal frontier that could
 * veto installs forever. Both cost paths need this exception, so it lives once
 * rather than being restated wherever a set is priced. */
export function closePurchaseSet(
  wanted: readonly string[],
  catalog: ReadonlyMap<string, AugInfo>,
  owned: ReadonlySet<string>,
): string[] {
  // The copy exists only to hide an owned NeuroFlux from the closure; without
  // NeuroFlux in the set, copying `owned` per call (this sits under every
  // portfolio evaluation) buys nothing.
  if (!wanted.includes(NEUROFLUX)) return closePrereqs(wanted, catalog, owned);
  const closureOwned = new Set(owned);
  closureOwned.delete(NEUROFLUX);
  return closePrereqs(wanted, catalog, closureOwned);
}

export function closePrereqs(
  wanted: readonly string[],
  catalog: ReadonlyMap<string, AugInfo>,
  owned: ReadonlySet<string>,
): string[] {
  // Fast path: while no wanted name has prerequisites, the closure is a plain
  // dedupe-and-drop-owned pass — which is what almost every set the portfolio
  // search closes (300k+ a virtual hour) looks like. The first name that does
  // carry prerequisites falls through to the recursive closure ON THE WHOLE
  // INPUT, which re-derives the same prefix this pass produced.
  const out: string[] = [];
  const seen = new Set<string>();
  let flat = true;
  for (const name of wanted) {
    if (seen.has(name) || owned.has(name)) continue;
    const aug = catalog.get(name);
    if (aug !== undefined && aug.prereqs.length > 0) {
      flat = false;
      break;
    }
    seen.add(name);
    out.push(name);
  }
  if (flat) return out;

  out.length = 0;
  seen.clear();
  const visiting = new Set<string>();

  const visit = (name: string): void => {
    if (seen.has(name) || owned.has(name)) return;
    if (visiting.has(name)) return; // cycle guard
    visiting.add(name);
    const aug = catalog.get(name);
    for (const prereq of aug?.prereqs ?? []) visit(prereq);
    visiting.delete(name);
    seen.add(name);
    out.push(name);
  };

  for (const name of wanted) visit(name);
  return out;
}

// --- purchase ordering ------------------------------------------------------

export interface PurchaseCandidate {
  name: string;
  aug: AugInfo;
  /** Faction offering it at the lowest reputation requirement we can meet. */
  faction: string;
}

export interface PurchasePlan {
  /** The order to buy in. Prerequisites always precede their dependants. */
  order: PurchaseCandidate[];
  /** Total money at the escalated prices. */
  totalCost: number;
  /** Candidates dropped because the money ran out. */
  dropped: PurchaseCandidate[];
}

/** Cost of buying `order` back to back under the queue escalation. */
export function totalCost(order: readonly PurchaseCandidate[], ctx: PriceContext): number {
  let total = 0;
  let nonSoA = 0;
  let neuroflux = ctx.neurofluxLevel;
  for (const candidate of order) {
    total += augMoneyCost(candidate.aug, ctx, nonSoA, neuroflux);
    if (candidate.name === NEUROFLUX) neuroflux++;
    if (!isSoA(candidate.name)) nonSoA++;
  }
  return total;
}

/** Above this many candidates, fall back from the exact DP to a heuristic.
 *
 * 2^16 x 16 is about a million transitions — a few milliseconds, against a
 * 30 s driver cadence. Real prerequisite-constrained sets are far smaller than
 * this; the limit exists so a late-game objective cannot stall the loop. */
export const EXACT_ORDER_LIMIT = 16;

/** Joint (subset x NeuroFlux level) state budget for the exact solve.
 *
 * The one-shot limit alone bounds only ONE dimension: 16 candidates against
 * the 64-level drain cap is 2^16 x 65 = 4.3M states and ~42 MB of typed
 * arrays, seconds per controller pass at the moment the run is most
 * time-critical. 2^20 keeps the joint sweep inside the millisecond budget the
 * limit above was chosen for; past it the greedy NeuroFlux order takes over. */
export const EXACT_JOINT_STATE_LIMIT = 1 << 20;

/** Whether the joint one-shot/NeuroFlux DP fits both budgets. */
function exactJointFits(size: number, levels: number): boolean {
  return size <= EXACT_ORDER_LIMIT && (1 << size) * (levels + 1) <= EXACT_JOINT_STATE_LIMIT;
}

/** Order a purchase set for minimum total cost, respecting prerequisites.
 *
 * WITHOUT prerequisites the answer is just most-expensive-first: the
 * escalation multiplies every SUBSEQUENT purchase, so the cheapest
 * augmentation should absorb the largest multiplier (a standard exchange
 * argument, and `tests/factions.test.ts` checks it against brute force).
 *
 * WITH prerequisites that is no longer optimal, and the failure is not subtle.
 * Given A ($1m, prerequisite of B), B ($500m) and C ($200m), taking the most
 * expensive READY item first picks C, then A, then B — and pays 20% more than
 * A, B, C, because buying cheap A early unlocks expensive B into a cheaper
 * slot. Bitburner's prerequisite graph BRANCHES (up to four prerequisites,
 * depth five), so no chain rule is exact either.
 *
 * So: exact subset DP up to EXACT_ORDER_LIMIT, heuristic above it. The DP is
 * cheap because the price of an item depends only on WHICH items precede it,
 * never on their order — non-SoA count drives the escalation and NeuroFlux
 * level drives its own — so the placed set is a sufficient state.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/Augmentations.ts#L425-L500
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L52-L108
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/AugmentationHelpers.ts#L120-L161 */
export function orderPurchases(
  candidates: readonly PurchaseCandidate[],
  ctx: PriceContext,
): PurchaseCandidate[] {
  if (candidates.length === 0) return [];
  return candidates.length <= EXACT_ORDER_LIMIT
    ? exactOrder(candidates, ctx)
    : improveOrder(greedyOrder(candidates), candidates, ctx);
}

/** Minimum-cost order for a fixed one-shot set plus a fixed number of
 * NeuroFlux levels. NeuroFlux is a chain (level n must precede n+1), while
 * ordinary prerequisites form a DAG. Keeping the NFG counter beside the
 * one-shot subset is enough to solve both exactly: price depends only on the
 * number of non-SoA purchases already placed and the current NFG level.
 *
 * This exists separately from {@link orderPurchases} because duplicate NFG
 * names are real purchases, whereas ordinary candidate identity is its name.
 * Above the exact one-shot limit a deterministic ready-most-expensive
 * heuristic preserves the same semantics without threatening the planner's
 * tick budget. */
export function orderPurchasesWithNeuroflux(
  candidates: readonly PurchaseCandidate[],
  neuroflux: PurchaseCandidate,
  neurofluxCount: number,
  ctx: PriceContext,
): PurchaseCandidate[] {
  const levels = Math.max(0, Math.floor(neurofluxCount));
  if (levels === 0) return orderPurchases(candidates, ctx);
  if (exactJointFits(candidates.length, levels)) return neurofluxOrdersByLevel(candidates, neuroflux, levels, ctx)[levels]!;
  return greedyNeurofluxOrder(candidates, neuroflux, levels, ctx);
}

/** Optimal orders for EVERY NeuroFlux level count from 0 to `maxLevels`.
 *
 * One solve answers them all: the DP state already carries the level counter,
 * so the terminal state at each `nfg` IS the optimum for exactly that many
 * levels. The drain's affordability search wants the largest fundable count,
 * and calling the exponential solver once per candidate level re-derived every
 * cheaper answer from scratch — tens of 2^n * levels sweeps per controller
 * pass, at the one moment the run is most time-critical. */
export function orderPurchasesWithNeurofluxByLevel(
  candidates: readonly PurchaseCandidate[],
  neuroflux: PurchaseCandidate,
  maxLevels: number,
  ctx: PriceContext,
): PurchaseCandidate[][] {
  const levels = Math.max(0, Math.floor(maxLevels));
  if (levels > 0 && exactJointFits(candidates.length, levels)) {
    return neurofluxOrdersByLevel(candidates, neuroflux, levels, ctx);
  }
  return Array.from({ length: levels + 1 }, (_unused, count) =>
    orderPurchasesWithNeuroflux(candidates, neuroflux, count, ctx));
}

/** Ready-most-expensive heuristic used above the exact one-shot limit. */
function greedyNeurofluxOrder(
  candidates: readonly PurchaseCandidate[],
  neuroflux: PurchaseCandidate,
  levels: number,
  ctx: PriceContext,
): PurchaseCandidate[] {
  const remaining = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  const inSet = new Set(remaining.keys());
  const placed = new Set<string>();
  const order: PurchaseCandidate[] = [];
  let nfgPlaced = 0;
  while (remaining.size > 0 || nfgPlaced < levels) {
    const ready = [...remaining.values()].filter((candidate) =>
      candidate.aug.prereqs.every((prereq) => !inSet.has(prereq) || placed.has(prereq)),
    );
    let best = nfgPlaced < levels ? neuroflux : undefined;
    let bestCost = best
      ? augCost(best.aug, { ...ctx, neurofluxLevel: ctx.neurofluxLevel + nfgPlaced }, order.filter((item) => !isSoA(item.name)).length).moneyCost
      : -Infinity;
    for (const candidate of ready) {
      const cost = augCost(candidate.aug, ctx, order.filter((item) => !isSoA(item.name)).length).moneyCost;
      if (cost > bestCost || (cost === bestCost && best && candidate.name < best.name)) {
        best = candidate;
        bestCost = cost;
      }
    }
    if (!best) break;
    order.push(best);
    if (best.name === NEUROFLUX) nfgPlaced++;
    else {
      placed.add(best.name);
      remaining.delete(best.name);
    }
  }
  return order;
}

/** The exact solve, shared by both entry points. Returns one order per level
 * count in `0..levels`. */
function neurofluxOrdersByLevel(
  candidates: readonly PurchaseCandidate[],
  neuroflux: PurchaseCandidate,
  levels: number,
  ctx: PriceContext,
): PurchaseCandidate[][] {
  const size = candidates.length;
  const masks = 1 << size;
  const stride = levels + 1;
  const states = masks * stride;
  const index = new Map(candidates.map((candidate, i) => [candidate.name, i]));
  const needs = candidates.map((candidate) => {
    let mask = 0;
    for (const prereq of candidate.aug.prereqs) {
      const at = index.get(prereq);
      if (at !== undefined) mask |= 1 << at;
    }
    return mask;
  });
  const nonSoAMask = candidates.reduce(
    (mask, candidate, i) => isSoA(candidate.name) ? mask : mask | (1 << i),
    0,
  );
  const popcount = new Uint8Array(masks);
  for (let mask = 1; mask < masks; mask++) popcount[mask] = popcount[mask >> 1]! + (mask & 1);

  const best = new Float64Array(states).fill(Infinity);
  const from = new Int16Array(states).fill(-2);
  best[0] = 0;
  for (let mask = 0; mask < masks; mask++) {
    for (let nfg = 0; nfg <= levels; nfg++) {
      const at = mask * stride + nfg;
      const sofar = best[at]!;
      if (!Number.isFinite(sofar)) continue;
      const queuedOffset = popcount[mask & nonSoAMask]! + nfg;
      if (nfg < levels) {
        const next = at + 1;
        const cost = augCost(
          neuroflux.aug,
          { ...ctx, neurofluxLevel: ctx.neurofluxLevel + nfg },
          queuedOffset,
        ).moneyCost;
        if (sofar + cost < best[next]!) {
          best[next] = sofar + cost;
          from[next] = -1;
        }
      }
      for (let i = 0; i < size; i++) {
        if ((mask & (1 << i)) !== 0 || (needs[i]! & mask) !== needs[i]!) continue;
        const next = (mask | (1 << i)) * stride + nfg;
        const cost = augCost(candidates[i]!.aug, ctx, queuedOffset).moneyCost;
        if (sofar + cost < best[next]!) {
          best[next] = sofar + cost;
          from[next] = i;
        }
      }
    }
  }

  // Each terminal state (every one-shot bought, `count` levels placed) is the
  // optimum for exactly that count, so one solve reconstructs them all.
  return Array.from({ length: levels + 1 }, (_unused, count) => {
    const order: PurchaseCandidate[] = [];
    let mask = masks - 1;
    let nfg = count;
    while (mask !== 0 || nfg !== 0) {
      const action = from[mask * stride + nfg]!;
      if (action === -1) {
        order.push(neuroflux);
        nfg--;
      } else if (action >= 0) {
        order.push(candidates[action]!);
        mask &= ~(1 << action);
      } else {
        return [...orderPurchases(candidates, ctx), ...Array.from({ length: count }, () => neuroflux)];
      }
    }
    return order.reverse();
  });
}

/** Cost of placing `index` when exactly the items in `mask` are already
 * bought. Depends only on the SET, which is what makes the DP valid. */
function costAt(
  index: number,
  mask: number,
  candidates: readonly PurchaseCandidate[],
  ctx: PriceContext,
): number {
  let nonSoA = 0;
  let neuroflux = ctx.neurofluxLevel;
  for (let i = 0; i < candidates.length; i++) {
    if ((mask & (1 << i)) === 0) continue;
    const name = candidates[i]!.name;
    if (name === NEUROFLUX) neuroflux++;
    if (!isSoA(name)) nonSoA++;
  }
  return augCost(candidates[index]!.aug, { ...ctx, neurofluxLevel: neuroflux }, nonSoA).moneyCost;
}

function exactOrder(candidates: readonly PurchaseCandidate[], ctx: PriceContext): PurchaseCandidate[] {
  const size = candidates.length;
  const index = new Map(candidates.map((candidate, i) => [candidate.name, i]));
  // Prerequisite mask per item, restricted to members of this set.
  const needs = candidates.map((candidate) => {
    let mask = 0;
    for (const prereq of candidate.aug.prereqs) {
      const at = index.get(prereq);
      if (at !== undefined) mask |= 1 << at;
    }
    return mask;
  });

  const total = 1 << size;
  const best = new Float64Array(total).fill(Infinity);
  const from = new Int32Array(total).fill(-1);
  best[0] = 0;

  for (let mask = 0; mask < total; mask++) {
    const sofar = best[mask]!;
    if (!Number.isFinite(sofar)) continue;
    for (let i = 0; i < size; i++) {
      if ((mask & (1 << i)) !== 0) continue;
      if ((needs[i]! & mask) !== needs[i]!) continue; // prerequisites unmet
      const next = mask | (1 << i);
      const cost = sofar + costAt(i, mask, candidates, ctx);
      if (cost < best[next]!) {
        best[next] = cost;
        from[next] = i;
      }
    }
  }

  const full = total - 1;
  if (!Number.isFinite(best[full]!)) {
    // Unsatisfiable precedence (impossible in real data); emit stably rather
    // than returning nothing.
    return greedyOrder(candidates);
  }
  const order: PurchaseCandidate[] = [];
  let mask = full;
  while (mask !== 0) {
    const i = from[mask]!;
    order.push(candidates[i]!);
    mask &= ~(1 << i);
  }
  return order.reverse();
}

/** Pick the set to buy by VALUE, then order it for minimum COST.
 *
 * The two orders are different and both matter, which is the whole reason this
 * function exists. Every queued non-SoA augmentation multiplies the price of the
 * next by {@link MULTIPLE_AUG_MULTIPLIER}, so a batch's total depends on the order
 * it is bought in — and an augmentation does nothing until it is installed, so
 * within one reset the order has no benefit to trade against. We therefore
 * *choose* greedily by value, best first, and *pay* in the order
 * {@link orderPurchases} finds. Pricing a candidate at today's queue depth instead
 * of at its position in the plan understates the batch and makes the last
 * purchases unaffordable.
 *
 * `candidates` must arrive in value order, best first, with prerequisites already
 * closed in (see {@link closePrereqs}).
 *
 * An unaffordable candidate is SKIPPED, not a stopping point: one $1.4b item
 * should not veto every cheaper augmentation behind it. Its dependants go with it,
 * since an augmentation whose prerequisite was dropped cannot be bought at all.
 *
 * NeuroFlux is deliberately not a candidate here because its repeatable levels
 * need an additional state dimension. The final sweep chooses a funded level
 * count separately, then {@link orderPurchasesWithNeuroflux} jointly orders
 * those levels with the accepted one-shot set. */
export function selectAffordableBatch(input: {
  candidates: readonly PurchaseCandidate[];
  owned: ReadonlySet<string>;
  ctx: PriceContext;
  money: number;
}): PurchasePlan {
  const accepted: PurchaseCandidate[] = [];
  const acceptedNames = new Set<string>();
  const dropped: PurchaseCandidate[] = [];

  for (const candidate of input.candidates) {
    const reachable = candidate.aug.prereqs.every(
      (prereq) => input.owned.has(prereq) || acceptedNames.has(prereq),
    );
    if (!reachable) {
      dropped.push(candidate);
      continue;
    }
    // Screen with the estimate, not the solver. Adding an item shifts every other
    // item's slot, so each trial is a fresh ordering problem — solving all n of them
    // exactly costs more than solving the one that survives, and the screen only
    // has to decide "does this still fit".
    if (estimatedCost([...accepted, candidate], input.ctx) > input.money) {
      dropped.push(candidate);
      continue;
    }
    accepted.push(candidate);
    acceptedNames.add(candidate.name);
  }

  // Solved once, on the set we are actually going to buy.
  const order = orderPurchases(accepted, input.ctx);
  return { order, totalCost: totalCost(order, input.ctx), dropped };
}

/** What a set will cost, without solving the ordering exactly.
 *
 * For ESTIMATES — comparing packages, screening affordability — where the answer
 * feeds a comparison rather than a purchase. {@link orderPurchases} is exponential
 * by design and belongs only where we actually buy: at 14 items it is 7.6 ms a call,
 * and the package frontier evaluates hundreds of candidates per tick, so using it
 * here costs seconds per decision to refine a number that is about to be compared
 * against another estimate.
 *
 * {@link greedyOrder} is exact without prerequisites — most-expensive-first is the
 * optimum there — and close with them, which is well inside the error of the rest of
 * a package estimate. */
export function estimatedCost(candidates: readonly PurchaseCandidate[], ctx: PriceContext): number {
  // Fast path for the shape the portfolio search actually sends 300k+ times a
  // virtual hour: unique names, no prerequisite sold inside the same set. The
  // greedy order is then exactly the static (baseCost descending, name
  // ascending) sort — every item is ready from the start, so the Kahn walk
  // pops in rank order — and the whole dedupe/indegree/heap apparatus can be
  // skipped. Same elements, same order, same accumulation sequence: the
  // returned float is bit-identical to the slow path's.
  const names = new Set<string>();
  let plain = true;
  for (const candidate of candidates) names.add(candidate.name);
  if (names.size === candidates.length) {
    for (const candidate of candidates) {
      const prereqs = candidate.aug.prereqs;
      for (let i = 0; i < prereqs.length; i++) {
        if (names.has(prereqs[i]!)) {
          plain = false;
          break;
        }
      }
      if (!plain) break;
    }
  } else {
    plain = false;
  }
  if (names.size !== candidates.length) return totalCost(greedyOrder(candidates), ctx);
  const order = [...candidates].sort((a, b) => {
    const costDiff = b.aug.baseCost - a.aug.baseCost;
    return costDiff !== 0 ? costDiff : a.name < b.name ? -1 : 1;
  });
  // Unique names but an in-set prerequisite: reuse the sorted copy and the
  // name set — the readiness scan needs nothing greedyOrder's dedupe adds.
  return totalCost(plain ? order : placeByPriority(order, names), ctx);
}

/** {@link estimatedCost} over bare {@link AugInfo}s — same order, same
 * arithmetic, same float. The portfolio's union pricing calls this 300k+
 * times a virtual hour with names it just resolved from the catalog (where
 * key === aug.name), and wrapping each in a `PurchaseCandidate` only to read
 * `.name` and `.aug` back out was a measurable allocation cost. */
export function estimatedAugSetCost(augs: readonly AugInfo[], ctx: PriceContext): number {
  const names = new Set<string>();
  for (const aug of augs) names.add(aug.name);
  if (names.size !== augs.length) {
    // Duplicate names (repeated NeuroFlux): the candidate pipeline owns that
    // dedupe rule. Rare — a union list is closure output, already unique.
    return estimatedCost(augs.map((aug) => ({ name: aug.name, aug, faction: "" })), ctx);
  }
  let plain = true;
  for (const aug of augs) {
    const prereqs = aug.prereqs;
    for (let i = 0; i < prereqs.length; i++) {
      if (names.has(prereqs[i]!)) {
        plain = false;
        break;
      }
    }
    if (!plain) break;
  }
  const sorted = [...augs].sort((a, b) => {
    const costDiff = b.baseCost - a.baseCost;
    return costDiff !== 0 ? costDiff : a.name < b.name ? -1 : 1;
  });
  const order = plain ? sorted : placeAugsByPriority(sorted, names);
  let total = 0;
  let nonSoA = 0;
  let neuroflux = ctx.neurofluxLevel;
  for (const aug of order) {
    total += augMoneyCost(aug, ctx, nonSoA, neuroflux);
    if (aug.name === NEUROFLUX) neuroflux++;
    if (!isSoA(aug.name)) nonSoA++;
  }
  return total;
}

/** {@link placeByPriority} over bare AugInfos; kept in step with it. */
function placeAugsByPriority(entries: readonly AugInfo[], inSet: { has(name: string): boolean }): AugInfo[] {
  const size = entries.length;
  const placed = new Set<string>();
  const order: AugInfo[] = [];
  let scanFrom = 0;
  while (order.length < size) {
    let advanced = false;
    for (let i = scanFrom; i < size; i++) {
      const candidate = entries[i]!;
      if (placed.has(candidate.name)) {
        if (i === scanFrom) scanFrom++;
        continue;
      }
      const prereqs = candidate.prereqs;
      let ready = true;
      for (let p = 0; p < prereqs.length; p++) {
        const prereq = prereqs[p]!;
        if (inSet.has(prereq) && !placed.has(prereq)) {
          ready = false;
          break;
        }
      }
      if (!ready) continue;
      order.push(candidate);
      placed.add(candidate.name);
      advanced = true;
      if (i === scanFrom) {
        scanFrom = i + 1;
        continue;
      }
      break;
    }
    if (!advanced) {
      order.push(...entries
        .filter((candidate) => !placed.has(candidate.name))
        .sort((a, b) => (a.name < b.name ? -1 : 1)));
      break;
    }
  }
  return order;
}

/** Most-expensive-ready-first. Optimal without prerequisites, and the starting
 * point for the local search above the exact limit.
 *
 * "Take the highest-priority READY item, repeatedly" under a FIXED priority —
 * (baseCost descending, name ascending), which never changes as items are
 * placed — is a single scan of the priority-sorted set that REWINDS when a
 * placement unblocks an item it already passed: the first unplaced ready item
 * from the scan position on is the global maximum, because everything before
 * it is placed or still blocked. Real sets carry a handful of short chains
 * (the Cranial Signal Processor generations, the Netburner Module line), so
 * the rewind bookkeeping is a few integers, not a heap — this sits under
 * `estimatedCost`, 300k+ calls per virtual hour of a BN1 run, where both a
 * rescan-per-placement and a build-the-whole-Kahn-apparatus-per-call version
 * measurably drowned in their own per-call overhead. */
function greedyOrder(candidates: readonly PurchaseCandidate[]): PurchaseCandidate[] {
  // Dedupe by name with last-value wins; priority determines final order.
  const byName = new Map<string, PurchaseCandidate>();
  for (const candidate of candidates) byName.set(candidate.name, candidate);
  const entries = [...byName.values()];
  const size = entries.length;
  if (size <= 1) return entries;

  entries.sort((a, b) => {
    const costDiff = b.aug.baseCost - a.aug.baseCost;
    return costDiff !== 0 ? costDiff : a.name < b.name ? -1 : 1;
  });
  return placeByPriority(entries, byName);
}

/** The readiness scan behind {@link greedyOrder}: place a PRIORITY-SORTED,
 * name-unique set most-expensive-ready-first. `inSet` answers "is this name
 * sold inside the set" — a Map or Set of exactly the entries' names. */
function placeByPriority(
  entries: readonly PurchaseCandidate[],
  inSet: { has(name: string): boolean },
): PurchaseCandidate[] {
  const size = entries.length;
  // `scanFrom` is the floor: every position below it is placed, so any
  // unplaced (in particular, still-blocked) item sits at or above it, and the
  // first ready item a scan meets from the floor up is the global maximum.
  const placed = new Set<string>();
  const order: PurchaseCandidate[] = [];
  let scanFrom = 0;
  while (order.length < size) {
    let advanced = false;
    for (let i = scanFrom; i < size; i++) {
      const candidate = entries[i]!;
      if (placed.has(candidate.name)) {
        if (i === scanFrom) scanFrom++;
        continue;
      }
      const prereqs = candidate.aug.prereqs;
      let ready = true;
      for (let p = 0; p < prereqs.length; p++) {
        const prereq = prereqs[p]!;
        if (inSet.has(prereq) && !placed.has(prereq)) {
          ready = false;
          break;
        }
      }
      if (!ready) continue;
      order.push(candidate);
      placed.add(candidate.name);
      advanced = true;
      if (i === scanFrom) {
        // Placed at the floor: nothing below it was blocked, so nothing this
        // placement unblocks can outrank the scan ahead. Keep going.
        scanFrom = i + 1;
        continue;
      }
      // Placed past a blocked item: the placement may have unblocked it, and
      // it outranks everything ahead — restart from the floor.
      break;
    }
    if (!advanced) {
      // A prerequisite cycle or self-prerequisite cannot advance; emit the
      // remainder in stable order rather than looping forever.
      order.push(...entries
        .filter((candidate) => !placed.has(candidate.name))
        .sort((a, b) => (a.name < b.name ? -1 : 1)));
      break;
    }
  }
  return order;
}

/** Adjacent-swap local search, for sets above the exact limit. Only swaps that
 * keep precedence valid, and only when they reduce the total. */
function improveOrder(
  start: PurchaseCandidate[],
  candidates: readonly PurchaseCandidate[],
  ctx: PriceContext,
): PurchaseCandidate[] {
  const inSet = new Set(candidates.map((candidate) => candidate.name));
  const order = [...start];
  let improved = true;
  let guard = order.length * order.length;
  while (improved && guard-- > 0) {
    improved = false;
    for (let i = 0; i + 1 < order.length; i++) {
      const left = order[i]!;
      const right = order[i + 1]!;
      // Illegal if the right one depends on the left one.
      if (right.aug.prereqs.some((prereq) => prereq === left.name && inSet.has(prereq))) continue;
      const before = totalCost(order, ctx);
      order[i] = right;
      order[i + 1] = left;
      if (totalCost(order, ctx) < before) improved = true;
      else {
        order[i] = left;
        order[i + 1] = right;
      }
    }
  }
  return order;
}

/** Can this augmentation be bought right now?
 *
 * Reputation suffices, OR donation can close the gap with the money left AFTER
 * paying for the augmentation itself. This distinguishes "wait for reputation"
 * from "pay for it".
 * Reference: `bitburner-2023/src/_lib/augmentations.ts:148-167` at commit 43e8585. */
export function canAfford(input: {
  moneyCost: number;
  repCost: number;
  factionRep: number;
  money: number;
  /** Undefined when donations are locked (favor below the threshold). */
  donationRate?: { factionRepMult: number; factionWorkRepGain: number };
}): { ok: boolean; needDonation: number; reason: string } {
  if (input.money < input.moneyCost) {
    return { ok: false, needDonation: 0, reason: "not enough money" };
  }
  if (input.factionRep >= input.repCost) {
    return { ok: true, needDonation: 0, reason: "reputation met" };
  }
  if (!input.donationRate) {
    return { ok: false, needDonation: 0, reason: "reputation short and donations locked" };
  }
  const gap = input.repCost - input.factionRep;
  const needed =
    (gap * 1e6) / input.donationRate.factionRepMult / input.donationRate.factionWorkRepGain;
  const spare = input.money - input.moneyCost;
  return needed <= spare
    ? { ok: true, needDonation: needed, reason: "reputation bought by donation" }
    : { ok: false, needDonation: needed, reason: "reputation short, donation unaffordable" };
}
