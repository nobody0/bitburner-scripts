import { describe, expect, test } from "bun:test";
import { SimWorld } from "../world.ts";
import { HacknetSystem } from "../features/hacknet.ts";

describe("augmentation prestige", () => {
  test("money sources reset since-install without losing since-start attribution", () => {
    const world = new SimWorld({ seed: 1, startingMoney: 1_000 });
    world.recordMoney("hacking", 100);
    world.recordMoney("servers", -20);

    expect(world.moneySources.sinceInstall.total).toBe(80);
    expect(world.moneySources.sinceStart.total).toBe(80);
    world.resetInstallMoneySources();
    expect(world.moneySources.sinceInstall.total).toBe(0);
    expect(world.moneySources.sinceStart).toMatchObject({ hacking: 100, servers: -20, total: 80 });
  });

  test("resets skills and public servers while preserving home upgrades", () => {
    const world = new SimWorld({
      seed: 1,
      startingMoney: 1e12,
      homeRam: 64,
      homeCores: 4,
      person: { skills: { hacking: 500 }, exp: { hacking: 1e9 } },
      network: [{
        hostname: "n00dles",
        hackDifficulty: 1,
        moneyAvailable: 1e6,
        requiredHackingSkill: 1,
        serverGrowth: 10,
        numOpenPortsRequired: 0,
        maxRam: 4,
      }],
    });
    world.execute({ type: "buyServer", name: "pserv-0", ram: 8 });
    world.servers.get("n00dles")!.moneyAvailable = 1;

    world.prestigeAugmentation(new Map());

    expect(world.person.skills.hacking).toBe(1);
    expect(world.person.exp.hacking).toBe(0);
    expect(world.servers.has("pserv-0")).toBe(false);
    expect(world.servers.get("n00dles")!.moneyAvailable).toBe(1e6);
    expect(world.servers.get("home")).toMatchObject({ maxRam: 64, cpuCores: 4, ramUsed: 0 });
  });

  test("Hacknet nodes, hashes and upgrades do not survive", () => {
    const world = new SimWorld({ seed: 1, startingMoney: 1e12, bitnode: 9 });
    const hacknet = new HacknetSystem(world, world.player, true);
    expect(hacknet.purchaseNode()).toBe(0);
    hacknet.hashes = 123;
    hacknet.hashLevels["Sell for Money"] = 4;

    hacknet.prestige();

    expect(hacknet.nodes).toEqual([]);
    expect(hacknet.hashes).toBe(0);
    expect(hacknet.hashLevels["Sell for Money"]).toBe(0);
  });
});
