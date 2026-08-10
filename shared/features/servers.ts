import type { Server } from "@ns";

/** Base ranges for every generated server, transcribed from
 * `bitburner-src v3.0.1 src/Server/data/servers.ts`.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/data/servers.ts
 *
 * The network is NOT fixed. Upstream declares most fields as `{min, max}` and
 * rolls each one once at world generation (`ServerHelpers.toNumber` ->
 * `getRandomIntInclusive`), so ecorp holds somewhere between $30b and $70b of
 * base money in one save and a different amount in the next. Nothing in the
 * game surfaces the range, which makes a live value uninterpretable on its
 * own: is 1,198 required hacking skill on megacorp a good roll or a bad one?
 *
 * Lives here rather than being read from the vendored copy because `ui/` may
 * not import `sim/` (tests/boundaries.test.ts). Pinned field-by-field against
 * that copy by `sim/tests/servers-parity.test.ts`; after a vendor bump, a
 * failure there is the signal to update this table, not a regression. */

/** An upstream `{min, max}`, or a fixed value as a degenerate range. */
export type Range = readonly [number, number];

export interface ServerRanges {
  /** BASE money, before the 25x and the BitNode multiplier — see rolledMoney. */
  money?: Range;
  skill?: Range;
  /** BASE security, before ServerStartingSecurity — see rolledSecurity. */
  sec?: Range;
  growth?: Range;
  /** Exponent: maxRam is 2^this. */
  ramExp?: Range;
  ports: number;
}

