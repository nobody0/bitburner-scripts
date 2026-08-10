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
  organizationName: string;
  hasAdminRights: boolean;
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
  bitnode: number;
  /** Active SF level for the CURRENT node — what the RAM cost multiplier and
   *  the capability gates key off. */
  sourceFileLevel: number;
  sourceFiles: Record<string, number>;
  companies: Record<string, number>;
  bladeburnerRank?: number;
  homeFiles: string[];
  bitNodeOptions: SaveSnapshot["bitNodeOptions"];
  homeRam: number;
  homeCores: number;
  startingMoney: number;
  servers: SaveSeedServer[];
  /** hostname -> neighbours, from the save's own topology. */
  topology: Record<string, string[]>;
  person: { skills: Record<string, number>; exp: Record<string, number>; mults: Record<string, number> };
  /** The non-Person half: karma, kills, joined factions, augmentations, jobs.
   *  Without this a save-seeded run starts at karma 0 with no factions, which
   *  silently makes every criminal faction unreachable and every karma need
   *  look freshly blocking. */
  playerState: {
    money: number;
    karma: number;
    numPeopleKilled: number;
    city: string;
    location: string;
    jobs: Record<string, string>;
    factions: string[];
    factionInvitations: string[];
    augmentations: { name: string; level: number }[];
    queuedAugmentations: { name: string; level: number }[];
    sourceFiles: Record<string, number>;
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
    goPlayable: boolean;
  };
}

/** Ordinary and Hacknet servers participate in the network/fleet. Darknet
 * servers are a separate mechanic. */
function isFleetServer(server: SaveServer): boolean {
  return server.kind === "Server" || server.kind === "HacknetServer";
}

function portFlags(server: SaveServer): Pick<
  SaveSeedServer,
  "sshPortOpen" | "ftpPortOpen" | "smtpPortOpen" | "httpPortOpen" | "sqlPortOpen"
> {
  // Only the count is stored, not which programs were used. Opening the first
  // N flags reproduces the count, which is all canRoot() and nuke() read.
  const open = server.openPortCount;
  return {
    sshPortOpen: open > 0,
    ftpPortOpen: open > 1,
    smtpPortOpen: open > 2,
    httpPortOpen: open > 3,
    sqlPortOpen: open > 4,
  };
}

export function saveToSeed(snapshot: SaveSnapshot): SaveSeed {
  const servers: SaveSeedServer[] = [];
  const topology: Record<string, string[]> = {};

  for (const server of snapshot.servers.values()) {
    if (!isFleetServer(server)) continue;
    topology[server.hostname] = server.serversOnNetwork.filter((neighbour) => {
      const target = snapshot.servers.get(neighbour);
      return target !== undefined && isFleetServer(target);
    });
    servers.push({
      hostname: server.hostname,
      organizationName: server.organizationName,
      hasAdminRights: server.hasAdminRights,
      purchasedByPlayer: server.purchasedByPlayer,
      backdoorInstalled: server.backdoorInstalled,
      maxRam: server.maxRam,
      // Scripts are not restored into the simulation, so nothing is running.
      ramUsed: 0,
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
      ...portFlags(server),
      ...(server.kind === "HacknetServer" ? { isHacknetServer: true } : {}),
      simKind: server.kind === "HacknetServer" ? "HacknetServer" : "Server",
    });
  }

  const home = snapshot.servers.get("home");
  return {
    bitnode: snapshot.bitNode,
    sourceFileLevel: sfLevel(snapshot.activeSourceFiles, snapshot.bitNode),
    sourceFiles: snapshot.activeSourceFiles,
    companies: Object.fromEntries(
      Object.entries(snapshot.companies).map(([name, standing]) => [name, standing.playerReputation ?? 0]),
    ),
    ...(snapshot.player.bladeburnerRank !== undefined
      ? { bladeburnerRank: snapshot.player.bladeburnerRank }
      : {}),
    homeFiles: home ? [...home.programs, ...home.messages] : [],
    bitNodeOptions: snapshot.bitNodeOptions,
    homeRam: home?.maxRam ?? 8,
    homeCores: home?.cpuCores ?? 1,
    startingMoney: snapshot.player.money,
    servers,
    topology,
    person: {
      skills: snapshot.player.skills,
      exp: snapshot.player.exp,
      mults: snapshot.player.mults,
    },
    playerState: {
      money: snapshot.player.money,
      karma: snapshot.player.karma,
      numPeopleKilled: snapshot.player.numPeopleKilled,
      city: snapshot.player.city,
      location: snapshot.player.location,
      jobs: snapshot.player.jobs,
      factions: snapshot.player.factions,
      factionInvitations: snapshot.player.factionInvitations,
      augmentations: snapshot.player.augmentations,
      queuedAugmentations: snapshot.player.queuedAugmentations,
      sourceFiles: { ...snapshot.activeSourceFiles },
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
      // IPvGO is always reachable; the simulator has no model for it, so the
      // ns call still reports itself as unmodelled when a probe asks.
      goPlayable: true,
    },
  };
}
