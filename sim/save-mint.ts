import type { RouteLeg } from "./route-legs.ts";
import type { SavePlayer, SaveServer, SaveSnapshot } from "../shared/save/snapshot.ts";
import { SERVER_DEFAULTS, SKILL_NAMES } from "../shared/save/snapshot.ts";
import { MINTED_SAVE_VERSION } from "../shared/save/encode.ts";
import { VANILLA_NETWORK } from "./network.ts";
import { serverFromSpec, type ServerSpec, type SimServer } from "./core/effects.ts";
import { mockServer } from "./core/mocks.ts";
import { currentNodeMults, replaceCurrentNodeMults } from "./vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { getBitNodeMultipliers } from "./vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { calculateExp } from "./vendor/bitburner/src/PersonObjects/formulas/skill.ts";

/** Build the save snapshot for a route leg's ENTRANCE.
 *
 * Lives in sim/ rather than shared/ because deriving a server's live fields is
 * the simulator's job (`serverFromSpec`) and shared/ may not import it.
 *
 * The entrance is exactly what the route implies — the Source-Files earlier
 * completions earned, the node's own partial level for a mid-milestone leg,
 * and the intelligence the chain carries — on the fixed vanilla network at a
 * cold 8 GB home. Nothing else: a leg begins where a source-file prestige
 * leaves the player, so there are no augmentations, no reputation, no
 * purchased servers and no programs. */

/** Money a node entrance starts with, matching SimWorld's own prestige reset
 * (sim/world.ts): $1,000 plus installed-augmentation grants — and a leg
 * entrance owns no augmentations — except BN8, where the node hands over a
 * trading bankroll because the market is its only income.
 *
 * Exported because a leg's entrance is expressed twice, and the two must
 * agree: as a minted save's player money here, and as the profile's
 * `startingMoney` when the same leg runs from its synthetic entrance. */
export function entranceMoney(bitNode: number): number {
  return bitNode === 8 ? 250e6 : 1_000;
}

/** The experience a synthetic intelligence level must be paired with, so skill
 * and exp describe the same reachable state. Mult 1 is the inverse of the
 * simulator's own `calculateSkill(exp, 1)`.
 *
 * Exported for the same reason as `entranceMoney`: a leg's entrance is
 * expressed both as a minted save and as a profile world, and the two must
 * agree. */
export function intelligenceExp(intelligence: number): number {
  return intelligence > 0 ? calculateExp(intelligence, 1) : 0;
}

/** Every skill at its post-prestige floor, with intelligence carried across
 * because owned SF5 is what makes it persist. */
function blankSkills(intelligence: number): Record<string, number> {
  const skills: Record<string, number> = {};
  for (const name of SKILL_NAMES) skills[name] = 1;
  skills["intelligence"] = intelligence;
  return skills;
}

function blankExp(intelligence: number): Record<string, number> {
  const exp: Record<string, number> = {};
  for (const name of SKILL_NAMES) exp[name] = 0;
  exp["intelligence"] = intelligenceExp(intelligence);
  return exp;
}

/** The files a source-file prestige leaves on home (sim/game-run.ts's own
 * post-prestige rebuild). They MUST be written into the blob: a run seeded
 * from a save takes its home files from the save alone — game-run only injects
 * NUKE.exe on the save-less path — so a minted entrance that omitted them
 * would start unable to root anything. */
function homePrograms(bitNode: number, sourceFiles: Readonly<Record<string, number>>): string[] {
  const programs = ["NUKE.exe"];
  if (bitNode === 5 || (sourceFiles["5"] ?? 0) > 0) programs.push("Formulas.exe");
  // DarkscapeNavigator.exe is deliberately absent: game-run grants it (and the
  // TOR it implies) from permanent darknet access, and writing it here would
  // hand TOR to a node that has no such access.
  return programs;
}

function saveServerFrom(
  server: SimServer,
  serversOnNetwork: readonly string[],
  files: { programs?: string[]; messages?: string[] } = {},
): SaveServer {
  return {
    ...SERVER_DEFAULTS,
    hostname: server.hostname,
    ip: server.ip,
    organizationName: server.organizationName,
    programs: files.programs ?? [],
    messages: files.messages ?? [],
    contracts: [],
    hasAdminRights: server.hasAdminRights,
    isConnectedTo: server.hostname === "home",
    backdoorInstalled: server.backdoorInstalled ?? false,
    purchasedByPlayer: server.purchasedByPlayer,
    maxRam: server.maxRam,
    cpuCores: server.cpuCores ?? 1,
    moneyAvailable: server.moneyAvailable,
    moneyMax: server.moneyMax,
    hackDifficulty: server.hackDifficulty,
    minDifficulty: server.minDifficulty,
    baseDifficulty: server.baseDifficulty,
    requiredHackingSkill: server.requiredHackingSkill,
    serverGrowth: server.serverGrowth,
    numOpenPortsRequired: server.numOpenPortsRequired,
    openPortCount: server.openPortCount ?? 0,
    sshPortOpen: server.sshPortOpen,
    ftpPortOpen: server.ftpPortOpen,
    smtpPortOpen: server.smtpPortOpen,
    httpPortOpen: server.httpPortOpen,
    sqlPortOpen: server.sqlPortOpen,
    serversOnNetwork: [...serversOnNetwork],
    ramUsed: 0,
    kind: server.hostname === "darkweb" ? "DarknetServer" : "Server",
  };
}

