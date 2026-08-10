import { describe, expect, test } from "bun:test";
import type { NS, ResetInfo } from "@ns";
import { SimWorld } from "../world.ts";
import { ProcessTable, ScriptDeath } from "../ns/process.ts";
import { makeSimNs, type SimNsHost } from "../ns/api.ts";
import { StockMarketSystem } from "../features/stock.ts";
import { mulberry32 } from "../core/rng.ts";
import { FactionSystem } from "../features/factions.ts";
import { makeSingularity } from "../ns/singularity.ts";

function harness(programs: string[] = [], withStock = false): { ns: NS; host: SimNsHost; world: SimWorld } {
  const world = new SimWorld({
    seed: 1,
    network: [{
      hostname: "n00dles",
      hackDifficulty: 1,
      moneyAvailable: 70_000,
      requiredHackingSkill: 1,
      serverGrowth: 3000,
      numOpenPortsRequired: 1,
      maxRam: 4,
    }],
  });
  const processes = new ProcessTable(world.servers, world.clock);
  const files = new Map([
    ["home", new Set(["main.js", "NUKE.exe", ...programs])],
    ["n00dles", new Set(["child.js"])],
  ]);
  const host: SimNsHost = {
    world,
    clock: world.clock,
    processes,
    files,
    contents: new Map(),
    scripts: new Map(),
    network: new Map([["home", ["n00dles"]], ["n00dles", ["home"]]]),
    ramCtx: {},
    reset: {} as ResetInfo,
    output: [],
    crashes: [],
  };
  const process = processes.start({
    filename: "main.js",
    host: "home",
    args: [],
    threads: 1,
    ramPerThreadGb: 1,
    temporary: false,
  })!;
  if (withStock) {
    world.player.money = 1e15;
    host.stock = new StockMarketSystem(world, world.player, mulberry32(11));
  }
  return { ns: makeSimNs(host, process), host, world };
}

