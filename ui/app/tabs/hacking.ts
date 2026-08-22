import type { Server } from "@ns";
import {
  rollPercentile,
  rolledMoney,
  rolledSecurity,
  rootState,
  serverRanges,
  type RootState,
} from "../../../shared/features/servers.ts";
import { bar, card, collapsible, dataTable, dot, filters, hint, meter, note, outcome, rankedTable, search, shownOf, table, tiles, waiting, type Column } from "../lib/dom.ts";
import { inline, raw } from "../lib/html.ts";
import { attachChartHover, drawSeries, type ChartSeries } from "../lib/chart.ts";
import { decisionHistory } from "../lib/history.ts";
import { esc, fmtMoney, fmtMs, fmtNum, fmtPct, fmtRam, fmtTime } from "../lib/format.ts";
import { hackTimeSeconds, makeHackContext, type HackContext } from "../../../shared/formulas.ts";
import { view } from "../lib/viewstate.ts";
import type { BatchAggregateReport, FarmRollup } from "../../../shared/telemetry/topics/hacking.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";
import { contractHosts, serverInspector } from "./hacking-server.ts";

/** Hacking tab: the farm. Dispatcher rollup on top (rates, target, RAM pie),
 * fleet capacity next, per-server detail below.
 *
 * The server table is the panel people actually read, so it answers the three
 * questions a target list is for, in one row each:
 *  - can we take it? — the dot, and the skill it needs, together
 *  - is it prepped? — money against its max, security against its min, both
 *    as meters that turn green at the target rather than as four raw numbers
 *  - is it worth it? — where this save's roll landed in the range the game
 *    generated it from, which is otherwise invisible
 */

interface Row {
  server: Server;
  root: RootState;
  /** Time one hack call takes against this host AT ITS CURRENT SECURITY, in
   * ms. Undefined only when the player record has not arrived yet. Computed
   * here rather than telemetered: the formula is pure and both inputs are
   * already in the projection, so telemetering it would be a per-server field
   * that goes stale the moment the skill ticks. */
  hackTimeMs?: number;
  /** The same call once the host is at MINIMUM security — what the farm will
   * actually see in steady state, and often less than half the current
   * figure on an unprepped host. */
  hackTimeMinMs?: number;
  /** Global number of port-opening programs currently available. */
  portOpeners: number;
  /** Fraction of max money currently on the host. */
  moneyFrac: number;
  atMaxMoney: boolean;
  /** 0 when at minimum security, 1 at the 100 cap. */
  secFrac: number;
  atMinSec: boolean;
  /** Where the world generator's roll landed, when the field is a range. */
  moneyRoll?: number;
  skillRoll?: number;
  secRoll?: number;
  moneyRange?: readonly [number, number];
  securityRange?: readonly [number, number];
}

const ROOT_DOT: Record<RootState, { status: "good" | "ready" | "bad"; label: string }> = {
  rooted: { status: "good", label: "rooted" },
  ready: { status: "ready", label: "can be rooted now" },
  blocked: { status: "bad", label: "not enough skill or port openers yet" },
};

/** The hack-time context, when the projection knows enough to build one.
 *
 * Both halves are needed: the player's own multipliers and the BitNode's. A
 * missing player record means no context at all rather than a default one —
 * hack times computed against skill 0 would be wrong by orders of magnitude
 * and there is no way to mark a number in a table as "computed from nothing". */
function hackContext(state: ProjectedState): HackContext | undefined {
  const player = state.player;
  if (!player?.mults || player.skills?.hacking === undefined) return undefined;
  const node = state.topics.progression?.multipliers;
  return makeHackContext(
    {
      skill: player.skills.hacking,
      intelligence: player.skills.intelligence ?? 0,
      mults: {
        hacking_chance: player.mults.hacking_chance ?? 1,
        hacking_money: player.mults.hacking_money ?? 1,
        hacking_speed: player.mults.hacking_speed ?? 1,
        hacking_exp: player.mults.hacking_exp ?? 1,
        hacking_grow: player.mults.hacking_grow ?? 1,
      },
    },
    {
      ...(node?.["HackingSpeedMultiplier"] !== undefined
        ? { HackingSpeedMultiplier: node["HackingSpeedMultiplier"] }
        : {}),
    },
  );
}

function buildRows(state: ProjectedState): Row[] {
  const skill = state.player?.skills?.hacking ?? 0;
  const openers = state.topics.fleet?.portOpeners ?? 0;
  const mults = state.topics.progression?.multipliers;
  const maxMoneyMult = mults?.["ServerMaxMoney"] ?? 1;
  const startSecMult = mults?.["ServerStartingSecurity"] ?? 1;
  const ctx = hackContext(state);

  return [...state.servers.values()].map((server) => {
    const ranges = serverRanges(server.hostname);
    const max = server.moneyMax ?? 0;
    const money = server.moneyAvailable ?? 0;
    const min = server.minDifficulty ?? 1;
    const current = server.hackDifficulty ?? min;

    const rolled = rolledMoney(server.moneyMax, maxMoneyMult);
    const rolledSec = rolledSecurity(server.baseDifficulty, startSecMult);

    // A host we cannot hack has no meaningful hack time: the formula would
    // still produce a number, but it describes a call the game would refuse.
    const hackable = server.requiredHackingSkill !== undefined && server.requiredHackingSkill <= skill;
    const times = ctx && hackable && server.requiredHackingSkill !== undefined
      ? {
          hackTimeMs: hackTimeSeconds(ctx, current, server.requiredHackingSkill) * 1_000,
          hackTimeMinMs: hackTimeSeconds(ctx, min, server.requiredHackingSkill) * 1_000,
        }
      : {};

    return {
      server,
      root: rootState(server, skill, openers),
      portOpeners: openers,
      ...times,
      moneyFrac: max > 0 ? money / max : 0,
      atMaxMoney: max > 0 && money >= max * 0.999,
      // 100 is the game's hard cap, so the bar spans min..100 and empty means
      // "as weak as this host can be".
      secFrac: Math.max(0, Math.min(1, (current - min) / Math.max(1, 100 - min))),
      atMinSec: current <= min + 0.01,
      ...(rolled !== undefined ? { moneyRoll: rollPercentile(rolled, ranges?.money) } : {}),
      ...(ranges?.money
        ? { moneyRange: [ranges.money[0] * 25 * maxMoneyMult, ranges.money[1] * 25 * maxMoneyMult] as const }
        : {}),
      ...(server.requiredHackingSkill !== undefined
        ? { skillRoll: rollPercentile(server.requiredHackingSkill, ranges?.skill) }
        : {}),
      ...(rolledSec !== undefined ? { secRoll: rollPercentile(rolledSec, ranges?.sec) } : {}),
      ...(ranges?.sec
        ? { securityRange: [Math.min(100, ranges.sec[0] * startSecMult), Math.min(100, ranges.sec[1] * startSecMult)] as const }
        : {}),
    };
  });
}

