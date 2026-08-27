import type { MoneySource } from "@ns";
import type { FeatureId } from "../../features/ids.ts";
import type { DenyReason, ResourceId } from "../../strategy/arbiter.ts";
import type { NeedKind, NeedUrgency } from "../../strategy/needs.ts";
import type { PlanningHorizons } from "../../strategy/progression/forecast.ts";
import type { ProgressionMarginals } from "../../strategy/progression/marginal.ts";
import type { RouteId, RouteNeed } from "../../strategy/progression/endgame.ts";
import type { InstallBlockerKind } from "../../strategy/progression/decide.ts";

/** Progression feature — the meta layer. Problem: pick the destroy order and
 * the augmentation/reset cadence that minimises total wall-clock to a target
 * source-file set.
 *
 * SERIALIZATION: ResetInfo hands back `ownedAugs`, `ownedSF` and
 * `bitNodeOptions.sourceFileOverrides` as Maps. `JSON.stringify(new Map())`
 * is `{}` — every one of them is flattened with Object.fromEntries before it
 * reaches the wire. Same rule for every topic in this directory. */

export interface Progression {
  bitNode: number;
  /** SF number -> active level. Advanced per-run overrides are already folded
   * in, so this is capability truth but cannot reconstruct permanently owned
   * levels for an overridden SF.
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObject.ts#L93-L95 */
  sourceFiles: Record<string, number>;
  /** Augmentation name -> level (level matters for NeuroFlux Governor). */
  ownedAugs: Record<string, number>;
  augCount: number;
  lastAugReset: number;
  lastNodeReset: number;
  /** Flattened BitNodeOptions; sourceFileOverrides is a Map upstream. */
  bitNodeOptions?: {
    sourceFileOverrides: Record<string, number>;
    intelligenceOverride?: number;
    restrictHomePCUpgrade?: boolean;
    disableGang?: boolean;
    disableCorporation?: boolean;
    disableBladeburner?: boolean;
    disable4SData?: boolean;
    disableHacknetServer?: boolean;
    disableSleeveExpAndAugmentation?: boolean;
  };
  /** Only present with SF5/BN5 — ns.getBitNodeMultipliers throws otherwise. */
  multipliers?: Record<string, number>;
  /** Per-feature money attribution: the cross-feature "what is actually
   * paying" view, and the cheapest signal for which feature to optimise. */
  moneySources?: { sinceInstall: MoneySource; sinceStart: MoneySource };

  /** Cross-feature coordination, hung here rather than on a feature of its
   * own: it describes the relationships BETWEEN features, so giving it a
   * feature id would be a category error (and would need a fifteenth tab, a
   * probe and a driver to satisfy tests/features.test.ts). Both are digests of
   * the pure results in shared/strategy/{needs,arbiter}.ts. */
  needs?: NeedDigest[];
  plan?: ProgressionPlan;
}

/* `arbitration` and `ramArena` used to live on `Progression` above. They were
 * moved out because a state record is whole-topic last-write-wins, so touching
 * either one republished ALL of it: measured on a live run, `progression` was
 * 50% of a 2.58 GB log, sent every 200 ms, while the 13.8 KB of
 * plan/needs/multipliers/moneySources it dragged along changed on 12 of 1259
 * consecutive pairs. Splitting them lets each publish at the rate it actually
 * moves — and lets the hub collapse the slow one into spans. */

/** The arbiter's per-pass verdict: who was funded, who was refused, what is
 * left. Moves on nearly every tick, because the money it divides does. */
export interface ArbitrationTopic extends ArbitrationDigest {}

/** Change-filtered digest of the RAM the farm may not have: home's standing
 * reserve, the bootstrap host, and each ns resident's own block
 * (shared/ram/broker.ts). `guaranteedDynamicGb` is the largest single ns call
 * the arena can currently serve. */
export interface RamArenaDigest {
  hosts: string[];
  arenaGb: number;
  targetGb: number;
  guaranteedDynamicGb: number;
  farmCostPerSec: number;
}

