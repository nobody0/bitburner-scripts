import type { NS } from "@ns";
import type { StateMap } from "../../shared/telemetry/state-map.ts";

/** Full-network snapshot, built to run INSIDE a dodge closure: every ns call
 * uses bracket notation on the stub's ns, so the importing bundle is charged
 * nothing (dynamic cost in the stub: scan 0.2 + getServer 2.0 < 2.5 budget).
 * Return type flows from ns.getServer — this is the source of truth that
 * types the telemetry topic, the global cache, and the UI reduction. */
export function collectServers(stubNs: NS): StateMap["servers"] {
  const servers: StateMap["servers"] = {};
  const queue = ["home"];
  while (queue.length > 0) {
    const host = queue.pop()!;
    if (servers[host]) continue;
    servers[host] = stubNs["getServer"](host);
    for (const neighbor of stubNs["scan"](host)) {
      if (!servers[neighbor]) queue.push(neighbor);
    }
  }
  return servers;
}
