import type { AssignmentResult } from "../assignment.ts";
import type { NeedBoard, NeedKind } from "../needs.ts";
import { needKey } from "../needs.ts";

/** Sleeve allocation.
 *
 * Sleeves are the CLEANEST consumer of the needs board: they satisfy other
 * features' outcomes in PARALLEL with the player, so a karma need that would
 * otherwise monopolise `Player.currentWork` can be handed to a sleeve instead
 * while the player does something else entirely.
 *
 * Shock and sync make early recovery dominate. Shock multiplies WorkStats and
 * faction reputation down, while crime karma/kills are applied separately.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveCrimeWork.ts#L31-L50
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveFactionWork.ts#L30-L48 */

export interface SleeveState {
  index: number;
  /** 0-100. Multiplies DOWN everything the sleeve produces. */
  shock: number;
  /** 1-100. Scales what the sleeve shares back to the player. */
  sync: number;
  city: string;
  skills: Record<string, number>;
  task?: { type: string; detail?: string; workType?: string };
  /** A running crime may only be replaced when its nextCompletion resolves. */
  /** Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveCrimeWork.ts */
  allowCrimeSwitch?: boolean;
}

export interface SleeveOutcome {
  /** Omit for an outcome shared by every sleeve; otherwise identifies the
   * sleeve whose stats were used to price it. */
  sleeve?: number;
  /** Outcome rates per second, before shock scaling. */
  rates: Partial<Record<NeedKind, number>>;
  /** Rates Bitburner does not reduce by sleeve shock. */
  shockExemptRates?: Partial<Record<NeedKind, number>>;
  /** Subject-aware rates such as `skill:hacking`. */
  contributions?: { kind: NeedKind; subject?: string; perSec: number }[];
  moneyPerSec: number;
}

export interface SleeveTask {
  type: "recovery" | "synchro" | "crime" | "class" | "gym" | "faction" | "company" | "bladeburner";
  detail?: string;
  /** Faction work subtype. */
  workType?: string;
  /** Tasks with the same key may be assigned to at most one sleeve. */
  exclusiveKey?: string;
  /** One normalized result shape replaces parallel generic/per-sleeve maps. */
  outcomes: SleeveOutcome[];
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
  assignments: { index: number; task: SleeveTask }[];
  assignment: AssignmentResult<SleeveState, SleeveTask>;
}

/** Shock scales WorkStats output down linearly: 90 shock leaves 10%.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Sleeve.ts#L173-L179 */
export function shockMultiplier(shock: number): number {
  return Math.max(0, 1 - shock / 100);
}

/** Exact dynamic program for repeatable tasks plus a small set of capacity-one
 * tasks (notably faction work: Bitburner permits only one sleeve per faction).
 * Complexity is O(sleeves * tasks * 2^exclusiveKeys), not tasks^sleeves. */
// Capacity-one faction assignment mirrors the public API's one-sleeve-per-faction rule.
// Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Sleeve.ts
function assignSleeves(
  agents: readonly SleeveState[],
  tasks: readonly SleeveTask[],
  score: (agent: SleeveState, task: SleeveTask) => number,
): AssignmentResult<SleeveState, SleeveTask> {
  const exclusive = [...new Set(tasks.flatMap((task) => task.exclusiveKey ? [task.exclusiveKey] : []))].sort();
  const bitFor = new Map(exclusive.map((key, index) => [key, 1n << BigInt(index)]));
  const memo = new Map<string, { total: number; taskIndexes: number[]; signature: string }>();
  const visit = (agentIndex: number, used: bigint): { total: number; taskIndexes: number[]; signature: string } => {
    if (agentIndex >= agents.length) return { total: 0, taskIndexes: [], signature: "" };
    const key = `${agentIndex}:${used}`;
    const cached = memo.get(key);
    if (cached) return cached;
    let best: { total: number; taskIndexes: number[]; signature: string } | undefined;
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex]!;
      const bit = task.exclusiveKey ? bitFor.get(task.exclusiveKey)! : 0n;
      if ((used & bit) !== 0n) continue;
      const tail = visit(agentIndex + 1, used | bit);
      const label = `${task.type}:${task.detail ?? ""}:${task.workType ?? ""}`;
      const candidate = {
        total: score(agents[agentIndex]!, task) + tail.total,
        taskIndexes: [taskIndex, ...tail.taskIndexes],
        signature: `${label}|${tail.signature}`,
      };
      if (!best || candidate.total > best.total || (candidate.total === best.total && candidate.signature < best.signature)) best = candidate;
    }
    const answer = best ?? { total: 0, taskIndexes: [], signature: "" };
    memo.set(key, answer);
    return answer;
  };
  const best = visit(0, 0n);
  return {
    choices: best.taskIndexes.map((taskIndex, index) => ({
      agent: agents[index]!,
      task: tasks[taskIndex]!,
      score: score(agents[index]!, tasks[taskIndex]!),
    })),
    total: best.total,
    approximated: false,
  };
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
    const outcome = task.outcomes.find((entry) => entry.sleeve === sleeve.index)
      ?? task.outcomes.find((entry) => entry.sleeve === undefined);
    if (!outcome) return -1;
    let value = 0;
    for (const [kind, rate] of Object.entries(outcome.rates) as [NeedKind, number][]) {
      const entry = weights.get(needKey({ kind }));
      if (!entry || rate <= 0) continue;
      value += ((rate * scale) / entry.remaining) * entry.weight;
    }
    for (const contribution of outcome.contributions ?? []) {
      const entry = weights.get(needKey(contribution));
      if (!entry || contribution.perSec <= 0) continue;
      value += ((contribution.perSec * scale) / entry.remaining) * entry.weight;
    }
    for (const [kind, rate] of Object.entries(outcome.shockExemptRates ?? {}) as [NeedKind, number][]) {
      const entry = weights.get(needKey({ kind }));
      if (!entry || rate <= 0) continue;
      value += (rate / entry.remaining) * entry.weight;
    }
    // Income is the fallback objective, scaled far below need-serving so a
    // posted need always wins.
    return value > 0 ? value : outcome.moneyPerSec * scale * 1e-9;
  };

  // Crimes/training repeat freely; faction work has capacity one per faction.
  const assignment = assignSleeves(view.sleeves, view.tasks, score);

  const assignments = assignment.choices
    .filter((choice) =>
      choice.task.type !== choice.agent.task?.type.toLowerCase()
      || choice.task.detail !== choice.agent.task?.detail
      || choice.task.workType !== choice.agent.task?.workType)
    .filter((choice) => choice.agent.task?.type.toUpperCase() !== "CRIME" || choice.agent.allowCrimeSwitch === true)
    .map((choice) => ({
      index: choice.agent.index,
      task: choice.task,
    }));

  return {
    assignments,
    assignment,
  };
}
