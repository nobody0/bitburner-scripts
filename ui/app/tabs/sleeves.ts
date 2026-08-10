import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const sleevesTab: Tab = {
  id: "sleeves",
  render(state: ProjectedState) {
    const s = state.topics.sleeves;
    if (!s) return note("waiting for the sleeves probe");

    const avgShock = s.sleeves.length ? s.sleeves.reduce((sum, x) => sum + x.shock, 0) / s.sleeves.length : 0;
    const avgSync = s.sleeves.length ? s.sleeves.reduce((sum, x) => sum + x.sync, 0) / s.sleeves.length : 0;
    const summary = tiles([
      { label: "sleeves", value: String(s.count) },
      { label: "avg shock", value: fmtPct(avgShock / 100), sub: "lower is better" },
      { label: "avg sync", value: fmtPct(avgSync / 100), sub: "higher is better" },
      ...(s.nextSleeveCost ? [{ label: "next sleeve", value: fmtMoney(s.nextSleeveCost) }] : []),
    ]);

    const rows = table(
      ["#", "task", "shock", "sync", "city", "hp", "hack", "str", "def", "dex", "agi", "cha"],
      s.sleeves.map((x) => [
        String(x.index),
        esc(x.task ? `${x.task.type}${x.task.detail ? `: ${x.task.detail}` : ""}` : "idle"),
        `<span class="${x.shock > 0 ? "bad" : "good"}">${x.shock.toFixed(1)}</span>`,
        x.sync.toFixed(1),
        esc(x.city),
        `${x.hp.current}/${x.hp.max}`,
        String(x.skills.hacking),
        String(x.skills.strength),
        String(x.skills.defense),
        String(x.skills.dexterity),
        String(x.skills.agility),
        String(x.skills.charisma),
      ]),
      { empty: "no sleeves", left: [1, 4] },
    );

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
        (plan.lastResult
          ? note(`${plan.lastResult.ok ? "last batch succeeded" : "last batch failed"}: ${plan.lastResult.detail}`)
          : "")
      : plan
        ? note("this replay predates structured sleeve scores")
        : note("waiting for the first sleeve decision");

    return `<div class="col wide">` + card("Sleeves", summary + rows) + card("Assignment decision", decision) + `</div>` + (augs ? `<div class="col">${augs}</div>` : "");
  },
};
