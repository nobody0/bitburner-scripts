import { card, dataTable, hint, NONE, note, outcome, rankedTable, shownOf, table, tiles, waiting } from "../lib/dom.ts";
import { decisionHistory } from "../lib/history.ts";
import { esc, fmtMoney, fmtNum, fmtRam, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const hacknetTab: Tab = {
  id: "hacknet",
  render(state: ProjectedState) {
    const h = state.topics.hacknet;
    if (!h) return waiting("the hacknet probe");

    const summary = tiles([
      { label: "nodes", value: `${h.numNodes}`, sub: h.maxNumNodes === null ? "uncapped" : `max ${h.maxNumNodes}` },
      { label: h.servers ? "hashes/sec" : "$/sec", value: fmtNum(h.productionPerSec, 3) },
      { label: "total produced", value: h.servers ? fmtNum(h.totalProduction, 0) : fmtMoney(h.totalProduction) },
      { label: "next node", value: fmtMoney(h.purchaseNodeCost) },
      ...(h.hashes ? [{ label: "hashes", value: `${fmtNum(h.hashes.current, 0)} / ${fmtNum(h.hashes.capacity, 0)}` }] : []),
      ...(h.hashes ? [{ label: "hash sale", value: `${fmtNum(h.hashes.sellForMoneyCost, 0)} hashes / $1m` }] : []),
    ]);

    type Node = (typeof h.nodes)[number];
    const nodes = dataTable("hacknet.nodes", h.nodes, [
      { id: "name", label: "node", left: true, cell: (n: Node) => esc(n.name), sort: (n: Node) => n.name },
      { id: "level", label: "level", cell: (n: Node) => String(n.level), sort: (n: Node) => n.level },
      { id: "ram", label: "ram", cell: (n: Node) => fmtRam(n.ram), sort: (n: Node) => n.ram },
      { id: "cores", label: "cores", cell: (n: Node) => String(n.cores), sort: (n: Node) => n.cores },
      ...(h.servers
        ? [{ id: "cache", label: "cache", cell: (n: Node) => String(n.cache ?? NONE), sort: (n: Node) => n.cache ?? 0 }]
        : []),
      {
        id: "production",
        label: "production",
        cell: (n: Node) => (h.servers ? fmtNum(n.production, 3) : `${fmtMoney(n.production)}/s`),
        sort: (n: Node) => n.production,
      },
      ...(h.servers
        ? []
        : [{ id: "total", label: "total", cell: (n: Node) => fmtMoney(n.totalProduction), sort: (n: Node) => n.totalProduction }]),
      { id: "online", label: "online", cell: (n: Node) => fmtTime(n.timeOnline * 1000), sort: (n: Node) => n.timeOnline },
    ], { defaultSort: { key: "production", dir: -1 }, empty: "no nodes purchased" });

    const upgrades = h.plan?.ranked?.length
      ? rankedTable(
          ["upgrade", "cost", "adds $/sec", "payback", "horizon net", "basis"],
          h.plan.ranked.map((u) => [
            esc(u.label),
            // An upgrade the grant cannot reach yet is a different kind of
            // "not bought" than one that never repays; say which.
            h.plan!.moneyGranted < u.cost ? hint(fmtMoney(u.cost), "over the current grant") : fmtMoney(u.cost),
            u.ramBasis
              ? hint(fmtMoney(u.deltaProduction), u.ramBasis === "occupied"
                ? "valued as fleet RAM: farm income beats the hashes the busy RAM gives up"
                : "valued as idle RAM: the free-RAM hash multiplier beats farming it")
              : fmtMoney(u.deltaProduction),
            hint(fmtTime(u.paybackSec * 1000), `return/$ ${fmtNum(u.returnPerDollarSec, 8)}`),
            fmtMoney(u.netOverHorizon),
            esc(u.milestone
              ? `${u.milestone.kind} ${fmtNum(u.milestone.have, 0)}/${fmtNum(u.milestone.target, 0)}`
              : u.worthBuying === true ? (h.plan!.moneyGranted < u.cost ? "repays, over grant" : "repays")
              : u.worthBuying === false ? "past horizon" : ""),
          ]),
          { selected: (i) => h.plan!.ranked[i]!.selected, left: [0, 5] },
        )
      : note("no upgrade costs yet");

    const decision = h.plan
      ? tiles([
          { label: "horizon", value: Number.isFinite(h.plan.horizonSec) ? fmtTime(h.plan.horizonSec * 1000) : "–" },
          { label: "cash / grant", value: `${fmtMoney(h.plan.moneyAvailable)} / ${fmtMoney(h.plan.moneyGranted)}` },
          { label: "hash value", value: `${fmtMoney(h.plan.hashDollarValue)}/hash` },
          // Context, not a switch: RAM upgrades are valued as the better of
          // idle-hash and occupied-farm regardless, and each row says which won.
          { label: "fleet load", value: `${fmtNum(h.plan.fleetUtilization * 100, 1)}%`, sub: h.plan.fleetDemanded === true ? "fleet RAM is scarce" : h.plan.fleetDemanded === false ? "fleet RAM is spare" : "basis unavailable" },
        ]) +
        (h.plan.lastResult ? outcome(h.plan.lastResult) : "") +
        upgrades +
        (h.plan.rankedTotal > h.plan.ranked.length ? shownOf(h.plan.ranked.length, h.plan.rankedTotal, "scored upgrades") : "")
      : upgrades;

    const hashUpgrades = h.hashUpgrades?.length
      ? table(
          ["hash upgrade", "level", "cost"],
          h.hashUpgrades.map((u) => [esc(u.name), String(u.level), fmtNum(u.cost, 0)]),
          { left: [0] },
        )
      : "";

    const hashPlan = h.plan?.hashes
      ? tiles([
          { label: "bank", value: `${fmtNum(h.plan.hashes.current, 0)} / ${fmtNum(h.plan.hashes.capacity, 0)}` },
          { label: "production", value: `${fmtNum(h.plan.hashes.productionPerSec, 3)}/s` },
          { label: "cash quote", value: h.plan.hashes.sellForMoneyCost > 0 ? `${fmtNum(h.plan.hashes.sellForMoneyCost, 0)} / $1m` : "unavailable" },
        ]) +
        (h.plan.hashes.ranked.length
          ? rankedTable(
              ["goal", "cost", "priority", "cash alternative", "net value", "status"],
              h.plan.hashes.ranked.map((action) => [
                esc(`${action.name}${action.target ? ` @ ${action.target}` : ""}`),
                fmtNum(action.cost, 0),
                fmtNum(action.priority, 0),
                fmtMoney(action.saleValueDollars),
                action.netDollars !== undefined ? fmtMoney(action.netDollars) : "goal",
                action.eligible === false ? "worse than cash" : action.fitsCapacity === false ? "needs cache" : action.affordable ? "ready" : "saving",
              ]),
              { selected: (i) => h.plan!.hashes!.ranked[i]!.selected, left: [0, 5] },
            )
          : "") +
        (h.plan.hashes.rankedTotal > h.plan.hashes.ranked.length
          ? shownOf(h.plan.hashes.ranked.length, h.plan.hashes.rankedTotal, "scored hash goals")
          : "") +
        (h.plan.hashes.lastResult ? outcome(h.plan.hashes.lastResult) : "")
      : "";

    const history = decisionHistory(state, {
      events: ["hash.decision", "hash.result"],
      subsystem: "hacknet",
      by: "hacknet",
    });

    return (
      `<div class="col wide">` +
      card("Hacknet", summary + nodes) +
      `</div>` +
      `<div class="col">` +
      card("Decision", decision) +
      (hashPlan ? card("Hash plan", hashPlan) : "") +
      (history ? card("Decision history", history) : "") +
      (hashUpgrades ? card("Hash upgrades", hashUpgrades) : "") +
      `</div>`
    );
  },
};
