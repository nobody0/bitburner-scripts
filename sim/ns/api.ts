import type { NS, Player, ResetInfo, Server } from "@ns";
import type { Clock } from "../clock.ts";
import type { SimServer } from "../core/effects.ts";
import { unmodeled } from "../realm/unmodeled.ts";
import type { SimWorld } from "../world.ts";
import { getRamCost, SCRIPT_BASE_RAM_GB, type RamCostContext } from "./ram-costs.ts";
import { ProcessTable, ScriptDeath, type SimProcess } from "./process.ts";

/** A synthetic Netscript runtime over SimWorld, faithful enough to run
 * game/lib/controller.ts unmodified.
 *
 * The two mechanics everything else hangs off:
 *
 * - **netscriptDelay is a timer, and the effect is a `.then` on it.** hack/grow/
 *   weaken compute their duration from state at CALL time, suspend on a virtual
 *   setTimeout, and apply the effect afterwards from state at COMPLETION time
 *   (bitburner-src/src/NetscriptFunctions.ts @ v3.0.1). Kill cancels the timer,
 *   so a killed op's effect never lands at all.
 * - **exec is synchronous bookkeeping plus a microtask start.** The pid, the RAM
 *   deduction and ns.ps visibility all happen before exec returns; main() begins
 *   on the next microtask, which is why an exec'd child always runs before the
 *   parent resumes from its next timer-based await.
 *
 * Anything not implemented here reports itself through unmodeled() and throws.
 * That is deliberate: probe-runner isolates probes and the controller isolates
 * drivers, so the run survives and the gap list becomes the roadmap. */

export type ScriptMain = (ns: NS) => unknown;

export interface SimNsHost {
  world: SimWorld;
  clock: Clock;
  processes: ProcessTable;
  /** host -> filenames present on it. */
  files: Map<string, Set<string>>;
  /** "host\0filename" -> text content, for ns.read. */
  contents: Map<string, string>;
  /** in-game filename -> module main. */
  scripts: Map<string, ScriptMain>;
  /** host -> directly connected hosts. */
  network: Map<string, string[]>;
  ramCtx: RamCostContext;
  /** ns.getResetInfo's answer. */
  reset: ResetInfo;
  /** ns.tprint output, in order. */
  output: string[];
  /** Unhandled script errors, for the run summary. */
  crashes: { pid: number; filename: string; error: string }[];
}

/** Static RAM for a script launched WITHOUT a ramOverride. Every exec site in
 * game/ passes one, so this is only a floor. */
const DEFAULT_SCRIPT_RAM_GB = SCRIPT_BASE_RAM_GB;

function fileKey(host: string, filename: string): string {
  return `${host}\0${filename}`;
}

function filesOn(host: SimNsHost, hostname: string): Set<string> {
  let set = host.files.get(hostname);
  if (!set) {
    set = new Set();
    host.files.set(hostname, set);
  }
  return set;
}

/** An unimplemented ns path. Callable AND traversable, so `ns.hacknet` resolves
 * but `ns.hacknet.getNodeStats()` reports the full dotted name. */
function unknownNode(path: string): unknown {
  const target = (): never => unmodeled("ns", path);
  return new Proxy(target, {
    get(_t, prop): unknown {
      if (typeof prop !== "string") return undefined;
      // `await ns.foo` must reject rather than hang, and instanceof checks in
      // game/lib/dodge-stub.ts must not be fooled into treating this as a
      // thenable.
      if (prop === "then" || prop === "constructor" || prop === "catch" || prop === "finally") return undefined;
      return unknownNode(`${path}.${prop}`);
    },
    apply: (): never => unmodeled("ns", path),
  });
}

/** Wrap an implemented namespace so its unimplemented siblings still report.
 * `path` is "" at the ns root, so children there are bare names. */
function namespace(impl: Record<string, unknown>, path: string): unknown {
  return new Proxy(impl, {
    get(target, prop): unknown {
      if (typeof prop === "string" && !(prop in target)) {
        return unknownNode(path === "" ? prop : `${path}.${prop}`);
      }
      return Reflect.get(target, prop) as unknown;
    },
  });
}

/** Suspend this process on the virtual clock, exactly as netscriptDelay does:
 * the timer is cancellable, and a kill rejects the await with ScriptDeath. */
function netscriptDelay(host: SimNsHost, process: SimProcess, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.delay = host.clock.in(Math.max(0, ms), () => {
      process.delay = undefined;
      process.delayReject = undefined;
      if (process.killed) reject(new ScriptDeath(process.pid));
      else resolve();
    });
    process.delayReject = reject;
  });
}

