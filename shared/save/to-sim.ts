import { sfLevel } from "../features/unlock.ts";
import type { SaveSnapshot, SaveServer, SaveStockMarket, SaveCurrentWork } from "./snapshot.ts";

/** Turn a save snapshot into simulator initial conditions.
 *
 * A save carries LIVE server state — money already grown, security already
 * weakened, RAM already bought — so this cannot go through
 * sim/core/effects.ts serverFromSpec, which derives live fields from base
 * metadata. The servers are injected whole instead. */

export interface SaveSeedServer {
  hostname: string;
  ip: string;
  organizationName: string;
  hasAdminRights: boolean;
  isConnectedTo: boolean;
  purchasedByPlayer: boolean;
  backdoorInstalled: boolean;
  maxRam: number;
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
  sshPortOpen: boolean;
  ftpPortOpen: boolean;
  smtpPortOpen: boolean;
  httpPortOpen: boolean;
  sqlPortOpen: boolean;
  isHacknetServer?: boolean;
  simKind?: "Server" | "HacknetServer" | "DarknetServer";
  contractFiles: string[];
}

export interface SaveSeedHacknetNode {
  hostname?: string;
  level: number;
  ram: number;
  cores: number;
  totalProduction: number;
  onlineTimeSeconds: number;
  cache?: number;
}

export interface SaveSeed {
  /** Save schema pinned to the vendored game source. */
  version: number;
  bitnode: number;
  /** Active SF level for the CURRENT node — what the RAM cost multiplier and
   *  the capability gates key off. */
  sourceFileLevel: number;
  sourceFiles: Record<string, number>;
  /** Reset ages are mapped onto the simulator's deterministic epoch. */
  playtimeSinceLastAug: number;
  playtimeSinceLastBitnode: number;
  totalPlaytime: number;
  sleeveCount: number;
  companies: Record<string, { rep: number; favor: number }>;
  bladeburnerRank?: number;
  homeFiles: string[];
  /** TOR ownership is represented upstream by home's edge to `darkweb`, not
   * by a Player boolean. Preserve it before darknet servers are filtered. */
  hasTor: boolean;
  bitNodeOptions: SaveSnapshot["bitNodeOptions"];
  homeRam: number;
  homeCores: number;
  startingMoney: number;
  currentServer: string;
  servers: SaveSeedServer[];
  /** hostname -> neighbours, from the save's own topology. */
  topology: Record<string, string[]>;
  person: {
    skills: Record<string, number>;
    exp: Record<string, number>;
    mults: Record<string, number>;
    hp: { current: number; max: number };
  };
  /** The non-Person half: karma, kills, joined factions, augmentations, jobs.
   *  Without this a save-seeded run starts at karma 0 with no factions, which
   *  silently makes every criminal faction unreachable and every karma need
   *  look freshly blocking. */
  playerState: {
    money: number;
    karma: number;
    entropy: number;
    exploits: string[];
    persistentIntelligenceExp: number;
    numPeopleKilled: number;
    city: string;
    location: string;
    jobs: Record<string, string>;
    factions: string[];
    factionInvitations: string[];
    augmentations: { name: string; level: number }[];
    queuedAugmentations: { name: string; level: number }[];
    sourceFiles: Record<string, number>;
    ownedSourceFiles: Record<string, number>;
    gangFaction?: string;
    focus?: boolean;
  };
  currentWork?: SaveCurrentWork;
  stockMarket?: SaveStockMarket;
  /** Faction name -> reputation and favor. Favor is the one thing that CANNOT
   *  be earned within a run — it is banked only at install — so a save is the
   *  only way to study donation-gated strategy at all. */
  factions: Record<string, { rep: number; favor: number }>;
  hacknet: { nodes: SaveSeedHacknetNode[]; hashes: number; hashLevels: Record<string, number> };
  gates: {
    inGang: boolean;
    inBladeburner: boolean;
    hasCorporation: boolean;
    hasWseAccount: boolean;
    hasTixApiAccess: boolean;
    /** The $1b ticker data and the $25b script API, which are bought
     *  independently — only the second one `getForecast` can read. Both survive
     *  an augmentation install and are cleared only by a BitNode reset, so a
     *  save is the only way to study a run that already owns them. */
    has4SData: boolean;
    has4SDataTixApi: boolean;
  };
}

