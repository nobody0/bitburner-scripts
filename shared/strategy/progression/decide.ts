import type { ChannelWorth } from "../income.ts";
import { formatScientific } from "../../format.ts";
import { countSlotWeight } from "../factions/augs.ts";
import { addRepToFavor } from "../factions/rep.ts";
import { BITNODE_SPEEDRUN_PLAN } from "./bitnode-order.ts";
import { DAEDALUS_EARLY_BATCH_PROGRESS_FRACTION } from "./endgame.ts";
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

/** Require early count-only installs to bank a target-relative tranche. The
 * fraction comes from the route phase policy, rather than a node-specific
 * augmentation count or observed purchase threshold. */
export function earlyCountBatchAllowed(required: number, installed: number, fundedDistinct: number): boolean {
  if (!(required > 0) || installed >= required) return false;
  return Math.max(0, Math.floor(fundedDistinct))
    >= Math.ceil(
      (required - Math.max(0, installed)) * DAEDALUS_EARLY_BATCH_PROGRESS_FRACTION,
    );
}

/** Persistent value of installing a sufficiently large partial tranche toward
 * a finite route count gate. Count slots do not accelerate the next cycle, but
 * omitting them entirely makes cadence wait for one enormous 1.9^N purchase
 * ladder. The route's consolidation policy supplies `batchAllowed`, so this
 * never re-opens tiny late resets. Units match faction package count value. */
export function routeCountInstallValue(input: {
  required: number;
  installed: number;
  affordableDistinct: number;
  batchAllowed: boolean;
  /** What the route measured an acquisition-rate increase to save. */
  worth?: ChannelWorth;
}): number {
  if (!input.batchAllowed || input.required <= 0 || input.installed >= input.required) return 0;
  const remaining = input.required - input.installed;
  const progress = Math.min(remaining, Math.max(0, Math.floor(input.affordableDistinct)));
  return progress * countSlotWeight(input.worth ?? new Map(), remaining);
}

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
  /** The selected route stage can survive an economic (non-mandatory) reset.
   * False for progress such as gang/Daedalus reputation, labyrinth traversal,
   * and the final world-daemon skill regrow. */
  optionalInstallAllowed?: boolean;
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
  /** Factions whose banked reputation would cross the donation threshold on
   *  install — the strongest single argument for resetting. */
  favorCrossings: { faction: string; favorNow: number; favorAfter: number }[];
  why: string;
}

/** Promote to `finishUp` when the affordable set's value product reaches this,
 * or FINISH_UP_IDLE with no faction work running. */
export const FINISH_UP_VALUE = 2.0;
export const FINISH_UP_IDLE_VALUE = 1.5;
/** Minimum remaining NODE time for an install cycle to repay its overhead
 * (kill everything, reboot, regrow). Below this, finish the node instead. */
export const INSTALL_MIN_PAYBACK_SEC = 600;
/** The accrued value must clear the renewal threshold by this margin before
 * the verdict flips to "install" — the push rate re-measures constantly and
 * an install is irreversible. */
// The renewal equation assumes a stationary value stream and an exact replay
// cost. Real prestige cycles are neither: the early bootstrap is convex and
// package value arrives at discrete reputation breakpoints. Keep a modest
// safety margin around the measured crossing; dwell handles transient flips.
// This is route-independent and is not a minimum augmentation count.
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
  /** Empirical time to replay the reset-sensitive frontier after prestige. */
  resetOverheadSec?: number;
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
  if (pushRate === undefined) {
    if (view.frontierIdle === true) {
      return { verdict: "install", why: "nothing left worth pushing for" };
    }
    return { verdict: "no-data", why: "the frontier has not published a push target yet" };
  }
  if (pushRate <= 0) {
    return {
      verdict: "install",
      pushRate: 0,
      threshold: 0,
      why: accrued > 0
        ? "the next package adds route progress but no reset-activated acceleration; bank the accrued multiplier value"
        : "the next package adds no reset-activated acceleration",
    };
  }
  const overhead = Math.max(INSTALL_VERDICT_OVERHEAD_SEC, view.resetOverheadSec ?? 0);
  const threshold = Math.sqrt(2 * overhead * pushRate) * PUSH_MARGIN;
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

