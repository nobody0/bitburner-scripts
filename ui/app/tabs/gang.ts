import { bar, card, meter, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const gangTab: Tab = {
  id: "gang",
  render(state: ProjectedState) {
    const g = state.topics.gang;
    if (!g) return note("waiting for the gang probe");

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

    const members = table(
      ["member", "task", "respect/s", "wanted/s", "$/s", "hack", "str", "def", "dex", "agi", "cha", "aug"],
      g.members.map((m) => [
        esc(m.name),
        esc(m.task),
        fmtNum(m.respectGain, 3),
        `<span class="${m.wantedLevelGain > 0 ? "bad" : "good"}">${fmtNum(m.wantedLevelGain, 3)}</span>`,
        fmtMoney(m.moneyGain),
        String(m.skills.hack),
        String(m.skills.str),
        String(m.skills.def),
        String(m.skills.dex),
        String(m.skills.agi),
        String(m.skills.cha),
        String(m.augmentations),
      ]),
      { empty: "no members recruited", left: [0, 1] },
    );

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

    return (
      `<div class="col wide">` +
      card("Gang", summary + members) +
      `</div>` +
      `<div class="col">` +
      card("Territory", territoryBar + note(g.territoryWarfareEngaged ? "warfare engaged" : "warfare disengaged")) +
      card("Clash odds", clash) +
      `</div>`
    );
  },
};
