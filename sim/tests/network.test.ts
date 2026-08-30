import { describe, expect, test } from "bun:test";
import {
  generateVanillaNetwork,
  generateVanillaNetworkFromRng,
  isSeededVanillaNetwork,
  VANILLA_NETWORK,
  VANILLA_NETWORK_SEED,
} from "../network.ts";
import { mulberry32 } from "../core/rng.ts";
import { staticsFromRolls } from "../../shared/strategy/bounds.ts";
import { findProfile } from "../profiles.ts";
import { SERVER_METADATA, type Range } from "../vendor/bitburner/src/Server/data/ServerMetadata.ts";
import { runGame } from "../game-run.ts";
import { parseGoal } from "../../shared/goals/presets.ts";
import { only } from "../feature-selection.ts";

function inRange(value: number, range: Range | undefined): boolean {
  return range !== undefined && value >= range[0] && value <= range[1];
}

describe("seeded vanilla network", () => {
  test("contains the complete standard server population", () => {
    const hosts = VANILLA_NETWORK.network.map((server) => server.hostname).sort();
    expect(hosts.filter((host) => host !== "darkweb")).toEqual(Object.keys(SERVER_METADATA).sort());
    expect(hosts).toContain("darkweb");
    const ips = [VANILLA_NETWORK.homeIp, ...VANILLA_NETWORK.network.map((server) => server.ip!)];
    expect(ips.every((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))).toBe(true);
    expect(new Set(ips).size).toBe(ips.length);
  });

  test("is fixed by its dedicated seed, independently of gameplay seeds", () => {
    expect(generateVanillaNetwork(VANILLA_NETWORK_SEED)).toEqual(VANILLA_NETWORK);
    expect(generateVanillaNetwork(VANILLA_NETWORK_SEED)).toEqual(generateVanillaNetwork(VANILLA_NETWORK_SEED));
    expect(generateVanillaNetwork(VANILLA_NETWORK_SEED + 1)).not.toEqual(VANILLA_NETWORK);
  });

  test("fixed vanilla worlds still use the declared seed for gameplay randomness", async () => {
    const initialEcorpPrice = async (seed: number): Promise<number> => {
      let price: number | undefined;
      await runGame({
        goal: parseGoal("wealth:1e99"),
        seed,
        horizonMs: 2_000,
        bitnode: 8,
        startingMoney: 250e6,
        features: only("stock", "progression"),
        ...VANILLA_NETWORK,
        onRecord: (line) => {
          const record = JSON.parse(line) as {
            kind: string;
            key?: string;
            data?: { positions?: { sym: string; price: number }[] };
          };
          if (record.kind !== "state" || record.key !== "stock") return;
          price ??= record.data?.positions?.find((position) => position.sym === "ECP")?.price;
        },
      });
      if (price === undefined) throw new Error("controller emitted no ECP quote");
      return price;
    };

    const seedOne = await initialEcorpPrice(1);
    expect(await initialEcorpPrice(1)).toBe(seedOne);
    expect(await initialEcorpPrice(2)).not.toBe(seedOne);
  });

  test("successive augmentation worlds consume one continuous generation stream", () => {
    const rngA = mulberry32(VANILLA_NETWORK_SEED);
    const first = generateVanillaNetworkFromRng(rngA);
    const second = generateVanillaNetworkFromRng(rngA);
    const rngB = mulberry32(VANILLA_NETWORK_SEED);
    expect(first).toEqual(generateVanillaNetworkFromRng(rngB));
    expect(second).toEqual(generateVanillaNetworkFromRng(rngB));
    expect(second).not.toEqual(first);
  });

  test("rolls every field inside the pinned upstream ranges", () => {
    for (const server of VANILLA_NETWORK.network) {
      if (server.hostname === "darkweb") {
        // initDarkwebServer() hands it 16 GB with nothing blocked and roots it,
        // which is what makes it the one darknet host reachable without a
        // credential. mockServer defaults hasAdminRights to false, so leaving
        // this off would make ns.exec("...", "darkweb") return a silent 0.
        expect(server).toMatchObject({
          simKind: "DarknetServer",
          maxRam: 16,
          numOpenPortsRequired: 0,
          hasAdminRights: true,
        });
        continue;
      }
      const metadata = SERVER_METADATA[server.hostname]!;
      expect(server.organizationName).toBe(metadata.org);
      expect(server.numOpenPortsRequired).toBe(metadata.ports);
      expect(inRange(server.moneyAvailable, metadata.money)).toBe(true);
      expect(inRange(server.requiredHackingSkill, metadata.skill)).toBe(true);
      // The spec carries the RAW roll; a metadata sec of 0 means "upstream never
      // set hackDifficulty", and the constructor's unmultiplied 1 is applied by
      // staticsFromRolls — so that is where the invariant is asserted.
      const derived = staticsFromRolls(server.hostname, {
        money: server.moneyAvailable,
        sec: server.hackDifficulty,
        skill: server.requiredHackingSkill,
        growth: server.serverGrowth,
      });
      if (metadata.sec?.[0] === 0 && !metadata.randomized.sec) {
        expect(server.hackDifficulty).toBe(0);
        expect(derived.baseDifficulty).toBe(1);
        expect(derived.minDifficulty).toBe(1);
      } else {
        expect(inRange(server.hackDifficulty, metadata.sec)).toBe(true);
      }
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
    expect(topology["w0r1d_d43m0n"]).toEqual([]);
    expect(topology["darkweb"]).toEqual([]);

    for (const [host, neighbours] of Object.entries(topology)) {
      for (const neighbour of neighbours) expect(topology[neighbour]).toContain(host);
    }

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
    expect(depth.has("w0r1d_d43m0n")).toBe(false);
    for (const metadata of Object.values(SERVER_METADATA)) {
      if (metadata.layer) expect(depth.get(metadata.host)).toBe(metadata.layer[0]);
    }
  });

  test("the route's first leg uses this population rather than a synthetic farm", () => {
    // `leg-bn4.1` is the route's genuine cold start: fresh BN4, nothing
    // granted, because Singularity is node-native there.
    const profile = findProfile("leg-bn4.1");
    const world = profile.world!;
    expect(world.network).toEqual(VANILLA_NETWORK.network);
    expect(world.topology).toEqual(VANILLA_NETWORK.topology);
    expect(profile.homeRam).toBe(8);
    expect(profile.startingMoney).toBeUndefined();
    expect(world.person).toBeUndefined();
    expect(world.factions).toBeUndefined();
    expect(world.playerState?.augmentations).toBeUndefined();
    expect(world.playerState?.queuedAugmentations).toBeUndefined();
    expect(world.playerState?.sourceFiles).toBeUndefined();
    expect(isSeededVanillaNetwork(world.network, world.topology)).toBe(true);
    expect(isSeededVanillaNetwork(world.network?.slice(1), world.topology)).toBe(false);
  });

  test("a later leg keeps the same population while carrying earned state", () => {
    // The entrance grows down the route; the world it is measured on must
    // not, or leg timings stop being comparable with each other.
    const profile = findProfile("leg-bn1.1");
    expect(profile.world?.network).toEqual(VANILLA_NETWORK.network);
    expect(profile.world?.topology).toEqual(VANILLA_NETWORK.topology);
    expect(profile.world?.playerState?.sourceFiles).toEqual({ "4": 3 });
  });
});