/** One posted need, flattened for the wire. `progress` is precomputed because
 * the UI sorts on it and the direction rule (karma counts DOWN) lives in
 * shared/strategy/needs.ts, not in the renderer. */
export interface NeedDigest {
  by: FeatureId;
  kind: NeedKind;
  subject?: string;
  target: number;
  have: number;
  progress: number;
  weight: number;
  /** Measured BN-seconds satisfying the need saves, when the poster priced it. */
  valueSec?: number;
  urgency: NeedUrgency;
  satisfied: boolean;
}

export interface GrantDigest {
  by: FeatureId;
  id: string;
  resource: ResourceId;
  amount: number;
  mode: "spend" | "reserve";
  partial: boolean;
  /** Original bid evidence. Optional for backwards-compatible replays. */
  wanted?: number;
  priority?: number;
  ratePerSec?: number;
  returnPerDollarSec?: number;
  /** BN-seconds saved by the next unit at the resolved allocation. */
  marginalValue?: number;
}

export interface DenialDigest {
  by: FeatureId;
  id: string;
  resource: ResourceId;
  wanted: number;
  available: number;
  reason: DenyReason;
  priority?: number;
  ratePerSec?: number;
  returnPerDollarSec?: number;
}

export interface ArbitrationDigest {
  grants: GrantDigest[];
  denied: DenialDigest[];
  /** Marginal threshold per independently resolved hard-priority band. */
  waterlines?: {
    resource: "money";
    priority: number;
    lambda: number;
    claimCount: number;
    pricedClaimCount: number;
  }[];
  stepLoop?: { iterations: number; cap: number; capHit: boolean };
  warnings?: string[];
  /** Who holds Player.currentWork, and for how long. */
  slot?: { by: FeatureId; id: string; priority: number; heldMs: number };
  /** Every bid for the work slot and what it was worth, best first — the
   *  alternatives, kept so a choice can be argued with. `valueSec` is BN-seconds
   *  saved; a hard bid is a lock or a mandatory action and carries none. */
  slotValues?: {
    by: FeatureId;
    id: string;
    pricing: "hard" | "economic";
    priority: number;
    valueSec?: number;
    moneyPerSec?: number;
    /** Per-channel breakdown: our rate, the best anyone announced, the worth. */
    channels?: { channel: string; ourRate: number; bestRate?: number; worthSec: number; valueSec: number }[];
  }[];
  preempted?: { by: FeatureId; id: string; heldMs: number };
  remaining: { money: number };
}