export function routeLegEntranceSnapshot(leg: RouteLeg): SaveSnapshot {
  const bitNode = leg.node;
  const ownLevel = leg.entranceSourceFiles[String(bitNode)] ?? 0;
  // MUST precede serverFromSpec: it derives money and difficulty through the
  // module-global node multipliers, so minting a BN5 entrance without this
  // would silently write BN1 economics. The +1 matches SimWorld's own call —
  // the level argument is "how many times this node has been completed,
  // plus the run in progress". Restored below: the binding is process-global,
  // and leaving it on the last minted node would silently retune whatever ran
  // next in the same process (another mint, a test file, the caller's run).
  const priorNodeMults = currentNodeMults;
  replaceCurrentNodeMults(getBitNodeMultipliers(bitNode, ownLevel + 1));
  try {
    return mintedSnapshot(leg, bitNode);
  } finally {
    replaceCurrentNodeMults(priorNodeMults);
  }
}

function mintedSnapshot(leg: RouteLeg, bitNode: number): SaveSnapshot {
  const servers = new Map<string, SaveServer>();
  const topology = VANILLA_NETWORK.topology;
  const home = serverFromSpec(
    {
      hostname: "home",
      ip: VANILLA_NETWORK.homeIp,
      organizationName: "Home PC",
      hackDifficulty: 0,
      moneyAvailable: 0,
      requiredHackingSkill: 1,
      serverGrowth: 1,
      numOpenPortsRequired: 5,
      maxRam: 8,
      hasAdminRights: true,
    },
    mockServer() as SimServer,
  );
  home.purchasedByPlayer = true;
  servers.set("home", saveServerFrom(home, topology["home"] ?? [], {
    programs: homePrograms(bitNode, leg.entranceSourceFiles),
    messages: ["hackers-starting-handbook.lit"],
  }));

  for (const spec of VANILLA_NETWORK.network as readonly ServerSpec[]) {
    const server = serverFromSpec(spec, mockServer() as SimServer);
    servers.set(server.hostname, saveServerFrom(server, topology[server.hostname] ?? []));
  }

  const intelligence = leg.entranceIntelligence;
  const player: SavePlayer = {
    money: entranceMoney(bitNode),
    karma: 0,
    entropy: 0,
    exploits: [],
    persistentIntelligenceExp: intelligenceExp(intelligence),
    city: "Sector-12",
    location: "Travel Agency",
    currentServer: "home",
    skills: blankSkills(intelligence),
    exp: blankExp(intelligence),
    // An aug-free entrance has no CAPTURED multiplier bag to write, so the
    // honest value is the empty one — and SimWorld reads an empty bag as
    // "rebuild me", which reapplies the defaults and the entrance's own
    // Source-File multipliers. A hand-written `{}` that suppressed the rebuild
    // would enter the leg without SF1/SF5/SF12 multipliers the route earned.
    mults: {},
    hp: { current: 10, max: 10 },
    augmentations: [],
    queuedAugmentations: [],
    factions: [],
    factionInvitations: [],
    numPeopleKilled: 0,
    jobs: {},
    // BN8 and SF8 grant market access at node entry, but that is the node's
    // statement at load, not saved player state.
    hasWseAccount: false,
    hasTixApiAccess: false,
    has4SData: false,
    has4SDataTixApi: false,
    hasGang: false,
    hasCorporation: false,
    hasBladeburner: false,
    sleeveCount: 0,
    playtimeSinceLastAug: 0,
    playtimeSinceLastBitnode: 0,
    totalPlaytime: 0,
    focus: true,
    hacknetNodes: [],
    hashes: 0,
    hashUpgrades: {},
  };

  const sourceFiles = { ...leg.entranceSourceFiles };
  return {
    version: MINTED_SAVE_VERSION,
    bitNode,
    sourceFiles,
    // No BitNode options are set, so the active set is the stored set.
    activeSourceFiles: { ...sourceFiles },
    bitNodeOptions: {
      sourceFileOverrides: {},
      intelligenceOverride: undefined,
      restrictHomePCUpgrade: false,
      disableGang: false,
      disableCorporation: false,
      disableBladeburner: false,
      disable4SData: false,
      disableHacknetServer: false,
      disableSleeveExpAndAugmentation: false,
    },
    player,
    servers,
    factions: {},
    companies: {},
  };
}
