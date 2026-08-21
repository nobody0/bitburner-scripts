import {
  NONE,
  card,
  collapsible,
  dataTable,
  definitions,
  filters,
  hint,
  meter,
  note,
  outcome,
  rankedTable,
  search,
  table,
  tiles,
  waiting,
} from "../lib/dom.ts";
import { raw, type Markup } from "../lib/html.ts";
import { esc, fmtNum, fmtPct, fmtRam, fmtTime } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import type { ProjectedState } from "../project.ts";
import { codeName } from "../../../shared/strategy/dnet/courier.ts";
import type { DarknetKnownHost, DarknetState } from "../../../shared/telemetry/topics/dnet.ts";
import { isStale, matches, mapOptions, netLegend, netMap } from "./dnet-map.ts";
import type { Tab } from "./index.ts";

/** The Darknet panel.
 *
 * The feature's own rule (spec/dnet.md) is that every fact carries where it came
 * from and when, and that a fact past its expiry is SHOWN but excluded from
 * decisions. This panel is where that stops being an internal discipline and
 * becomes something an operator can act on: the map draws what we believe, the
 * fading says how much, and the detail card shows the age and the source of
 * every single fact behind a box.
 *
 * The second job is the password problem. Nineteen of the twenty-four models are
 * deliberately unsolved, so for those the panel's task is to hand over the raw
 * material — the hint, the captured oracle, the response codes, the exact reason
 * we have not attacked it — rather than to hide a blank behind a shrug. */

/** How many rows the server table shows before saying it truncated. The MAP
 * never truncates; a table is where a limit belongs. */
const TABLE_LIMIT = 60;

function factRows(host: DarknetKnownHost): [Markup, Markup][] {
  const rows: [Markup, Markup][] = [];
  for (const [key, fact] of Object.entries(host.facts)) {
    const source = fact.from === "agent" ? `agent via ${esc(fact.via ?? "?")}` : "home";
    // `null` is the identity class: it never expires by age, only by the host
    // disappearing. Rendering it as "0ms left" would be exactly backwards.
    const life = fact.expiresInMs === null
      ? `<span class="muted">never expires</span>`
      : fact.stale
        ? `<span class="bad">stale</span>`
        : `<span class="good">${fmtTime(fact.expiresInMs)} left</span>`;
    rows.push([
      hint(key, `${fact.class} fact`),
      `<span class="${fact.stale ? "muted" : ""}">${fmtTime(fact.ageMs)} ago</span> · ${source} · ${life}`,
    ]);
  }
  return rows;
}

