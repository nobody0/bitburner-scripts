import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtRam, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const hacknetTab: Tab = {
  id: "hacknet",
  render(state: ProjectedState) {
    const h = state.topics.hacknet;
    if (!h) return note("waiting for the hacknet probe");

    const summary = tiles([
      { label: "nodes", value: `${h.numNodes}`, sub: h.maxNumNodes === null ? "uncapped" : `max ${h.maxNumNodes}` },
      { label: h.servers ? "hashes/sec" : "$/sec", value: fmtNum(h.productionPerSec, 3) },
      { label: "total produced", value: h.servers ? fmtNum(h.totalProduction, 0) : fmtMoney(h.totalProduction) },
      { label: "next node", value: fmtMoney(h.purchaseNodeCost) },
      ...(h.hashes ? [{ label: "hashes", value: `${fmtNum(h.hashes.current, 0)} / ${fmtNum(h.hashes.capacity, 0)}` }] : []),
      ...(h.hashes ? [{ label: "hash sale", value: `${fmtNum(h.hashes.sellForMoneyCost, 0)} hashes / $1m` }] : []),
    ]);

    const nodes = table(
      h.servers
        ? ["node", "level", "ram", "cores", "cache", "production", "online"]
        : ["node", "level", "ram", "cores", "production", "total", "online"],
      h.nodes.map((n) =>
        h.servers
          ? [
              esc(n.name),
              String(n.level),
              fmtRam(n.ram),
              String(n.cores),
              String(n.cache ?? "–"),
              fmtNum(n.production, 3),
              fmtTime(n.timeOnline * 1000),
            ]
          : [
              esc(n.name),
              String(n.level),
              fmtRam(n.ram),
              String(n.cores),
              `${fmtMoney(n.production)}/s`,
              fmtMoney(n.totalProduction),
              fmtTime(n.timeOnline * 1000),
            ],
      ),
      { empty: "no nodes purchased", left: [0] },
    );

    const upgrades = h.plan?.ranked?.length
      ? table(
          ["pick", "upgrade", "cost", "adds $/sec", "return/$", "payback", "horizon net", "basis"],
          h.plan.ranked.map((u) => [
            u.selected ? "▶" : "",
            esc(u.label),
            fmtMoney(u.cost),
            fmtMoney(u.deltaProduction),
            fmtNum(u.returnPerDollarSec, 8),
            fmtTime(u.paybackSec * 1000),
            fmtMoney(u.netOverHorizon),
            esc(u.milestone
              ? `${u.milestone.kind} ${fmtNum(u.milestone.have, 0)}/${fmtNum(u.milestone.target, 0)}`
              : u.worthBuying === true ? "repays" : u.worthBuying === false ? "past horizon" : ""),
          ]),
          { left: [1, 7] },
        )
      : note("no upgrade costs yet");

    const decision = h.plan
      ? tiles([
          { label: "horizon", value: Number.isFinite(h.plan.horizonSec) ? fmtTime(h.plan.horizonSec * 1000) : "–" },
          { label: "cash / grant", value: `${fmtMoney(h.plan.moneyAvailable)} / ${fmtMoney(h.plan.moneyGranted)}` },
          { label: "hash value", value: `${fmtMoney(h.plan.hashDollarValue)}/hash` },
          { label: "fleet load", value: `${fmtNum(h.plan.fleetUtilization * 100, 1)}%`, sub: h.plan.fleetDemanded === true ? "Hacknet RAM has farm value" : h.plan.fleetDemanded === false ? "RAM demand not saturated" : "basis unavailable" },
        ]) +
        note(`${esc(h.plan.why)}${h.plan.hold ? ` — ${esc(h.plan.hold)}` : ""}`) +
        (h.plan.lastResult ? note(`${h.plan.lastResult.ok ? "last action succeeded" : "last action failed"}: ${esc(h.plan.lastResult.detail)}`) : "") +
        upgrades +
        (h.plan.rankedTotal > h.plan.ranked.length ? note(`showing ${h.plan.ranked.length} of ${h.plan.rankedTotal} scored upgrades`) : "")
      : upgrades;

    const hashUpgrades = h.hashUpgrades?.length
      ? table(
          ["hash upgrade", "level", "cost"],
          h.hashUpgrades.map((u) => [esc(u.name), String(u.level), fmtNum(u.cost, 0)]),
          { left: [0] },
        )
      : "";

    const hashPlan = h.plan?.hashes
      ? note(esc(h.plan.hashes.why)) +
        tiles([
          { label: "bank", value: `${fmtNum(h.plan.hashes.current, 0)} / ${fmtNum(h.plan.hashes.capacity, 0)}` },
          { label: "production", value: `${fmtNum(h.plan.hashes.productionPerSec, 3)}/s` },
          { label: "cash quote", value: h.plan.hashes.sellForMoneyCost > 0 ? `${fmtNum(h.plan.hashes.sellForMoneyCost, 0)} / $1m` : "unavailable" },
        ]) +
        (h.plan.hashes.ranked.length
          ? table(
              ["pick", "goal", "cost", "priority", "cash alternative", "net value", "status", "why"],
              h.plan.hashes.ranked.map((action) => [
                action.selected ? "▶" : "",
                esc(`${action.name}${action.target ? ` @ ${action.target}` : ""}`),
                fmtNum(action.cost, 0),
                fmtNum(action.priority, 0),
                fmtMoney(action.saleValueDollars),
                action.netDollars !== undefined ? fmtMoney(action.netDollars) : "goal",
                action.eligible === false ? "worse than cash" : action.fitsCapacity === false ? "needs cache" : action.affordable ? "ready" : "saving",
                esc(action.why),
              ]),
              { left: [1, 6, 7] },
            )
          : "") +
        (h.plan.hashes.rankedTotal > h.plan.hashes.ranked.length
          ? note(`showing ${h.plan.hashes.ranked.length} of ${h.plan.hashes.rankedTotal} scored hash goals`)
          : "") +
        (h.plan.hashes.lastResult
          ? note(`${h.plan.hashes.lastResult.ok ? "last spend succeeded" : "last spend failed"}: ${esc(h.plan.hashes.lastResult.detail)}`)
          : "")
      : "";

    const historyRows = state.events
      .filter((event) => event.kind === "event" && (
        event.name === "hash.decision" || event.name === "hash.result" ||
        (event.name === "investment.decision" && (event.data as { subsystem?: string } | undefined)?.subsystem === "hacknet") ||
        (event.name === "investment.result" && (event.data as { subsystem?: string } | undefined)?.subsystem === "hacknet")
      ))
      .slice(-10)
      .reverse()
      .map((event) => {
        const data = event.data as {
          plan?: { why?: string };
          result?: { detail?: string };
          detail?: string;
          arbitration?: {
            grants?: { by: string; id: string; amount: number }[];
            denied?: { by: string; reason: string }[];
          };
        } | undefined;
        const denied = data?.arbitration?.denied?.find((entry) => entry.by === "hacknet");
        const winners = data?.arbitration?.grants?.filter((entry) => entry.by !== "hacknet") ?? [];
        const arbiter = denied
          ? `${denied.reason}${winners.length ? `; funded ${winners.map((entry) => `${entry.by}:${entry.id} ${fmtMoney(entry.amount)}`).join(", ")}` : ""}`
          : data?.arbitration ? "funded" : "–";
        return [
          fmtTime(event.t - (state.t0 ?? event.t)),
          esc(event.kind === "event" ? event.name : ""),
          esc(data?.plan?.why ?? data?.result?.detail ?? data?.detail ?? ""),
          esc(arbiter),
        ];
      });

    return (
      `<div class="col wide">` +
      card("Hacknet", summary + nodes) +
      `</div>` +
      `<div class="col">` +
      card("ROI plan", decision) +
      (hashPlan ? card("Hash spending plan", hashPlan) : "") +
      (historyRows.length ? card("Decision history", table(["at", "transition", "reason / outcome", "arbiter"], historyRows, { left: [1, 2, 3] })) : "") +
      (hashUpgrades ? card("Hash upgrades", hashUpgrades) : "") +
      `</div>`
    );
  },
};
