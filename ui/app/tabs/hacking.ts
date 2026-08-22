import type { Server } from "@ns";
import {
  rollPercentile,
  rolledMoney,
  rolledSecurity,
  rootState,
  serverRanges,
  type RootState,
} from "../../../shared/features/servers.ts";
import { bar, card, collapsible, dataTable, dot, filters, hint, meter, NONE, note, outcome, rankedTable, search, table, tiles, waiting, type Column } from "../lib/dom.ts";
import { inline, raw, type Html } from "../lib/html.ts";
import { chartCanvas, mountChart, type ChartSeries } from "../lib/chart.ts";
import { decisionHistory } from "../lib/history.ts";
import { esc, fmtMoney, fmtMs, fmtNum, fmtPct, fmtRam, fmtTime } from "../lib/format.ts";
import { hackTimeSeconds, makeHackContext, type HackContext } from "../../../shared/formulas.ts";
import { view } from "../lib/viewstate.ts";
import type { BatchAggregateReport, FarmRollup } from "../../../shared/telemetry/topics/hacking.ts";
import type { FarmHealthSeries, ProjectedState, SettledBatchView } from "../project.ts";
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
  const chart = state.allocShare.hack.length >= 2 ? chartCanvas("allocchart") : "";
  return collapsible("hacking.allocDetail", "farm segment: planned vs observed, core leverage", split + ratios + chart);
}

/** Batch kinds this run has actually run, busiest first.
 *
 * Read from the rollup rather than from `BATCH_KINDS`, so a kind the
 * dispatcher grows later needs no change here — and a kind that has done
 * nothing does not take a column to say zero.
 *
 * A kind with no SETTLED batches still counts if it abandoned any. That is a
 * mode which is running and failing every batch it starts, which is the single
 * most important thing this card can say — and testing `batches > 0` alone
 * dropped it, rendering it identically to a mode the save has never used. */
function activeBatchKinds(state: ProjectedState): [string, BatchAggregateReport][] {
  return Object.entries(state.topics.farm?.batches ?? {})
    .filter(([, entry]) => entry.batches > 0 || (entry.abandoned ?? 0) > 0)
    .sort(([, a], [, b]) => b.batches - a.batches);
}

/** Metrics the per-batch timeline can plot.
 *
 * Batches are not comparable as they arrive, which is the whole reason this
 * view exists: a prep wave is a hundred grow threads that steal nothing and a
 * HWGW cycle is four ops that do, so ranking them on raw `moneyEarned` ranks
 * them by size. The default is therefore a RATE — what one batch earned per GB
 * it occupied per second it held it — which asks both the same question. The
 * raw totals stay available, because "which batch was expensive" is also a real
 * question; it is just a different one. */
interface BatchMetric {
  label: string;
  title: string;
  value(batch: SettledBatchView): number;
  fmt(value: number): string;
  /** Scale to the band rather than to zero. Right for a quantity whose spread
   * is the reading (a span, a rate); wrong for one whose magnitude is. */
  fit: boolean;
}

const BATCH_METRICS: Record<string, BatchMetric> = {
  rate: {
    label: "$/GB·s",
    title: "money earned per GB-second the batch occupied — size-normalised, so a prep wave and a farm cycle are comparable",
    value: (batch) => batch.moneyPerGbSec,
    fmt: (value) => fmtMoney(value),
    fit: true,
  },
  money: {
    label: "$/batch",
    title: "money this batch earned outright — ranks by batch size, which is sometimes the question",
    value: (batch) => batch.moneyEarned,
    fmt: (value) => fmtMoney(value),
    fit: false,
  },
  span: {
    label: "span",
    title: "start to settle. A pipeline slipping shows up here before it shows up in income",
    value: (batch) => batch.spanMs,
    fmt: (value) => fmtMs(value),
    fit: true,
  },
  threads: {
    label: "threads",
    title: "threads across all of the batch's ops — its size",
    value: (batch) => batch.totalThreads,
    fmt: (value) => fmtNum(value),
    fit: false,
  },
};

