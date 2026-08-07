import { card, definitions, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Career tab: stats, karma and work. Karma is here because it is the gate
 * other features wait on — BN2's gang needs -54,000 of it. */

const GANG_KARMA = -54_000;

export const careerTab: Tab = {
  id: "career",
  render(state: ProjectedState) {
    const c = state.topics.career;
    if (!c) return note("waiting for the career probe");

    const summary = tiles([
      { label: "karma", value: fmtNum(c.karma, 0), sub: `gang unlocks at ${fmtNum(GANG_KARMA, 0)}` },
      { label: "people killed", value: String(c.numPeopleKilled) },
      { label: "city", value: c.city },
      { label: "entropy", value: String(c.entropy) },
      { label: "playtime", value: fmtTime(c.totalPlaytime) },
    ]);

    const statRows = (["hacking", "strength", "defense", "dexterity", "agility", "charisma", "intelligence"] as const)
      .map((key) => [esc(key), String(c.skills[key] ?? 0), fmtNum(c.exp[key] ?? 0, 0)]);

    const work = c.currentWork
      ? definitions([
          ["type", esc(c.currentWork.type)],
          ["detail", esc(c.currentWork.detail ?? "—")],
          ["focused", c.currentWork.focused ? "yes" : "no"],
        ])
      : note("idle, or singularity access (BN4/SF4) is unavailable");

    const jobs = Object.keys(c.jobs).length
      ? table(
          ["company", "position", "rep", "favor"],
          Object.entries(c.jobs).map(([company, position]) => [
            esc(company),
            esc(position),
            c.companies?.[company] ? fmtNum(c.companies[company]!.rep, 0) : "–",
            c.companies?.[company] ? fmtNum(c.companies[company]!.favor, 1) : "–",
          ]),
        )
      : note("no jobs held");

    const crimes = c.crimes
      ? table(
          ["crime", "$/sec", "chance", "payout", "time", "karma"],
          c.crimes
            .slice(0, 15)
            .map((crime) => [
              esc(crime.name),
              `${fmtMoney(crime.moneyPerSec)}/s`,
              fmtPct(crime.chance),
              fmtMoney(crime.money),
              fmtTime(crime.timeMs),
              fmtNum(crime.karma, 1),
            ]),
        )
      : note("crime ranking needs BN4 or SF4 (Singularity)");

    return (
      `<div class="col wide">` +
      card("Career", summary) +
      card("Crime ranking", crimes) +
      `</div>` +
      `<div class="col">` +
      card("Skills", table(["skill", "level", "exp"], statRows)) +
      card("Current work", work) +
      card("Employment", jobs) +
      `</div>`
    );
  },
};
