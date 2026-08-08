import type { ServerSpec } from "./core/effects.ts";

/** Early-game target set for the v1 simulator. Base values copied verbatim
 * from bitburner-src v3.0.1 src/Server/data/servers.ts (maxRam = 2^maxRamExponent);
 * live fields are derived from these via serverFromSpec exactly like the
 * game's Server constructor. All 0-port servers — port-opener modeling is a
 * later fidelity step (spec/simulator.md). */
export const DEFAULT_NETWORK: ServerSpec[] = [
  { hostname: "n00dles", hackDifficulty: 1, moneyAvailable: 70_000, requiredHackingSkill: 1, serverGrowth: 3000, numOpenPortsRequired: 0, maxRam: 4 },
  { hostname: "foodnstuff", hackDifficulty: 10, moneyAvailable: 2_000_000, requiredHackingSkill: 1, serverGrowth: 5, numOpenPortsRequired: 0, maxRam: 16 },
  { hostname: "sigma-cosmetics", hackDifficulty: 10, moneyAvailable: 2_300_000, requiredHackingSkill: 5, serverGrowth: 10, numOpenPortsRequired: 0, maxRam: 16 },
  { hostname: "joesguns", hackDifficulty: 15, moneyAvailable: 2_500_000, requiredHackingSkill: 10, serverGrowth: 20, numOpenPortsRequired: 0, maxRam: 16 },
  { hostname: "hong-fang-tea", hackDifficulty: 15, moneyAvailable: 3_000_000, requiredHackingSkill: 30, serverGrowth: 20, numOpenPortsRequired: 0, maxRam: 16 },
  { hostname: "harakiri-sushi", hackDifficulty: 15, moneyAvailable: 4_000_000, requiredHackingSkill: 40, serverGrowth: 40, numOpenPortsRequired: 0, maxRam: 16 },

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
