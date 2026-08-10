import { formatScientific } from "../../format.ts";
import { addRepToFavor } from "../factions/rep.ts";
import { INSTALL_OVERHEAD_SEC } from "./eta.ts";

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
  /** The faction sweep needs the stock book converted before it can make the
   * first queued purchase. This may request liquidation, never installation. */
  factionsNeedLiquidation: boolean;
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
  /** The chosen endgame route's estimate of REMAINING node time, when a route
   * is decided. Nothing persists past the node, so an install this close to
   * the end only delays it. */
  nodeRemainingSec?: number;
  /** The selected route cannot complete without installing its already-owned
   * route augmentation (currently The Red Pill). */
  routeRequiresInstall: boolean;
  /** Σ multiplier-only log-value of the QUEUED augmentations (scoreAugMults —
   * no flat bonuses). What the reset would ACTIVATE. */
  resetValueMult?: number;
  /** value/sec of pushing the next faction package increment — the frontier's
   * own marginalRate, which already prices escalation, rep walls and donation
   * crossovers. */
  pushMarginalRate?: number;
  /** That package's acquisition ETA, for the published digest. */
  pushEtaSec?: number;
  /** The DWELLED marginal verdict, resolved by the driver (hysteresis + latch
   * live in progressionMemory): true = install beats pushing, false = keep
   * pushing, undefined = no route ETA — the legacy cash gate decides. */
  marginalInstall?: boolean;
  /** The final sweep could still convert at least one rep-met, affordable
   * offer. Purchases are end-loaded, so mid-cycle the queue is empty BY
   * DESIGN — this is the "an install would activate something" signal that
   * opens the install gate; the sweep then turns it into a real queue before
   * the purchasable-augmentation blocker lets the reset execute. */
  resetRealizable?: boolean;
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
  /** Stock should convert its book. Broader than installWanted only for the
   * empty-queue first-purchase bootstrap. */
  liquidationWanted: boolean;
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
/** Minimum remaining NODE time for an install cycle to repay its overhead
 * (kill everything, reboot, regrow). Below this, finish the node instead. */
export const INSTALL_MIN_PAYBACK_SEC = 600;
/** The accrued value must clear the renewal threshold by this margin before
 * the verdict flips to "install" — the push rate re-measures constantly and
 * an install is irreversible. */
export const PUSH_MARGIN = 1.25;
/** A raw verdict flip must hold this long before it takes effect: rates
 * re-measure constantly and an unhysteresed rule would thrash the endgame
 * machinery (the final sweep and the stock liquidation both key off it). */
export const VERDICT_DWELL_MS = 90_000;
/** Flat time cost a reset spends before the activated queue earns anything
 * (kill/reboot/re-sweep). Not a second opinion: it IS the route model's
 * install overhead, imported so a recalibration there moves the cadence
 * threshold sqrt(2·O·pushRate) with it. */
export const INSTALL_VERDICT_OVERHEAD_SEC = INSTALL_OVERHEAD_SEC;

export interface InstallVerdict {
  verdict: "push" | "install" | "no-data";
  /** value/sec of continuing to push (frontier marginalRate). */
  pushRate?: number;
  /** The renewal threshold the accrued value must clear: sqrt(2·O·pushRate). */
  threshold?: number;
  why: string;
}

/** The install-vs-push cadence, as a renewal problem.
 *
 * The metric is BitNode completion time. Value accrues while pushing (at the
 * frontier's marginalRate, which already prices 1.9x escalation, rep walls
 * and donation crossovers) but only ACTIVATES at an install — so every cycle
 * pays two deadweights: accrued value sitting inactive (≈ p·T²/2 over a
 * cycle of length T) and the flat install overhead O. The per-second loss
 * p·T/2 + O/T is minimized at T* = sqrt(2·O/p), i.e. install when the
 * accrued value p·T reaches sqrt(2·O·p). Crucially this is INDEPENDENT of
 * the remaining node time — a long node wants frequent small installs, not
 * none; the too-close-to-the-end case is INSTALL_MIN_PAYBACK_SEC's job in
 * stepProgression, not this rule's. Flat score bonuses (Red Pill's route
 * marker) are excluded from the accrued side — they mark necessity, not
 * rate — and the route-mandatory install path is routeRequiresInstall's. */
