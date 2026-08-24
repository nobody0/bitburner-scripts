import type { NS, Player, ResetInfo, Server } from "@ns";
import type { Clock } from "../clock.ts";
import { countCall } from "../cost.ts";
import type { SimServer } from "../core/effects.ts";
import type { Engine } from "../engine.ts";
import type { HacknetSystem } from "../features/hacknet.ts";
import type { GoSystem } from "../features/go-system.ts";
import type { ShareSystem } from "../features/share.ts";
import type { StanekSystem } from "../features/stanek.ts";
import type { StockMarketSystem } from "../features/stock.ts";
import type { ContractSystem } from "../features/contracts.ts";
import { getBitNodeMultipliers as vendoredBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { StockMarketConstants as STOCK_CONSTANTS } from "../vendor/bitburner/src/StockMarket/data/Constants.ts";
import { getDarknetVolatilityMult } from "../vendor/bitburner/src/StockMarket/MarketAdapter.ts";
import { PositionType } from "../vendor/bitburner/src/StockMarket/Enums.ts";
import {
  getBuyTransactionCost,
  getSellTransactionGain,
} from "../vendor/bitburner/src/StockMarket/StockMarketHelpers.ts";
import { CodingContractName } from "../vendor/bitburner/src/CodingContract/Enums.ts";
import { noteUnmodeled, unmodeled } from "../realm/unmodeled.ts";
import type { SimWorld } from "../world.ts";
import { getCloudServerCost, getCloudServerLimit, getCloudServerMaxRam, getCloudServerUpgradeCost } from "../core/effects.ts";
import { getFunctionRamCost, SCRIPT_BASE_RAM_GB, type RamCostContext } from "./ram-costs.ts";
import { ProcessTable, ScriptDeath, type SimProcess } from "./process.ts";
import { publicResetInfo, publicServer, resolveServer } from "./contracts.ts";
import { makeStanek } from "./stanek.ts";
import { calculateDnetAuthenticateTime, darknetGate, makeDnet } from "./dnet.ts";
import type { DarknetSystem } from "../features/dnet.ts";
import { ShareBonusTime } from "../vendor/bitburner/src/NetworkShare/Share.ts";

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

export interface SimGoState {
  currentPlayer: "White" | "Black" | "None";
  whiteScore: number;
  blackScore: number;
  previousMove: [number, number] | null;
  komi: number;
  bonusCycles: number;
}

export interface SimNsHost {
  world: SimWorld;
  clock: Clock;
  /** Wall-clock domain used by Date.now()/ResetInfo. Test harnesses without
   * virtual time may omit this and remain in the relative clock domain. */
  nowMs?: () => number;
  /** null means a save supplied an unknown live board; undefined means the
   * exact fresh-game state used by synthetic/unit worlds. */
  goState?: SimGoState | null;
  /** Full Go lifecycle used by game-driver simulations. Unit harnesses may
   * omit it and retain the narrow goState getter fixture above. */
  go?: GoSystem;
  processes: ProcessTable;
  /** host -> filenames present on it. */
  files: Map<string, Set<string>>;
  /** "host\0filename" -> text content, for ns.read. */
  contents: Map<string, string>;
  /** in-game filename -> module main. */
  scripts: Map<string, ScriptMain>;
  /** host -> directly connected hosts. */
  network: Map<string, string[]>;
  /** The darknet, present once something can reach it. */
  dnet?: DarknetSystem;
  ramCtx: RamCostContext;
  /** ns.getResetInfo's answer. */
  reset: ResetInfo;
  /** ns.tprint output, in order. */
  output: string[];
  /** Unhandled script errors, for the run summary. */
  crashes: { pid: number; filename: string; error: string }[];
  /** BitNodeOptions.disableBladeburner, which is independent of API access. */
  bladeburnerDisabled?: boolean;
  /** The game's SECOND timebase (sim/engine.ts).
   *
   *  Present so an ns call can poke a counter the way the game does —
   *  `Singularity.checkFactionInvitations` resets `checkFactionInvitations` to
   *  force an immediate re-check rather than waiting out the 2 s cycle. Absent
   *  in harnesses that drive ns without an engine. */
  engine?: Engine;
  /** The singularity namespace plus its two loose members, when a run wires a
   *  faction system. Built by sim/ns/singularity.ts. */
  singularity?: {
    singularity: Record<string, unknown>;
    grafting: Record<string, unknown>;
    getFavorToDonate: () => number;
    enums: Record<string, unknown>;
    installBackdoorWithDelay: (delay: (ms: number) => Promise<void>) => Promise<void>;
  };
  hacknet?: HacknetSystem;
  share?: ShareSystem;
  stanek?: StanekSystem;
  /** The World Stock Exchange, when a run wires one. Absent means the whole
   *  namespace degrades to the gate flags, which is what a run with no market
   *  model should see. */
  stock?: StockMarketSystem;
  contracts?: ContractSystem;
  /** Called when an augmentation install prestiges the run.
   *
   *  Lives here rather than in `game/` on purpose: a prestige kills every
   *  process, so `game/`'s module-level dispatcher ledger and the realm
   *  rendezvous slots describe a world that no longer exists. `game/` must stay
   *  unaware it is being simulated, so the simulator owns the cleanup. */
  onPrestige?: (cbScript: string | undefined, newlyInstalled: ReadonlyMap<string, number>) => void;
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
function concurrentCall(host: SimNsHost, process: SimProcess, path: string): void {
  if (process.killed) throw new ScriptDeath(process.pid);
  if (!process.runningFn || path === "asleep") return;
  const running = process.runningFn;
  const error = new Error(
    `Concurrent calls to Netscript functions are not allowed! Currently running: ${running}; tried to run: ${path}`,
  );
  // This is the point at which Bitburner terminates the worker. Recording it
  // here matters because application code can catch the immediate Error; the
  // following Netscript call then only observes ScriptDeath, which is normal
  // cancellation and is intentionally omitted by launch().
  host.crashes.push({ pid: process.pid, filename: process.filename, error: String(error) });
  host.processes.kill(process.pid);
  throw error;
}

function unknownNode(path: string, host: SimNsHost, process: SimProcess): unknown {
  const target = (): never => unmodeled("ns", path);
  return new Proxy(target, {
    get(_t, prop): unknown {
      if (typeof prop !== "string") return undefined;
      // `await ns.foo` must reject rather than hang, and instanceof checks in
      // game/lib/dodge-stub.ts must not be fooled into treating this as a
      // thenable.
      if (prop === "then" || prop === "constructor" || prop === "catch" || prop === "finally") return undefined;
      return unknownNode(`${path}.${prop}`, host, process);
    },
    apply: (): never => {
      concurrentCall(host, process, path);
      return unmodeled("ns", path);
    },
  });
}

/** Wrap an implemented namespace so its unimplemented siblings still report.
 * `path` is "" at the ns root, so children there are bare names. */
function namespace(impl: Record<string, unknown>, path: string, host: SimNsHost, process: SimProcess): unknown {
  return new Proxy(impl, {
    get(target, prop): unknown {
      if (typeof prop === "string" && !(prop in target)) {
        return unknownNode(path === "" ? prop : `${path}.${prop}`, host, process);
      }
      const value = Reflect.get(target, prop) as unknown;
      if (typeof prop !== "string" || typeof value !== "function") return value;
      const functionPath = path === "" ? prop : `${path}.${prop}`;
      return (...args: unknown[]): unknown => {
        // Only counts when --cost armed the meter; otherwise a null check.
        countCall(functionPath);
        concurrentCall(host, process, functionPath);
        const result = (value as (...inner: unknown[]) => unknown)(...args);
        if (functionPath === "asleep" || !(result instanceof Promise) || process.runningFn) return result;
        process.runningFn = functionPath;
        return result.finally(() => {
          if (process.runningFn === functionPath) process.runningFn = undefined;
        });
      };
    },
  });
}

/** Suspend this process on the virtual clock, exactly as netscriptDelay does:
 * the timer is cancellable, and a kill rejects the await with ScriptDeath. */
function netscriptDelay(host: SimNsHost, process: SimProcess, ms: number, functionName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.runningFn = functionName;
    process.delay = host.clock.in(Math.max(0, ms), () => {
      process.delay = undefined;
      process.delayReject = undefined;
      process.runningFn = undefined;
      if (process.killed) reject(new ScriptDeath(process.pid));
      else resolve();
    });
    process.delayReject = reject;
  });
}

