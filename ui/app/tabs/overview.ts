import { FEATURES } from "../../../shared/features/registry.ts";
import { attachChartHover, drawChart } from "../lib/chart.ts";
import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Overview: the cross-feature view. Money over time, plus the one number
 * that says which feature to work on next — per-feature income attribution
 * from ns.getMoneySources(). */

function incomeRows(state: ProjectedState): string[][] {
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
  return rows.map((r) => [
    esc(r.label),
    fmtMoney(r.value),
    grand !== 0 ? `${((r.value / grand) * 100).toFixed(1)}%` : "–",
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
    const feed = state.events.slice(-200).reverse();
    const events = feed.length
      ? `<ul id="events">${feed
          .map((e) => {
            const name = e.kind === "debug" ? `debug: ${e.msg}` : e.name;
            const bad = name === "action.failed" || name === "action.blocked" || name.startsWith("probe.");
            const data = e.data ? JSON.stringify(e.data) : "";
            return `<li><span class="t">${esc(fmtTime(e.t - (state.t0 ?? e.t)))}</span><span class="${
              bad ? "fail" : ""
            }">${esc(name)}</span><span class="data">${esc(data.slice(0, 160))}</span></li>`;
          })
          .join("")}</ul>`
      : note("no events yet");

    return (
      `<div class="col">` +
      card("Money", money + chart) +
      card(
        "Income by feature",
        income.length
          ? table(["feature", "since install", "share"], income)
          : note("waiting for ns.getMoneySources() — probed every 2 minutes"),
      ) +
      card("Features", statusChips(state)) +
      `</div>` +
      `<div class="col">` +
      card("Events", events) +
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
