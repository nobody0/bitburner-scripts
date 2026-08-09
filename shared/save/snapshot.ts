/** The normalised shape of a Bitburner save.
 *
 * Deliberately not the game's shape. A save is a serialised object graph with
 * class wrappers, sparse keys, two Map encodings and several fields that are
 * derived rather than stored; a snapshot is the flat subset that seeding a
 * simulation actually needs, with every default already applied. */

export interface SaveServer {
  hostname: string;
  organizationName: string;
  hasAdminRights: boolean;
  backdoorInstalled: boolean;
  purchasedByPlayer: boolean;
  maxRam: number;
  /** NOT stored in the save — recomputed from the running-script list. */
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
   *  longer reach. */
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
  sleeveCount: number;
  playtimeSinceLastBitnode: number;
  totalPlaytime: number;
  hacknetNodes: (string | SaveHacknetNode)[];
  hashes: number;
  hashUpgrades: Record<string, number>;
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
  /** CONSTANTS.VersionNumber the save was written by (51 at v3.0.1). */
  version: number | undefined;
  bitNode: number;
  /** As stored. */
  sourceFiles: Record<string, number>;
  /** sourceFiles merged with bitNodeOptions.sourceFileOverrides — what the
   *  game actually plays with, and what ns.getResetInfo().ownedSF reports. */
  activeSourceFiles: Record<string, number>;
  bitNodeOptions: SaveBitNodeOptions;
  player: SavePlayer;
  /** Keyed by hostname. A Map, never an object: "__proto__" is a legitimate
   *  hostname in the game's own test corpus. */
  servers: Map<string, SaveServer>;
  factions: Record<string, SaveFactionStanding>;
  companies: Record<string, SaveFactionStanding>;
}

/** Absent keys mean "class default", not undefined: Generic_toJSON prunes via
 * getKeyList, so a v3.0.1 save legitimately omits most server fields. Getting
 * these wrong is the single biggest source of quiet divergence, so they live
 * in one table.
 *
 * Source: bitburner-src/src/Server/BaseServer.ts and Server.ts @ v3.0.1. */
export const SERVER_DEFAULTS: Omit<SaveServer, "hostname"> = {
  organizationName: "",
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
  numOpenPortsRequired: 0,
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
