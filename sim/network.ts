import type { ServerSpec } from "./core/effects.ts";

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