const BATCH_METRIC_ORDER = ["rate", "money", "span", "threads"] as const;
const DEFAULT_BATCH_METRIC = "rate";

function batchMetric(): BatchMetric {
  const key = view("hacking.batchMetric", DEFAULT_BATCH_METRIC);
  return BATCH_METRICS[key] ?? BATCH_METRICS[DEFAULT_BATCH_METRIC]!;
}

/** How a settled batch landed, which is what the timeline colours by. */
type BatchVerdict = "ordered" | "misordered" | "ungraded";

function verdictOf(batch: SettledBatchView): BatchVerdict {
  if (batch.order === undefined) return "ungraded";
  return batch.misordered ? "misordered" : "ordered";
}

const VERDICTS: { verdict: BatchVerdict; color: string; label: string; title: string }[] = [
  {
    verdict: "ordered",
    color: "--series-1",
    label: "in order",
    title: "landed in the order the cycle planned",
  },
  {
    verdict: "misordered",
    color: "--series-4",
    label: "mis-ordered",
    title: "had a landing grid and landed out of order — the effects fought each other",
  },
  {
    verdict: "ungraded",
    color: "--series-2",
    label: "no grid",
    title: "no landing grid to be right about — a prep wave, a shotgun cycle, or a batch that never launched a hack",
  },
];

/** The `kN` class that colours prose to match a `--series-N` stroke.
 *
 * Derived rather than restated: app.css defines `kN` as `var(--series-N)`, so a
 * legend that hard-codes its own class alongside its own colour is two facts
 * that can drift, and did — a `.k2` pinned to `--series-5` is what made the
 * launched/landed key describe the wrong curve. */
function seriesKey(color: string): string {
  return `k${color.slice("--series-".length)}`;
}

/** The timeline's series: one point per settled batch, split by verdict.
 *
 * POINTS, not a line. Each sample is a different batch, so joining them would
 * assert a continuity between neighbours that does not exist — and the shape of
 * the zig-zag would be an artefact of the order they happened to settle in.
 *
 * Shared by `render` and `mount` so the two cannot disagree about what is on
 * the chart. */
function batchTimelineSeries(state: ProjectedState): ChartSeries[] {
  const metric = batchMetric();
  const byVerdict = new Map<BatchVerdict, [number, number][]>();
  for (const batch of state.batchHistory) {
    const value = metric.value(batch);
    if (!Number.isFinite(value)) continue;
    const verdict = verdictOf(batch);
    let pts = byVerdict.get(verdict);
    if (!pts) byVerdict.set(verdict, (pts = []));
    pts.push([batch.at, value]);
  }
  return VERDICTS
    .map((entry) => ({
      pts: byVerdict.get(entry.verdict) ?? [],
      color: entry.color,
      label: entry.label,
      kind: "points" as const,
    }))
    // `drawSeries` discards a series with fewer than two points, so anything
    // shorter is not on the chart and must not be in the legend either: a key
    // for a mark that was never drawn sends the reader hunting for it.
    .filter((series) => series.pts.length >= 2);
}

/** The per-kind aggregates added up. Two panels need these sums — the run-level
 * tiles and the sampling note's census — and summing them in each was how the
 * two drifted the last time. */
interface BatchTotals {
  settled: number;
  abandoned: number;
  /** Ops the abandoned batches launched and never landed. */
  opsLost: number;
}

function batchTotals(state: ProjectedState): BatchTotals {
  let settled = 0;
  let abandoned = 0;
  let opsLost = 0;
  for (const [, entry] of activeBatchKinds(state)) {
    settled += entry.batches;
    abandoned += entry.abandoned ?? 0;
    opsLost += (entry.abandonedOps ?? 0) - (entry.abandonedLanded ?? 0);
  }
  return { settled, abandoned, opsLost };
}