function requireServer(host: SimNsHost, hostname: unknown, fallback = "home"): SimServer {
  return resolveServer(host.world.servers, host.network, hostname, fallback);
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
    return (target: string, rawOpts?: unknown): Promise<number> => {
      if (rawOpts != null && typeof rawOpts !== "object") {
        throw new Error(`${kind}: BasicHGWOptions must be an object if specified`);
      }
      const opts = (rawOpts ?? {}) as { additionalMsec?: unknown; threads?: unknown; stock?: unknown };
      const asNumber = (name: string, value: unknown): number => {
        const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
        if (typeof parsed !== "number" || Number.isNaN(parsed)) throw new Error(`${kind}: '${name}' must be a number`);
        return parsed;
      };
      const additionalMsec = asNumber("opts.additionalMsec", opts.additionalMsec ?? 0);
      if (additionalMsec < 0) throw new Error(`${kind}: additionalMsec must be non-negative`);
      if (additionalMsec > 1e9) throw new Error(`${kind}: additionalMsec too large (>1e9)`);
      const requested = opts.threads;
      const threads = !requested ? process.threads : asNumber("opts.threads", requested);
      if (threads <= 0) throw new Error(`${kind}: opts.threads must be a positive number`);
      if (threads > process.threads) {
        throw new Error(`${kind}: Too many threads requested. Requested: ${threads}. Has: ${process.threads}.`);
      }
      const server = requireServer(host, target, process.host);
      if (server.simKind === "DarknetServer") throw new Error(`${kind}: the server must not be a darknet server`);
      if (server.purchasedByPlayer) throw new Error(`${kind}: cannot target a purchased server`);
      if (!server.hasAdminRights) throw new Error(`${kind}: no admin rights on ${target}`);
      // Duration from CALL-time state, additionalMsec folded in before the
      // delay starts — one longer timer, never two.
      const durationMs = world.hgwDurationMs(kind, server) + additionalMsec;
      if (kind === "hack") {
        if (world.person.skills.hacking < server.requiredHackingSkill) {
          throw new Error(`hack: hacking skill too low for ${target}`);
        }
      }
      const cores = requireServer(host, process.host).cpuCores;
      // `stock: true` is honoured at COMPLETION, not at call time: the influence
      // roll is against the money actually moved, which is not known until the
      // op lands (NetscriptHelpers.tsx:614, NetscriptFunctions.ts:305).
      const stock = !!opts.stock;
      return netscriptDelay(host, process, durationMs, kind).then(
        () => {
          const landed = world.land(kind, server.hostname, threads, cores, stock);
          process.onlineExpGained += landed.result?.expGained ?? 0;
          if (kind === "hack") process.onlineMoneyMade += landed.nsValue;
          return landed.nsValue;
        },
      );
    };
  }

  function openPort(
    hostname: string,
    program: string,
    flag: "sshPortOpen" | "ftpPortOpen" | "smtpPortOpen" | "httpPortOpen" | "sqlPortOpen",
  ): boolean {
    const server = requireServer(host, hostname);
    if (!filesOn(host, "home").has(program)) return false;
    if (!server[flag]) {
      server[flag] = true;
      server.openPortCount = (server.openPortCount ?? 0) + 1;
    }
    return true;
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
    sleep: (ms = 0): Promise<boolean> => netscriptDelay(host, process, ms, "sleep").then(() => true),
    // asleep is NOT cancellable and does not block concurrent ns calls.
    asleep: (ms = 0): Promise<boolean> =>
      new Promise<boolean>((resolve) => void host.clock.in(Math.max(0, ms), () => resolve(true))),
    atExit: (callback: () => void, id = "default") => void process.atExit.set(id, callback),

    ramOverride: (ram?: number): number => {
      const currentPerThread = Math.round((process.ramGb / process.threads) * 100) / 100;
      if (ram === undefined) return currentPerThread;
      const wanted = Math.round(Number(ram) * 100) / 100;
      if (!Number.isFinite(wanted)) throw new Error("ram must be a finite number");
      if (wanted === currentPerThread) return currentPerThread;
      return unmodeled(
        "ns",
        "ramOverride",
        "changing an allocation requires per-process dynamic RAM accounting",
      );
    },

    // --- files ----------------------------------------------------------
    read: (filename: string): string => host.contents.get(fileKey(process.host, filename)) ?? "",
    write: (filename: string, data = "", mode = "a") => {
      const key = fileKey(process.host, filename);
      host.contents.set(key, mode === "w" ? data : (host.contents.get(key) ?? "") + data);
      filesOn(host, process.host).add(filename);
    },
    fileExists: (filename: string, hostname: unknown = process.host): boolean =>
      filesOn(host, requireServer(host, hostname, process.host).hostname).has(filename),
    ls: (hostname: unknown = process.host, substring = ""): string[] => {
      const target = requireServer(host, hostname, process.host).hostname;
      // ls is how a script discovers .cache files: upstream appends a darknet
      // server's caches to its file list rather than storing them alongside.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L845-L851
      const caches = host.dnet?.cachesOn(target) ?? [];
      // The storm seed rides the same append: upstream lists a darknet
      // server's `programs` in `ls` too, and exposes them nowhere else.
      const seed = host.dnet?.stormSeedOn(target) === true ? ["STORM_SEED.exe"] : [];
      return [...filesOn(host, target), ...caches, ...seed].filter((f) => f.includes(substring)).sort();
    },
    rm: (filename: string, hostname: unknown = process.host): boolean => {
      const target = requireServer(host, hostname, process.host).hostname;
      const removed = filesOn(host, target).delete(filename);
      host.contents.delete(fileKey(target, filename));
      return removed;
    },
    scp: (files: string | string[], rawDestination: unknown, rawSource: unknown = process.host): boolean => {
      const list = Array.isArray(files) ? files : [files];
      const source = requireServer(host, rawSource, process.host).hostname;
      const destination = requireServer(host, rawDestination, process.host).hostname;
      // Copying TO a darknet host needs a session — but NO direct connection, at
      // any distance. Copying FROM one needs nothing at all: upstream checks the
      // destination and never the source. That asymmetry is why data is nearly
      // free to move out there and a running PROCESS is the hard problem.
      if (host.dnet) {
        const gate = darknetGate(host.dnet, host.world.servers, process, destination, {});
        if (!gate.allowed) return false;
      }
      const from = filesOn(host, source);
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
      rawHostname: string,
      threadOrOptions?: number | { threads?: number; temporary?: boolean; ramOverride?: number },
      ...args: (string | number | boolean)[]
    ): number => {
      const hostname = requireServer(host, rawHostname, process.host).hostname;
      // exec needs a session AND a direct connection (or a backdoor). The
      // connection check runs BEFORE the darkweb early-out upstream, which is
      // why exec onto `darkweb` works only from `home` — the one host holding
      // the TOR edge. A dodge stub placed anywhere else scps happily and then
      // gets a silent 0 here.
      if (host.dnet) {
        const gate = darknetGate(host.dnet, host.world.servers, process, hostname, {
          requireDirectConnection: true,
          backdoorBypasses: true,
        });
        if (!gate.allowed) return 0;
      }
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
        parentPid: process.pid,
      });
      if (!started) return 0;
      launch(host, started);
      return started.pid;
    },
    /** `ns.spawn`: kill the caller, then start the target on the SAME host.
     *
     * With `spawnDelay: 0` upstream kills the worker script and runs the target
     * immediately and synchronously; any other delay schedules it. Modelled
     * because the darknet agents are built on it — a resident spawns into a job
     * so the job gets the RAM the resident was holding, and peak host RAM is one
     * script rather than two.
     *
     * The ORDER is the load-bearing part: kill first, launch second. Launching
     * first would need both allocations at once, which is exactly the situation
     * spawning exists to avoid, and a host with room for one would silently
     * refuse.
     * Source: src/NetscriptFunctions.ts:653-690 */
    spawn: (
      script: string,
      threadOrOptions?: number | { threads?: number; temporary?: boolean; ramOverride?: number; spawnDelay?: number },
      ...args: (string | number | boolean)[]
    ): void => {
      const options = typeof threadOrOptions === "object" ? threadOrOptions : undefined;
      const threads = (typeof threadOrOptions === "number" ? threadOrOptions : options?.threads) ?? 1;
      const delayMs = options?.spawnDelay ?? 10_000;
      const hostname = process.host;
      const launchSpawned = (): void => {
        if (!filesOn(host, hostname).has(script)) return;
        const started = host.processes.start({
          filename: script,
          host: hostname,
          args,
          threads,
          ramPerThreadGb: options?.ramOverride ?? DEFAULT_SCRIPT_RAM_GB,
          temporary: options?.temporary ?? false,
        });
        if (started) launch(host, started);
      };
      // Kill the caller FIRST, so its allocation is free for the target.
      host.processes.kill(process.pid);
      if (delayMs === 0) launchSpawned();
      else host.clock.in(delayMs, launchSpawned);
      // Upstream throws ScriptDeath so the caller's remaining code never runs.
      throw new ScriptDeath(process.pid);
    },
    kill: (pid: number): boolean => host.processes.kill(pid),
    // The pid form ignores the hostname, as upstream does: the worker map is
    // global, and this is what lets the darknet controller vouch (and kill) a
    // job on a host it could never exec onto.
    isRunning: (script: unknown, hostname?: unknown, ...args: (string | number | boolean)[]): boolean => {
      if (typeof script === "number") return host.processes.get(script) !== undefined;
      const target = requireServer(host, hostname, process.host).hostname;
      return host.processes
        .ps(target)
        .some((p) =>
          p.filename === script
          && p.args.length === args.length
          && p.args.every((arg, index) => arg === args[index]),
        );
    },
    killall: (hostname: unknown = process.host): boolean =>
      host.processes.killall(requireServer(host, hostname, process.host).hostname, process.pid) > 0,
    ps: (hostname: unknown = process.host) =>
      host.processes.ps(requireServer(host, hostname, process.host).hostname),
    getFunctionRamCost: (name: unknown): number => {
      if (typeof name !== "string" && typeof name !== "number") {
        throw new Error("getFunctionRamCost: 'name' must be a string");
      }
      return getFunctionRamCost(String(name), host.ramCtx);
    },

    // --- world reads ----------------------------------------------------
    getPlayer: (): Player => world.playerRecord(),
    getResetInfo: (): ResetInfo => publicResetInfo(host.reset),
    getBitNodeMultipliers: (n?: number, lvl?: number) => {
      const currentNode = host.reset.currentNode ?? world.bitnode;
      const sf5 = host.reset.ownedSF?.get(5) ?? world.player.sourceFiles["5"] ?? 0;
      if (currentNode !== 5 && sf5 <= 0) {
        throw new Error("getBitNodeMultipliers: requires BitNode 5 or Source-File 5");
      }
      const node = n ?? currentNode;
      const level = lvl ?? (
        node === 12
          ? (host.reset.ownedSF?.get(12) ?? world.player.sourceFiles["12"] ?? 0) + (currentNode === 12 ? 1 : 0)
          : 1
      );
      return { ...vendoredBitNodeMultipliers(node, level) };
    },
    getMoneySources: () => structuredClone(world.moneySources),
    getTotalScriptIncome: (): [number, number] => {
      let current = 0;
      for (const running of host.processes.values()) {
        current += running.onlineMoneyMade / running.onlineRunningTimeSeconds;
      }
      const sinceInstallSec = Math.max(0, (host.nowMs?.() ?? host.clock.now()) - host.reset.lastAugReset) / 1_000;
      const sinceInstall = sinceInstallSec > 0 ? world.moneySources.sinceInstall.hacking / sinceInstallSec : 0;
      return [current, sinceInstall];
    },
    getTotalScriptExpGain: (): number => {
      let current = 0;
      for (const running of host.processes.values()) {
        current += running.onlineExpGained / running.onlineRunningTimeSeconds;
      }
      return current;
    },
    share: (): Promise<void> => {
      const share = host.share ?? unmodeled("subsystem", "NetworkShare");
      const cores = requireServer(host, process.host).cpuCores;
      const release = share.startSharing(process.threads, cores);
      return netscriptDelay(host, process, ShareBonusTime, "share").finally(release);
    },
    getSharePower: (): number =>
      (host.share ?? unmodeled("subsystem", "NetworkShare")).currentBonus(),
    getHostname: (): string => process.host,
    // 0 GB, and exactly the process's own filename. Telemetry labels itself with
    // this, so without it any script that reports at all dies on its first line.
    getScriptName: (): string => process.filename,
    // A copy, like the game: the controller mutates its snapshot (setting
    // hasAdminRights after a root pass) and must not reach into the world.
    getServer: (hostname: unknown = process.host): Server =>
      publicServer(requireServer(host, hostname, process.host), world.player.money),
    scan: (hostname: unknown = process.host, returnOpts?: unknown): string[] => {
      const server = requireServer(host, hostname, process.host);
      const returnByIP = !!(
        returnOpts
        && typeof returnOpts === "object"
        && (returnOpts as { returnByIP?: unknown }).returnByIP
      );
      const known = new Set(host.network.get(server.hostname) ?? []);
      if (server.hostname === "home") {
        for (const server of world.servers.values()) {
          if (server.hostname !== "home" && server.purchasedByPlayer) known.add(server.hostname);
        }
      } else if (server.purchasedByPlayer) {
        known.add("home");
      }
      // Darknet servers are deliberately invisible to scan upstream —
      // `if (s === null || s instanceof DarknetServer) continue;` — which is why
      // ns.dnet.probe() exists at all. Without this, `darkweb` would appear in
      // the fleet snapshot and, once correctly rooted, be treated as a 16 GB
      // worker host the real game never offers.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L185-L191
      return [...known]
        .map((entry) => requireServer(host, entry))
        .filter((neighbour) => neighbour.simKind !== "DarknetServer")
        .map((neighbour) => (returnByIP ? neighbour.ip : neighbour.hostname));
    },
    hasRootAccess: (hostname: unknown): boolean => requireServer(host, hostname, process.host).hasAdminRights,
    getServerMoneyAvailable: (hostname: unknown): number => {
      const server = requireServer(host, hostname, process.host);
      return server.hostname === "home" ? world.player.money : server.moneyAvailable;
    },
    getServerSecurityLevel: (hostname: unknown): number => requireServer(host, hostname, process.host).hackDifficulty ?? 0,
    getServerMaxRam: (hostname: unknown): number => requireServer(host, hostname, process.host).maxRam,
    getServerUsedRam: (hostname: unknown): number => requireServer(host, hostname, process.host).ramUsed,
    // v3.0.1 NetscriptFunctions.ts: dnsLookup is bidirectional. The shared
    // resolver already applies Netscript's hostname/IP coercion and visibility
    // rules; unlike ordinary getters this API returns "" for an invalid host.
    dnsLookup: (rawHost: unknown = process.host): string => {
      let server: SimServer;
      try {
        server = requireServer(host, rawHost, process.host);
      } catch {
        return "";
      }
      const query = typeof rawHost === "number" ? String(rawHost) : rawHost;
      return query === server.ip ? server.hostname : server.ip;
    },

    // --- ops ------------------------------------------------------------
    hack: hgw("hack"),
    grow: hgw("grow"),
    weaken: hgw("weaken"),

    // --- rooting --------------------------------------------------------
    brutessh: (hostname: string): boolean => openPort(hostname, "BruteSSH.exe", "sshPortOpen"),
    ftpcrack: (hostname: string): boolean => openPort(hostname, "FTPCrack.exe", "ftpPortOpen"),
    relaysmtp: (hostname: string): boolean => openPort(hostname, "relaySMTP.exe", "smtpPortOpen"),
    httpworm: (hostname: string): boolean => openPort(hostname, "HTTPWorm.exe", "httpPortOpen"),
    sqlinject: (hostname: string): boolean => openPort(hostname, "SQLInject.exe", "sqlPortOpen"),
    nuke: (hostname: string): boolean => {
      const server = requireServer(host, hostname);
      if (server.hasAdminRights) return true;
      if (!filesOn(host, "home").has("NUKE.exe")) return false;
      if ((server.openPortCount ?? 0) < (server.numOpenPortsRequired ?? 0)) return false;
      server.hasAdminRights = true;
      return true;
    },
  };

  // Partially-implemented namespaces: the gate batch reads exactly these, and
  // every other member of each reports itself.
  impl["gang"] = namespace({ inGang: () => world.gates.inGang }, "gang", host, process);
  impl["bladeburner"] = namespace({
    inBladeburner: () => world.gates.inBladeburner,
    joinBladeburnerDivision: (): boolean => {
      const access = world.bitnode === 6
        || world.bitnode === 7
        || (world.player.sourceFiles["6"] ?? 0) > 0
        || (world.player.sourceFiles["7"] ?? 0) > 0;
      if (!access || host.bladeburnerDisabled || currentNodeMults.BladeburnerRank === 0) return false;
      if (world.gates.inBladeburner) return true;
      const skills = world.person.skills;
      const combatReady = Math.min(skills.strength, skills.defense, skills.dexterity, skills.agility) >= 100;
      if (!combatReady) return false;
      world.gates.inBladeburner = true;
      noteUnmodeled(
        "subsystem",
        "bladeburner",
        "the division was joined but its autonomous engine lifecycle is not modeled",
      );
      world.emit({ kind: "event", name: "bladeburner.joined", data: {} });
      return true;
    },
  }, "bladeburner", host, process);
  impl["corporation"] = namespace({ hasCorporation: () => world.gates.hasCorporation }, "corporation", host, process);
  // The market, when a run wires one. Every getter reads the vendored `Stock`
  // objects directly, so a price, a spread or a forecast the strategy sees is
  // the same value the vendored price engine just wrote.
  //
  // The gate checks match upstream exactly, because the strategy is built to
  // climb the unlock ladder and a stub that answered anyway would let it skip
  // rungs: `getSymbols` and everything below it need the TIX API, and
  // `getForecast`/`getVolatility` need has4SDataTixApi — NOT has4SData, which is
  // the $1b ticker data a script can never read.
  if (host.stock) {
    const stock = host.stock;
    const requireTix = (fn: string): void => {
      if (!stock.hasTixApiAccess) throw new Error(`${fn}: no TIX API access`);
    };
    const requireForecast = (fn: string): void => {
      if (!stock.has4SDataTixApi) throw new Error(`${fn}: no 4S Market Data TIX API access`);
    };
    const require4SPosition = (fn: string, symbol: string) => {
      requireTix(fn);
      const found = stock.stock(symbol);
      if (!found) throw new Error(`${fn}: invalid stock symbol ${symbol}`);
      return found;
    };
    /** Upstream `Player.activeSourceFileLvl`: a BitNodeOptions override REPLACES
     *  the owned level when the key is present, including at level 0. Reading
     *  `ownedSF` alone would hand a script a rung the run disabled. */
    const activeSF = (n: number): number => {
      const overrides = host.reset.bitNodeOptions?.sourceFileOverrides;
      if (overrides?.has(n)) return overrides.get(n) ?? 0;
      return host.reset.ownedSF.get(n) ?? 0;
    };
    const requireShorts = (fn: string): void => {
      if (host.ramCtx.bitNode !== 8 && activeSF(8) <= 1) {
        throw new Error(`${fn}: shorts need BN8 or SF8 level 2`);
      }
    };
    // Upstream gates the whole order book — reading it included — on BN8 or
    // SF8.3, and throws otherwise. Answering with an empty book instead would
    // let a script below the rung believe it had looked and seen nothing.
    const requireOrders = (fn: string): void => {
      if (host.ramCtx.bitNode !== 8 && activeSF(8) <= 2) {
        throw new Error(`${fn}: limit/stop orders need BN8 or SF8 level 3`);
      }
    };
    const positionType = (raw: unknown, fn: string): PositionType => {
      if (raw === PositionType.Long || raw === PositionType.Short) return raw;
      throw new Error(`${fn}: invalid position type ${String(raw)}`);
    };
    impl["stock"] = namespace(
      {
        hasWseAccount: () => stock.hasWseAccount,
        hasTixApiAccess: () => stock.hasTixApiAccess,
        has4SData: () => stock.has4SData,
        has4SDataTixApi: () => stock.has4SDataTixApi,
        getConstants: () => structuredClone(STOCK_CONSTANTS),
        getSymbols: () => {
          requireTix("getSymbols");
          return stock.symbols();
        },
        getPrice: (symbol: string) => require4SPosition("getPrice", symbol).price,
        getAskPrice: (symbol: string) => require4SPosition("getAskPrice", symbol).getAskPrice(),
        getBidPrice: (symbol: string) => require4SPosition("getBidPrice", symbol).getBidPrice(),
        getOrganization: (symbol: string) => require4SPosition("getOrganization", symbol).name,
        getMaxShares: (symbol: string) => require4SPosition("getMaxShares", symbol).maxShares,
        getPosition: (symbol: string) => {
          const found = require4SPosition("getPosition", symbol);
          return [found.playerShares, found.playerAvgPx, found.playerShortShares, found.playerAvgShortPx];
        },
        getForecast: (symbol: string) => {
          requireForecast("getForecast");
          const found = require4SPosition("getForecast", symbol);
          return found.getAbsoluteForecast() / 100;
        },
        // `mv` alone is the UNPROMOTED volatility. Upstream multiplies by the
        // darknet boost here exactly as the price engine does, so a script that
        // promoted a symbol can see what the tick will actually use.
        getVolatility: (symbol: string) => {
          requireForecast("getVolatility");
          const found = require4SPosition("getVolatility", symbol);
          return (found.mv * getDarknetVolatilityMult(found.symbol)) / 100;
        },
        getPurchaseCost: (symbol: string, shares: number, posType: unknown) => {
          const found = require4SPosition("getPurchaseCost", symbol);
          const cost = getBuyTransactionCost(found, Math.round(shares), positionType(posType, "getPurchaseCost"));
          return cost ?? Infinity;
        },
        getSaleGain: (symbol: string, shares: number, posType: unknown) => {
          const found = require4SPosition("getSaleGain", symbol);
          const gain = getSellTransactionGain(found, Math.round(shares), positionType(posType, "getSaleGain"));
          return gain ?? 0;
        },
        buyStock: (symbol: string, shares: number) => {
          requireTix("buyStock");
          return stock.buyStock(symbol, shares);
        },
        sellStock: (symbol: string, shares: number) => {
          requireTix("sellStock");
          return stock.sellStock(symbol, shares);
        },
        buyShort: (symbol: string, shares: number) => {
          requireTix("buyShort");
          requireShorts("buyShort");
          return stock.buyShort(symbol, shares);
        },
        sellShort: (symbol: string, shares: number) => {
          requireTix("sellShort");
          requireShorts("sellShort");
          return stock.sellShort(symbol, shares);
        },
        purchaseWseAccount: () => stock.purchaseWseAccount(),
        purchaseTixApi: () => stock.purchaseTixApi(),
        purchase4SMarketData: () => stock.purchase4SMarketData(),
        purchase4SMarketDataTixApi: () => {
          requireTix("purchase4SMarketDataTixApi");
          return stock.purchase4SMarketDataTixApi();
        },
        // Reading an EMPTY order book is fully modelled, once past the same
        // BN8/SF8.3 gate upstream applies. Fresh worlds have no orders, our
        // strategy never places one, and save seeding separately marks a
        // non-empty saved book invalid before the controller starts.
        // Returning `{}` here is therefore observed state, not a fabricated
        // fill engine. Mutating the book remains deliberately unmodelled.
        getOrders: () => {
          requireTix("getOrders");
          requireOrders("getOrders");
          return {};
        },
        placeOrder: () => unmodeled("ns", "stock.placeOrder", "limit/stop orders have no simulation model"),
        cancelOrder: () => unmodeled("ns", "stock.cancelOrder", "limit/stop orders have no simulation model"),
      },
      "stock",
      host,
      process,
    );
  } else {
    impl["stock"] = namespace(
      {
        hasWseAccount: () => world.gates.hasWseAccount,
        hasTixApiAccess: () => world.gates.hasTixApiAccess,
        has4SData: () => world.gates.has4SData,
        has4SDataTixApi: () => world.gates.has4SDataTixApi,
      },
      "stock",
      host,
      process,
    );
  }
  impl["cloud"] = namespace({
    getServerLimit: () => getCloudServerLimit(),
    getRamLimit: () => getCloudServerMaxRam(),
    getServerCost: (ram: number) => getCloudServerCost(ram),
    getServerUpgradeCost: (hostname: unknown, ram: number) => {
      try {
        const server = requireServer(host, hostname, process.host);
        if (!server.purchasedByPlayer || server.hostname === "home" || server.hostname.startsWith("hacknet-server-")) return -1;
        return getCloudServerUpgradeCost(server.maxRam, ram);
      } catch {
        // Cloud.ts deliberately turns every validation/lookup failure into
        // the API's sentinel rather than exposing the helper exception.
        return -1;
      }
    },
    getServerNames: () => [...world.servers.values()]
      .filter((server) => server.purchasedByPlayer && server.hostname !== "home" && !server.hostname.startsWith("hacknet-server-"))
      .map((server) => server.hostname),
    purchaseServer: (requested: string, ram: number) => {
      let name = String(requested).replaceAll(" ", "");
      if (!name) return "";
      const base = name;
      let suffix = 0;
      while (world.servers.has(name)) name = `${base}-${suffix++}`;
      if (!world.execute({ type: "buyServer", name, ram })) return "";
      host.network.set(name, ["home"]);
      const homeLinks = host.network.get("home") ?? [];
      if (!homeLinks.includes(name)) host.network.set("home", [...homeLinks, name]);
      return name;
    },
    upgradeServer: (hostname: unknown, ram: number) => {
      try {
        return world.execute({ type: "upgradeServer", host: requireServer(host, hostname, process.host).hostname, ram });
      } catch {
        return false;
      }
    },
  }, "cloud", host, process);
  const goAnalysis = host.go
    ? namespace({
        getStats: () => host.go!.getStats(),
        getControlledEmptyNodes: () => host.go!.getControlledEmptyNodes(),
      }, "go.analysis", host, process)
    : namespace({}, "go.analysis", host, process);
  const goCheat = host.go
    ? namespace({
        getCheatSuccessChance: (count?: number, playAsWhite = false) => playAsWhite
          ? unmodeled("ns", "go.cheat.getCheatSuccessChance", "white-side No AI Go is not modeled")
          : host.go!.getCheatSuccessChance(count),
        getCheatCount: (playAsWhite = false) => playAsWhite
          ? unmodeled("ns", "go.cheat.getCheatCount", "white-side No AI Go is not modeled")
          : host.go!.getCheatCount(),
        removeRouter: (x: number, y: number, playAsWhite = false) => playAsWhite
          ? unmodeled("ns", "go.cheat.removeRouter", "white-side No AI Go is not modeled")
          : host.go!.removeRouter(x, y),
        playTwoMoves: (x1: number, y1: number, x2: number, y2: number, playAsWhite = false) => playAsWhite
          ? unmodeled("ns", "go.cheat.playTwoMoves", "white-side No AI Go is not modeled")
          : host.go!.playTwoMoves(x1, y1, x2, y2),
        repairOfflineNode: (x: number, y: number, playAsWhite = false) => playAsWhite
          ? unmodeled("ns", "go.cheat.repairOfflineNode", "white-side No AI Go is not modeled")
          : host.go!.repairOfflineNode(x, y),
        destroyNode: (x: number, y: number, playAsWhite = false) => playAsWhite
          ? unmodeled("ns", "go.cheat.destroyNode", "white-side No AI Go is not modeled")
          : host.go!.destroyNode(x, y),
      }, "go.cheat", host, process)
    : namespace({}, "go.cheat", host, process);
  impl["go"] = namespace(
    host.go
      ? {
          getGameState: () => host.go!.getGameState(),
          getBoardState: () => host.go!.getBoardState(),
          getMoveHistory: () => host.go!.getMoveHistory(),
          getCurrentPlayer: () => host.go!.getCurrentPlayer(),
          getOpponent: () => host.go!.getOpponent(),
          resetBoardState: (opponent: string, boardSize: number) => host.go!.resetBoardState(opponent, boardSize),
          makeMove: (x: number, y: number) => host.go!.makeMove(x, y),
          passTurn: () => host.go!.passTurn(),
          opponentNextTurn: () => host.go!.opponentNextTurn(),
          analysis: goAnalysis,
          cheat: goCheat,
        }
      : {
        getGameState: () => {
        // Exact fresh-game state: GoObject.currentGame starts as an empty 7x7
        // Netburners board. This getter is universally reachable, so the
        // capability probe must succeed. Deeper Go calls still fall through
        // to unmodeled(), invalidating an enabled Go lifecycle.
        if (host.goState === null) {
          return unmodeled(
            "initial-state",
            "IPvGO game state",
            "the save decoder does not yet retain the live board, opponent, history, scores, and stored cycles",
          );
        }
        return structuredClone(host.goState ?? {
          currentPlayer: "Black",
          whiteScore: 1.5,
          blackScore: 0,
          previousMove: null,
          komi: 1.5,
          bonusCycles: 0,
        });
        },
        analysis: goAnalysis,
        cheat: goCheat,
      },
    "go",
    host,
    process,
  );
  impl["codingcontract"] = namespace(
    host.contracts ? {
      getContractTypes: () => Object.values(CodingContractName),
      getContractType: (filename: string, rawHost: unknown = process.host) => {
        const target = requireServer(host, rawHost, process.host).hostname;
        return host.contracts!.type(target, String(filename));
      },
      getNumTriesRemaining: (filename: string, rawHost: unknown = process.host) => {
        const target = requireServer(host, rawHost, process.host).hostname;
        return host.contracts!.triesRemaining(target, String(filename));
      },
      getData: (filename: string, rawHost: unknown = process.host) => {
        const target = requireServer(host, rawHost, process.host).hostname;
        return host.contracts!.data(target, String(filename));
      },
      attempt: (answer: unknown, filename: string, rawHost: unknown = process.host) => {
        const target = requireServer(host, rawHost, process.host).hostname;
        return host.contracts!.attempt(target, String(filename), answer);
      },
    } : { getContractTypes: () => Object.values(CodingContractName) },
    "codingcontract",
    host,
    process,
  );

  if (host.stanek) {
    impl["stanek"] = namespace(
      makeStanek({
        system: host.stanek,
        process,
        hostCores: () => requireServer(host, process.host).cpuCores,
        delay: (ms) => netscriptDelay(host, process, ms, "stanek.chargeFragment"),
      }),
      "stanek",
      host,
      process,
    );
  }

  if (host.dnet) {
    const dnet = host.dnet;
    impl["dnet"] = namespace(
      makeDnet({
        system: dnet,
        process,
        // The same virtual-clock suspension hack/grow/weaken use, so a killed
        // authentication never grants a session.
        delay: (ms, fn) => netscriptDelay(host, process, ms, fn),
        skills: () => ({
          charisma: host.world.person.skills.charisma,
          intelligence: host.world.person.skills.intelligence,
        }),
        nowMs: () => host.clock.now(),
        hasBoots: () => host.world.player.augmentations.has("The B00ts of Perseus"),
        sf15Level: () => host.world.player.sourceFiles["15"] ?? 0,
        servers: host.world.servers,
        charismaExpMult: () => host.world.person.mults.charisma_exp,
        gainCharismaExp: (amount) => {
          if (!Number.isFinite(amount)) return;
          host.world.person.exp.charisma = Math.max(0, host.world.person.exp.charisma + amount);
          host.world.recalculateSkills();
        },
      }),
      "dnet",
      host,
      process,
    );
  }

  if (host.dnet) {
    const timingOptions = {
      system: host.dnet,
      skills: () => ({
        charisma: host.world.person.skills.charisma,
        intelligence: host.world.person.skills.intelligence,
      }),
      hasBoots: () => host.world.player.augmentations.has("The B00ts of Perseus"),
      sf15Level: () => host.world.player.sourceFiles["15"] ?? 0,
    };
    impl["formulas"] = namespace({
      dnet: namespace({
        getAuthenticateTime: (rawDetails: unknown, threads = 1, rawPlayer?: unknown, correctChars = 0): number => {
          if (rawPlayer !== undefined) {
            return unmodeled("ns", "formulas.dnet.getAuthenticateTime", "an explicit mock player is not retained");
          }
          return calculateDnetAuthenticateTime(
            timingOptions,
            rawDetails as { modelId: string; difficulty: number; depth: number; requiredCharismaSkill: number },
            Number(threads),
            Number(correctChars),
          );
        },
      }, "formulas.dnet", host, process),
    }, "formulas", host, process);
  }
  if (host.hacknet) {
    const hacknet = host.hacknet;
    impl["hacknet"] = namespace(
      {
        numNodes: () => hacknet.nodes.length,
        maxNumNodes: () => hacknet.maxNodes,
        purchaseNode: () => hacknet.purchaseNode(),
        getPurchaseNodeCost: () => hacknet.nodeCost(),
        getNodeStats: (index: number) => {
          const node = hacknet.nodes[index];
          if (!node) throw new Error(`hacknet.getNodeStats: no node ${index}`);
          const server = node.hostname ? world.servers.get(node.hostname) : undefined;
          return {
            name: node.hostname ?? `hacknet-node-${index}`,
            level: node.level,
            ram: server?.maxRam ?? node.ram,
            cores: node.cores,
            production: hacknet.production(node),
            totalProduction: node.totalProduction,
            timeOnline: node.onlineTimeSeconds,
            ...(hacknet.hashMode
              ? {
                  cache: node.cache ?? 1,
                  hashCapacity: 32 * Math.pow(2, node.cache ?? 1),
                  ramUsed: server?.ramUsed ?? node.ramUsed ?? 0,
                }
              : {}),
          };
        },
        upgradeLevel: (index: number, n = 1) => hacknet.upgradeLevel(index, n),
        upgradeRam: (index: number, n = 1) => hacknet.upgradeRam(index, n),
        upgradeCore: (index: number, n = 1) => hacknet.upgradeCore(index, n),
        upgradeCache: (index: number, n = 1) => hacknet.upgradeCache(index, n),
        getLevelUpgradeCost: (index: number) => hacknet.levelCost(index),
        getRamUpgradeCost: (index: number) => hacknet.ramCost(index),
        getCoreUpgradeCost: (index: number) => hacknet.coreCost(index),
        getCacheUpgradeCost: (index: number) => hacknet.cacheCost(index),
        numHashes: () => hacknet.hashes,
        hashCapacity: () => hacknet.hashCapacity(),
        hashCost: (name: string, count = 1) => hacknet.hashCost(name, count),
        spendHashes: (name: string, target = "", count = 1) => hacknet.spendHashes(name, target, count),
        getHashUpgrades: () => hacknet.hashUpgrades(),
        getHashUpgradeLevel: (name: string) => hacknet.hashLevels[name] ?? 0,
      },
      "hacknet",
      host,
      process,
    );
  }

  // Singularity, when the host wired a faction system. Absent in harnesses
  // that drive ns without one, where every member reports itself as usual.
  if (host.singularity) {
    const singularity = {
      ...host.singularity.singularity,
      installBackdoor: () => host.singularity!.installBackdoorWithDelay(
        (ms) => netscriptDelay(host, process, ms, "singularity.installBackdoor"),
      ),
    };
    impl["singularity"] = namespace(singularity, "singularity", host, process);
    impl["grafting"] = namespace(host.singularity.grafting, "grafting", host, process);
    impl["getFavorToDonate"] = host.singularity.getFavorToDonate;
    // `ns.enums` is a PROPERTY, not a function — a 0 GB read, and the
    // planner's only way to enumerate factions it has not been invited to.
    impl["enums"] = host.singularity.enums;
  }

  return namespace(impl, "", host, process) as NS;
}

export { ProcessTable, ScriptDeath, launch };
