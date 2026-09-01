import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { SimWorld } from "../world.ts";
import { ProcessTable } from "../ns/process.ts";
import { makeSimNs, type SimNsHost } from "../ns/api.ts";
import { DarknetSystem, MUTATION_DRAWS, STORM_PHASE_CYCLES } from "../features/dnet.ts";
import { mulberry32 } from "../core/rng.ts";
import { darkwebServerSpec } from "../network.ts";
import { harvestLogs } from "../../shared/strategy/dnet/oracle.ts";
import { darknetGate } from "../ns/dnet.ts";
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
  test("ungated stasis readings answer without darknet access", () => {
    const h = harness(1);
    expect(h.ns.dnet.getStasisLinkedServers()).toEqual([]);
  });

  test("heartbleed grants charisma XP after its full delay", async () => {
    const h = harness();
    const before = h.world.person.exp.charisma;
    const pending = h.ns.dnet.heartbleed("darkweb", { peek: true });
    let finished = false;
    void pending.then(() => { finished = true; });
    expect(await h.world.clock.runAsync(() => finished)).toBe("goal");
    expect((await pending).success).toBe(true);
    expect(h.world.person.exp.charisma - before).toBeCloseTo(50.1, 8);
  });

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
      // whole controller/breaker split exists to satisfy: a credential buys you
      // file transfer at any distance and a running process only next door.
      h.host.network.set("darkweb", ["home"]);
      expect(ns.scp("agent.js", neighbour, "darkweb")).toBe(true);
      expect(ns.exec("agent.js", neighbour, 1)).toBe(0);
      expect(record.sessions.has(pid)).toBe(true);
    });
  });

  describe("recovering a resident after adjacency changes", () => {
    test("connectToSession reopens a rooted host at distance, and a backdoor makes remote exec possible", async () => {
      const h = harness();
      const target = neighbourOf(h, "darkweb");
      const record = h.dnet.record(target)!;
      const openerPid = h.start("agent.js", "darkweb");
      const opener = makeSimNs(h.host, h.host.processes.get(openerPid)!);
      const opening = opener["dnet"]["authenticate"](target, record.password);
      let opened = false;
      void opening.then(() => { opened = true; });
      expect(await h.world.clock.runAsync(() => opened)).toBe("goal");
      expect((await opening).success).toBe(true);

      // Lose adjacency and the original PID's session. Root and the password are
      // global host state, so a new process can cheaply recover its own session.
      h.host.processes.kill(openerPid);
      h.host.network.set("darkweb", ["home"]);
      const recoveryPid = h.start("agent.js", "darkweb");
      const recovery = makeSimNs(h.host, h.host.processes.get(recoveryPid)!);
      expect(recovery["dnet"]["connectToSession"](target, record.password).success).toBe(true);
      expect(recovery.scp("agent.js", target, "darkweb")).toBe(true);
      expect(recovery.exec("agent.js", target, 1)).toBe(0);

      h.world.servers.get(target)!.backdoorInstalled = true;
      expect(recovery.exec("agent.js", target, 1)).toBeGreaterThan(0);

      const unrooted = [...h.dnet.hosts.entries()]
        .find(([hostname, host]) => hostname !== target && host.online && !h.world.servers.get(hostname)!.hasAdminRights)!;
      expect(recovery["dnet"]["connectToSession"](unrooted[0], unrooted[1].password).success).toBe(false);
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

    test("the action gate trusts self, but hasSession only reports stored sessions and darkweb", () => {
      const h = harness();
      const pid = h.start("agent.js", "darkweb");
      expect(h.dnet.isAuthenticated("darkweb", pid, "darkweb")).toBe(true);
      const neighbour = neighbourOf(h, "darkweb");
      expect(h.dnet.isAuthenticated(neighbour, pid, neighbour)).toBe(false);
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
      h.dnet.logAttempt(neighbour, "0000", 401, { ok: false, message: "Unauthorized", data: "2,1" }, 0);
      const lines = h.dnet.captureLogs(neighbour, 4, true, 0);
      const harvest = harvestLogs(lines, { bledFrom: neighbour });
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
        const harvest = harvestLogs(h.dnet.captureLogs(neighbour, 200, true, interval * i), { bledFrom: neighbour });
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
      // stream.
      //
      // The rigging has to name the SLOT, not the call order. `#mutate` takes
      // one fixed-width block of MUTATION_DRAWS draws up front and then indexes
      // into it, precisely so that what a tick does cannot change how much of
      // the shared stream it consumes — so "the first draw picks the branch" has
      // not been true since that block landed, and an alternating stream simply
      // lands on whichever branch its parity happens to select. (It selected the
      // ADD branch, which returns before the restart is ever reached, and the
      // test went quietly green on an assertion it was no longer exercising.)
      //
      // So: 0.9 in every slot that guards a branch we do not want, 0 in the two
      // that select the restart and its victim.
      const rigged = new Array<number>(MUTATION_DRAWS).fill(0.9);
      rigged[0] = 0;    // under the depth throttle, so the tick runs at all
      rigged[14] = 0;   // < 0.2: restart
      rigged[15] = 0;   // the victim: the first movable host, alphabetically
      let call = 0;
      const restarts = new DarknetSystem({
        servers: h.world.servers,
        network: h.host.network,
        processes: h.host.processes,
        generate: mulberry32(5),
        random: () => rigged[call++ % MUTATION_DRAWS]!,
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
      h.host.files.set(first.hostname, new Set(["agent.js"]));
      h.host.scripts.set("agent.js", () => new Promise<void>(() => {}));
      const firstServer = h.world.servers.get(first.hostname)!;
      firstServer.hasAdminRights = true;
      firstServer.backdoorInstalled = true;
      first.blockedRam = 0;
      firstServer.ramUsed = 0;
      const runner = h.start("agent.js", first.hostname);
      expect(runner).toBeGreaterThan(0);
      first.sessions.add(runner);
      const oldNeighbours = [...(h.host.network.get(first.hostname) ?? [])];
      const exitView: { session?: boolean; backdoor?: boolean; neighbours?: string[] } = {};
      const runnerNs = makeSimNs(h.host, h.host.processes.get(runner)!);
      runnerNs.atExit(() => {
        exitView.session = first.sessions.has(runner);
        exitView.backdoor = firstServer.backdoorInstalled;
        exitView.neighbours = [...(h.host.network.get(first.hostname) ?? [])];
        runnerNs.spawn(
          "agent.js",
          { threads: 1, ramOverride: 1, spawnDelay: 1 },
          "restart-recovery",
        );
      });
      const cache = restarts.addCache(first.hostname, false)!;
      // Cache filename generation legitimately consumed the gameplay stream;
      // restart the deliberately indexed mutation block at its boundary.
      call = 0;

      restarts.darknetProcess(10_000);

      // restartServer kills scripts before clearing sessions, the backdoor or
      // old edges. The delayed spawn cannot fire until the whole restart stack
      // has returned and the replacement edge has been installed.
      expect(exitView).toEqual({ session: true, backdoor: true, neighbours: oldNeighbours });
      expect(h.host.processes.get(runner)).toBeUndefined();
      expect(h.host.processes.ps(first.hostname)).toEqual([]);
      expect(first.sessions.size).toBe(0);
      // Files and admin rights survive a restart; only the backdoor does not.
      expect(h.host.files.get(first.hostname)?.has("agent.js")).toBe(true);
      expect(firstServer.hasAdminRights).toBe(true);
      expect(firstServer.backdoorInstalled).toBe(false);
      expect(first.blockedRam).toBe(0);
      expect(restarts.cachesOn(first.hostname)).toContain(cache);

      h.world.clock.run(() => false, h.world.clock.now() + 1);
      expect(h.host.processes.ps(first.hostname).map((process) => process.args))
        .toEqual([["restart-recovery"]]);
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

  describe("a stasis link is durability, and it is scarce", () => {
    // Modelling this is what turns `getStasisLinkedServers()` from a constant
    // into a reading. Until now it returned `[]` — true, because nothing could
    // ever link anything — so no strategy that spends a link could be exercised
    // at all.
    test("it pins the CALLING host, and the limit is global", () => {
      const h = harness();
      const movable = [...h.dnet.hosts.values()]
        .filter((host) => host.online && !host.isStationary)
        .sort((a, b) => (a.hostname < b.hostname ? -1 : 1));
      const [first, second] = movable;
      expect(first).toBeDefined();
      expect(second).toBeDefined();

      expect(h.dnet.stasisLinkedServers()).toEqual([]);

      // 200: pinned. Note the argument is the CALLER's host — the real member
      // takes no hostname at all, which is why spending a link needs a process
      // standing on the host being pinned.
      expect(h.dnet.setStasisLink(first!.hostname, true)).toBe(200);
      expect(h.dnet.stasisLinkedServers()).toEqual([first!.hostname]);
      expect(h.world.servers.get(first!.hostname)!.backdoorInstalled).toBe(true);

      // The limit is one until the labyrinth starts paying out, and it is
      // GLOBAL — which is the whole reason candidates have to be ranked.
      expect(h.dnet.stasisLinkLimit()).toBe(1);
      expect(h.dnet.setStasisLink(second!.hostname, true)).toBe(453);
      expect(h.dnet.stasisLinkedServers()).toEqual([first!.hostname]);

      // Releasing frees the slot rather than the host: re-pinning the same host
      // is idempotent, so a job that runs twice does not spend two.
      expect(h.dnet.setStasisLink(first!.hostname, true)).toBe(200);
      expect(h.dnet.setStasisLink(first!.hostname, false)).toBe(200);
      expect(h.dnet.stasisLinkedServers()).toEqual([]);
      expect(h.dnet.setStasisLink(second!.hostname, true)).toBe(200);
    });

    test("a pinned host is outside every mutation branch's victim pool", () => {
      // What the link actually BUYS. It is not remote exec — upstream's own doc
      // line is stale: `setStasisLink` also sets `backdoorInstalled`. This
      // test isolates the other benefit, that the mutation clock cannot touch
      // the pinned host.
      const h = harness();
      const rigged = new Array<number>(MUTATION_DRAWS).fill(0.9);
      rigged[0] = 0;    // under the depth throttle, so the tick runs
      // The ORDINARY restart branch. It sits at 18 rather than at 14 because the
      // two BACKDOOR branches — a 10% restart and a 5% delete, both drawing from
      // `getBackdooredDarknetServers` — come first in `mutateDarknet` and now
      // occupy 14-17. Both are no-ops here: nothing is backdoored, and the one
      // host that is pinned is filtered out of that pool by `!hasStasisLink`.
      rigged[18] = 0;   // < 0.2: restart
      rigged[19] = 0;   // the victim: the first movable host, alphabetically
      let call = 0;
      const pinned = new DarknetSystem({
        servers: h.world.servers,
        network: h.host.network,
        processes: h.host.processes,
        generate: mulberry32(5),
        random: () => rigged[call++ % MUTATION_DRAWS]!,
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
      pinned.populate();
      const victim = [...pinned.hosts.values()]
        .filter((host) => host.online && !host.isStationary)
        .sort((a, b) => (a.hostname < b.hostname ? -1 : 1))[0]!;

      // A session marker on every movable host, so the tick's effect is visible
      // without needing a real process — a restart clears `sessions`, and these
      // hosts do not all have the free RAM to hold one.
      const movable = [...pinned.hosts.values()].filter((host) => host.online && !host.isStationary);
      for (const host of movable) host.sessions.add(1);

      // Pin the host the rigged stream would otherwise have picked.
      expect(pinned.setStasisLink(victim.hostname, true)).toBe(200);
      pinned.darknetProcess(10_000);

      // The pinned host is untouched...
      expect(victim.sessions.has(1)).toBe(true);
      // ...and the branch really did fire, on somebody else. Without this the
      // assertion above would pass just as well for a tick that did nothing.
      const restarted = movable.filter((host) => !host.sessions.has(1));
      expect(restarted).toHaveLength(1);
      expect(restarted[0]!.hostname).not.toBe(victim.hostname);
    });

    test("an install takes every link with it", () => {
      const h = harness();
      const host = [...h.dnet.hosts.values()].find((entry) => entry.online && !entry.isStationary)!;
      expect(h.dnet.setStasisLink(host.hostname, true)).toBe(200);
      h.dnet.prestige(0);
      expect(h.dnet.stasisLinkedServers()).toEqual([]);
    });
  });

  describe("the two farm calls, which are what the net PAYS with", () => {
    // Driven through the SYSTEM rather than through ns, deliberately. Both ns
    // members are `netscriptDelay`-shaped, and this harness has no pump for the
    // virtual clock — awaiting one here would hang for ever rather than fail.
    // What the system layer owns is every fact worth pinning: the check order,
    // the two separate writes, the cache on clear, and the net-wide cooldown.
    // The ns wrapper contributes the wait and the charisma-xp call, and
    // `tests/ram-budget.test.ts` pins that its RAM was declared.

    test("memoryReallocation frees the block on the CALLING host with no credential", () => {
      // The single most useful fact in the feature. The call declares
      // `requireAdminRights`, but `checkDarknetServer` evaluates the direct-
      // connection requirement first and then early-outs on self BEFORE the
      // admin-rights check is reached — so a resident grinds its own owner's
      // block open for free. If this stops being true, the farm ladder's second
      // rung becomes unreachable on every host we have not cracked.
      const h = harness();
      const target = neighbourOf(h, "darkweb");
      const record = h.dnet.record(target)!;
      record.blockedRam = 8;
      const server = h.world.servers.get(target)!;
      server.ramUsed = 8;
      server.hasAdminRights = false;

      const freed = h.dnet.reallocateRam(target, 1, 200)!;
      expect(freed.freed).toBeGreaterThan(0);
      expect(record.blockedRam).toBe(8 - freed.freed);
      // The two writes are SEPARATE upstream and both have to land: blocked RAM
      // presents AS used RAM, so a model that moved one without the other would
      // make reported availability disagree with what `exec` accepts.
      expect(server.ramUsed).toBeCloseTo(record.blockedRam, 6);
      // Every call pays charisma, scaled by the difficulty that makes it slow.
      expect(freed.charismaExp).toBeGreaterThan(0);
    });

    test("clearing a block to zero drops a .cache, with no roll at all", () => {
      const h = harness();
      const target = neighbourOf(h, "darkweb");
      const record = h.dnet.record(target)!;
      // Small enough that one call clamps to the remainder and clears it.
      record.blockedRam = 0.01;
      const before = h.dnet.cachesOn(target).length;
      const freed = h.dnet.reallocateRam(target, 1, 200)!;
      expect(freed.cleared).toBe(true);
      expect(record.blockedRam).toBe(0);
      expect(h.dnet.cachesOn(target).length).toBe(before + 1);
    });

    test("a neighbour's block still needs the credential the self case does not", () => {
      // The other half of the same check order, read through the gate `exec` and
      // `scp` share: the early-out is on SELF, so a directly-connected host we
      // have never rooted refuses with 401 while our own host never asks.
      const h = harness();
      const pid = h.start("agent.js", "darkweb");
      const process = h.host.processes.get(pid)!;
      const neighbour = neighbourOf(h, "darkweb");
      h.world.servers.get(neighbour)!.hasAdminRights = false;
      expect(darknetGate(h.dnet, h.world.servers, process, neighbour, {}).code).toBe(401);
      expect(darknetGate(h.dnet, h.world.servers, process, "darkweb", {}).code).toBe(200);
    });

    test("phishingAttack pays charisma on EVERY call, including the failures", () => {
      // A quarter rate on the failure path, which is what makes phishing the
      // reliable charisma source rather than the lottery it looks like.
      const h = harness();
      const target = neighbourOf(h, "darkweb");
      const now = h.world.clock.now();
      let failures = 0;
      for (let i = 0; i < 40; i++) {
        const outcome = h.dnet.phish(target, 1, 50, now);
        expect(outcome.charismaExp).toBeGreaterThan(0);
        expect(outcome.code === 200 || outcome.code === 455).toBe(true);
        if (!outcome.success) failures++;
      }
      // At charisma 50 the money chance is ~6%, so most calls fail and still pay.
      expect(failures).toBeGreaterThan(0);
    });

    test("the phishing cache cooldown is NET-WIDE, not per host", () => {
      // `lastPhishingCacheTime` lives on DarknetState, so the whole net yields at
      // most twenty caches an hour however many hosts are phishing. That fact is
      // exactly what the farm ladder's probability reserve exists to exploit:
      // full-thread calls are accumulated only until the target chance is met.
      const h = harness();
      // NOT the labyrinth: `handlePhishingAttack` excludes a lab server from the
      // cache branch outright, which is also why the reserve never includes one.
      // `populate` places the lab first, so an unfiltered list starts with
      // exactly the host that can never claim a window.
      const hosts = [...h.dnet.hosts.values()]
        .filter((host) => host.hostname !== "darkweb" && !host.isStationary)
        .map((host) => host.hostname)
        .slice(0, 2);
      expect(hosts.length).toBe(2);
      const now = h.world.clock.now() + 3 * 60 * 1000 + 1;
      expect(h.dnet.phishCooldownReached(h.world.clock.now())).toBe(false);
      expect(h.dnet.phishCooldownReached(now)).toBe(true);
      let claimed = false;
      for (let i = 0; i < 4000 && !claimed; i++) {
        claimed = h.dnet.phish(hosts[0]!, 1, 1000, now).message.includes("Found a cache file");
      }
      expect(claimed).toBe(true);
      // ...and the OTHER host's window is shut by it.
      expect(h.dnet.phishCooldownReached(now)).toBe(false);
      expect(h.dnet.phish(hosts[1]!, 1, 1000, now).message).not.toContain("Found a cache file");
      expect(h.dnet.phishCooldownReached(now + 3 * 60 * 1000 + 1)).toBe(true);
    });

    test("phishing refuses to run anywhere but a darknet host, before its wait", () => {
      // `expectRunningOnDarknetServer` is evaluated BEFORE the netscriptDelay, so
      // a script on an ordinary server throws rather than waiting ten seconds to
      // be told no. Reached synchronously, which is the point.
      const h = harness();
      expect(() => (h.ns.dnet as unknown as { phishingAttack: () => unknown }).phishingAttack()).toThrow();
    });
  });

  describe("the gaps did not silently shrink", () => {
    test("the complete dnet surface has no fabricated catch-all members", () => {
      // An ns member this does not model must be ABSENT, so the root proxy
      // reports it and throws. A stub that returned a plausible value would let
      // a strategy be measured against behaviour that does not exist.
      const h = harness();
      const dnet = (h.ns as unknown as { dnet: Record<string, unknown> }).dnet;
      expect(() => (dnet.notARealMember as () => unknown)()).toThrow();
    });

    test("a stasis link is now a reading rather than a constant", () => {
      // Since `setStasisLink` is modeled, assert that the reading changes rather
      // than treating an always-empty value as evidence.
      const h = harness();
      expect(h.ns.dnet.getStasisLinkedServers()).toEqual([]);

      const host = [...h.dnet.hosts.values()].find((entry) => entry.online && !entry.isStationary)!;
      expect(h.dnet.setStasisLink(host.hostname, true)).toBe(200);
      expect(h.ns.dnet.getStasisLinkedServers()).toEqual([host.hostname]);
      expect(h.ns.dnet.getStasisLinkedServers(true)).toEqual([h.world.servers.get(host.hostname)!.ip]);
    });

    test("the restart wave lands on the FIRST gap, not the second", () => {
      // Upstream's launchWebstorm sleeps 5 s on its warning toast and then, in
      // ONE synchronous block, deletes, moves and restartAllDarknetServers()
      // (src/DarkNet/effects/webstorm.ts:41-46). Splitting that block across
      // two phases put the restart at 9 s and slid every later action one gap
      // out, so the rebalance ran at 30 s instead of 25 s. Nothing caught it:
      // the existing burst test runs all six gaps out and only checks the end
      // state, which is identical either way. This pins the SCHEDULE.
      //
      // shared/strategy/dnet/rates.ts's STORM_RESTART_BY_MS = 15_000 and
      // spec/dnet.md both already described upstream correctly — the
      // simulator was the only thing that disagreed.
      const h = harness();
      const now = 60 * 60 * 1000;

      const movable = [...h.dnet.hosts.values()]
        .filter((entry) => entry.online && !entry.isStationary && !entry.stasisLinked);
      for (const entry of movable) h.dnet.addSession(entry.hostname, 43);
      const seedHost = movable[0]!.hostname;
      h.dnet.plantStormSeed(seedHost);
      expect(h.dnet.unleashStormSeed(seedHost, now).success).toBe(true);

      // Nothing has elapsed yet: the warning gap is still running.
      expect([...h.dnet.hosts.values()].some((entry) => entry.sessions.size > 0)).toBe(true);

      // Exactly the first gap — 25 cycles, 5 s. Every surviving movable host
      // must ALREADY have been restarted, so no session outlives this tick.
      h.dnet.darknetProcess(STORM_PHASE_CYCLES[0]!);
      const stillSessioned = [...h.dnet.hosts.values()]
        .filter((entry) => !entry.isStationary && !entry.stasisLinked && entry.sessions.size > 0)
        .map((entry) => entry.hostname);
      expect(stillSessioned).toEqual([]);
    });

    test("the storm seed and the webstorm — reroll the net, spare the pinned", async () => {
      // The endgame cache farm's whole mechanism, in one arranged board: a seed
      // is fired, the burst deletes/moves/restarts everything movable, adds
      // fresh hosts, and the stasis-linked survivor keeps its sessions — the
      // exact property the trigger policy's `links-unspent` gate exists for.
      const h = harness();
      const now = 60 * 60 * 1000;

      // Firing without a seed answers 404 through the ns surface — a refusal,
      // never a throw, so a stale sighting costs a job and not an agent.
      const empty = h.ns.dnet.unleashStormSeed();
      expect(empty.success).toBe(false);
      expect(empty.code).toBe(404);

      // Arrange: one pinned survivor with a session, sessions on every movable,
      // and a second seed parked on the pinned host.
      const pinned = [...h.dnet.hosts.values()].find((entry) => entry.online && !entry.isStationary)!;
      expect(h.dnet.setStasisLink(pinned.hostname, true)).toBe(200);
      h.dnet.addSession(pinned.hostname, 42);
      const movableBefore = [...h.dnet.hosts.values()]
        .filter((entry) => entry.online && !entry.isStationary && !entry.stasisLinked);
      for (const entry of movableBefore) h.dnet.addSession(entry.hostname, 43);
      const seedHost = movableBefore[0]!.hostname;
      h.dnet.plantStormSeed(seedHost);
      h.dnet.plantStormSeed(pinned.hostname);
      expect(h.dnet.stormSeedOn(seedHost)).toBe(true);

      // Fire. The seed is consumed, the lock is held, and the ordinary
      // mutation clock is frozen for the whole burst.
      const fired = h.dnet.unleashStormSeed(seedHost, now);
      expect(fired.success).toBe(true);
      expect(h.dnet.stormSeedOn(seedHost)).toBe(false);
      expect(h.dnet.stormActive()).toBe(true);
      const mutationsBefore = h.dnet.mutations;

      // A second fire mid-burst BURNS its seed — the engine consumes and stamps
      // before checking the lock, and so does the model.
      const burned = h.dnet.unleashStormSeed(pinned.hostname, now + 1000);
      expect(burned.success).toBe(false);
      expect(h.dnet.stormSeedOn(pinned.hostname)).toBe(false);

      // nextMutation resolves on storm PHASES while the lock is held: a waiter
      // parked on the clock wakes when the first gap elapses.
      const wake = h.dnet.nextMutation();
      h.dnet.darknetProcess(STORM_PHASE_CYCLES[0]!);
      await wake;

      // Run the burst out: the phase gaps sum to ~30 s.
      h.dnet.darknetProcess(STORM_PHASE_CYCLES.reduce((sum, cycles) => sum + cycles, 0));
      expect(h.dnet.stormActive()).toBe(false);
      // The ordinary clock never ticked under the lock.
      expect(h.dnet.mutations).toBe(mutationsBefore);

      // The pinned host survived whole — online, session intact. So did the
      // stationary beachhead.
      expect(h.dnet.hosts.get(pinned.hostname)!.online).toBe(true);
      expect(h.dnet.hosts.get(pinned.hostname)!.sessions.has(42)).toBe(true);
      expect(h.dnet.hosts.get("darkweb")?.online ?? true).toBe(true);

      // Every movable host that survived was restarted: its sessions are gone.
      for (const entry of movableBefore) {
        const held = h.dnet.hosts.get(entry.hostname);
        if (held?.online !== true) continue;
        expect(held.sessions.has(43)).toBe(false);
      }

      // The add waves refilled the net: fresh hosts exist that predate nothing.
      const onlineAfter = [...h.dnet.hosts.values()].filter((entry) => entry.online);
      const fresh = onlineAfter.filter((entry) =>
        !entry.isStationary && !movableBefore.some((old) => old.hostname === entry.hostname)
        && entry.hostname !== pinned.hostname);
      expect(fresh.length).toBeGreaterThan(0);
    });

    test("the seed drop honours all four of the engine's gates", () => {
      const h = harness();
      let grind = [...h.dnet.hosts.values()].filter((entry) => entry.online && !entry.isStationary);
      const clearOn = (hostname: string, nowMs: number): void => {
        const host = h.dnet.hosts.get(hostname)!;
        host.blockedRam = 0.01;
        const freed = h.dnet.reallocateRam(hostname, 1, 1000, nowMs);
        expect(freed?.cleared).toBe(true);
      };
      const seedAnywhere = (): string | undefined =>
        [...h.dnet.hosts.keys()].find((name) => h.dnet.stormSeedOn(name));

      // Gate (d): inside the 30-minute window after the storm clock is
      // stamped, no clear can mint a seed however many times the 15% roll
      // would have passed. Stamped via `prestige`, which restamps
      // `lastStormTime` exactly as an install does — a real burst here would
      // delete the very hosts the rest of this test grinds.
      const stormAt = 60 * 60 * 1000;
      h.dnet.prestige(stormAt);
      grind = [...h.dnet.hosts.values()].filter((entry) => entry.online && !entry.isStationary);
      for (let i = 0; i < 60; i++) clearOn(grind[1]!.hostname, stormAt + 60_000);
      expect(seedAnywhere()).toBeUndefined();

      // Past the cooldown the roll is live: with a fixed noise stream, sixty
      // 15%-rolls mint one deterministically.
      const later = stormAt + 31 * 60 * 1000;
      for (let i = 0; i < 60 && seedAnywhere() === undefined; i++) clearOn(grind[1]!.hostname, later);
      const minted = seedAnywhere();
      expect(minted).toBe(grind[1]!.hostname);

      // Gate (c) scans MOVABLES only: while a movable seed exists, more clears
      // mint nothing — but the same seed parked on a PINNED host blocks
      // nothing, and a second can spawn.
      for (let i = 0; i < 60; i++) clearOn(grind[2]!.hostname, later);
      expect(h.dnet.stormSeedOn(grind[2]!.hostname)).toBe(false);
      expect(h.dnet.setStasisLink(minted!, true)).toBe(200);
      for (let i = 0; i < 60 && !h.dnet.stormSeedOn(grind[2]!.hostname); i++) {
        clearOn(grind[2]!.hostname, later);
      }
      expect(h.dnet.stormSeedOn(grind[2]!.hostname)).toBe(true);

      // The seed is `ls`-visible from anywhere — it is the only channel.
      expect(h.ns.ls(grind[2]!.hostname)).toContain("STORM_SEED.exe");
    });

    test("initial instability is neutral before any darknet backdoor is installed", () => {
      // Instability is based on surplus backdoored darknet servers. A fresh
      // session has none; other tests install backdoors and exercise 408s.
      const h = harness();
      expect(h.ns.dnet.getDarknetInstability()).toEqual({
        authenticationDurationMultiplier: 1,
        authenticationTimeoutChance: 0,
      });
    });
  });
});
