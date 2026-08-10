import {
  SERVER_DEFAULTS,
  SKILL_NAMES,
  type SaveBitNodeOptions,
  type SaveFactionStanding,
  type SaveHacknetNode,
  type SavePlayer,
  type SaveServer,
  type SaveSnapshot,
} from "./snapshot.ts";

/** Parse a decompressed Bitburner save into a SaveSnapshot.
 *
 * Takes a STRING, not bytes: gunzip is a Bun API and shared/ must stay pure
 * (tests/boundaries.test.ts). tools/save-io.ts owns the decompression.
 *
 * The format, confirmed against bitburner-src @ v3.0.1
 * (src/SaveObject.ts, src/utils/JSONReviver.ts):
 *
 *   {"ctor":"BitburnerSaveObject","data":{"PlayerSave":"<json>", ...}}
 *
 * Every value inside `data` is itself a JSON *string*, so the whole thing is
 * double-encoded. Within those, class instances are wrapped as
 * `{ctor, data}`, and Map/Set become `{"ctor":"JSONMap","data":[[k,v],...]}`.
 *
 * Four traps, each of which silently corrupts a naive parser:
 *   1. "__proto__" is a legitimate hostname — servers go into a Map, and no
 *      parsed object is ever spread or Object.assign'd.
 *   2. Missing keys mean class defaults, not undefined (SERVER_DEFAULTS).
 *   3. `ramUsed` is not saved at all; it is recomputed from runningScripts.
 *   4. Faction and company reputation live in their own top-level saves, not
 *      in PlayerSave, and both are sparse. */

export class SaveFormatError extends Error {}

interface ReviverValue {
  ctor: string;
  data: unknown;
}

function isReviverValue(value: unknown): value is ReviverValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as ReviverValue).ctor === "string" &&
    "data" in value
  );
}

/** Recursively replace `{ctor, data}` wrappers with their payload, turning the
 * two Jsonable wrappers back into real collections. Class identity is kept on
 * a `__ctor` marker where it matters (servers). */
export function unwrap(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrap);
  if (typeof value !== "object" || value === null) return value;

  if (isReviverValue(value)) {
    if (value.ctor === "JSONMap") {
      const entries = Array.isArray(value.data) ? (value.data as [unknown, unknown][]) : [];
      return new Map(entries.map(([key, item]) => [key, unwrap(item)]));
    }
    if (value.ctor === "JSONSet") {
      const items = Array.isArray(value.data) ? value.data : [];
      return new Set(items.map(unwrap));
    }
    const inner = unwrap(value.data);
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner) && !(inner instanceof Map)) {
      // fromEntries uses CreateDataProperty, so a "__proto__" key becomes a
      // plain own property rather than mutating the prototype.
      return Object.fromEntries([...Object.entries(inner), ["__ctor", value.ctor]]);
    }
    return inner;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
}

type Bag = Record<string, unknown>;

function asBag(value: unknown): Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Map<K, number> | Record<K, number> -> Record<string, number>.
 *
 * `keepZero` matters: in `sourceFiles` a level of 0 means "absent" and is
 * dropped (matching ns.getResetInfo().ownedSF), but in `sourceFileOverrides` a
 * 0 is the whole point — it is how a BitNode option suppresses a source file
 * the player owns. Collapsing the two loses that. */
function numberMap(value: unknown, keepZero = false): Record<string, number> {
  const out: Record<string, number> = {};
  const keep = (item: unknown): item is number => typeof item === "number" && (keepZero || item !== 0);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      if (keep(item)) out[String(key)] = item;
    }
    return out;
  }
  for (const [key, item] of Object.entries(asBag(value))) {
    if (keep(item)) out[key] = item;
  }
  return out;
}

function skillBag(value: unknown): Record<string, number> {
  const source = asBag(value);
  const out: Record<string, number> = {};
  for (const name of SKILL_NAMES) out[name] = num(source[name], name === "hacking" ? 1 : 1);
  // intelligence is 0 on a character that has never unlocked it.
  out["intelligence"] = num(source["intelligence"], 0);
  return out;
}

function ownedAugList(value: unknown): { name: string; level: number }[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const bag = asBag(entry);
    return { name: str(bag["name"]), level: num(bag["level"], 1) };
  });
}

/** ramUsed is excluded from the save (BaseServer.getIncludedKeys) and rebuilt
 * on load from the scripts that were running. */
function ramUsedFrom(runningScripts: unknown): number {
  if (!Array.isArray(runningScripts)) return 0;
  let total = 0;
  for (const entry of runningScripts) {
    const bag = asBag(entry);
    total += num(bag["ramUsage"], 0) * num(bag["threads"], 1);
  }
  return Math.round(total * 100) / 100;
}