/** Forecast the cadence crossing while preserving the measured bootstrap
 * shape used by {@link installVerdict}.
 *
 * A convex cumulative-money curve makes the equivalent reset delay grow as
 * `runSec * (1 - 1 / exponent)`. Holding today's threshold fixed therefore
 * predicts a crossing too early. Freeze the measured exponent and push rate,
 * then solve the resulting linear-value / square-root-threshold intersection.
 * This is still an estimate, but it forecasts the same model the next verdict
 * will evaluate instead of a threshold that cannot remain fixed. */
export function installCadenceRemainingSec(view: {
  runSec: number;
  resetValueMult: number;
  pushMarginalRate?: number;
  bootstrapExponent?: number;
}): number | undefined {
  const pushRate = view.pushMarginalRate;
  if (pushRate === undefined || !Number.isFinite(pushRate) || pushRate < 0) return undefined;
  if (pushRate === 0) return 0;

  const runSec = Math.max(0, view.runSec);
  const accrued = Math.max(0, view.resetValueMult);
  const exponent = Math.max(1, view.bootstrapExponent ?? 1);
  const overheadSlope = exponent > 1 ? 1 - 1 / exponent : 0;
  const currentOverhead = Math.max(INSTALL_VERDICT_OVERHEAD_SEC, overheadSlope * runSec);
  const currentThreshold = Math.sqrt(2 * currentOverhead * pushRate) * PUSH_MARGIN;
  if (accrued >= currentThreshold) return 0;

  const fixedCrossingSec = (currentThreshold - accrued) / pushRate;
  if (overheadSlope <= 0) return fixedCrossingSec;

  const dynamicStartsAt = INSTALL_VERDICT_OVERHEAD_SEC / overheadSlope;
  if (runSec + fixedCrossingSec <= dynamicStartsAt) return fixedCrossingSec;

  // (accrued + rate*x)^2 = 2 * margin^2 * rate * slope * (runSec + x)
  const dynamicScale = 2 * PUSH_MARGIN * PUSH_MARGIN * pushRate * overheadSlope;
  const a = pushRate * pushRate;
  const b = 2 * accrued * pushRate - dynamicScale;
  const c = accrued * accrued - dynamicScale * runSec;
  const discriminant = Math.max(0, b * b - 4 * a * c);
  const crossingSec = (-b + Math.sqrt(discriminant)) / (2 * a);
  return Number.isFinite(crossingSec) ? Math.max(0, crossingSec) : undefined;
}

export function phaseOf(view: ProgressionView): RunPhase {
  // This threshold is an install-state signal, not a claimant veto. The value
  // curves can decide how cash is shared only AFTER progression has posted an
  // install reserve; they cannot decide that a queued augmentation should be
  // activated or open the factions/stock liquidation handshake. Keep the
  // existing arm until install timing itself has a measured decision model.
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
  // A route-critical package may still be only reputation-banked here:
  // purchases are deliberately end-loaded, and factions opens that
  // transaction only after installWanted becomes true.  A realizable banked
  // set therefore counts as "something to activate" for a mandatory install
  // just as it does for optional cadence.  installReady remains blocked on an
  // empty queue until the sweep has actually converted it.
  const somethingToActivate = view.queued.length > 0 || view.resetRealizable === true;
  const routeInstallWanted = view.routeRequiresInstall && somethingToActivate;
  // The marginal-value rule is the PRIMARY driver when a route ETA exists;
  // the legacy cash-ratio phase gate covers the no-data case. The favor
  // crossing stays as an independent fast-path — a step change (donations
  // unlock) the smooth rate comparison cannot represent.
  const endingArm = view.marginalInstall === undefined ? phase === "ending" : view.marginalInstall;
  // End-loaded purchasing keeps the queue empty until the sweep runs, and the
  // sweep is triggered BY installWanted — so a realizable sweep set must open
  // this gate as well or cycles after the first can never conclude.
  const optionalInstallWanted =
    view.optionalInstallAllowed !== false &&
    nodeAllowsOptionalInstall &&
    somethingToActivate &&
    (endingArm || crossings.length > 0);
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
    favorCrossings: crossings,
    why,
  };
}