const COLUMNS: Column<Row>[] = [
  {
    id: "host",
    label: "host",
    left: true,
    sort: (r) => r.server.hostname,
    cell: (r) => {
      const { status, label } = ROOT_DOT[r.root];
      return `<button class="server-link" data-view-key="hacking.selected" ` +
        `data-view-value="${esc(r.server.hostname)}" title="Inspect ${esc(r.server.hostname)}">` +
        `${dot(status, label)}${esc(r.server.hostname)}</button>`;
    },
  },
  {
    id: "skill",
    label: "skill",
    sort: (r) => r.server.requiredHackingSkill ?? 0,
    cell: (r) => {
      const need = r.server.requiredHackingSkill;
      if (need === undefined) return `<span class="muted">–</span>`;
      // Colour matches the dot's reasoning: the number is the reason we cannot
      // take the host, so it should read as the blocker.
      const cls = r.root === "rooted" ? "muted" : r.root === "ready" ? "" : "bad";
      const range = serverRanges(r.server.hostname)?.skill;
      const detail = range
        ? range[0] === range[1]
          ? `fixed at ${fmtNum(range[0])}`
          : `generated range ${fmtNum(range[0])}–${fmtNum(range[1])}${r.skillRoll !== undefined ? `; this save is p${(r.skillRoll * 100).toFixed(0)}` : ""}`
        : `requires hacking skill ${fmtNum(need)}`;
      return `<span class="${cls}" title="${esc(detail)}">${fmtNum(need)}</span>`;
    },
  },
  {
    id: "ports",
    label: "ports req.",
    sort: (r) => r.server.numOpenPortsRequired ?? 0,
    cell: (r) => {
      const required = r.server.numOpenPortsRequired ?? 0;
      const cls = r.portOpeners >= required ? "muted" : "bad";
      return `<span class="${cls}" title="${esc(`${required} required for NUKE; ${r.portOpeners} port-opening programs available globally`)}">${required}</span>`;
    },
  },
  {
    id: "money",
    label: "money",
    sort: (r) => r.server.moneyMax ?? 0,
    cell: (r) => {
      const max = r.server.moneyMax ?? 0;
      if (max <= 0) return `<span class="muted">none</span>`;
      const roll = r.moneyRoll !== undefined ? `; this save is p${(r.moneyRoll * 100).toFixed(0)}` : "";
      const potential = r.moneyRange
        ? `\ngenerated maximum-money range ${fmtMoney(r.moneyRange[0])}–${fmtMoney(r.moneyRange[1])}${roll}`
        : "";
      return meter(
        r.moneyFrac,
        `${fmtMoney(r.server.moneyAvailable)} / ${fmtMoney(max)}`,
        r.atMaxMoney,
        `${fmtPct(r.moneyFrac)} of maximum${potential}`,
      );
    },
  },
  {
    id: "sec",
    label: "security",
    sort: (r) => r.server.hackDifficulty ?? 0,
    cell: (r) => {
      const min = r.server.minDifficulty;
      const current = r.server.hackDifficulty;
      if (min === undefined || current === undefined) return `<span class="muted">–</span>`;
      // The bar EMPTIES as security falls, so "prepped" reads as an empty bar
      // that has gone green — the same visual as a full money bar.
      const roll = r.secRoll !== undefined ? `; this save is p${(r.secRoll * 100).toFixed(0)}` : "";
      const potential = r.securityRange
        ? `\ngenerated starting-security range ${r.securityRange[0].toFixed(1)}–${r.securityRange[1].toFixed(1)}${roll}`
        : "";
      return meter(
        1 - r.secFrac,
        `${current.toFixed(1)} / ${min.toFixed(1)}`,
        r.atMinSec,
        `current ${current.toFixed(2)}, minimum ${min.toFixed(2)}, cap 100${potential}`,
      );
    },
  },
  {
    id: "hacktime",
    label: "hack time",
    sort: (r) => r.hackTimeMs ?? Infinity,
    cell: (r) => {
      if (r.hackTimeMs === undefined) {
        return `<span class="muted" title="${esc("needs root-level skill and a player record to compute")}">–</span>`;
      }
      // The prepped figure is the one the farm's cycle is built on, so it is
      // the one shown when the two differ; the current figure explains a
      // long-looking batch on a host that has not been weakened yet.
      const prepped = r.atMinSec || r.hackTimeMinMs === undefined;
      const shown = prepped ? r.hackTimeMs : r.hackTimeMinMs!;
      const detail = prepped
        ? `one hack call; grow is 3.2x and weaken 4x this (${fmtTime(shown * 4)} per batch cycle)`
        : `at MINIMUM security, which is what the farm will see once prepped.
` +
          `right now, at ${(r.server.hackDifficulty ?? 0).toFixed(1)} security, it is ${fmtTime(r.hackTimeMs)}`;
      return `<span class="${prepped ? "" : "hint"}" title="${esc(detail)}">${fmtTime(shown)}</span>`;
    },
  },
  {
    id: "ram",
    label: "ram · cores",
    sort: (r) => r.server.maxRam ?? 0,
    cell: (r) => {
      const cores = r.server.cpuCores ?? 1;
      const bonus = 1 + (Math.max(1, cores) - 1) / 16;
      const ram = (r.server.maxRam ?? 0) > 0
        ? `${fmtNum(r.server.ramUsed ?? 0)}/${fmtNum(r.server.maxRam)}`
        : "–";
      return `<span title="${esc(`${bonus.toFixed(4)}x grow/weaken effect when scripts run on this host`)}">${ram} · ${fmtNum(cores)}c</span>`;
    },
  },
];

const KINDS = ["hack", "grow", "weaken"] as const;
type Kind = (typeof KINDS)[number];
/** One colour per kind, held together so the bar, the legend and the chart
 * cannot drift apart. */
const KIND_SEG: Record<Kind, string> = { hack: "s1", grow: "s2", weaken: "s3" };
const KIND_SERIES: Record<Kind, string> = { hack: "--series-1", grow: "--series-2", weaken: "--series-3" };

/** Where planner occupancy stops being healthy. The measured baseline of a
 * well-behaved run is ~5% of wall time; the run that produced a 107s mean
 * landing error sat at 60-100%. These are the panel's own thresholds — the
 * driver does not yet enforce a budget, so nothing here can be derived from
 * one. */
