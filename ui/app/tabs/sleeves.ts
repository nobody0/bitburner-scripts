import { card, dataTable, note, outcome, table, tiles, waiting } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const sleevesTab: Tab = {
  id: "sleeves",
  render(state: ProjectedState) {
    const s = state.topics.sleeves;
    if (!s) return waiting("the sleeves probe");

    const avgShock = s.sleeves.length ? s.sleeves.reduce((sum, x) => sum + x.shock, 0) / s.sleeves.length : 0;
    const avgSync = s.sleeves.length ? s.sleeves.reduce((sum, x) => sum + x.sync, 0) / s.sleeves.length : 0;
    const summary = tiles([
      { label: "sleeves", value: String(s.count) },
      { label: "avg shock", value: fmtPct(avgShock / 100), sub: "lower is better" },
      { label: "avg sync", value: fmtPct(avgSync / 100), sub: "higher is better" },
      ...(s.nextSleeveCost ? [{ label: "next sleeve", value: fmtMoney(s.nextSleeveCost) }] : []),
    ]);

    type Sleeve = (typeof s.sleeves)[number];
    const skillColumn = (id: string, label: string, pick: (x: Sleeve) => number) => ({
      id,
      label,
      cell: (x: Sleeve) => String(pick(x)),
      sort: pick,
    });
    const rows = dataTable("sleeves.list", s.sleeves, [
      { id: "index", label: "#", cell: (x) => String(x.index), sort: (x) => x.index },
      {
        id: "task",
        label: "task",
        left: true,
        cell: (x) => esc(x.task ? `${x.task.type}${x.task.detail ? `: ${x.task.detail}` : ""}` : "idle"),
        sort: (x) => (x.task ? x.task.type : "idle"),
      },
      {
        id: "shock",
        label: "shock",
        cell: (x) => `<span class="${x.shock > 0 ? "bad" : "good"}">${x.shock.toFixed(1)}</span>`,
        sort: (x) => x.shock,
      },
      { id: "sync", label: "sync", cell: (x) => x.sync.toFixed(1), sort: (x) => x.sync },
      { id: "city", label: "city", left: true, cell: (x) => esc(x.city), sort: (x) => x.city },
      { id: "hp", label: "hp", cell: (x) => `${x.hp.current}/${x.hp.max}` },
      skillColumn("hack", "hack", (x) => x.skills.hacking),
      skillColumn("str", "str", (x) => x.skills.strength),
      skillColumn("def", "def", (x) => x.skills.defense),
      skillColumn("dex", "dex", (x) => x.skills.dexterity),
      skillColumn("agi", "agi", (x) => x.skills.agility),
      skillColumn("cha", "cha", (x) => x.skills.charisma),
    ], { defaultSort: { key: "index", dir: 1 }, empty: "no sleeves" });

    const augs = s.sleeves
      .filter((x) => x.purchasableAugs?.length)
      .map((x) =>
        card(
          `Sleeve ${x.index} — augmentations`,
          table(
            ["augmentation", "price"],
            (x.purchasableAugs ?? []).slice(0, 20).map((a) => [esc(a.name), fmtMoney(a.price)]),
            { left: [0] },
          ),
        ),
      )
      .join("");

    const plan = s.plan;
    const decision = plan?.selection
      ? tiles([
          { label: "solver", value: "exact" },
          { label: "total score", value: fmtNum(plan.totalScore, 4) },
          { label: "task changes", value: String(plan.assignments.length) },
        ]) +
        table(
          ["sleeve", "selected task", "score", "change"],
          plan.selection.map((entry) => [
            String(entry.index),
            esc(entry.task),
            fmtNum(entry.score, 4),
            plan.assignments.some((change) => change.index === entry.index) ? "queued" : "unchanged",
          ]),
          { empty: "no task candidates", left: [1, 3] },
        ) +
        (plan.lastResult ? outcome(plan.lastResult) : "")
      : plan
        ? note("this replay predates structured sleeve scores")
        : waiting("the first sleeve decision");

    return `<div class="col wide">` + card("Sleeves", summary + rows) + card("Decision", decision) + `</div>` + `<div class="col">${augs || card("Augmentations", note("no data"))}</div>`;
  },
};