/** Run-level throughput and earnings, and the loss curve.
 *
 * The aggregates a per-batch view still needs: no scatter answers "is the farm
 * earning" at a glance. Deliberately short — five tiles and one chart — because
 * the batch is what this card is about. */
function throughputStrip(state: ProjectedState): string {
  const farm = state.topics.farm;
  // `opsLost` here is the ops the abandoned batches took with them. A batch
  // only settles once its last op lands, so an abandoned batch is the ONLY
  // place a lost op is ever counted.
  const { settled, abandoned, opsLost } = batchTotals(state);
  let perSec = 0;
  for (const series of Object.values(state.batchSeries)) perSec += series.perSec.at(-1)?.[1] ?? 0;
  const residual = state.farmHealth.opsLost.at(-1)?.[1];

  const strip = tiles([
    { label: "$/sec", value: farm?.moneyRate !== undefined ? `${fmtMoney(farm.moneyRate)}/s` : NONE },
    {
      label: "settling",
      value: perSec > 0 ? `${fmtNum(perSec, 2)}/s` : NONE,
      sub: `over ${fmtTime(state.farmWindowMs)}`,
    },
    { label: "settled", value: fmtNum(settled), sub: "batches, this install" },
    {
      label: "abandoned",
      value: abandoned > 0 ? raw(`<span class="bad">${fmtNum(abandoned)}</span>`) : "0",
      sub: abandoned > 0 ? `${fmtNum(opsLost)} ops never arrived` : "every batch settled",
    },
    {
      label: "ops adrift",
      value: residual === undefined
        ? NONE
        : residual > 0 ? raw(`<span class="bad">${fmtNum(residual)}</span>`) : "0",
      sub: "launched, not in flight, never landed",
    },
  ]);

  // A magnitude, so the axis keeps zero: zero adrift is the healthy reading and
  // the distance from it is the finding.
  const chart = state.farmHealth.opsLost.length >= 2
    ? chartCanvas("ops-lost", "micro") +
      note(hint(
        raw(`<span class="k4">ops adrift</span> over time`),
        "launched minus landed minus in flight. Subtracting the in-flight gauge is what makes this loss rather than " +
          "pipeline depth: at steady state most of the launched/landed gap is simply work still on its way. " +
          "A curve that climbs and stays up is the farm losing ops.",
      ))
    : "";
  return strip + chart;
}

/** One mark per settled batch — the card's primary view.
 *
 * This is the unit the farm reasons in, and the unit its health lives at. The
 * per-kind aggregates below are a summary of these, and summarising is exactly
 * what hides the finding: batches within one kind differ by orders of magnitude
 * in size, so a run-cumulative mean per kind reports a number no individual
 * batch resembles. A scatter shows the spread, and the outlier is the batch
 * worth looking at. */
function batchTimeline(state: ProjectedState): string {
  const history = state.batchHistory;
  const metric = batchMetric();
  const chips = filters(
    "hacking.batchMetric",
    BATCH_METRIC_ORDER.map((key) => ({
      value: key,
      label: BATCH_METRICS[key]!.label,
      title: BATCH_METRICS[key]!.title,
    })),
    DEFAULT_BATCH_METRIC,
  );
  if (history.length < 2) {
    return chips + note(
      state.compacted
        ? "this run was served compacted — its per-batch history is not recoverable, only the final rollup"
        : "waiting for a second batch to settle",
    );
  }

  const shown = batchTimelineSeries(state);
  const legend =
    `<div class="barkey">` +
    VERDICTS.filter((entry) => shown.some((series) => series.label === entry.label))
      .map((entry) =>
        `<span class="${seriesKey(entry.color)}" title="${esc(entry.title)}">●</span>` +
        `<span class="muted">${esc(entry.label)}</span>`
      )
      .join("") +
    `</div>`;

  return chips + chartCanvas("batch-timeline", "full") + legend + note(samplingNote(state));
}