const OCCUPANCY_TARGET = 0.2;
const OCCUPANCY_CRITICAL = 0.4;
/** Tick lateness in ms: one engine cycle is 200ms, so a quarter of it is a
 * warning and a full cycle is a cycle the game did not get. */
const LATENESS_WARN_MS = 50;
const LATENESS_CRITICAL_MS = 200;

function occupancyClass(occupancy: number): string {
  if (occupancy >= OCCUPANCY_CRITICAL) return "bad";
  return occupancy > OCCUPANCY_TARGET ? "warn" : "";
}

function latenessClass(meanMs: number): string {
  if (meanMs >= LATENESS_CRITICAL_MS) return "bad";
  return meanMs >= LATENESS_WARN_MS ? "warn" : "";
}

type Pipeline = NonNullable<FarmRollup["pipelines"]>[number];

/** One panel per ACTIVE pipeline, built from what the dispatcher reports it is
 * running rather than from a fixed farm/prep pair.
 *
 * The panel used to hardcode "farm target" and "prepping" as two tiles, which
 * silently assumed there is exactly one of each and that a farm is always a
 * batch cycle. Neither holds: the mode can be hwgw, hgw or shotgun, and a
 * second prep is a pipeline the dispatcher can already fund. Reading the list
 * means a new pipeline kind shows up here without this file changing. */
function pipelinePanels(state: ProjectedState): string {
  const farm = state.topics.farm;
  const pipelines = farm?.pipelines;
  if (!pipelines || pipelines.length === 0) {
    // A run recorded before the pipeline list existed still has the scalars.
    if (!farm?.target && !farm?.prepTarget) return "";
    const legacy = [farm.target ? `farming ${farm.target}` : "", farm.prepTarget ? `prepping ${farm.prepTarget}` : ""];
    return note(legacy.filter(Boolean).join(" · "));
  }
  return `<div class="pipelines">${pipelines.map(pipelinePanel).join("")}</div>`;
}

function pipelinePanel(pipeline: Pipeline): string {
  const inFlight = KINDS.map((kind) => `${kind[0]!.toUpperCase()}${pipeline.inFlight[kind]}`).join(" ");
  const moneyFrac = pipeline.moneyMax ? (pipeline.money ?? 0) / pipeline.moneyMax : undefined;
  const secOver = pipeline.security !== undefined && pipeline.minSecurity !== undefined
    ? pipeline.security - pipeline.minSecurity
    : undefined;

  const head =
    `<div class="pipehead">` +
    `<span class="pipename">${esc(pipeline.host)}</span>` +
    `<span class="pipetag">${esc(pipeline.role)}${pipeline.mode ? ` · ${esc(pipeline.mode)}` : ""}</span>` +
    `<span class="muted">${fmtRam(pipeline.gb)} · ${esc(inFlight)} in flight</span>` +
    `</div>`;

  const vitals =
    (moneyFrac !== undefined
      ? `<div class="piperow"><span class="l">money</span>${meter(
          moneyFrac,
          `${fmtMoney(pipeline.money)} / ${fmtMoney(pipeline.moneyMax)}`,
          moneyFrac >= 0.999,
          `${fmtPct(moneyFrac)} of maximum`,
        )}</div>`
      : "") +
    (secOver !== undefined && pipeline.minSecurity !== undefined
      ? `<div class="piperow"><span class="l">security</span>${meter(
          1 - Math.min(1, secOver / Math.max(1, 100 - pipeline.minSecurity)),
          `${(pipeline.security ?? 0).toFixed(1)} / ${pipeline.minSecurity.toFixed(1)}`,
          secOver <= 0.01,
          `${secOver.toFixed(2)} above minimum`,
        )}</div>`
      : "");

  // A prep's ETA and a farm's cycle answer the same question — "when does this
  // pipeline pay off" — so they occupy the same slot.
  const eta = pipeline.eta;
  const progress = eta
    ? eta.prepped
      ? `<p class="good">prepped — ready to farm</p>`
      : `<p>ready in <b>${fmtTime(eta.seconds * 1_000)}</b> ` +
        `${inline(hint(
          eta.bound === "ram" ? "RAM-bound" : "latency-bound",
          eta.bound === "ram"
            ? "the prep's GB·seconds divided by the GB its segment holds; more RAM finishes it sooner"
            : "one weaken plus the grow/weaken phase — the game's own op durations, which no amount of RAM shortens",
        ))}</p>`
    : pipeline.hackTimeMs !== undefined
      ? `<p class="muted">hack ${fmtMs(pipeline.hackTimeMs)} · weaken ${fmtMs(pipeline.weakenTimeMs)}` +
        `${pipeline.moneyPerSecPerGb !== undefined ? ` · ${fmtMoney(pipeline.moneyPerSecPerGb)}/s/GB` : ""}</p>`
      : "";

  const plan = pipeline.planThreads
    ? `<p class="muted" title="${esc("thread counts the cycle solve chose for one batch")}">plan ` +
      KINDS.map((kind) => `${kind[0]}${fmtNum(pipeline.planThreads![kind])}`).join(" : ") +
      `</p>`
    : "";

  return `<section class="pipe">${head}${vitals}${progress}${plan}</section>`;
}

/** Did the batches land in the order the cycle planned?
 *
 * This is the aggregate that stands in for per-op landing events, which are
 * impossible here — landings run at roughly one per 20 ms. Each batch collapses
 * to one signature, so a healthy farm is a single row at ~100% and a reorder is
 * a second row, with recent examples underneath it. */
function landingOrderCard(state: ProjectedState): string {
  const farm = state.topics.farm;
  const order = farm?.landingOrder;
  if (!order) {
    return waiting(
      "a batch to complete with a verifiable landing order",
      "only a JIT batch lands on a grid; a shotgun wave has no intra-batch order to verify",
    );
  }
  const rows = Object.entries(order.observed).sort(([, a], [, b]) => b - a);
  const inOrder = order.observed[order.planned] ?? 0;
  const breakdown = table(
    ["landed as", "batches", "share", ""],
    [
      ...rows.map(([observed, count]) => [
        `<span class="${observed === order.planned ? "good" : "bad"}">${esc(observed)}</span>`,
        fmtNum(count),
        fmtPct(count / order.batches, 2),
        observed === order.planned ? "as planned" : esc(describeReorder(observed, order.planned)),
      ]),
      ...(order.otherBatches
        ? [[
            `<span class="muted">other</span>`,
            fmtNum(order.otherBatches),
            fmtPct(order.otherBatches / order.batches, 2),
            "rarer orders, not itemised",
          ]]
        : []),
    ],
    { left: [0, 3] },
  );
  const headline = tiles([
    // A tile value is a TEXT slot: it escapes for us, so the signature goes in
    // as prose and the coloured count goes in as deliberate markup.
    { label: "planned order", value: order.planned, sub: "the order the cycle solve intends" },
    {
      label: "landed as planned",
      value: fmtPct(inOrder / order.batches, 2),
      sub: `${fmtNum(order.batches)} complete batches verified`,
    },
    ...(order.incomplete
      ? [{
          label: "no hack launched",
          value: raw(`<span class="bad">${fmtNum(order.incomplete)}</span>`),
          sub: "support landed, nothing stolen",
        }]
      : []),
  ]);
  const anomalies = order.anomalies.length
    ? collapsible(
        "hacking.landingAnomalies",
        `${order.anomalies.length} recent mis-ordered batch(es)`,
        table(
          ["at", "target", "landed as", "planned"],
          [...order.anomalies].reverse().map((entry) => [
            fmtTime(entry.at - (state.t0 ?? 0)),
            esc(entry.target),
            `<span class="bad">${esc(entry.observed)}</span>`,
            esc(entry.planned),
          ]),
          { left: [1, 2, 3] },
        ),
      )
    : "";
  return headline + breakdown + anomalies;
}

