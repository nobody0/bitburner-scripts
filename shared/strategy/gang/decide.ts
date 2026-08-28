import { assignCoupled, type AssignmentResult } from "../assignment.ts";

/** Gang management.
 *
 * Objective: grow respect, money and territory WITHOUT the wanted-level
 * penalty eating the gains. That penalty is the whole reason this is a coupled
 * assignment rather than "every member does the most profitable thing": wanted
 * level is a single gang-wide number, every member's task contributes to it,
 * and the resulting penalty multiplies EVERYONE's output. A member-by-member
 * argmax therefore optimises the wrong function. */

export interface GangMemberState {
  name: string;
  task: string;
  skills: { hack: number; str: number; def: number; dex: number; agi: number; cha: number };
  ascMults: { hack: number; str: number; def: number; dex: number; agi: number; cha: number };
  earnedRespect: number;
  upgrades: number;
}

export interface GangTaskOption {
  name: string;
  /** Per-member rates, as the game reports them for this member. */
  respectGain: number;
  moneyGain: number;
  wantedGain: number;
  /** True for training tasks, which produce nothing but raise stats. */
  training: boolean;
}

export interface GangView {
  faction: string;
  isHacking: boolean;
  respect: number;
  wantedLevel: number;
  /** `1 / (1 + wanted/respect)`-ish, as the game reports it. Multiplies output. */
  wantedPenalty: number;
  territory: number;
  territoryClashChance: number;
  territoryWarfareEngaged: boolean;
  members: GangMemberState[];
  /** Task options, already priced per member by the caller. */
  taskOptions: (member: GangMemberState) => GangTaskOption[];
  /** Members whose ascension multiplier gain clears the threshold. */
  ascensionGain: (member: GangMemberState) => number;
  respectForNextRecruit: number;
  canRecruit: boolean;
  /** Chance of winning a clash, per rival gang. */
  clashChances: Record<string, number>;
  /** How much the run values money against respect. Respect buys members and
   *  territory; money buys equipment. */
  weights: { respect: number; money: number };
}

export type GangAction =
  | { type: "recruit" }
  | { type: "assign"; member: string; task: string }
  | { type: "ascend"; member: string }
  | { type: "warfare"; engage: boolean }
  | { type: "idle" };

export interface GangDecision {
  actions: GangAction[];
  assignment: AssignmentResult<GangMemberState, GangTaskOption>;
  /** Whether the wanted penalty is currently costing more than the tasks earn. */
  wantedWarning?: string;
}

/** A deliberate policy threshold, not an upstream formula or crossover. */
export const ASCEND_THRESHOLD = 1.15;

/** Engage territory warfare only above this win chance. Any clash can kill a
 * warfare-assigned member, even on a win, and a dead member is a far larger
 * loss than the territory is worth.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Gang/Gang.ts#L281-L302 */
export const CLASH_CONFIDENCE = 0.6;

export function stepGang(view: GangView): GangDecision {
  const actions: GangAction[] = [];

  // Recruiting is free respect-wise and strictly additive — always take it.
  if (view.canRecruit) {
    actions.push({ type: "recruit" });
  }

  // Ascension policy threshold, checked per member.
  for (const member of view.members) {
    const gain = view.ascensionGain(member);
    if (gain >= ASCEND_THRESHOLD) {
      actions.push({ type: "ascend", member: member.name });
    }
  }

  // Only compare task names priced for EVERY member. getMemberInformation
  // exposes the current task's exact rates, not a hypothetical task matrix;
  // borrowing member A's measured rate for member B would fabricate data.
  // A full Formulas-backed caller may still supply a complete matrix.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Gang.ts#L151-L164
  const tasksFor = view.members.length > 0
    ? view.taskOptions(view.members[0]!).filter((task) =>
        view.members.every((member) => view.taskOptions(member).some((option) => option.name === task.name)))
    : [];
  const assignment = assignCoupled(
    view.members,
    tasksFor,
    (choices) => {
      let respect = 0;
      let money = 0;
      let wanted = 0;
      for (const { agent, task } of choices) {
        const options = view.taskOptions(agent);
        const priced = options.find((option) => option.name === task.name)!;
        respect += priced.respectGain;
        money += priced.moneyGain;
        wanted += priced.wantedGain;
      }
      // The gang-wide penalty. More wanted level divides everyone's output, so
      // the objective is the PENALISED total, not the raw sum.
      const penalty = 1 / (1 + Math.max(0, wanted) / Math.max(1, view.respect + respect));
      return (respect * view.weights.respect + money * view.weights.money) * penalty;
    },
    (member, task) => {
      const priced = view.taskOptions(member).find((option) => option.name === task.name)!;
      return priced.respectGain * view.weights.respect + priced.moneyGain * view.weights.money;
    },
    (task) => task.name,
  );

  for (const choice of assignment.choices) {
    if (choice.agent.task === choice.task.name) continue;
    actions.push({
      type: "assign",
      member: choice.agent.name,
      task: choice.task.name,
    });
  }

  // Territory warfare: engage only when confident, because losing costs
  // members and a dead member outweighs the territory.
  const worst = Math.min(...Object.values(view.clashChances), 1);
  const shouldEngage = Number.isFinite(worst) && worst >= CLASH_CONFIDENCE;
  if (shouldEngage !== view.territoryWarfareEngaged) {
    actions.push({ type: "warfare", engage: shouldEngage });
  }

  const wantedWarning =
    view.wantedPenalty < 0.5
      ? `wanted penalty is ${view.wantedPenalty.toFixed(2)} — over half of all output is being lost`
      : undefined;

  if (actions.length === 0) actions.push({ type: "idle" });

  return {
    actions,
    assignment,
    ...(wantedWarning ? { wantedWarning } : {}),
  };
}
