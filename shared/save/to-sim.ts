import { sfLevel } from "../features/unlock.ts";
import type { SaveSnapshot, SaveServer } from "./snapshot.ts";

/** Turn a save snapshot into simulator initial conditions.
 *
 * A save carries LIVE server state — money already grown, security already
 * weakened, RAM already bought — so this cannot go through
 * sim/core/effects.ts serverFromSpec, which derives live fields from base
 * metadata. The servers are injected whole instead. */

export interface SaveSeedServer {
  hostname: string;
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
}

export interface SaveSeed {
  bitnode: number;
  /** Active SF level for the CURRENT node — what the RAM cost multiplier and
   *  the capability gates key off. */
  sourceFileLevel: number;
  sourceFiles: Record<string, number>;
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
  };
  /** Faction name -> reputation and favor. Favor is the one thing that CANNOT
   *  be earned within a run — it is banked only at install — so a save is the
   *  only way to study donation-gated strategy at all. */
  factions: Record<string, { rep: number; favor: number }>;
  gates: {
    inGang: boolean;
    inBladeburner: boolean;
    hasCorporation: boolean;
    hasWseAccount: boolean;
    hasTixApiAccess: boolean;
    goPlayable: boolean;
  };
}

/** Hacknet and darknet servers are not part of the hacking fleet: the game
 * excludes hacknet servers from `isUseful` and darknet ones are a separate
 * mechanic entirely. */
function isFleetServer(server: SaveServer): boolean {
  return server.kind === "Server";
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
    });
  }

  const home = snapshot.servers.get("home");
  return {
    bitnode: snapshot.bitNode,
    sourceFileLevel: sfLevel(snapshot.activeSourceFiles, snapshot.bitNode),
    sourceFiles: snapshot.activeSourceFiles,
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
    },
    factions: Object.fromEntries(
      Object.entries(snapshot.factions).map(([name, standing]) => [
        name,
        { rep: standing.playerReputation ?? 0, favor: standing.favor ?? 0 },
      ]),
    ),
    gates: {
      inGang: snapshot.player.hasGang,
      inBladeburner: snapshot.player.hasBladeburner,
      hasCorporation: snapshot.player.hasCorporation,
      hasWseAccount: snapshot.player.hasWseAccount,
      hasTixApiAccess: snapshot.player.hasTixApiAccess,
      // IPvGO is always reachable; the simulator has no model for it, so the
      // ns call still reports itself as unmodelled when a probe asks.
      goPlayable: true,
    },
  };
}
