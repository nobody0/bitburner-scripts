import {
  NEUROFLUX,
  closePurchaseSet,
  estimatedAugSetCost,
  type AugInfo,
} from "./augs.ts";
import type { FactionIntent, FactionPortfolio, HorizonSample } from "./plan.ts";
import {
  buildFrontiers,
  countValue,
  cycleCompatible,
  favorValueFromFuture,
  qualityValue,
  routeAwareScore,
  type FactionPackage,
} from "./packages.ts";
import { curveExponent, repCurveResource, pacedSec, spotSecFromPaced } from "./pace.ts";
import { settlingMoney, type FactionStanding, type FactionsView } from "./state.ts";
import { bestWorkType } from "./rep.ts";
import type { Blocker } from "./requirements.ts";
import { INSTALL_FINAL_SWEEP_SEC } from "../progression/forecast.ts";
import { INSTALL_OVERHEAD_SEC } from "../progression/eta.ts";

/** Choosing a SET of faction pushes, rather than one faction and how far.
 *
 * The predecessor of this module picked the single best `value/etaSec` package,
 * walked that one faction's concave envelope, and consulted the best runner-up
 * only as a stopping threshold. Three things are not expressible that way, and
 * all three change the answer:
 *
 *  - **Overlap.** Most augmentations are sold by several factions. Their value
 *    is realised once, not once per seller, so the value of a set is the value
 *    of its UNION. Pairwise residual scoring against a single runner-up prices
 *    a two-faction cycle and nothing beyond it.
 *  - **One price ladder.** Money cost escalates as `1.9^queued` across the
 *    whole install cycle, so two factions' purchases are cheaper priced
 *    together than summed apart — and the sum is what a per-faction ETA does.
 *  - **One work slot.** Reputation work is sequential across the set. A
 *    per-package `etaSec` is a critical path for that package alone and cannot
 *    be added up, which is why nothing previously tried to.
 *
 * So the decision unit here is the whole install cycle: a budget of seconds,
 * and the best set of `(faction, reputation target)` pairs that fits in it.
 *
 * The budget is not assumed either. `V*(T)` — the best value reachable in `T`
 * — is swept, and the cycle length is chosen to maximise `V*(T) / (T + O)`.
 * Because value is `sum of w*ln(mult)` (`augs.ts`), that ratio is a log-growth
 * rate per second, which is exactly what a repeated prestige maximises. It
 * reduces to `progression`'s existing `T* = sqrt(2O/p)` whenever `V*` is linear
 * in `T`, so this generalises that rule rather than competing with it. */

/** Grid resolution of the budget sweep. Geometric, so short cycles (where the
 * decision is delicate) are sampled as finely as long ones.
 *
 * The whole grid is evaluated. It is tempting to walk outward and stop when the
 * rate falls, and that is wrong here for a named reason: rates ACCELERATE
 * within a cycle (`pace.ts`), so `V*(T)` is not concave — a faction that is
 * unreachable at twenty minutes can be cheap at two hours, and a stopping walk
 * never sees it. Stopping early at the wrong level of the problem is the exact
 * mistake this module exists to fix. */
export const HORIZON_SAMPLES = 24;

/** COST. On a full board — every faction joined, the whole catalogue, 458
 * breakpoints — an ordinary pass re-prices the committed set in ~0.2 ms, and
 * the sweep that re-chooses it costs ~430 ms. The sweep runs on the forecast's
 * recalibration cadence (60 s), never per pass, which is what makes that
 * affordable; the split is pinned by `tests/factions-portfolio-cost.test.ts`.
 * A few hundred milliseconds is still a synchronous stall, and this repository's
 * established answer for an expensive search is the resumable
 * `budget`/`first`/`next` state machine the darknet solvers use
 * (`spec/dnet-solvers.md`). That is worth doing if the stall ever shows up in
 * batch timing; it is not free, so it is not done pre-emptively. */
/** Shortest cycle worth solving for. Below this the final sweep dominates. */
export const MIN_BUDGET_SEC = 60;

/** Local search passes over the greedy seed. Each pass is O(selected x
 * breakpoints) and the seed is already a `(1 - 1/e)` approximation; this
 * converges in two or three in practice, and the cap keeps one pathological
 * frontier from spending a controller tick. */
const MAX_LOCAL_SEARCH_PASSES = 6;

/** Unowned augmentations each faction sells, cached per view.
 *
 * One `FactionsView` is immutable for one strategy pass, and the search
 * re-derives this list inside its innermost loop: every candidate evaluation,
 * for every chosen faction, over a 137-entry catalogue, across a 24-budget
 * sweep. Recomputing it there is how a faction decision becomes seconds instead
 * of milliseconds — the same trap `packages.ts` documents for its route score. */
const OFFERED_CACHE = new WeakMap<FactionsView, Map<string, AugInfo[]>>();

function unownedFrom(faction: string, view: FactionsView): AugInfo[] {
  let cache = OFFERED_CACHE.get(view);
  if (!cache) {
    cache = new Map();
    OFFERED_CACHE.set(view, cache);
  }
  const cached = cache.get(faction);
  if (cached) return cached;
  const offered = [...view.catalog.values()].filter(
    (aug) => aug.name !== NEUROFLUX && !view.owned.has(aug.name) && aug.factions.includes(faction),
  );
  cache.set(faction, offered);
  return offered;
}