/** What the history is a sample OF, stated wherever the sample is shown.
 *
 * The rollup carries a bounded ring of recently settled batches and is read
 * once a second, so a farm settling faster than the ring is deep overflows it
 * between reads. Every figure derived from the history is therefore a sample —
 * and the per-kind totals beside it are a census, which is exactly the pair of
 * numbers most likely to be silently compared. */
function samplingNote(state: ProjectedState): Html {
  const { settled } = batchTotals(state);
  const sampled = state.batchHistory.length;
  // No census to divide by. Still a sample, and still says so: the count is the
  // one number here that must never be read as a total.
  if (settled <= 0) {
    return hint(
      `${fmtNum(sampled)} batch(es) sampled`,
      "individual batches caught from the dispatcher's bounded ring, read once a second — a sample of batches, not " +
        "a count of them. The per-kind totals that would say how many actually settled are not in this rollup.",
    );
  }
  return hint(
    `${fmtNum(sampled)} of ${fmtNum(settled)} batches sampled (${fmtPct(Math.min(1, sampled / settled), 1)})`,
    "individual batches are caught from the dispatcher's bounded ring, read once a second. A farm settling faster " +
      "than that overflows the ring between reads, so this is a sample of batches, not a count of them — the " +
      "per-kind totals are the count. The sample is unbiased in what a batch LOOKS like and useless as a denominator.",
  );
}

/** Everything known about one batch, when the operator picks it.
 *
 * The aggregates say whether the farm is healthy; this says what happened to
 * the batch that was not — including how far from its own kind's middle it sat,
 * which is the reading that makes a single batch mean anything. */
function batchInspector(state: ProjectedState): string {
  const id = view("hacking.batch");
  if (id === "") return "";
  const batch = state.batchHistory.find((entry) => String(entry.id) === id);
  if (!batch) {
    return note(hint(
      `batch ${esc(id)} is no longer held`,
      "the history is bounded, and an install clears it — the batch has aged out of the retained window",
    ));
  }
  const metric = batchMetric();
  // Its own kind is the only fair comparison, and the MEDIAN rather than the
  // mean: the distribution has a long tail (a batch that lost its window earns
  // nothing at all), and a mean sits inside that tail rather than in the body.
  const peers = state.batchHistory
    .filter((entry) => entry.kind === batch.kind)
    .map((entry) => metric.value(entry))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const median = peers.length > 0 ? peers[Math.floor(peers.length / 2)]! : undefined;
  const value = metric.value(batch);
  const versus = median === undefined || median === 0
    ? undefined
    : `${fmtNum(value / median, 2)}x its kind's median`;

  const head = tiles([
    { label: "batch", value: `#${fmtNum(batch.id)}`, sub: batch.kind },
    { label: "target", value: batch.target },
    { label: "settled", value: fmtTime(batch.at - (state.t0 ?? 0)), sub: `span ${fmtMs(batch.spanMs)}` },
    { label: "earned", value: fmtMoney(batch.moneyEarned), sub: `${fmtRam(batch.gb)} committed` },
    { label: metric.label, value: metric.fmt(value), ...(versus ? { sub: versus } : {}) },
  ]);

  const split = bar(KINDS.map((each) => ({ label: each, value: batch.threads[each], className: KIND_SEG[each] })));
  const threads = note(`${KINDS.map((each) => fmtNum(batch.threads[each])).join(" : ")} threads · ${fmtNum(batch.ops)} ops`);

  const order = batch.order === undefined
    ? note(hint("no landing grid", "lands as a group, with no intended internal order to be right about"))
    : batch.misordered
      ? `<p class="bad" title="${esc("the effects landed in a different order from the one the cycle planned")}">` +
        `landed <b>${esc(batch.order)}</b>, planned <b>${esc(batch.planned ?? "")}</b></p>`
      : `<p class="good">landed <b>${esc(batch.order)}</b>, as planned</p>`;

  return collapsible(
    "hacking.batchDetail",
    `batch #${fmtNum(batch.id)} — ${batch.kind} on ${batch.target}`,
    head + split + threads + order,
    true,
  );
}

