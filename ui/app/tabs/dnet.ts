import { NONE, card, note, outcome, rankedTable, table, tiles, waiting } from "../lib/dom.ts";
import { esc, fmtNum, fmtPct, fmtRam } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const dnetTab: Tab = {
  id: "dnet",
  render(state: ProjectedState) {
    const d = state.topics.dnet;
    if (!d) return waiting("the darknet probe");

    const summary = tiles([
      { label: "reachable servers", value: String(d.reachable) },
      { label: "max depth", value: String(d.maxDepth) },
      { label: "stasis links", value: `${d.stasisLinked.length} / ${d.stasisLinkLimit}` },
      { label: "auth duration", value: `x${fmtNum(d.instability.authenticationDurationMultiplier, 2)}` },
      { label: "timeout chance", value: fmtPct(d.instability.authenticationTimeoutChance) },
    ]);

    const servers = table(
      ["host", "depth", "blocked RAM", "charisma", "online", "stasis"],
      d.servers
        .slice()
        .sort((a, b) => a.depth - b.depth || (a.hostname < b.hostname ? -1 : 1))
        .map((s) => [
          esc(s.hostname),
          String(s.depth),
          fmtRam(s.blockedRam),
          s.requiredCharisma !== undefined ? fmtNum(s.requiredCharisma, 0) : NONE,
          `<span class="${s.isOnline ? "good" : "muted"}">${s.isOnline ? "yes" : "no"}</span>`,
          s.stasisLinked ? `<span class="good">linked</span>` : NONE,
        ]),
      { empty: "nothing probed", left: [0] },
    );

    const plan = d.plan;
    const decision = plan
      ? tiles([
          { label: "selected", value: plan.action.type, sub: plan.action.hostname },
          { label: "charisma gate", value: plan.charismaNeeded === undefined ? "clear" : fmtNum(plan.charismaNeeded, 0) },
          { label: "topology", value: d.topologyComplete ? "complete" : "partial" },
        ]) +
        rankedTable(
          ["host", "depth", "servers kept reachable"],
          plan.ranked.map((entry) => [esc(entry.hostname), String(entry.depth), String(entry.unlocks)]),
          {
            selected: (i) => plan.ranked[i]!.hostname === plan.action.hostname,
            empty: "no stasis candidates",
            left: [0],
          },
        ) +
        (plan.lastResult ? outcome(plan.lastResult) : "")
      : waiting("the first darknet decision");

    return (
      `<div class="col wide">` +
      card("Darknet", summary + servers) +
      card("Decision", decision) +
      `</div>` +
      `<div class="col">` +
      card(
        "Stasis links",
        d.stasisLinked.length
          ? table(["host"], d.stasisLinked.map((h) => [esc(h)]))
          : note("no servers stasis-linked"),
      ) +
      `</div>`
    );
  },
};
