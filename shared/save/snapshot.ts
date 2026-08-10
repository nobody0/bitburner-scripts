/** The normalised shape of a Bitburner save.
 *
 * Deliberately not the game's shape. A save is a serialised object graph with
 * class wrappers, sparse keys, two Map encodings and several fields that are
 * derived rather than stored; a snapshot is the flat subset that seeding a
 * simulation actually needs, with every default already applied.
 * Sources: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/SaveObject.ts#L191-L230 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/utils/JSONReviver.ts#L24-L43 */

export interface SaveServer {
  hostname: string;
  organizationName: string;
  programs: string[];
  messages: string[];
  /** Coding-contract filenames present on this server. */
  contracts: string[];
  hasAdminRights: boolean;
  backdoorInstalled: boolean;
  purchasedByPlayer: boolean;
  maxRam: number;
  /** NOT stored in the save — recomputed from the running-script list.
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/BaseServer.ts#L293-L323 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/BaseServer.ts#L381-L384 */
  ramUsed: number;
  cpuCores: number;
  moneyAvailable: number;
  moneyMax: number;
  hackDifficulty: number;
  minDifficulty: number;
  baseDifficulty: number;
  requiredHackingSkill: number;
  serverGrowth: number;
  numOpenPortsRequired: number;
  openPortCount: number;
  serversOnNetwork: string[];
  /** "Server" | "HacknetServer" | "DarknetServer" */
  kind: string;
  /** HacknetServer-only state. */
  hacknetLevel?: number;
  hacknetCache?: number;
  hacknetTotalProduction?: number;
  hacknetOnlineTimeSeconds?: number;
}

export interface SaveHacknetNode {
  /** Present for Hacknet Servers; absent for ordinary Hacknet Nodes. */
  hostname?: string;
  level: number;
  ram: number;
  cores: number;
  totalProduction: number;
  onlineTimeSeconds: number;
  cache?: number;
}

export interface SaveFactionStanding {
  favor?: number;
  playerReputation?: number;
  discovery?: string;
}

export interface SavePlayer {
  money: number;
  karma: number;
  entropy: number;
  city: string;
  location: string;
  skills: Record<string, number>;
  exp: Record<string, number>;
  mults: Record<string, number>;
  hp: { current: number; max: number };
  augmentations: { name: string; level: number }[];
  queuedAugmentations: { name: string; level: number }[];
  factions: string[];
  /** Pending invitations. Distinct from `factions` and NOT derivable from it:
   *  an invitation is revoked by joining an enemy, so a planner that treated
   *  "not joined" as "invitable" would commit to a faction set the save can no
   *  longer reach.
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L29-L51 */
  factionInvitations: string[];
  numPeopleKilled: number;
  jobs: Record<string, string>;
  hasWseAccount: boolean;
  hasTixApiAccess: boolean;
  has4SData: boolean;
  has4SDataTixApi: boolean;
  hasGang: boolean;
  hasCorporation: boolean;
  hasBladeburner: boolean;
  bladeburnerRank?: number;
  sleeveCount: number;
  playtimeSinceLastAug: number;
  playtimeSinceLastBitnode: number;
  totalPlaytime: number;
  focus: boolean;
  hacknetNodes: (string | SaveHacknetNode)[];
  hashes: number;
  hashUpgrades: Record<string, number>;
  /** Serialized Player.currentWork, normalized without importing game work
   * classes. Unknown kinds are retained so the simulator can invalidate the
   * run instead of silently starting idle. */
  currentWork?: SaveCurrentWork;
  gangFaction?: string;
}

export interface SaveCurrentWork {
  kind: "faction" | "crime" | "graft" | "company" | "class" | "createProgram" | "unknown";
  subject: string;
  workType?: string;
  cyclesWorked: number;
  /** Crime/grafting progress is stored in milliseconds, not cycles. */
  unitCompleted?: number;
  ctor: string;
}

export interface SaveStockMarket {
  stocks: Record<string, Record<string, string | number | boolean>>;
  storedCycles: number;
  ticksUntilCycle: number;
  hasOrders: boolean;
}

export interface SaveBitNodeOptions {
  sourceFileOverrides: Record<string, number>;
  intelligenceOverride: number | undefined;
  restrictHomePCUpgrade: boolean;
  disableGang: boolean;
  disableCorporation: boolean;
  disableBladeburner: boolean;
  disable4SData: boolean;
  disableHacknetServer: boolean;
  disableSleeveExpAndAugmentation: boolean;
}

export interface SaveSnapshot {
  /** CONSTANTS.VersionNumber the save was written by (51 at v3.0.1).
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Constants.ts#L6-L10 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/SaveObject.ts#L217-L224 */
  version: number | undefined;
  bitNode: number;
  /** As stored. */
  sourceFiles: Record<string, number>;
  /** sourceFiles merged with bitNodeOptions.sourceFileOverrides — what the
   *  game actually plays with, and what ns.getResetInfo().ownedSF reports.
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObject.ts#L81-L95 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1486-L1500 */
  activeSourceFiles: Record<string, number>;
  bitNodeOptions: SaveBitNodeOptions;
  player: SavePlayer;
  /** Keyed by hostname. A Map, never an object: "__proto__" is a legitimate
   *  hostname in the game's own test corpus.
   * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/test/jest/Save.test.ts#L20-L29 */
  servers: Map<string, SaveServer>;
  factions: Record<string, SaveFactionStanding>;
  companies: Record<string, SaveFactionStanding>;
  stockMarket?: SaveStockMarket;
}

/** Absent keys mean "class default", not undefined: Generic_toJSON prunes via
 * getKeyList, so a v3.0.1 save legitimately omits most server fields. Getting
 * these wrong is the single biggest source of quiet divergence, so they live
 * in one table.
 *
 * Sources: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/BaseServer.ts#L44-L125
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/Server.ts#L26-L57
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/BaseServer.ts#L381-L384 */
export const SERVER_DEFAULTS: Omit<SaveServer, "hostname"> = {
  organizationName: "",
  programs: [],
  messages: [],
  contracts: [],
  hasAdminRights: false,
  backdoorInstalled: false,
  purchasedByPlayer: false,
  maxRam: 0,
  ramUsed: 0,
  cpuCores: 1,
  moneyAvailable: 0,
  moneyMax: 0,
  hackDifficulty: 1,
  minDifficulty: 1,
  baseDifficulty: 1,
  requiredHackingSkill: 1,
  serverGrowth: 1,
  numOpenPortsRequired: 5,
  openPortCount: 0,
  serversOnNetwork: [],
  kind: "Server",
};

export const SKILL_NAMES = [
  "hacking",
  "strength",
  "defense",
  "dexterity",
  "agility",
  "charisma",
  "intelligence",
] as const;
