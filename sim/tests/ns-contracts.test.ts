import { describe, expect, test } from "bun:test";
import type { NS, ResetInfo } from "@ns";
import { SimWorld } from "../world.ts";
import { ProcessTable, ScriptDeath } from "../ns/process.ts";
import { makeSimNs, type SimNsHost } from "../ns/api.ts";
import { StockMarketSystem } from "../features/stock.ts";
import { mulberry32 } from "../core/rng.ts";

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

  test("the 4S script API purchase requires TIX access", () => {
    const { ns } = harness([], true);
    expect(() => ns.stock.purchase4SMarketDataTixApi()).toThrow("no TIX API access");
  });
});