export const SERVER_RANGES: Readonly<Record<string, ServerRanges>> = {
  "ecorp": { money: [30000000000, 70000000000], skill: [1050, 1400], sec: [99, 99], growth: [99, 99], ports: 5 },
  "megacorp": { money: [40000000000, 60000000000], skill: [1100, 1350], sec: [99, 99], growth: [99, 99], ports: 5 },
  "b-and-a": { money: [15000000000, 30000000000], skill: [900, 1150], sec: [72, 88], growth: [60, 80], ports: 5 },
  "blade": { money: [10000000000, 40000000000], skill: [900, 1200], sec: [88, 97], growth: [55, 85], ramExp: [5, 9], ports: 5 },
  "nwo": { money: [20000000000, 40000000000], skill: [950, 1300], sec: [99, 99], growth: [65, 95], ports: 5 },
  "clarkinc": { money: [15000000000, 25000000000], skill: [950, 1250], sec: [45, 65], growth: [45, 75], ports: 5 },
  "omnitek": { money: [13000000000, 22000000000], skill: [900, 1100], sec: [90, 99], growth: [95, 99], ramExp: [7, 9], ports: 5 },
  "4sigma": { money: [15000000000, 25000000000], skill: [900, 1250], sec: [55, 75], growth: [75, 99], ports: 5 },
  "kuai-gong": { money: [20000000000, 30000000000], skill: [950, 1300], sec: [95, 99], growth: [90, 99], ports: 5 },
  "fulcrumtech": { money: [1400000000, 1800000000], skill: [950, 1250], sec: [83, 97], growth: [80, 99], ramExp: [7, 11], ports: 5 },
  "fulcrumassets": { money: [1000000, 1000000], skill: [1100, 1600], sec: [99, 99], growth: [1, 1], ports: 5 },
  "stormtech": { money: [1000000000, 1200000000], skill: [875, 1075], sec: [78, 92], growth: [68, 92], ports: 5 },
  "defcomm": { money: [800000000, 950000000], skill: [850, 1050], sec: [84, 96], growth: [47, 73], ports: 5 },
  "infocomm": { money: [600000000, 900000000], skill: [875, 950], sec: [70, 90], growth: [35, 75], ports: 5 },
  "helios": { money: [550000000, 750000000], skill: [800, 900], sec: [85, 95], growth: [70, 80], ramExp: [5, 8], ports: 5 },
  "vitalife": { money: [700000000, 800000000], skill: [775, 900], sec: [80, 90], growth: [60, 80], ramExp: [4, 7], ports: 5 },
  "icarus": { money: [900000000, 1000000000], skill: [850, 925], sec: [85, 95], growth: [85, 95], ports: 5 },
  "univ-energy": { money: [1100000000, 1200000000], skill: [800, 900], sec: [80, 90], growth: [80, 90], ramExp: [4, 7], ports: 4 },
  "titan-labs": { money: [750000000, 900000000], skill: [800, 875], sec: [70, 80], growth: [60, 80], ramExp: [4, 7], ports: 5 },
  "microdyne": { money: [500000000, 700000000], skill: [800, 875], sec: [65, 75], growth: [70, 90], ramExp: [4, 6], ports: 5 },
  "taiyang-digital": { money: [800000000, 900000000], skill: [850, 950], sec: [70, 80], growth: [70, 80], ports: 5 },
  "galactic-cyber": { money: [750000000, 850000000], skill: [825, 875], sec: [55, 65], growth: [70, 90], ports: 5 },
  "aerocorp": { money: [1000000000, 1200000000], skill: [850, 925], sec: [80, 90], growth: [55, 65], ports: 5 },
  "omnia": { money: [900000000, 1000000000], skill: [850, 950], sec: [85, 95], growth: [60, 70], ramExp: [4, 6], ports: 5 },
  "zb-def": { money: [900000000, 1100000000], skill: [775, 825], sec: [55, 65], growth: [65, 75], ports: 4 },
  "applied-energetics": { money: [700000000, 1000000000], skill: [775, 850], sec: [60, 80], growth: [70, 75], ports: 4 },
  "solaris": { money: [700000000, 900000000], skill: [750, 850], sec: [70, 80], growth: [70, 80], ramExp: [4, 7], ports: 5 },
  "deltaone": { money: [1300000000, 1700000000], skill: [800, 900], sec: [75, 85], growth: [50, 70], ports: 5 },
  "global-pharm": { money: [1500000000, 1750000000], skill: [750, 850], sec: [75, 85], growth: [80, 90], ramExp: [3, 6], ports: 4 },
  "nova-med": { money: [1100000000, 1250000000], skill: [775, 850], sec: [60, 80], growth: [65, 85], ports: 4 },
  "zeus-med": { money: [1300000000, 1500000000], skill: [800, 850], sec: [70, 90], growth: [70, 80], ports: 5 },
  "unitalife": { money: [1000000000, 1100000000], skill: [775, 825], sec: [70, 80], growth: [70, 80], ramExp: [4, 6], ports: 4 },
  "lexo-corp": { money: [700000000, 800000000], skill: [650, 750], sec: [60, 80], growth: [55, 65], ramExp: [4, 7], ports: 4 },
  "rho-construction": { money: [500000000, 700000000], skill: [475, 525], sec: [40, 60], growth: [40, 60], ramExp: [4, 6], ports: 3 },
  "alpha-ent": { money: [600000000, 750000000], skill: [500, 600], sec: [50, 70], growth: [50, 60], ramExp: [4, 7], ports: 4 },
  "aevum-police": { money: [200000000, 400000000], skill: [400, 450], sec: [70, 80], growth: [30, 50], ramExp: [4, 6], ports: 4 },
  "rothman-uni": { money: [175000000, 250000000], skill: [370, 430], sec: [45, 55], growth: [35, 45], ramExp: [4, 7], ports: 3 },
  "zb-institute": { money: [800000000, 1100000000], skill: [725, 775], sec: [65, 85], growth: [75, 85], ramExp: [4, 7], ports: 5 },
  "summit-uni": { money: [200000000, 350000000], skill: [425, 475], sec: [45, 65], growth: [40, 60], ramExp: [4, 6], ports: 3 },
  "syscore": { money: [400000000, 600000000], skill: [550, 650], sec: [60, 80], growth: [60, 70], ports: 4 },
  "catalyst": { money: [300000000, 550000000], skill: [400, 450], sec: [60, 70], growth: [25, 55], ramExp: [4, 7], ports: 3 },
  "the-hub": { money: [150000000, 200000000], skill: [275, 325], sec: [35, 45], growth: [45, 55], ramExp: [3, 6], ports: 2 },
  "computek": { money: [220000000, 250000000], skill: [300, 400], sec: [55, 65], growth: [45, 65], ports: 3 },
  "netlink": { money: [275000000, 275000000], skill: [375, 425], sec: [60, 80], growth: [45, 75], ramExp: [4, 7], ports: 3 },
  "johnson-ortho": { money: [70000000, 85000000], skill: [250, 300], sec: [35, 65], growth: [35, 65], ports: 2 },
  "n00dles": { money: [70000, 70000], skill: [1, 1], sec: [1, 1], growth: [3000, 3000], ramExp: [2, 2], ports: 0 },
  "foodnstuff": { money: [2000000, 2000000], skill: [1, 1], sec: [10, 10], growth: [5, 5], ramExp: [4, 4], ports: 0 },
  "sigma-cosmetics": { money: [2300000, 2300000], skill: [5, 5], sec: [10, 10], growth: [10, 10], ramExp: [4, 4], ports: 0 },
  "joesguns": { money: [2500000, 2500000], skill: [10, 10], sec: [15, 15], growth: [20, 20], ramExp: [4, 4], ports: 0 },
  "zer0": { money: [7500000, 7500000], skill: [75, 75], sec: [25, 25], growth: [40, 40], ramExp: [5, 5], ports: 1 },
  "nectar-net": { money: [2750000, 2750000], skill: [20, 20], sec: [20, 20], growth: [25, 25], ramExp: [4, 4], ports: 0 },
  "neo-net": { money: [5000000, 5000000], skill: [50, 50], sec: [25, 25], growth: [25, 25], ramExp: [5, 5], ports: 1 },
  "silver-helix": { money: [45000000, 45000000], skill: [150, 150], sec: [30, 30], growth: [30, 30], ramExp: [6, 6], ports: 2 },
  "hong-fang-tea": { money: [3000000, 3000000], skill: [30, 30], sec: [15, 15], growth: [20, 20], ramExp: [4, 4], ports: 0 },
  "harakiri-sushi": { money: [4000000, 4000000], skill: [40, 40], sec: [15, 15], growth: [40, 40], ramExp: [4, 4], ports: 0 },
  "phantasy": { money: [24000000, 24000000], skill: [100, 100], sec: [20, 20], growth: [35, 35], ramExp: [5, 5], ports: 2 },
  "max-hardware": { money: [10000000, 10000000], skill: [80, 80], sec: [15, 15], growth: [30, 30], ramExp: [5, 5], ports: 1 },
  "omega-net": { money: [60000000, 70000000], skill: [180, 220], sec: [25, 35], growth: [30, 40], ramExp: [5, 5], ports: 2 },
  "crush-fitness": { money: [40000000, 60000000], skill: [225, 275], sec: [35, 45], growth: [27, 33], ports: 2 },
  "iron-gym": { money: [20000000, 20000000], skill: [100, 100], sec: [30, 30], growth: [20, 20], ramExp: [5, 5], ports: 1 },
  "millenium-fitness": { money: [250000000, 250000000], skill: [475, 525], sec: [45, 55], growth: [25, 45], ramExp: [4, 8], ports: 3 },
  "powerhouse-fitness": { money: [900000000, 900000000], skill: [950, 1100], sec: [55, 65], growth: [50, 60], ramExp: [4, 6], ports: 5 },
  "snap-fitness": { money: [450000000, 450000000], skill: [675, 800], sec: [40, 60], growth: [40, 60], ports: 4 },
  "run4theh111z": { money: [0, 0], skill: [505, 550], sec: [0, 0], growth: [0, 0], ramExp: [5, 9], ports: 4 },
  "I.I.I.I": { money: [0, 0], skill: [340, 365], sec: [0, 0], growth: [0, 0], ramExp: [4, 8], ports: 3 },
  "avmnite-02h": { money: [0, 0], skill: [202, 220], sec: [0, 0], growth: [0, 0], ramExp: [4, 7], ports: 2 },
  ".": { money: [0, 0], skill: [505, 550], sec: [0, 0], growth: [0, 0], ramExp: [4, 4], ports: 4 },
  "CSEC": { money: [0, 0], skill: [51, 60], sec: [0, 0], growth: [0, 0], ramExp: [3, 3], ports: 1 },
  "The-Cave": { money: [0, 0], skill: [925, 925], sec: [0, 0], growth: [0, 0], ports: 5 },
  "w0r1d_d43m0n": { money: [0, 0], skill: [3000, 3000], sec: [0, 0], growth: [0, 0], ports: 5 },
};

