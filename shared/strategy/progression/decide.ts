import { addRepToFavor } from "../factions/rep.ts";

/** Progression: install timing, reset cadence and BitNode ordering.
 *
 * Last by design, because it COMPOSES every other feature's completed
 * strategy: its decision is "given what each feature can deliver per hour
 * under this node's multipliers, when is a reset worth it".
 *
 * The run-phase machine is taken from the predecessor scripts
 * (src/main.ts:1417-1573), which is the most concrete prior art available for
 * a decision most scripts fudge:
 *
 *   start -> finishUp -> ending
 *
 * with promotion on the affordable augmentation set's VALUE PRODUCT, then on
 * cash exceeding half of what the run earned. It is a starting shape refined
 * by an install-timing rule, not a copied implementation. */

export type RunPhase = "start" | "finishUp" | "ending";

export interface ProgressionView {
  /** Augmentations owned this run (installed or queued). */
  queued: string[];
  /** Value product of the augmentations we could afford right now. Their
   *  multipliers MULTIPLY, so this is a product rather than a sum. */
  affordableValueProduct: number;
  /** Is any faction work currently in progress? */
  factionWorkInProgress: boolean;
  /** The faction planner has finished its last-chance purchase/donation sweep. */
  factionsReadyToInstall: boolean;
  /** The stock feature's OWN answer to "may an install destroy the book?" —
   *  `stock.plan.flat`, not a scan of its positions. Nothing held, nothing
   *  pending, nothing wanted. */
  stockReadyToInstall: boolean;
  /** An augmentation that could still be BOUGHT right now: joined faction,
   *  reputation met, prerequisites owned, price affordable.
   *
   *  The other half of the barrier, and the reason the barrier is not simply "the
   *  phase says ending". Cash does not survive an install, so every dollar that
   *  could still have become a permanent multiplier is destroyed by resetting
   *  early — which makes a purchasable augmentation a strictly better use of the
   *  next pass than the reset. Named rather than boolean so the blocker can say
   *  WHICH one is holding it up; a value that never clears is a factions bug made
   *  visible instead of money silently thrown away. */
  purchasableAugmentation?: string;
  /** A graft has already paid its cash cost and must finish before reset. */
  graftInProgress: boolean;
  /** Money on hand. */
  money: number;
  /** Money earned since the last install. */
  earnedThisRun: number;
  /** Faction name -> {rep, favor}, for the favor crossover. */
  factions: Record<string, { rep: number; favor: number }>;
  /** Favor at which donations unlock. */
  favorToDonate: number;
  /** Home RAM, and its cost to upgrade. */
  homeRam: number;
  homeRamUpgradeCost: number;
  /** Seconds elapsed this run. */
  runSec: number;
}

export type InstallBlockerKind = "factions" | "stock" | "graft" | "augmentations";

export interface InstallBlocker {
  kind: InstallBlockerKind;
  why: string;
}

export interface ProgressionDecision {
  phase: RunPhase;
  /** The economic cadence says this run should end, before safety barriers. */
  installWanted: boolean;
  /** Preconditions that must clear before the irreversible reset. */
  installBlockers: InstallBlocker[];
  /** The reset is economically wanted and every observed barrier is clear. */
  installReady: boolean;
  /** Fraction of cash the home-RAM budget may take this phase. */
  homeRamBudgetFraction: number;
  /** Factions whose banked reputation would cross the donation threshold on
   *  install — the strongest single argument for resetting. */
  favorCrossings: { faction: string; favorNow: number; favorAfter: number }[];
  why: string;
}

/** Promote to `finishUp` when the affordable set's value product reaches this,
 * or FINISH_UP_IDLE with no faction work running. */
export const FINISH_UP_VALUE = 2.0;
export const FINISH_UP_IDLE_VALUE = 1.5;
/** Home RAM budget as a fraction of cash, per phase. */
export const HOME_RAM_BUDGET = { start: 0.1, finishUp: 0.5, ending: 0.5 };

export function phaseOf(view: ProgressionView): RunPhase {
  // `ending` once cash exceeds half of what the run earned: at that point the
  // run is accumulating rather than converting, and the conversion (install)
  // is what compounds.
  if (view.earnedThisRun > 0 && view.money > view.earnedThisRun / 2 && view.queued.length > 0) return "ending";
  if (view.affordableValueProduct >= FINISH_UP_VALUE) return "finishUp";
  if (view.affordableValueProduct >= FINISH_UP_IDLE_VALUE && !view.factionWorkInProgress) return "finishUp";
  return "start";
}

/** Which factions would cross the donation threshold if we installed now.
 *
 * This is the EXACT install-timing crossover the plan calls for. Favor is
 * banked only at install, and crossing `favorToDonate` converts every future
 * reputation requirement at that faction from "work for hours" into "pay
 * money" — a step change, not a marginal gain. */
export function favorCrossings(view: ProgressionView): ProgressionDecision["favorCrossings"] {
  const out: ProgressionDecision["favorCrossings"] = [];
  for (const [faction, standing] of Object.entries(view.factions)) {
    if (standing.favor >= view.favorToDonate) continue;
    const after = addRepToFavor(standing.favor, standing.rep);
    if (after >= view.favorToDonate) {
      out.push({ faction, favorNow: standing.favor, favorAfter: after });
    }
  }
  return out.sort((a, b) => b.favorAfter - a.favorAfter || (a.faction < b.faction ? -1 : 1));
}

