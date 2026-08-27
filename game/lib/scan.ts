import type { NsProxy } from "./ns-proxy.ts";
import type { StateMap } from "../../shared/telemetry/state-map.ts";

/** Full-network snapshot: a breadth-first `scan` walk from home, reading each
 * host once with `getServer`.
 *
 * Both calls go through the ns proxy, so neither member name appears dotted in
 * this bundle and the walk is billed to the resident — which pays for `scan`
 * and `getServer` once and then serves every later sweep for free.
 *
 * Return type flows from ns.getServer — this is the source of truth that types
 * the telemetry topic, the global cache, and the UI reduction. */
export async function collectServers(call: NsProxy): Promise<StateMap["servers"]> {
  const servers: StateMap["servers"] = {};
  const queue = ["home"];
  while (queue.length > 0) {
    const host = queue.pop()!;
    if (servers[host]) continue;
    servers[host] = await call("getServer", host);
    for (const neighbor of await call("scan", host)) {
      if (!servers[neighbor]) queue.push(neighbor);
    }
  }
  return servers;
}