/** Name set of {@link unownedFrom}, for overlap counting from the acquired
 * side: the union a portfolio evaluation holds is usually far smaller than a
 * big faction's catalogue, so `favorValue`'s future-work count is cheaper as
 * `|offered| - |acquired ∩ offered|` iterating the union. Same per-view
 * lifetime as the list it mirrors. */
const OFFERED_SET_CACHE = new WeakMap<FactionsView, Map<string, ReadonlySet<string>>>();

function unownedSetFrom(faction: string, view: FactionsView): ReadonlySet<string> {
  let cache = OFFERED_SET_CACHE.get(view);
  if (!cache) {
    cache = new Map();
    OFFERED_SET_CACHE.set(view, cache);
  }
  const cached = cache.get(faction);
  if (cached) return cached;
  const names = new Set(unownedFrom(faction, view).map((aug) => aug.name));
  cache.set(faction, names);
  return names;
}

/** What a selection pass returns. `intent` and `runnerUp` are the head and the
 * next member of the portfolio, kept under their old names because every
 * existing consumer — the arbiter's claims, the `until` readout, progression's
 * install forecast — reads them and does not need to know the plan grew. */
export interface PackageSelection {
  intent?: FactionPackage;
  runnerUp?: FactionPackage;
  /** Complete, non-dominated frontiers for review, tests and the UI. */
  frontiers: Map<string, FactionPackage[]>;
  foreclosed: { name: string; bannedBy: string }[];
  /** No intent, but only because the planning horizon filtered every raw
   * candidate out — a TRANSIENT state (the node forecast recalibrates), not
   * "nothing left worth pushing for". The install verdict must not read a
   * horizon-starved frontier as concluded: doing so armed premature installs
   * at cycle start whenever the forecast dipped for one 90s dwell. */
  horizonStarved?: boolean;
}

/** One chosen push, kept with its frontier identity so local search can move
 * it along its own faction's ladder. */
interface Choice {
  faction: string;
  index: number;
  pkg: FactionPackage;
}

export interface PortfolioSolution {
  choices: Choice[];
  /** Everything the set is worth, including route count progress. */
  value: number;
  /** The part that an install ACTIVATES — multipliers and favor. The budget is
   * chosen on this, never on `value`. */
  activation: number;
  workSec: number;
  moneySec: number;
  etaSec: number;
  augmentations: string[];
}

// --- evaluation ------------------------------------------------------------

/** Every augmentation an ordered set of pushes would acquire, deduplicated and
 * prerequisite-closed. This union IS the fix: an augmentation named by three
 * factions appears once. */
function unionAugs(choices: readonly Choice[], view: FactionsView): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  // `plain` tracks, in the same walk that builds the list, whether the closure
  // could change it at all: it deduplicates (repeated NeuroFlux), drops owned
  // names, and inserts prerequisites — so a unique, unowned, prerequisite-free
  // list IS its own closure and skips the whole `closePurchaseSet` apparatus.
  // This is the portfolio search's inner loop; see the COST note above.
  let plain = true;
  let nfgSeen = false;
  for (const choice of choices) {
    for (const name of choice.pkg.augmentations) {
      // NeuroFlux is the one repeatable name: two factions each offering the
      // next level is two levels, not one shared purchase.
      if (name === NEUROFLUX) {
        if (nfgSeen || view.owned.has(name)) plain = false;
        nfgSeen = true;
      } else if (seen.has(name)) {
        continue;
      } else {
        seen.add(name);
        if (view.owned.has(name)) plain = false;
      }
      if (plain) {
        const aug = view.catalog.get(name);
        if (aug !== undefined && aug.prereqs.length > 0) plain = false;
      }
      names.push(name);
    }
  }
  if (plain) return names;
  return closePurchaseSet(names, view.catalog, view.owned);
}

const STANDING_CACHE = new WeakMap<FactionsView, Map<string, FactionStanding>>();

/** `bestWorkType(standing.offers, view.person, standing.favor, ...)` reads
 * only per-view-stable inputs, and both the critical-path pricing and the
 * forfeit term ask it per chosen faction per evaluation — thousands of times
 * per budget sweep for a handful of distinct answers. */
const WORK_CACHE = new WeakMap<FactionsView, Map<string, ReturnType<typeof bestWorkType>>>();

function bestWorkFor(standing: FactionStanding, view: FactionsView): ReturnType<typeof bestWorkType> {
  let cache = WORK_CACHE.get(view);
  if (!cache) {
    cache = new Map();
    WORK_CACHE.set(view, cache);
  }
  if (cache.has(standing.name)) return cache.get(standing.name)!;
  const work = bestWorkType(standing.offers, view.person, standing.favor, view.repContext, true);
  cache.set(standing.name, work);
  return work;
}

function standingOf(faction: string, view: FactionsView): FactionStanding | undefined {
  let cache = STANDING_CACHE.get(view);
  if (!cache) {
    cache = new Map(view.factions.map((entry) => [entry.name, entry]));
    STANDING_CACHE.set(view, cache);
  }
  return cache.get(faction);
}

