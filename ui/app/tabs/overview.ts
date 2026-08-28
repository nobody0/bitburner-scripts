import type { MoneySource } from "@ns";
import { FEATURES } from "../../../shared/features/registry.ts";
import { chartCanvas, hasSpan, mountChart } from "../lib/chart.ts";
import { card, filters, hint, meter, NONE, note, search, table, tiles, waiting } from "../lib/dom.ts";
import { esc, fmtMoney, fmtTime } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import type { Markup } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import { automationSummary } from "./overview-summary.ts";
import type { Tab } from "./index.ts";

/** Overview: the cross-feature view. Money over time, plus the one number
 * that says which feature to work on next — per-feature income attribution
 * from ns.getMoneySources(). */

/** The MoneySource fields no feature claims — the registry claims 15 of the 19.
 * Casino and infiltration are excluded from automation by design
 * (spec/features.md), `hospitalization` is a bill, and `other` is whatever the
 * game did not classify. It is money this panel cannot advise on, which is not
 * the same as money that does not exist. */
const MANUAL_SOURCES: [field: keyof MoneySource, label: string, why: string][] = [
  ["casino", "casino", "manual play — automating it is out of scope by design"],
  [
    "hospitalization",
    "hospitalization",
    "hospital bills — the cheapest signal that crime or Bladeburner is getting the player killed",
  ],
  ["infiltration", "infiltration", "manual play — automating it is out of scope by design"],
  ["other", "other", "money the game attributed to no source"],
];

function incomeBody(state: ProjectedState): string {
  const sources = state.topics.progression?.moneySources?.sinceInstall;
  if (!sources) return waiting("ns.getMoneySources()", "probed every 2 minutes");
  const rows: { label: Markup; value: number }[] = [];
  for (const feature of FEATURES) {
    if (feature.moneySources.length === 0) continue;
    let total = 0;
    for (const field of feature.moneySources) total += sources[field] ?? 0;
    if (total === 0) continue;
    rows.push({ label: esc(feature.label), value: total });
  }
  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  // The unclaimed fields, one row each and under the features. Netting them
  // into a single residual cancels a $10b casino win against a $4m hospital
  // bill and destroys both readings; dropping them — which is what this table
  // did — left the share column silently failing to sum to 100.
  for (const [field, label, why] of MANUAL_SOURCES) {
    const value = sources[field] ?? 0;
    if (value === 0) continue;
    rows.push({ label: hint(label, why), value });
  }
  // One denominator, and it is `sources.total` rather than the attributed sum:
  // the shares have to sum to 100 across the rows on screen, which the
  // attributed sum stops doing the moment the unclaimed fields are shown.
  // Whatever the ledger holds and no row above names lands in `unaccounted`, so
  // a MoneySource field added by a future game version appears here instead of
  // vanishing. The dollar threshold is float noise in a summed ledger, not a
  // missing field.
  const grand = sources.total ?? 0;
  const rest = grand - rows.reduce((sum, r) => sum + r.value, 0);
  if (Math.abs(rest) > 1) {
    rows.push({
      label: hint("unaccounted", "in ns.getMoneySources().total but in no field this table names"),
      value: rest,
    });
  }
  if (rows.length === 0) return note("the ledger is reported and every source is still zero");
  const largest = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const share = (value: number): Markup => {
    // Coloured off the PRINTED percentage rather than off the raw value: with a
    // distorted denominator the two disagree, and a profitable feature rendered
    // a negative share in the normal colour.
    const pct = (value / grand) * 100;
    return `<span class="${pct < 0 ? "bad" : ""}">${pct.toFixed(1)}%</span>`;
  };
  const body = table(
    ["feature", "since install", "share"],
    rows.map((r) => [
      r.label,
      // The share is the point of this table — which feature to work on next —
      // so it is a bar, not a fourth right-aligned number to compare by eye.
      meter(Math.abs(r.value) / largest, fmtMoney(r.value), false, `${fmtMoney(r.value)} since install`),
      grand > 0 ? share(r.value) : NONE,
    ]),
    { left: [0] },
  );
  // Guarded on the SIGN, not on zero: the raw ledger books an open stock
  // position at its whole purchase price (game/lib/income.ts), so the total goes
  // small or negative mid-position while `stock` carries the same hole.
  // Dividing by it printed 4,000% shares, and a column of dashes on its own
  // reads as missing telemetry rather than as a distorted denominator.
  return grand > 0
    ? body
    : body
      + note("no share: the ledger total is not positive, because an open stock position is booked at its full cost");
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

/** Said in both places it has to be said: the column header, and every cell
 * under it. */
const NO_GAP_COUNTS =
  "seen at least once — sim.unmodeled reports only the first hit of each gap; the totals arrive with sim.result";

/** What this run asked the simulator for and did not get.
 *
 * The gap list is the roadmap: a simulated run that reads "reached the goal"
 * means much less if half the feature surface threw on contact, so the gaps sit
 * next to the result rather than in a log nobody reads. Empty for a live game
 * run, which models everything by definition.
 *
 * The COUNTS exist only once `sim.result` lands. sim/realm/unmodeled.ts reports
 * only the first hit of each kind+name — the record stream is a digest and the
 * totals ride on the run result — so for the whole duration of a live run, and
 * forever for a run killed before its result, the honest answer is "at least
 * once". Writing 1 there made a probe that threw 400 times read like one that
 * threw once. */
function fidelityRows(state: ProjectedState): Markup[][] {
  const counts = new Map<string, { kind: string; name: string; count?: number; detail?: string }>();
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
    for (const [key, gap] of state.simGapDetails) counts.set(key, { ...gap });
  }
  return [...counts.values()]
    // Ranked by count only where the counts are real. In the fallback every
    // entry is a first-hit digest, so kind then name is the only ordering that
    // means anything — before this it was Map insertion order wearing a
    // ranking's clothes.
    .sort((a, b) =>
      authoritative ? (b.count ?? 0) - (a.count ?? 0) : a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    )
    .map((gap) => [
      esc(gap.kind),
      esc(gap.name),
      gap.count === undefined ? hint(NONE, NO_GAP_COUNTS) : String(gap.count),
      esc(gap.detail ?? ""),
    ]);
}