export function stepProgression(view: ProgressionView): ProgressionDecision {
  const phase = phaseOf(view);
  const crossings = favorCrossings(view);

  // Install when the run is in `ending` AND there is something to install.
  // The favor crossing is the strongest single argument, so it is reported
  // even when it is not decisive.
  const installWanted = phase === "ending" && view.queued.length > 0;
  const installBlockers: InstallBlocker[] = [];
  if (installWanted && !view.factionsReadyToInstall) {
    installBlockers.push({ kind: "factions", why: "factions has not finished its final purchase and donation sweep" });
  }
  if (installWanted && !view.stockReadyToInstall) {
    installBlockers.push({ kind: "stock", why: "stock portfolio is not authoritatively flat" });
  }
  if (installWanted && view.purchasableAugmentation !== undefined) {
    installBlockers.push({
      kind: "augmentations",
      why: `${view.purchasableAugmentation} is still affordable; cash does not survive the install`,
    });
  }
  if (installWanted && view.graftInProgress) {
    installBlockers.push({ kind: "graft", why: "an already-paid graft is still in progress" });
  }
  const installReady = installWanted && installBlockers.length === 0;
  const why = installReady
    ? crossings.length > 0
      ? `ready to install ${view.queued.length} augmentation(s); ${crossings.length} faction(s) cross the donation threshold`
      : `ready to install ${view.queued.length} augmentation(s); cash exceeds half the run's earnings`
    : installWanted
      ? `preparing install: ${installBlockers.map((blocker) => blocker.why).join("; ")}`
    : phase === "finishUp"
      ? `affordable set is worth x${view.affordableValueProduct.toFixed(2)} — converting reputation to augmentations`
      : `building: affordable set is only worth x${view.affordableValueProduct.toFixed(2)}`;

  return {
    phase,
    installWanted,
    installBlockers,
    installReady,
    homeRamBudgetFraction: HOME_RAM_BUDGET[phase],
    favorCrossings: crossings,
    why,
  };
}

// --- BitNode ordering -------------------------------------------------------

export interface BitNodeEntry {
  node: number;
  /** Target source-file level. */
  level: number;
  /** HEURISTIC hours to complete — an estimate from ./eta.ts and the recorded
   *  runs, never a known constant. We optimise to reduce it; the telemetry log
   *  (estimate at decision time, actual at reset) is what tunes it. */
  hours?: number;
  /** Source files that make this node materially easier. */
  wants: number[];
}

/** The predecessor scripts' explicit ordering, with their stated rationale:
 * "build hack power to get hacknet, use hacknet to get Stanek, then do all the
 * Bladeburners" (src/main.ts:1483-1511).
 *
 * This is the BASELINE to beat — a real, rationalised human ordering, which is
 * a far more honest bar than a strawman. */
export const BASELINE_ORDER: [number, number][] = [
  [4, 3], [1, 3], [5, 1], [2, 3], [5, 3], [12, 3], [8, 3], [10, 3],
  [9, 3], [13, 3], [7, 1], [6, 3], [7, 3], [11, 3], [3, 3],
];

/** Total hours for an ordering, given measured per-node times and the
 * dependency discount a prerequisite source file provides. */
export function orderingCost(
  order: readonly [number, number][],
  hours: Record<number, number>,
  /** Multiplier applied when a wanted source file is already held. */
  discount: number,
  wants: Record<number, number[]>,
): number {
  const held = new Set<number>();
  let total = 0;
  for (const [node] of order) {
    const base = hours[node] ?? 0;
    const satisfied = (wants[node] ?? []).filter((want) => held.has(want)).length;
    total += base * Math.pow(discount, satisfied);
    held.add(node);
  }
  return total;
}

/** Exhaustive search over orderings, for a small node set.
 *
 * 15 nodes is 15! and impossible, so this is EXACT only for the subset the
 * caller passes — which is the honest framing: BitNode ordering is evaluated
 * analytically across runs, not inside one, because `currentNodeMults` is
 * module state and the simulator is one node per process. */
export function bestOrdering(
  nodes: readonly [number, number][],
  hours: Record<number, number>,
  discount: number,
  wants: Record<number, number[]>,
  maxNodes = 8,
): { order: [number, number][]; hours: number; exact: boolean } {
  if (nodes.length > maxNodes) {
    // Greedy: cheapest first, which at least respects measured times.
    const order = [...nodes].sort((a, b) => (hours[a[0]] ?? 0) - (hours[b[0]] ?? 0));
    return { order, hours: orderingCost(order, hours, discount, wants), exact: false };
  }
  let best: [number, number][] = [];
  let bestHours = Infinity;
  const permute = (remaining: [number, number][], current: [number, number][]): void => {
    if (remaining.length === 0) {
      const cost = orderingCost(current, hours, discount, wants);
      if (cost < bestHours) {
        bestHours = cost;
        best = [...current];
      }
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      const next = remaining[i]!;
      permute([...remaining.slice(0, i), ...remaining.slice(i + 1)], [...current, next]);
    }
  };
  permute([...nodes], []);
  return { order: best, hours: bestHours, exact: true };
}