/** Money the whole set needs, priced through ONE escalating ladder.
 *
 * Summing per-faction `purchaseCost` charges `1.9^queued` from zero for each
 * faction independently, which understates a joint set badly enough to hide it
 * from selection entirely. Estimated rather than solved: this runs inside the
 * local search, and the exact ordering DP is exponential — `orderPurchases` is
 * for the transaction boundary, where money actually changes hands. */
function unionCost(augNames: readonly string[], view: FactionsView): number {
  // No seller attribution and no PurchaseCandidate wrappers: an augmentation
  // costs the same wherever it is bought, the estimate reads only the name,
  // the prerequisites and the queue depth, and nothing built here leaves this
  // function — both the per-augmentation `choices.find` and the wrapper
  // objects sat measurably inside the search's innermost loop. The
  // transaction boundary (`orderPurchases`) still names real sellers.
  const augs: AugInfo[] = [];
  for (const name of augNames) {
    const aug = view.catalog.get(name);
    if (aug) augs.push(aug);
  }
  return estimatedAugSetCost(augs, view.priceContext);
}

/** Value of the union, recomposed from the same terms `packageValues` uses.
 *
 * Count and quality are properties of the SET; favor is per faction, and is
 * scored against the union so a faction earns no favor credit for future work
 * another member of the set has already made unnecessary. */
function portfolioValue(
  choices: readonly Choice[],
  augNames: readonly string[],
  view: FactionsView,
): { total: number; activation: number } {
  const augs: AugInfo[] = [];
  for (const name of augNames) {
    const aug = view.catalog.get(name);
    if (aug) augs.push(aug);
  }

  // Same terms `packageValues` uses, over the UNION rather than one package.
  const count = countValue(augs, view);
  const quality = qualityValue(augs, view);

  let favor = 0;
  for (const choice of choices) {
    const standing = standingOf(choice.faction, view);
    if (!standing) continue;
    // future = offered minus what this set acquires, counted from the
    // acquired side — see unownedSetFrom. Identical to handing favorValue the
    // offered list; the acquired union is just the smaller thing to iterate.
    const offered = unownedSetFrom(choice.faction, view);
    let overlap = 0;
    for (let i = 0; i < augNames.length; i++) if (offered.has(augNames[i]!)) overlap++;
    const servesTerminal = (view.route === "daedalus" || view.route === "gang")
      && !view.owned.has("The Red Pill")
      && (standing.joined || standing.invited)
      && offered.has("The Red Pill");
    favor += favorValueFromFuture(standing, choice.pkg.favorAfterInstall, offered.size - overlap, view, servesTerminal);
  }
  // Same split `packageValues` makes, and for the same reason: count is ROUTE
  // progress toward a gate, not a rate. It is kept once acquired and an install
  // does not switch it on, so it must not enter a rate comparison — that is the
  // documented contract the install cadence relies on.
  return { total: count + quality + favor, activation: quality + favor };
}

/** Critical path of an ORDERED set.
 *
 * Work is sequential — there is one player work slot, and `workForFaction`
 * cancels rather than queues — so each push starts where the previous one
 * finished, and is re-paced at that position: by then the rate has moved. That
 * order dependence is real, and is why local search is allowed to reorder. */
function portfolioTime(
  choices: readonly Choice[],
  augNames: readonly string[],
  view: FactionsView,
): { workSec: number; moneySec: number; etaSec: number } {
  const pace = view.cyclePace;
  const moneyExponent = curveExponent(pace, "money");
  let cursor = pace?.elapsedSec ?? 0;
  let workSec = 0;
  let donationCost = 0;

  for (const choice of choices) {
    const pkg = choice.pkg;
    donationCost += Math.max(0, pkg.donationCost);
    // A donation-funded push buys its reputation with money, so it costs the
    // work slot nothing; only its unlock does.
    let sec = pkg.unlockSec;
    if (pkg.donationCost <= 0 && pkg.repSec > 0) {
      const standing = standingOf(choice.faction, view);
      const work = standing
        ? bestWorkFor(standing, view)
        : undefined;
      if (!pace || !work) {
        sec += pkg.repSec;
      } else {
        const resource = repCurveResource(work.type);
        const exponent = curveExponent(pace, resource);
        const spot = spotSecFromPaced(pkg.repSec, pace.elapsedSec, exponent);
        sec += pacedSec(spot, cursor, exponent);
      }
    }
    workSec += sec;
    cursor += sec;
  }

  const totalCost = unionCost(augNames, view) + donationCost;
  const moneySpotSec = Math.max(0, totalCost - settlingMoney(view)) / Math.max(1, view.incomePerSec);
  const moneySec = pacedSec(moneySpotSec, pace?.elapsedSec ?? 0, moneyExponent);
  // Money production runs underneath the work rather than after it.
  return { workSec, moneySec, etaSec: Math.max(workSec, moneySec) + INSTALL_FINAL_SWEEP_SEC };
}

