import {
  BITNODES,
  MULTIPLIER_GROUPS,
  changedMultipliers,
  type ChangedMultiplier,
  type MultiplierGroup,
} from "../../../shared/features/bitnode.ts";
import { featureForBitNode } from "../../../shared/features/registry.ts";
import { formatScientific } from "../../../shared/format.ts";
import { chartCanvas, hasSpan, mountChart } from "../lib/chart.ts";
import { ageMs, ago, nowFor } from "../lib/clock.ts";
import { NONE, card, collapsible, definitions, dot, filters, hint, note, rankedTable, table, tiles, waiting, waitingPanel, type Tile } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtTime } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import { view } from "../lib/viewstate.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";
import { forecastAt, type EstimatedForecast, type TimeForecast } from "../../../shared/strategy/progression/forecast.ts";
import type { MarginalResource } from "../../../shared/strategy/progression/marginal.ts";
import {
  BITNODE_SPEEDRUN_PLAN,
  DISABLED_BITNODES,
  STALL_BITNODE_COMPLETION,
} from "../../../shared/strategy/progression/bitnode-order.ts";

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

/** The configured cross-node route, rendered from the same policy data the
 * controller consumes. Disabled nodes stay in-place and current progress is
 * derived from Source-File levels rather than duplicated telemetry. */
function bitNodeRoute(
  currentNode: number | undefined,
  sourceFiles: Readonly<Record<string, number>>,
): string {
  const nextIndex = BITNODE_SPEEDRUN_PLAN.findIndex(
    ({ node, level }) => !DISABLED_BITNODES.has(node) && (sourceFiles[String(node)] ?? 0) < level,
  );
  return (
    `<div class="bnroute-heading"><span>Automation order</span>` +
    (STALL_BITNODE_COMPLETION
      ? `<span class="chip off" title="current controller policy will not dispatch destroyW0r1dD43m0n">completion stalled</span>`
      : "") +
    `</div>` +
    `<div class="bnroute" aria-label="configured BitNode automation order">` +
    BITNODE_SPEEDRUN_PLAN.map(({ node, level }, index) => {
      const held = sourceFiles[String(node)] ?? 0;
      const disabled = DISABLED_BITNODES.has(node);
      const complete = held >= level;
      const current = currentNode === node && !complete;
      const classes = [
        "bnroute-step",
        disabled ? "disabled" : complete ? "complete" : "pending",
        current ? "current" : "",
        index === nextIndex ? "next" : "",
      ].filter(Boolean).join(" ");
      const status = disabled
        ? "disabled in automation"
        : complete
          ? `complete at SF${node}.${held}`
          : current
            ? `current BitNode; targeting SF${node}.${level}`
            : index === nextIndex
              ? "next configured milestone"
              : "pending";
      return `<span class="${classes}" title="${esc(`BN${node} to SF${node}.${level} — ${status}`)}">${node}.${level}</span>`;
    }).join("") +
    `</div>` +
    `<div class="bnroute-key"><span class="complete">complete</span><span class="current">current</span>` +
    `<span class="next">next</span><span class="disabled">disabled</span></div>`
  );
}

