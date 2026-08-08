import type { NS, Server } from "@ns";
import { resyncHeap, WORKER_BASE_SCRIPT, workerScript } from "./dispatch-driver.ts";
import { dodge, dodgeStubScript } from "./dodge.ts";
import { hackingState } from "./features/hacking.ts";
import {
  canRoot,
  deployFleet,
  listPortOpeners,
  reapStrayScripts,
  reclaimFleet,
  rootServers,
} from "./net.ts";
import { collectServers } from "./scan.ts";
import { set, type GameState } from "./state.ts";
import type { Telemetry } from "./telemetry.ts";

/** The fleet substrate: scan, reclaim, root, deploy, reap, reconcile.
 *
 * Infrastructure with the SHAPE of a feature refresh (read the game, write the
 * store) but deliberately not a registry feature: a rooted fleet is what every
 * feature spends — hacking is only its first customer — so it belongs to no
 * one of them, takes no part in needs/claims arbitration, and runs first in
 * the controller's refresh order. It keeps the raw `dodge` primitive for the
 * same reason: featureDodge exists to make features pass through their claims
 * and grants, and this module has neither.
 *
 * Every step is dodged, so none of it is charged to the controller's static
 * RAM. */

/** One sweep. */
export async function sweepFleet(
  ns: NS,
  state: GameState,
  tel: Telemetry | undefined,
  cold: boolean,
): Promise<void> {
  // 1) Scan the whole network (typed snapshot -> store + UI).
  set(state, "servers", await dodge(ns, collectServers));

  // 1a) Cold boot: this realm is fresh, so every script still running is an
  //     orphan whose RAM we can never account for. Reclaim the fleet once,
  //     before the dispatcher tries to allocate anything.
  if (cold) {
    const self = ns.pid;
    const snapshot = state.topics.servers!;
    const reclaimed = await dodge(ns, (stubNs) => reclaimFleet(stubNs, snapshot, self), 1.5);
    if (reclaimed.length > 0) {
      ns.tprint(`reclaimed ${reclaimed.length} host(s) from orphaned scripts`);
      TELEMETRY: if (__TELEMETRY__) tel!.event("fleet.reclaimed", { hosts: reclaimed });
    }
    set(state, "servers", await dodge(ns, collectServers));
  }

  const servers = state.topics.servers!;
  const driver = hackingState();

  // 2) Root anything newly rootable. (An opener-count gate used to wrap this;
  //    it was functionally dead — every real effect was already conditional
  //    on `rootable`, which is recomputed from the fresh scan each sweep.)
  const openers = await dodge(ns, listPortOpeners, 0.5);
  const rootable = Object.values(servers).filter((s: Server) => !s.hasAdminRights && canRoot(s, openers));
  if (rootable.length > 0) {
    const hosts = rootable.map((s: Server) => s.hostname);
    const rooted = await dodge(ns, (stubNs) => rootServers(stubNs, hosts, openers), 1);
    for (const host of rooted) servers[host]!.hasAdminRights = true;
    TELEMETRY: if (__TELEMETRY__) tel!.event("net.rooted", { hosts: rooted, openers });
  }

  // 3) Deploy the fleet payload — puppet worker AND dodge stub — so any rooted
  //    host can serve a dodge (dodged: scp stays out of our RAM bill).
  const deployed = await dodge(ns, (stubNs) => deployFleet(stubNs, [workerScript(), dodgeStubScript()], servers), 1);
  for (const host of deployed) driver.deployed.add(host);

  // 3a) Safety net: retire old architectures and kill unreachable workers.
  //     Liveness comes from the realm registry (survives build handoffs),
  //     never from this instance's ledger.
  const registered = new Set(driver.globals.worker_info?.keys() ?? []);
  const reaped = await dodge(ns, (stubNs) => reapStrayScripts(stubNs, deployed, WORKER_BASE_SCRIPT, registered), 1);
  TELEMETRY: if (__TELEMETRY__ && (reaped.workers > 0 || reaped.retired > 0)) {
    tel!.event("fleet.reaped", reaped);
  }

  // 4) Reconcile the heap with the game's real usage.
  const drifted = resyncHeap(driver, servers);
  TELEMETRY: if (__TELEMETRY__ && drifted.length > 0) tel!.event("heap.resync", { hosts: drifted });
}