/** Evaluations are the search's inner loop and the search revisits the same
 * sets constantly — local search proposes a move, rejects it, and the next
 * budget proposes it again. Keyed on the ORDERED selection, because the work
 * term is order-dependent. Per view, so it dies with the strategy pass.
 *
 * The key is a trie over the packages' object identities rather than a
 * `faction:index` string: each frontier entry is a fresh literal identifying
 * exactly one (faction, index) pair, and building + hashing the string key
 * cost more than many of the cache hits it served. A frontier REBUILT for the
 * same view starts cold here where the string key would have carried entries
 * over — which only re-runs a pure function on equal inputs. */
interface EvalNode {
  solution?: PortfolioSolution;
  next?: Map<FactionPackage, EvalNode>;
}
const EVAL_CACHE = new WeakMap<FactionsView, EvalNode>();

function evaluate(choices: readonly Choice[], view: FactionsView): PortfolioSolution {
  let node = EVAL_CACHE.get(view);
  if (!node) {
    node = {};
    EVAL_CACHE.set(view, node);
  }
  for (const choice of choices) {
    if (!node.next) node.next = new Map();
    let child = node.next.get(choice.pkg);
    if (!child) {
      child = {};
      node.next.set(choice.pkg, child);
    }
    node = child;
  }
  if (node.solution) return node.solution;
  const solution = evaluateUncached(choices, view);
  node.solution = solution;
  return solution;
}

function evaluateUncached(choices: readonly Choice[], view: FactionsView): PortfolioSolution {
  const augmentations = unionAugs(choices, view);
  const { workSec, moneySec, etaSec } = portfolioTime(choices, augmentations, view);
  const value = portfolioValue(choices, augmentations, view);
  return {
    choices: [...choices],
    value: value.total,
    activation: value.activation,
    workSec,
    moneySec,
    etaSec,
    augmentations,
  };
}

/** Enemy bans are mutual and last the whole install cycle, so a set may not
 * contain two factions that forbid each other — joining one forecloses the
 * other until the next reset. */
function compatible(faction: string, chosen: readonly Choice[], view: FactionsView): boolean {
  const standing = standingOf(faction, view);
  if (!standing) return false;
  if (!cycleCompatible(standing, view.factions)) return false;
  for (const choice of chosen) {
    if (choice.faction === faction) continue;
    const other = standingOf(choice.faction, view);
    if (!other) continue;
    if (standing.enemies.includes(other.name) || other.enemies.includes(standing.name)) return false;
  }
  return true;
}

// --- search ----------------------------------------------------------------

/** Greedy on marginal value per marginal second.
 *
 * This is the arithmetic the predecessor already had — revalue a faction after
 * the chosen set has supplied its shared augmentations — applied to the whole
 * set instead of once to a runner-up. Value over a union is monotone and
 * submodular and the work term is additive, so this carries the standard
 * `(1 - 1/e)` guarantee. */
function greedy(
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
  budgetSec: number,
  seed?: PortfolioSolution,
): PortfolioSolution {
  // A set that fits a smaller budget fits every larger one, so the sweep hands
  // each solve the previous budget's answer to extend rather than rediscover.
  let current = seed && seed.etaSec <= budgetSec ? seed : evaluate([], view);
  const used = new Set<string>(current.choices.map((choice) => choice.faction));

  for (;;) {
    let best: { solution: PortfolioSolution; faction: string } | undefined;
    let bestRate = 0;
    for (const [faction, frontier] of frontiers) {
      if (used.has(faction)) continue;
      if (!compatible(faction, current.choices, view)) continue;
      for (let index = 0; index < frontier.length; index++) {
        const candidate = evaluate([...current.choices, { faction, index, pkg: frontier[index]! }], view);
        if (candidate.etaSec > budgetSec) continue;
        const gainedSec = Math.max(1, candidate.etaSec - current.etaSec);
        const rate = (candidate.value - current.value) / gainedSec;
        if (rate > bestRate + 1e-12) {
          bestRate = rate;
          best = { solution: candidate, faction };
        }
      }
    }
    if (!best) return current;
    current = best.solution;
    used.add(best.faction);
  }
}

/** Polish the greedy seed: move each chosen push along its own faction's
 * ladder, drop it, swap in a faction that was passed over, and REORDER.
 *
 * Reordering is not cosmetic. With accelerating rates a cheap unlock done first
 * raises the rate at which everything behind it is earned, so "best value/sec
 * first" — the order the greedy seed produces — is only a starting guess. */
