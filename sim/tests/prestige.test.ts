import { describe, expect, test } from "bun:test";
import { SimWorld } from "../world.ts";
import { HacknetSystem } from "../features/hacknet.ts";
import { AUGMENTATION_TABLE } from "../vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { CONSTANTS } from "../vendor/bitburner/src/Constants.ts";
import { calculateExp } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";

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

  test("rebuilds augmentations, Source Files, repeated NeuroFlux, and both entropy directions", () => {
    const nfg = AUGMENTATION_TABLE["NeuroFlux Governor"]!;
    const world = new SimWorld({
      seed: 1,
      playerState: {
        entropy: 2,
        exploits: ["Bypass", "Bypass", "not-an-exploit"],
        augmentations: [
          { name: "BitWire", level: 1 },
          { name: "NeuroFlux Governor", level: 2 },
        ],
        sourceFiles: { "1": 1 },
      },
    });
    const benefit = 1.05 * nfg.mults.hacking! ** 2 * 1.16 * 1.001 * CONSTANTS.EntropyEffect ** 2;
    const cost = nfg.mults.hacknet_node_purchase_cost! ** 2 / 1.16 * 0.999 / CONSTANTS.EntropyEffect ** 2;
    expect(world.player.exploits).toEqual(["Bypass"]);
    expect(world.person.mults.hacking).toBeCloseTo(benefit, 14);
    expect(world.person.mults.hacknet_node_purchase_cost).toBeCloseTo(cost, 14);

    world.person.mults.hacking = 999;
    world.prestigeAugmentation(new Map());
    expect(world.person.mults.hacking).toBeCloseTo(benefit, 14);
    expect(world.person.mults.hacknet_node_purchase_cost).toBeCloseTo(cost, 14);
  });

  test("sets level-one experience from the final multiplier and attributes augmentation grants in BN8", () => {
    const entropy = 100;
    const world = new SimWorld({
      seed: 1,
      bitnode: 8,
      playerState: {
        entropy,
        augmentations: [{ name: "CashRoot Starter Kit", level: 1 }],
      },
    });
    world.prestigeAugmentation(new Map());

    const skillMult = CONSTANTS.EntropyEffect ** entropy;
    expect(world.person.exp.hacking).toBe(calculateExp(1, skillMult * currentNodeMults.HackingLevelMultiplier));
    expect(world.person.skills.hacking).toBe(1);
    expect(world.player.money).toBe(250e6);
    expect(world.moneySources.sinceInstall.other).toBe(1_000_000);
  });

  test("restores persistent intelligence and applies the advanced-option cap on install", () => {
    const persistent = calculateExp(50, 1);
    const world = new SimWorld({
      seed: 1,
      bitnode: 5,
      intelligenceOverride: 25,
      person: { skills: { intelligence: 5 }, exp: { intelligence: calculateExp(5, 1) } },
      playerState: { persistentIntelligenceExp: persistent },
    });
    world.gainIntelligenceExp(10);
    expect(world.player.persistentIntelligenceExp).toBe(persistent + 10);
    world.prestigeAugmentation(new Map());
    expect(world.person.skills.intelligence).toBe(25);
    expect(world.person.exp.intelligence).toBe(calculateExp(25, 1));
    expect(world.player.persistentIntelligenceExp).toBe(persistent + 10);
  });
});
