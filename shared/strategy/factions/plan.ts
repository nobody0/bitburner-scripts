import type { FeatureId } from "../../features/ids.ts";
import type { Blocker } from "./requirements.ts";
import type { WorkType } from "./rep.ts";

/** The vocabulary of a faction decision: what we are trying to do, what we do
 * next, what else we considered, and what would make us reconsider. */

export interface FactionObjective {
  /** Factions committed to, best first. */
  factions: string[];
  /** Augmentations the objective is aiming at, in purchase order. */
  augmentations: string[];
  /** Total value in the scoring units (Σ w·ln(mult)). */
  value: number;
  /** Factions foreclosed for this install cycle, and by which membership. */
  foreclosed: { name: string; bannedBy: string }[];
  /** The one package being pursued now. The compatible faction set is not an
   * actionable intent; this is what other features should prepare. */
  intent?: FactionIntent;
  /** Intent absent ONLY because the planning horizon filtered every raw
   * candidate — a transient forecast state, not a concluded frontier. The
   * install verdict must not treat it as "nothing left to push for".
   *
   * Specifically: every candidate was DROPPED as noise (beyond twice the
   * horizon). A merely discounted package is still selectable, so it is not
   * starvation and does not set this. */
  horizonStarved?: boolean;
  /** Best alternative package at the same decision point. Its marginal rate
   * is the opportunity cost that stops us pushing `intent` indefinitely. */
  runnerUp?: FactionIntent;
}

export interface FactionIntent {
  faction: string;
  repTarget: number;
  augmentations: string[];
  /** Goal units gained by the whole package (count first, quality second). */
  value: number;
  etaSec: number;
  /** Average value/time for entering and completing this package. */
  rate: number;
  /** Value/time of the last extension included in this package. */
  marginalRate: number;
  /** Reset-activated value excludes permanent route counters and one-off
   * ranking bonuses. This is the like-for-like stream used by install cadence. */
  activationValue?: number;
  /** Marginal activationValue/time for the last package extension. */
  marginalActivationRate?: number;
  /** ETA decomposition. Unlock/player work is sequential; money production
   * overlaps it, so `etaSec` is not the sum of all three. */
  unlockSec: number;
  repSec: number;
  moneySec: number;
  favorAfterInstall: number;
  /** Donation plus escalated augmentation purchases. */
  totalCost: number;
  /** Escalated cash needed for the augmentation package itself. */
  purchaseCost: number;
  /** Exact reputation donation chosen by the ETA model, zero when working is
   * faster. Kept separate so the arbiter can reserve both obligations. */
  donationCost: number;
  purpose: "augmentations" | "favor";
}

export type FactionAction =
  | { type: "idle"; reason: "blocked" | "waiting" | "continue" | "slot" }
  | { type: "joinFaction"; faction: string }
  | { type: "workForFaction"; faction: string; workType: WorkType; focus: boolean }
  | { type: "stopWork" }
  | { type: "donate"; faction: string; amount: number; purchaseCost?: number }
  | { type: "purchaseAugmentation"; faction: string; augmentation: string }
  | { type: "graft"; augmentation: string }
  | { type: "travelTo"; city: string }
  /** In the union so the sim and driver can execute it, but `decide` NEVER
   *  selects it: spec/features.md gives the reset cadence to `progression`,
   *  and factions emits `recommendInstall` instead. */
  | { type: "installAugmentations" };

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
  /** What the work slot would EARN if this feature had it, and where.
   *  Published even when the action is idle: the arbiter needs to know what the
   *  claim produces to price it, and "another feature holds the slot" is
   *  exactly the state in which that price has to be argued.
   *
   *  `produces` is every channel, not just reputation — field and security work
   *  pay combat and charisma experience too, and a combat gate served by the
   *  same second that earns reputation is the whole reason to know. */
  workRate?: { faction: string; repPerSec: number; produces: Record<string, number> };
  invalidation: InvalidationKey[];
  /** Set when the run should end: nothing further is buyable and banked
   *  reputation is worth more as favor than as more of this run. */
  recommendInstall?: { augmentations: string[] };
  /** The final sweep cannot make its first purchase from cash alone, but the
   *  stock book can close the gap. Published separately from recommendInstall
   *  so progression may ask stock to liquidate without treating an empty
   *  augmentation queue as installable. */
  liquidationNeeded?: {
    augmentation: string;
    price: number;
    cash: number;
    pendingProceeds: number;
  };
  /** The next augmentation this plan intends to buy, priced at ITS SLOT in the
   *  purchase order rather than at today's queue depth. Published so the driver has
   *  something to claim money against: the purchase needs a grant, the grant needs
   *  a claim, and a claim read off the already-funded decision could never
   *  bootstrap. Absent when nothing is buyable. */
  nextBuy?: { name: string; price: number };
  /** The drain's frozen budget, when a drain is running — published so the
   *  install barrier (`purchasableAugmentation`) tests the same money the drain
   *  itself is willing to spend. Without it the two predicates diverge on a
   *  fast farm: the barrier sees the next NeuroFlux affordable out of fresh
   *  income the drain has already declined to spend. */
  drainCeiling?: number;
  /** Set when the feature genuinely cannot act — reported, never spun on. */
  blocked?: true;
}