function localSearch(
  seed: PortfolioSolution,
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
  budgetSec: number,
): PortfolioSolution {
  let best = seed;
  const fits = (candidate: PortfolioSolution): boolean => candidate.etaSec <= budgetSec;
  const better = (candidate: PortfolioSolution): boolean =>
    fits(candidate)
    && (candidate.value > best.value + 1e-12
      || (candidate.value > best.value - 1e-12 && candidate.etaSec < best.etaSec - 1e-9));

  for (let pass = 0; pass < MAX_LOCAL_SEARCH_PASSES; pass++) {
    const start = best;

    // Move or drop each chosen push.
    //
    // Iterated over a SNAPSHOT of the pass's membership, and each member is
    // located by faction rather than by position. `best` is reassigned inside
    // this loop — a drop makes the list shorter — so a positional index would
    // address a different push after the first accepted move, silently skipping
    // members and reading a stale `chosen`.
    for (const member of [...best.choices]) {
      const slot = best.choices.findIndex((choice) => choice.faction === member.faction);
      if (slot < 0) continue; // already dropped by an earlier move this pass
      const current = best.choices[slot]!;
      const frontier = frontiers.get(current.faction) ?? [];
      for (let index = 0; index < frontier.length; index++) {
        if (index === current.index) continue;
        const next = [...best.choices];
        next[slot] = { faction: current.faction, index, pkg: frontier[index]! };
        const candidate = evaluate(next, view);
        if (better(candidate)) best = candidate;
      }
      const at = best.choices.findIndex((choice) => choice.faction === member.faction);
      if (at < 0) continue;
      const dropped = evaluate(best.choices.filter((_, i) => i !== at), view);
      if (better(dropped)) best = dropped;
    }

    // Add a faction that was passed over.
    for (const [faction, frontier] of frontiers) {
      if (best.choices.some((choice) => choice.faction === faction)) continue;
      if (!compatible(faction, best.choices, view)) continue;
      for (let index = 0; index < frontier.length; index++) {
        const candidate = evaluate([...best.choices, { faction, index, pkg: frontier[index]! }], view);
        if (better(candidate)) best = candidate;
      }
    }

    // Reorder by adjacent transposition. Only the work term is order
    // sensitive, so a single sweep of swaps is enough to find the improving
    // moves a pass can see.
    for (let slot = 0; slot + 1 < best.choices.length; slot++) {
      const next = [...best.choices];
      const a = next[slot]!;
      next[slot] = next[slot + 1]!;
      next[slot + 1] = a;
      const candidate = evaluate(next, view);
      if (better(candidate)) best = candidate;
    }

    if (best === start) break;
  }
  return best;
}

/** Upper bound on the value any set could reach in the budget, from the
 * fractional relaxation: take breakpoints in descending value-per-second,
 * WITHOUT deduplicating shared augmentations and allowing the last one to be
 * taken fractionally. Both relaxations only ever help the bound, so this is
 * sound. Published as a gap so the heuristic is auditable rather than trusted. */
function upperBound(
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  budgetSec: number,
): number {
  const items: { value: number; sec: number }[] = [];
  for (const frontier of frontiers.values()) {
    for (const pkg of frontier) {
      const sec = Math.max(1, pkg.unlockSec + (pkg.donationCost > 0 ? 0 : pkg.repSec));
      if (pkg.value > 0) items.push({ value: pkg.value, sec });
    }
  }
  items.sort((a, b) => b.value / b.sec - a.value / a.sec);
  let remaining = budgetSec;
  let bound = 0;
  for (const item of items) {
    if (remaining <= 0) break;
    const take = Math.min(1, remaining / item.sec);
    bound += item.value * take;
    remaining -= item.sec * take;
  }
  return bound;
}

/** Evaluate an explicit selection, or `undefined` when it violates the
 * mutual-enemy constraint. Exported so a test can brute-force every selection
 * and compare against {@link solvePortfolio} on the same arithmetic — a search
 * checked against its own scoring function proves the search, not the score. */
export function evaluateSelection(
  selection: readonly { faction: string; index: number }[],
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
): PortfolioSolution | undefined {
  const choices: Choice[] = [];
  for (const entry of selection) {
    const pkg = frontiers.get(entry.faction)?.[entry.index];
    if (!pkg) return undefined;
    if (!compatible(entry.faction, choices, view)) return undefined;
    choices.push({ faction: entry.faction, index: entry.index, pkg });
  }
  return evaluate(choices, view);
}

/** Best set that fits a budget. */
export function solvePortfolio(
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
  budgetSec: number,
  seed?: PortfolioSolution,
): PortfolioSolution {
  return localSearch(greedy(frontiers, view, budgetSec, seed), frontiers, view, budgetSec);
}

// --- budget ----------------------------------------------------------------

/** Geometric budget grid from {@link MIN_BUDGET_SEC} upward.
 *
 * The top is the node horizon OR the longest single package, whichever is
 * larger. The horizon alone would be wrong twice over. The frontier has already
 * discounted every beyond-horizon package by its realizable fraction and
 * dropped the ones below half, so capping the budget there discounts the same
 * fact a second time. Worse, it can make the grid admit NOTHING — a route's
 * terminal package is deliberately exempt from horizon filtering, and a budget
 * that cannot hold it would silently plan around the augmentation the node
 * cannot end without. Reaching at least the longest package also guarantees the
 * property that makes replacing the old selector safe: whatever single package
 * the predecessor would have chosen is inside some budget on this grid, so the
 * set solver can never do worse than it. */
export function budgetGrid(horizonSec: number, longestPackageSec = 0, samples = HORIZON_SAMPLES): number[] {
  const reach = Math.max(
    Number.isFinite(horizonSec) ? horizonSec : 0,
    Number.isFinite(longestPackageSec) ? longestPackageSec : 0,
  );
  const top = Math.max(MIN_BUDGET_SEC * 2, reach > 0 ? reach : MIN_BUDGET_SEC * 64);
  const grid: number[] = [];
  for (let i = 0; i < samples; i++) {
    const share = samples === 1 ? 1 : i / (samples - 1);
    grid.push(MIN_BUDGET_SEC * Math.pow(top / MIN_BUDGET_SEC, share));
  }
  return grid;
}