/** The sampled batches as a sortable table, so "which was worst" is one click.
 *
 * Sortable rather than newest-first because the question is almost never "what
 * happened last" — it is "what was the worst one", and on a scatter you can see
 * an outlier but not read it. */
function batchHistoryDetail(state: ProjectedState): string {
  const history = state.batchHistory;
  if (history.length === 0) return "";
  const selected = view("hacking.batch");
  const columns: Column<SettledBatchView>[] = [
    {
      id: "at",
      label: "at",
      left: true,
      sort: (batch) => batch.at,
      cell: (batch) =>
        `<button class="server-link" data-view-key="hacking.batch" data-view-value="${batch.id}" ` +
        `title="Inspect batch ${batch.id}">#${fmtNum(batch.id)}</button>` +
        ` <span class="muted">${fmtTime(batch.at - (state.t0 ?? 0))}</span>`,
    },
    { id: "kind", label: "kind", left: true, sort: (batch) => batch.kind, cell: (batch) => esc(batch.kind) },
    { id: "target", label: "target", left: true, sort: (batch) => batch.target, cell: (batch) => esc(batch.target) },
    { id: "ops", label: "ops", sort: (batch) => batch.ops, cell: (batch) => fmtNum(batch.ops) },
    { id: "threads", label: "threads", sort: (batch) => batch.totalThreads, cell: (batch) => fmtNum(batch.totalThreads) },
    { id: "span", label: "span", sort: (batch) => batch.spanMs, cell: (batch) => fmtMs(batch.spanMs) },
    { id: "earned", label: "earned", sort: (batch) => batch.moneyEarned, cell: (batch) => fmtMoney(batch.moneyEarned) },
    {
      // The same reading the timeline defaults to, so the two cannot disagree
      // about what "$/GB·s" means.
      id: "rate",
      label: BATCH_METRICS.rate!.label,
      sort: (batch) => BATCH_METRICS.rate!.value(batch),
      cell: (batch) => BATCH_METRICS.rate!.fmt(BATCH_METRICS.rate!.value(batch)),
    },
    {
      id: "order",
      label: "landed as",
      left: true,
      sort: (batch) => batch.order ?? "",
      cell: (batch) =>
        batch.order === undefined
          ? `<span class="muted">no grid</span>`
          : batch.misordered
            ? `<span class="bad" title="${esc(`planned ${batch.planned ?? ""}`)}">${esc(batch.order)}</span>`
            : `<span class="good">${esc(batch.order)}</span>`,
    },
  ];
  return collapsible(
    "hacking.batchHistory",
    samplingNote(state),
    dataTable("hacking.batches", history, columns, {
      defaultSort: { key: "at", dir: -1 },
      empty: "no batches sampled yet",
      limit: 80,
      rowClass: (batch) => String(batch.id) === selected ? "picked" : "",
    }),
  );
}

/** Per-kind sums, demoted to a disclosure.
 *
 * Still worth having — "what does a prep wave cost against a farm cycle" is a
 * per-kind question and nothing else answers it — but no longer the headline.
 * A cumulative mean per kind is a number no individual batch resembles, which
 * is what put the per-batch view above it.
 *
 * The launched-against-landed chart these columns used to carry is GONE. Those
 * two counters are equal by construction: a batch settles only once its last op
 * lands, so the per-kind sums of `ops` and `landed` never differ and the chart
 * drew one curve twice. Loss is `abandoned` here, and the adrift curve above. */
function perKindDetail(state: ProjectedState, kinds: [string, BatchAggregateReport][]): string {
  if (kinds.length === 0) return "";
  return collapsible(
    "hacking.batchKinds",
    `per-kind totals — ${kinds.map(([kind]) => kind).join(", ")}`,
    `<div class="batchgrid">${kinds.map(([kind, entry]) => batchColumn(state, kind, entry)).join("")}</div>`,
  );
}

