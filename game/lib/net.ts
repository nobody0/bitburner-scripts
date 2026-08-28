import type { Server } from "@ns";
import type { NsProxy } from "./ns-proxy.ts";

/** Network bootstrap: crackers, rooting, payload deployment and the two kill
 * sweeps. Every ns call goes through the proxy's string path, so none of these
 * member names is charged to the bundle that imports them; the resident pays
 * for each once and every later sweep reuses it. The pure predicates
 * (`canRoot`, `isUseful`) take a plain `Server` and stay synchronous. */

/** Cracker programs in the order the game exposes their port operations.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L549-L622 */
const CRACKERS = [
  { file: "BruteSSH.exe", portFlag: "sshPortOpen" },
  { file: "FTPCrack.exe", portFlag: "ftpPortOpen" },
  { file: "relaySMTP.exe", portFlag: "smtpPortOpen" },
  { file: "HTTPWorm.exe", portFlag: "httpPortOpen" },
  { file: "SQLInject.exe", portFlag: "sqlPortOpen" },
] as const;

/** The cracker files present on home, in game order. */
export async function listPortOpeners(call: NsProxy): Promise<string[]> {
  const files = new Set(await call("ls", "home", ".exe"));
  return CRACKERS.filter((c) => files.has(c.file)).map((c) => c.file);
}

/** Ports-only test: hacking level is irrelevant to nuking.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L531-L547 */
export function canRoot(server: Server, openers: string[]): boolean {
  const have = new Set(openers);
  let openable = 0;
  for (const cracker of CRACKERS) {
    if (have.has(cracker.file) && !server[cracker.portFlag]) openable++;
  }
  return openable + (server.openPortCount ?? 0) >= (server.numOpenPortsRequired ?? 5);
}

/** Runs every available cracker on every host, then nukes. Returns the hosts
 * now rooted. */
export async function rootServers(call: NsProxy, hosts: string[], openers: string[]): Promise<string[]> {
  const have = new Set(openers);
  const rooted: string[] = [];
  for (const host of hosts) {
    if (have.has("BruteSSH.exe")) await call("brutessh", host);
    if (have.has("FTPCrack.exe")) await call("ftpcrack", host);
    if (have.has("relaySMTP.exe")) await call("relaysmtp", host);
    if (have.has("HTTPWorm.exe")) await call("httpworm", host);
    if (have.has("SQLInject.exe")) await call("sqlinject", host);
    try {
      if (await call("nuke", host)) rooted.push(host);
    } catch {
      /* not enough open ports after all — skip */
    }
  }
  return rooted;
}

/** Usable as a worker host: rooted and has RAM. Hacknet Servers are genuine
 * player-owned servers; using their RAM reduces hash production, and that
 * opportunity cost is accounted for by the Hacknet investment model.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacknet/HacknetServer.ts#L121-L126 */
export function isUseful(server: Server): boolean {
  return server.hasAdminRights && server.maxRam >= 2;
}

/** Copies the fleet payload to every useful rooted host. Returns the hosts
 * that now hold it.
 *
 * The payload carries the ns resident alongside the dispatcher's puppet worker,
 * because any of them can be placed on any rooted host
 * (shared/ram/broker.ts) and `ns.exec` of a file that is not there returns 0 —
 * indistinguishable from "the host is full", so a missing payload file would
 * burn every retry and look like a RAM shortage. One `scp` call takes an
 * array, so carrying them costs nothing extra.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L634-L651 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L766-L825 */
export async function deployFleet(
  call: NsProxy,
  scripts: string[],
  servers: Record<string, Server>,
): Promise<string[]> {
  const deployed: string[] = ["home"];
  for (const server of Object.values(servers)) {
    if (server.hostname === "home" || !isUseful(server)) continue;
    if (await call("scp", scripts, server.hostname, "home")) deployed.push(server.hostname);
  }
  return deployed;
}

/** Cold-boot fleet reclaim. Our controller owns the fleet, so anything still
 * running when a fresh realm starts is an orphan: workers from a previous
 * session can never report completion (their descriptor map died with the old
 * realm), so their RAM would be held forever and the dispatcher would starve.
 *
 * Some hosts are handled PER-PROCESS rather than by `killall`:
 *  - **home**, so we never kill the controller itself;
 *  - **every host holding an ns resident**, so no resident is killed by a
 *    sweep it is not even making. That is not hypothetical: residents are
 *    placed wherever the broker has room, and killing one mid-call leaves the
 *    awaited promise unresolved — the caller HANGS, not merely stalls, which
 *    is worse than the dodger's failure mode (a stub had a ten-second
 *    watchdog).
 *
 * The ACTING resident reads its own identity, because it is the only process
 * that knows where it is and it can migrate between calls as the fleet grows.
 * The others cannot be read that way and are passed in by the caller, which
 * holds their handles.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L742-L759
 *
 * Returns the hosts that had something to reclaim. */
export async function reclaimFleet(
  call: NsProxy,
  servers: Record<string, Server>,
  controllerPid: number,
  residents: readonly { pid: number; host: string }[] = [],
): Promise<string[]> {
  const me = await call("self");
  const reclaimed: string[] = [];
  const survivors = new Set([controllerPid, me.pid, ...residents.map((r) => r.pid)]);
  const perProcess = new Set(["home", me.server, ...residents.map((r) => r.host)]);
  for (const server of Object.values(servers)) {
    if (!server.hasAdminRights) continue;
    if (perProcess.has(server.hostname)) {
      let killed = 0;
      for (const process of await call("ps", server.hostname)) {
        if (survivors.has(process.pid)) continue;
        if (await call("kill", process.pid)) killed++;
      }
      if (killed > 0) reclaimed.push(server.hostname);
      continue;
    }
    if (server.ramUsed > 0) {
      await call("killall", server.hostname);
      reclaimed.push(server.hostname);
    }
  }
  return reclaimed;
}

/** Continuous safety net run every sweep: kills workers whose process is no
 * longer registered.
 *
 * Liveness is tested against the worker registry, not the dispatcher's planning
 * ledger. The registry tracks the actual processes that may still be finishing
 * work after their originating batch has left the planner. */
export async function reapStrayScripts(
  call: NsProxy,
  hosts: string[],
  workerBaseScript: string,
  registeredPids: Set<number>,
): Promise<number> {
  let workers = 0;
  for (const host of hosts) {
    for (const process of await call("ps", host)) {
      if (process.filename !== workerBaseScript) continue;
      if (registeredPids.has(process.pid)) continue;
      if (await call("kill", process.pid)) workers++;
    }
  }
  return workers;
}
