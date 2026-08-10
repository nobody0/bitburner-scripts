import { FEATURES } from "../../../shared/features/registry.ts";
import { factsOnly } from "../../../shared/telemetry/schema.ts";
import { attachChartHover, drawChart } from "../lib/chart.ts";
import { card, filters, meter, note, search, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtTime } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import type { Markup } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Overview: the cross-feature view. Money over time, plus the one number
 * that says which feature to work on next — per-feature income attribution
 * from ns.getMoneySources(). */

function incomeRows(state: ProjectedState): Markup[][] {
  const sources = state.topics.progression?.moneySources?.sinceInstall;
  if (!sources) return [];
  const rows: { label: string; value: number }[] = [];
  for (const feature of FEATURES) {
    if (feature.moneySources.length === 0) continue;
    let total = 0;
    for (const field of feature.moneySources) total += sources[field] ?? 0;
    if (total === 0) continue;
    rows.push({ label: feature.label, value: total });
  }
  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const grand = sources.total || rows.reduce((sum, r) => sum + r.value, 0);
  const largest = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return rows.map((r) => [
    esc(r.label),
    // The share is the point of this table — which feature to work on next —
    // so it is a bar, not a fourth right-aligned number to compare by eye.
    meter(Math.abs(r.value) / largest, fmtMoney(r.value), false, `${fmtMoney(r.value)} since install`),
    grand !== 0 ? `<span class="${r.value < 0 ? "bad" : ""}">${((r.value / grand) * 100).toFixed(1)}%</span>` : "–",
  ]);
}

function statusChips(state: ProjectedState): string {
  return (
    `<div class="chips">` +
    FEATURES.map((feature) => {
      const unlocked = state.caps.unlocked[feature.id];
      const hasData = feature.topics.some((topic) => state.topics[topic] !== undefined);
      const cls = unlocked === "yes" ? (hasData ? "on" : "idle") : unlocked === "no" ? "off" : "unknown";
      return `<span class="chip ${cls}" title="${esc(feature.problem)}">${esc(feature.label)}</span>`;
    }).join("") +
    `</div>`
  );
}

/** What this run asked the simulator for and did not get.
 *
 * The gap list is the roadmap: a simulated run that reads "reached the goal"
 * means much less if half the feature surface threw on contact, so the count
 * of each unmodelled call sits next to the result rather than in a log
 * nobody reads. Empty for a live game run, which models everything by
 * definition. */