/** Name the failure a signature represents, so the row does not ask the reader
 * to diff two strings in their head. */
function describeReorder(observed: string, planned: string): string {
  const seen = observed.split("-");
  const want = planned.split("-");
  if (seen.length < want.length) return `${want.length - seen.length} effect(s) never landed`;
  if (seen.length > want.length) return `${seen.length - want.length} extra effect(s)`;
  const first = seen.findIndex((role, index) => role !== want[index]);
  if (first < 0) return "same order";
  return `${seen[first]} landed where ${want[first]} was due`;
}

/** The farm SEGMENT's thread split and what its cores bought.
 *
 * Deliberately not in a batch column: this is keyed by RAM segment, so it folds
 * every kind funded out of `farm` together and answers a placement question
 * rather than a per-batch one. Two independent readings. The RATIO is a
 * scheduling property: the cycle solve picks it, and it should sit near the
 * plan. The core LEVERAGE is a placement property: the same grow thread does
 * more work on a high-core host, so leverage rising while the grow share falls
 * is the cores paying off, and leverage falling means fragmentation is pushing
 * the placer onto 1-core hosts. */
function allocationDetail(state: ProjectedState): string {
  const farm = state.topics.farm;
  const threads = farm?.allocation?.threads?.["farm"];
  if (!threads) return "";
  const total = KINDS.reduce((sum, kind) => sum + threads[kind], 0);
  if (total <= 0) return "";

  const plan = farm?.pipelines?.find((entry) => entry.role === "farm")?.planThreads;
  const split = bar(KINDS.map((kind) => ({ label: kind, value: threads[kind], className: KIND_SEG[kind] })));

  // Normalised against hack, so the row reads as the shape the cycle is
  // designed around rather than as three unrelated running totals.
  const perHack = (values: { hack: number; grow: number; weaken: number }): string =>
    values.hack > 0 ? KINDS.map((kind) => fmtNum(values[kind] / values.hack, 2)).join(" : ") : "–";

  const effect = farm?.allocation?.effectThreads?.["farm"];
  const rows: string[][] = [
    ["observed (run total)", ...KINDS.map((kind) => fmtNum(threads[kind])), perHack(threads)],
    ...(plan ? [["planned (one batch)", ...KINDS.map((kind) => fmtNum(plan[kind])), perHack(plan)]] : []),
    ...(effect
      ? [[
          "core leverage",
          ...KINDS.map((kind) =>
            threads[kind] > 0
              ? `<span title="${esc(
                  kind === "hack"
                    ? "hack is unaffected by cores; this stays at 1.00 and is the control"
                    : "one-core-equivalent effect divided by the threads launched — what the placer's core choices actually bought",
                )}">${fmtNum(effect[kind] / threads[kind], 3)}x</span>`
              : "–",
          ),
          "",
        ]]
      : []),
  ];

  const ratios = table(["", "hack", "grow", "weaken", "per hack"], rows, { left: [0, 4] });
  const chart = state.allocShare.hack.length >= 2
    ? `<div class="chartwrap"><canvas id="allocchart" class="minichart"></canvas><div class="charttip" id="alloctip"></div></div>`
    : "";
  return collapsible("hacking.allocDetail", "farm segment: planned vs observed, core leverage", split + ratios + chart);
}

/** Batch kinds this run has actually settled, busiest first.
 *
 * Read from the rollup rather than from `BATCH_KINDS`, so a kind the
 * dispatcher grows later needs no change here — and a kind that has settled
 * nothing does not take a column to say zero. */
function activeBatchKinds(state: ProjectedState): [string, BatchAggregateReport][] {
  return Object.entries(state.topics.farm?.batches ?? {})
    .filter(([, entry]) => entry.batches > 0)
    .sort(([, a], [, b]) => b.batches - a.batches);
}

/** A batch kind's canvas id. The kind is a string off the wire, so it is
 * slugged rather than trusted: `morph` keys nodes on `id`, and an id with a
 * space in it would silently stop matching across renders. */
function kindSlug(kind: string): string {
  return kind.replace(/[^a-zA-Z0-9]/g, "-");
}

/** What one batch costs and earns, one column per class of batch.
 *
 * The farm's unit of work is the batch, not the op: a prep wave is a hundred
 * grow threads that steal nothing and a farm cycle is four ops that do, so a
 * global op counter describes neither, and a single blended row describes
 * neither either. Every launch group carries an id and every completion is
 * attributed back through the `opId` it already echoes, which is what makes
 * these per-kind sums possible without sending a record per batch — as
 * impossible as a record per op.
 *
 * A column reads top to bottom as: how many ran, what one costs, the band
 * between what it launched and what landed, how its threads split, and how
 * often it lands in order. */
function batchesCard(state: ProjectedState): string {
  const kinds = activeBatchKinds(state);
  if (kinds.length === 0) return waiting("a batch to settle", "a batch counts once every one of its ops has landed");
  return (
    `<div class="batchgrid">${kinds.map(([kind, entry]) => batchColumn(state, kind, entry)).join("")}</div>` +
    batchHistoryDetail(state) +
    allocationDetail(state)
  );
}

