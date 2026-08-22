import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { SimWorld } from "../world.ts";
import { ProcessTable, ScriptDeath, type SimProcess } from "../ns/process.ts";
import { makeSimNs, type SimNsHost } from "../ns/api.ts";
import { DarknetSystem } from "../features/dnet.ts";
import { mulberry32 } from "../core/rng.ts";
import { darkwebServerSpec } from "../network.ts";

/** The teardown window the darknet agents' survival depends on.
 *
 * The engine (stopAndCleanUpWorkerScript) releases the concurrency lock and
 * runs atExit callbacks synchronously in the killer's stack BEFORE the script
 * is marked stopped — so inside atExit every ns function is callable, and
 * `ns.spawn(..., {spawnDelay: 0})` re-enters the kill, frees the dying
 * process's RAM, and launches the replacement into the vacated allocation.
 * The killed script's own await rejects with ScriptDeath only afterwards, on a
 * microtask, and any ns call in that zombie continuation throws.
 *
 * game/dnet/agent.ts's atExit-respawn hook depends on every clause, and each
 * was separately wrong in the simulator before this suite existed: `killed`
 * was set before the handlers ran (no ns call worked at all), and RAM was
 * freed after them with re-entrant kill a no-op (spawn could never fit). A
 * wrong version here would let the survival design pass in the simulator and
 * die in the game — the exact failure a simulator exists to prevent. */

interface Harness {
  host: SimNsHost;
  world: SimWorld;
  dnet: DarknetSystem;
  processes: ProcessTable;
  start: (filename: string, on: string, ramGb: number, parentPid?: number) => SimProcess;
}

function harness(): Harness {
  const bitnode = 15;
  const world = new SimWorld({
    seed: 1,
    bitnode,
    network: [darkwebServerSpec()],
  });
  const processes = new ProcessTable(world.servers, world.clock);
  const files = new Map<string, Set<string>>([
    ["home", new Set(["agent.js"])],
    ["darkweb", new Set(["agent.js"])],
  ]);
  const network = new Map<string, string[]>([
    ["home", ["darkweb"]],
    ["darkweb", ["home"]],
  ]);
  const host = {
    world,
    clock: world.clock,
    processes,
    files,
    contents: new Map<string, string>(),
    // A replacement launched by spawn must find a main() or launch() finishes
    // it instantly; one that never returns keeps the process observable.
    scripts: new Map<string, (ns: NS) => Promise<void>>([
      ["agent.js", () => new Promise<void>(() => {})],
    ]),
    network,
    ramCtx: { bitNode: bitnode },
    output: [],
    crashes: [],
  } as unknown as SimNsHost;

  const dnet = new DarknetSystem({
    servers: world.servers,
    network,
    processes,
    generate: mulberry32(5),
    random: mulberry32(6),
    logNoise: mulberry32(7),
    bitNode: bitnode,
    fullAccess: () => true,
    hasProgram: () => false,
    installedAugmentations: () => new Set(world.player.augmentations.keys()),
    allowRedPill: () => true,
    world,
    player: world.player,
    homeFiles: () => files.get("home")!,
    darknetMoneyMultiplier: () => 1,
    forgetFiles: (hostname: string) => {
      files.delete(hostname);
    },
  });
  host.dnet = dnet;
  dnet.populate();

  const start = (filename: string, on: string, ramGb: number, parentPid?: number): SimProcess =>
    processes.start({
      filename,
      host: on,
      args: [],
      threads: 1,
      ramPerThreadGb: ramGb,
      temporary: false,
      ...(parentPid !== undefined ? { parentPid } : {}),
    })!;

  return { host, world, dnet, processes, start };
}

/** A darknet host reachable from darkweb, with its password. */
function neighbourOf(h: Harness): { target: string; password: string } {
  const names = (h.host.network.get("darkweb") ?? []).filter((name) => h.dnet.hosts.has(name));
  const target = names[0]!;
  return { target, password: h.dnet.record(target)!.password };
}

