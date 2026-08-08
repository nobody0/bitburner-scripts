import type { MoneySource } from "@ns";
import type { FeatureId } from "../../features/ids.ts";
import type { DenyReason, ResourceId } from "../../strategy/arbiter.ts";
import type { NeedKind, NeedUrgency } from "../../strategy/needs.ts";

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
  /** SF number -> active level. Level n on SF k means BN k was completed n
   * times, so this doubles as "which BitNodes are done". */
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
  arbitration?: ArbitrationDigest;
  /** How much home RAM the dispatcher is being told to leave free, and why.
   *  `capped: true` is a real blocker — a feature's probe cannot be afforded
   *  on this home no matter how long we wait, and the answer is more home RAM
   *  (or a bigger rooted host to place the dodge on). */
  homeReserve?: { gb: number; capped: boolean; driver?: FeatureId; why: string };
  plan?: ProgressionPlan;
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
  urgency: NeedUrgency;
  satisfied: boolean;
  why: string;
}

export interface GrantDigest {
  by: FeatureId;
  id: string;
  resource: ResourceId;
  amount: number;
  mode: "spend" | "reserve";
  partial: boolean;
}

export interface DenialDigest {
  by: FeatureId;
  id: string;
  resource: ResourceId;
  wanted: number;
  available: number;
  reason: DenyReason;
  why: string;
}

export interface ArbitrationDigest {
  grants: GrantDigest[];
  denied: DenialDigest[];
  /** Who holds Player.currentWork, and for how long. */
  slot?: { by: FeatureId; id: string; priority: number; heldMs: number };
  preempted?: { by: FeatureId; id: string; heldMs: number };
  remaining: { money: number; ram: number };
}

export interface ProgressionPlan {
  phase: "start" | "finishUp" | "ending";
  install: boolean;
  homeRamBudgetFraction: number;
  /** Factions that would cross the donation threshold on install — the
   *  strongest single argument for resetting now. */
  favorCrossings: { faction: string; favorNow: number; favorAfter: number }[];
  why: string;
  /** The chosen way to finish this BitNode, with the estimate it was chosen
   *  on. Everything below is the decision record the calibration loop reads
   *  back out of runs/*.jsonl: which route, guessed for how long, decided
   *  when — matched at the node reset against what actually happened. */
  route?: "daedalus" | "labyrinth" | "bladeburner";
  /** Wall-clock timestamp the run is expected to end at, from the chosen
   *  route's estimate. Features derive their planning horizon from it. */
  expectedEndAt?: number;
  /** When the current route was chosen (survives refreshes that keep it). */
  decidedAt?: number;
  /** When the plan was last recomputed. The horizon's staleness guard reads
   *  this: a plan whose publisher has gone quiet must stop steering. */
  refreshedAt?: number;
  routeWhy?: string;
  /** Every route's estimate with its per-part breakdown, so a wrong total can
   *  be attributed to the specific sub-heuristic that produced it. */
  routes?: RouteEtaDigest[];
}

export interface RouteEtaDigest {
  id: "daedalus" | "labyrinth" | "bladeburner";
  available: boolean;
  complete: boolean;
  /** The single next thing this route is waiting on (from stepEndgame). */
  blocker: string;
  etaSec: number;
  /** `measured: false` marks a fallback constant rather than an observed
   *  rate — the calibration loop treats the two kinds of error differently. */
  parts: { what: string; sec: number; measured: boolean }[];
}