/** Memory carried between ticks. Pure data, owned by the driver. */
export interface FactionMemory {
  /** The committed objective, so it does not thrash between equal options. */
  objective?: FactionObjective;
  /** One-shot augmentations whose reputation breakpoint was completed during
   * this install cycle. They remain physically unowned until the end-loaded
   * transaction, but package selection treats them as committed so their
   * zero-second frontier cannot win again and strand the work loop idle. */
  bankedAugmentations: string[];
  /** Measured rep/sec per faction (EWMA). Reality beats the formula when a
   *  share bonus or an unnoticed unfocus disagrees with it. */
  measuredRepPerSec: Record<string, number>;
  /** Last observed reputation per faction, to difference against. */
  lastRep: Record<string, number>;
  lastRepAt: number;
  /** When the current focus faction was chosen. */
  focusSince: number;
  focusFaction?: string;
  /** The action issued last tick, for the continuation guard. */
  lastAction?: FactionAction;
  /** Invalidation keys as of the last decision. */
  lastInvalidation: InvalidationKey[];
  /** Which intent the stall tracker is watching, the best rep seen for it,
   * and when that rep last MOVED. The committed-objective latch exists so
   * near-equal packages do not thrash — but a latch with no progress escape
   * held an unservable objective for a full two-hour run (Blade Industries,
   * whose employment blocker nothing could deliver) while a one-step faction
   * sat ignored. No progress for INTENT_STALL_MS + a frontier that prefers a
   * different package = drop the latch. */
  intentKey?: string;
  intentRepSeen?: number;
  intentProgressAt?: number;
  /** Cash on hand when the final-sweep drain began. The drain spends DOWN from
   * this frozen snapshot: income earned while draining never funds further
   * NeuroFlux escalation, because a fast farm otherwise turns the drain into a
   * race between income and the 1.9x price ladder and the install only lands
   * when the race is momentarily lost. Money made during the drain compounds
   * better in the next run. Cleared on any decision that is not a recommending
   * drain. */
  drainCeiling?: number;
  /** Frozen payment order for the end-loaded transaction. Replanning
   * this set after its first purchase would apply the new 1.9x queue depth to
   * a different set than the one whose affordability was proved. Repeated
   * NeuroFlux names are finite, pre-funded levels interleaved at their
   * price-minimising positions. */
  drainOrder?: string[];
  /** NFG level when drainOrder was frozen, used to consume repeated NFG
   * entries only after the game confirms each purchase. */
  drainStartNeurofluxLevel?: number;
}

export function initFactionMemory(): FactionMemory {
  return {
    bankedAugmentations: [],
    measuredRepPerSec: {},
    lastRep: {},
    lastRepAt: 0,
    focusSince: 0,
    lastInvalidation: [],
  };
}

/** Hysteresis constants, named so a change is a deliberate act.
 *
 * Both exist for the same reason and it is not aesthetics: switching
 * faction work CANCELS the current activity outright
 * (`workForFaction` does not queue), so a planner that re-decided freely would
 * oscillate between two near-equal options and complete neither.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObjectWorkMethods.ts#L5-L22 */
export const FOCUS_DWELL_MS = 60_000;
export const WORK_SWITCH_MARGIN = 1.05;
/** How long a latched objective may make ZERO reputation progress before the
 * frontier is allowed to replace it with a different package. */
export const INTENT_STALL_MS = 600_000;
/** Minimum remaining NODE time for a NeuroFlux level to be worth draining
 * into. Each level is ~+1% across the board, so it repays roughly 1% of the
 * remainder; below this there is nothing left to accelerate and the drain
 * only delays the node's end.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/Augmentations.ts#L1159-L1209 */
export const NFG_MIN_PAYBACK_SEC = 600;

/** EWMA weight for the measured rep rate. */
export const RATE_SMOOTHING = 0.3;
