import {
  BITNODES,
  MULTIPLIER_GROUPS,
  changedMultipliers,
  type ChangedMultiplier,
  type MultiplierGroup,
} from "../../../shared/features/bitnode.ts";
import { featureForBitNode } from "../../../shared/features/registry.ts";
import { formatScientific } from "../../../shared/format.ts";
import { attachChartHover, drawSeries } from "../lib/chart.ts";
import { card, collapsible, definitions, dot, filters, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtTime } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import { view } from "../lib/viewstate.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";
import type { TimeForecast } from "../../../shared/strategy/progression/forecast.ts";

/** BitNode tab: where we are, what we have finished, and exactly what this
 * node changes. Source-file level doubles as the completion count — SF n at
 * level 3 means BitNode n was destroyed three times. */

const GROUP_LABELS: Record<MultiplierGroup, string> = {
  hacking: "Hacking",
  infra: "Infrastructure",
  skills: "Skills",
  career: "Career",
  factions: "Factions",
  side: "Side income",
  hacknet: "Hacknet",
  stock: "Stocks",
  gang: "Gang",
  corp: "Corporation",
  bladeburner: "Bladeburner",
  stanek: "Stanek",
  go: "Go",
  darknet: "Darknet",
  endgame: "Endgame",
};

/** Strip the noise words every field name repeats. `HackingLevelMultiplier`
 * inside a card titled "BitNode multipliers" spends 10 of its 23 characters
 * saying nothing. */