/** Scripts that died inside the simulated run.
 *
 * The other half of "invalid-for-goal": sim/game-run.ts turns a run invalid on
 * an unmodelled call OR a crash, so a run whose only fault was a dead script
 * showed "invalid-for-goal" beside a Not-modelled card claiming it had nothing,
 * while pid, filename and error sat unread in the result.
 *
 * Folded by filename+error the way the gap list folds gaps: the host pushes an
 * entry per throw, so a controller relaunching a broken script yields dozens of
 * identical rows. */
function crashRows(state: ProjectedState): Markup[][] {
  const folded = new Map<string, { pid: number; filename: string; error: string; times: number }>();
  for (const crash of state.simResult?.crashes ?? []) {
    const key = `${crash.filename} ${crash.error}`;
    const seen = folded.get(key);
    if (seen) seen.times += 1;
    else folded.set(key, { ...crash, times: 1 });
  }
  return [...folded.values()]
    .sort((a, b) => b.times - a.times)
    .map((crash) => [String(crash.pid), esc(crash.filename), esc(crash.error), String(crash.times)]);
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
    //
    // Gated on `hasSpan`, not on a point count: the sink mirrors `player` to
    // `getPlayer` in one flush, so a game run pushes the same money sample twice
    // at one millisecond. Two points with no x extent draw a full-width axis
    // with three identical time labels — a chart asserting a timeline over a
    // single observation.
    const chart = hasSpan(state.moneySeries)
      ? chartCanvas("moneychart", "full")
      : note("no money timeline yet — a curve needs two observations at different times");

    const income = incomeBody(state);
    const gaps = fidelityRows(state);
    const gapCounts = state.simResult?.unmodeled !== undefined;
    const crashes = crashRows(state);

    // Identity comes from `sim.meta`, the run's FIRST record; the verdict only
    // from `sim.result`, its last. Rendering the two as one block hid the goal,
    // driver, experiment and seed for the entire run — which is exactly when
    // somebody is watching it.
    const experiment = state.simMeta?.experiment;
    const simIdentity = tiles([
      { label: "goal", value: state.simMeta?.goal ?? "unknown" },
      { label: "driver", value: state.simMeta?.driver ?? "unknown" },
      {
        label: "experiment",
        // "legacy" is a real category here — a run with no experiment identity —
        // so it must not double as "the record that would have said so is gone".
        // A compacted replay has no `sim.meta` at all, and this tile's
        // neighbours honestly say "unknown".
        value: state.simMeta === null ? "unknown" : experiment?.class ?? "legacy",
        // Route+leg is the durable identity (shared/experiment.ts); the index is
        // informational. Without it, two legs of two different routes entering
        // the same node fresh render byte-identically.
        sub: experiment?.route ? `${experiment.route.route} / ${experiment.route.leg}` : undefined,
      },
      {
        label: "entrance",
        value: experiment?.entrance.kind === "save"
          ? experiment.entrance.saveId
          : experiment?.entrance.kind ?? "unknown",
      },
      { label: "scenario", value: state.simResult?.scenario ?? state.simMeta?.scenario ?? "unknown" },
      { label: "seed", value: state.simMeta?.seed !== undefined ? String(state.simMeta.seed) : "unknown" },
    ]);
    // Four tiles read "unknown" for one reason, so it is said once rather than
    // per tile: `sim.meta` is the run's first event, and a compacted file kept
    // only the tail.
    const identityNote =
      state.simMeta === null && state.compacted
        ? note(
            hint(
              "run identity not in this file",
              "sim.meta is the run's first event and a compacted run keeps only the tail, so driver, seed, scenario and experiment are lost",
            ),
          )
        : "";
    const timeToGoal = state.simResult?.timeToGoalMs;
    const simStatus = state.simResult
      ? tiles([
          { label: "validity", value: state.simResult.validity ?? "unknown" },
          {
            label: "goal reached",
            value: state.simResult.reached === undefined ? NONE : state.simResult.reached ? "reached" : "not reached",
          },
          {
            label: "time to goal",
            // Not the Money card's `elapsed`: that is the span of the LOADED
            // artifact, and artifacts rotate on prestige, so in a multi-install
            // session it is the last segment while this is measured from session
            // start. Gated on finiteness rather than on `reached` because a
            // not-reached run's `Infinity` arrives as JSON null, and fmtTime
            // would print a raw Infinity as "Infinityd".
            value: typeof timeToGoal === "number" && Number.isFinite(timeToGoal) ? fmtTime(timeToGoal) : NONE,
          },
          { label: "stopped", value: state.simResult.stoppedBecause ?? "unknown" },
        ])
      // `state.live` is the only thing that separates "not yet" from "never".
      // Asserting "still running" over a stored file — a run killed or thrown
      // before it wrote a result — was the bug.
      : state.live
        ? note("simulation is still running; final validity is not available yet")
        : note(
            hint(
              "no sim.result record in this run",
              "a run that was killed or threw before its result was written has no final validity; the gap list below is still what was observed",
            ),
          );

    // The feed is mostly `probe.batch` debug in steady state, which buries the
    // handful of records that mean something went wrong. Filtering is the
    // difference between a log and a signal.
    const mode = view("overview.events", "all");
    const needle = view("overview.search").trim().toLowerCase();
    const named = state.events.map((e) => ({
      record: e,
      name: e.kind === "debug" ? `debug: ${e.msg}` : e.name,
    }));
    // Two vocabularies, and this predicate was written against one of them.
    // `action.failed`/`action.blocked` are SIM records (sim/world.ts,
    // sim/run.ts); a live GAME run reports a break as `start.crash`
    // (game/main.ts), `feature.failed` or
    // `ram.starvation` (game/lib/controller.ts), or `telemetry.dropped`
    // (game/lib/telemetry.ts). Without those, a run whose controller crashed
    // showed the crash in plain grey, a "problems" badge of 0, and "nothing
    // matches this filter". Anything added to those emitters gets checked
    // against this list.
    const isFailure = (name: string): boolean =>
      name === "action.failed"
      || name === "action.blocked"
      || name === "start.crash"
      || name === "feature.failed"
      || name === "ram.starvation"
      || name === "proxy.slow"
      || name === "telemetry.dropped"
      || name.startsWith("probe.")
      || name.startsWith("contract.");
    const isDecision = (name: string): boolean => name.endsWith(".decision") || name.endsWith(".result");
    const feed = named
      .filter(({ record, name }) => {
        if (mode === "events" && record.kind !== "event") return false;
        if (mode === "failures" && !isFailure(name)) return false;
        if (mode === "decisions" && !isDecision(name)) return false;
        if (needle) {
          const data = record.data ? JSON.stringify(record.data).toLowerCase() : "";
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
            const data = record.data ? JSON.stringify(record.data) : "";
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
      ? note(hint("compacted run", "too large to load whole: topics are the last write of each, and the feed is the tail"))
      : "";

    return (
      `<div class="col wide">` +
      card("Automation summary", automationSummary(state)) +
      card("Money", money + chart) +
      card("Income by feature", income) +
      card("Features", statusChips(state)) +
      `</div>` +
      `<div class="col">` +
      (state.src === "sim"
        ? card("Simulation result", identityNote + simIdentity + simStatus) +
          card(
            "Not modelled",
            gaps.length
              ? table(
                  ["kind", "what was asked for", gapCounts ? "times" : hint("times", NO_GAP_COUNTS), "note"],
                  gaps,
                  { left: [0, 1, 3] },
                )
              // Keyed off whether `unmodeled` was REPORTED, not off
              // `validity === "valid"`: the planner driver emits neither field
              // and its runs are "partial", so a validity test told a run
              // nobody measured that it had stayed inside the model.
              : !gapCounts
                ? note("no gap summary is available yet")
                : crashes.length
                  ? note("no unmodelled calls — this run is invalid because scripts crashed, see Crashes")
                  : note("this run stayed inside what the simulator models"),
          ) +
          // Only when crashes were REPORTED: the planner driver never sets the
          // field, and an empty table there would claim a clean run on the
          // strength of a measurement nobody took.
          (crashes.length
            ? card("Crashes", table(["pid", "script", "error", "times"], crashes, { left: [1, 2], wrap: [2] }))
            : "")
        : "") +
      card("Events", compactNote + events, eventControls) +
      `</div>`
    );
  },
  mount(state, el) {
    mountChart(el, "moneychart", [{ pts: state.moneySeries, color: "--series-1" }], state.t0);
  },
};