function batchColumn(state: ProjectedState, kind: string, entry: BatchAggregateReport): string {
  // A kind can reach this column having settled NOTHING — that is exactly the
  // case `activeBatchKinds` was widened to admit. `0/0` is NaN, which every
  // formatter renders as an em dash, so the column added to shout "this mode is
  // failing every batch it starts" would be a column of dashes. Say so instead.
  const settledAny = entry.batches > 0;
  const per = (value: number): number => (settledAny ? value / entry.batches : NaN);

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
  const summary = tiles([
    { label: "ops", value: fmtNum(per(entry.ops), 1), sub: "per batch" },
    { label: "RAM", value: fmtRam(per(entry.gb)), sub: "per batch" },
    { label: "span", value: fmtMs(per(entry.spanMs)), sub: "start to settle" },
    {
      label: "earns",
      value: fmtMoney(per(entry.moneyEarned)),
      sub: recentMoney === undefined ? "per batch, run mean" : `run mean · now ${fmtMoney(recentMoney)}`,
    },
  ]);

  const abandoned = entry.abandoned ?? 0;
  const adrift = (entry.abandonedOps ?? 0) - (entry.abandonedLanded ?? 0);
  const loss =
    `<p class="muted">` +
    `${fmtNum(entry.ops)} ops in ${fmtNum(entry.batches)} settled batches` +
    (abandoned > 0
      ? ` · <span class="bad" title="${esc(
          "batches evicted without ever settling — a batch that loses an op never completes, and this is the only counter that sees it",
        )}">${fmtNum(abandoned)} abandoned, ${fmtNum(adrift)} ops lost</span>`
      : "") +
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
  const order = !settledAny
    ? `<p class="bad" title="${esc(
        "no batch of this kind has ever settled, so there is no landing order to grade",
      )}">nothing settled</p>`
    : graded
    ? `<p class="${entry.inOrder >= entry.batches ? "good" : "bad"}" title="${esc(
        "batches whose effects landed in the order the cycle planned, out of every batch of this kind. " +
          "A batch launched without a landing grid can never contribute, so this reads low on a kind that only sometimes lands on a grid.",
      )}">${fmtNum(entry.inOrder)} / ${fmtNum(entry.batches)} in order</p>`
    : `<p class="muted" title="${esc(
        "this kind has never produced a landing-order verdict — its batches land as a group with no intended internal sequence",
      )}">no landing grid</p>`;

  return `<section class="batchcol">${head}${summary}${loss}${split}${threads}${order}</section>`;
}

/** The card. Aggregates for "is it earning", the batch scatter for "is it
 * healthy", the picked batch for "what went wrong with that one". */
function batchesCard(state: ProjectedState): string {
  const kinds = activeBatchKinds(state);
  if (kinds.length === 0 && state.batchHistory.length === 0) {
    return state.compacted
      ? note(hint(
          "this run was served compacted",
          "runs past a size threshold are folded to one record per state key before being served, so the per-batch " +
            "history and every series on this card are gone — only the final rollup survives. Nothing is wrong with the farm.",
        ))
      : waiting("a batch to settle", "a batch counts once every one of its ops has landed");
  }
  return (
    throughputStrip(state) +
    batchTimeline(state) +
    batchInspector(state) +
    batchHistoryDetail(state) +
    perKindDetail(state, kinds) +
    allocationDetail(state)
  );
}

/** Dispatcher health, as curves rather than the latest scalar.
 *
 * Every one of these was already published and already rendered — as a single
 * number in a table, which cannot answer the only question worth asking of a
 * gauge: is it getting worse. `pumpOccupancy` is the case that matters most.
 * The tab's own notes call it the leading indicator of the landing error that
 * eventually shows up as lost money, and it was drawn nowhere.
 *
 * `fit` is per-metric, and the distinction is real: a count or a cost reads
 * against zero, while a RATIO living in a narrow band far from zero — an
 * in-order share between 0.97 and 1.00 — is a flat line on a zero-anchored
 * axis, with the entire finding inside one pixel. */
