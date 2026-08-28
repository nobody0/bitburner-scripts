import { gangRespectGain, gangWantedGain, type GangTaskStats } from "./formulas.ts";

export interface GangMemberState {
  name: string;
  task: string;
  skills: { hack: number; str: number; def: number; dex: number; agi: number; cha: number };
  ascensionGain: number;
}

export interface GangView {
  isHacking: boolean;
  respect: number;
  wantedLevel: number;
  territory: number;
  territoryWarfareEngaged: boolean;
  gangSoftcap: number;
  recruitsAvailable: number;
  members: GangMemberState[];
  tasks: GangTaskStats[];
}

export type GangPhase = "recruit" | "ascend" | "train" | "wanted" | "respect";
export type GangAction =
  | { type: "recruit"; name: string; task: string }
  | { type: "assign"; member: string; task: string }
  | { type: "ascend"; member: string; task: string }
  | { type: "warfare" };

export interface GangAssignment {
  member: string;
  task: string;
  respect: number;
  wanted: number;
}

export interface GangDecision {
  phase: GangPhase;
  reason: string;
  actions: GangAction[];
  assignments: GangAssignment[];
}

/** A deliberate policy threshold, not an upstream formula or crossover. */
export const ASCEND_THRESHOLD = 1.15;

function trainingTask(isHacking: boolean): string {
  return isHacking ? "Train Hacking" : "Train Combat";
}

function nextMemberNames(existing: readonly GangMemberState[], count: number): string[] {
  const used = new Set(existing.map((member) => member.name));
  const names: string[] = [];
  for (let index = 1; names.length < count; index++) {
    const name = `member-${index}`;
    if (!used.has(name)) names.push(name);
  }
  return names;
}

export function stepGang(view: GangView): GangDecision {
  const warfare: GangAction[] = view.territoryWarfareEngaged ? [{ type: "warfare" }] : [];
  const train = trainingTask(view.isHacking);

  if (view.recruitsAvailable > 0) {
    const recruits = nextMemberNames(view.members, view.recruitsAvailable)
      .map((name): GangAction => ({ type: "recruit", name, task: train }));
    return { phase: "recruit", reason: `recruit ${recruits.length} available member(s)`, actions: [...warfare, ...recruits], assignments: [] };
  }

  const ascender = [...view.members]
    .filter((member) => member.ascensionGain >= ASCEND_THRESHOLD)
    .sort((a, b) => b.ascensionGain - a.ascensionGain || a.name.localeCompare(b.name))[0];
  if (ascender) {
    return {
      phase: "ascend",
      reason: `${ascender.name} has a ${ascender.ascensionGain.toFixed(2)}x policy gain`,
      actions: [...warfare, { type: "ascend", member: ascender.name, task: train }],
      assignments: [],
    };
  }

  const gang = { respect: view.respect, wantedLevel: view.wantedLevel, territory: view.territory };
  const productiveTasks = view.tasks.filter((task) =>
    task.name !== "Unassigned"
    && task.name !== "Vigilante Justice"
    && task.name !== "Territory Warfare"
    && !task.name.startsWith("Train"));
  const justice = view.tasks.find((task) => task.name === "Vigilante Justice");
  const assignments: GangAssignment[] = view.members.map((member) => {
    const options = productiveTasks
      .map((task) => ({
        member: member.name,
        task: task.name,
        respect: gangRespectGain(gang, member, task, view.gangSoftcap),
        wanted: gangWantedGain(gang, member, task),
      }))
      .filter((option) => option.respect > 0)
      .sort((a, b) => b.respect - a.respect || a.task.localeCompare(b.task));
    return options[0] ?? { member: member.name, task: train, respect: 0, wanted: 0 };
  });

  let totalWanted = assignments.reduce((sum, assignment) => sum + assignment.wanted, 0);
  if (justice && totalWanted > 0) {
    const candidates = assignments
      .filter((assignment) => assignment.respect > 0)
      .map((assignment) => {
        const member = view.members.find((entry) => entry.name === assignment.member)!;
        const wanted = gangWantedGain(gang, member, justice);
        const reduction = assignment.wanted - wanted;
        return { assignment, wanted, reduction, cost: reduction > 0 ? assignment.respect / reduction : Infinity };
      })
      .filter((candidate) => candidate.reduction > 0)
      .sort((a, b) => a.cost - b.cost || a.assignment.member.localeCompare(b.assignment.member));
    let producers = assignments.filter((assignment) => assignment.respect > 0).length;
    for (const candidate of candidates) {
      if (totalWanted <= 0 || producers <= 1) break;
      totalWanted -= candidate.reduction;
      candidate.assignment.task = justice.name;
      candidate.assignment.respect = 0;
      candidate.assignment.wanted = candidate.wanted;
      producers--;
    }
  }

  const actions = assignments
    .filter((assignment) => view.members.find((member) => member.name === assignment.member)?.task !== assignment.task)
    .map((assignment): GangAction => ({ type: "assign", member: assignment.member, task: assignment.task }));
  const productive = assignments.some((assignment) => assignment.respect > 0);
  const balancing = assignments.some((assignment) => assignment.task === "Vigilante Justice");
  const phase: GangPhase = !productive ? "train" : balancing || totalWanted > 0 ? "wanted" : "respect";
  const reason = !productive
    ? "members need training before any task produces respect"
    : totalWanted > 0
      ? "best effort: retain one respect producer while wanted still rises"
      : balancing
        ? "reduce raw wanted gain while preserving respect production"
        : "maximize source-calculated respect gain";
  return { phase, reason, actions: [...warfare, ...actions], assignments };
}