function detailCard(d: DarknetState, hosts: readonly DarknetKnownHost[], selected: string): string {
  const host = hosts.find((entry) => entry.hostname === selected)
    ?? hosts.find((entry) => entry.hostname === d.plan?.action.hostname)
    ?? hosts.find((entry) => entry.isDarkweb)
    ?? hosts[0];
  if (!host) return card("Host", note("no host selected"));

  const summary = tiles([
    { label: "depth", value: host.depth === undefined ? "?" : String(host.depth) },
    {
      label: "usable RAM",
      value: host.maxRam === undefined ? NONE : fmtRam(host.freeRam ?? 0),
      sub: host.maxRam === undefined ? undefined : `of ${fmtRam(host.maxRam)}`,
    },
    {
      label: "charisma",
      value: host.requiredCharisma === undefined ? NONE : fmtNum(host.requiredCharisma, 0),
      sub: d.charisma !== undefined ? `have ${fmtNum(d.charisma, 0)}` : undefined,
    },
    { label: "state", value: host.authState ?? NONE },
  ]);

  // The password model, and — when we have not attacked it — exactly why not.
  // This is the panel's most useful block: it is the difference between "we did
  // nothing here" and "here is the oracle, and here is what writing the solver
  // would take".
  const modelRows: [Markup, Markup][] = [];
  if (host.modelId) {
    modelRows.push(["model", `${esc(host.modelId)}${host.modelName ? ` <span class="muted">(${esc(host.modelName)})</span>` : ""}`]);
    if (host.modelFeedback) modelRows.push(["feedback", esc(host.modelFeedback)]);
    if (host.passwordLength !== undefined) {
      modelRows.push(["password", `${host.passwordLength} × ${esc(host.passwordFormat ?? "?")}`]);
    }
    if (host.passwordHint) modelRows.push([hint("hint", "shown by getServerDetails, free"), esc(host.passwordHint)]);
    if (host.data) modelRows.push(["data", esc(host.data)]);
    if (host.difficulty !== undefined) modelRows.push(["difficulty", fmtNum(host.difficulty, 0)]);
    if (host.logTrafficInterval !== undefined) {
      modelRows.push([
        hint("log traffic", "how often the server writes a line of its own — and how often it leaks"),
        fmtTime(host.logTrafficInterval * 1000),
      ]);
    }
    if (host.modelOracle) {
      modelRows.push([hint("oracle", "what a wrong guess tells you, and where it appears"), esc(host.modelOracle)]);
    }
    if (host.modelVia) modelRows.push(["read via", esc(host.modelVia)]);
    if (host.modelBlocked) modelRows.push(["not attacked", `<span class="muted">${esc(host.modelBlocked)}</span>`]);
  }

  const attempt = host.attempt;
  const attemptRows: [Markup, Markup][] = attempt
    ? [
      ["status", esc(attempt.status)],
      ["candidates tried", String(attempt.tried)],
      [hint("probes", "deliberate failures spent to make the oracle appear at all"), String(attempt.probes)],
      ...(attempt.lastCode !== undefined
        ? [[`last code`, `${attempt.lastCode} ${esc(codeName(attempt.lastCode))}`] as [Markup, Markup]]
        : []),
      ...(attempt.lastOracle !== undefined ? [["last response", esc(attempt.lastOracle)] as [Markup, Markup]] : []),
    ]
    : [];

  const neighbours = (host.neighbours ?? []).length > 0
    ? `<div class="chips">`
      + (host.neighbours ?? [])
        .map((name) => `<button class="chip pick" data-view-key="dnet.sel" data-view-value="${esc(name)}">${esc(name)}</button>`)
        .join("")
      + `</div>`
    : note("no adjacency known — this host is a rumour until an agent stands next to it");

  return card(
    // raw(), because `card` escapes a plain string title — the hostname and the
    // ip are already escaped individually above.
    raw(`${esc(host.hostname)}${host.ip ? ` <span class="muted">${esc(host.ip)}</span>` : ""}`),
    summary
    + (host.credentialKnown ? `<p class="good">credential held</p>` : "")
    + (host.goneAt !== undefined ? `<p class="bad">gone — its identity facts were dropped with it</p>` : "")
    + (modelRows.length > 0 ? definitions(modelRows) : note("no password model observed"))
    + (attemptRows.length > 0 ? collapsible("dnet.attempt", "attempts", definitions(attemptRows), true) : "")
    + collapsible("dnet.facts", "facts, with provenance", definitions(factRows(host)), true)
    + collapsible("dnet.neigh", "neighbours", neighbours, false),
  );
}