/** What ending the cycle here THROWS AWAY, in seconds the next cycle must
 * spend re-establishing this one's position.
 *
 * An install does not merely cost its own overhead. It resets every faction's
 * reputation AND its membership, so a cycle that stops halfway up a faction's
 * ladder pays to unlock that faction again and to re-earn the reputation it
 * already banked there. Without this term the renewal rule has nothing pulling
 * against short cycles and collapses to the shortest budget on the grid — it
 * would happily abandon a faction that took an hour of backdoors and company
 * reputation to enter, for one augmentation.
 *
 * Charged only where we would actually return: a faction whose catalogue this
 * set exhausts is not re-entered, so leaving it costs nothing.
 *
 * Two things are charged, and only for factions this set does not finish:
 *
 *  - The UNLOCK. Membership is discrete and the next cycle buys it again at full
 *    price — backdoors, company reputation, combat gates.
 *  - The reputation ALREADY BANKED there. This is the term that stops the rule
 *    installing the moment a cheap augmentation becomes affordable: a faction
 *    sitting on a hundred thousand reputation, one breakpoint short of the
 *    augmentation it was earned for, loses all of it to the reset. What is
 *    charged is what we HOLD and forfeit, not what the next target costs —
 *    charging the whole target made every budget but the largest look ruinous
 *    and the planner would never conclude a cycle at all.
 *
 * Both are discounted by the favor the install itself banks, which is the one
 * part of the position that survives. */
function resetForfeitSec(solution: PortfolioSolution, view: FactionsView): number {
  let forfeit = 0;
  const acquired = new Set(solution.augmentations);
  for (const choice of solution.choices) {
    const standing = standingOf(choice.faction, view);
    if (!standing) continue;

    // How much of this faction is being left behind, by VALUE rather than by
    // count. "It still sells one thing we do not own" is true of nearly every
    // faction in a 137-entry catalogue, so a count test charges the full
    // re-establish cost almost always and pushes every cycle toward the longest
    // budget on the grid. What decides whether we come back is whether what is
    // left is worth coming back FOR.
    let taken = 0;
    let left = 0;
    for (const aug of unownedFrom(choice.faction, view)) {
      const score = routeAwareScore(aug, view);
      if (acquired.has(aug.name)) taken += score;
      else left += score;
    }
    if (left <= 0) continue;
    const leftShare = left / (left + taken);

    const favorRelief = (1 + standing.favor / 100)
      / Math.max(1e-9, 1 + choice.pkg.favorAfterInstall / 100);
    const work = bestWorkFor(standing, view);
    const bankedSec = work && work.repPerSec > 0 ? standing.rep / work.repPerSec : 0;
    forfeit += (choice.pkg.unlockSec + bankedSec)
      * leftShare
      * Math.max(0, Math.min(1, favorRelief));
  }
  return forfeit;
}

export interface BudgetChoice {
  budgetSec: number;
  solution: PortfolioSolution;
  curve: HorizonSample[];
}

/** Sweep the budget and take the cycle length that maximises long-run growth.
 *
 * `resetOverheadSec` is the measured replay cost of a prestige, not a constant:
 * a cycle that installs bigger multipliers replays faster, so the overhead this
 * rule divides by shrinks as the run improves. Passing a constant here would
 * freeze the cadence at the cost of the run's WORST cycle. */
export function chooseBudget(
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
  resetOverheadSec: number,
): BudgetChoice {
  // Floored, never zero: `progression`'s install verdict takes the same measured
  // figure with the same constant as its floor, and a zero-cost reset makes the
  // renewal optimum degenerate to "install immediately, always".
  const overhead = Math.max(INSTALL_OVERHEAD_SEC, resetOverheadSec);
  const curve: HorizonSample[] = [];
  let best: { budgetSec: number; solution: PortfolioSolution; rate: number } | undefined;

  let longestPackageSec = 0;
  for (const frontier of frontiers.values()) {
    for (const pkg of frontier) longestPackageSec = Math.max(longestPackageSec, pkg.etaSec);
  }
  // A portfolio's ETA carries the final sweep that a bare package ETA does not.
  // Without this the top of the grid sits exactly one sweep BELOW the cheapest
  // set containing the longest package, and that set is silently unreachable.
  if (longestPackageSec > 0) longestPackageSec += INSTALL_FINAL_SWEEP_SEC;
  // Ascending, so each solve starts from the last one's answer.
  let previous: PortfolioSolution | undefined;
  for (const budgetSec of budgetGrid(view.horizonSec, longestPackageSec)) {
    const solution = solvePortfolio(frontiers, view, budgetSec, previous);
    previous = solution;
    // Score the set at the time it ACTUALLY needs, not the budget it was
    // allowed. Otherwise every budget above the winning one reports a worse
    // rate for the identical set and the grid reads as concave when it is not.
    const cycleSec = Math.max(solution.etaSec, MIN_BUDGET_SEC)
      + overhead
      + resetForfeitSec(solution, view);
    // Rated on TOTAL value, count included.
    //
    // Rating on the activated part alone is tempting — that is the split the
    // install cadence uses, and count is a gate rather than a rate. It is wrong
    // here for a blunt reason: on a route whose remaining value is all count,
    // every set activates nothing, every budget rates zero, and the EMPTY cycle
    // wins on the tie-break. This rate ranks budgets against each other, and
    // acquiring route progress per second of cycle is real work. When to convert
    // the cycle into an install remains progression's decision, on its own
    // activation-only comparison.
    const rate = solution.value / cycleSec;
    curve.push({
      sec: budgetSec,
      value: solution.value,
      rate,
      factions: solution.choices.length,
    });
    if (!best || rate > best.rate + 1e-12) best = { budgetSec, solution, rate };
  }

  const chosen = best ?? {
    budgetSec: MIN_BUDGET_SEC,
    solution: evaluate([], view),
    rate: 0,
  };
  return { budgetSec: chosen.budgetSec, solution: chosen.solution, curve };
}