// --- BitNode ordering analysis ---------------------------------------------

/** The predecessor scripts' explicit ordering, retained as the analytical
 * baseline against which candidate orders are measured. */
export const BASELINE_ORDER: [number, number][] = [
  [4, 3], [1, 3], [5, 1], [2, 3], [5, 3], [12, 3], [8, 3], [10, 3],
  [9, 3], [13, 3], [7, 1], [6, 3], [7, 3], [11, 3], [3, 3],
];

/** Tuple form consumed by the existing selector. */
export const ACTIVE_BITNODE_TARGETS: readonly [number, number][] =
  BITNODE_SPEEDRUN_PLAN.map(({ node, level }) => [node, level]);

/** Default account progression after the predecessor baseline. The first
 * entries preserve its staged prerequisites; BN14/15 are appended so the
 * policy covers every finite Source-File rather than silently stopping at 13.
 * This is policy data, separate from the mechanism below and replaceable by a
 * future measured ordering without touching node-completion execution. */
export const DEFAULT_BITNODE_TARGETS: readonly [number, number][] = [
  ...BASELINE_ORDER,
  [14, 3],
  [15, 3],
];

export interface NextBitNodeDecision {
  bitNode: number;
  targetLevel: number;
  why: string;
}

/** Reset-activated value of reputation that will become favor at install.
 *
 * Each faction and unique augmentation contributes at most once. Shared offers
 * are matched to sellers so one arbitrary seller choice cannot hide another
 * faction's useful favor gain. Repeatable levels are re-evaluated after reset.
 */
export function bankedFavorActivationValue(input: {
  standings: readonly { name: string; rep: number; favor: number }[];
  offers: readonly { name: string; faction: string; owned: boolean }[];
  favorToDonate: number;
  /** BN-seconds a relative reputation-rate increase saves. Favor IS a
   *  reputation rate multiplier, so this is what converts the term into the
   *  same seconds the multiplier value beside it is quoted in — without it the
   *  favor half of the accrued value is a rounding error next to the other
   *  half, and on a live BN12 run favor was 97% of it. */
  reputationWorthSec?: number;
}): number {
  const joined = new Set(input.standings.map((standing) => standing.name));
  const offersByFaction = new Map<string, Set<string>>();
  for (const offer of input.offers) {
    if (offer.owned) continue;
    if (!joined.has(offer.faction)) continue;
    const offers = offersByFaction.get(offer.faction) ?? new Set<string>();
    offers.add(offer.name);
    offersByFaction.set(offer.faction, offers);
  }

  const factions = input.standings.filter((standing) => offersByFaction.has(standing.name)).map((standing) => {
    const favorAfter = addRepToFavor(standing.favor, standing.rep);
    const beforeRate = 1 + standing.favor / 100;
    const afterRate = 1 + favorAfter / 100;
    const rateGain = Math.max(0, afterRate / beforeRate - 1);
    const crossesDonation = standing.favor < input.favorToDonate && favorAfter >= input.favorToDonate
      ? 0.5
      : 0;
    return { faction: standing.name, value: rateGain + crossesDonation };
  }).sort((a, b) => b.value - a.value || a.faction.localeCompare(b.faction));

  // Each faction is credited by how many residual augmentations its favor rate
  // could still accelerate — the same `future * rateGain` shape packageValues
  // prices the push side with, so the install verdict compares like with like.
  // Shared offers go to the highest-valued seller only, so one augmentation is
  // never counted twice; factions are already sorted by value, which makes the
  // greedy walk the best such partition.
  const claimed = new Set<string>();
  let value = 0;
  for (const faction of factions) {
    let residual = 0;
    for (const augmentation of [...(offersByFaction.get(faction.faction) ?? [])].sort()) {
      if (claimed.has(augmentation)) continue;
      claimed.add(augmentation);
      residual += 1;
    }
    value += residual * faction.value;
  }
  // Scaled, not reshaped. The `residual` weighting and the crossing constant
  // are relative preferences WITHIN this term and are left exactly as they
  // were; what changes is that the term as a whole is now comparable with the
  // multiplier value it is summed with.
  return value * (input.reputationWorthSec ?? 1);
}

