import type { NS, Server } from "@ns";
import { resyncHeap, WORKER_BASE_SCRIPT } from "./dispatch-driver.ts";
import { fleetPayloadScripts } from "./fleet-payload.ts";
import { hackingState } from "./features/hacking.ts";
import {
  canRoot,
  deployFleet,
  listPortOpeners,
  reapStrayScripts,
  reclaimFleet,
  rootServers,
} from "./net.ts";
import { nsp, proxyResidents } from "./proxies.ts";
import { collectServers } from "./scan.ts";
import { set, type GameState } from "./state.ts";
import type { Telemetry } from "./telemetry.ts";

/** The fleet substrate: scan, reclaim, root, deploy, reap, reconcile.
 *
 * Infrastructure with the SHAPE of a feature refresh (read the game, write the
 * store) but deliberately not a registry feature: a rooted fleet is what every
 * feature spends — hacking is only its first customer — so it belongs to no
 * one of them, takes no part in needs/claims arbitration, and runs first in
 * the controller's refresh order. It reaches for the bare `nsp` surface for
 * the same reason: the feature-scoped accessors exist to make features pass
 * through their claims and grants, and this module has neither.
 *
 * Every ns call goes through the proxy, so none of it is charged to the
 * controller's static RAM. There is no longer any reason to batch the steps:
 * the resident pays for `scan`, `getServer`, `ps`, `scp` and the crackers once
 * apiece and every subsequent sweep reuses them for free, so the sweep reads
 * as the straight sequence it always was. */

/** One sweep. */
export async function sweepFleet(
  ns: NS,
  state: GameState,
  tel: Telemetry | undefined,
  cold: boolean,
): Promise<void> {
  const call = nsp;

  // 1) Scan the whole network (typed snapshot -> store + UI).
  set(state, "servers", await collectServers(call));

  // 1a) Cold boot: this realm is fresh, so every script still running is an
  //     orphan whose RAM we can never account for. Reclaim the fleet once,
  //     before the dispatcher tries to allocate anything.
  if (cold) {
    const reclaimed = await reclaimFleet(call, state.topics.servers!, ns.pid, proxyResidents());
    if (reclaimed.length > 0) {
      ns.tprint(`reclaimed ${reclaimed.length} host(s) from orphaned scripts`);
      TELEMETRY: if (__TELEMETRY__) tel!.event("fleet.reclaimed", { hosts: reclaimed });
    }
    set(state, "servers", await collectServers(call));
  }

  const servers = state.topics.servers!;
  const driver = hackingState();

  // 2) Openers, then rooting. `canRoot` is pure, so the decision is taken here
  //    against the snapshot. (An opener-count gate used to wrap the rooting; it
  //    was functionally dead — every real effect was already conditional on
  //    `rootable`.)
  const openers = await listPortOpeners(call);
  const rootable = Object.values(servers)
    .filter((s: Server) => !s.hasAdminRights && canRoot(s, openers))
    .map((s: Server) => s.hostname);
  const rooted = rootable.length > 0 ? await rootServers(call, rootable, openers) : [];
  if (rooted.length > 0) {
    for (const host of rooted) servers[host]!.hasAdminRights = true;
    TELEMETRY: if (__TELEMETRY__) tel!.event("net.rooted", { hosts: rooted, openers });
  }

  // 3) Deploy the fleet payload — the HGW worker and the ns resident
  //    — so any rooted host can serve a proxy call, then reap unreachable
  //    workers. Liveness comes from the realm registry (survives build
  //    handoffs), never from this instance's ledger.
  const registered = new Set(
    [...(driver.globals.worker_info?.values() ?? [])]
      .map((worker) => worker.pid)
      .filter((pid): pid is number => pid !== undefined),
  );
  const deployed = await deployFleet(call, fleetPayloadScripts(), servers);
  const reaped = await reapStrayScripts(call, deployed, WORKER_BASE_SCRIPT, registered);
  for (const host of deployed) driver.deployed.add(host);
  TELEMETRY: if (__TELEMETRY__ && reaped > 0) {
    tel!.event("fleet.reaped", { workers: reaped });
  }

  // 4) Reconcile the heap with the game's real usage.
  const drifted = resyncHeap(driver, servers);
  TELEMETRY: if (__TELEMETRY__ && drifted.length > 0) tel!.event("heap.resync", { hosts: drifted });
}
