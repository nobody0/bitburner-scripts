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
      { label: "nodes", value: `${h.numNodes}`, sub: `max ${h.maxNumNodes}` },
      { label: h.servers ? "hashes/sec" : "$/sec", value: fmtNum(h.productionPerSec, 3) },
      { label: "total produced", value: h.servers ? fmtNum(h.totalProduction, 0) : fmtMoney(h.totalProduction) },
      { label: "next node", value: fmtMoney(h.purchaseNodeCost) },
      ...(h.hashes ? [{ label: "hashes", value: `${fmtNum(h.hashes.current, 0)} / ${fmtNum(h.hashes.capacity, 0)}` }] : []),
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
      "no nodes purchased",
    );

    const upgrades = h.nextUpgrades?.length
      ? table(
          ["upgrade", "cheapest node", "cost"],
          h.nextUpgrades.map((u) => [esc(u.kind), `#${u.node}`, fmtMoney(u.cost)]),
        )
      : note("no upgrade costs yet");

    const hashUpgrades = h.hashUpgrades?.length
      ? table(
          ["hash upgrade", "level", "cost"],
          h.hashUpgrades.map((u) => [esc(u.name), String(u.level), fmtNum(u.cost, 0)]),
        )
      : "";

    return (
      `<div class="col wide">` +
      card("Hacknet", summary + nodes) +
      `</div>` +
      `<div class="col">` +
      card("Cheapest upgrades", upgrades) +
      (hashUpgrades ? card("Hash upgrades", hashUpgrades) : "") +
      `</div>`
    );
  },
};