// --- public shape ----------------------------------------------------------

/** Re-price one chosen push as it will actually be worked: at its position in
 * the set, after the pushes before it, with shared augmentations removed. The
 * published `FactionIntent` has to describe the real obligation, because the
 * arbiter reserves money and the work slot against it. */
function intentAt(
  solution: PortfolioSolution,
  slot: number,
  view: FactionsView,
): FactionIntent {
  const prefix = solution.choices.slice(0, slot + 1);
  const before = evaluate(solution.choices.slice(0, slot), view);
  const upTo = evaluate(prefix, view);
  const choice = solution.choices[slot]!;
  const marginalSec = Math.max(1, upTo.etaSec - before.etaSec);
  const marginalValue = Math.max(0, upTo.value - before.value);
  const added = upTo.augmentations.filter((name) => !before.augmentations.includes(name));
  return {
    ...choice.pkg,
    augmentations: added,
    value: marginalValue,
    etaSec: upTo.etaSec - before.etaSec,
    rate: marginalValue / marginalSec,
    marginalRate: marginalValue / marginalSec,
    workSecFromNow: before.workSec,
  };
}

function toPortfolio(
  choice: BudgetChoice,
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
  basis: string,
  previousBudgetSec?: number,
): FactionPortfolio {
  const { solution } = choice;
  const bound = upperBound(frontiers, choice.budgetSec);
  return {
    packages: solution.choices.map((_, slot) => intentAt(solution, slot, view)),
    augmentations: solution.augmentations,
    value: solution.value,
    budgetSec: choice.budgetSec,
    etaSec: solution.etaSec,
    workSec: solution.workSec,
    moneySec: solution.moneySec,
    boundGap: bound > 0 ? Math.max(0, 1 - solution.value / bound) : 0,
    basis,
    ...(previousBudgetSec !== undefined ? { previousBudgetSec } : {}),
  };
}

/** Once the selected faction-acquisition route has a reachable terminal
 * augmentation, it is a route CONSTRAINT rather than another value/sec bidder.
 *
 * The node cannot end without The Red Pill, so it may neither sit behind an
 * optional package with a better rate nor — the case a budget introduces — be
 * left out of the plan altogether because its reputation grind does not fit the
 * cycle the renewal rule liked. It is forced to the head of the set, displacing
 * whatever the faction was doing there. Routes that do not use it never produce
 * this package and are unaffected. */
function routeTerminal(
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
): { faction: string; index: number } | undefined {
  if (view.route !== "daedalus" && view.route !== "gang") return undefined;
  if (view.owned.has("The Red Pill")) return undefined;
  let best: { faction: string; index: number; etaSec: number; cost: number } | undefined;
  for (const [faction, frontier] of frontiers) {
    const standing = standingOf(faction, view);
    if (standing?.joined !== true && standing?.invited !== true) continue;
    for (let index = 0; index < frontier.length; index++) {
      const pkg = frontier[index]!;
      if (!pkg.augmentations.includes("The Red Pill")) continue;
      if (
        !best
        || pkg.etaSec < best.etaSec
        || (pkg.etaSec === best.etaSec && pkg.totalCost < best.cost)
        || (pkg.etaSec === best.etaSec && pkg.totalCost === best.cost && faction < best.faction)
      ) {
        best = { faction, index, etaSec: pkg.etaSec, cost: pkg.totalCost };
      }
    }
  }
  return best ? { faction: best.faction, index: best.index } : undefined;
}

/** Put the route's terminal package at the head of a solved set, adding it if
 * the budget left it out. */
function withRouteTerminal(
  solution: PortfolioSolution,
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
): PortfolioSolution {
  const terminal = routeTerminal(frontiers, view);
  if (!terminal) return solution;
  const already = solution.choices[0];
  if (already && already.faction === terminal.faction && already.index === terminal.index) return solution;
  const rest = solution.choices
    .filter((choice) => choice.faction !== terminal.faction)
    .map((choice) => ({ faction: choice.faction, index: choice.index }));
  return evaluateSelection([terminal, ...rest], frontiers, view) ?? solution;
}