describe("Netscript contract fidelity", () => {
  test("port openers require their program, count once, and nuke returns a boolean", () => {
    const { ns, world } = harness();
    const target = world.servers.get("n00dles")!;
    expect(ns.brutessh("n00dles")).toBe(false);
    expect(target.openPortCount).toBe(0);
    expect(ns.nuke("n00dles")).toBe(false);

    expect(ns.ls("home")).toContain("NUKE.exe");
  });

  test("a real opener succeeds once and permits nuke", () => {
    const { ns, world } = harness(["BruteSSH.exe"]);
    const target = world.servers.get("n00dles")!;
    expect(ns.brutessh("n00dles")).toBe(true);
    expect(ns.brutessh("n00dles")).toBe(true);
    expect(target.openPortCount).toBe(1);
    expect(ns.nuke("n00dles")).toBe(true);
    expect(target.hasAdminRights).toBe(true);
  });

  test("HGW rejects unrooted and purchased servers", () => {
    const { ns, world } = harness();
    const target = world.servers.get("n00dles")!;
    expect(() => ns.grow("n00dles")).toThrow("no admin rights");
    target.hasAdminRights = true;
    target.purchasedByPlayer = true;
    expect(() => ns.hack("n00dles")).toThrow("purchased server");
    expect(() => ns.weaken("n00dles")).toThrow("purchased server");
  });

  test("HGW validates thread and delay options like validateHGWOptions", () => {
    const { ns, world } = harness();
    world.servers.get("n00dles")!.hasAdminRights = true;
    expect(() => ns.grow("n00dles", { threads: 2 })).toThrow("Too many threads");
    expect(() => ns.grow("n00dles", { threads: -1 })).toThrow("positive number");
    expect(() => ns.grow("n00dles", { additionalMsec: -1 })).toThrow("non-negative");
    expect(() => ns.grow("n00dles", { additionalMsec: 1e9 + 1 })).toThrow("too large");
    expect(() => (ns.grow as (host: string, opts: unknown) => unknown)("n00dles", 1)).toThrow("must be an object");
  });

  test("home money reads player money through both public APIs", () => {
    const { ns, world } = harness();
    world.player.money = 123_456;
    expect(ns.getServerMoneyAvailable("home")).toBe(123_456);
    expect(ns.getServer("home").moneyAvailable).toBe(123_456);
  });

  test("the universally available Go capability getter returns the real fresh-board state", () => {
    const { ns } = harness();
    expect(ns.go.getGameState()).toEqual({
      currentPlayer: "Black",
      whiteScore: 1.5,
      blackScore: 0,
      previousMove: null,
      komi: 1.5,
      bonusCycles: 0,
    });
  });

  test("script totals report live per-process rates and since-install hacking separately", () => {
    const { ns, host, world } = harness();
    const running = [...host.processes.values()][0]!;
    running.onlineMoneyMade = 20;
    running.onlineExpGained = 7;
    running.onlineRunningTimeSeconds = 1;
    host.reset.lastAugReset = 0;
    world.recordMoney("hacking", 50);
    host.clock.in(1_000, () => {});
    host.clock.run();
    expect(ns.getTotalScriptIncome()).toEqual([20, 50]);
    expect(ns.getTotalScriptExpGain()).toBe(7);
  });

  test("engine-time accounting starts at 0.01s and finished children transfer earnings to their parent", () => {
    const { host } = harness();
    const parent = [...host.processes.values()][0]!;
    expect(parent.onlineRunningTimeSeconds).toBe(0.01);
    host.processes.updateOnlineTimes(5);
    expect(parent.onlineRunningTimeSeconds).toBe(1.01);
    const child = host.processes.start({
      filename: "child.js", host: "home", args: [], threads: 1,
      ramPerThreadGb: 1, temporary: true, parentPid: parent.pid,
    })!;
    child.onlineMoneyMade = 123;
    child.onlineExpGained = 45;
    host.processes.finish(child.pid);
    expect(parent.onlineMoneyMade).toBe(123);
    expect(parent.onlineExpGained).toBe(45);
  });

  test("the public RAM-cost API rejects unknown paths", () => {
    const { ns } = harness();
    expect(ns.getFunctionRamCost("baseCost")).toBe(1.6);
    expect(() => ns.getFunctionRamCost("does.not.exist")).toThrow();
  });

  test("ramOverride reports an unchanged allocation and refuses to invent dynamic RAM headroom", () => {
    const { ns, host } = harness();
    const process = [...host.processes.values()][0]!;
    expect(ns.ramOverride()).toBe(1);
    expect(ns.ramOverride(1)).toBe(1);
    expect(() => ns.ramOverride(3.6)).toThrow("changing an allocation requires per-process dynamic RAM accounting");
    expect(process.ramGb).toBe(1);
  });

  test("exec refuses a server without root even when the script is present", () => {
    const { ns } = harness();
    expect(ns.exec("child.js", "n00dles", 1)).toBe(0);
  });

  test("an un-awaited delaying call kills the script on its next Netscript call", async () => {
    const { ns, host } = harness();
    const pending = ns.sleep(1_000).catch((error) => error);
    expect(() => ns.getPlayer()).toThrow("Concurrent calls to Netscript functions");
    expect(host.processes.size).toBe(0);
    expect(await pending).toBeInstanceOf(ScriptDeath);
  });

  test("killing installBackdoor cancels its timer and world mutation", async () => {
    const { ns, host, world } = harness();
    const target = world.servers.get("n00dles")!;
    target.hasAdminRights = true;
    const factions = new FactionSystem(world, world.player);
    host.singularity = makeSingularity({
      world,
      player: world.player,
      factions,
      clock: world.clock,
      bitNode: 4,
      terminal: { host: "n00dles" },
      network: host.network,
      crimes: { start: () => 0 } as never,
      satisfyContext: () => ({
        player: world.player, person: world.person, servers: world.servers,
        factionRep: () => 0, companyRep: () => 0, bitNode: 4,
        hacknet: { ram: 0, cores: 0, levels: 0 }, bladeburnerRank: () => 0, files: new Set(),
      }),
      pokeInvitationCounter: () => {}, homeFiles: () => new Set(), hasTor: () => false, setTor: () => {},
    });
    const processNs = makeSimNs(host, [...host.processes.values()][0]!);
    const pending = processNs.singularity.installBackdoor().catch((error) => error);
    expect(host.processes.kill(processNs.pid)).toBe(true);
    host.clock.run();
    expect(await pending).toBeInstanceOf(ScriptDeath);
    expect(target.backdoorInstalled).toBe(false);
  });

  test("the 4S script API purchase requires TIX access", () => {
    const { ns } = harness([], true);
    expect(() => ns.stock.purchase4SMarketDataTixApi()).toThrow("no TIX API access");
  });
});
