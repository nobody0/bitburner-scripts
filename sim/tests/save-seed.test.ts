import { describe, expect, test } from "bun:test";
import type { PlayerRequirement } from "@ns";
import { SimWorld } from "../world.ts";
import { FactionSystem } from "../features/factions.ts";
import { satisfies, type SatisfyContext } from "../features/requirements.ts";
import { makeSingularity } from "../ns/singularity.ts";

describe("save-seeded faction and player state", () => {
  test("the simulated Netscript surface preserves standings, invitations, queued augs, and source files", () => {
    const world = new SimWorld({
      seed: 1,
      bitnode: 4,
      playerState: {
        money: 1e9,
        factions: ["Sector-12"],
        factionInvitations: ["Tetrads", "Chongqing"],
        augmentations: [{ name: "BitWire", level: 1 }],
        queuedAugmentations: [{ name: "PCMatrix", level: 1 }],
        sourceFiles: { "1": 3, "4": 2 },
      },
    });
    const factions = new FactionSystem(world, world.player, {
      "Sector-12": { rep: 123_456, favor: 42 },
      Tetrads: { rep: 789, favor: 7 },
      UnknownFaction: { rep: 999, favor: 99 },
    });
    const satisfyContext = (): SatisfyContext => ({
      player: world.player,
      person: world.person,
      servers: world.servers,
      factionRep: (name) => factions.get(name)?.rep ?? 0,
      companyRep: () => 0,
      bitNode: 4,
      hacknet: { ram: 0, cores: 0, levels: 0 },
      bladeburnerRank: () => 0,
      files: new Set(),
    });
    const api = makeSingularity({
      world,
      player: world.player,
      factions,
      clock: world.clock,
      bitNode: 4,
      terminal: { host: "home" },
      network: new Map([["home", []]]),
      crimes: { start: () => 0 } as never,
      satisfyContext,
      pokeInvitationCounter: () => {},
      homeFiles: () => new Set(),
      hasTor: () => false,
      setTor: () => {},
    }).singularity as Record<string, (...args: never[]) => unknown>;

    expect(api["getFactionRep"]!("Sector-12" as never)).toBe(123_456);
    expect(api["getFactionFavor"]!("Sector-12" as never)).toBe(42);
    const invitations = api["checkFactionInvitations"]!() as string[];
    expect(invitations).toContain("Tetrads");
    expect(invitations).not.toContain("Chongqing"); // banned by joined Sector-12
    expect(api["getOwnedAugmentations"]!(true as never)).toEqual(["BitWire", "PCMatrix"]);
    const firstNfg = api["getAugmentationPrice"]!("NeuroFlux Governor" as never) as number;
    expect(api["purchaseAugmentation"]!("Sector-12" as never, "NeuroFlux Governor" as never)).toBe(true);
    const secondNfg = api["getAugmentationPrice"]!("NeuroFlux Governor" as never) as number;
    expect(secondNfg / firstNfg).toBeCloseTo(1.9 * 1.14, 10);

    const augRequirement: PlayerRequirement = { type: "numAugmentations", numAugmentations: 2 };
    const sfRequirement: PlayerRequirement = { type: "sourceFile", sourceFile: 4 };
    expect(satisfies(augRequirement, satisfyContext())).toBe(false);
    expect(satisfies(sfRequirement, satisfyContext())).toBe(true);
    expect(factions.get("Tetrads")).toMatchObject({ rep: 789, favor: 7, invited: true });
    expect(factions.get("UnknownFaction")).toBeUndefined();
  });

  test("augmentation prestige banks all reputation and resets cycle-only faction state", () => {
    const world = new SimWorld({
      seed: 1,
      bitnode: 4,
      playerState: {
        factions: ["Sector-12"],
        factionInvitations: ["ECorp", "CyberSec"],
      },
    });
    const factions = new FactionSystem(world, world.player, {
      "Sector-12": { rep: 25_000, favor: 0 },
      ECorp: { rep: 10_000, favor: 2 },
      Chongqing: { rep: 5_000, favor: 0 },
    });

    expect(factions.get("Chongqing")?.banned).toBe(true);
    factions.prestigeAugmentation();

    expect(world.player.factions).toEqual([]);
    expect(world.player.factionInvitations).toEqual(["ECorp"]);
    expect(factions.get("ECorp")).toMatchObject({ invited: true, joined: false, rep: 0 });
    expect(factions.get("CyberSec")?.invited).toBe(false);
    expect(factions.get("Chongqing")).toMatchObject({ banned: false, rep: 0 });
    expect(factions.get("Chongqing")?.favor ?? 0).toBeGreaterThan(0);
    expect(factions.get("Sector-12")?.favor ?? 0).toBeGreaterThan(0);
  });
});