const HEALTH_TRENDS: {
  id: string;
  label: string;
  title: string;
  color: string;
  fit: boolean;
  series(health: FarmHealthSeries): [number, number][];
  fmt(value: number): string;
}[] = [
  {
    id: "occupancy",
    label: "planner occupancy",
    title: "planner milliseconds per millisecond of wall clock. A healthy run sits near 5%; past about a fifth of " +
      "wall time the game's own timers and every in-flight delay start missing their deadlines, and the landing " +
      "error that follows is what gets noticed instead. Zero is kept on the axis because the distance from it is the reading.",
    color: "--series-3",
    fit: false,
    series: (health) => health.pumpOccupancy,
    fmt: (value) => fmtPct(value, 1),
  },
  {
    id: "inorder",
    label: "landed in order",
    title: "share of GRADED batches whose effects landed in the planned order. Scaled to its own band: a healthy " +
      "run sits just under 1.0, and against a zero-anchored axis the few percent that matter are invisible.",
    color: "--series-1",
    fit: true,
    series: (health) => health.inOrderShare,
    fmt: (value) => fmtPct(value, 1),
  },
  {
    id: "span",
    label: "mean batch span",
    title: "start to settle, averaged over every kind by summed spans over summed batches. A pipeline slipping " +
      "shows up here before it shows up in income. Scaled to its band — the level is known, the drift is the finding.",
    color: "--series-2",
    fit: true,
    series: (health) => health.batchSpanMs,
    fmt: (value) => fmtMs(value),
  },
  {
    id: "landingerror",
    label: "landing error",
    title: "observed minus planned landing time, signed mean and worst absolute. A mean far from zero means the " +
      "duration model is biased; a worst case above one landing gap means effects are reordering.",
    color: "--series-4",
    fit: false,
    series: (health) => health.landingErrorMeanMs,
    fmt: (value) => fmtMs(value),
  },
  {
    id: "lateness",
    label: "engine lateness",
    title: "main-thread starvation, measured directly. Leads landing error by about a weaken time, which makes it " +
      "the earliest warning on this card.",
    color: "--series-5",
    fit: false,
    series: (health) => health.engineLatenessMs,
    fmt: (value) => fmtMs(value),
  },
];

/** The trends that have enough points to draw. Shared by render and mount so
 * the two cannot disagree about which canvases exist. */
function drawableTrends(state: ProjectedState): typeof HEALTH_TRENDS {
  return HEALTH_TRENDS.filter((trend) => trend.series(state.farmHealth).length >= 2);
}

