import { describe, expect, test } from "bun:test";
import {
  generateVanillaNetwork,
  isSeededVanillaNetwork,
  VANILLA_NETWORK,
  VANILLA_NETWORK_SEED,
} from "../network.ts";
import { findProfile } from "../profiles.ts";
import { SERVER_METADATA, type Range } from "../vendor/bitburner/src/Server/data/ServerMetadata.ts";

function inRange(value: number, range: Range | undefined): boolean {
  return range !== undefined && value >= range[0] && value <= range[1];
}

describe("seeded vanilla network", () => {
  test("contains the complete standard server population", () => {
    const hosts = VANILLA_NETWORK.network.map((server) => server.hostname).sort();
    expect(hosts).toEqual(Object.keys(SERVER_METADATA).sort());
    expect(hosts).toHaveLength(70);
    expect(hosts).toContain("n00dles");
    expect(hosts).toContain("The-Cave");
    expect(hosts).toContain("w0r1d_d43m0n");
    expect(hosts).not.toContain("late-farm");
  });

  test("is fixed by its dedicated seed, independently of gameplay seeds", () => {
    expect(generateVanillaNetwork(VANILLA_NETWORK_SEED)).toEqual(VANILLA_NETWORK);
    expect(generateVanillaNetwork(VANILLA_NETWORK_SEED)).toEqual(generateVanillaNetwork(VANILLA_NETWORK_SEED));
    expect(generateVanillaNetwork(VANILLA_NETWORK_SEED + 1)).not.toEqual(VANILLA_NETWORK);
  });

  test("rolls every field inside the pinned upstream ranges", () => {
    for (const server of VANILLA_NETWORK.network) {
      const metadata = SERVER_METADATA[server.hostname]!;
      expect(server.organizationName).toBe(metadata.org);
      expect(server.numOpenPortsRequired).toBe(metadata.ports);
      expect(inRange(server.moneyAvailable, metadata.money)).toBe(true);
      expect(inRange(server.requiredHackingSkill, metadata.skill)).toBe(true);
      if (metadata.sec?.[0] === 0 && !metadata.randomized.sec) expect(server.hackDifficulty).toBe(1);
      else expect(inRange(server.hackDifficulty, metadata.sec)).toBe(true);
      if (metadata.growth?.[0] === 0 && !metadata.randomized.growth) expect(server.serverGrowth).toBe(1);
      else expect(inRange(server.serverGrowth, metadata.growth)).toBe(true);
      if (metadata.ramExp) expect(inRange(Math.log2(server.maxRam), metadata.ramExp)).toBe(true);
      else expect(server.maxRam).toBe(0);
      if (metadata.layer) {
        const layer = metadata.layer[0];
        expect(server.cpuCores).toBeGreaterThanOrEqual(Math.ceil(layer / 2));
        expect(server.cpuCores).toBeLessThanOrEqual(layer);
      } else expect(server.cpuCores).toBe(1);
    }
  });

  test("uses the vanilla layer tree and leaves the daemon hidden until Red Pill install", () => {
    const { topology } = VANILLA_NETWORK;
    expect(Object.keys(topology)).toHaveLength(71);
    expect(topology["w0r1d_d43m0n"]).toEqual([]);

    let directedEdges = 0;
    for (const [host, neighbours] of Object.entries(topology)) {
      directedEdges += neighbours.length;
      for (const neighbour of neighbours) expect(topology[neighbour]).toContain(host);
    }
    expect(directedEdges / 2).toBe(69);

    const depth = new Map<string, number>([["home", 0]]);
    const queue = ["home"];
    while (queue.length > 0) {
      const host = queue.shift()!;
      for (const neighbour of topology[host]!) {
        if (depth.has(neighbour)) continue;
        depth.set(neighbour, depth.get(host)! + 1);
        queue.push(neighbour);
      }
    }
    expect(depth.size).toBe(70);
    expect(depth.has("w0r1d_d43m0n")).toBe(false);
    for (const metadata of Object.values(SERVER_METADATA)) {
      if (metadata.layer) expect(depth.get(metadata.host)).toBe(metadata.layer[0]);
    }
  });

  test("bn1-full uses this population rather than a synthetic farm", () => {
    const profile = findProfile("bn1-full");
    const world = profile.world!;
    expect(world.network).toEqual(VANILLA_NETWORK.network);
    expect(world.topology).toEqual(VANILLA_NETWORK.topology);
    expect(world.network).toHaveLength(70);
    expect(profile.homeRam).toBe(8);
    expect(profile.startingMoney).toBeUndefined();
    expect(world.person).toBeUndefined();
    expect(world.factions).toBeUndefined();
    expect(world.playerState?.augmentations).toBeUndefined();
    expect(world.playerState?.queuedAugmentations).toBeUndefined();
    expect(world.playerState?.sourceFiles).toEqual({ "4": 3, "14": 3 });
    expect(isSeededVanillaNetwork(world.network, world.topology)).toBe(true);
    expect(isSeededVanillaNetwork(world.network?.slice(1), world.topology)).toBe(false);
  });
});