/** Ordinary and Hacknet servers participate in the network/fleet. Darknet
 * servers are a separate mechanic. */
function isFleetServer(server: SaveServer): boolean {
  return server.kind === "Server" || server.kind === "HacknetServer";
}

/** The static darkweb root is needed for exact TOR topology. Movable darknet
 * servers remain unsupported because their specialized state is not present
 * in SaveSeedServer. */
function isSeededServer(server: SaveServer): boolean {
  return isFleetServer(server) || (server.kind === "DarknetServer" && server.hostname === "darkweb");
}

export const SUPPORTED_SAVE_VERSION = 51;

export function saveToSeed(snapshot: SaveSnapshot): SaveSeed {
  if (snapshot.version !== SUPPORTED_SAVE_VERSION) {
    throw new Error(
      `Unsupported Bitburner save version ${String(snapshot.version)}; expected ${SUPPORTED_SAVE_VERSION}`,
    );
  }
  const servers: SaveSeedServer[] = [];
  const topology: Record<string, string[]> = {};

  const connected = snapshot.servers.get(snapshot.player.currentServer);
  if (!connected || !isSeededServer(connected)) {
    throw new Error(
      `Unsupported current server '${snapshot.player.currentServer}'; movable darknet terminal state is not modeled`,
    );
  }

  for (const server of snapshot.servers.values()) {
    if (!isSeededServer(server)) continue;
    topology[server.hostname] = server.serversOnNetwork.filter((neighbour) => {
      const target = snapshot.servers.get(neighbour);
      return target !== undefined && isSeededServer(target);
    });
    servers.push({
      hostname: server.hostname,
      ip: server.ip,
      organizationName: server.organizationName,
      hasAdminRights: server.hasAdminRights,
      isConnectedTo: server.isConnectedTo,
      purchasedByPlayer: server.purchasedByPlayer,
      backdoorInstalled: server.backdoorInstalled,
      maxRam: server.maxRam,
      // Preserve the observed occupancy. game-run marks the absent process
      // lifecycle as unmodelled instead of granting fabricated free RAM.
      ramUsed: server.ramUsed,
      cpuCores: server.cpuCores,
      moneyAvailable: server.moneyAvailable,
      moneyMax: server.moneyMax,
      hackDifficulty: server.hackDifficulty,
      minDifficulty: server.minDifficulty,
      baseDifficulty: server.baseDifficulty,
      requiredHackingSkill: server.requiredHackingSkill,
      serverGrowth: server.serverGrowth,
      numOpenPortsRequired: server.numOpenPortsRequired,
      openPortCount: server.openPortCount,
      sshPortOpen: server.sshPortOpen,
      ftpPortOpen: server.ftpPortOpen,
      smtpPortOpen: server.smtpPortOpen,
      httpPortOpen: server.httpPortOpen,
      sqlPortOpen: server.sqlPortOpen,
      ...(server.kind === "HacknetServer" ? { isHacknetServer: true } : {}),
      simKind: server.kind === "HacknetServer"
        ? "HacknetServer"
        : server.kind === "DarknetServer"
          ? "DarknetServer"
          : "Server",
      contractFiles: [...server.contracts],
    });
  }

  const home = snapshot.servers.get("home");
  return {
    version: snapshot.version,
    bitnode: snapshot.bitNode,
    sourceFileLevel: sfLevel(snapshot.activeSourceFiles, snapshot.bitNode),
    sourceFiles: snapshot.activeSourceFiles,
    playtimeSinceLastAug: snapshot.player.playtimeSinceLastAug,
    playtimeSinceLastBitnode: snapshot.player.playtimeSinceLastBitnode,
    totalPlaytime: snapshot.player.totalPlaytime,
    sleeveCount: snapshot.player.sleeveCount,
    companies: Object.fromEntries(
      Object.entries(snapshot.companies).map(([name, standing]) => [
        name,
        { rep: standing.playerReputation ?? 0, favor: standing.favor ?? 0 },
      ]),
    ),
    ...(snapshot.player.bladeburnerRank !== undefined
      ? { bladeburnerRank: snapshot.player.bladeburnerRank }
      : {}),
    homeFiles: home ? [...home.programs, ...home.messages, ...home.contracts] : [],
    hasTor: home?.serversOnNetwork.includes("darkweb") ?? false,
    bitNodeOptions: snapshot.bitNodeOptions,
    homeRam: home?.maxRam ?? 8,
    homeCores: home?.cpuCores ?? 1,
    startingMoney: snapshot.player.money,
    currentServer: snapshot.player.currentServer,
    servers,
    topology,
    person: {
      skills: snapshot.player.skills,
      exp: snapshot.player.exp,
      mults: snapshot.player.mults,
      hp: snapshot.player.hp,
    },
    playerState: {
      money: snapshot.player.money,
      karma: snapshot.player.karma,
      entropy: snapshot.player.entropy,
      exploits: snapshot.player.exploits,
      persistentIntelligenceExp: snapshot.player.persistentIntelligenceExp,
      numPeopleKilled: snapshot.player.numPeopleKilled,
      city: snapshot.player.city,
      location: snapshot.player.location,
      jobs: snapshot.player.jobs,
      factions: snapshot.player.factions,
      factionInvitations: snapshot.player.factionInvitations,
      augmentations: snapshot.player.augmentations,
      queuedAugmentations: snapshot.player.queuedAugmentations,
      sourceFiles: { ...snapshot.activeSourceFiles },
      ownedSourceFiles: { ...snapshot.sourceFiles },
      ...(snapshot.player.gangFaction ? { gangFaction: snapshot.player.gangFaction } : {}),
      focus: snapshot.player.focus,
    },
    ...(snapshot.player.currentWork ? { currentWork: snapshot.player.currentWork } : {}),
    ...(snapshot.stockMarket ? { stockMarket: snapshot.stockMarket } : {}),
    factions: Object.fromEntries(
      Object.entries(snapshot.factions).map(([name, standing]) => [
        name,
        { rep: standing.playerReputation ?? 0, favor: standing.favor ?? 0 },
      ]),
    ),
    hacknet: {
      nodes: snapshot.player.hacknetNodes.flatMap((node): SaveSeedHacknetNode[] => {
        if (typeof node !== "string") return [node];
        const server = snapshot.servers.get(node);
        if (!server || server.kind !== "HacknetServer") return [];
        return [{
          hostname: server.hostname,
          level: server.hacknetLevel ?? 1,
          ram: server.maxRam,
          cores: server.cpuCores,
          totalProduction: server.hacknetTotalProduction ?? 0,
          onlineTimeSeconds: server.hacknetOnlineTimeSeconds ?? 0,
          cache: server.hacknetCache ?? 1,
        }];
      }),
      hashes: snapshot.player.hashes,
      hashLevels: { ...snapshot.player.hashUpgrades },
    },
    gates: {
      inGang: snapshot.player.hasGang,
      inBladeburner: snapshot.player.hasBladeburner,
      hasCorporation: snapshot.player.hasCorporation,
      hasWseAccount: snapshot.player.hasWseAccount,
      hasTixApiAccess: snapshot.player.hasTixApiAccess,
      has4SData: snapshot.player.has4SData,
      has4SDataTixApi: snapshot.player.has4SDataTixApi,
    },
  };
}