function batchColumn(state: ProjectedState, kind: string, entry: BatchAggregateReport): string {
  const per = (value: number): number => value / entry.batches;
  const slug = kindSlug(kind);

  const head =
    `<div class="pipehead">` +
    `<span class="pipetag">${esc(kind)}</span>` +
    `<span class="pipename">${fmtNum(entry.batches)}</span>` +
    `<span class="muted">batches</span>` +
    `</div>`;

  const series = state.batchSeries[kind];
  // The run mean answers "what does a batch cost"; the windowed figure answers
  // "what does one cost NOW", and the two drifting apart is the finding a
  // cumulative mean is structurally incapable of showing — a target drying out
  // moves the recent number long before it moves the average.
  const recentMoney = series?.moneyPerBatch.at(-1)?.[1];
  const recentRate = series?.perSec.at(-1)?.[1];
  const summary = tiles([
    { label: "ops", value: fmtNum(per(entry.ops), 1), sub: "per batch" },
    { label: "RAM", value: fmtRam(per(entry.gb)), sub: "per batch" },
    { label: "span", value: fmtMs(per(entry.spanMs)), sub: "start to settle" },
    {
      label: "earns",
      value: fmtMoney(per(entry.moneyEarned)),
      sub: recentMoney === undefined ? "per batch, run mean" : `run mean · now ${fmtMoney(recentMoney)}`,
    },
    {
      label: "settling",
      value: recentRate === undefined ? "–" : `${fmtNum(recentRate, 2)}/s`,
      sub: `over ${fmtTime(state.farmWindowMs)}`,
    },
  ]);

  // Totals, not rates: the finding is the BAND between the two curves, and a
  // rate of each would compress it to nothing. See BatchKindSeries.
  const chart = (series?.launched.length ?? 0) >= 2
    ? `<div class="chartwrap"><canvas id="batch-${slug}" class="microchart"></canvas>` +
      `<div class="charttip" id="batchtip-${slug}"></div></div>`
    : note("waiting for a second rollup");

  const lost = entry.ops - entry.landed;
  // Colour-keyed to the two curves. The chart carries no legend at this size,
  // and when nothing is being lost the curves coincide exactly — so without
  // the key there is no way to tell which line you are looking at, or that
  // there are two.
  const band =
    `<p class="muted" title="${esc(
      "ops this kind launched against the ops that arrived. The two curves separating is the finding: " +
        "an op that never lands is a batch dying between dispatch and arrival, visible here long before it becomes a fall in income.",
    )}"><span class="k1">${fmtNum(entry.ops)} launched</span> → ` +
    `<span class="k2">${fmtNum(entry.landed)} landed</span>` +
    (lost > 0 ? ` · <span class="bad">${fmtNum(lost)} lost</span>` : "") +
    (entry.noHack
      ? ` · <span class="bad" title="${esc("support landed with no steal to protect")}">${fmtNum(entry.noHack)} no-hack</span>`
      : "") +
    `</p>`;

  const split = bar(KINDS.map((each) => ({ label: each, value: entry.threads[each], className: KIND_SEG[each] })));
  const threads = `<p class="muted">${KINDS.map((each) => fmtNum(per(entry.threads[each]))).join(" : ")} threads/batch</p>`;

  // A batch with no landing grid has no order to be right about. Which kinds
  // those are is not this panel's business to know — a prep wave has none, a
  // shotgun cycle has none, and the next mode will decide for itself — so the
  // test is whether this kind has ever produced a verdict, not what it is
  // called.
  //
  // Shown as a FRACTION rather than a percentage, because the denominator is
  // every batch of the kind including the ungradeable ones: a bare red "0.0%"
  // asserts that every batch mis-landed, where "0 / 265" invites the reader to
  // notice what is being divided by.
  // Whether this kind lands on a grid at all, reported by the dispatcher
  // rather than inferred from the verdicts: inferring it from
  // `inOrder + noHack > 0` hid the one case worth surfacing, a kind that has
  // a grid and mis-ordered every batch of it.
  // Runs recorded before the dispatcher published it fall back to the old
  // inference, which is right whenever it fires at all.
  const graded = entry.graded !== undefined ? entry.graded > 0 : entry.inOrder + entry.noHack > 0;
  const order = graded
    ? `<p class="${entry.inOrder >= entry.batches ? "good" : "bad"}" title="${esc(
        "batches whose effects landed in the order the cycle planned, out of every batch of this kind. " +
          "A batch launched without a landing grid can never contribute, so this reads low on a kind that only sometimes lands on a grid.",
      )}">${fmtNum(entry.inOrder)} / ${fmtNum(entry.batches)} in order</p>`
    : `<p class="muted" title="${esc(
        "this kind has never produced a landing-order verdict — its batches land as a group with no intended internal sequence",
      )}">no landing grid</p>`;

  return `<section class="batchcol">${head}${summary}${chart}${band}${split}${threads}${order}</section>`;
}

/** Individual settled batches, accumulated far past the eight the rollup carries.
 *
 * The aggregates above say whether the farm is healthy; these say which batch
 * was not, and the accumulated history (ui/app/project.ts) is what makes "which
 * one" answerable more than eight seconds after the fact.
 *
 * SAMPLED, and the summary says so. The rollup's ring holds eight entries and
 * is read once a second, so a farm settling more than eight batches per second
 * overflows it between reads — measured on a real run, 96 of ~965 batches came
 * through. That is a perfectly good sample of what a batch looks like, and a
 * useless denominator; the aggregates above are the denominator. */
function batchHistoryDetail(state: ProjectedState): string {
  const history = state.batchHistory;
  if (history.length === 0) return "";
  const LIMIT = 60;
  // Tail first, THEN reverse: this runs twice a second, and reversing a copy
  // of the whole history to keep sixty rows would copy the other 1,940.
  const shown = history.slice(-LIMIT).reverse();
  return collapsible(
    "hacking.batchHistory",
    hint(
      `${fmtNum(history.length)} batch(es) sampled, newest first`,
      "individual batches caught from the dispatcher's eight-deep ring, read once a second. " +
        "A farm settling faster than that overflows it between reads, so this is a sample of batches, not a count of them — " +
        "the per-kind totals above are the count.",
    ),
    table(
      ["at", "kind", "target", "ops", "span", "earned", "landed as"],
      shown.map((batch) => [
        fmtTime(batch.at - (state.t0 ?? 0)),
        esc(batch.kind),
        esc(batch.target),
        batch.landed === batch.ops
          ? fmtNum(batch.ops)
          : `<span class="bad" title="${esc("an op never landed")}">${fmtNum(batch.landed)}/${fmtNum(batch.ops)}</span>`,
        fmtMs(batch.spanMs),
        fmtMoney(batch.moneyEarned),
        batch.order === undefined
          ? `<span class="muted">no grid</span>`
          : batch.order === batch.planned
            ? `<span class="good">${esc(batch.order)}</span>`
            : `<span class="bad">${esc(batch.order)}</span>`,
      ]),
      { left: [1, 2, 6] },
    ) + (history.length > LIMIT ? shownOf(LIMIT, history.length, "older batches") : ""),
  );
}

