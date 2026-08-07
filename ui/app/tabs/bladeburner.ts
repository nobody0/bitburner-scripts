import { bar, card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const bladeburnerTab: Tab = {
  id: "bladeburner",
  render(state: ProjectedState) {
    const b = state.topics.bladeburner;
    if (!b) return note("waiting for the bladeburner probe");

    const [stamina, staminaMax] = b.stamina;
    const summary = tiles([
      { label: "rank", value: fmtNum(b.rank, 0) },
      { label: "skill points", value: fmtNum(b.skillPoints, 0) },
      { label: "stamina", value: `${fmtNum(stamina, 0)} / ${fmtNum(staminaMax, 0)}`, sub: fmtPct(staminaMax ? stamina / staminaMax : 0) },
      { label: "city", value: b.city },
      { label: "action", value: b.current ? `${b.current.type}: ${b.current.name}` : "idle" },
      ...(b.nextBlackOp
        ? [{ label: "next black op", value: b.nextBlackOp.name, sub: `rank ${fmtNum(b.nextBlackOp.rank, 0)}` }]
        : []),
      ...(b.bonusTime ? [{ label: "bonus time", value: fmtTime(b.bonusTime) }] : []),
    ]);

    const staminaBar = bar([
      { label: "stamina", value: stamina, className: "s1" },
      { label: "spent", value: Math.max(0, staminaMax - stamina), className: "s4" },
    ]);

    const actions = table(
      ["type", "action", "success", "time", "remaining", "level"],
      (b.actions ?? [])
        .slice()
        .sort((a, b2) => b2.chance[0] - a.chance[0])
        .map((a) => [
          esc(a.type),
          esc(a.name),
          a.chance[0] === a.chance[1]
            ? fmtPct(a.chance[0])
            : `${fmtPct(a.chance[0])} – ${fmtPct(a.chance[1])}`,
          fmtTime(a.timeMs),
          a.countRemaining >= 1e9 ? "∞" : fmtNum(a.countRemaining, 0),
          a.maxLevel ? `${a.level ?? 0}/${a.maxLevel}` : "–",
        ]),
      "waiting for the bladeburner.actions probe",
    );

    const skills = Object.keys(b.skills ?? {}).length
      ? table(
          ["skill", "level", "next cost"],
          Object.entries(b.skills ?? {})
            .sort((a, c) => c[1].level - a[1].level)
            .map(([name, s]) => [
              esc(name),
              String(s.level),
              `<span class="${s.upgradeCost <= b.skillPoints ? "good" : "muted"}">${fmtNum(s.upgradeCost, 0)}</span>`,
            ]),
        )
      : note("skill list needs the actions probe");

    const cities = b.cities?.length
      ? table(
          ["city", "population", "communities", "chaos"],
          b.cities.map((c) => [
            esc(c.name),
            fmtNum(c.population, 0),
            String(c.communities),
            `<span class="${c.chaos > 50 ? "bad" : ""}">${fmtNum(c.chaos, 1)}</span>`,
          ]),
        )
      : note("city intel needs the cities probe");

    return (
      `<div class="col wide">` +
      card("Bladeburner", summary + staminaBar) +
      card("Actions", actions) +
      `</div>` +
      `<div class="col">` +
      card("Skills", skills) +
      card("Cities", cities) +
      `</div>`
    );
  },
};
