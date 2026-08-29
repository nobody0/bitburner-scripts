import type {
  SaveFactionStanding,
  SaveHacknetNode,
  SavePlayer,
  SaveServer,
  SaveSnapshot,
} from "./snapshot.ts";

/** Serialize a SaveSnapshot back into Bitburner's save JSON — the exact
 * inverse of decode.ts, and the reason it exists: a route leg's entrance is
 * derived, so the checkpoint that starts it has to be written rather than
 * captured from a real game.
 *
 * Returns a STRING, not bytes: gzip is a Bun API and shared/ must stay pure
 * (tests/boundaries.test.ts). tools/ owns compression and file custody.
 *
 * The snapshot is a LOSSY normalization by design (snapshot.ts) — it holds
 * "the flat subset that seeding a simulation actually needs". So this writes a
 * save the SIMULATOR round-trips exactly, and deliberately does not claim to
 * reproduce every key the real game writes: settings, aliases, per-server
 * scripts and the mechanic sub-saves have no snapshot representation to write
 * back. That is why minted saves are registered as `minted` and refused by
 * save-restore until the upstream key set is vendored and verified.
 *
 * Sources: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/SaveObject.ts#L191-L230
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/utils/JSONReviver.ts#L11-L43 */

/** CONSTANTS.VersionNumber at the pinned v3.0.1. saveToSeed refuses anything
 * else, so a minted save that omitted or drifted this would fail at load. */
export const MINTED_SAVE_VERSION = 51;

type Bag = Record<string, unknown>;

/** `{ctor, data}` — the JSONReviver wrapper every class instance carries. */
function wrap(ctor: string, data: unknown): Bag {
  return { ctor, data };
}

/** The Map encoding: entries as a pair array, never an object, so a
 * "__proto__" hostname survives the round trip. */
function jsonMap(entries: Iterable<readonly [string | number, unknown]>): Bag {
  return wrap("JSONMap", [...entries].map(([key, value]) => [key, value]));
}

function encodeHacknetNode(node: string | SaveHacknetNode): unknown {
  if (typeof node === "string") return node;
  // Hacknet SERVERS are stored as hostname strings pointing into the server
  // map; ordinary nodes carry their own state, under the game's field names.
  return wrap("HacknetNode", {
    level: node.level,
    ram: node.ram,
    cores: node.cores,
    totalMoneyGenerated: node.totalProduction,
    onlineTimeSeconds: node.onlineTimeSeconds,
  });
}

function encodePlayer(snapshot: SaveSnapshot): string {
  const player: SavePlayer = snapshot.player;
  const data: Bag = {
    money: player.money,
    bitNodeN: snapshot.bitNode,
    karma: player.karma,
    entropy: player.entropy,
    exploits: player.exploits,
    persistentIntelligenceData: { exp: player.persistentIntelligenceExp },
    city: player.city,
    location: player.location,
    currentServer: player.currentServer,
    hp: { current: player.hp.current, max: player.hp.max },
    skills: player.skills,
    exp: player.exp,
    mults: player.mults,
    augmentations: player.augmentations.map((aug) => ({ name: aug.name, level: aug.level })),
    queuedAugmentations: player.queuedAugmentations.map((aug) => ({ name: aug.name, level: aug.level })),
    factions: player.factions,
    factionInvitations: player.factionInvitations,
    numPeopleKilled: player.numPeopleKilled,
    jobs: player.jobs,
    hasWseAccount: player.hasWseAccount,
    hasTixApiAccess: player.hasTixApiAccess,
    has4SData: player.has4SData,
    has4SDataTixApi: player.has4SDataTixApi,
    playtimeSinceLastAug: player.playtimeSinceLastAug,
    playtimeSinceLastBitnode: player.playtimeSinceLastBitnode,
    totalPlaytime: player.totalPlaytime,
    focus: player.focus,
    hacknetNodes: player.hacknetNodes.map(encodeHacknetNode),
    hashManager: wrap("HashManager", { hashes: player.hashes, upgrades: player.hashUpgrades }),
    // A level of 0 is dropped on decode, so writing the stored map verbatim
    // round-trips: what is absent here is absent there.
    sourceFiles: jsonMap(Object.entries(snapshot.sourceFiles).map(([sf, level]) => [Number(sf), level])),
    bitNodeOptions: {
      ...snapshot.bitNodeOptions,
      sourceFileOverrides: jsonMap(
        Object.entries(snapshot.bitNodeOptions.sourceFileOverrides).map(([sf, level]) => [Number(sf), level]),
      ),
    },
    // The null-vs-object slot IS how decode detects each mechanic; an empty
    // object would read as "started" and change the run's capabilities.
    gang: player.hasGang ? wrap("Gang", { facName: player.gangFaction ?? "" }) : null,
    corporation: player.hasCorporation ? wrap("Corporation", {}) : null,
    bladeburner: player.hasBladeburner
      ? wrap("Bladeburner", { rank: player.bladeburnerRank ?? 0 })
      : null,
    sleeves: Array.from({ length: player.sleeveCount }, () => wrap("Sleeve", {})),
  };
  if (player.currentWork) {
    const work = player.currentWork;
    // Each work class names its own subject and type fields; decode.ts
    // switches on the ctor to read them, so this must mirror that switch.
    data["currentWork"] = wrap(work.ctor, {
      cyclesWorked: work.cyclesWorked,
      ...(work.unitCompleted !== undefined ? { unitCompleted: work.unitCompleted } : {}),
      ...(work.kind === "faction"
        ? { factionName: work.subject, factionWorkType: work.workType ?? "" }
        : {}),
      ...(work.kind === "company" ? { companyName: work.subject } : {}),
      ...(work.kind === "crime" ? { crimeType: work.subject } : {}),
      ...(work.kind === "class" ? { classType: work.subject } : {}),
      ...(work.kind === "graft" ? { augmentation: work.subject } : {}),
      ...(work.kind === "createProgram" ? { programName: work.subject } : {}),
      ...(work.kind === "unknown" && work.workType !== undefined ? { workType: work.workType } : {}),
    });
  }
  return JSON.stringify(wrap("PlayerObject", data));
}