function decodeServer(hostname: string, raw: unknown): SaveServer {
  const bag = asBag(raw);
  const server: SaveServer = { ...SERVER_DEFAULTS, hostname, serversOnNetwork: [] };
  server.kind = str(bag["__ctor"], "Server");
  server.organizationName = str(bag["organizationName"], SERVER_DEFAULTS.organizationName);
  server.programs = strList(bag["programs"]);
  server.messages = strList(bag["messages"]);
  server.hasAdminRights = bool(bag["hasAdminRights"]);
  server.backdoorInstalled = bool(bag["backdoorInstalled"]);
  server.purchasedByPlayer = bool(bag["purchasedByPlayer"]);
  server.maxRam = num(bag["maxRam"], SERVER_DEFAULTS.maxRam);
  server.cpuCores = num(bag["cpuCores"], SERVER_DEFAULTS.cpuCores);
  server.moneyAvailable = num(bag["moneyAvailable"], SERVER_DEFAULTS.moneyAvailable);
  server.moneyMax = num(bag["moneyMax"], SERVER_DEFAULTS.moneyMax);
  server.hackDifficulty = num(bag["hackDifficulty"], SERVER_DEFAULTS.hackDifficulty);
  server.minDifficulty = num(bag["minDifficulty"], SERVER_DEFAULTS.minDifficulty);
  server.baseDifficulty = num(bag["baseDifficulty"], SERVER_DEFAULTS.baseDifficulty);
  server.requiredHackingSkill = num(bag["requiredHackingSkill"], SERVER_DEFAULTS.requiredHackingSkill);
  server.serverGrowth = num(bag["serverGrowth"], SERVER_DEFAULTS.serverGrowth);
  server.numOpenPortsRequired = num(bag["numOpenPortsRequired"], SERVER_DEFAULTS.numOpenPortsRequired);
  server.openPortCount = num(bag["openPortCount"], SERVER_DEFAULTS.openPortCount);
  server.serversOnNetwork = Array.isArray(bag["serversOnNetwork"])
    ? (bag["serversOnNetwork"] as unknown[]).filter((h): h is string => typeof h === "string")
    : [];
  server.ramUsed = ramUsedFrom(bag["runningScripts"]);
  if (server.kind === "HacknetServer") {
    server.hacknetLevel = num(bag["level"], 1);
    server.hacknetCache = num(bag["cache"], 1);
    server.hacknetTotalProduction = num(bag["totalHashesGenerated"], 0);
    server.hacknetOnlineTimeSeconds = num(bag["onlineTimeSeconds"], 0);
  }
  return server;
}

function decodeBitNodeOptions(raw: unknown): SaveBitNodeOptions {
  const bag = asBag(raw);
  const intelligenceOverride = bag["intelligenceOverride"];
  return {
    sourceFileOverrides: numberMap(bag["sourceFileOverrides"], true),
    intelligenceOverride: typeof intelligenceOverride === "number" ? intelligenceOverride : undefined,
    restrictHomePCUpgrade: bool(bag["restrictHomePCUpgrade"]),
    disableGang: bool(bag["disableGang"]),
    disableCorporation: bool(bag["disableCorporation"]),
    disableBladeburner: bool(bag["disableBladeburner"]),
    disable4SData: bool(bag["disable4SData"]),
    disableHacknetServer: bool(bag["disableHacknetServer"]),
    disableSleeveExpAndAugmentation: bool(bag["disableSleeveExpAndAugmentation"]),
  };
}

function strList(raw: unknown): string[] {
  return Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === "string") : [];
}

