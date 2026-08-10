import type { Server } from "@ns";
import {
  rollPercentile,
  rolledMoney,
  rolledSecurity,
  rootState,
  serverRanges,
  type RootState,
} from "../../../shared/features/servers.ts";
import { bar, card, dataTable, dot, filters, meter, note, search, table, tiles, type Column } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtRam, fmtTime } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

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
}

const ROOT_DOT: Record<RootState, { status: "good" | "ready" | "bad"; why: string }> = {
  rooted: { status: "good", why: "rooted" },
  ready: { status: "ready", why: "can be rooted now" },
  blocked: { status: "bad", why: "not enough skill or port openers yet" },
};

function buildRows(state: ProjectedState): Row[] {
  const skill = state.player?.skills?.hacking ?? 0;
  const openers = state.topics.fleet?.portOpeners ?? 0;
  const mults = state.topics.progression?.multipliers;
  const maxMoneyMult = mults?.["ServerMaxMoney"] ?? 1;
  const startSecMult = mults?.["ServerStartingSecurity"] ?? 1;

  return [...state.servers.values()].map((server) => {
    const ranges = serverRanges(server.hostname);
    const max = server.moneyMax ?? 0;
    const money = server.moneyAvailable ?? 0;
    const min = server.minDifficulty ?? 1;
    const current = server.hackDifficulty ?? min;

    const rolled = rolledMoney(server.moneyMax, maxMoneyMult);
    const rolledSec = rolledSecurity(server.baseDifficulty, startSecMult);

    return {
      server,
      root: rootState(server, skill, openers),
      moneyFrac: max > 0 ? money / max : 0,
      atMaxMoney: max > 0 && money >= max * 0.999,
      // 100 is the game's hard cap, so the bar spans min..100 and empty means
      // "as weak as this host can be".
      secFrac: Math.max(0, Math.min(1, (current - min) / Math.max(1, 100 - min))),
      atMinSec: current <= min + 0.01,
      ...(rolled !== undefined ? { moneyRoll: rollPercentile(rolled, ranges?.money) } : {}),
      ...(server.requiredHackingSkill !== undefined
        ? { skillRoll: rollPercentile(server.requiredHackingSkill, ranges?.skill) }
        : {}),
      ...(rolledSec !== undefined ? { secRoll: rollPercentile(rolledSec, ranges?.sec) } : {}),
    };
  });
}

/** A percentile as a short, sortable label. Deliberately terse: it is a
 * curiosity column, not a decision column, and it must not push the meters
 * off the right edge. */
function rollCell(row: Row): string {
  const p = row.moneyRoll;
  const ranges = serverRanges(row.server.hostname);
  if (p === undefined || !ranges?.money) return `<span class="muted">fixed</span>`;
  const [min, max] = ranges.money;
  const cls = p >= 0.66 ? "good" : p <= 0.33 ? "bad" : "";
  return (
    `<span class="${cls}" title="${esc(
      `this save rolled ${fmtMoney(min + p * (max - min))} of the ${fmtMoney(min)}–${fmtMoney(max)} the generator allows` +
        `\nmoneyMax = 25 x roll x ServerMaxMoney`,
    )}">p${(p * 100).toFixed(0)}</span>`
  );
}

