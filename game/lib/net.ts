import type { NS, ProcessInfo, Server } from "@ns";

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

export const STARTER_SCRIPT = "worker/starter.js";
export const STARTER_RAM = 2.4;
/** Keep home free for start.js + a dodge stub + handoff headroom. */
export const HOME_RESERVE_GB = 8;

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

export interface DeployPlan {
  hostname: string;
  threads: number;
  /** Replace starter processes whose arguments do not match the desired target. */
  replace: boolean;
}

export type ProcessSnapshot = Record<string, ProcessInfo[]>;

/** Budget: ps 0.2. Snapshot processes so deployment planning can distinguish
 * RAM owned by our starter from RAM owned by unrelated scripts. */
export function collectProcesses(stubNs: NS, hosts: string[]): ProcessSnapshot {
  const processes: ProcessSnapshot = {};
  for (const host of hosts) processes[host] = stubNs["ps"](host);
  return processes;
}

/** Pure: size starter threads per host from the latest server + process
 * snapshots. A correctly targeted starter is left alone. An old starter's RAM
 * is reclaimable during retargeting; unrelated script RAM remains reserved. */
export function planDeploy(
  servers: Record<string, Server>,
  processes: ProcessSnapshot,
  target: string,
): DeployPlan[] {
  const plans: DeployPlan[] = [];
  for (const server of Object.values(servers)) {
    if (!isUseful(server) && server.hostname !== "home") continue;

    const starters = (processes[server.hostname] ?? []).filter((process) => process.filename === STARTER_SCRIPT);
    if (starters.length === 1 && String(starters[0]!.args[0] ?? "") === target) continue;

    const reserve = server.hostname === "home" ? HOME_RESERVE_GB : 0;
    const reclaimableRam = starters.reduce((ram, process) => ram + process.threads * STARTER_RAM, 0);
    const threads = Math.floor((server.maxRam - server.ramUsed - reserve + reclaimableRam) / STARTER_RAM);
    // If an old starter cannot be replaced with at least one thread, preserve
    // it. The next sweep inventories the host again and retries.
    if (threads >= 1) plans.push({ hostname: server.hostname, threads, replace: starters.length > 0 });
  }
  return plans;
}

/** Budget: scriptKill 0.5 + scp 0.6 + exec 1.3 = 2.4. Copies the starter and
 * (re)starts it. Replacement plans kill existing starters only after a remote
 * copy succeeds. Failed hosts are reported and retried from a fresh inventory
 * on the next sweep.
 * Deliberately never killall: a live save may run scripts we don't own. */
export interface DeployResult {
  started: string[];
  failed: string[];
}

export async function deployStarters(stubNs: NS, plans: DeployPlan[], target: string): Promise<DeployResult> {
  const result: DeployResult = { started: [], failed: [] };
  for (const plan of plans) {
    try {
      if (plan.hostname !== "home") {
        const copied = await stubNs["scp"](STARTER_SCRIPT, plan.hostname, "home");
        if (!copied) {
          result.failed.push(plan.hostname);
          continue;
        }
      }
      if (plan.replace) stubNs["scriptKill"](STARTER_SCRIPT, plan.hostname);
      const pid = stubNs["exec"](STARTER_SCRIPT, plan.hostname, plan.threads, target);
      (pid === 0 ? result.failed : result.started).push(plan.hostname);
    } catch {
      result.failed.push(plan.hostname);
    }
  }
  return result;
}