function decodePlayer(raw: unknown): SavePlayer {
  const bag = asBag(raw);
  const hp = asBag(bag["hp"]);
  const sleeves = bag["sleeves"];
  const hashManager = asBag(bag["hashManager"]);
  const bladeburner = asBag(bag["bladeburner"]);
  const hasBladeburner = bag["bladeburner"] !== null && bag["bladeburner"] !== undefined;
  const hacknetNodes = Array.isArray(bag["hacknetNodes"])
    ? (bag["hacknetNodes"] as unknown[]).flatMap((rawNode): (string | SaveHacknetNode)[] => {
        if (typeof rawNode === "string") return [rawNode];
        const node = asBag(rawNode);
        if (Object.keys(node).length === 0) return [];
        return [{
          level: num(node["level"], 1),
          ram: num(node["ram"], 1),
          cores: num(node["cores"], 1),
          totalProduction: num(node["totalMoneyGenerated"], 0),
          onlineTimeSeconds: num(node["onlineTimeSeconds"], 0),
        }];
      })
    : [];
  return {
    // loadPlayer parses money through parseFloat, so a string is legal here.
    money: typeof bag["money"] === "string" ? Number.parseFloat(bag["money"]) : num(bag["money"], 0),
    karma: num(bag["karma"], 0),
    entropy: num(bag["entropy"], 0),
    city: str(bag["city"], "Sector-12"),
    location: str(bag["location"]),
    skills: skillBag(bag["skills"]),
    exp: skillBag(bag["exp"]),
    mults: Object.fromEntries(
      Object.entries(asBag(bag["mults"])).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    ),
    hp: { current: num(hp["current"], 10), max: num(hp["max"], 10) },
    augmentations: ownedAugList(bag["augmentations"]),
    queuedAugmentations: ownedAugList(bag["queuedAugmentations"]),
    factions: strList(bag["factions"]),
    factionInvitations: strList(bag["factionInvitations"]),
    numPeopleKilled: num(bag["numPeopleKilled"], 0),
    jobs: Object.fromEntries(
      Object.entries(asBag(bag["jobs"])).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    hasWseAccount: bool(bag["hasWseAccount"]),
    hasTixApiAccess: bool(bag["hasTixApiAccess"]),
    has4SData: bool(bag["has4SData"]),
    has4SDataTixApi: bool(bag["has4SDataTixApi"]),
    // null when the mechanic was never started; a wrapped object otherwise.
    hasGang: bag["gang"] !== null && bag["gang"] !== undefined,
    hasCorporation: bag["corporation"] !== null && bag["corporation"] !== undefined,
    hasBladeburner,
    ...(hasBladeburner && typeof bladeburner["rank"] === "number"
      ? { bladeburnerRank: bladeburner["rank"] }
      : {}),
    sleeveCount: Array.isArray(sleeves) ? sleeves.length : 0,
    playtimeSinceLastBitnode: num(bag["playtimeSinceLastBitnode"], 0),
    totalPlaytime: num(bag["totalPlaytime"], 0),
    hacknetNodes,
    hashes: num(hashManager["hashes"], 0),
    hashUpgrades: numberMap(hashManager["upgrades"], true),
  };
}

function decodeStandings(raw: unknown): Record<string, SaveFactionStanding> {
  const out: Record<string, SaveFactionStanding> = {};
  for (const [name, value] of Object.entries(asBag(raw))) {
    const bag = asBag(value);
    const standing: SaveFactionStanding = {};
    if (typeof bag["favor"] === "number") standing.favor = bag["favor"];
    if (typeof bag["playerReputation"] === "number") standing.playerReputation = bag["playerReputation"];
    if (typeof bag["discovery"] === "string") standing.discovery = bag["discovery"];
    out[name] = standing;
  }
  return out;
}

/** Parse one of the double-encoded sub-saves. Absent or empty is not an error:
 * StaneksGiftSave and StockMarketSave default to "". */
function subSave(data: Bag, key: string): unknown {
  const raw = data[key];
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    return unwrap(JSON.parse(raw));
  } catch (error) {
    throw new SaveFormatError(`${key} is not valid JSON: ${String(error)}`);
  }
}

export function decodeSaveJson(json: string): SaveSnapshot {
  let outer: unknown;
  try {
    outer = JSON.parse(json);
  } catch (error) {
    throw new SaveFormatError(`save is not valid JSON: ${String(error)}`);
  }
  if (!isReviverValue(outer) || outer.ctor !== "BitburnerSaveObject") {
    throw new SaveFormatError(`not a Bitburner save (expected ctor BitburnerSaveObject)`);
  }
  const data = asBag(outer.data);
  if (typeof data["PlayerSave"] !== "string") {
    throw new SaveFormatError("save has no PlayerSave");
  }

  const playerRaw = asBag(subSave(data, "PlayerSave"));
  const player = decodePlayer(playerRaw);
  const bitNodeOptions = decodeBitNodeOptions(playerRaw["bitNodeOptions"]);
  const sourceFiles = numberMap(playerRaw["sourceFiles"]);

  // activeSourceFiles is a getter, never stored: overrides win outright, and a
  // level of 0 means "not active" rather than "present at zero".
  const activeSourceFiles: Record<string, number> = { ...sourceFiles };
  for (const [sf, level] of Object.entries(bitNodeOptions.sourceFileOverrides)) {
    if (level === 0) delete activeSourceFiles[sf];
    else activeSourceFiles[sf] = level;
  }

  const servers = new Map<string, SaveServer>();
  const serversRaw = subSave(data, "AllServersSave");
  // Object.entries, never spread: "__proto__" appears as a hostname in the
  // game's own save corpus.
  for (const [hostname, raw] of Object.entries(asBag(serversRaw))) {
    servers.set(hostname, decodeServer(hostname, raw));
  }

  const versionRaw = subSave(data, "VersionSave");
  return {
    version: typeof versionRaw === "number" ? versionRaw : Number(versionRaw) || undefined,
    bitNode: num(playerRaw["bitNodeN"], 1),
    sourceFiles,
    activeSourceFiles,
    bitNodeOptions,
    player,
    servers,
    factions: decodeStandings(subSave(data, "FactionsSave")),
    companies: decodeStandings(subSave(data, "CompaniesSave")),
  };
}