function requireServer(host: SimNsHost, hostname: string): SimServer {
  const server = host.world.servers.get(hostname);
  if (!server) throw new Error(`getServer: no such server ${hostname}`);
  return server;
}

/** Start a process's main() on the microtask queue. */
function launch(host: SimNsHost, process: SimProcess): void {
  const main = host.scripts.get(process.filename);
  if (!main) {
    host.processes.finish(process.pid);
    return;
  }
  const ns = makeSimNs(host, process);
  queueMicrotask(() => {
    if (process.killed) return;
    let outcome: unknown;
    try {
      outcome = main(ns);
    } catch (error) {
      if (!(error instanceof ScriptDeath)) {
        host.crashes.push({ pid: process.pid, filename: process.filename, error: String(error) });
      }
      host.processes.finish(process.pid);
      return;
    }
    void Promise.resolve(outcome).then(
      () => host.processes.finish(process.pid),
      (error: unknown) => {
        if (!(error instanceof ScriptDeath)) {
          host.crashes.push({ pid: process.pid, filename: process.filename, error: String(error) });
        }
        host.processes.finish(process.pid);
      },
    );
  });
}

export function makeSimNs(host: SimNsHost, process: SimProcess): NS {
  const world = host.world;

  function hgw(kind: "hack" | "grow" | "weaken") {
    return (target: string, opts?: { additionalMsec?: number; threads?: number }): Promise<number> => {
      const server = requireServer(host, target);
      const threads = opts?.threads ?? process.threads;
      // Duration from CALL-time state, additionalMsec folded in before the
      // delay starts — one longer timer, never two.
      const durationMs = world.hgwDurationMs(kind, server) + (opts?.additionalMsec ?? 0);
      if (kind === "hack") {
        if (!server.hasAdminRights) throw new Error(`hack: no admin rights on ${target}`);
        if (world.person.skills.hacking < server.requiredHackingSkill) {
          throw new Error(`hack: hacking skill too low for ${target}`);
        }
      }
      const cores = requireServer(host, process.host).cpuCores;
      return netscriptDelay(host, process, durationMs).then(() => world.land(kind, target, threads, cores).nsValue);
    };
  }

  const impl: Record<string, unknown> = {
    // --- identity -------------------------------------------------------
    args: process.args,
    pid: process.pid,

    // --- output ---------------------------------------------------------
    tprint: (...parts: unknown[]) => void host.output.push(parts.map(String).join("")),
    tprintf: (format: string, ...rest: unknown[]) => void host.output.push([format, ...rest].map(String).join(" ")),
    print: () => {},
    printf: () => {},
    disableLog: () => {},
    enableLog: () => {},
    clearLog: () => {},
    toast: () => {},

    // --- scheduling -----------------------------------------------------
    sleep: (ms = 0): Promise<boolean> => netscriptDelay(host, process, ms).then(() => true),
    // asleep is NOT cancellable and does not block concurrent ns calls.
    asleep: (ms = 0): Promise<boolean> =>
      new Promise<boolean>((resolve) => void host.clock.in(Math.max(0, ms), () => resolve(true))),
    atExit: (callback: () => void, id = "default") => void process.atExit.set(id, callback),

    // --- files ----------------------------------------------------------
    read: (filename: string): string => host.contents.get(fileKey(process.host, filename)) ?? "",
    write: (filename: string, data = "", mode = "a") => {
      const key = fileKey(process.host, filename);
      host.contents.set(key, mode === "w" ? data : (host.contents.get(key) ?? "") + data);
      filesOn(host, process.host).add(filename);
    },
    fileExists: (filename: string, hostname = process.host): boolean =>
      filesOn(host, hostname).has(filename),
    ls: (hostname: string, substring = ""): string[] =>
      [...filesOn(host, hostname)].filter((f) => f.includes(substring)).sort(),
    scp: (files: string | string[], destination: string, source = process.host): boolean => {
      const list = Array.isArray(files) ? files : [files];
      const from = filesOn(host, source);
      if (!host.world.servers.has(destination)) return false;
      for (const file of list) {
        if (!from.has(file)) return false;
        filesOn(host, destination).add(file);
        const content = host.contents.get(fileKey(source, file));
        if (content !== undefined) host.contents.set(fileKey(destination, file), content);
      }
      return true;
    },

    // --- processes ------------------------------------------------------
    exec: (
      script: string,
      hostname: string,
      threadOrOptions?: number | { threads?: number; temporary?: boolean; ramOverride?: number },
      ...args: (string | number | boolean)[]
    ): number => {
      if (!filesOn(host, hostname).has(script)) return 0;
      const options = typeof threadOrOptions === "object" ? threadOrOptions : undefined;
      const threads = (typeof threadOrOptions === "number" ? threadOrOptions : options?.threads) ?? 1;
      if (threads < 1) return 0;
      const started = host.processes.start({
        filename: script,
        host: hostname,
        args,
        threads,
        ramPerThreadGb: options?.ramOverride ?? DEFAULT_SCRIPT_RAM_GB,
        temporary: options?.temporary ?? false,
      });
      if (!started) return 0;
      launch(host, started);
      return started.pid;
    },
    kill: (pid: number): boolean => host.processes.kill(pid),
    killall: (hostname: string): boolean => host.processes.killall(hostname, process.pid) > 0,
    ps: (hostname = process.host) => host.processes.ps(hostname),
    getFunctionRamCost: (name: string): number => getRamCost(name, host.ramCtx),

    // --- world reads ----------------------------------------------------
    getPlayer: (): Player => world.playerRecord(),
    getResetInfo: (): ResetInfo => host.reset,
    getHostname: (): string => process.host,
    // A copy, like the game: the controller mutates its snapshot (setting
    // hasAdminRights after a root pass) and must not reach into the world.
    getServer: (hostname = process.host): Server => ({ ...requireServer(host, hostname) }),
    scan: (hostname = process.host): string[] => [...(host.network.get(hostname) ?? [])],
    hasRootAccess: (hostname: string): boolean => requireServer(host, hostname).hasAdminRights,
    getServerMoneyAvailable: (hostname: string): number => requireServer(host, hostname).moneyAvailable ?? 0,
    getServerSecurityLevel: (hostname: string): number => requireServer(host, hostname).hackDifficulty ?? 0,
    getServerMaxRam: (hostname: string): number => requireServer(host, hostname).maxRam,
    getServerUsedRam: (hostname: string): number => requireServer(host, hostname).ramUsed,

    // --- ops ------------------------------------------------------------
    hack: hgw("hack"),
    grow: hgw("grow"),
    weaken: hgw("weaken"),

    // --- rooting --------------------------------------------------------
    brutessh: (hostname: string) => void (requireServer(host, hostname).sshPortOpen = true),
    ftpcrack: (hostname: string) => void (requireServer(host, hostname).ftpPortOpen = true),
    relaysmtp: (hostname: string) => void (requireServer(host, hostname).smtpPortOpen = true),
    httpworm: (hostname: string) => void (requireServer(host, hostname).httpPortOpen = true),
    sqlinject: (hostname: string) => void (requireServer(host, hostname).sqlPortOpen = true),
    nuke: (hostname: string) => {
      const server = requireServer(host, hostname);
      const open = [
        server.sshPortOpen,
        server.ftpPortOpen,
        server.smtpPortOpen,
        server.httpPortOpen,
        server.sqlPortOpen,
      ].filter(Boolean).length;
      if (open < (server.numOpenPortsRequired ?? 0)) {
        throw new Error(`nuke: not enough open ports on ${hostname}`);
      }
      server.openPortCount = open;
      server.hasAdminRights = true;
    },
  };

  // Partially-implemented namespaces: the gate batch reads exactly these, and
  // every other member of each reports itself.
  impl["gang"] = namespace({ inGang: () => world.gates.inGang }, "gang");
  impl["bladeburner"] = namespace({ inBladeburner: () => world.gates.inBladeburner }, "bladeburner");
  impl["corporation"] = namespace({ hasCorporation: () => world.gates.hasCorporation }, "corporation");
  impl["stock"] = namespace(
    {
      hasWseAccount: () => world.gates.hasWseAccount,
      hasTixApiAccess: () => world.gates.hasTixApiAccess,
    },
    "stock",
  );
  impl["go"] = namespace(
    {
      getGameState: () => {
        if (!world.gates.goPlayable) unmodeled("subsystem", "go", "IPvGO has no simulation model");
        return { currentPlayer: "None", whiteScore: 0, blackScore: 0, previousMove: null };
      },
    },
    "go",
  );

  return namespace(impl, "") as NS;
}

export { ProcessTable, ScriptDeath, launch };
