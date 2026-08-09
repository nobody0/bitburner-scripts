import { describe, expect, test } from "bun:test";
import { mockServer } from "../core/mocks.ts";
import { HacknetSystem } from "../features/hacknet.ts";
import { SimWorld } from "../world.ts";

describe("simulated Hacknet economy", () => {
  test("a save seed restores nodes, hashes, and escalating upgrade levels", () => {
    const world = new SimWorld({ seed: 1, startingMoney: 1e9 });
    world.servers.set("hacknet-server-0", mockServer({
      hostname: "hacknet-server-0", hasAdminRights: true, purchasedByPlayer: true, maxRam: 8, cpuCores: 3,
    }) as never);
    const hacknet = new HacknetSystem(world, world.player, true, {
      nodes: [{
        hostname: "hacknet-server-0", level: 42, ram: 8, cores: 3,
        cache: 4, totalProduction: 1234, onlineTimeSeconds: 5678,
      }],
      hashes: 37,
      hashLevels: { "Increase Maximum Money": 2 },
    });

    expect(hacknet.nodes[0]).toMatchObject({ level: 42, ram: 8, cores: 3, cache: 4 });
    expect(hacknet.hashes).toBe(37);
    expect(hacknet.hashCost("Increase Maximum Money")).toBe(150);
    expect(hacknet.hashCapacity()).toBe(512);
  });

  test("plain nodes pay money directly", () => {
    const world = new SimWorld({ seed: 1, bitnode: 1, startingMoney: 10_000 });
    const hacknet = new HacknetSystem(world, world.player, false);
    expect(hacknet.purchaseNode()).toBe(0);
    const afterPurchase = world.money;
    hacknet.processEarnings(5); // one second
    expect(world.money - afterPurchase).toBeCloseTo(1.5, 10);
  });

  test("servers produce hashes which can be sold for money", () => {
    const world = new SimWorld({ seed: 1, bitnode: 9, startingMoney: 100_000 });
    const hacknet = new HacknetSystem(world, world.player, true);
    expect(hacknet.purchaseNode()).toBe(0);
    expect(world.servers.get("hacknet-server-0")?.maxRam).toBe(1);
    expect(hacknet.nodeCost()).toBe(160_000);
    hacknet.processEarnings(20_000); // 4,000 seconds at .001 hashes/sec
    expect(hacknet.hashes).toBeCloseTo(4, 10);
    const beforeSale = world.money;
    expect(hacknet.spendHashes(1)).toBe(true);
    expect(world.money - beforeSale).toBe(1_000_000);
    expect(hacknet.hashes).toBeCloseTo(0, 10);
  });

  test("server RAM usage is the hash-production opportunity cost", () => {
    const world = new SimWorld({ seed: 1, bitnode: 9, startingMoney: 1e9 });
    const hacknet = new HacknetSystem(world, world.player, true);
    hacknet.purchaseNode();
    const node = hacknet.nodes[0]!;
    const idle = hacknet.production(node);
    world.servers.get("hacknet-server-0")!.ramUsed = 1;
    expect(hacknet.production(node)).toBe(0);
    world.servers.get("hacknet-server-0")!.ramUsed = 0;
    expect(hacknet.production(node)).toBe(idle);
    expect(hacknet.upgradeRam(0)).toBe(true);
    expect(world.servers.get("hacknet-server-0")!.maxRam).toBe(2);
  });

  test("cache and target-mutating hash upgrades use escalating authoritative costs", () => {
    const world = new SimWorld({
      seed: 1,
      bitnode: 9,
      startingMoney: 1e12,
      network: [{ hostname: "foodnstuff", hackDifficulty: 10, moneyAvailable: 1e6, requiredHackingSkill: 1, serverGrowth: 10, numOpenPortsRequired: 0, maxRam: 0 }],
    });
    const target = world.servers.get("foodnstuff")!;
    const hacknet = new HacknetSystem(world, world.player, true);
    hacknet.purchaseNode();
    const oldCapacity = hacknet.hashCapacity();
    expect(hacknet.upgradeCache(0)).toBe(true);
    expect(hacknet.hashCapacity()).toBe(oldCapacity * 2);
    hacknet.hashes = 1_000;
    const oldMoney = target.moneyMax;
    expect(hacknet.hashCost("Increase Maximum Money")).toBe(50);
    expect(hacknet.spendHashes("Increase Maximum Money", "foodnstuff")).toBe(true);
    expect(target.moneyMax).toBeCloseTo(oldMoney * 1.02, 8);
    expect(hacknet.hashCost("Increase Maximum Money")).toBe(100);
  });

  test("server count is capped while node count is not", () => {
    const world = new SimWorld({ seed: 1, bitnode: 9, startingMoney: 1e30 });
    const servers = new HacknetSystem(world, world.player, true);
    expect(servers.maxNodes).toBe(20);
    const nodes = new HacknetSystem(world, world.player, false);
    expect(nodes.maxNodes).toBe(Infinity);
  });
});