export function installVerdict(view: {
  /** A route ETA exists at all. Deliberately a boolean, not the seconds: the
   * renewal rule is INDEPENDENT of remaining node time (see above), so only
   * the ETA's absence matters here — the magnitude is consumed by
   * stepProgression's INSTALL_MIN_PAYBACK_SEC rule. A numeric parameter whose
   * value was dead invited someone to double-count that rule. */
  routeEtaKnown?: boolean;
  resetValueMult?: number;
  pushMarginalRate?: number;
  /** The frontier has published a plan and it names NO push target — the
   * honest "nothing left to push for". A missing rate WITHOUT this flag just
   * means the frontier has not run yet (cycle start, feature booting), and
   * concluding "install" there latches before any work begins. */
  frontierIdle?: boolean;
}): InstallVerdict {
  if (view.routeEtaKnown !== true) {
    return { verdict: "no-data", why: "no route ETA; the legacy cash gate decides" };
  }
  const accrued = Math.max(0, view.resetValueMult ?? 0);
  const pushRate = view.pushMarginalRate;
  if (pushRate === undefined || pushRate <= 0) {
    if (view.frontierIdle === true) {
      return { verdict: "install", why: "nothing left worth pushing for" };
    }
    return { verdict: "no-data", why: "the frontier has not published a push target yet" };
  }
  const threshold = Math.sqrt(2 * INSTALL_VERDICT_OVERHEAD_SEC * pushRate) * PUSH_MARGIN;
  if (accrued > threshold) {
    return {
      verdict: "install",
      pushRate,
      threshold,
      why: `accrued value ${formatScientific(accrued)} clears the cadence threshold ${formatScientific(threshold)} at push rate ${formatScientific(pushRate)}/s`,
    };
  }
  return {
    verdict: "push",
    pushRate,
    threshold,
    why: `accrued value ${formatScientific(accrued)} below the cadence threshold ${formatScientific(threshold)} at push rate ${formatScientific(pushRate)}/s`,
  };
}

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

  // Install when the run is in `ending` AND there is something to install —
  // or when a favor crossing exists and factions has concluded its sweep. The
  // crossing is a step change (donations unlock, every future rep requirement
  // becomes payable), so once the faction layer itself says the run should end
  // there is nothing left for the cash-accumulation phase gate to protect:
  // waiting for `money > earned/2` just strands banked favor behind a
  // heuristic about a conversion that has already happened.
  // ...unless the NODE itself is nearly over: nothing survives the node, so
  // an install whose payoff window is shorter than its own overhead only
  // delays the finish. Unknown route ETA keeps installs allowed.
  const nodeAllowsOptionalInstall =
    view.nodeRemainingSec === undefined || view.nodeRemainingSec > INSTALL_MIN_PAYBACK_SEC;
  const routeInstallWanted = view.routeRequiresInstall && view.queued.length > 0;
  // The marginal-value rule is the PRIMARY driver when a route ETA exists;
  // the legacy cash-ratio phase gate covers the no-data case. The favor
  // crossing stays as an independent fast-path — a step change (donations
  // unlock) the smooth rate comparison cannot represent.
  const endingArm = view.marginalInstall === undefined ? phase === "ending" : view.marginalInstall;
  // End-loaded purchasing keeps the queue empty until the sweep runs, and the
  // sweep is triggered BY installWanted — so a realizable sweep set must open
  // this gate as well or cycles after the first can never conclude.
  const somethingToActivate = view.queued.length > 0 || view.resetRealizable === true;
  const optionalInstallWanted =
    nodeAllowsOptionalInstall &&
    somethingToActivate &&
    (endingArm || (crossings.length > 0 && view.factionsReadyToInstall));
  const installWanted = routeInstallWanted || optionalInstallWanted;
  const liquidationWanted =
    installWanted || ((view.routeRequiresInstall || nodeAllowsOptionalInstall) && view.factionsNeedLiquidation);
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
  if (installWanted && view.queued.length === 0) {
    // The game's installAugmentations is a NO-OP with nothing queued — an
    // armed empty install would sit forever. The realizable signal may open
    // the gate, but the sweep must convert something before the reset can
    // actually execute.
    installBlockers.push({ kind: "augmentations", why: "nothing queued yet; the sweep must convert something first" });
  }
  const installReady = installWanted && installBlockers.length === 0;
  const why = installReady
    ? routeInstallWanted
      ? `ready to install ${view.queued.length} augmentation(s); the selected endgame route requires this reset`
      : crossings.length > 0
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
    liquidationWanted,
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
