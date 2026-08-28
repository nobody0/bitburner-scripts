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
 * Shock and sync make early recovery dominate. Shock multiplies experience and
 * faction reputation down, while crime money, karma, and kills are separate.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveCrimeWork.ts#L31-L50
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveFactionWork.ts#L30-L48 */

export interface SleeveState {
  index: number;
  /** 0-100. Reduces work stats and faction reputation, but not money,
   * crime karma, or kills. */
  shock: number;
  /** 1-100. Scales experience shared to the player and crime karma. */
  sync: number;
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
}

export interface SleeveTask {
  type: "recovery" | "synchro" | "crime" | "faction";
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
function assignSleeves(
  agents: readonly SleeveState[],
  tasks: readonly SleeveTask[],
  score: (agent: SleeveState, task: SleeveTask) => number,
  eligible: (agent: SleeveState, task: SleeveTask) => boolean,
): AssignmentResult<SleeveState, SleeveTask> {
  const exclusive = [...new Set(tasks.flatMap((task) => task.exclusiveKey ? [task.exclusiveKey] : []))].sort();
  const bitFor = new Map(exclusive.map((key, index) => [key, 1n << BigInt(index)]));
  interface Candidate {
    total: number;
    assigned: number;
    taskIndexes: (number | undefined)[];
    signature: string;
  }
  const memo = new Map<string, Candidate>();
  const better = (candidate: Candidate, best: Candidate): boolean =>
    candidate.total > best.total
    || (candidate.total === best.total && candidate.assigned < best.assigned)
    || (candidate.total === best.total && candidate.assigned === best.assigned && candidate.signature < best.signature);
  const visit = (agentIndex: number, used: bigint): Candidate => {
    if (agentIndex >= agents.length) return { total: 0, assigned: 0, taskIndexes: [], signature: "" };
    const key = `${agentIndex}:${used}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const skipped = visit(agentIndex + 1, used);
    let best: Candidate = {
      total: skipped.total,
      assigned: skipped.assigned,
      taskIndexes: [undefined, ...skipped.taskIndexes],
      signature: `|${skipped.signature}`,
    };
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex]!;
      if (!eligible(agents[agentIndex]!, task)) continue;
      const bit = task.exclusiveKey ? bitFor.get(task.exclusiveKey)! : 0n;
      if ((used & bit) !== 0n) continue;
      const tail = visit(agentIndex + 1, used | bit);
      const label = `${task.type}:${task.detail ?? ""}:${task.workType ?? ""}`;
      const candidate = {
        total: score(agents[agentIndex]!, task) + tail.total,
        assigned: tail.assigned + 1,
        taskIndexes: [taskIndex, ...tail.taskIndexes],
        signature: `${label}|${tail.signature}`,
      };
      if (better(candidate, best)) best = candidate;
    }
    memo.set(key, best);
    return best;
  };
  const best = visit(0, 0n);
  return {
    choices: best.taskIndexes.flatMap((taskIndex, index) => taskIndex === undefined ? [] : [{
      agent: agents[index]!,
      task: tasks[taskIndex]!,
      score: score(agents[index]!, tasks[taskIndex]!),
    }]),
    total: best.total,
    approximated: false,
  };
}

export function stepSleeves(view: SleevesView, board: NeedBoard): SleeveDecision {
  const weights = new Map<string, number>();
  for (const need of board.open) {
    const key = needKey(need);
    const remaining = Math.max(1e-9, Math.abs(need.target - need.have));
    weights.set(key, (weights.get(key) ?? 0) + need.weight / remaining);
  }

  const matchesCurrent = (sleeve: SleeveState, task: SleeveTask): boolean =>
    task.type === sleeve.task?.type.toLowerCase()
    && task.detail === sleeve.task?.detail
    && task.workType === sleeve.task?.workType;

  const eligible = (sleeve: SleeveState, task: SleeveTask): boolean => {
    if (sleeve.task?.type.toUpperCase() === "CRIME" && sleeve.allowCrimeSwitch !== true) {
      return matchesCurrent(sleeve, task);
    }
    if (sleeve.shock > view.shockCeiling) return task.type === "recovery";
    if (sleeve.sync < view.syncFloor) return task.type === "synchro";
    return task.type !== "recovery" && task.type !== "synchro";
  };

  const score = (sleeve: SleeveState, task: SleeveTask): number => {
    // Recovery and synchronisation are not scored against needs. Eligibility
    // makes those policy choices mandatory; the positive sentinel merely
    // selects them without pretending it is an outcome rate.
    if (task.type === "recovery" || task.type === "synchro") return 1;
    const scale = shockMultiplier(sleeve.shock);
    const outcome = task.outcomes.find((entry) => entry.sleeve === sleeve.index)
      ?? task.outcomes.find((entry) => entry.sleeve === undefined);
    if (!outcome) return -1;
    let value = 0;
    for (const [kind, rate] of Object.entries(outcome.rates) as [NeedKind, number][]) {
      const weight = weights.get(needKey({ kind }));
      if (!weight || rate <= 0) continue;
      value += rate * scale * weight;
    }
    for (const contribution of outcome.contributions ?? []) {
      const weight = weights.get(needKey(contribution));
      if (!weight || contribution.perSec <= 0) continue;
      value += contribution.perSec * scale * weight;
    }
    for (const [kind, rate] of Object.entries(outcome.shockExemptRates ?? {}) as [NeedKind, number][]) {
      const weight = weights.get(needKey({ kind }));
      if (!weight || rate <= 0) continue;
      value += rate * weight;
    }
    // scaleWorkStats(..., false) leaves sleeve money unshocked.
    return value > 0 ? value : (outcome.shockExemptRates?.money ?? 0) * 1e-9;
  };

  // Crime repeats freely; faction work has capacity one per faction.
  const assignment = assignSleeves(view.sleeves, view.tasks, score, eligible);

  const assignments = assignment.choices
    .filter((choice) =>
      choice.task.type !== choice.agent.task?.type.toLowerCase()
      || choice.task.detail !== choice.agent.task?.detail
      || choice.task.workType !== choice.agent.task?.workType)
    .map((choice) => ({
      index: choice.agent.index,
      task: choice.task,
    }));

  return {
    assignments,
    assignment,
  };
}
