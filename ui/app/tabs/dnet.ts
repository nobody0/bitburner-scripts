import { NONE, card, dataTable, definitions, hint, meter, note, outcome, rankedTable, table, tiles, waiting } from "../lib/dom.ts";
import { esc, fmtNum, fmtPct, fmtRam, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import { codeName } from "../../../shared/strategy/dnet/courier.ts";
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

    // Usable RAM is what decides whether an agent can run on a host at all, and
    // it is maxRam minus what the owner blocks — not the ordinary free figure.
    const usable = (s: (typeof d.servers)[number]): number | undefined =>
      s.maxRam === undefined ? undefined : Math.max(0, s.maxRam - (s.blockedRam ?? 0) - (s.usedRam ?? 0));

    const servers = dataTable(
      "dnet.servers",
      d.servers,
      [
        { id: "host", label: "host", left: true, cell: (s) => esc(s.hostname), sort: (s) => s.hostname },
        { id: "depth", label: "depth", cell: (s) => (s.depth < 0 ? NONE : String(s.depth)), sort: (s) => s.depth },
        {
          id: "usable",
          label: "usable RAM",
          cell: (s) => {
            const free = usable(s);
            return free === undefined ? NONE : `<span class="${free >= 2 ? "good" : "bad"}">${fmtRam(free)}</span>`;
          },
          sort: (s) => usable(s) ?? -1,
        },
        { id: "max", label: "max RAM", cell: (s) => (s.maxRam === undefined ? NONE : fmtRam(s.maxRam)), sort: (s) => s.maxRam ?? -1 },
        {
          id: "blocked",
          label: "blocked",
          cell: (s) => (s.blockedRam === undefined ? NONE : fmtRam(s.blockedRam)),
          sort: (s) => s.blockedRam ?? -1,
        },
        {
          id: "charisma",
          label: "charisma",
          cell: (s) => (s.requiredCharisma === undefined ? NONE : fmtNum(s.requiredCharisma, 0)),
          sort: (s) => s.requiredCharisma ?? -1,
        },
        {
          id: "online",
          label: "online",
          cell: (s) => `<span class="${s.isOnline ? "good" : "muted"}">${s.isOnline ? "yes" : "no"}</span>`,
          sort: (s) => (s.isOnline ? 1 : 0),
        },
        {
          id: "reach",
          label: "reach",
          cell: (s) =>
            [
              s.directlyConnected ? `<span class="good">direct</span>` : "",
              s.hasSession ? `<span class="good">session</span>` : "",
              s.stasisLinked ? `<span class="good">linked</span>` : "",
              s.isStationary ? `<span class="muted">fixed</span>` : "",
            ]
              .filter(Boolean)
              .join(" ") || NONE,
        },
      ],
      { defaultSort: { key: "depth", dir: 1 }, empty: "nothing probed" },
    );

    // The password surface. Recorded and rendered only: the model list is
    // deliberately undocumented upstream, so nothing may decide on modelId
    // until the models are measured (spec/game-source.md).
    const discovery = table(
      [
        "host",
        hint("model", "similar models share vulnerabilities; the list is undocumented upstream"),
        "password",
        "hint",
        "data",
        hint("log traffic", "how often the server adds its own lines to the log"),
        "difficulty",
      ],
      d.servers
        .filter((s) => s.modelId !== undefined)
        .map((s) => [
          esc(s.hostname),
          esc(s.modelId ?? ""),
          s.passwordLength === undefined ? NONE : `${s.passwordLength} × ${esc(s.passwordFormat ?? "?")}`,
          s.passwordHint ? esc(s.passwordHint) : NONE,
          s.data ? esc(s.data) : NONE,
          s.logTrafficInterval === undefined ? NONE : fmtTime(s.logTrafficInterval * 1000),
          s.difficulty === undefined ? NONE : fmtNum(s.difficulty, 0),
        ]),
      { empty: "no host details observed yet", left: [0, 1, 3, 4], wrap: [3, 4] },
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

    // What agents delivered, and how healthy the delivery is. `known` only moves
    // when a report is drained, so a host that an agent saw and never delivered
    // is an agent that died first — see spec/dnet.md.
    const channel = d.channel;
    const cover = d.coverage;
    const reach = cover
      ? definitions([
          ["hosts known", String(cover.known)],
          ["adjacency known", `${cover.adjacencyKnown} / ${cover.known}`],
          ["believed fresh", meter(cover.freshFraction, fmtPct(cover.freshFraction))],
          ["gone", String(cover.gone)],
        ])
      : note("no agent report has been folded yet");
    const delivery = channel
      ? definitions([
          ["reports drained", String(channel.drained)],
          ["unreadable", String(channel.rejected)],
          [hint("from dead runs", "gathered in a world this run no longer shares"), String(channel.fromDeadRuns)],
          [hint("hosts forgotten", "unseen long enough that keeping them would be a map of a dead world"), String(channel.forgotten)],
        ])
      : note("the report port has not been drained yet");

    // Every darknet call answers with a code, so a refusal is always
    // attributable rather than a blank.
    const codes = Object.entries(d.codes ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => [code, esc(codeName(Number(code))), String(count)]);

    return (
      `<div class="col wide">` +
      card("Darknet", summary + servers) +
      card("Discovery", discovery) +
      card("Decision", decision) +
      `</div>` +
      `<div class="col">` +
      card("Knowledge", reach) +
      card("Report channel", delivery) +
      card("Response codes", table(["code", "meaning", "n"], codes, { empty: "no darknet call has answered yet", left: [0, 1] })) +
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
