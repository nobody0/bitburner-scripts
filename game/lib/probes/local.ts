import type { Server } from "@ns";
import type { FleetRollup } from "../../../shared/telemetry/topics/hacking.ts";
import { emit, type LocalProbe, type ProbeContext } from "./index.ts";

/** Zero-cost probes: everything derivable from the sweep snapshot
 * (ns.getPlayer, already watched; the servers map, already scanned). No ns
 * call, no dodge, no budget — these run every sweep unconditionally.
 *
 * This tier exists because home RAM is scarce: the heap hands the dispatcher
 * everything above HOME_RESERVE_GB, so the dodge budget stays small forever.
 * Anything that can be computed from state we already paid for should be, and
 * the Career / Fleet / joined-factions panels are never empty as a result. */

/** Fleet aggregates from the sweep snapshot. Exported so the priced
 * `hacking.cloud` probe can republish a complete FleetRollup rather than a
 * fragment. */
export function fleetFrom(
  servers: Record<string, Server>,
  previousPurchased?: FleetRollup["purchased"],
): FleetRollup {
  let rootedHosts = 0;
  let totalHosts = 0;
  let maxRam = 0;
  let usedRam = 0;
  let purchasedCount = 0;
  let purchasedRam = 0;
  // How many port openers we own, inferred from the network rather than from
  // an ns call. `rootServers` runs EVERY cracker it holds against every host
  // it touches, so the most ports opened anywhere is the size of our toolkit.
  // A lower bound before the first rooting attempt, exact after — and free,
  // where `ns.ls("home", ".exe")` would cost dodge budget every sweep.
  //
  // Player-owned machines are EXCLUDED from the inference: the game reports
  // `home` with all five ports open regardless of which crackers exist.
  // Count only opener-induced ports; server state is not evidence that the
  // corresponding executable is owned.
  // Source (each cracker increments openPortCount once): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L549-L622
  let portOpeners = 0;
  for (const server of Object.values(servers)) {
    totalHosts++;
    if (!server.purchasedByPlayer && server.hostname !== "home"
      && (server.openPortCount ?? 0) > portOpeners) {
      portOpeners = server.openPortCount ?? 0;
    }
    if (!server.hasAdminRights) continue;
    rootedHosts++;
    maxRam += server.maxRam;
    usedRam += server.ramUsed;
    if (server.purchasedByPlayer && server.hostname !== "home" && !server.hostname.startsWith("hacknet-server-")) {
      purchasedCount++;
      purchasedRam += server.maxRam;
    }
  }
  const home = servers["home"];
  return {
    rootedHosts,
    totalHosts,
    maxRam,
    usedRam,
    portOpeners,
    // `limit` and `maxRamPerServer` come from the slower priced cloud probe.
    // The server map is also sweep-cadenced, while a successful action advances
    // these totals immediately. Preserve that newer observation until the next
    // complete cloud probe instead of rewinding it every local-probe pass.
    purchased: {
      ...previousPurchased,
      count: Math.max(purchasedCount, previousPurchased?.count ?? 0),
      totalRam: Math.max(purchasedRam, previousPurchased?.totalRam ?? 0),
    },
    home: { maxRam: home?.maxRam ?? 0, usedRam: home?.ramUsed ?? 0, cores: home?.cpuCores ?? 1 },
  };
}

const careerProbe: LocalProbe = {
  id: "career.local",
  kind: "local",
  feature: "career",
  everyMs: 5_000,
  merge: true,
  run({ player }: ProbeContext) {
    return [
      emit("career", {
        karma: player.karma,
        numPeopleKilled: player.numPeopleKilled,
        skills: player.skills,
        exp: player.exp,
        city: String(player.city),
        location: String(player.location),
        entropy: player.entropy,
        totalPlaytime: player.totalPlaytime,
        jobs: Object.fromEntries(Object.entries(player.jobs).map(([co, job]) => [String(co), String(job)])),
      }),
    ];
  },
};

const factionsProbe: LocalProbe = {
  id: "factions.local",
  kind: "local",
  feature: "factions",
  everyMs: 5_000,
  merge: true,
  run({ player }: ProbeContext) {
    // Player.factions is free and needs no singularity access, so the tab has
    // something real even without SF4.
    return [emit("factions", { joined: player.factions.map(String) })];
  },
};

const fleetProbe: LocalProbe = {
  id: "hacking.fleet",
  kind: "local",
  feature: "hacking",
  everyMs: 5_000,
  merge: true,
  run({ servers, state }: ProbeContext) {
    return [emit("fleet", fleetFrom(servers, state.topics.fleet?.purchased))];
  },
};

export const LOCAL_PROBES: readonly LocalProbe[] = [careerProbe, factionsProbe, fleetProbe];