function encodeServer(server: SaveServer): Bag {
  const data: Bag = {
    hostname: server.hostname,
    ip: server.ip,
    organizationName: server.organizationName,
    programs: server.programs,
    messages: server.messages,
    contracts: server.contracts.map((fn) => wrap("CodingContract", { fn })),
    hasAdminRights: server.hasAdminRights,
    isConnectedTo: server.isConnectedTo,
    backdoorInstalled: server.backdoorInstalled,
    purchasedByPlayer: server.purchasedByPlayer,
    maxRam: server.maxRam,
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
    serversOnNetwork: server.serversOnNetwork,
    // ramUsed is NOT a stored key: the game recomputes it from this list.
    runningScripts: [],
  };
  if (server.kind === "HacknetServer") {
    data["level"] = server.hacknetLevel ?? 1;
    data["cache"] = server.hacknetCache ?? 1;
    data["totalHashesGenerated"] = server.hacknetTotalProduction ?? 0;
    data["onlineTimeSeconds"] = server.hacknetOnlineTimeSeconds ?? 0;
  }
  return wrap(server.kind, data);
}

function encodeStandings(standings: Record<string, SaveFactionStanding>, ctor: string): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(standings).map(([name, standing]) => [
        name,
        wrap(ctor, {
          ...(standing.favor !== undefined ? { favor: standing.favor } : {}),
          ...(standing.playerReputation !== undefined ? { playerReputation: standing.playerReputation } : {}),
          ...(standing.discovery !== undefined ? { discovery: standing.discovery } : {}),
        }),
      ]),
    ),
  );
}

export function encodeSaveJson(snapshot: SaveSnapshot): string {
  if (snapshot.stockMarket) {
    // Refused rather than dropped: `SaveStockMarket` is itself lossy — it
    // keeps `hasOrders`, not the orders — so no faithful `StockMarketSave`
    // can be written from it. A leg entrance never carries a market, and a
    // caller that does deserves to be told rather than to lose it silently.
    throw new Error("cannot encode a snapshot carrying stock-market state: no faithful inverse exists");
  }
  const data: Bag = {
    PlayerSave: encodePlayer(snapshot),
    // A plain hostname-keyed object, NOT a JSONMap — that is how the game
    // stores it and how decode.ts reads it back. `fromEntries` uses
    // CreateDataProperty, so a "__proto__" hostname becomes an own property
    // instead of mutating the prototype.
    AllServersSave: JSON.stringify(
      Object.fromEntries([...snapshot.servers].map(([hostname, server]) => [hostname, encodeServer(server)])),
    ),
    FactionsSave: encodeStandings(snapshot.factions, "Faction"),
    CompaniesSave: encodeStandings(snapshot.companies, "Company"),
    VersionSave: JSON.stringify(snapshot.version ?? MINTED_SAVE_VERSION),
  };
  return JSON.stringify(wrap("BitburnerSaveObject", data));
}