function forecastCard(forecast: TimeForecast, now: number): string {
  // A recalibration deadline in the past is "overdue", never "0s": the clamp
  // read as "recalibrating right now" for a planner that stopped 40 minutes ago.
  const review = (at: number): string => (at <= now ? "overdue" : `in ${fmtTime(at - now)}`);
  if (forecast.state === "unknown") {
    return note(`unknown: ${forecast.reason}; next review ${review(forecast.nextRecalibrationAt)}`);
  }
  // `forecastAt` owns the definition of "stale"; the record's own `state` was
  // computed at EMIT time. `progression` republishes only when the planner's
  // 60 s refresh rebuilds the plan, so a refresh that throws freezes an
  // "estimated" forecast on the wire while the run's clock keeps advancing —
  // and the viewer is then the only party that can notice. Re-derive against
  // the clock this panel is actually reading rather than trusting the label.
  const fresh = forecastAt(forecast, now) as EstimatedForecast;
  return (
    tiles([
      {
        label: "remaining",
        value: now > forecast.expectedAt ? "overdue" : fmtTime(fresh.remainingSec * 1_000),
        sub: fresh.state,
      },
      { label: "expected at", value: new Date(forecast.expectedAt).toLocaleString() },
      // The age stays next to the confidence: "stale" says the reading is old,
      // and only this says by how much, which is what makes it actionable.
      { label: "confidence", value: forecast.confidence, sub: `estimated ${fmtTime(Math.max(0, now - forecast.estimatedAt))} ago` },
      { label: "next recalibration", value: forecast.nextRecalibrationAt <= now ? "overdue" : fmtTime(forecast.nextRecalibrationAt - now) },
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
// Both are separate from `progression` because state records republish their
// whole topic and these values change on a faster cadence.
type RamArena = NonNullable<ProjectedState["topics"]["ramArena"]>;
type Route = NonNullable<Plan["routes"]>[number];
type ResourceMarginal = NonNullable<Plan["marginals"]>[MarginalResource];

/** A route's status, worded once for the header tile and the table row.
 *
 * `actionable: false` is a route this CONTROLLER cannot drive, not one the node
 * forbids: `stepEndgame` keeps publishing it (and its gate needs) and excludes
 * it from route choice, then falls back to the merely-available list when that
 * leaves nothing — so it can be the CHOSEN route, which is BN15's labyrinth
 * with automation unavailable. Painting that green "available" asserted a
 * drivable plan; the tile and the cell share this helper so they cannot drift
 * back apart. */
function routeStatus(route: Route): { mark: string; label: string } {
  if (route.complete) return { mark: String(dot("good", "complete")), label: "complete" };
  if (route.actionable === false) {
    return {
      mark: String(dot("wait", "mechanically available, but this controller cannot drive it yet")),
      label: "not drivable",
    };
  }
  if (route.available) return { mark: String(dot("good", "available")), label: "available" };
  return { mark: String(dot("wait", "blocked")), label: "blocked" };
}

/** Ordered labels for the plan's marginals.
 *
 * A LOCAL record rather than an import of `MARGINAL_RESOURCES`: that module
 * runtime-imports the whole route-ETA engine, and the browser bundle should not
 * carry it for a label order. Same reasoning as `GROUP_LABELS` above. */
const MARGINAL_LABELS: Record<MarginalResource, string> = {
  money: "money",
  hacking: "hacking",
  charisma: "charisma",
  reputation: "reputation",
  combat: "combat",
  bladeburnerRank: "bladeburner rank",
  augmentations: "augmentations",
};

/** What would make this BitNode finish sooner: BN-seconds the current plan
 * saves per 100% more of each rate, at the operating point the slope was taken
 * at.
 *
 * This is the exchange rate the arbitration table's `return/$` and `marginal`
 * columns use. An
 * `estimated` zero is a real modelled answer — "the selected plan has no
 * dependency on this resource" — and stays visually distinct from `unknown`,
 * which is an absent observation (shared/strategy/progression/marginal.ts). */
function marginalsBody(marginals: Plan["marginals"]): string {
  if (!marginals) return waiting("the progression planner");
  const rows = (Object.keys(MARGINAL_LABELS) as MarginalResource[]).map((resource) => {
    // Read per resource rather than trusting the total Record: the field
    // postdates runs already on disk and the viewer replays them.
    const entry: ResourceMarginal | undefined = marginals[resource];
    if (!entry) return [esc(MARGINAL_LABELS[resource]), NONE, NONE, NONE, ""];
    return [
      esc(MARGINAL_LABELS[resource]),
      entry.state === "estimated" ? fmtNum(entry.secondsPerRelativeRate, 0) : NONE,
      entry.atRatePerSec === undefined
        ? NONE
        : resource === "money"
          ? `${fmtMoney(entry.atRatePerSec)}/s`
          : `${fmtNum(entry.atRatePerSec, 3)}/s`,
      esc(entry.horizon ?? NONE),
      esc(entry.reason ?? ""),
    ];
  });
  return table(["resource", "BN-seconds / +100% rate", "at rate", "horizon", "note"], rows, {
    left: [0, 3, 4],
    wrap: [4],
  });
}

/** The chosen ending and every route's estimate, with per-part attribution so
 * a wrong total points at the sub-heuristic that produced it. */
function routeCard(plan: Plan, now: number): string {
  if (!plan.routes || plan.routes.length === 0) {
    return waiting("the endgame route estimates");
  }
  const chosen = plan.route;
  const selected = plan.routes.find((route) => route.id === chosen);
  const header = chosen
    ? tiles([
        {
          label: "chosen route",
          value: chosen,
          // Same words as the table row, from one helper: the chosen route can
          // be non-drivable.
          sub: selected
            ? `${Number.isFinite(selected.etaSec) ? fmtTime(selected.etaSec * 1_000) : "∞"} ETA · ${routeStatus(selected).label}`
            : "",
        },
        {
          label: "decided",
          value: plan.decidedAt !== undefined ? `${fmtTime(Math.max(0, now - plan.decidedAt))} ago` : NONE,
        },
      ])
    : note("no route decided yet");
  const sorted = [...plan.routes].sort((a, b) => a.etaSec - b.etaSec);
  const rows = rankedTable(
    // `stage` names the route position the blocker belongs to, so the two read
    // together; NONE when the record predates the field or the stage is empty.
    ["route", "stage", "status", "blocker", "eta"],
    sorted.map((route) => {
      const status = routeStatus(route);
      return [
        esc(route.id),
        esc(route.stage || NONE),
        `${status.mark} ${status.label}`,
        esc(route.blocker || NONE),
        Number.isFinite(route.etaSec) ? fmtTime(route.etaSec * 1_000) : "∞",
      ];
    }),
    { selected: (i) => sorted[i]!.id === chosen, left: [0, 1, 2, 3] },
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
        ) +
          // The gate needs this route still publishes, next to the estimate they
          // price. Plain `have / target` and deliberately no meter: `have` is
          // already flattened to 0 upstream when the probe has not reported
          // (endgame.ts uses `view.bladeburnerRank ?? 0`), so a fraction here
          // would invent precision the wire does not carry.
          (route.needs?.length
            ? table(
                ["need", "have / target"],
                route.needs.map((need) => [
                  esc(`${need.kind}${need.subject ? `: ${need.subject}` : ""}`),
                  `${fmtNum(need.have, 1)} / ${fmtNum(need.target, 1)}`,
                ]),
                { left: [0] },
              )
            : "") +
          (route.nextMandatoryInstall
            ? note(
                `route mechanics require an install in ${fmtTime(route.nextMandatoryInstall.sec * 1_000)} · ` +
                  (route.nextMandatoryInstall.measured ? "measured" : "model/fallback"),
              )
            : "") +
          (route.optionalInstall === false
            ? note("an economic install would set this stage back — only a route-mandatory reset is safe here")
            : ""),
        false,
      ),
    )
    .join("");
  return header + rows + parts;
}

/** The arena: how much RAM is held back from the batcher and which hosts
 * carry it. `largest block` is the biggest reservation, so `largest single
 * call` is the most expensive ns member a resident could currently be given
 * room for — the number to look at when a singularity read is stalling. */
function arenaBody(arena: RamArena | undefined): string {
  if (!arena) return note("the RAM arena has not reported yet");
  return definitions([
    ["hosts", arena.hosts.length ? arena.hosts.map((host: string) => esc(host)).join(", ") : "—"],
    ["arena", `${fmtNum(arena.arenaGb, 1)} GB`],
    ["largest block", `${fmtNum(arena.targetGb, 1)} GB`],
    ["largest single call", `${fmtNum(arena.guaranteedDynamicGb, 1)} GB`],
    ["farm opportunity cost", `${fmtMoney(arena.farmCostPerSec)}/sec`],
  ]);
}

/** The install-vs-push cadence: what has accrued, what it must clear, and
 * which way the dwelled verdict points. The chart draws the two series whose
 * crossing IS the decision. */
function cadenceCard(plan: Plan, hasSeries: boolean): string {
  const decision = plan.installDecision;
  if (!decision) return waiting("the cadence verdict", "needs a route ETA and a factions frontier");
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
      value: decision.threshold !== undefined ? fmtNum(decision.threshold, 2) : NONE,
      // "no push target" is a claim, and a missing pushRate does not support
      // it: `installVerdict` drops the rate both when the frontier concluded
      // there is nothing left to push for (verdict "install") and when it has
      // not run yet or no route ETA exists (verdict "no-data"). Only `verdict`
      // separates the two states.
      sub:
        decision.verdict === "no-data"
          ? "no verdict yet — needs a route ETA and a push rate"
          : decision.pushRate !== undefined
            ? `push rate ${formatScientific(decision.pushRate)}/s`
            : "no push target",
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
  // The threshold above is sqrt(2·overhead·pushRate)·margin, so the overhead is
  // one of its three inputs and the only one this card never showed. It is
  // `max(flat install cost, fitted cold-start replay)` — which of the two won
  // decides whether it is a measurement at all, the same distinction the
  // component tables draw with measured / model-fallback. The exponents beside
  // it are what `factions` prices a deep reputation gap through, so a bad fit
  // is otherwise invisible in the viewer.
  const pace = plan.pace;
  const exponentTip = "cumulative-progress exponent: 1 is a stationary rate, above 1 the run is accelerating";
  const paceDefs = pace
    ? definitions([
        [
          "reset overhead",
          `${fmtTime(pace.resetOverheadSec * 1_000)} · ${
            pace.money !== undefined && pace.money > 1
              ? "cold-start replay, floored at the flat install cost"
              : "flat install cost — no cold-start fit yet"
          }`,
        ],
        [hint("money exponent", exponentTip), pace.money !== undefined ? fmtNum(pace.money, 3) : NONE],
        [hint("hacking exponent", exponentTip), pace.hacking !== undefined ? fmtNum(pace.hacking, 3) : NONE],
        [hint("combat exponent", exponentTip), pace.combat !== undefined ? fmtNum(pace.combat, 3) : NONE],
      ])
    : note("no pace fit on this plan");
  const chart = hasSeries
    ? chartCanvas("cadencechart")
    : note("no cadence timeline yet — accrued and threshold have not been observed at two different times");
  return header + paceDefs + chart + crossings;
}

export const bitnodeTab: Tab = {
  id: "progression",
  render(state: ProjectedState) {
    const p = state.topics.progression;
    if (!p) return waitingPanel("BitNode", "the gate probe", "ns.getResetInfo, ~1 GB, every sweep");

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
    // Every age and countdown on this tab reads the run's own clock: a replay is
    // not now, and a simulated run's stamps are virtual time (lib/clock.ts).
    const now = nowFor(state);
    // `forecasts` is guarded rather than assumed: a plan recorded before the field
    // existed still has to render. The viewer replays runs from disk, so any field
    // added to a topic is optional in practice however required the type says it is,
    // and one unguarded read takes down the whole tab.
    const forecasts = p.plan?.forecasts
      ? card(
          "Expected next installation",
          forecastCard(p.plan.forecasts.install, now),
        ) + card("Expected BitNode completion", forecastCard(p.plan.forecasts.node, now))
      : card("Time forecasts", waiting("the progression planner"));
    // The exchange rate the arbitration table's return/$ and marginal columns
    // are denominated in. Guarded like the forecasts, for the same reason.
    const sensitivity = p.plan ? card("Plan sensitivity", marginalsBody(p.plan.marginals)) : "";
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
                ? `armed ${ago(state, lifecycle.installArmedAt)}`
                : `wanted ${lifecycle.installWanted ? "yes" : "no"} · ready ${lifecycle.installReady ? "yes" : "no"}`,
            },
            {
              label: "queued augmentations",
              value: String(lifecycle.queuedAugmentations.length),
              sub: lifecycle.queuedAugmentations.join(", ") || "none",
            },
            // The opposite money regime, and a FORECAST rather than a failure:
            // augs, favor and cash all die with the node, so install-shaped
            // reserves release. Deliberately fail-open upstream — if the node
            // does not end, the freed money bought productive RAM — so it is not
            // painted red, and it is shown only when the field is actually true
            // (the producer spreads it only then, and older runs never had it).
            ...(lifecycle.endingByDestroy === true
              ? [{
                  label: "node ending",
                  value: html`${dot("ready", "forecast: the node ends by destroy, with no install first")} by destroy`,
                  sub: "forecast: no install planned — aug-fund and donation reserves released",
                }]
              : []),
          ]) +
          definitions([
            [
              // Route mechanics forcing the reset is why the cadence verdict can
              // read "push" beside an armed install. Absent stays absent: an old
              // record must not be coerced into "economic".
              "reset cause",
              lifecycle.routeInstallRequired === true
                ? "route-mandatory"
                : lifecycle.routeInstallRequired === false
                  ? "economic"
                  : NONE,
            ],
            [
              // An ORDER, not market behaviour: `stock` only converts the book
              // when every remaining blocker is `stock`/`augmentations`
              // (game/lib/features/stock.ts), and progression ordering a
              // liquidation for an install it never performed is a real
              // incident (spec/progress.md). Saying "liquidating" here while
              // the stock tab says "trade" would be the same bug again.
              "liquidation",
              lifecycle.liquidationWanted === true
                ? lifecycle.installBlockers.every((blocker) => blocker === "stock" || blocker === "augmentations")
                  ? "ordered · stock may convert the book"
                  : "ordered · market still trading (a non-stock barrier stands)"
                : lifecycle.liquidationWanted === false
                  ? "not ordered"
                  : NONE,
            ],
            [
              // The rep-met, jointly affordable set whose value ARMED an
              // optional install — frozen so execution cannot substitute a
              // different one, and disjoint from `queuedAugmentations` (which is
              // only what is already bought). Published only for an optional
              // install, so `undefined` means "not published", NOT "none".
              "funded augmentations",
              lifecycle.installFundedAugmentations === undefined
                ? NONE
                : lifecycle.installFundedAugmentations.length
                  ? esc(lifecycle.installFundedAugmentations.join(", "))
                  : "none funded",
            ],
          ]) +
          (lifecycle.installBlockers.length
            ? table(
                ["barrier"],
                lifecycle.installBlockers.map((blocker) => [esc(blocker)]),
                { left: [0] },
              )
            : note(lifecycle.installWanted
                ? "all destructive-reset barriers acknowledged"
                : "install is not economically due yet")),
        )
      : "";
    // Both cards read only optional plan fields (they postdate recorded runs).
    // A game run mirrors the whole plan in one flush, so two points at the same
    // millisecond is the common case and a point count would pass it while there
    // is still nothing to draw.
    const hasCadenceSeries = hasSpan(state.cadenceAccrued, state.cadenceThreshold);
    const cadence = p.plan ? card("Install cadence", cadenceCard(p.plan, hasCadenceSeries)) : "";
    const route = p.plan ? card("Endgame route", routeCard(p.plan, now)) : "";
    // `completion` exists ONLY once the selected route is mechanically finished,
    // so its presence already says "the node can be ended now" — and the states
    // inside it are not interchangeable. Without SF4 (and outside BN4) the driver
    // never arms anything and the run waits for a human to click
    // destroyW0r1dD43m0n. `ready` is not tested: the
    // producer hardcodes it true whenever the object exists.
    const completion = p.plan?.completion;
    const completionTile: Tile = completion
      ? {
          label: "planned next BitNode",
          value: html`${dot(completion.execute ? "good" : "ready")} BN${completion.nextBitNode}`,
          sub:
            (completion.stalled === true
              ? "route complete — automatic BitNode completion is stalled"
              : completion.execute
                ? "destroying node — destroyW0r1dD43m0n dispatched"
                : completion.armedAt !== undefined
                  ? `route complete — armed ${ago(state, completion.armedAt)}`
                  : completion.automatic
                    ? "route complete — arming"
                    : "route complete — destroyW0r1dD43m0n needs a human (no SF4)")
            + ` · to SF${completion.nextBitNode} level ${completion.targetLevel}`,
        }
      : { label: "planned next BitNode", value: NONE, sub: "central speedrun plan" };
    const augAge = p.lastAugReset ? ageMs(state, p.lastAugReset) : undefined;
    const nodeAge = p.lastNodeReset ? ageMs(state, p.lastNodeReset) : undefined;
    const summary = tiles([
      { label: "current BitNode", value: current ? `BN${p.bitNode} ${current.name}` : `BN${p.bitNode}` },
      completionTile,
      { label: "source files", value: String(completed.length), sub: `${BITNODES.length} nodes exist` },
      { label: "augmentations installed", value: String(p.augCount) },
      // Both ages read the same clock as every forecast above, so a replayed run
      // reports the age it had at the scrub cutoff instead of one that grows
      // with wall time. `ageMs` also clamps: a sim log stamps records with a
      // 0-based virtual clock while these timestamps come off the virtual Date
      // epoch, and the raw difference formats as thousands of negative days.
      { label: "since aug reset", value: augAge !== undefined ? fmtTime(augAge) : NONE },
      { label: "since node reset", value: nodeAge !== undefined ? fmtTime(nodeAge) : NONE },
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
    const overrides = Object.entries(options?.sourceFileOverrides ?? {});
    const flagPairs: [string, string][] = options
      ? (
          [
            ["restrict home upgrades", options.restrictHomePCUpgrade],
            ["gang disabled", options.disableGang],
            ["corporation disabled", options.disableCorporation],
            ["bladeburner disabled", options.disableBladeburner],
            // Named for BOTH rungs on purpose: this flag blocks the $1b
            // exchange data AND the $25b TIX forecast API, so "4S market data
            // disabled" would read as "the forecast API is still reachable".
            // It is also the reason the stock tab's forecast path is
            // permanently unavailable on this run — affordability is not.
            ["4S data + TIX API disabled", options.disable4SData],
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
          )
      : [];
    // Guard on the DATA, not on the rendered markup: `definitions([])` returns
    // note("no data"), so sniffing the generated `<dt>` printed "no data"
    // directly above a populated source-file override table on the ordinary
    // overrides-only run (forced SF levels, every boolean left alone).
    const optionsBody =
      flagPairs.length || overrides.length
        ? (flagPairs.length ? definitions(flagPairs) : "") +
          (overrides.length
            ? table(
                ["SF", "forced level"],
                overrides.map(([sf, level]) => [`SF${esc(sf)}`, String(level)]),
              )
            : "")
        : note("default BitNode options");

    return (
      `<div class="col wide">` +
      card("Progression", summary + bitNodeRoute(p.bitNode, p.sourceFiles) + grid) +
      route +
      cadence +
      installLifecycle +
      forecasts +
      sensitivity +
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
      // The needs/arbitration view moved to the arbiter drawer (ui/app/lib/
      // arbiter.ts): resource decisions are cross-feature, so they are
      // reachable from every tab rather than parked on this one.
      card("RAM arena", arenaBody(state.topics.ramArena)) +
      `</div>`
    );
  },
  mount(state, el) {
    mountChart(
      el,
      "cadencechart",
      [
        { pts: state.cadenceAccrued, color: "--series-1", label: "accrued" },
        { pts: state.cadenceThreshold, color: "--series-2", label: "threshold" },
      ],
      state.t0,
      (v) => fmtNum(v, 2),
    );
  },
};