export const dnetTab: Tab = {
  id: "dnet",
  render(state: ProjectedState) {
    const d = state.topics.dnet;
    if (!d) return waiting("the darknet probe");

    const knowledge = d.knowledge;
    // Until an agent has reported, home's own one-hop probe is genuinely all we
    // have, so it is shown as such rather than as an empty map.
    const hosts: DarknetKnownHost[] = knowledge?.hosts ?? d.servers.map((server) => ({
      hostname: server.hostname,
      lastSeenAt: 0,
      ...(server.depth >= 0 || server.hostname === "darkweb" ? { depth: server.depth } : {}),
      ...(server.hostname === "darkweb" ? { isDarkweb: true } : {}),
      ...(server.maxRam !== undefined ? { maxRam: server.maxRam } : {}),
      ...(server.blockedRam !== undefined ? { blockedRam: server.blockedRam } : {}),
      ...(server.usedRam !== undefined ? { usedRam: server.usedRam } : {}),
      freeRam: server.maxRam === undefined
        ? 0
        : Math.max(0, server.maxRam - Math.max(server.usedRam ?? 0, server.blockedRam ?? 0)),
      ...(server.requiredCharisma !== undefined ? { requiredCharisma: server.requiredCharisma } : {}),
      ...(server.modelId !== undefined ? { modelId: server.modelId } : {}),
      ...(server.passwordLength !== undefined ? { passwordLength: server.passwordLength } : {}),
      ...(server.passwordFormat !== undefined ? { passwordFormat: server.passwordFormat } : {}),
      ...(server.passwordHint !== undefined ? { passwordHint: server.passwordHint } : {}),
      ...(server.data !== undefined ? { data: server.data } : {}),
      ...(server.difficulty !== undefined ? { difficulty: server.difficulty } : {}),
      ...(server.isStationary !== undefined ? { isStationary: server.isStationary } : {}),
      ...(server.stasisLinked !== undefined ? { stasisLinked: server.stasisLinked } : {}),
      facts: {},
      authState: server.isOnline === false
        ? ("offline" as const)
        : server.hostname === "darkweb"
          ? ("session" as const)
          : server.directlyConnected
            ? ("auth-required" as const)
            : ("no-connection" as const),
    }));

    const options = mapOptions();
    const matched = options.query ? hosts.filter((host) => matches(host, options.query)) : hosts;

    const summary = tiles([
      { label: "hosts known", value: String(knowledge ? knowledge.hosts.length - knowledge.gone : d.reachable) },
      { label: "max depth", value: String(d.maxDepth) },
      {
        label: "cracked",
        value: String(d.coverage?.cracked ?? 0),
        sub: d.coverage?.plantable !== undefined ? `${d.coverage.plantable} plantable` : undefined,
      },
      {
        label: "agents",
        value: knowledge ? String(knowledge.agents.live) : NONE,
        // The gap between agents seen and agents still reporting IS agent
        // mortality, and out there that is the loss that actually matters.
        sub: knowledge && knowledge.agents.lostSinceBoot > 0 ? `${knowledge.agents.lostSinceBoot} lost` : undefined,
      },
      { label: "stasis links", value: `${d.stasisLinked.length} / ${d.stasisLinkLimit}` },
      {
        label: hint("mutation", "how often the net rearranges itself"),
        value: d.mutationIntervalMs === undefined ? NONE : fmtTime(d.mutationIntervalMs),
        sub: knowledge?.mutationsSeen !== undefined ? `${knowledge.mutationsSeen} seen` : undefined,
      },
      { label: "auth duration", value: `x${fmtNum(d.instability.authenticationDurationMultiplier, 2)}` },
      { label: "timeout chance", value: fmtPct(d.instability.authenticationTimeoutChance) },
    ]);

    const controls =
      `<div class="netcontrols">`
      + search("dnet.q", "search host, ip, model, hint")
      + filters("dnet.zoom", [
        { value: "40", label: "40%" },
        { value: "60", label: "60%" },
        { value: "80", label: "80%" },
        { value: "100", label: "100%" },
      ], "100")
      + filters("dnet.edges", [
        { value: "tree", label: "tree", title: "only parent-to-child links" },
        { value: "all", label: "all links" },
        { value: "none", label: "no links" },
      ], "tree")
      + `</div>`
      // Search HIGHLIGHTS rather than removes, the way the in-game search box
      // does: the shape of the net is the point, and filtering it away to seven
      // boxes destroys the thing you came to look at.
      + (options.query ? note(`${matched.length} of ${hosts.length} match — non-matches dimmed, not removed`) : "");

    const showFilter = view("dnet.show", "all");
    const tableHosts = hosts.filter((host) => {
      if (options.query && !matches(host, options.query)) return false;
      switch (showFilter) {
        case "cracked": return host.credentialKnown === true;
        case "locked": return host.authState === "auth-required";
        case "roomy": return (host.freeRam ?? 0) >= 2.6;
        case "stale": return isStale(host);
        case "gone": return host.goneAt !== undefined;
        default: return true;
      }
    });

    const servers = dataTable(
      "dnet.servers",
      tableHosts,
      [
        {
          id: "host",
          label: "host",
          left: true,
          // The accessible route to selection: a real button, unlike the SVG
          // group, which cannot be activated from the keyboard.
          cell: (h) =>
            `<button class="chip pick${h.hostname === options.selected ? " sel" : ""}"`
            + ` data-view-key="dnet.sel" data-view-value="${esc(h.hostname)}">${esc(h.hostname)}</button>`,
          sort: (h) => h.hostname,
        },
        { id: "depth", label: "depth", cell: (h) => (h.depth === undefined ? NONE : String(h.depth)), sort: (h) => h.depth ?? 999 },
        { id: "ip", label: "ip", left: true, cell: (h) => (h.ip ? esc(h.ip) : NONE), sort: (h) => h.ip ?? "" },
        { id: "model", label: "model", left: true, cell: (h) => (h.modelId ? esc(h.modelId) : NONE), sort: (h) => h.modelId ?? "" },
        {
          id: "usable",
          label: "usable RAM",
          cell: (h) => {
            if (h.maxRam === undefined) return NONE;
            const free = h.freeRam ?? 0;
            return `<span class="${free >= 2.6 ? "good" : "bad"}">${fmtRam(free)}</span>`;
          },
          sort: (h) => h.freeRam ?? -1,
        },
        { id: "max", label: "max RAM", cell: (h) => (h.maxRam === undefined ? NONE : fmtRam(h.maxRam)), sort: (h) => h.maxRam ?? -1 },
        { id: "blocked", label: "blocked", cell: (h) => (h.blockedRam === undefined ? NONE : fmtRam(h.blockedRam)), sort: (h) => h.blockedRam ?? -1 },
        {
          id: "charisma",
          label: "charisma",
          cell: (h) => (h.requiredCharisma === undefined ? NONE : fmtNum(h.requiredCharisma, 0)),
          sort: (h) => h.requiredCharisma ?? -1,
        },
        {
          id: "seen",
          label: "seen",
          cell: (h) => (h.lastSeenAt > 0 && knowledge ? fmtTime(knowledge.at - h.lastSeenAt) : NONE),
          sort: (h) => -h.lastSeenAt,
        },
        {
          id: "state",
          label: "state",
          cell: (h) =>
            [
              h.authState === "session" ? `<span class="good">session</span>` : "",
              h.authState === "authenticated" ? `<span class="good">cracked</span>` : "",
              h.authState === "auth-required" ? `<span class="muted">auth</span>` : "",
              h.authState === "no-connection" ? `<span class="muted">unreached</span>` : "",
              h.goneAt !== undefined ? `<span class="bad">gone</span>` : "",
              h.stasisLinked ? `<span class="good">linked</span>` : "",
              h.isStationary ? `<span class="muted">fixed</span>` : "",
              isStale(h) ? `<span class="muted">stale</span>` : "",
            ].filter(Boolean).join(" ") || NONE,
        },
      ],
      { defaultSort: { key: "depth", dir: 1 }, empty: "nothing observed yet", limit: TABLE_LIMIT },
    );

    // The password surface for the whole net at once, kept as a table because
    // comparing models across hosts is how you spot which one to solve first.
    const discovery = table(
      [
        "host",
        hint("model", "similar models share vulnerabilities; the list is undocumented upstream"),
        "password",
        "hint",
        "data",
        hint("why untouched", "the registry's own reason, per model"),
      ],
      hosts
        .filter((h) => h.modelId !== undefined)
        .map((h) => [
          esc(h.hostname),
          esc(h.modelId ?? ""),
          h.passwordLength === undefined ? NONE : `${h.passwordLength} × ${esc(h.passwordFormat ?? "?")}`,
          h.passwordHint ? esc(h.passwordHint) : NONE,
          h.data ? esc(h.data) : NONE,
          h.modelBlocked ? `<span class="muted">${esc(h.modelBlocked)}</span>` : `<span class="good">implemented</span>`,
        ]),
      { empty: "no host details observed yet", left: [0, 1, 3, 4, 5], wrap: [3, 4, 5] },
    );

    const plan = d.plan;
    const decision = plan
      ? tiles([
        { label: "selected", value: plan.action.type, sub: plan.action.hostname },
        { label: "charisma gate", value: plan.charismaNeeded === undefined ? "clear" : fmtNum(plan.charismaNeeded, 0) },
        { label: "topology", value: d.topologyComplete ? "complete" : "partial" },
      ])
        + rankedTable(
          ["host", "depth", "servers kept reachable"],
          plan.ranked.map((entry) => [esc(entry.hostname), String(entry.depth), String(entry.unlocks)]),
          {
            selected: (i) => plan.ranked[i]!.hostname === plan.action.hostname,
            empty: "no stasis candidates",
            left: [0],
          },
        )
        + (plan.lastResult ? outcome(plan.lastResult) : "")
      : waiting("the first darknet decision");

    // What agents delivered, and how healthy the delivery is. `known` only moves
    // when a report is drained, so a host an agent saw and never delivered is an
    // agent that died first — see spec/dnet.md.
    const channel = d.channel;
    const cover = d.coverage;
    const reach = cover
      ? definitions([
        ["hosts known", String(cover.known)],
        ["adjacency known", `${cover.adjacencyKnown} / ${cover.known}`],
        ["believed fresh", meter(cover.freshFraction, fmtPct(cover.freshFraction))],
        ["gone", String(cover.gone)],
        ...(cover.cracked !== undefined ? [["cracked", String(cover.cracked)] as [Markup, Markup]] : []),
        ...(cover.plantable !== undefined
          ? [[hint("plantable", "cracked AND with believable room for an agent"), String(cover.plantable)] as [Markup, Markup]]
          : []),
      ])
      : note("no agent report has been folded yet");
    const delivery = channel
      ? definitions([
        ["reports drained", String(channel.drained)],
        ["unreadable", String(channel.rejected)],
        [hint("from dead runs", "gathered in a world this run no longer shares"), String(channel.fromDeadRuns)],
        [hint("hosts forgotten", "unseen long enough that keeping them would be a map of a dead world"), String(channel.forgotten)],
        ...(channel.vaultDrained !== undefined
          ? [[hint("vault messages", "credentials arriving on their own channel; the count travels, they do not"), String(channel.vaultDrained)] as [Markup, Markup]]
          : []),
      ])
      : note("the report port has not been drained yet");

    // Every darknet call answers with a code, so a refusal is always
    // attributable rather than a blank.
    const codes = Object.entries(d.codes ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => [code, esc(codeName(Number(code))), String(count)]);

    const unknown = knowledge?.unknownModels;
    const unknownCard = unknown && Object.keys(unknown).length > 0
      ? card(
        "Unrecognised models",
        note("the game produced a model id our transcription does not know — a game update, or a hole in shared/strategy/dnet/models.ts")
        + table(["model", "seen"], Object.entries(unknown).map(([id, n]) => [esc(id), String(n)]), { left: [0] }),
      )
      : "";

    return (
      // The map spans both columns: it is eight boxes wide by construction, the
      // game's own NET_WIDTH, and does not fit a half-width column at any zoom
      // that leaves the hostnames readable.
      `<div class="col span">`
      + card("Darknet", summary + controls + netMap(hosts, options) + netLegend())
      + `</div>`
      + `<div class="col wide">`
      + card(
        "Servers",
        filters("dnet.show", [
          { value: "all", label: "all", badge: String(hosts.length) },
          { value: "cracked", label: "cracked" },
          { value: "locked", label: "auth required" },
          { value: "roomy", label: "has RAM" },
          { value: "stale", label: "stale" },
          { value: "gone", label: "gone" },
        ], "all")
        + servers
        + collapsible("dnet.discovery", "password surface, every host", discovery, false),
      )
      + card("Decision", decision)
      + `</div>`
      + `<div class="col">`
      + detailCard(d, hosts, options.selected)
      + card("Knowledge", reach)
      + card("Report channel", delivery)
      + card("Response codes", table(["code", "meaning", "n"], codes, { empty: "no darknet call has answered yet", left: [0, 1] }))
      + unknownCard
      + `</div>`
    );
  },
};