/** Let the async prologue of an ns call reach its netscriptDelay. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("kill during a blocking ns call, and the atExit window", () => {
  test("atExit runs with ns callable, spawn(0) relaunches into the freed RAM, and the effect never lands", async () => {
    const h = harness();
    const { target, password } = neighbourOf(h);
    const agent = h.start("agent.js", "darkweb", 10);
    const ns = makeSimNs(h.host, agent);
    const events: string[] = [];

    ns.atExit(() => {
      // Before the fix, `killed` was already true here and this threw
      // ScriptDeath — the push after it is the pin that ns works in atExit.
      const free = ns.getServerMaxRam("darkweb") - ns.getServerUsedRam("darkweb");
      events.push(`atExit free=${free}`);
      // 10 GB on a 16 GB host: the replacement fits only if the dying
      // process's allocation was freed by spawn's re-entrant kill.
      ns.spawn("agent.js", { threads: 1, spawnDelay: 0, ramOverride: 10 });
      events.push("unreachable: spawn returned");
    }, "respawn");

    const attempt = ns["dnet"]["authenticate"](target, password).then(
      () => events.push("landed"),
      (error: unknown) => {
        events.push(`rejected:${(error as Error).name}`);
        // The zombie continuation still runs — but ns is dead to it.
        try {
          ns.getServerUsedRam("darkweb");
          events.push("zombie ns call worked");
        } catch (zombie) {
          events.push(`zombie:${(zombie as Error).name}`);
        }
      },
    );
    await settle();
    expect(agent.runningFn).toBeDefined();

    h.processes.kill(agent.pid);

    // atExit already ran, synchronously in the killer's stack; the rejection
    // is a queued microtask and has not been delivered yet.
    expect(events).toEqual(["atExit free=6"]);
    const replacement = h.processes.ps("darkweb").find((p) => p.filename === "agent.js");
    expect(replacement).toBeDefined();
    expect(replacement!.pid).not.toBe(agent.pid);

    await attempt;
    expect(events).toEqual(["atExit free=6", "rejected:ScriptDeath", "zombie:ScriptDeath"]);
    // The kill cancelled the delay before authenticate's completion ran: no
    // session for the dead pid, and none conjured for the replacement.
    expect(h.dnet.isAuthenticated(target, agent.pid)).toBe(false);
    expect(h.dnet.isAuthenticated(target, replacement!.pid)).toBe(false);
    expect(h.host.crashes).toEqual([]);
  });

  test("re-entrant teardown is idempotent: RAM freed once, earnings transferred once, on a host with zero slack", () => {
    const h = harness();
    const darkweb = h.world.servers.get("darkweb")!;
    const parent = h.start("agent.js", "home", 1);
    const child = h.start("agent.js", "darkweb", darkweb.maxRam, parent.pid);
    child.onlineMoneyMade = 123;
    child.onlineExpGained = 7;
    const ns = makeSimNs(h.host, child);

    ns.atExit(() => {
      ns.spawn("agent.js", { threads: 1, spawnDelay: 0, ramOverride: darkweb.maxRam });
    }, "respawn");
    h.processes.kill(child.pid);

    // The replacement occupies the full host: it can only have fit if the
    // child's allocation was released before the launch, and exactly once.
    expect(darkweb.ramUsed).toBe(darkweb.maxRam);
    expect(h.processes.get(child.pid)).toBeUndefined();
    expect(h.processes.ps("darkweb")).toHaveLength(1);
    expect(parent.onlineMoneyMade).toBe(123);
    expect(parent.onlineExpGained).toBe(7);
    expect(h.host.crashes).toEqual([]);
  });

  test("a normal return runs atExit with ns callable too", () => {
    const h = harness();
    const proc = h.start("agent.js", "darkweb", 4);
    const ns = makeSimNs(h.host, proc);
    const events: string[] = [];

    ns.atExit(() => {
      events.push(`finish free=${ns.getServerMaxRam("darkweb") - ns.getServerUsedRam("darkweb")}`);
    }, "report");
    h.processes.finish(proc.pid);

    // RAM is released AFTER the handlers, as in the engine: the handler still
    // saw its own 4 GB held, and the table is clean afterwards.
    expect(events).toEqual(["finish free=12"]);
    expect(h.processes.get(proc.pid)).toBeUndefined();
    expect(h.world.servers.get("darkweb")!.ramUsed).toBe(0);
    expect(h.host.crashes).toEqual([]);
  });
});