export interface InstallVerdictDwell {
  candidate?: "push" | "install";
  candidateSince?: number;
  effective?: "push" | "install";
}

/** Conservative hysteresis for an irreversible reset. A push observation can
 * always cancel safely and therefore applies immediately. Install must remain
 * the raw answer for the full dwell; boot noise never gets a free first flip. */
export function dwellInstallVerdict(
  raw: InstallVerdict["verdict"],
  previous: InstallVerdictDwell,
  now: number,
  dwellMs = VERDICT_DWELL_MS,
): { state: InstallVerdictDwell; install: boolean | undefined } {
  if (raw === "no-data") return { state: previous, install: undefined };
  if (raw === "push") {
    return {
      state: { candidate: "push", candidateSince: now, effective: "push" },
      install: false,
    };
  }
  const candidateSince = previous.candidate === "install" && previous.candidateSince !== undefined
    ? previous.candidateSince
    : now;
  const held = now - candidateSince >= Math.max(0, dwellMs);
  return {
    state: {
      candidate: "install",
      candidateSince,
      effective: held ? "install" : "push",
    },
    install: held,
  };
}

/** Bound a forward-looking package slope with the value stream observed over
 * the current prestige cycle. Package ETA is a remaining-time estimate and
 * legitimately tends to one second at completion; it must not be interpreted
 * as a sustainable activationValue/second rate by reset cadence. */
export function installCadencePushRate(view: {
  runSec: number;
  resetValueMult: number;
  intentActivationValue?: number;
  intentEtaSec?: number;
  intentMarginalActivationRate?: number;
}): number | undefined {
  const runSec = Math.max(0, view.runSec);
  const observed = runSec > 0 ? Math.max(0, view.resetValueMult) / runSec : 0;
  const intentAverage = view.intentActivationValue !== undefined
    ? Math.max(0, view.intentActivationValue) / Math.max(1, runSec, view.intentEtaSec ?? 0)
    : undefined;
  if (view.intentMarginalActivationRate !== undefined) {
    const forward = Math.max(0, view.intentMarginalActivationRate);
    // A zero marginal SPEED value is not an exhausted route frontier. A
    // package may still contribute a distinct Daedalus count slot, which is
    // intentionally excluded from activationValue because it does not make
    // the next bootstrap faster. Use the measured cycle-average multiplier
    // stream as the cadence prior in that case: this keeps pursuing route
    // progress without pretending the count itself is acceleration.
    if (forward === 0) {
      const prior = Math.max(observed, intentAverage ?? 0);
      return prior > 0 ? prior : undefined;
    }
    const bounded = Math.min(forward, Math.max(observed, intentAverage ?? 0));
    return bounded > 0 ? bounded : undefined;
  }
  return observed > 0 ? observed : undefined;
}

/** Choose the next node after crediting the Source-File the current destroy
 * will award. Duplicate staged entries (SF5.1 before SF5.3, SF7.1 before
 * SF7.3) are intentional. Once every finite target is met, BN12 remains the
 * repeatable scaling destination. */
export function chooseNextBitNode(
  currentBitNode: number,
  sourceFiles: Readonly<Record<string, number>>,
  targets: readonly [number, number][] = ACTIVE_BITNODE_TARGETS,
): NextBitNodeDecision {
  const projected = { ...sourceFiles };
  projected[String(currentBitNode)] = (projected[String(currentBitNode)] ?? 0) + 1;
  for (const [bitNode, targetLevel] of targets) {
    const level = projected[String(bitNode)] ?? 0;
    if (level < targetLevel) {
      return {
        bitNode,
        targetLevel,
        why: `SF${bitNode}.${level + 1} is the next unmet milestone toward level ${targetLevel}`,
      };
    }
  }
  const nextLevel = (projected["12"] ?? 0) + 1;
  return {
    bitNode: 12,
    targetLevel: nextLevel,
    why: `all finite Source-File targets are met; continue repeatable SF12 at level ${nextLevel}`,
  };
}

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
