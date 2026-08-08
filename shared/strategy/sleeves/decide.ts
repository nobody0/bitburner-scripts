import { assignIndependent, type AssignmentResult } from "../assignment.ts";
import type { NeedBoard, NeedKind } from "../needs.ts";
import { needKey } from "../needs.ts";

/** Sleeve allocation.
 *
 * Sleeves are the CLEANEST consumer of the needs board: they satisfy other
 * features' outcomes in PARALLEL with the player, so a karma need that would
 * otherwise monopolise `Player.currentWork` can be handed to a sleeve instead
 * while the player does something else entirely.
 *
 * Shock and sync make early recovery dominate, and that is not a heuristic:
 * shock MULTIPLIES down everything a sleeve earns, so a sleeve at 90 shock is
 * contributing almost nothing and recovering it is worth more than any task
 * it could be doing. */

export interface SleeveState {
  index: number;
  /** 0-100. Multiplies DOWN everything the sleeve produces. */
  shock: number;
  /** 1-100. Scales what the sleeve shares back to the player. */
  sync: number;
  city: string;
  skills: Record<string, number>;
  task?: { type: string; detail?: string };
}

export interface SleeveTask {
  type: "recovery" | "synchro" | "crime" | "class" | "gym" | "faction" | "company" | "bladeburner";
  detail?: string;
  /** Outcome rates this task delivers, per second, before shock scaling. */
  rates: Partial<Record<NeedKind, number>>;
  /** Money per second, for the income fallback. */
  moneyPerSec: number;
}

export interface SleevesView {
  sleeves: SleeveState[];
  tasks: SleeveTask[];
  /** Shock above this is worth recovering before doing anything else. */
  shockCeiling: number;
  /** Sync below this is worth synchronising. */
  syncFloor: number;
}

export interface SleeveDecision {
  assignments: { index: number; task: SleeveTask; why: string }[];
  assignment: AssignmentResult<SleeveState, SleeveTask>;
  why: string;
}

/** Above this shock, everything the sleeve does is scaled down enough that
 * recovery pays for itself almost immediately. */
export const DEFAULT_SHOCK_CEILING = 50;
/** Below this sync, the player receives little of what the sleeve earns. */
export const DEFAULT_SYNC_FLOOR = 50;

/** Shock scales output DOWN linearly: a sleeve at 90 shock produces 10%. */
export function shockMultiplier(shock: number): number {
  return Math.max(0, 1 - shock / 100);
}

export function stepSleeves(view: SleevesView, board: NeedBoard): SleeveDecision {
  const weights = new Map<string, { weight: number; remaining: number }>();
  for (const need of board.open) {
    const key = needKey(need);
    const remaining = Math.max(1e-9, Math.abs(need.target - need.have));
    const existing = weights.get(key);
    if (existing) {
      existing.weight += need.weight;
      existing.remaining = Math.min(existing.remaining, remaining);
    } else {
      weights.set(key, { weight: need.weight, remaining });
    }
  }

  const score = (sleeve: SleeveState, task: SleeveTask): number => {
    // Recovery and synchronisation are not scored against needs — they are
    // INVESTMENTS in the sleeve's own throughput, and their value is exactly
    // how much they unlock.
    if (task.type === "recovery") {
      return sleeve.shock > view.shockCeiling ? 1e6 + sleeve.shock : -1;
    }
    if (task.type === "synchro") {
      return sleeve.sync < view.syncFloor ? 1e5 + (view.syncFloor - sleeve.sync) : -1;
    }
    const scale = shockMultiplier(sleeve.shock);
    let value = 0;
    for (const [kind, rate] of Object.entries(task.rates) as [NeedKind, number][]) {
      const entry = weights.get(needKey({ kind }));
      if (!entry || rate <= 0) continue;
      value += ((rate * scale) / entry.remaining) * entry.weight;
    }
    // Income is the fallback objective, scaled far below need-serving so a
    // posted need always wins.
    return value > 0 ? value : task.moneyPerSec * scale * 1e-9;
  };

  // INDEPENDENT: sleeves do not interfere with each other — two sleeves can
  // commit the same crime simultaneously — so per-sleeve argmax is exact.
  const assignment = assignIndependent(view.sleeves, view.tasks, score, (task) => `${task.type}:${task.detail ?? ""}`);

  const assignments = assignment.choices
    .filter((choice) => choice.task.type !== choice.agent.task?.type || choice.task.detail !== choice.agent.task?.detail)
    .map((choice) => ({
      index: choice.agent.index,
      task: choice.task,
      why:
        choice.task.type === "recovery"
          ? `shock ${Math.round(choice.agent.shock)} scales output to ${(shockMultiplier(choice.agent.shock) * 100).toFixed(0)}%`
          : choice.task.type === "synchro"
            ? `sync ${Math.round(choice.agent.sync)} is below the ${view.syncFloor} floor`
            : `best weighted need progress (${choice.score.toExponential(2)})`,
    }));

  return {
    assignments,
    assignment,
    why: `exact per-sleeve argmax over ${view.tasks.length} tasks for ${view.sleeves.length} sleeves`,
  };
}
