import type { FeatureId } from "../../features/ids.ts";
import type { Blocker } from "./requirements.ts";
import type { WorkType } from "./rep.ts";

/** The vocabulary of a faction decision: what we are trying to do, what we do
 * next, and — the part that makes it reviewable — why, what else we considered,
 * and what would make us reconsider. */

export interface FactionObjective {
  /** Factions committed to, best first. */
  factions: string[];
  /** Augmentations the objective is aiming at, in purchase order. */
  augmentations: string[];
  /** Total value in the scoring units (Σ w·ln(mult)). */
  value: number;
  /** Factions permanently foreclosed by this choice, and by which. */
  foreclosed: { name: string; bannedBy: string }[];
  why: string;
}

export type FactionAction =
  | { type: "idle"; reason: "blocked" | "waiting" | "continue"; why: string }
  | { type: "joinFaction"; faction: string; why: string }
  | { type: "workForFaction"; faction: string; workType: WorkType; focus: boolean; why: string }
  | { type: "stopWork"; why: string }
  | { type: "donate"; faction: string; amount: number; why: string }
  | { type: "purchaseAugmentation"; faction: string; augmentation: string; why: string }
  | { type: "graft"; augmentation: string; why: string }
  | { type: "travelTo"; city: string; why: string }
  /** In the union so the sim and driver can execute it, but `decide` NEVER
   *  selects it: spec/features.md gives the reset cadence to `progression`,
   *  and factions emits `recommendInstall` instead. */
  | { type: "installAugmentations"; why: string };

/** A condition that, when it changes, invalidates the current plan. Compared
 * shallowly against the previous tick's values. */
export interface InvalidationKey {
  /** Human label, for the UI. */
  label: string;
  value: string | number | boolean;
}

/** When the current long-running action is expected to finish. */
export interface Until {
  kind: "rep" | "money" | "time" | "never";
  faction?: string;
  target: number;
  have: number;
  etaSec: number;
}

export interface ScoredAlternative {
  label: string;
  value: number;
  why: string;
}

export interface FactionDecision {
  objective: FactionObjective | undefined;
  action: FactionAction;
  /** The scored runners-up, so a decision can be argued with. */
  alternatives: ScoredAlternative[];
  /** Everything standing between us and the objective, with its owner. */
  blockers: (Blocker & { faction: string })[];
  /** Outcomes to post on the needs board. Derived from `blockers`. */
  needOwners: FeatureId[];
  until?: Until;
  invalidation: InvalidationKey[];
  /** Set when the run should end: nothing further is buyable and banked
   *  reputation is worth more as favor than as more of this run. */
  recommendInstall?: { why: string; augmentations: string[] };
  /** Set when the feature genuinely cannot act — reported, never spun on. */
  blocked?: { why: string };
}

/** Memory carried between ticks. Pure data, owned by the driver. */
export interface FactionMemory {
  /** The committed objective, so it does not thrash between equal options. */
  objective?: FactionObjective;
  /** Measured rep/sec per faction (EWMA). Reality beats the formula when a
   *  share bonus or an unnoticed unfocus disagrees with it. */
  measuredRepPerSec: Record<string, number>;
  /** Last observed reputation per faction, to difference against. */
  lastRep: Record<string, number>;
  lastRepAt: number;
  /** When the current focus faction was chosen. */
  focusSince: number;
  focusFaction?: string;
  /** How far through `purchaseOrder` we are. */
  purchaseCursor: number;
  /** The action issued last tick, for the continuation guard. */
  lastAction?: FactionAction;
  /** Invalidation keys as of the last decision. */
  lastInvalidation: InvalidationKey[];
  /** Do not reconsider before this timestamp (used after a skip). */
  reconsiderAt: number;
}

export function initFactionMemory(): FactionMemory {
  return {
    measuredRepPerSec: {},
    lastRep: {},
    lastRepAt: 0,
    focusSince: 0,
    purchaseCursor: 0,
    lastInvalidation: [],
    reconsiderAt: 0,
  };
}

/** Hysteresis constants, named so a change is a deliberate act.
 *
 * All three exist for the same reason and it is not aesthetics: switching
 * faction work CANCELS the current activity outright
 * (`workForFaction` does not queue), so a planner that re-decided freely would
 * oscillate between two near-equal options and complete neither. */
export const SWITCH_MARGIN = 1.1;
export const FOCUS_DWELL_MS = 60_000;
export const WORK_SWITCH_MARGIN = 1.05;

/** EWMA weight for the measured rep rate. */
export const RATE_SMOOTHING = 0.3;