function fidelityRows(state: ProjectedState): string[][] {
  const counts = new Map<string, { kind: string; name: string; count: number; detail?: string }>();
  const authoritative = state.simResult?.unmodeled;
  if (authoritative) {
    for (const [key, count] of Object.entries(authoritative)) {
      const detail = state.simGapDetails.get(key);
      const separator = key.indexOf(" ");
      counts.set(key, {
        kind: detail?.kind ?? (separator < 0 ? "ns" : key.slice(0, separator)),
        name: detail?.name ?? (separator < 0 ? key : key.slice(separator + 1)),
        count,
        ...(detail?.detail ? { detail: detail.detail } : {}),
      });
    }
  } else {
    for (const [key, gap] of state.simGapDetails) counts.set(key, { ...gap, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .map((gap) => [esc(gap.kind), esc(gap.name), String(gap.count), esc(gap.detail ?? "")]);
}

/** Event payloads are a coder-facing fact dump, not a second prose log.
 * Planner annotations are deliberately omitted here; the feature panels show
 * the structured action, candidates, scores, thresholds and outcomes that
 * support the decision. Observed `reason` fields (API failures, arbiter denial
 * codes, scheduler triggers) remain because they are data from the system. */
function factJson(value: unknown): string {
  return JSON.stringify(factsOnly(value));
}

export const overviewTab: Tab = {
  id: "overview",
  render(state) {
    const player = state.player;
    const money = tiles([
      { label: "on hand", value: fmtMoney(player?.money) },
      {
        label: state.hasTotals ? "earned by hacking" : "no totals source yet",
        value: state.hasTotals ? fmtMoney(state.earned) : "–",
      },
      {
        label: state.hasTotals ? "successful hacks" : "needs farm rollup",
        value: state.hasTotals ? String(state.hacks) : "–",
      },
      { label: "hacking skill", value: player?.skills?.hacking !== undefined ? String(player.skills.hacking) : "–" },
      { label: "elapsed", value: state.t0 !== null ? fmtTime(state.lastT - state.t0) : "–" },
    ]);

    // Replay scrubbing is a run-level control and lives in the shell header,
    // so this panel can be rebuilt wholesale without resetting the slider.
    const chart = `<div id="chartwrap"><canvas id="chart"></canvas><div id="tooltip"></div></div>`;

    const income = incomeRows(state);
    const gaps = fidelityRows(state);
    const simStatus = state.simResult
      ? tiles([
          { label: "validity", value: state.simResult.validity ?? "unknown" },
          { label: "goal", value: state.simResult.reached ? "reached" : "not reached" },
          { label: "stopped", value: state.simResult.stoppedBecause ?? "unknown" },
          { label: "driver", value: state.simMeta?.driver ?? "unknown" },
          { label: "scenario", value: state.simResult.scenario ?? state.simMeta?.scenario ?? "unknown" },
          { label: "seed", value: state.simMeta?.seed !== undefined ? String(state.simMeta.seed) : "unknown" },
        ])
      : note("simulation is still running; final validity is not available yet");

    // The feed is mostly `probe.batch` debug in steady state, which buries the
    // handful of records that mean something went wrong. Filtering is the
    // difference between a log and a signal.
    const mode = view("overview.events", "all");
    const needle = view("overview.search").trim().toLowerCase();
    const named = state.events.map((e) => ({
      record: e,
      name: e.kind === "debug" ? `debug: ${e.msg}` : e.name,
    }));
    const isFailure = (name: string): boolean =>
      name === "action.failed"
      || name === "action.blocked"
      || name.startsWith("probe.")
      || name.startsWith("contract.");
    const isDecision = (name: string): boolean => name.endsWith(".decision") || name.endsWith(".result");
    const feed = named
      .filter(({ record, name }) => {
        if (mode === "events" && record.kind !== "event") return false;
        if (mode === "failures" && !isFailure(name)) return false;
        if (mode === "decisions" && !isDecision(name)) return false;
        if (needle) {
          const data = record.data ? factJson(record.data).toLowerCase() : "";
          if (!name.toLowerCase().includes(needle) && !data.includes(needle)) return false;
        }
        return true;
      })
      .slice(-200)
      .reverse();

    const eventControls =
      filters(
        "overview.events",
        [
          { value: "all", label: "all" },
          { value: "events", label: "events" },
          { value: "decisions", label: "decisions", badge: String(named.filter((e) => isDecision(e.name)).length) },
          { value: "failures", label: "problems", badge: String(named.filter((e) => isFailure(e.name)).length) },
        ],
        "all",
      ) + search("overview.search", "filter…");

    const events = feed.length
      ? `<ul id="events">${feed
          .map(({ record, name }) => {
            const data = record.data ? factJson(record.data) : "";
            return `<li><span class="t">${esc(fmtTime(record.t - (state.t0 ?? record.t)))}</span><span class="${
              isFailure(name) ? "fail" : ""
            }">${esc(name)}</span><span class="data" title="${esc(data.slice(0, 600))}">${esc(
              data.slice(0, 160),
            )}</span></li>`;
          })
          .join("")}</ul>`
      : note(named.length ? "nothing matches this filter" : "no events yet");

    // A compacted run kept only the tail; saying so beats letting the feed
    // look like the run started three minutes before it ended.
    const compactNote = state.compacted
      ? note("this run was too large to load whole — topics are the last write of each, and the feed is the tail")
      : "";

    return (
      `<div class="col">` +
      card("Money", money + chart) +
      card(
        "Income by feature",
        income.length
          ? table(["feature", "since install", "share"], income, { left: [0] })
          : note("waiting for ns.getMoneySources() — probed every 2 minutes"),
      ) +
      card("Features", statusChips(state)) +
      `</div>` +
      `<div class="col">` +
      (state.src === "sim"
        ? card("Simulation result", simStatus) +
          card(
            "Not modelled",
            gaps.length
              ? table(["kind", "what was asked for", "times", "note"], gaps, { left: [0, 1, 3] })
              : state.simResult?.validity === "valid"
                ? note("this run stayed inside what the simulator models")
                : note("no gap summary is available yet"),
          )
        : "") +
      card("Events", compactNote + events, eventControls) +
      `</div>`
    );
  },
  mount(state, el) {
    const canvas = el.querySelector<HTMLCanvasElement>("#chart");
    const tooltip = el.querySelector<HTMLElement>("#tooltip");
    if (!canvas || !tooltip) return;
    drawChart(canvas, state.moneySeries, state.t0);
    // The canvas node is recreated by each render, so its listeners go with
    // it; attaching per mount keeps exactly one set on the live node.
    attachChartHover(canvas, tooltip);
  },
};
