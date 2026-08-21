import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { SimWorld } from "../world.ts";
import { ProcessTable } from "../ns/process.ts";
import { makeSimNs, type SimNsHost } from "../ns/api.ts";
import { DarknetSystem } from "../features/dnet.ts";
import { mulberry32 } from "../core/rng.ts";
import { darkwebServerSpec } from "../network.ts";
import { harvestLogs } from "../../shared/strategy/dnet/oracle.ts";
import { lane } from "../../tests/support/lanes.ts";

/** The half of the darknet the controller actually runs on.
 *
 * What is asserted here is not "authenticate works" — it is the set of rules
 * that made the agent architecture take the shape it did. A session belongs to
 * one PID, `scp` and `exec` need different things, and the host underneath you
 * can be restarted mid-sentence. Every one of those is separately wrong-able,
 * and each wrong version would let a strategy pass in the simulator and fail in
 * the game, which is worse than not simulating it at all. */

const { describe: laneDescribe } = lane({ feature: "dnet" });

interface Harness {
  ns: NS;
  host: SimNsHost;
  world: SimWorld;
  dnet: DarknetSystem;
  start: (filename: string, on: string) => number;
}

function harness(bitnode = 15): Harness {
  const world = new SimWorld({
    seed: 1,
    bitnode,
    network: [
      { hostname: "n00dles", hackDifficulty: 1, moneyAvailable: 1, requiredHackingSkill: 1, serverGrowth: 1, numOpenPortsRequired: 1, maxRam: 4 },
      darkwebServerSpec(),
    ],
  });
  const processes = new ProcessTable(world.servers, world.clock);
  const files = new Map<string, Set<string>>([
    ["home", new Set(["main.js", "agent.js"])],
    ["darkweb", new Set(["agent.js"])],
  ]);
  const network = new Map<string, string[]>([
    ["home", ["n00dles", "darkweb"]],
    ["n00dles", ["home"]],
    ["darkweb", ["home"]],
  ]);
  const host = {
    world,
    clock: world.clock,
    processes,
    files,
    contents: new Map<string, string>(),
    scripts: new Map(),
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
    fullAccess: () => bitnode === 15,
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

  const start = (filename: string, on: string): number => {
    const process = processes.start({
      filename,
      host: on,
      args: [],
      threads: 1,
      ramPerThreadGb: 1,
      temporary: false,
    });
    return process?.pid ?? 0;
  };

  const process = processes.start({
    filename: "main.js",
    host: "home",
    args: [],
    threads: 1,
    ramPerThreadGb: 1,
    temporary: false,
  })!;
  return { ns: makeSimNs(host, process), host, world, dnet, start };
}

/** A host we can actually reach from where a test's process is standing. */
function neighbourOf(h: Harness, from: string): string {
  const names = (h.host.network.get(from) ?? []).filter((name) => h.dnet.hosts.has(name));
  return names[0]!;
}

laneDescribe("darknet sessions and the gates that shaped the agents", () => {
  describe("who may copy, and who may run", () => {
    test("scp TO a darknet host needs a session, and copies nothing without one", () => {
      const h = harness();
      const target = neighbourOf(h, "darkweb") ?? [...h.dnet.hosts.keys()][0]!;
      const before = new Set(h.host.files.get(target) ?? []);
      expect(h.ns.scp("main.js", target, "home")).toBe(false);
      // The refusal has to be total. A copy that half-happened would leave a
      // payload on a host we cannot exec on, and `exec` returning 0 for a
      // missing file is indistinguishable from a full host.
      expect(new Set(h.host.files.get(target) ?? [])).toEqual(before);
    });

    test("scp FROM a darknet host needs nothing at all", () => {
      // Upstream checks the DESTINATION and never the source. That asymmetry is
      // why getting data out of the darknet is nearly free and getting a running
      // process in is the whole problem.
      const h = harness();
      expect(h.ns.scp("agent.js", "home", "darkweb")).toBe(true);
    });

    test("a session lets scp through at any distance, and exec only next door", () => {
      const h = harness();
      const target = neighbourOf(h, "home") ?? "darkweb";
      void target;
      // Stand on darkweb, where no credential is needed, and open a neighbour.
      const pid = h.start("agent.js", "darkweb");
      const ns = makeSimNs(h.host, h.host.processes.get(pid)!);
      const neighbour = neighbourOf(h, "darkweb");
      const record = h.dnet.record(neighbour)!;

      h.dnet.addSession(neighbour, pid);
      expect(ns.scp("agent.js", neighbour, "darkweb")).toBe(true);
      expect(ns.exec("agent.js", neighbour, 1)).toBeGreaterThan(0);

      // Now break the adjacency but keep the session. `scp` still works — it has
      // no connection requirement — and `exec` stops. This is THE constraint the
      // whole overseer/breaker split exists to satisfy: a credential buys you
      // file transfer at any distance and a running process only next door.
      h.host.network.set("darkweb", ["home"]);
      expect(ns.scp("agent.js", neighbour, "darkweb")).toBe(true);
      expect(ns.exec("agent.js", neighbour, 1)).toBe(0);
      expect(record.sessions.has(pid)).toBe(true);
    });
  });

  describe("a session belongs to the PID that won it", () => {
    test("it dies with its process, and is not inherited by a recycled pid", () => {
      const h = harness();
      const neighbour = neighbourOf(h, "darkweb");
      const first = h.start("agent.js", "darkweb");
      h.dnet.addSession(neighbour, first);
      expect(h.dnet.isAuthenticated(neighbour, first)).toBe(true);

      // Kill everything: resetPidCounter below refuses while anything runs, and
      // the point of the test is the prestige path.
      h.host.processes.kill(first);
      // Upstream never actively clears the set; it prunes lazily with
      // findRunningScriptByPid. Reproduced — and checked on READ, which matters
      // because resetPidCounter() restarts pids at 1 on prestige and a stale
      // entry would hand a new process someone else's session.
      expect(h.dnet.isAuthenticated(neighbour, first)).toBe(false);

      for (const process of [...h.host.processes.values()]) h.host.processes.kill(process.pid);
      h.host.processes.resetPidCounter();
      const recycled = h.start("agent.js", "darkweb");
      expect(h.dnet.isAuthenticated(neighbour, recycled)).toBe(false);
    });

    test("a process is always authenticated to its own host, and to darkweb", () => {
      // Upstream: "We always are authed to ourselves and DarkWeb."
      const h = harness();
      const pid = h.start("agent.js", "darkweb");
      expect(h.dnet.isAuthenticated("darkweb", pid, "darkweb")).toBe(true);
      const neighbour = neighbourOf(h, "darkweb");
      expect(h.dnet.isAuthenticated(neighbour, pid, neighbour)).toBe(true);
      expect(h.dnet.isAuthenticated(neighbour, pid, "darkweb")).toBe(false);
    });
  });

  describe("passwords, and what a wrong one tells you", () => {
    test("the transcribed dictionaries really do open their models", () => {
      // If these did not match, a strategy would pass here and fail in the game
      // — which is the exact failure mode a simulator exists to prevent.
      const h = harness();
      for (const host of h.dnet.hosts.values()) {
        if (host.modelId === "ZeroLogon") expect(host.password).toBe("");
        if (host.modelId === "FreshInstall_1.0") {
          expect(["admin", "password", "0000", "12345"]).toContain(host.password);
        }
        if (host.modelId === "Laika4") expect(["fido", "spot", "rover", "max"]).toContain(host.password);
        // Length is DERIVED, never invented: a dictionary attack checks it.
        // The labyrinth is the exception, and upstream's too: it reports 0
        // because it is a maze rather than a password.
        if (host.modelId !== "(The Labyrinth)") {
          expect(host.passwordLength).toBe(host.password.length);
        }
      }
    });

    test("the shallow rows really are soft, because the model draw is tiered", () => {
      // Upstream does not draw uniformly. At difficulty <= 2 the pool is four
      // models, two of them four-entry dictionaries — which is why the beachhead
      // can bootstrap at all. A uniform draw would make the simulator report a
      // net far harder than the game's.
      const h = harness();
      const shallow = [...h.dnet.hosts.values()].filter((host) => host.difficulty <= 2);
      expect(shallow.length).toBeGreaterThan(0);
      for (const host of shallow) {
        expect(["ZeroLogon", "DeskMemo_3.1", "FreshInstall_1.0", "CloudBlare(tm)"]).toContain(host.modelId);
      }
    });

    test("the echo model puts its password in the hint, as upstream does", () => {
      const h = harness();
      for (const host of h.dnet.hosts.values()) {
        if (host.modelId !== "DeskMemo_3.1") continue;
        expect(host.passwordHint).toContain(host.password);
      }
    });

    test("a wrong password leaves the model's answer in the LOG, not the return value", () => {
      // This is the fact that decides where cracking code can live. authenticate
      // returns a generic failure; the model-specific response is written to the
      // target's ring and comes back only through heartbleed.
      const h = harness();
      const neighbour = neighbourOf(h, "darkweb");
      h.dnet.logAttempt(neighbour, "0000", 401, "Unauthorized", "2,1", 0);
      const lines = h.dnet.captureLogs(neighbour, 4, true, 0);
      const harvest = harvestLogs(lines, neighbour);
      expect(harvest.oracles[0]).toMatchObject({ code: 401, passwordAttempted: "0000", data: "2,1" });
    });

    test("sharedChars is the timing oracle's input, and counts LEADING matches only", () => {
      // Each correct leading character adds 50ms to authentication, so slower
      // means closer. A count of matching characters anywhere would make the
      // curve unclimbable and the model look impossible.
      const h = harness();
      const [name, host] = [...h.dnet.hosts.entries()].find(([, entry]) => entry.password.length >= 3)!;
      const password = host.password;
      expect(h.dnet.sharedChars(name, password)).toBe(password.length);
      expect(h.dnet.sharedChars(name, `${password.slice(0, 2)}zzz`)).toBe(2);
      expect(h.dnet.sharedChars(name, `z${password.slice(1)}`)).toBe(0);
    });
  });

  describe("the logs leak, which is what makes the net crawlable", () => {
    test("noise is back-filled from elapsed VIRTUAL time, with no timer", () => {
      // populateServerLogsWithNoise is lazy upstream: it seeds two lines on first
      // touch and then adds one per interval that has passed. Under the virtual
      // clock that transcribes exactly — the model is a function of "how long
      // since anyone looked", which is why it needs no timer at all.
      const h = harness();
      const neighbour = neighbourOf(h, "darkweb");
      const record = h.dnet.record(neighbour)!;
      h.dnet.populateLogs(neighbour, 0);
      expect(record.logs).toHaveLength(2);

      const intervalMs = record.logTrafficInterval * 1000;
      h.dnet.populateLogs(neighbour, intervalMs * 5);
      expect(record.logs.length).toBe(7);
    });

    test("peek leaves the lines, consuming takes exactly what was asked for", () => {
      const h = harness();
      const neighbour = neighbourOf(h, "darkweb");
      h.dnet.populateLogs(neighbour, 0);
      const record = h.dnet.record(neighbour)!;
      const before = record.logs.length;
      expect(h.dnet.captureLogs(neighbour, 2, true, 0)).toHaveLength(2);
      expect(record.logs.length).toBe(before);
      h.dnet.captureLogs(neighbour, 1, false, 0);
      expect(record.logs.length).toBe(before - 1);
    });

    test("over enough time the noise really does hand over a password", () => {
      // The BitNode promises "weak passwords and leaky logs". This is the leak,
      // and it is a credential source owing nothing to any of the 24 minigames —
      // which is what lets a crawler spread without solving a single puzzle.
      const h = harness();
      const neighbour = neighbourOf(h, "darkweb");
      const record = h.dnet.record(neighbour)!;
      const interval = record.logTrafficInterval * 1000;
      let found = 0;
      for (let i = 1; i <= 400 && found === 0; i++) {
        h.dnet.populateLogs(neighbour, interval * i);
        const harvest = harvestLogs(h.dnet.captureLogs(neighbour, 200, true, interval * i), neighbour);
        found = harvest.credentials.length + harvest.loose.length;
      }
      expect(found).toBeGreaterThan(0);
    });

    test("log volume never touches the shared gameplay stream", () => {
      // Noise draws vary in number with how long a script waited before
      // bleeding. Taking them from the gameplay stream would let a chatty host
      // move stock prices, which would quietly invalidate every A/B.
      let shared = 0;
      const world = new SimWorld({ seed: 1, bitnode: 15, network: [darkwebServerSpec()] });
      const processes = new ProcessTable(world.servers, world.clock);
      const network = new Map<string, string[]>([["home", ["darkweb"]], ["darkweb", ["home"]]]);
      const dnet = new DarknetSystem({
        servers: world.servers,
        network,
        processes,
        generate: mulberry32(5),
        random: () => {
          shared++;
          return 0.5;
        },
        logNoise: mulberry32(7),
        bitNode: 15,
        fullAccess: () => true,
        hasProgram: () => false,
        installedAugmentations: () => new Set<string>(),
        allowRedPill: () => true,
        world,
        player: world.player,
        homeFiles: () => new Set<string>(),
        darknetMoneyMultiplier: () => 1,
      });
      dnet.populate();
      const target = [...dnet.hosts.keys()][0]!;
      const drawsBefore = shared;
      for (let i = 1; i <= 50; i++) dnet.populateLogs(target, i * 60_000);
      expect(shared).toBe(drawsBefore);
    });
  });

  describe("the net moves under you", () => {
    test("a restart kills scripts and sessions, and keeps files and admin rights", () => {
      // All four halves are separately wrong-able, and each wrong version looks
      // like a different bug: a restart that kept sessions would make agents
      // immortal, one that dropped files would make every plant look like a
      // missing payload.
      const h = harness();
      // Rather than reach into private state, drive the real tick with a rigged
      // stream: the first draw picks the branch (0.2 is [0.1, 0.3) — restart)
      // and the second picks the victim.
      let call = 0;
      const restarts = new DarknetSystem({
        servers: h.world.servers,
        network: h.host.network,
        processes: h.host.processes,
        generate: mulberry32(5),
        random: () => (call++ % 2 === 0 ? 0.2 : 0),
        logNoise: mulberry32(7),
        bitNode: 15,
        fullAccess: () => true,
        hasProgram: () => false,
        installedAugmentations: () => new Set<string>(),
        allowRedPill: () => true,
        world: h.world,
        player: h.world.player,
        homeFiles: () => h.host.files.get("home")!,
        darknetMoneyMultiplier: () => 1,
      });
      restarts.populate();
      const first = [...restarts.hosts.values()].filter((host) => host.online && !host.isStationary).sort((a, b) => (a.hostname < b.hostname ? -1 : 1))[0]!;
      const runner = h.start("agent.js", first.hostname);
      first.sessions.add(runner);
      h.host.files.set(first.hostname, new Set(["agent.js"]));
      const firstServer = h.world.servers.get(first.hostname)!;
      firstServer.hasAdminRights = true;
      firstServer.backdoorInstalled = true;

      restarts.darknetProcess(10_000);

      expect(h.host.processes.get(runner)).toBeUndefined();
      expect(first.sessions.size).toBe(0);
      // Files and admin rights survive a restart; only the backdoor does not.
      expect(h.host.files.get(first.hostname)?.has("agent.js")).toBe(true);
      expect(firstServer.hasAdminRights).toBe(true);
      expect(firstServer.backdoorInstalled).toBe(false);
    });

    test("nextMutation resolves once per tick, and wakes every waiter", () => {
      // A bare promise, not a per-process timer: upstream resolves it before the
      // throttle roll, so an agent parked on it wakes on the net's CLOCK rather
      // than on the net's activity — and two waiters both wake.
      const h = harness();
      let a = false;
      let b = false;
      void h.dnet.nextMutation().then(() => { a = true; });
      void h.dnet.nextMutation().then(() => { b = true; });
      h.dnet.darknetProcess(10_000);
      return Promise.resolve().then(() => {
        expect(a).toBe(true);
        expect(b).toBe(true);
      });
    });

    test("a delete takes the host's files with it", () => {
      // The old tick left them behind, which an agent that scps itself onto a
      // host would expose immediately: its payload would still read as present
      // on a server that no longer exists.
      const h = harness();
      let call = 0;
      const deletes = new DarknetSystem({
        servers: h.world.servers,
        network: h.host.network,
        processes: h.host.processes,
        generate: mulberry32(5),
        random: () => (call++ % 2 === 0 ? 0.01 : 0),
        logNoise: mulberry32(7),
        bitNode: 15,
        fullAccess: () => true,
        hasProgram: () => false,
        installedAugmentations: () => new Set<string>(),
        allowRedPill: () => true,
        world: h.world,
        player: h.world.player,
        homeFiles: () => h.host.files.get("home")!,
        darknetMoneyMultiplier: () => 1,
        forgetFiles: (hostname: string) => {
          h.host.files.delete(hostname);
        },
      });
      deletes.populate();
      const victim = [...deletes.hosts.values()].filter((host) => host.online && !host.isStationary).sort((a, b) => (a.hostname < b.hostname ? -1 : 1))[0]!;
      h.host.files.set(victim.hostname, new Set(["agent.js"]));

      deletes.darknetProcess(10_000);

      expect(victim.online).toBe(false);
      expect(h.host.files.has(victim.hostname)).toBe(false);
      expect(victim.sessions.size).toBe(0);
    });
  });

  describe("the gaps did not silently shrink", () => {
    test("the actions nobody calls still report themselves rather than answering", () => {
      // An ns member this does not model must be ABSENT, so the root proxy
      // reports it and throws. A stub that returned a plausible value would let
      // a strategy be measured against behaviour that does not exist.
      const h = harness();
      const dnet = (h.ns as unknown as { dnet: Record<string, unknown> }).dnet;
      for (const name of [
        "setStasisLink",
        "memoryReallocation",
        "phishingAttack",
        "induceServerMigration",
        "promoteStock",
        "unleashStormSeed",
      ]) {
        expect(() => (dnet[name] as () => unknown)(), `ns.dnet.${name} must stay unmodelled`).toThrow();
      }
    });

    test("stasis links report empty because they ARE empty, not because they are stubbed", () => {
      // The difference matters: while setStasisLink is unmodelled, nothing can
      // create a link, so [] is literally true rather than a fabrication.
      const h = harness();
      expect(h.ns.dnet.getStasisLinkedServers()).toEqual([]);
      expect(h.ns.dnet.getDarknetInstability()).toEqual({
        authenticationDurationMultiplier: 1,
        authenticationTimeoutChance: 0,
      });
    });
  });
});