export interface ProgressionPlan {
  phase: "start" | "finishUp" | "ending";
  /** The node is about to end by DESTROY with no install planned first.
   * Opposite money policy to an imminent install: augs, favor and cash all
   * die with the node, so install-shaped reserves (aug-fund, donations)
   * release and speedup spending is the only remaining use of money. */
  endingByDestroy?: boolean;
  /** Economic reset decision before safety barriers. */
  installWanted: boolean;
  /** Whether stock should liquidate, including an empty-queue first-purchase
   * bootstrap that is not itself permission to install. */
  liquidationWanted: boolean;
  /** Why the reset cannot execute yet. */
  installBlockers: InstallBlockerKind[];
  /** Every reset-sensitive subsystem has acknowledged readiness. */
  installReady: boolean;
  /** Route mechanics require the current final sweep/reset. This is broader
   * than a queued route reward: Daedalus also needs the count-finishing batch
   * installed before its invitation can exist. */
  routeInstallRequired?: boolean;
  /** First safe pass has been published; execution occurs on the next pass. */
  installArmedAt?: number;
  /** Exact queue the armed transaction revalidates before executing. */
  queuedAugmentations: string[];
  /** Rep-met, jointly affordable one-shot names whose value armed an optional
   * install. Factions freezes these into the final sweep so execution cannot
   * substitute a smaller, differently weighted set. NeuroFlux is omitted: the
   * sweep prices its repeatable ladder separately. */
  installFundedAugmentations?: string[];
  install: boolean;
  /** Factions that would cross the donation threshold on install — the
   *  strongest single argument for resetting now. */
  favorCrossings: { faction: string; favorNow: number; favorAfter: number }[];
  /** The install-vs-push cadence verdict: value accrues while pushing but
   *  only activates at an install, so install when the accrued value clears
   *  the renewal threshold sqrt(2·overhead·pushRate). `effective` folds in
   *  the driver's hysteresis/latch; "legacy" means no route ETA existed and
   *  the cash-ratio phase gate decided. */
  /** How fast the run is accelerating, and what a prestige costs to replay.
   *
   * A DIGEST of the cycle curve, not the curve: the samples stay in
   * progression's memory and only the fitted exponents cross the wire.
   * `factions` converts reputation and money gaps to seconds through these, so
   * a deep breakpoint is priced at the rate it will actually be earned at
   * rather than at today's — see `shared/strategy/factions/pace.ts`. */
  pace?: {
    elapsedSec: number;
    /** Bounded exponent of cumulative progress. 1 is a stationary rate. */
    money?: number;
    hacking?: number;
    combat?: number;
    /** Measured seconds a prestige spends replaying what the reset erased. */
    resetOverheadSec: number;
  };
  installDecision?: {
    verdict: "push" | "install" | "no-data";
    effective: "push" | "install" | "legacy";
    pushRate?: number;
    /** The cadence threshold resetValueMult must clear to flip to install. */
    threshold?: number;
    resetValueMult: number;
    /** Portion of the reset value from banked-but-unrealized favor. */
    resetFavorValue?: number;
    pushEtaSec?: number;
    remainingSec?: number;
    latched: boolean;
  };
  /** Terminal action once the selected route is mechanically complete. */
  completion?: {
    ready: boolean;
    automatic: boolean;
    nextBitNode: number;
    targetLevel: number;
    armedAt?: number;
    /** Deliberate policy hold before the irreversible destroy call. */
    stalled?: boolean;
    execute: boolean;
  };
  /** Immediate, reversible route bootstrap owned by progression because it is
   * selected by the high-level route rather than by a feature-local optimum. */
  routeAction?:
    | { type: "joinBladeburner" }
    | { type: "createGang"; faction: string };
  /** The chosen way to finish this BitNode, with the estimate it was chosen
   *  on. Everything below is the decision record the calibration loop reads
   *  back out of runs/*.jsonl: which route, guessed for how long, decided
   *  when — matched at the node reset against what actually happened. */
  route?: RouteId;
  /** When the current route was chosen (survives refreshes that keep it). */
  decidedAt?: number;
  /** Every route's estimate with its per-part breakdown, so a wrong total can
   *  be attributed to the specific sub-heuristic that produced it. */
  routes?: RouteEtaDigest[];
  /** Independently anchored forecasts for the next destructive install and
   * the end of the BitNode. Neither is capped or silently defaulted. */
  forecasts: PlanningHorizons;
  /** Local BN-time sensitivity of the current plan to productive rates. */
  marginals?: ProgressionMarginals;
}

export interface RouteEtaDigest {
  id: RouteId;
  available: boolean;
  /** False means game mechanics permit it, but this controller cannot safely
   * execute it yet; it remains visible but is excluded from route choice. */
  actionable?: boolean;
  complete: boolean;
  /** The single next thing this route is waiting on (from stepEndgame). */
  blocker: string;
  etaSec: number;
  /** `measured: false` marks a fallback constant rather than an observed
   *  rate — the calibration loop treats the two kinds of error differently. */
  parts: { what: string; resource: string; sec: number; measured: boolean }[];
  stage?: string;
  needs?: RouteNeed[];
  nextMandatoryInstall?: { sec: number; measured: boolean };
  optionalInstall?: boolean;
}
