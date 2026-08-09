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
 *     `tests/factions-augs.test.ts` checks it against brute force over all
 *     permutations.
 *  3. **Two augmentation families price differently.** NeuroFlux Governor
 *     scales `1.14^level` on BOTH rep and money (and then also takes the queue
 *     multiplier), while the Shadows-of-Anarchy set uses `7^ownedSoA` /
 *     `1.3^ownedSoA` and is EXCLUDED from the queue count entirely — so buying
 *     SoA augmentations does not inflate anything else. */

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
 * factions declines to buy is a deadlock. They converge rather than match exactly:
 * the drain re-plans every tick against the cash that is actually left, so an
 * augmentation the batch passed over this pass is reconsidered as soon as the items
 * ahead of it have been bought and the budget has shrunk to fit it. Any change here
 * has to preserve that, not just the field list.
 *
 * `offers` spans every faction the NODE defines, joined or not, filtered only by
 * `owned`, so "affordable by price" is nowhere near "can be bought". Four
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
  /** Upstream randomises these at load time; they must not be scored. */
  multsUnknown?: boolean;
}

export interface PriceContext {
  /** Non-SoA augmentations already queued this run. */
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
 * would this cost as the Nth purchase" without mutating the context. */
export function augCost(
  aug: AugInfo,
  ctx: PriceContext,
  queuedOffset = 0,
): { moneyCost: number; repCost: number } {
  const queued = ctx.queuedNonSoA + queuedOffset;
  const generic = Math.pow(basePriceMultiplier(ctx.sf11Level), queued);

  if (aug.name === NEUROFLUX) {
    const multiplier = Math.pow(NEUROFLUX_LEVEL_MULT, ctx.neurofluxLevel);
    return {
      repCost: aug.baseRepRequirement * multiplier * ctx.augRepCost,
      moneyCost: aug.baseCost * multiplier * ctx.augMoneyCost * generic,
    };
  }

  if (isSoA(aug.name)) {
    return {
      moneyCost: aug.baseCost * Math.pow(SOA_COST_MULT, ctx.ownedSoA),
      repCost: aug.baseRepRequirement * Math.pow(SOA_REP_MULT, ctx.ownedSoA),
    };
  }

  return {
    moneyCost: aug.baseCost * generic * ctx.augMoneyCost,
    repCost: aug.baseRepRequirement * ctx.augRepCost,
  };
}

// --- valuation -------------------------------------------------------------

/** What the run is trying to maximise, per multiplier field. Defaults below
 * reproduce the predecessor scripts' per-domain valuation
 * (src/_lib/augmentations.ts:6-102), whose multiplicative product is the
 * unlogged form of our `Σ ln(mult)` — the same objective, reached
 * independently, which is reassuring. */
export type ObjectiveWeights = Record<string, number>;

/** Named special cases, in log space. These are effects the multiplier fields
 * do not express at all, so without them the planner cannot see why anyone
 * would buy The Red Pill. */
export const AUG_BONUS: Record<string, number> = {
  // Ends the BitNode. Nothing else in the game does that.
  "The Red Pill": 9,
  // A one-off $1m and a free port opener on a fresh run.
  "CashRoot Starter Kit": 0.05,
  // Doubles the effective work rate by removing the unfocused penalty.
  "Neuroreceptor Management Implant": Math.log(1.1),
  // BitRunners' Neurolink grants a free port opener and +hacking.
  "BitRunners Neurolink": 0.1,
};

/** A multiplier on EXPERIENCE is worth less than the same multiplier on the
 * stat, because a stat grows as a fractional power of its experience. The
 * predecessor scripts apply `sqrt` to the multiplier; in log space that is
 * exactly a factor of 0.5 on the contribution, which is how it lands here. */
const EXP_DISCOUNT = 0.5;

/** Fields multiplied by CONSTANTS.EntropyEffect for each completed graft in
 * v3.0.1's `calculateEntropy`. */
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

/** Score one augmentation.
 *
 * `Σ w_k · ln(mult_k)`, because the multipliers COMPOSE MULTIPLICATIVELY: in
 * log space "which set of augmentations is best" becomes an additive set
 * problem, which is what makes the purchase planning tractable at all.
 *
 * An augmentation whose multipliers upstream randomises scores 0 rather than
 * being guessed at — see AUGMENTATION_TABLE.multsUnknown. */
export function scoreAug(aug: AugInfo, weights: ObjectiveWeights): number {
  let score = AUG_BONUS[aug.name] ?? 0;
  if (aug.multsUnknown) return score;
  for (const [field, value] of Object.entries(aug.mults)) {
    if (value <= 0) continue;
    score += contributionOf(field, value, weights);
  }
  return score;
}

/** Default weights: a balanced hacking-first run. */
export function defaultWeights(): ObjectiveWeights {
  return {
    hacking: 1,
    hacking_exp: 1,
    hacking_chance: 0.6,
    hacking_speed: 1,
    hacking_money: 1,
    hacking_grow: 0.4,
    faction_rep: 0.8,
    company_rep: 0.3,
    crime_money: 0.2,
    crime_success: 0.2,
    charisma: 0.1,
    charisma_exp: 0.1,
    strength: 0.1,
    defense: 0.1,
    dexterity: 0.1,
    agility: 0.1,
    strength_exp: 0.1,
    defense_exp: 0.1,
    dexterity_exp: 0.1,
    agility_exp: 0.1,
    hacknet_node_money: 0.2,
    work_money: 0.2,
  };
}

/** Bias multiplier utility toward the route that will actually end this node.
 * The count objective remains route-independent; this only breaks ties toward
 * augmentations that accelerate the chosen finish. */
export function weightsForRoute(
  route: "daedalus" | "labyrinth" | "bladeburner" | undefined,
): ObjectiveWeights {
  const weights = defaultWeights();
  if (route === "bladeburner") {
    weights.bladeburner_success_chance = 2;
    weights.bladeburner_stamina_gain = 1;
    weights.bladeburner_max_stamina = 1;
    weights.bladeburner_analysis = 0.8;
    weights.strength = 0.5;
    weights.defense = 0.5;
    weights.dexterity = 0.5;
    weights.agility = 0.5;
  } else if (route === "daedalus") {
    weights.hacking = 1.2;
    weights.hacking_exp = 1.2;
    weights.faction_rep = 1.2;
  } else if (route === "labyrinth") {
    weights.hacking = 1.1;
    weights.hacking_speed = 1.1;
    weights.dnet_money = 0.8;
  }
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
export function closePrereqs(
  wanted: readonly string[],
  catalog: ReadonlyMap<string, AugInfo>,
  owned: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
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
    const local: PriceContext = { ...ctx, neurofluxLevel: neuroflux };
    total += augCost(candidate.aug, local, nonSoA).moneyCost;
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
 * level drives its own — so the placed set is a sufficient state. */
export function orderPurchases(
  candidates: readonly PurchaseCandidate[],
  ctx: PriceContext,
): PurchaseCandidate[] {
  if (candidates.length === 0) return [];
  return candidates.length <= EXACT_ORDER_LIMIT
    ? exactOrder(candidates, ctx)
    : improveOrder(greedyOrder(candidates), candidates, ctx);
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
    if (!isSoA(name)) nonSoA++;
    if (name === NEUROFLUX) neuroflux++;
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
 * NeuroFlux is deliberately not a candidate here. It is the residual sink — bought
 * repeatedly with whatever survives the batch, so its count is not known until the
 * money runs out, and its levels form a forced ascending-price chain that cannot
 * be reordered. The drain re-plans each tick and buys NeuroFlux once the one-offs
 * are done. That is a simplification: at high levels NeuroFlux is dear enough that
 * it would ideally interleave into the batch rather than follow it, which costs at
 * most part of one level's escalation. */
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
  return totalCost(greedyOrder(candidates), ctx);
}

/** Most-expensive-ready-first. Optimal without prerequisites, and the starting
 * point for the local search above the exact limit. */
function greedyOrder(candidates: readonly PurchaseCandidate[]): PurchaseCandidate[] {
  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  const remaining = new Map(byName);
  const placed = new Set<string>();
  const order: PurchaseCandidate[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((candidate) =>
      candidate.aug.prereqs.every((prereq) => !byName.has(prereq) || placed.has(prereq)),
    );
    if (ready.length === 0) {
      order.push(...[...remaining.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
      break;
    }
    ready.sort((a, b) => {
      const costDiff = b.aug.baseCost - a.aug.baseCost;
      return costDiff !== 0 ? costDiff : a.name < b.name ? -1 : 1;
    });
    const next = ready[0]!;
    order.push(next);
    placed.add(next.name);
    remaining.delete(next.name);
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

/** Greedy-by-value with a price-descending affordability recheck.
 *
 * The shape is taken from the predecessor scripts
 * (src/_lib/augmentations.ts:170-199): add the next-best augmentation, re-sort
 * the whole set most-expensive-first, recompute the total under the escalation,
 * and stop when it stops being affordable. Recomputing the TOTAL each time is
 * the part that matters — the escalation means adding one augmentation raises
 * the price of everything after it, so an incremental sum is simply wrong. */
export function planPurchases(
  ranked: readonly PurchaseCandidate[],
  budget: number,
  ctx: PriceContext,
): PurchasePlan {
  const chosen: PurchaseCandidate[] = [];
  const dropped: PurchaseCandidate[] = [];
  let best: { order: PurchaseCandidate[]; cost: number } = { order: [], cost: 0 };

  for (const candidate of ranked) {
    const attempt = [...chosen, candidate];
    const order = orderPurchases(attempt, ctx);
    const cost = totalCost(order, ctx);
    if (cost > budget) {
      dropped.push(candidate);
      continue;
    }
    chosen.push(candidate);
    best = { order, cost };
  }

  return { order: best.order, totalCost: best.cost, dropped };
}

/** Can this augmentation be bought right now?
 *
 * Reputation suffices, OR donation can close the gap with the money left AFTER
 * paying for the augmentation itself. That second clause is materially better
 * than a plain `rep >= repReq` test — it is the difference between "wait for
 * reputation" and "pay for it", and the predecessor scripts get it right
 * (src/_lib/augmentations.ts:148-167) where most scripts do not. */
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