/** RAM segments now, and how each segment has spent its share across the ops. */
function ramSegmentsCard(farm: FarmRollup | undefined): string {
  if (!farm?.ramPie) return "";
  const pie = bar([
    { label: "farm", value: farm.ramPie.farm, className: "s1" },
    { label: "prep", value: farm.ramPie.prep, className: "s2" },
    { label: "share", value: farm.ramPie.share, className: "s3" },
    { label: "free", value: farm.ramPie.free, className: "s4" },
    { label: "reserve", value: farm.ramPie.reserve, className: "s5" },
  ]);

  const cross = farm.ramWork?.nativeGbMsBySegmentKind;
  if (!cross) return pie;
  // GB·s is cumulative WORK, not the live segment sizes above: the bar says
  // where the RAM is right now, this says where it has been spent. The two
  // disagree whenever a segment was recently resized, and that disagreement is
  // worth being able to see rather than being averaged away.
  const segments = ["farm", "prep", "share"] as const;
  const rows = segments
    .filter((segment) => cross[segment])
    .map((segment) => {
      const kinds = cross[segment]!;
      const segTotal = KINDS.reduce((sum, kind) => sum + kinds[kind], 0);
      return [
        esc(segment),
        ...KINDS.map((kind) => (segTotal > 0 ? fmtPct(kinds[kind] / segTotal, 1) : "–")),
        fmtNum(segTotal / 1000),
      ];
    });
  return (
    pie +
    collapsible(
      "hacking.ramCross",
      "work spent per segment, by op",
      table(["segment", "hack", "grow", "weaken", "GB·s"], rows, { left: [0] }),
      true,
    )
  );
}

/** Draw one of this tab's mini charts, if its canvas is present and it has
 * something to say. A series with fewer than two points draws nothing (see
 * drawSeries), so an empty chart is silence rather than a misleading flat
 * line at zero. */
function drawMini(
  el: HTMLElement,
  canvasId: string,
  tooltipId: string,
  series: ChartSeries[],
  t0: number | null,
  fmtY: (value: number) => string,
  compact = false,
): void {
  const canvas = el.querySelector<HTMLCanvasElement>(`#${canvasId}`);
  const tooltip = el.querySelector<HTMLElement>(`#${tooltipId}`);
  if (!canvas || !tooltip) return;
  drawSeries(canvas, series, t0, fmtY, { compact });
  attachChartHover(canvas, tooltip);
}

