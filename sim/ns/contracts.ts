import type { ResetInfo, Server } from "@ns";
import type { SimServer } from "../core/effects.ts";

/** The small, shared part of Netscript's runtime contract.
 *
 * Upstream routes nearly every host argument through
 * NetscriptHelpers.getServer(), which accepts a hostname OR an IP address,
 * and every public object getter constructs a fresh API-shaped value. Keeping
 * those rules here prevents individual ns methods from slowly acquiring
 * different coercion, lookup, and copy semantics. */

export function nsString(argName: string, value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") throw new Error(`'${argName}' must be a string`);
  return value;
}

export function resolveServer(
  servers: ReadonlyMap<string, SimServer>,
  network: ReadonlyMap<string, readonly string[]>,
  rawHost: unknown,
  fallback: string,
): SimServer {
  const host = nsString("host", rawHost ?? fallback);
  const direct = servers.get(host);
  let server = direct;
  if (!server) {
    for (const candidate of servers.values()) {
      if (candidate.ip !== host) continue;
      server = candidate;
      break;
    }
  }
  // NetscriptHelpers.getServer rejects isolated ordinary servers. This is
  // what keeps the pre-Red-Pill world daemon inaccessible even though its
  // object already exists in AllServers. Darknet servers are the deliberate
  // exception: their online/offline lifecycle is represented by their class,
  // not by ordinary network adjacency.
  // Player-purchased servers are the second deliberate exception. Upstream
  // attaches them to home's network at purchase time (both
  // `purchaseServer` and `purchaseHacknetServer` push the edge), and
  // `ns.scan("home")` here already treats every `purchasedByPlayer` server as
  // home-adjacent. The simulator's `HacknetSystem.purchaseNode` registers the
  // server object without the edge, so requiring adjacency made the first
  // `ns.scan("home")` after buying a hash-mode hacknet server throw
  // `Invalid host: 'hacknet-server-0'` and kill the controller outright.
  // `w0r1d_d43m0n` is not purchasedByPlayer, so the pre-Red-Pill guard stands.
  if (server && (
    server.simKind === "DarknetServer"
    || server.purchasedByPlayer
    || (network.get(server.hostname)?.length ?? 0) > 0
  )) {
    return server;
  }
  throw new Error(`Invalid host: ${host === "" ? "'' (empty string)" : `'${host}'`}`);
}

/** Exact normal-server field projection returned by ns.getServer(). Internal
 * simulator discriminants (notably simKind) must never cross this boundary. */
export function publicServer(server: SimServer, homeMoney: number): Server {
  return {
    hostname: server.hostname,
    ip: server.ip,
    sshPortOpen: server.sshPortOpen,
    ftpPortOpen: server.ftpPortOpen,
    smtpPortOpen: server.smtpPortOpen,
    httpPortOpen: server.httpPortOpen,
    sqlPortOpen: server.sqlPortOpen,
    hasAdminRights: server.hasAdminRights,
    cpuCores: server.cpuCores,
    isConnectedTo: server.isConnectedTo,
    ramUsed: server.ramUsed,
    maxRam: server.maxRam,
    organizationName: server.organizationName,
    purchasedByPlayer: server.purchasedByPlayer,
    backdoorInstalled: server.backdoorInstalled,
    baseDifficulty: server.baseDifficulty,
    hackDifficulty: server.hackDifficulty,
    minDifficulty: server.minDifficulty,
    moneyAvailable: server.hostname === "home" ? homeMoney : server.moneyAvailable,
    moneyMax: server.moneyMax,
    numOpenPortsRequired: server.numOpenPortsRequired,
    openPortCount: server.openPortCount,
    requiredHackingSkill: server.requiredHackingSkill,
    serverGrowth: server.serverGrowth,
    ...(server.simKind === "DarknetServer" ? { isOnline: true } : {}),
  } as Server;
}

/** getResetInfo constructs a new object and new Maps on every call upstream. */
export function publicResetInfo(reset: ResetInfo): ResetInfo {
  return {
    ...reset,
    ownedAugs: new Map(reset.ownedAugs),
    ownedSF: new Map(reset.ownedSF),
    bitNodeOptions: {
      ...reset.bitNodeOptions,
      sourceFileOverrides: new Map(reset.bitNodeOptions.sourceFileOverrides),
    },
  };
}
