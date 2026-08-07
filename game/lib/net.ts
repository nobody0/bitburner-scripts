import type { NS, Server } from "@ns";
import { HOME_RESERVE_GB } from "../../shared/ram/heap.ts";

/** Network bootstrap closures — every function here runs INSIDE a dodge stub
 * (bracket-notation ns calls, so importing bundles pay nothing). Budgets are
 * noted per closure; keep them under the dodge budget you pass. */

/** Cracker programs in the order the game defines them (legacy PROGRAMS_MAP). */
const CRACKERS = [
  { file: "BruteSSH.exe", portFlag: "sshPortOpen" },
  { file: "FTPCrack.exe", portFlag: "ftpPortOpen" },
  { file: "relaySMTP.exe", portFlag: "smtpPortOpen" },
  { file: "HTTPWorm.exe", portFlag: "httpPortOpen" },
  { file: "SQLInject.exe", portFlag: "sqlPortOpen" },
] as const;

export { HOME_RESERVE_GB } from "../../shared/ram/heap.ts";

/** Budget: ls 0.2. Returns the cracker files present on home, in game order. */
export function listPortOpeners(stubNs: NS): string[] {
  const files = new Set(stubNs["ls"]("home", ".exe"));
  return CRACKERS.filter((c) => files.has(c.file)).map((c) => c.file);
}

/** Ports-only test, exactly like legacy canRoot: hacking level is irrelevant
 * to nuking. */
export function canRoot(server: Server, openers: string[]): boolean {
  const have = new Set(openers);
  let openable = 0;
  for (const cracker of CRACKERS) {
    if (have.has(cracker.file) && !server[cracker.portFlag]) openable++;
  }
  return openable + (server.openPortCount ?? 0) >= (server.numOpenPortsRequired ?? 5);
}

/** Budget: 5 crackers x 0.05 + nuke 0.05 = 0.3. Runs every available cracker
 * on every host, then nukes. Returns the hosts now rooted. */
export function rootServers(stubNs: NS, hosts: string[], openers: string[]): string[] {
  const have = new Set(openers);
  const rooted: string[] = [];
  for (const host of hosts) {
    if (have.has("BruteSSH.exe")) stubNs["brutessh"](host);
    if (have.has("FTPCrack.exe")) stubNs["ftpcrack"](host);
    if (have.has("relaySMTP.exe")) stubNs["relaysmtp"](host);
    if (have.has("HTTPWorm.exe")) stubNs["httpworm"](host);
    if (have.has("SQLInject.exe")) stubNs["sqlinject"](host);
    try {
      stubNs["nuke"](host);
      rooted.push(host);
    } catch {
      /* not enough open ports after all — skip */
    }
  }
  return rooted;
}

/** Legacy isUseful: rooted, has RAM, not a hacknet server. */
export function isUseful(server: Server): boolean {
  return server.hasAdminRights && server.maxRam >= 2 && !server.hostname.startsWith("hacknet-");
}

/** Budget: scp 0.6. Copies the dispatcher's puppet worker to every useful
 * rooted host. Runs on the dodged sweep so the controller never pays for scp.
 * Returns the hosts that now hold the worker. */
export function deployWorker(stubNs: NS, script: string, servers: Record<string, Server>): string[] {
  const deployed: string[] = ["home"];
  for (const server of Object.values(servers)) {
    if (server.hostname === "home" || !isUseful(server)) continue;
    if (stubNs["scp"](script, server.hostname, "home")) deployed.push(server.hostname);
  }
  return deployed;
}

/** Budget: ps 0.2 + kill 0.5 + killall 0.5 = 1.2.
 *
 * Cold-boot fleet reclaim. Our controller owns the fleet, so anything still
 * running when a fresh realm starts is an orphan: workers from a previous
 * session can never report completion (their descriptor map died with the old
 * realm), so their RAM would be held forever and the dispatcher would starve.
 *
 * Home is handled per-process so we never kill ourselves or the dodge stub we
 * are currently running inside; other rooted hosts are cleared wholesale.
 * Returns the hosts that had something to reclaim. */
export function reclaimFleet(stubNs: NS, servers: Record<string, Server>, controllerPid: number): string[] {
  const reclaimed: string[] = [];
  for (const server of Object.values(servers)) {
    if (!server.hasAdminRights) continue;
    if (server.hostname === "home") {
      const survivors = new Set([controllerPid, stubNs["pid"]]);
      let killed = 0;
      for (const process of stubNs["ps"]("home")) {
        if (survivors.has(process.pid)) continue;
        if (stubNs["kill"](process.pid)) killed++;
      }
      if (killed > 0) reclaimed.push("home");
      continue;
    }
    if (server.ramUsed > 0) {
      stubNs["killall"](server.hostname);
      reclaimed.push(server.hostname);
    }
  }
  return reclaimed;
}

/** Scripts from earlier versions of this project. They are killed wherever
 * they turn up, so a build push is enough to retire an architecture — no game
 * reload required. */
export const RETIRED_SCRIPTS = ["worker/starter.js", "main.js"];

/** Budget: ps 0.2 + kill 0.5 = 0.7. Continuous safety net run every sweep:
 * kills retired scripts, plus workers whose op is no longer registered.
 *
 * Liveness is tested against the realm-level worker registry, NOT the
 * dispatcher's own ledger: a build handoff gives the new controller a fresh
 * ledger while its workers keep running, so using the ledger here would kill
 * the whole in-flight fleet on every push. The registry dies only with the
 * realm, which is exactly when those workers really are unreachable. */
export function reapStrayScripts(
  stubNs: NS,
  hosts: string[],
  workerScript: string,
  registeredOpIds: Set<number>,
): { workers: number; retired: number } {
  const retiredNames = new Set(RETIRED_SCRIPTS);
  let workers = 0;
  let retired = 0;
  for (const host of hosts) {
    for (const process of stubNs["ps"](host)) {
      if (retiredNames.has(process.filename)) {
        if (stubNs["kill"](process.pid)) retired++;
        continue;
      }
      if (process.filename !== workerScript) continue;
      if (registeredOpIds.has(Number(process.args[0]))) continue;
      if (stubNs["kill"](process.pid)) workers++;
    }
  }
  return { workers, retired };
}