export const hackingTab: Tab = {
  id: "hacking",
  render(state: ProjectedState) {
    const farm = state.topics.farm;
    const fleet = state.topics.fleet;

    // Which host is being farmed and which is being prepped now belongs to the
    // pipeline panels below, which can show any number of either. What is left
    // here is the run-level total that belongs to no single pipeline.
    const farmTiles = farm
      ? tiles([
          { label: "$/sec", value: farm.moneyRate !== undefined ? `${fmtMoney(farm.moneyRate)}/s` : "–" },
          { label: "exp/sec", value: farm.expRate !== undefined ? fmtNum(farm.expRate, 1) : "–" },
          { label: "earned", value: fmtMoney(farm.totals?.moneyEarned) },
          { label: "hacks", value: String(farm.totals?.hacks ?? 0) },
          {
            label: "target solve",
            value: farm.targetSolveExact === undefined ? "–" : farm.targetSolveExact ? "exact" : "heuristic",
            sub: farm.targetSolveExact === undefined
              ? "not reported yet"
              : farm.targetSolveExact ? "whole integer domain searched" : "search was truncated",
          },
        ])
      : "";

    const inFlight = farm?.inFlight;
    const landed = farm?.landed;
    const ops =
      inFlight || landed
        ? table(
            ["op", "in flight", "launched", "landed"],
            (["hack", "grow", "weaken"] as const).map((kind) => [
              esc(kind),
              String(inFlight?.[kind] ?? 0),
              String(farm?.launched?.[kind] ?? 0),
              String(landed?.[kind] ?? 0),
            ]),
          )
        : "";

    const segments = ramSegmentsCard(farm);

    const health =
      farm &&
      (farm.allocFails !== undefined || farm.execFails !== undefined || farm.batchesSkipped !== undefined ||
        // Planner cost belongs here whether or not anything has failed yet:
        // occupancy is the leading indicator, and the failures below it are
        // what occupancy turns into if it is left unread.
        farm.pumpMaxMs !== undefined)
        ? table(
            ["metric", "value"],
            [
              ...(farm.orphanLandings
                ? [[
                    `<span title="${esc(
                      "completions from workers this controller never launched — processes that outlived an install or a reload. " +
                        "Their RAM is spent but not steered, and they are excluded from `landed` so it stays comparable with `launched`.",
                    )}">orphan landings</span>`,
                    `<span class="bad">${fmtNum(farm.orphanLandings)}</span>`,
                  ]]
                : []),
              ["alloc failures", String(farm.allocFails ?? 0)],
              ["exec failures", String(farm.execFails ?? 0)],
              [
                `<span title="${esc(
                  "batches not launched. The by-cause split matters more than the total: arrival-money and " +
                    "arrival-security are the safety brakes working as designed, while deadline and placement " +
                    "mean the pipeline could not be fed.",
                )}">batches skipped</span>`,
                farm.batchesSkippedBy
                  ? `${fmtNum(farm.batchesSkipped ?? 0)} <span class="muted">(${Object.entries(farm.batchesSkippedBy)
                      .filter(([, count]) => count > 0)
                      .map(([cause, count]) => `${esc(cause)} ${fmtNum(count)}`)
                      .join(", ") || "–"})</span>`
                  : String(farm.batchesSkipped ?? 0),
              ],
              // The landing grid's only falsifiable measurement, and it was
              // published but rendered nowhere — so the live reading the two
              // disabled timing tightenings wait on could not be taken by
              // looking at the game. The simulator lands ops exactly on plan,
              // so anything non-trivial here comes from a real run.
              ...(farm.landingError
                ? [[
                    `<span title="${esc(
                      "observed minus planned landing time. Negative is early. A mean far from zero is a biased " +
                        "duration model; a maxAbs above one landing gap means batch effects are reordering.",
                    )}">landing error</span>`,
                    `${farm.landingError.meanMs.toFixed(2)}ms mean` +
                      `<span class="muted"> (${farm.landingError.minMs.toFixed(2)} … ` +
                      `${farm.landingError.maxMs.toFixed(2)}, |max| ` +
                      `${farm.landingError.maxAbsMs.toFixed(2)})</span>`,
                  ]]
                : []),
              ...Object.entries(farm.landingErrorByKind ?? {}).map(([kind, d]) => [
                `<span class="muted">&nbsp;&nbsp;${esc(kind)}</span>`,
                `${d.meanMs.toFixed(2)}ms mean` +
                  `<span class="muted"> (|max| ${d.maxAbsMs.toFixed(2)})</span>`,
              ]),
              // Cost and consequence, adjacent on purpose: the landing error
              // above is what the planner occupancy below produces, one
              // weaken-time later. A live run showed a 107-SECOND mean landing
              // error with nothing here but "worst pump 92ms".
              [
                `<span title="${esc(
                  "main-thread time spent planning, as a share of wall time. The game engine, netscriptDelay and " +
                    "this controller share one timer queue, so past a fifth of it the game itself starts missing " +
                    "deadlines. A healthy run sits near 5%.",
                )}">planner</span>`,
                farm.pumpOccupancy === undefined
                  ? (farm.pumpMaxMs !== undefined ? `${farm.pumpMaxMs.toFixed(1)}ms worst` : "–")
                  : `<span class="${occupancyClass(farm.pumpOccupancy)}">${fmtPct(farm.pumpOccupancy)}</span> of wall` +
                    (farm.pumpMs
                      ? `<span class="muted"> · ${farm.pumpMs.meanMs.toFixed(1)}ms mean · ` +
                        `${farm.pumpMs.maxMs.toFixed(1)}ms worst · ${fmtNum(farm.pumpMs.count)} passes</span>`
                      : ""),
              ],
              ...(farm.wakePumpRate !== undefined
                ? [[
                    "wake pumps",
                    `${farm.wakePumpRate.toFixed(1)}/s` +
                      (farm.wakePumpsSkipped
                        ? `<span class="muted"> · refused ${fmtNum(farm.wakePumpsSkipped.gap)} gap / ` +
                          `${fmtNum(farm.wakePumpsSkipped.frame)} frame</span>`
                        : "") +
                      (farm.weakenWindow
                        ? `<span class="muted" title="${esc(
                            "minimum-security weaken windows, which bypass both throttles",
                          )}"> · ${fmtNum(farm.weakenWindow.pumps)} weaken window</span>`
                        : ""),
                  ]]
                : []),
              ...(farm.engineLatenessMs
                ? [[
                    `<span title="${esc(
                      "how late the controller's own timer reached its deadline. The engine cycle rides the same " +
                        "queue, so this is the ground truth for main-thread starvation.",
                    )}">engine late</span>`,
                    `<span class="${latenessClass(farm.engineLatenessMs.meanMs)}">` +
                      `${farm.engineLatenessMs.meanMs.toFixed(1)}ms mean</span>` +
                      `<span class="muted"> (max ${farm.engineLatenessMs.maxMs.toFixed(0)})</span>`,
                  ]]
                : []),
              ...(farm.ledger
                ? [[
                    `<span title="${esc(
                      "in-flight depth — the independent variable of the planner's cost above",
                    )}">in flight</span>`,
                    `${fmtNum(farm.ledger.tracked)} ops` +
                      `<span class="muted"> · ${fmtNum(farm.ledger.onTarget)} on target · ` +
                      `${fmtNum(farm.ledger.pendingBatches)} pending batches</span>`,
                  ]]
                : []),
            ],
          )
        : "";

    const fleetTiles = fleet
      ? tiles([
          { label: "rooted hosts", value: `${fleet.rootedHosts}`, sub: `of ${fleet.totalHosts} seen` },
          { label: "fleet RAM", value: fmtRam(fleet.maxRam), sub: `${fmtPct(fleet.maxRam ? fleet.usedRam / fleet.maxRam : 0)} used` },
          {
            label: "purchased servers",
            value: `${fleet.purchased.count}${fleet.purchased.limit !== undefined ? ` / ${fleet.purchased.limit}` : ""}`,
            sub: fmtRam(fleet.purchased.totalRam),
          },
          { label: "home", value: fmtRam(fleet.home.maxRam), sub: `${fleet.home.cores} core(s)` },
          {
            label: "script income",
            value: fleet.scriptIncome ? `${fmtMoney(fleet.scriptIncome[0])}/s` : "–",
          },
          { label: "share power", value: fleet.sharePower !== undefined ? fmtNum(fleet.sharePower, 2) : "–" },
        ])
      : waiting("the fleet probe");

    const homeRamPlan = fleet?.homeRamPlan
      ? table(
          ["cost", "adds", "adds $/sec", "payback", "horizon net", "decision"],
          [[
            fmtMoney(fleet.homeRamPlan.cost),
            fmtRam(fleet.homeRamPlan.addedRam),
            fmtMoney(fleet.homeRamPlan.incomePerSec),
            fmtTime(fleet.homeRamPlan.paybackSec * 1000),
            fmtMoney(fleet.homeRamPlan.netOverHorizon),
            fleet.homeRamPlan.worthBuying ? "buy" : "hold",
          ]],
        )
      : "";

    const infrastructurePlan = fleet?.infrastructurePlan
      ? tiles([
          { label: "horizon", value: fmtTime(fleet.infrastructurePlan.horizonSec * 1000) },
          { label: "cash / grant", value: `${fmtMoney(fleet.infrastructurePlan.moneyAvailable)} / ${fmtMoney(fleet.infrastructurePlan.moneyGranted)}` },
          { label: "farm value", value: `${fmtMoney(fleet.infrastructurePlan.incomePerSecPerGb)}/s/GB` },
        ]) +
        (fleet.infrastructurePlan.lastResult ? outcome(fleet.infrastructurePlan.lastResult) : "") +
        (fleet.infrastructurePlan.ranked.length
          ? rankedTable(
              ["option", "adds", "cost", "adds $/sec", "payback", "horizon net", "status"],
              fleet.infrastructurePlan.ranked.map((entry) => [
                esc(entry.kind === "upgradeServer"
                  ? `${entry.host ?? "server"} → ${fmtRam(entry.targetRam)}`
                  : entry.kind === "buyServer"
                    ? `new server ${fmtRam(entry.targetRam)}`
                    : entry.kind === "homeRam"
                      ? `home → ${fmtRam(entry.targetRam)}`
                      : "home core"),
                entry.addedRam === undefined ? "–" : entry.addedRam > 0 ? fmtRam(entry.addedRam) : "+1 core",
                fmtMoney(entry.cost),
                fmtMoney(entry.incomePerSec),
                hint(fmtTime(entry.paybackSec * 1000), `return/$ ${fmtNum(entry.returnPerDollarSec, 8)}`),
                fmtMoney(entry.netOverHorizon),
                entry.worthBuying === true ? "repays" : entry.worthBuying === false ? "past horizon" : "–",
              ]),
              {
                selected: (i) => fleet.infrastructurePlan!.ranked[i]!.selected,
                left: [0, 6],
                shown: fleet.infrastructurePlan.ranked.length,
                total: fleet.infrastructurePlan.rankedTotal,
              },
            )
          : "")
      : "";

    const infrastructureHistory = decisionHistory(state, {
      subsystem: "infrastructure",
      by: "hacking",
      idPrefix: "infrastructure:",
    });

    // --- servers ---
    const all = buildRows(state);
    const activeHosts = new Set([
      ...(farm?.pipelines ?? []).map((pipeline) => pipeline.host),
      ...[farm?.target, farm?.prepTarget].filter((host): host is string => Boolean(host)),
    ]);
    const hostsWithContracts = contractHosts(state);
    const counts = {
      rooted: all.filter((r) => r.root === "rooted").length,
      ready: all.filter((r) => r.root === "ready").length,
      blocked: all.filter((r) => r.root === "blocked").length,
      prepped: all.filter((r) => r.atMaxMoney && r.atMinSec).length,
      active: all.filter((r) => activeHosts.has(r.server.hostname)).length,
      needsPrep: all.filter((r) => r.root === "rooted" && (r.server.moneyMax ?? 0) > 0 && !(r.atMaxMoney && r.atMinSec)).length,
      contracts: all.filter((r) => hostsWithContracts.has(r.server.hostname)).length,
      owned: all.filter((r) => r.server.purchasedByPlayer || r.server.hostname === "home").length,
      busy: all.filter((r) => (r.server.ramUsed ?? 0) > 0).length,
    };
    const mode = view("hacking.servers", "money");
    const needle = view("hacking.search").trim().toLowerCase();
    const selectedName = view("hacking.selected", farm?.target ?? farm?.prepTarget ?? "");
    const rows = all
      .filter((r) => {
        if (needle && !r.server.hostname.toLowerCase().includes(needle)) return false;
        if (mode === "money") return (r.server.moneyMax ?? 0) > 0;
        if (mode === "rooted") return r.root === "rooted";
        if (mode === "active") return activeHosts.has(r.server.hostname);
        if (mode === "needs-prep") return r.root === "rooted" && (r.server.moneyMax ?? 0) > 0 && !(r.atMaxMoney && r.atMinSec);
        if (mode === "contracts") return hostsWithContracts.has(r.server.hostname);
        if (mode === "owned") return r.server.purchasedByPlayer || r.server.hostname === "home";
        if (mode === "busy") return (r.server.ramUsed ?? 0) > 0;
        if (mode === "ready") return r.root === "ready";
        if (mode === "blocked") return r.root === "blocked";
        if (mode === "prepped") return r.atMaxMoney && r.atMinSec;
        return true;
      });

    const selected = all.find((r) => r.server.hostname === selectedName)
      ?? all.find((r) => activeHosts.has(r.server.hostname))
      ?? rows[0]
      ?? all[0];
    const serverControls =
      filters(
        "hacking.servers",
        [
          { value: "money", label: "worth hacking" },
          { value: "rooted", label: "rooted", badge: String(counts.rooted), title: "root access held" },
          { value: "ready", label: "rootable", badge: String(counts.ready), title: "rootable now" },
          { value: "blocked", label: "blocked", badge: String(counts.blocked), title: "needs more skill or port openers" },
          { value: "active", label: "active", badge: String(counts.active), title: "farm or preparation pipeline" },
          { value: "needs-prep", label: "needs prep", badge: String(counts.needsPrep), title: "rooted money server below max money or above min security" },
          { value: "contracts", label: "contracts", badge: String(counts.contracts), title: "queued or quarantined coding contracts" },
          { value: "owned", label: "owned", badge: String(counts.owned), title: "home and purchased servers" },
          { value: "busy", label: "RAM in use", badge: String(counts.busy), title: "server currently using RAM" },
          { value: "prepped", label: "prepped", badge: String(counts.prepped), title: "at max money and min security" },
          { value: "all", label: "all", badge: String(all.length) },
        ],
        "money",
      ) + search("hacking.search", "host…");

    const servers = dataTable("hacking.servers", rows, COLUMNS, {
      defaultSort: { key: "money", dir: -1 },
      empty: "no servers match this filter",
      limit: 120,
      rowClass: (row) => row.server.hostname === selected?.server.hostname ? "picked" : "",
    });

    return (
      // Batches FIRST. The batch is the unit the farm reasons in, and burying
      // it under five tile rows meant you could not see one without scrolling.
      `<div class="col wide">` +
      card("Batches", batchesCard(state)) +
      card(
        "Farm",
        farm
          ? farmTiles + pipelinePanels(state) + ops
          : waiting("the farm rollup", "the dispatcher publishes one per second"),
      ) +
      card("Landing order", landingOrderCard(state)) +
      card("Servers", servers + (selected ? serverInspector(selected, state) : ""), serverControls) +
      `</div>` +
      `<div class="col">` +
      card("Fleet", fleetTiles) +
      (infrastructurePlan ? card("Infrastructure ROI", infrastructurePlan) :
        homeRamPlan ? card("Home RAM investment", homeRamPlan) : "") +
      (infrastructureHistory ? card("Decision history", infrastructureHistory) : "") +
      (segments ? card("RAM segments", segments) : "") +
      (health ? card("Dispatcher health", health) : "") +
      `</div>`
    );
  },

  /** Charts are drawn imperatively after the panel is in the DOM. The canvases
   * survive a re-render now (the viewer patches rather than rebuilds), so
   * `attachChartHover` must be — and is — idempotent. A canvas that is not
   * present (a kind with no series yet) is skipped by drawMini rather than
   * guarded for here.
   *
   * A COLLAPSED disclosure is a different case and is NOT skipped: `<details>`
   * keeps its children, so the canvas is found and measures 0x0, which draws a
   * zero-sized bitmap. Opening one therefore has to re-render (main.ts's
   * `toggle` handler does), or a stored run — which never re-renders on its
   * own — shows the section blank. */
  mount(state, el) {
    for (const [kind] of activeBatchKinds(state)) {
      const series = state.batchSeries[kind];
      if (!series) continue;
      const slug = kindSlug(kind);
      drawMini(
        el,
        `batch-${slug}`,
        `batchtip-${slug}`,
        [
          { pts: series.launched, color: "--series-1", label: "launched" },
          { pts: series.landed, color: "--series-5", label: "landed" },
        ],
        state.t0,
        // A COUNT, not a rate. The band between the two totals is the point.
        (v) => fmtNum(v),
        true,
      );
    }
    drawMini(
      el,
      "allocchart",
      "alloctip",
      KINDS.map((each) => ({ pts: state.allocShare[each], color: KIND_SERIES[each], label: each })),
      state.t0,
      (v) => `${(v * 100).toFixed(0)}%`,
    );
  },
};
