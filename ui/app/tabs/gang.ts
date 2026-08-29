import { stamp } from "../lib/clock.ts";
import { card, dataTable, NONE, note, outcome, table, tiles, waiting, waitingPanel } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import { ASCEND_THRESHOLD } from "../../../shared/strategy/gang/decide.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

const PER_SECOND = 5;

export const gangTab: Tab = {
  id: "gang",
  render(state: ProjectedState) {
    const gang = state.topics.gang;
    if (!gang) return waitingPanel("Gang", "the gang probe");
    const nextRecruit = gang.respectForNextRecruit;
    const memberSub = gang.recruitsAvailable > 0
      ? `${fmtNum(gang.recruitsAvailable, 0)} recruitable now`
      : Number.isFinite(nextRecruit) ? `next at ${fmtNum(nextRecruit, 0)} respect` : "roster full";
    const summary = tiles([
      { label: "faction", value: gang.faction, sub: gang.isHacking ? "hacking gang" : "combat gang" },
      { label: "respect", value: fmtNum(gang.respect, 0), sub: `${fmtNum(gang.respectGainRate * PER_SECOND, 2)}/s` },
      { label: "wanted", value: fmtNum(gang.wantedLevel, 2), sub: `penalty ${fmtPct(1 - gang.wantedPenalty)}` },
      { label: "income", value: `${fmtMoney(gang.moneyGainRate * PER_SECOND)}/s` },
      { label: "members", value: String(gang.members.length), sub: memberSub },
    ]);
    type Member = (typeof gang.members)[number];
    const members = dataTable("gang.members", gang.members, [
      { id: "name", label: "member", left: true, cell: (member) => esc(member.name), sort: (member) => member.name },
      { id: "task", label: "task", left: true, cell: (member) => esc(member.task), sort: (member) => member.task },
      { id: "respect", label: "respect/s", cell: (member) => fmtNum(member.respectGain * PER_SECOND, 3), sort: (member) => member.respectGain },
      { id: "wanted", label: "wanted/s", cell: (member) => fmtNum(member.wantedLevelGain * PER_SECOND, 3), sort: (member) => member.wantedLevelGain },
      { id: "money", label: "$/s", cell: (member) => fmtMoney(member.moneyGain * PER_SECOND), sort: (member) => member.moneyGain },
      {
        id: "asc", label: gang.isHacking ? "hack asc" : "combat asc",
        cell: (member: Member) => {
          const gain = gang.ascensionGain?.[member.name];
          if (!gain) return "not yet";
          return gain >= ASCEND_THRESHOLD ? html`<span class="good">${gain.toFixed(2)}x</span>` : `${gain.toFixed(2)}x`;
        },
        sort: (member) => gang.ascensionGain?.[member.name] ?? -1,
      },
    ], { defaultSort: { key: "respect", dir: -1 }, empty: "no members recruited" });

    const plan = gang.plan;
    // `phase`/`assignments` are newer than the topic itself; a stored run
    // recorded before them carries the old `assignment` scoring shape.
    const decision = !plan
      ? waiting("the first gang decision")
      : !plan.assignments || !plan.actions
      ? note("this replay predates structured gang assignments")
      : tiles([
          { label: "phase", value: plan.phase },
          { label: "changes", value: String(plan.actions.length), sub: plan.reason },
        ])
        + table(
          ["member", "desired task", "respect/s", "wanted/s"],
          plan.assignments.map((assignment) => [
            esc(assignment.member), esc(assignment.task),
            fmtNum(assignment.respect * PER_SECOND, 3), fmtNum(assignment.wanted * PER_SECOND, 3),
          ]),
          { empty: "no members", left: [0, 1] },
        )
        // Recruit/ascend/warfare branches return no assignments at all, so
        // without this the "changes" count names nothing.
        + (plan.actions.some((action) => action.type !== "assign")
          ? table(
              ["action", "target", "task"],
              plan.actions.filter((action) => action.type !== "assign").map((action) => [
                esc(action.type),
                esc("member" in action ? action.member : "name" in action ? action.name : NONE),
                esc("task" in action ? action.task : NONE),
              ]),
              { empty: "", left: [0, 1, 2] },
            )
          : "")
        + (plan.lastResults ?? []).map((entry) => outcome({
          ok: entry.ok,
          detail: html`${entry.detail} · ${stamp(state, entry.at)}`,
        })).join("");
    return `<div class="col wide">${card("Gang", summary + members)}${card("Decision", decision)}</div>`;
  },
};