/** Drop-in replacement for the single-faction selector.
 *
 * `intent` is the HEAD of the portfolio and `runnerUp` the next package in it,
 * so every existing consumer — the arbiter's money and work-slot claims, the
 * `until` readout, progression's install forecast — keeps reading exactly what
 * it read before. What changed is how the head was chosen: as the first move of
 * a set costed together, rather than as a winner costed alone. */
export function selectFactionPortfolio(
  view: FactionsView,
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  options: {
    resetOverheadSec: number;
    basis: string;
    previousBudgetSec?: number;
    /** Solve at THIS budget instead of sweeping for one. */
    budgetSec?: number;
    /** The committed set. Given with `budgetSec`, the plan is RE-PRICED rather
     * than re-chosen — one evaluation instead of a search. Falls back to a
     * solve when a committed target has left its frontier. */
    committed?: readonly { faction: string; repTarget: number }[];
  },
): PackageSelection & { portfolio: FactionPortfolio; horizonCurve: HorizonSample[] } {
  const reprice = options.committed && options.budgetSec !== undefined
    ? repricePortfolio(options.committed, frontiers, view)
    : undefined;
  const choice: BudgetChoice = reprice
    ? { budgetSec: options.budgetSec!, solution: reprice, curve: [] }
    : options.budgetSec !== undefined
      ? { budgetSec: options.budgetSec, solution: solvePortfolio(frontiers, view, options.budgetSec), curve: [] }
      : chooseBudget(frontiers, view, options.resetOverheadSec);
  const constrained: BudgetChoice = {
    ...choice,
    solution: withRouteTerminal(choice.solution, frontiers, view),
  };
  const portfolio = toPortfolio(constrained, frontiers, view, options.basis, options.previousBudgetSec);
  const head = portfolio.packages[0];
  const runner = portfolio.packages[1];

  const foreclosed: { name: string; bannedBy: string }[] = [];
  for (const pkg of portfolio.packages) {
    const standing = view.factions.find((entry) => entry.name === pkg.faction);
    if (!standing) continue;
    for (const other of view.factions) {
      if (other.name === pkg.faction || other.joined) continue;
      if (standing.enemies.includes(other.name) || other.enemies.includes(pkg.faction)) {
        if (!foreclosed.some((entry) => entry.name === other.name)) {
          foreclosed.push({ name: other.name, bannedBy: pkg.faction });
        }
      }
    }
  }

  return {
    ...(head ? { intent: head } : {}),
    ...(runner ? { runnerUp: runner } : {}),
    frontiers: new Map([...frontiers].map(([name, list]) => [name, [...list]])),
    foreclosed,
    portfolio,
    horizonCurve: choice.curve,
  };
}

/** Re-price a committed set against today's frontiers WITHOUT re-choosing it.
 *
 * Solving is the expensive half — a 24-budget sweep over every faction's ladder
 * — and it answers a question that does not change every pass. Reputation,
 * income and blockers DO change every pass, so between re-solves the committed
 * `(faction, reputation target)` pairs are looked up again and re-costed. That
 * is one evaluation instead of thousands, and it is what keeps a committed plan
 * honest without re-deciding it twice a second.
 *
 * `undefined` when a committed target has left its faction's frontier, which
 * means the plan is stale for a structural reason and the caller must re-solve.
 * Matching by reputation target rather than by index for the same reason
 * `decide.ts` refreshes a latched intent that way: an index is a position in a
 * list that today's frontier may have reshaped. */
export function repricePortfolio(
  committed: readonly { faction: string; repTarget: number }[],
  frontiers: ReadonlyMap<string, readonly FactionPackage[]>,
  view: FactionsView,
): PortfolioSolution | undefined {
  if (committed.length === 0) return undefined;
  const selection: { faction: string; index: number }[] = [];
  for (const entry of committed) {
    const frontier = frontiers.get(entry.faction);
    if (!frontier) return undefined;
    const index = frontier.findIndex((pkg) => Math.abs(pkg.repTarget - entry.repTarget) <= 1e-9);
    if (index < 0) return undefined;
    selection.push({ faction: entry.faction, index });
  }
  return evaluateSelection(selection, frontiers, view);
}

/** Build the frontiers and choose a plan in one step.
 *
 * `decideFactions` deliberately does these separately, because it needs
 * `horizonStarved` from the frontier build to tell "nothing left worth pushing
 * for" from "the forecast dipped". Everywhere else — review tooling, tests —
 * wants the whole answer from a view. */
export function selectFactionPlan(
  view: FactionsView,
  blockers: ReadonlyMap<string, readonly Blocker[]>,
  options: { resetOverheadSec?: number; basis?: string; budgetSec?: number } = {},
): PackageSelection & { portfolio: FactionPortfolio; horizonCurve: HorizonSample[] } {
  const { frontiers, horizonDropped } = buildFrontiers(view, blockers);
  const selection = selectFactionPortfolio(view, frontiers, {
    resetOverheadSec: options.resetOverheadSec ?? view.resetOverheadSec ?? 0,
    basis: options.basis ?? "",
    ...(options.budgetSec !== undefined ? { budgetSec: options.budgetSec } : {}),
  });
  return {
    ...selection,
    ...(selection.intent === undefined && horizonDropped > 0 ? { horizonStarved: true } : {}),
  };
}
