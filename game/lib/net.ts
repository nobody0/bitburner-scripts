import type { NS, Server } from "@ns";
import { isScriptVersion } from "../../shared/deployment.ts";
import { HOME_RESERVE_GB } from "../../shared/ram/heap.ts";

/** Network bootstrap closures — every function here runs INSIDE a dodge stub
 * (bracket-notation ns calls, so importing bundles pay nothing). Budgets are
 * noted per closure; keep them under the dodge budget you pass. */

/** Cracker programs in the order the game defines them. */
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

/** Ports-only test: hacking level is irrelevant to nuking. */
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

/** Usable as a worker host: rooted and has RAM. Hacknet Servers are genuine
 * player-owned servers; using their RAM reduces hash production, and that
 * opportunity cost is accounted for by the Hacknet investment model. */
export function isUseful(server: Server): boolean {
  return server.hasAdminRights && server.maxRam >= 2;
}

/** Budget: scp 0.6. Copies the fleet payload — the dispatcher's puppet worker
 * AND the dodge stub — to every useful rooted host. Runs on the dodged sweep so
 * the controller never pays for scp. Returns the hosts that now hold them.
 *
 * The stub ships alongside the worker because a dodge can be placed on any
 * rooted host (shared/ram/placement.ts), and `ns.exec` of a file that is not
 * there returns 0 — indistinguishable from "the host is full", so a missing
 * stub would burn every retry and look like a RAM shortage. One `scp` call
 * takes an array, so carrying the stub costs nothing extra. */
export function deployFleet(stubNs: NS, scripts: string[], servers: Record<string, Server>): string[] {
  const deployed: string[] = ["home"];
  for (const server of Object.values(servers)) {
    if (server.hostname === "home" || !isUseful(server)) continue;
    if (stubNs["scp"](scripts, server.hostname, "home")) deployed.push(server.hostname);
  }
  return deployed;
}

/** Budget: ps 0.2 + kill 0.5 + killall 0.5 = 1.2 (getHostname and pid are free).
 *
 * Cold-boot fleet reclaim. Our controller owns the fleet, so anything still
 * running when a fresh realm starts is an orphan: workers from a previous
 * session can never report completion (their descriptor map died with the old
 * realm), so their RAM would be held forever and the dispatcher would starve.
 *
 * Two hosts are handled PER-PROCESS rather than wholesale, and the second one
 * is the subtle half:
 *  - **home**, so we never kill the controller itself;
 *  - **whichever host this stub is running on**, because since dodges can be
 *    placed on the fleet this reclaim may itself be executing on a client. A
 *    blanket `killall` there would kill the very stub doing the killing, and
 *    the dodge would hang until its 10 s watchdog fired — every cold boot,
 *    non-deterministically, depending only on where placement put it.
 *
 * Returns the hosts that had something to reclaim. */
export function reclaimFleet(stubNs: NS, servers: Record<string, Server>, controllerPid: number): string[] {
  const reclaimed: string[] = [];
  // Free (0 GB) getters, so this costs the stub nothing.
  const stubHost = stubNs["getHostname"]();
  const survivors = new Set([controllerPid, stubNs["pid"]]);
  for (const server of Object.values(servers)) {
    if (!server.hasAdminRights) continue;
    if (server.hostname === "home" || server.hostname === stubHost) {
      let killed = 0;
      for (const process of stubNs["ps"](server.hostname)) {
        if (survivors.has(process.pid)) continue;
        if (stubNs["kill"](process.pid)) killed++;
      }
      if (killed > 0) reclaimed.push(server.hostname);
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
  workerBaseScript: string,
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
      if (!isScriptVersion(process.filename, workerBaseScript)) continue;
      if (registeredOpIds.has(Number(process.args[0]))) continue;
      if (stubNs["kill"](process.pid)) workers++;
    }
  }
  return { workers, retired };
}
