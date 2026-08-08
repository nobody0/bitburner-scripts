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
          ["cycles", fmtNum(c.currentWork.cyclesWorked ?? 0, 0)],
        ])
      : note("idle, or singularity access (BN4/SF4) is unavailable");

    const decision = c.plan
      ? definitions([
          ["selected", esc(`${c.plan.action.type}${c.plan.action.subject ? `: ${c.plan.action.subject}` : ""}`)],
          ["priority", c.plan.priority ? `${esc(c.plan.priority.band)} (${c.plan.priority.value})` : "--"],
          ["decision", esc(c.plan.why)],
          ["action", esc(c.plan.action.why)],
          ["review", c.plan.schedule ? `${esc(c.plan.schedule.reason)} / ${esc(c.plan.schedule.mode)}` : "--"],
          ["last completion", c.plan.schedule?.lastCompletion
            ? `${esc(c.plan.schedule.lastCompletion.type)}: ${esc(c.plan.schedule.lastCompletion.detail ?? "")} (${fmtTime(Date.now() - c.plan.schedule.lastCompletion.at)} ago)`
            : "--"],
        ])
      : note("waiting for the first career decision");

    const requests = c.plan?.serving.length
      ? table(
          ["priority", "requester", "outcome", "have to target", "weight", "progress", "why"],
          c.plan.serving.map((request) => [
            esc(request.urgency ?? "--"),
            esc(request.by ?? "--"),
            esc(`${request.kind}${request.subject ? `: ${request.subject}` : ""}`),
            request.have !== undefined && request.target !== undefined ? `${fmtNum(request.have, 1)} to ${fmtNum(request.target, 1)}` : "--",
            fmtNum(request.weight, 2),
            fmtPct(request.progress),
            esc(request.why ?? ""),
          ]),
        )
      : note("no open career requests; income fallback is active");

    const options = c.plan?.ranked.length
      ? table(
          ["option", "priority", "score", "$/sec", "contributes", "why"],
          c.plan.ranked.map((option) => [
            esc(option.label),
            esc(option.priority ?? "income"),
            fmtNum(option.score, 4),
            fmtMoney(option.moneyPerSec),
            esc((option.contributions ?? []).map((part) => `${part.kind}${part.subject ? `:${part.subject}` : ""} ${fmtNum(part.score, 3)}`).join(", ") || "income"),
            esc(option.why),
          ]),
        )
      : note("no viable career options");

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
      card("Decision", decision) +
      card("Request queue", requests) +
      card("Ranked options", options) +
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