export function serverRanges(host: string): ServerRanges | undefined {
  return SERVER_RANGES[host];
}

/** Where a rolled value sits in its range, in [0, 1].
 *
 * `undefined` for a fixed field: n00dles is $70,000 in every save, and
 * reporting that as "p100" or "p0" would invent a distinction the game does
 * not make. */
export function rollPercentile(value: number, range: Range | undefined): number | undefined {
  if (!range) return undefined;
  const [min, max] = range;
  if (!(max > min)) return undefined;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** Recover the base money roll from a live `moneyMax`.
 *
 * `Server.ts` v3.0.1: `moneyMax = 25 * baseMoney * ServerMaxMoney`. Both
 * factors have to be undone or the comparison is off by more than an order of
 * magnitude — a BN12 megacorp reads $720b against a documented $40-60b range,
 * which looks like the table is wrong rather than like a 25x and a 0.7x. */
// Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/Server.ts
export function rolledMoney(moneyMax: number | undefined, serverMaxMoneyMult = 1): number | undefined {
  if (moneyMax === undefined || !(serverMaxMoneyMult > 0)) return undefined;
  return moneyMax / (25 * serverMaxMoneyMult);
}

/** Recover the base security roll from a live `hackDifficulty` baseline.
 *
 * `Server.ts` v3.0.1 sets `hackDifficulty = min(roll * ServerStartingSecurity,
 * 100)`, so a server whose scaled security clipped at 100 cannot be inverted —
 * hence `undefined` rather than a wrong answer. */
// Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/Server.ts
export function rolledSecurity(baseDifficulty: number | undefined, startingSecurityMult = 1): number | undefined {
  if (baseDifficulty === undefined || !(startingSecurityMult > 0)) return undefined;
  if (baseDifficulty >= 100) return undefined;
  return baseDifficulty / startingSecurityMult;
}

/** Whether a server can be rooted now, later, or not at all in this run.
 *
 * The three cases the hacking panel colours by: we already own it, we have the
 * skill and the port openers to take it, or something is still missing. */
export type RootState = "rooted" | "ready" | "blocked";

export function rootState(server: Server, hackingSkill: number, portOpeners: number): RootState {
  if (server.hasAdminRights) return "rooted";
  const skillOk = (server.requiredHackingSkill ?? 0) <= hackingSkill;
  const portsOk = (server.numOpenPortsRequired ?? 0) <= portOpeners;
  return skillOk && portsOk ? "ready" : "blocked";
}
