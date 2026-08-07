import { bar, card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtRam } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Hacking tab: the farm. Dispatcher rollup on top (rates, target, RAM pie),
 * fleet capacity next, per-server detail below. */

export const hackingTab: Tab = {
  id: "hacking",
  render(state: ProjectedState) {
    const farm = state.topics.farm;
    const fleet = state.topics.fleet;

    const farmTiles = farm
      ? tiles([
          { label: "farm target", value: farm.target || "–" },
          { label: "prepping", value: farm.prepTarget || "–" },
          { label: "$/sec", value: farm.moneyRate !== undefined ? `${fmtMoney(farm.moneyRate)}/s` : "–" },
          { label: "exp/sec", value: farm.expRate !== undefined ? fmtNum(farm.expRate, 1) : "–" },
          { label: "earned", value: fmtMoney(farm.totals?.moneyEarned) },
          { label: "hacks", value: String(farm.totals?.hacks ?? 0) },
        ])
      : "";

    const targetState =
      farm && (farm.money !== undefined || farm.security !== undefined)
        ? table(
            ["", "current", "target"],
            [
              ["money", fmtMoney(farm.money), fmtMoney(farm.moneyMax)],
              ["security", fmtNum(farm.security, 2), fmtNum(farm.minSecurity, 2)],
            ],
          )
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

    const rows = [...state.servers.values()]
      .sort((a, b) => (b.moneyMax ?? 0) - (a.moneyMax ?? 0))
      .map((s) => [
        esc(s.hostname),
        `<span class="${s.hasAdminRights ? "good" : "muted"}">${s.hasAdminRights ? "yes" : "no"}</span>`,
        fmtMoney(s.moneyAvailable),
        fmtMoney(s.moneyMax),
        s.hackDifficulty !== undefined ? s.hackDifficulty.toFixed(1) : "–",
        s.minDifficulty !== undefined ? s.minDifficulty.toFixed(1) : "–",
        String(s.requiredHackingSkill ?? "–"),
        `${(s.ramUsed ?? 0).toFixed(0)}/${s.maxRam || 0}`,
      ]);

    return (
      `<div class="col wide">` +
      card("Farm", farm ? farmTiles + targetState + ops : note("no farm rollup — the dispatcher publishes one per second")) +
      (pie ? card("RAM segments", pie) : "") +
      card("Servers", table(["host", "root", "money", "max", "sec", "min", "skill", "ram"], rows, "no servers scanned yet")) +
      `</div>` +
      `<div class="col">` +
      card("Fleet", fleetTiles) +
      (health ? card("Dispatcher health", health) : "") +
      `</div>`
    );
  },
};
