import { bar, card, dataTable, meter, note, outcome, table, tiles, waiting } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const gangTab: Tab = {
  id: "gang",
  render(state: ProjectedState) {
    const g = state.topics.gang;
    if (!g) return waiting("the gang probe");

    const summary = tiles([
      { label: "faction", value: g.faction, sub: g.isHacking ? "hacking gang" : "combat gang" },
      { label: "respect", value: fmtNum(g.respect, 0), sub: `${fmtNum(g.respectGainRate, 2)}/s` },
      {
        label: "wanted",
        value: fmtNum(g.wantedLevel, 2),
        sub: `penalty ${fmtPct(1 - g.wantedPenalty)}`,
      },
      { label: "income", value: `${fmtMoney(g.moneyGainRate)}/s` },
      { label: "territory", value: fmtPct(g.territory, 2) },
      { label: "power", value: fmtNum(g.power, 0) },
      { label: "members", value: String(g.members.length), sub: g.canRecruit ? "can recruit" : `next at ${fmtNum(g.respectForNextRecruit, 0)} respect` },
      ...(g.bonusTime ? [{ label: "bonus time", value: fmtTime(g.bonusTime) }] : []),
    ]);

    type Member = (typeof g.members)[number];
    const skillColumn = (id: keyof Member["skills"]) => ({
      id: String(id),
      label: String(id),
      cell: (m: Member) => String(m.skills[id]),
      sort: (m: Member) => m.skills[id],
    });
    const members = dataTable("gang.members", g.members, [
      { id: "name", label: "member", left: true, cell: (m) => esc(m.name), sort: (m) => m.name },
      { id: "task", label: "task", left: true, cell: (m) => esc(m.task), sort: (m) => m.task },
      { id: "respect", label: "respect/s", cell: (m) => fmtNum(m.respectGain, 3), sort: (m) => m.respectGain },
      {
        id: "wanted",
        label: "wanted/s",
        cell: (m) => `<span class="${m.wantedLevelGain > 0 ? "bad" : "good"}">${fmtNum(m.wantedLevelGain, 3)}</span>`,
        sort: (m) => m.wantedLevelGain,
      },
      { id: "money", label: "$/s", cell: (m) => fmtMoney(m.moneyGain), sort: (m) => m.moneyGain },
      skillColumn("hack"),
      skillColumn("str"),
      skillColumn("def"),
      skillColumn("dex"),
      skillColumn("agi"),
      skillColumn("cha"),
      { id: "aug", label: "aug", cell: (m) => String(m.augmentations), sort: (m) => m.augmentations },
    ], { defaultSort: { key: "respect", dir: -1 }, empty: "no members recruited" });

    const clash = g.clashChances
      ? table(
          ["rival gang", "win chance"],
          Object.entries(g.clashChances)
            .sort((a, b) => b[1] - a[1])
            .map(([name, chance]) => [
              esc(name),
              meter(chance, fmtPct(chance), chance > 0.5),
            ]),
          { left: [0] },
        )
      : note("clash odds need the detail probe");

    const territoryBar = bar([
      { label: "ours", value: g.territory, className: "s1" },
      { label: "rivals", value: Math.max(0, 1 - g.territory), className: "s4" },
    ]);

    const plan = g.plan;
    const decision = plan?.assignment
      ? tiles([
          { label: "search", value: plan.assignment.approximated ? "greedy" : "exact" },
          { label: "objective", value: fmtNum(plan.assignment.total, 4) },
          { label: "changes", value: String(plan.actions.filter((action) => action.type !== "idle").length) },
        ]) +
        table(
          ["member", "selected task", "raw score", "change"],
          plan.assignment.choices.map((choice) => {
            const change = plan.actions.find((action) => action.type === "assign" && action.member === choice.member);
            return [esc(choice.member), esc(choice.task), fmtNum(choice.score, 4), change ? "queued" : "unchanged"];
          }),
          { empty: "no priced assignment", left: [0, 1, 3] },
        ) +
        (plan.lastResult ? outcome(plan.lastResult) : "")
      : plan
        ? note("this replay predates structured gang assignment scores")
        : waiting("the first gang decision");

    return (
      `<div class="col wide">` +
      card("Gang", summary + members) +
      card("Decision", decision) +
      `</div>` +
      `<div class="col">` +
      card("Territory", territoryBar + note(g.territoryWarfareEngaged ? "warfare engaged" : "warfare disengaged")) +
      card("Clash odds", clash) +
      `</div>`
    );
  },
};