describe("Singularity terminal topology", () => {
  test("connect follows graph edges while backdoors/purchased hosts remain direct shortcuts", () => {
    const world = new SimWorld({
      seed: 3,
      network: [
        { hostname: "a", hackDifficulty: 1, moneyAvailable: 0, requiredHackingSkill: 1, serverGrowth: 0, numOpenPortsRequired: 0, maxRam: 0 },
        { hostname: "b", hackDifficulty: 1, moneyAvailable: 0, requiredHackingSkill: 1, serverGrowth: 0, numOpenPortsRequired: 0, maxRam: 0 },
      ],
    });
    const factions = new FactionSystem(world, world.player);
    const terminal = { host: "home" };
    const network = new Map([["home", ["a"]], ["a", ["home", "b"]], ["b", ["a"]]]);
    const api = makeSingularity({
      world,
      player: world.player,
      factions,
      clock: world.clock,
      bitNode: 4,
      terminal,
      network,
      crimes: { start: () => 0 } as never,
      satisfyContext: () => ({
        player: world.player, person: world.person, servers: world.servers,
        factionRep: () => 0, companyRep: () => 0, bitNode: 4,
        hacknet: { ram: 0, cores: 0, levels: 0 }, bladeburnerRank: () => 0, files: new Set(),
      }),
      pokeInvitationCounter: () => {},
      homeFiles: () => new Set(),
      hasTor: () => false,
      setTor: () => {},
    }).singularity as Record<string, (...args: never[]) => unknown>;

    expect(api["connect"]!("b" as never)).toBe(false);
    expect(api["connect"]!("a" as never)).toBe(true);
    expect(api["connect"]!("b" as never)).toBe(true);
    expect(api["connect"]!("home" as never)).toBe(true);
    world.servers.get("b")!.backdoorInstalled = true;
    expect(api["connect"]!("b" as never)).toBe(true);
  });

  test("installBackdoor rejects purchased, unrooted, and under-skilled targets", async () => {
    const world = new SimWorld({
      seed: 4,
      network: [{ hostname: "target", hackDifficulty: 1, moneyAvailable: 0, requiredHackingSkill: 50, serverGrowth: 0, numOpenPortsRequired: 0, maxRam: 0 }],
    });
    const factions = new FactionSystem(world, world.player);
    const target = world.servers.get("target")!;
    const api = makeSingularity({
      world, player: world.player, factions, clock: world.clock, bitNode: 4,
      terminal: { host: "target" }, network: new Map([["home", ["target"]], ["target", ["home"]]]),
      crimes: { start: () => 0 } as never,
      satisfyContext: () => ({
        player: world.player, person: world.person, servers: world.servers,
        factionRep: () => 0, companyRep: () => 0, bitNode: 4,
        hacknet: { ram: 0, cores: 0, levels: 0 }, bladeburnerRank: () => 0, files: new Set(),
      }),
      pokeInvitationCounter: () => {}, homeFiles: () => new Set(), hasTor: () => false, setTor: () => {},
    }).singularity as Record<string, (...args: never[]) => unknown>;

    target.purchasedByPlayer = true;
    await expect(api["installBackdoor"]!() as Promise<void>).rejects.toThrow("purchased server");
    target.purchasedByPlayer = false;
    await expect(api["installBackdoor"]!() as Promise<void>).rejects.toThrow("no root access");
    target.hasAdminRights = true;
    await expect(api["installBackdoor"]!() as Promise<void>).rejects.toThrow("hacking level is too low");
    expect(target.backdoorInstalled).toBe(false);
  });
});

describe("invitation requirement state", () => {
  test("company, file, Bladeburner, and infiltration checks use seeded state", () => {
    const world = new SimWorld({ seed: 8 });
    const files = new Set(["fulcrumassets.lit"]);
    const ctx: SatisfyContext = {
      player: world.player,
      person: world.person,
      servers: world.servers,
      factionRep: () => 0,
      companyRep: (name) => name === "ECorp" ? 250_000 : 0,
      bitNode: 7,
      hacknet: { ram: 0, cores: 0, levels: 0 },
      bladeburnerRank: () => 321,
      files,
    };

    expect(satisfies({ type: "companyReputation", company: "ECorp", reputation: 200_000 }, ctx)).toBe(true);
    expect(satisfies({ type: "file", file: "fulcrumassets.lit" }, ctx)).toBe(true);
    expect(satisfies({ type: "bladeburnerRank", bladeburnerRank: 300 }, ctx)).toBe(true);
    expect(satisfies({ type: "numInfiltrations", numInfiltrations: 1 }, ctx)).toBe(false);
    world.player.factionInvitations.push("Shadows of Anarchy");
    expect(satisfies({ type: "numInfiltrations", numInfiltrations: 1 }, ctx)).toBe(true);
  });
});