function shortField(field: string): string {
  return field.replace(/Multiplier$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** One multiplier as `name  value  ±%`.
 *
 * The BN1 default is not a column: it is 1.0 for every field but two, so a
 * whole column of "1.000" was a third of the table's width. The percentage
 * carries the same information and reads as a magnitude — 0.700 is "70% of
 * BN1", 1.428 is "143%" — while the colour says whether that helps. */
function multiplierEntry(entry: ChangedMultiplier): string {
  const cls = entry.harder ? "bad" : "good";
  // StaneksGiftExtraSize is the one field with a base of 0, where a ratio is
  // undefined; it is a count of grid squares, so it is shown as a delta.
  const delta =
    entry.base === 0
      ? `${entry.value > 0 ? "+" : ""}${fmtNum(entry.value, 0)}`
      : `${((entry.value / entry.base) * 100).toFixed(0)}%`;
  return (
    `<div class="mult" title="${esc(`${entry.field}: ${entry.value} (BN1 default ${entry.base})`)}">` +
    `<span class="nm">${esc(shortField(entry.field))}</span>` +
    `<span class="vl">${fmtNum(entry.value, entry.value < 10 ? 2 : 0)}</span>` +
    `<span class="dl ${cls}">${esc(delta)}</span>` +
    `</div>`
  );
}

function multiplierGrid(changed: ChangedMultiplier[]): string {
  const mode = view("bitnode.mults", "all");
  const shown = mode === "harder" ? changed.filter((c) => c.harder) : mode === "easier" ? changed.filter((c) => !c.harder) : changed;
  if (shown.length === 0) return note("nothing in this view");

  const byGroup = new Map<MultiplierGroup, ChangedMultiplier[]>();
  for (const entry of shown) {
    const list = byGroup.get(entry.group);
    if (list) list.push(entry);
    else byGroup.set(entry.group, [entry]);
  }
  return MULTIPLIER_GROUPS.filter((group) => byGroup.has(group))
    .map(
      (group) =>
        `<div class="multgroup"><h3>${esc(GROUP_LABELS[group])}</h3>` +
        `<div class="mults">${byGroup.get(group)!.map(multiplierEntry).join("")}</div></div>`,
    )
    .join("");
}

function forecastCard(forecast: TimeForecast, now: number): string {
  if (forecast.state === "unknown") {
    return note(`unknown: ${forecast.reason}; next review in ${fmtTime(Math.max(0, forecast.nextRecalibrationAt - now))}`);
  }
  const remainingMs = Math.max(0, forecast.expectedAt - now);
  return (
    tiles([
      { label: "remaining", value: fmtTime(remainingMs), sub: forecast.state },
      { label: "expected at", value: new Date(forecast.expectedAt).toLocaleString() },
      { label: "confidence", value: forecast.confidence, sub: `estimated ${fmtTime(now - forecast.estimatedAt)} ago` },
      { label: "next recalibration", value: fmtTime(Math.max(0, forecast.nextRecalibrationAt - now)) },
    ]) +
    table(
      ["component", "relationship", "time", "source", "critical"],
      forecast.components.map((part) => [
        esc(part.what),
        part.mode,
        fmtTime(part.sec * 1_000),
        part.measured ? "measured" : "model/fallback",
        part.critical ? "yes" : "",
      ]),
      { empty: "ready now", left: [0, 1, 3, 4] },
    )
  );
}

type Plan = NonNullable<NonNullable<ProjectedState["topics"]["progression"]>["plan"]>;
type Progression = NonNullable<ProjectedState["topics"]["progression"]>;
type RamArena = NonNullable<Progression["ramArena"]>;

/** The chosen ending and every route's estimate, with per-part attribution so
 * a wrong total points at the sub-heuristic that produced it. */
function routeCard(plan: Plan, now: number): string {
  if (!plan.routes || plan.routes.length === 0) {
    return note("waiting for the endgame route estimates");
  }
  const chosen = plan.route;
  const selected = plan.routes.find((route) => route.id === chosen);
  const header = chosen
    ? tiles([
        {
          label: "chosen route",
          value: chosen,
          sub: selected
            ? `${Number.isFinite(selected.etaSec) ? fmtTime(selected.etaSec * 1_000) : "∞"} ETA · ${selected.available ? "available" : "blocked"}`
            : "",
        },
        {
          label: "decided",
          value: plan.decidedAt !== undefined ? `${fmtTime(Math.max(0, now - plan.decidedAt))} ago` : "–",
        },
      ])
    : note("no route decided yet");
  const rows = table(
    ["", "route", "status", "blocker", "eta"],
    [...plan.routes]
      .sort((a, b) => a.etaSec - b.etaSec)
      .map((route) => [
        route.id === chosen ? "▶" : "",
        esc(route.id),
        route.complete
          ? dot("good", "complete") + " complete"
          : route.available
            ? dot("good", "available") + " available"
            : dot("wait", "blocked") + " blocked",
        esc(route.blocker || "–"),
        Number.isFinite(route.etaSec) ? fmtTime(route.etaSec * 1_000) : "∞",
      ]),
    { left: [1, 2, 3] },
  );
  const parts = plan.routes
    .map((route) =>
      collapsible(
        `bitnode.route.${route.id}`,
        `${esc(route.id)} — ${route.parts.length} component(s)`,
        table(
          ["component", "time", "source"],
          route.parts.map((part) => [
            esc(part.what),
            Number.isFinite(part.sec) ? fmtTime(part.sec * 1_000) : "∞",
            part.measured ? "measured" : "model/fallback",
          ]),
          { empty: "no components", left: [0, 2] },
        ),
        false,
      ),
    )
    .join("");
  return header + rows + parts;
}

/** The dodge arena: how much RAM is held back from the batcher, which hosts
 * carry it, and who is waiting. Reports the broker's own numbers — the split
 * between the guaranteed floor (a request at or under it never queues) and
 * growth that only a genuinely starved request can summon. Anything waiting
 * past five seconds is the signal that the arena is too small for what the
 * run is actually asking for. */
function arenaBody(arena: Progression["ramArena"]): string {
  if (!arena) return note("the RAM broker has not reported yet");
  const starved = new Set(arena.starvation.map((request) => `${request.by}\0${request.id}`));
  const summary = definitions([
    ["hosts", arena.hosts.length ? arena.hosts.map((host: string) => esc(host)).join(", ") : "—"],
    ["arena", `${fmtNum(arena.arenaGb, 1)} GB`],
    ["instant up to", `${fmtNum(arena.guaranteedDynamicGb, 1)} GB`],
    ["largest measured", `${fmtNum(arena.measuredDynamicGb, 1)} GB`],
    ["foodnstuff promoted", arena.promoted ? "yes" : "no"],
    ["farm opportunity cost", `${fmtMoney(arena.farmCostPerSec)}/sec`],
  ]);
  const waiting = arena.waits.length
    ? table(
        ["waiting", "request", "GB", "class", "lane", "waited"],
        arena.waits.map((request: RamArena["waits"][number]) => [
          starved.has(`${request.by}\0${request.id}`) ? "starved" : "queued",
          esc(`${request.by}:${request.id}`),
          fmtNum(request.gb, 1),
          esc(request.class),
          esc(request.lane),
          fmtTime(request.waitMs),
        ]),
        { left: [0, 1, 3, 4] },
      )
    : note("nothing waiting for RAM");
  const shortfall = arena.queueDepth > 0
    ? note(`largest waiter needs ${fmtNum(arena.neededForLargestWaitingGb, 1)} GB contiguous`)
    : "";
  return summary + waiting + shortfall;
}

/** The install-vs-push cadence: what has accrued, what it must clear, and
 * which way the dwelled verdict points. The chart draws the two series whose
 * crossing IS the decision. */
function cadenceCard(plan: Plan, hasSeries: boolean): string {
  const decision = plan.installDecision;
  if (!decision) return note("waiting for the cadence verdict (needs a route ETA and a factions frontier)");
  const verdictDot =
    decision.effective === "install" ? dot("ready", "install") : decision.effective === "push" ? dot("good", "push") : dot("off", "legacy");
  const header = tiles([
    {
      label: "verdict",
      value: html`${verdictDot} ${decision.effective}`,
      sub: `${decision.verdict} before latch${decision.remainingSec !== undefined ? ` · ${fmtTime(decision.remainingSec * 1_000)} remaining` : ""}`,
    },
    {
      label: "accrued value",
      value: fmtNum(decision.resetValueMult, 2),
      sub: decision.resetFavorValue !== undefined ? `${fmtNum(decision.resetFavorValue, 2)} from banked favor` : "",
    },
    {
      label: "threshold",
      value: decision.threshold !== undefined ? fmtNum(decision.threshold, 2) : "–",
      sub: decision.pushRate !== undefined ? `push rate ${formatScientific(decision.pushRate)}/s` : "no push target",
    },
    {
      label: "latched",
      value: decision.latched ? "yes" : "no",
      sub: decision.pushEtaSec !== undefined ? `next package ${fmtTime(decision.pushEtaSec * 1_000)}` : "",
    },
  ]);
  const crossings = plan.favorCrossings?.length
    ? table(
        ["faction", "favor now", "favor after install"],
        plan.favorCrossings.map((crossing) => [
          esc(crossing.faction),
          fmtNum(crossing.favorNow, 0),
          fmtNum(crossing.favorAfter, 0),
        ]),
        { left: [0] },
      )
    : note("no faction crosses the donation threshold on install");
  const chart = hasSeries
    ? `<div id="cadencewrap"><canvas id="cadencechart" class="minichart"></canvas><div id="cadencetip"></div></div>`
    : "";
  return header + chart + crossings;
}

export const bitnodeTab: Tab = {
  id: "progression",
  render(state: ProjectedState) {
    const p = state.topics.progression;
    if (!p) return note("waiting for the gate probe (ns.getResetInfo, ~1 GB, every sweep)");

    const current = BITNODES.find((b) => b.n === p.bitNode);
    const grid =
      `<div class="nodegrid">` +
      BITNODES.map((node) => {
        const level = p.sourceFiles[String(node.n)] ?? 0;
        const isCurrent = node.n === p.bitNode;
        const cls = isCurrent ? "current" : level > 0 ? "done" : "todo";
        const feature = featureForBitNode(node.n);
        return (
          `<div class="node ${cls}" title="${esc(`${node.name} — ${node.tagline}${feature ? `\n${feature.problem}` : ""}`)}">` +
          `<div class="n">BN${node.n}${level > 0 ? `<span class="lvl">${level}</span>` : ""}</div>` +
          `<div class="nm">${esc(node.name)}</div>` +
          `<div class="ft">${esc(feature?.label ?? "—")}</div>` +
          `</div>`
        );
      }).join("") +
      `</div>`;

    const completed = Object.entries(p.sourceFiles).filter(([, level]) => level > 0);
    // Live countdowns follow wall time; replay countdowns follow the scrubbed
    // record time so an old run does not render every forecast as expired.
    const now = state.live ? Date.now() : state.lastT || Date.now();
    // `forecasts` is guarded rather than assumed: a plan recorded before the field
    // existed still has to render. The viewer replays runs from disk, so any field
    // added to a topic is optional in practice however required the type says it is,
    // and one unguarded read takes down the whole tab.
    const forecasts = p.plan?.forecasts
      ? card(
          "Expected next installation",
          forecastCard(p.plan.forecasts.install, now),
        ) + card("Expected BitNode completion", forecastCard(p.plan.forecasts.node, now))
      : card("Time forecasts", note("waiting for the progression planner"));
    // Same guard as the forecasts above, applied once for the whole card: every
    // field it reads was added to the plan after runs already existed on disk, and
    // the viewer replays those runs.
    const lifecycle = p.plan?.queuedAugmentations && p.plan.installBlockers ? p.plan : undefined;
    const installLifecycle = lifecycle
      ? card(
          "Install lifecycle",
          tiles([
            {
              label: "transaction",
              value: lifecycle.installArmedAt !== undefined
                ? "armed"
                : lifecycle.installReady
                  ? "ready — arming"
                  : lifecycle.installWanted
                    ? "preparing"
                    : lifecycle.phase,
              sub: lifecycle.installArmedAt !== undefined
                ? `armed ${fmtTime(Math.max(0, now - lifecycle.installArmedAt))} ago`
                : `wanted ${lifecycle.installWanted ? "yes" : "no"} · ready ${lifecycle.installReady ? "yes" : "no"}`,
            },
            {
              label: "queued augmentations",
              value: String(lifecycle.queuedAugmentations.length),
              sub: lifecycle.queuedAugmentations.join(", ") || "none",
            },
          ]) +
          (lifecycle.installBlockers.length
            ? table(
                ["barrier"],
                lifecycle.installBlockers.map((blocker) => [esc(blocker.kind)]),
                { left: [0] },
              )
            : note(lifecycle.installWanted
                ? "all destructive-reset barriers acknowledged"
                : "install is not economically due yet")),
        )
      : "";
    // Both cards read only optional plan fields (they postdate recorded runs).
    const hasCadenceSeries = state.cadenceAccrued.length >= 2;
    const cadence = p.plan ? card("Install cadence", cadenceCard(p.plan, hasCadenceSeries)) : "";
    const route = p.plan ? card("Endgame route", routeCard(p.plan, now)) : "";
    const summary = tiles([
      { label: "current BitNode", value: current ? `BN${p.bitNode} ${current.name}` : `BN${p.bitNode}` },
      {
        label: "planned next BitNode",
        value: p.plan?.completion ? `BN${p.plan.completion.nextBitNode}` : "–",
        sub: p.plan?.completion?.execute ? "ready to complete" : "central speedrun plan",
      },
      { label: "source files", value: String(completed.length), sub: `${BITNODES.length} nodes exist` },
      { label: "augmentations installed", value: String(p.augCount) },
      { label: "since aug reset", value: p.lastAugReset ? fmtTime(Date.now() - p.lastAugReset) : "–" },
      { label: "since node reset", value: p.lastNodeReset ? fmtTime(Date.now() - p.lastNodeReset) : "–" },
    ]);

    const changed = changedMultipliers(p.multipliers);
    const harder = changed.filter((m) => m.harder).length;
    const multipliers = p.multipliers
      ? changed.length > 0
        ? multiplierGrid(changed)
        : note("this BitNode uses every default multiplier")
      : note("requires SF5 or BN5 — ns.getBitNodeMultipliers is unavailable otherwise");
    const multiplierFilters =
      p.multipliers && changed.length > 0
        ? filters(
            "bitnode.mults",
            [
              { value: "all", label: "all", badge: String(changed.length) },
              { value: "harder", label: "harder", badge: String(harder) },
              { value: "easier", label: "easier", badge: String(changed.length - harder) },
            ],
            "all",
          )
        : "";

    const options = p.bitNodeOptions;
    const flags = options
      ? definitions(
          (
            [
              ["restrict home upgrades", options.restrictHomePCUpgrade],
              ["gang disabled", options.disableGang],
              ["corporation disabled", options.disableCorporation],
              ["bladeburner disabled", options.disableBladeburner],
              ["hacknet server disabled", options.disableHacknetServer],
              ["sleeve exp/augs disabled", options.disableSleeveExpAndAugmentation],
            ] as [string, boolean | undefined][]
          )
            .filter(([, on]) => on)
            .map(([label]) => [label, "on"] as [string, string])
            .concat(
              options.intelligenceOverride !== undefined
                ? [["intelligence override", String(options.intelligenceOverride)]]
                : [],
            ),
        )
      : "";
    const optionsBody =
      options && (flags.includes("<dt>") || Object.keys(options.sourceFileOverrides).length > 0)
        ? flags +
          (Object.keys(options.sourceFileOverrides).length > 0
            ? table(
                ["SF", "forced level"],
                Object.entries(options.sourceFileOverrides).map(([sf, level]) => [`SF${esc(sf)}`, String(level)]),
              )
            : "")
        : note("default BitNode options");

    const needs = (p.needs ?? []).filter((need) => !need.satisfied);
    const waterline = (resource: string, priority: number | undefined): number | undefined =>
      p.arbitration?.waterlines?.find((entry) => entry.resource === resource && entry.priority === priority)?.lambda;
    const arbitrationRows = [
      ...(p.arbitration?.grants ?? []).map((grant) => [
        "granted",
        esc(grant.by),
        esc(grant.id),
        esc(grant.resource),
        grant.resource === "money" ? fmtMoney(grant.amount) : fmtNum(grant.amount, 2),
        fmtNum(grant.priority),
        grant.returnPerDollarSec !== undefined ? fmtNum(grant.returnPerDollarSec, 8) : "–",
        waterline(grant.resource, grant.priority) !== undefined ? fmtNum(waterline(grant.resource, grant.priority), 5) : "–",
        grant.marginalValue !== undefined ? fmtNum(grant.marginalValue, 5) : "–",
      ]),
      ...(p.arbitration?.denied ?? []).map((denial) => [
        `denied: ${esc(denial.reason)}`,
        esc(denial.by),
        esc(denial.id),
        esc(denial.resource),
        denial.resource === "money" ? fmtMoney(denial.wanted) : fmtNum(denial.wanted, 2),
        fmtNum(denial.priority),
        denial.returnPerDollarSec !== undefined ? fmtNum(denial.returnPerDollarSec, 8) : "–",
        waterline(denial.resource, denial.priority) !== undefined ? fmtNum(waterline(denial.resource, denial.priority), 5) : "–",
        "–",
      ]),
    ];
    const coordination =
      (needs.length
        ? table(
            ["urgency", "requested by", "need", "progress", "weight"],
            needs.map((need) => [
              esc(need.urgency),
              esc(need.by),
              esc(`${need.kind}${need.subject ? `: ${need.subject}` : ""}`),
              `${fmtNum(need.have, 1)} / ${fmtNum(need.target, 1)}`,
              fmtNum(need.weight, 2),
            ]),
            { left: [0, 1, 2] },
          )
        : note("no open cross-feature needs")) +
      (arbitrationRows.length
        ? table(["outcome", "feature", "claim", "resource", "amount", "priority", "return/$", "λ", "marginal"], arbitrationRows, { left: [0, 1, 2, 3] })
        : note("no contended resource claims"));

    return (
      `<div class="col wide">` +
      card("Progression", summary + grid) +
      route +
      cadence +
      installLifecycle +
      forecasts +
      card("BitNode multipliers", multipliers, multiplierFilters) +
      `</div>` +
      `<div class="col">` +
      card(
        "Source files",
        completed.length
          ? table(
              ["source file", "level", "theme"],
              completed
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([sf, level]) => [
                  `SF${esc(sf)}`,
                  String(level),
                  esc(featureForBitNode(Number(sf))?.label ?? "—"),
                ]),
            )
          : note("no source files yet"),
      ) +
      card("BitNode options", optionsBody) +
      card("Needs & investment arbiter", coordination) +
      card("RAM arena", arenaBody(p.ramArena)) +
      `</div>`
    );
  },
  mount(state, el) {
    const canvas = el.querySelector<HTMLCanvasElement>("#cadencechart");
    const tooltip = el.querySelector<HTMLElement>("#cadencetip");
    if (!canvas || !tooltip) return;
    drawSeries(
      canvas,
      [
        { pts: state.cadenceAccrued, color: "--series-1", label: "accrued" },
        { pts: state.cadenceThreshold, color: "--series-2", label: "threshold" },
      ],
      state.t0,
      (v) => fmtNum(v, 2),
    );
    // The canvas node is recreated by each render, so its listeners go with
    // it; attaching per mount keeps exactly one set on the live node.
    attachChartHover(canvas, tooltip);
  },
};
