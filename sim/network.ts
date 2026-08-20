import type { ServerSpec } from "./core/effects.ts";
import { mulberry32 } from "./core/rng.ts";
import {
  SERVER_METADATA,
  type Range,
  type VendoredServer,
} from "./vendor/bitburner/src/Server/data/ServerMetadata.ts";

export interface GeneratedNetwork {
  homeIp: string;
  network: ServerSpec[];
  topology: Record<string, string[]>;
}

/** The v3.0.1 darkweb root is created after the ordinary foreign-server tree.
 * It exists before TOR is bought, but remains isolated until getTorRouter()
 * connects it to home.
 *
 * `initDarkwebServer()` makes it a special case in every way that matters: 16 GB
 * with `blockedRam = 0` and `preventBlockedRam`, `hasAdminRights = true`,
 * `isStationary = true`, `depth: -1`, and `modelId: NoPassword` with an empty
 * password. Both the session check and the exec/scp gate short-circuit for it
 * ("We always are authed to ourselves and DarkWeb"), so it is the one darknet
 * host a script can be placed on with no credential at all.
 *
 * Being rooted is inert for the fleet — scan hides darknet servers — but it is
 * what lets ns.exec target it, so it must not be left at mockServer's default.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/DarkNet/controllers/NetworkGenerator.ts#L52-L89 */
export function darkwebServerSpec(ip?: string): ServerSpec {
  return {
    hostname: "darkweb",
    ...(ip !== undefined ? { ip } : {}),
    organizationName: "",
    hackDifficulty: 0,
    moneyAvailable: 0,
    requiredHackingSkill: 0,
    serverGrowth: 0,
    numOpenPortsRequired: 0,
    maxRam: 16,
    hasAdminRights: true,
    simKind: "DarknetServer",
  };
}

/** Synthetic fixtures still model the always-present darkweb root. Generated
 * vanilla worlds already include it with their authoritative rolled IP. */
export function withDarkwebServer(network: readonly ServerSpec[]): ServerSpec[] {
  return network.some((server) => server.hostname === "darkweb")
    ? [...network]
    : [...network, darkwebServerSpec()];
}

/** Dedicated world-generation seed for the full BN1 benchmark. Gameplay
 * seeds deliberately do not change the target population: seed-to-seed A/B
 * variance then measures the strategy, not a different set of servers. */
export const VANILLA_NETWORK_SEED = 0xb17b_0301;

function randomInt(rng: () => number, [min, max]: Range): number {
  return Math.floor(rng() * (max - min + 1) + min);
}

function rolledValue(
  rng: () => number,
  metadata: VendoredServer,
  field: keyof VendoredServer["randomized"],
  range: Range | undefined,
  fallback: number,
): number {
  if (!range) return fallback;
  return metadata.randomized[field] ? randomInt(rng, range) : range[0];
}

function truthyMetadataValue(
  rng: () => number,
  metadata: VendoredServer,
  field: keyof VendoredServer["randomized"],
  range: Range | undefined,
  fallback: number,
): number {
  if (!range) return fallback;
  if (metadata.randomized[field]) return randomInt(rng, range);
  return range[0] ? range[0] : fallback;
}

/** Build the standard v3.0.1 foreign-server population using the same roll
 * order and layer-parent algorithm as ServerHelpers.initForeignServers().
 * IP values are irrelevant to Netscript here, but their random draws are
 * consumed because upstream creates an IP before rolling each server's stats. */
export function generateVanillaNetwork(seed: number): GeneratedNetwork {
  return generateInitialVanillaNetworkFromRng(mulberry32(seed));
}

function randomIp(rng: () => number): string {
  const encoded = rng().toString(16) + "000000000";
  return (encoded.match(/..?/g) ?? []).slice(1, 5).map((part) => parseInt(part, 16)).join(".");
}

/** Player.init creates home before initForeignServers, consuming one IP draw
 * that an augmentation prestige does not repeat. */
export function generateInitialVanillaNetworkFromRng(rng: () => number): GeneratedNetwork {
  const homeIp = randomIp(rng);
  return generateVanillaNetworkFromRng(rng, homeIp);
}

/** Stateful form used across augmentation prestiges. Upstream consumes the
 * same world-generation RNG stream each time it recreates foreign servers;
 * accepting the stream makes the successive worlds distinct without
 * inventing per-install seed arithmetic. */
export function generateVanillaNetworkFromRng(rng: () => number, homeIp = ""): GeneratedNetwork {
  const ips = new Set<string>(homeIp ? [homeIp] : []);
  const network: ServerSpec[] = [];
  const layers: string[][] = Array.from({ length: 15 }, () => []);

  for (const metadata of Object.values(SERVER_METADATA)) {
    let ip: string;
    do {
      ip = randomIp(rng);
    } while (ips.has(ip));
    ips.add(ip);

    const ramExponent = rolledValue(rng, metadata, "ramExp", metadata.ramExp, -Infinity);
    const hackDifficulty = truthyMetadataValue(rng, metadata, "sec", metadata.sec, 1);
    const moneyAvailable = rolledValue(rng, metadata, "money", metadata.money, 0);
    const requiredHackingSkill = rolledValue(rng, metadata, "skill", metadata.skill, 1);
    const serverGrowth = truthyMetadataValue(rng, metadata, "growth", metadata.growth, 1);
    const server: ServerSpec = {
      hostname: metadata.host,
      ip,
      organizationName: metadata.org,
      hackDifficulty,
      moneyAvailable,
      requiredHackingSkill,
      serverGrowth,
      numOpenPortsRequired: metadata.ports,
      maxRam: Math.pow(2, ramExponent),
    };
    const layer = rolledValue(rng, metadata, "layer", metadata.layer, 0);
    server.cpuCores = layer > 0
      ? Math.floor(rng() * (layer - Math.ceil(layer / 2) + 1) + Math.ceil(layer / 2))
      : 1;
    network.push(server);
    const topologyLayer = rolledValue(rng, metadata, "layer", metadata.layer, 0);
    if (topologyLayer > 0) layers[topologyLayer - 1]!.push(server.hostname);
  }

  const topology: Record<string, string[]> = Object.fromEntries([
    ["home", []],
    ...network.map((server) => [server.hostname, []]),
  ]);
  const connect = (a: string, b: string): void => {
    topology[a]!.push(b);
    topology[b]!.push(a);
  };
  for (const host of layers[0]!) connect(host, "home");
  for (let layer = 1; layer < layers.length; layer++) {
    const parents = layers[layer - 1]!;
    for (const host of layers[layer]!) connect(host, parents[Math.floor(rng() * parents.length)]!);
  }
  let darkwebIp: string;
  do {
    darkwebIp = randomIp(rng);
  } while (ips.has(darkwebIp));
  network.push(darkwebServerSpec(darkwebIp));
  topology["darkweb"] = [];
  return { homeIp, network, topology };
}