const COLUMNS: Column<Row>[] = [
  {
    id: "host",
    label: "host",
    left: true,
    sort: (r) => r.server.hostname,
    cell: (r) => {
      const { status, why } = ROOT_DOT[r.root];
      return `${dot(status, why)}${esc(r.server.hostname)}`;
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
      const roll =
        r.skillRoll !== undefined ? ` <span class="muted">p${(r.skillRoll * 100).toFixed(0)}</span>` : "";
      return `<span class="${cls}">${fmtNum(need)}</span>${roll}`;
    },
  },
  {
    id: "money",
    label: "money",
    sort: (r) => r.server.moneyMax ?? 0,
    cell: (r) => {
      const max = r.server.moneyMax ?? 0;
      if (max <= 0) return `<span class="muted">none</span>`;
      return meter(
        r.moneyFrac,
        `${fmtMoney(r.server.moneyAvailable)} / ${fmtMoney(max)}`,
        r.atMaxMoney,
        `${fmtPct(r.moneyFrac)} of maximum`,
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
      const roll =
        r.secRoll !== undefined ? `\nbase security rolled at p${(r.secRoll * 100).toFixed(0)} of its range` : "";
      return meter(
        1 - r.secFrac,
        `${current.toFixed(1)} / ${min.toFixed(1)}`,
        r.atMinSec,
        `current ${current.toFixed(2)}, minimum ${min.toFixed(2)}, cap 100${roll}`,
      );
    },
  },
  {
    id: "roll",
    label: "roll",
    sort: (r) => r.moneyRoll ?? -1,
    cell: rollCell,
  },
  {
    id: "ram",
    label: "ram",
    sort: (r) => r.server.maxRam ?? 0,
    cell: (r) =>
      (r.server.maxRam ?? 0) > 0
        ? `${fmtNum(r.server.ramUsed ?? 0)}/${fmtNum(r.server.maxRam)}`
        : `<span class="muted">–</span>`,
  },
];

export const hackingTab: Tab = {
  id: "hacking",
  render(state: ProjectedState) {
    const farm = state.topics.farm;
    const fleet = state.topics.fleet;

    const farmTiles = farm
      ? tiles([
          { label: "farm target", value: farm.target || "–" },
          { label: "target solve", value: farm.targetSolveExact === undefined ? "–" : farm.targetSolveExact ? "exact" : "heuristic" },
          { label: "prepping", value: farm.prepTarget || "–" },
          { label: "$/sec", value: farm.moneyRate !== undefined ? `${fmtMoney(farm.moneyRate)}/s` : "–" },
          { label: "exp/sec", value: farm.expRate !== undefined ? fmtNum(farm.expRate, 1) : "–" },
          { label: "earned", value: fmtMoney(farm.totals?.moneyEarned) },
          { label: "hacks", value: String(farm.totals?.hacks ?? 0) },
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

    const pie = farm?.ramPie
      ? bar([
          { label: "farm", value: farm.ramPie.farm, className: "s1" },
          { label: "prep", value: farm.ramPie.prep, className: "s2" },
          { label: "share", value: farm.ramPie.share, className: "s3" },
          { label: "free", value: farm.ramPie.free, className: "s4" },
          { label: "reserve", value: farm.ramPie.reserve, className: "s5" },
        ])
      : "";

    const health =
      farm &&
      (farm.allocFails !== undefined || farm.execFails !== undefined || farm.batchesSkipped !== undefined)
        ? table(
            ["metric", "value"],
            [
              ["alloc failures", String(farm.allocFails ?? 0)],
              ["exec failures", String(farm.execFails ?? 0)],
              ["batches skipped", String(farm.batchesSkipped ?? 0)],
              ["worst pump", farm.pumpMaxMs !== undefined ? `${farm.pumpMaxMs.toFixed(1)}ms` : "–"],
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
      : note("waiting for the fleet probe");

    const homeRamPlan = fleet?.homeRamPlan
      ? note(fleet.homeRamPlan.why) +
        table(
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
        note(`${fleet.infrastructurePlan.why}${fleet.infrastructurePlan.hold ? ` — ${fleet.infrastructurePlan.hold}` : ""}`) +
        (fleet.infrastructurePlan.lastResult
          ? note(`${fleet.infrastructurePlan.lastResult.ok ? "last action succeeded" : "last action failed"}: ${fleet.infrastructurePlan.lastResult.detail}`)
          : "") +
        (fleet.infrastructurePlan.ranked.length
          ? table(
              ["pick", "option", "adds", "cost", "adds $/sec", "return/$", "payback", "horizon net", "status"],
              fleet.infrastructurePlan.ranked.map((entry) => [
                entry.selected ? "▶" : "",
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
                fmtNum(entry.returnPerDollarSec, 8),
                fmtTime(entry.paybackSec * 1000),
                fmtMoney(entry.netOverHorizon),
                entry.worthBuying === true ? "repays" : entry.worthBuying === false ? "past horizon" : "–",
              ]),
              { left: [1, 8] },
            )
          : "") +
        (fleet.infrastructurePlan.rankedTotal > fleet.infrastructurePlan.ranked.length
          ? note(`showing ${fleet.infrastructurePlan.ranked.length} of ${fleet.infrastructurePlan.rankedTotal} scored options`)
          : "")
      : "";

    const infrastructureHistory = state.events
      .filter((event) => event.kind === "event" &&
        (event.name === "investment.decision" || event.name === "investment.result") &&
        (event.data as { subsystem?: string } | undefined)?.subsystem === "infrastructure")
      .slice(-10)
      .reverse()
      .map((event) => {
        const data = event.data as {
          plan?: { why?: string };
          result?: { detail?: string };
          arbitration?: {
            grants?: { by: string; id: string; amount: number }[];
            denied?: { by: string; id: string; reason: string }[];
          };
        } | undefined;
        const denied = data?.arbitration?.denied?.find((entry) => entry.by === "hacking" && entry.id.startsWith("infrastructure:"));
        const winners = data?.arbitration?.grants?.filter((entry) => entry.by !== "hacking" || !entry.id.startsWith("infrastructure:")) ?? [];
        const arbiter = denied
          ? `${denied.reason}${winners.length ? `; funded ${winners.map((entry) => `${entry.by}:${entry.id} ${fmtMoney(entry.amount)}`).join(", ")}` : ""}`
          : data?.arbitration ? "funded" : "–";
        return [
          fmtTime(event.t - (state.t0 ?? event.t)),
          esc(event.kind === "event" ? event.name : ""),
          esc(data?.plan?.why ?? data?.result?.detail ?? ""),
          esc(arbiter),
        ];
      });

    // --- servers ---
    const all = buildRows(state);
    const counts = {
      rooted: all.filter((r) => r.root === "rooted").length,
      ready: all.filter((r) => r.root === "ready").length,
      blocked: all.filter((r) => r.root === "blocked").length,
      prepped: all.filter((r) => r.atMaxMoney && r.atMinSec).length,
    };
    const mode = view("hacking.servers", "money");
    const needle = view("hacking.search").trim().toLowerCase();
    const rows = all
      .filter((r) => {
        if (needle && !r.server.hostname.toLowerCase().includes(needle)) return false;
        if (mode === "money") return (r.server.moneyMax ?? 0) > 0;
        if (mode === "rooted") return r.root === "rooted";
        if (mode === "ready") return r.root === "ready";
        if (mode === "blocked") return r.root === "blocked";
        if (mode === "prepped") return r.atMaxMoney && r.atMinSec;
        return true;
      });

    const serverControls =
      filters(
        "hacking.servers",
        [
          { value: "money", label: "worth hacking" },
          { value: "rooted", label: "rooted", badge: String(counts.rooted) },
          { value: "ready", label: "rootable", badge: String(counts.ready) },
          { value: "blocked", label: "blocked", badge: String(counts.blocked) },
          { value: "prepped", label: "prepped", badge: String(counts.prepped) },
          { value: "all", label: "all", badge: String(all.length) },
        ],
        "money",
      ) + search("hacking.search", "host…");

    const servers =
      dataTable("hacking.servers", rows, COLUMNS, {
        defaultSort: { key: "money", dir: -1 },
        empty: "no servers match this filter",
        limit: 120,
      }) +
      note(
        "● rooted · ● rootable now · ● needs more skill or port openers. " +
          "roll is where this save landed in the range the generator rolls each server from — " +
          "money, security and required skill are all randomised per save, so two BN12s do not share a network.",
      );

    return (
      `<div class="col wide">` +
      card("Farm", farm ? farmTiles + ops : note("no farm rollup — the dispatcher publishes one per second")) +
      card("Servers", servers, serverControls) +
      `</div>` +
      `<div class="col">` +
      card("Fleet", fleetTiles) +
      (infrastructurePlan ? card("Infrastructure ROI", infrastructurePlan) :
        homeRamPlan ? card("Home RAM investment", homeRamPlan) : "") +
      (infrastructureHistory.length
        ? card("Infrastructure history", table(["at", "transition", "reason / outcome", "arbiter"], infrastructureHistory, { left: [1, 2, 3] }))
        : "") +
      (pie ? card("RAM segments", pie) : "") +
      (health ? card("Dispatcher health", health) : "") +
      `</div>`
    );
  },
};
