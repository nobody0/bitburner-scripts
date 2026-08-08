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
      bladeburnerRank: 0,
      numInfiltrations: 0,
      files: new Set(),
    });
    const api = makeSingularity({
      world,
      player: world.player,
      factions,
      clock: world.clock,
      bitNode: 4,
      terminal: { host: "home" },
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

    const augRequirement: PlayerRequirement = { type: "numAugmentations", numAugmentations: 2 };
    const sfRequirement: PlayerRequirement = { type: "sourceFile", sourceFile: 4 };
    expect(satisfies(augRequirement, satisfyContext())).toBe(true);
    expect(satisfies(sfRequirement, satisfyContext())).toBe(true);
    expect(factions.get("Tetrads")).toMatchObject({ rep: 789, favor: 7, invited: true });
    expect(factions.get("UnknownFaction")).toBeUndefined();
  });
});