export const VANILLA_NETWORK = generateVanillaNetwork(VANILLA_NETWORK_SEED);

/** Structural classifier for run metadata. It intentionally requires both the
 * complete host population and exact fixed topology; a synthetic fixture that
 * merely reuses one vanilla hostname must never be labeled vanilla. */
export function isSeededVanillaNetwork(
  network: readonly ServerSpec[] | undefined,
  topology: Readonly<Record<string, readonly string[]>> | undefined,
): boolean {
  if (!network || !topology || network.length !== VANILLA_NETWORK.network.length) return false;
  const actualHosts = network.map((server) => server.hostname).sort();
  const expectedHosts = VANILLA_NETWORK.network.map((server) => server.hostname).sort();
  if (actualHosts.some((host, index) => host !== expectedHosts[index])) return false;
  const actualTopologyHosts = Object.keys(topology).sort();
  const expectedTopologyHosts = Object.keys(VANILLA_NETWORK.topology).sort();
  if (
    actualTopologyHosts.length !== expectedTopologyHosts.length
    || actualTopologyHosts.some((host, index) => host !== expectedTopologyHosts[index])
  ) return false;
  return expectedTopologyHosts.every((host) => {
    const actual = [...(topology[host] ?? [])].sort();
    const expected = [...(VANILLA_NETWORK.topology[host] ?? [])].sort();
    return actual.length === expected.length && actual.every((neighbour, index) => neighbour === expected[index]);
  });
}

/** Early-game target set for the v1 simulator. Base values copied verbatim
 * from bitburner-src v3.0.1 src/Server/data/servers.ts (maxRam = 2^maxRamExponent);
 * live fields are derived from these via serverFromSpec exactly like the
 * game's Server constructor. The special backdoor targets retain their real
 * port requirements so the controller must acquire the actual programs. */
export const DEFAULT_NETWORK: ServerSpec[] = [
  { hostname: "n00dles", organizationName: "Noodle Bar", hackDifficulty: 1, moneyAvailable: 70_000, requiredHackingSkill: 1, serverGrowth: 3000, numOpenPortsRequired: 0, maxRam: 4 },
  { hostname: "foodnstuff", organizationName: "FoodNStuff", hackDifficulty: 10, moneyAvailable: 2_000_000, requiredHackingSkill: 1, serverGrowth: 5, numOpenPortsRequired: 0, maxRam: 16 },
  { hostname: "sigma-cosmetics", organizationName: "Sigma Cosmetics", hackDifficulty: 10, moneyAvailable: 2_300_000, requiredHackingSkill: 5, serverGrowth: 10, numOpenPortsRequired: 0, maxRam: 16 },
  { hostname: "joesguns", organizationName: "Joe's Guns", hackDifficulty: 15, moneyAvailable: 2_500_000, requiredHackingSkill: 10, serverGrowth: 20, numOpenPortsRequired: 0, maxRam: 16 },
  { hostname: "hong-fang-tea", organizationName: "HongFang Teahouse", hackDifficulty: 15, moneyAvailable: 3_000_000, requiredHackingSkill: 30, serverGrowth: 20, numOpenPortsRequired: 0, maxRam: 16 },
  { hostname: "harakiri-sushi", organizationName: "HaraKiri Sushi Bar Network", hackDifficulty: 15, moneyAvailable: 4_000_000, requiredHackingSkill: 40, serverGrowth: 40, numOpenPortsRequired: 0, maxRam: 16 },

  // The two faction backdoor servers. They hold no money and are never worth
  // hacking — they exist so `backdoorInstalled` is REACHABLE, which is what
  // makes CyberSec and NiteSec joinable at all. Without them a faction run has
  // no path to its first invitation and the whole slice is unmeasurable.
  //
  // requiredHackingSkill is a min/max range upstream (CSEC 51-60, avmnite
  // 202-220); the midpoint is used, and `numOpenPortsRequired` is real — CSEC
  // needs one port opener, which the fleet must actually acquire.
  { hostname: "CSEC", hackDifficulty: 0, moneyAvailable: 0, requiredHackingSkill: 55, serverGrowth: 0, numOpenPortsRequired: 1, maxRam: 8 },
  { hostname: "avmnite-02h", hackDifficulty: 0, moneyAvailable: 0, requiredHackingSkill: 211, serverGrowth: 0, numOpenPortsRequired: 2, maxRam: 32 },
];