function healthTrends(state: ProjectedState): string {
  const drawable = drawableTrends(state);
  if (drawable.length === 0) return "";
  return (
    `<div class="chartgrid">` +
    drawable
      .map((trend) =>
        `<div>` +
        note(hint(raw(`<span class="${seriesKey(trend.color)}">${esc(trend.label)}</span>`), trend.title)) +
        chartCanvas(`health-${trend.id}`, "micro") +
        `</div>`
      )
      .join("") +
    `</div>`
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
    const trends = healthTrends(state);

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
    // One predicate per filter chip: the badge count and the row filter are
    // derived from the same function so they cannot drift apart.
    const modes: Record<string, (r: Row) => boolean> = {
      money: (r) => (r.server.moneyMax ?? 0) > 0,
      rooted: (r) => r.root === "rooted",
      ready: (r) => r.root === "ready",
      blocked: (r) => r.root === "blocked",
      active: (r) => activeHosts.has(r.server.hostname),
      "needs-prep": (r) => r.root === "rooted" && (r.server.moneyMax ?? 0) > 0 && !(r.atMaxMoney && r.atMinSec),
      contracts: (r) => hostsWithContracts.has(r.server.hostname),
      owned: (r) => Boolean(r.server.purchasedByPlayer) || r.server.hostname === "home",
      busy: (r) => (r.server.ramUsed ?? 0) > 0,
      prepped: (r) => r.atMaxMoney && r.atMinSec,
      all: () => true,
    };
    const badge = (value: string): string => String(all.filter(modes[value]!).length);
    const mode = view("hacking.servers", "money");
    const needle = view("hacking.search").trim().toLowerCase();
    const selectedName = view("hacking.selected", farm?.target ?? farm?.prepTarget ?? "");
    const rows = all
      .filter((r) => {
        if (needle && !r.server.hostname.toLowerCase().includes(needle)) return false;
        return (modes[mode] ?? modes.all!)(r);
      });

    // The inspector's subject comes from the VISIBLE rows: a selection the
    // active filter excludes must not render detail under a table (or an
    // empty-table note) that does not contain it.
    const selected = rows.find((r) => r.server.hostname === selectedName)
      ?? rows.find((r) => activeHosts.has(r.server.hostname))
      ?? rows[0];
    const serverControls =
      filters(
        "hacking.servers",
        [
          { value: "money", label: "worth hacking" },
          { value: "rooted", label: "rooted", badge: badge("rooted"), title: "root access held" },
          { value: "ready", label: "rootable", badge: badge("ready"), title: "rootable now" },
          { value: "blocked", label: "blocked", badge: badge("blocked"), title: "needs more skill or port openers" },
          { value: "active", label: "active", badge: badge("active"), title: "farm or preparation pipeline" },
          { value: "needs-prep", label: "needs prep", badge: badge("needs-prep"), title: "rooted money server below max money or above min security" },
          { value: "contracts", label: "contracts", badge: badge("contracts"), title: "queued or quarantined coding contracts" },
          { value: "owned", label: "owned", badge: badge("owned"), title: "home and purchased servers" },
          { value: "busy", label: "RAM in use", badge: badge("busy"), title: "server currently using RAM" },
          { value: "prepped", label: "prepped", badge: badge("prepped"), title: "at max money and min security" },
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
      (health || trends ? card("Dispatcher health", trends + (health || "")) : "") +
      `</div>`
    );
  },

  /** Charts are drawn imperatively after the panel is in the DOM. A canvas that
   * is not present (a kind with no series yet) is skipped by mountChart rather
   * than guarded for here.
   *
   * A COLLAPSED disclosure is a different case and is NOT skipped: `<details>`
   * keeps its children, so the canvas is found and measures 0x0, which draws a
   * zero-sized bitmap. Opening one therefore has to re-render (main.ts's
   * `toggle` handler does), or a stored run — which never re-renders on its
   * own — shows the section blank. */
  mount(state, el) {
    // One mark per settled batch. POINTS rather than a line: each sample is a
    // different batch, so a path between them would assert a continuity that
    // does not exist. The metric follows the chips, and `fit` follows the
    // metric — a span or a rate reads by its spread, a total by its magnitude.
    const metric = batchMetric();
    mountChart(
      el,
      "batch-timeline",
      batchTimelineSeries(state),
      state.t0,
      (value) => metric.fmt(value),
      { fitY: metric.fit },
    );
    // Ops launched that are neither in flight nor landed. A magnitude, so zero
    // stays on the axis: zero adrift is the healthy reading.
    mountChart(
      el,
      "ops-lost",
      [{ pts: state.farmHealth.opsLost, color: "--series-4", label: "adrift" }],
      state.t0,
      (value) => fmtNum(value),
      { compact: true },
    );
    for (const trend of drawableTrends(state)) {
      mountChart(
        el,
        `health-${trend.id}`,
        [{ pts: trend.series(state.farmHealth), color: trend.color, label: trend.label }],
        state.t0,
        (value) => trend.fmt(value),
        { compact: true, fitY: trend.fit },
      );
    }
    mountChart(
      el,
      "allocchart",
      KINDS.map((each) => ({ pts: state.allocShare[each], color: KIND_SERIES[each], label: each })),
      state.t0,
      (v) => `${(v * 100).toFixed(0)}%`,
    );
  },
};
