import { describe, expect, test } from "bun:test";
import { decodeSaveJson, SaveFormatError, unwrap } from "../shared/save/decode.ts";
import { saveToSeed } from "../shared/save/to-sim.ts";
import { only } from "../sim/feature-selection.ts";
import { parseGoals } from "../shared/goals/presets.ts";
import { runGame } from "../sim/game-run.ts";
import { DEFAULT_EPOCH_MS } from "../sim/realm/timers.ts";
import { decodeSaveData, prepareIndexedDbSave } from "../tools/save-io.ts";

/** The save parser's job is to be boring and exactly right. Every test here
 * corresponds to a real encoding decision in bitburner-src @ v3.0.1 that a
 * naive parser gets wrong silently rather than loudly. */

function jsonMap(entries: [unknown, unknown][]): unknown {
  return { ctor: "JSONMap", data: entries };
}

/** An object with a literal "__proto__" own property. Written this way on
 * purpose: an object literal would set the prototype instead, which is exactly
 * the bug this fixture exists to catch. */
function withProtoKey(key: string, value: unknown, rest: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...Object.entries(rest), [key, value]]);
}

function server(data: Record<string, unknown>): unknown {
  return { ctor: "Server", data };
}

interface FixtureOptions {
  bitNodeN?: number;
  sourceFiles?: [number, number][];
  sourceFileOverrides?: [number, number][];
  currentWork?: unknown;
  gang?: unknown;
  focus?: boolean;
  stockMarket?: unknown;
  currentServer?: string;
}

function buildSaveJson(options: FixtureOptions = {}): string {
  const player = {
    money: 1_234_567,
    bitNodeN: options.bitNodeN ?? 1,
    karma: -54,
    entropy: 2,
    exploits: ["Bypass", "N00dles"],
    persistentIntelligenceData: { exp: 1_234 },
    city: "Sector-12",
    location: "Travel Agency",
    currentServer: options.currentServer ?? "home",
    hp: { current: 7, max: 20 },
    skills: { hacking: 812, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 3 },
    exp: { hacking: 1e6, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 12 },
    mults: { hacking: 1.5, hacking_exp: 2, hacking_money: 1.1 },
    augmentations: [
      { name: "Bionic Arms", level: 1 },
      { name: "NeuroFlux Governor", level: 12 },
    ],
    queuedAugmentations: [{ name: "PCMatrix", level: 1 }],
    factions: ["CyberSec", "NiteSec", "Sector-12"],
    factionInvitations: ["Tetrads", "Chongqing"],
    jobs: { "Noodle Bar": "Employee" },
    hasWseAccount: true,
    hasTixApiAccess: true,
    has4SData: false,
    has4SDataTixApi: false,
    gang: options.gang ?? null,
    currentWork: options.currentWork ?? null,
    focus: options.focus ?? false,
    corporation: null,
    bladeburner: { ctor: "Bladeburner", data: { rank: 40 } },
    sleeves: [{ ctor: "Sleeve", data: {} }, { ctor: "Sleeve", data: {} }],
    playtimeSinceLastAug: 3_600_000,
    playtimeSinceLastBitnode: 7_200_000,
    totalPlaytime: 99_000_000,
    hacknetNodes: ["hacknet-server-0"],
    hashManager: { ctor: "HashManager", data: { hashes: 37, upgrades: { "Sell for Money": 2 } } },
    sourceFiles: jsonMap(options.sourceFiles ?? [[1, 3]]),
    bitNodeOptions: {
      sourceFileOverrides: jsonMap(options.sourceFileOverrides ?? []),
      intelligenceOverride: undefined,
      restrictHomePCUpgrade: false,
      disableGang: false,
      disableCorporation: false,
      disableBladeburner: false,
      disable4SData: false,
      disableHacknetServer: false,
      disableSleeveExpAndAugmentation: false,
    },
  };

  const servers = withProtoKey(
    // A legitimate hostname in the game's own darknet corpus.
    "__proto__",
    server({ hostname: "__proto__", maxRam: 4, serversOnNetwork: ["home"] }),
    {
      home: server({
        hostname: "home",
        ip: "10.20.30.40",
        programs: ["NUKE.exe", "BruteSSH.exe"],
        messages: ["hackers-starting-handbook.lit", "j0.msg"],
        contracts: [{ ctor: "CodingContract", data: { fn: "saved.cct", type: "Find Largest Prime Factor" } }],
        maxRam: 64,
        cpuCores: 4,
        hasAdminRights: true,
        isConnectedTo: true,
        purchasedByPlayer: true,
        serversOnNetwork: ["n00dles", "run4theh111z", "darkweb"],
        runningScripts: [
          { filename: "start.js", threads: 1, ramUsage: 3.6 },
          { filename: "worker/worker.js", threads: 10, ramUsage: 1.75 },
        ],
        scripts: jsonMap([["start.js", { ctor: "Script", data: { code: "x".repeat(5_000) } }]]),
      }),
      n00dles: server({
        hostname: "n00dles",
        organizationName: "Noodle Bar",
        maxRam: 4,
        moneyAvailable: 70_000,
        moneyMax: 1_750_000,
        hackDifficulty: 1.2,
        minDifficulty: 1,
        baseDifficulty: 1,
        requiredHackingSkill: 1,
        serverGrowth: 3_000,
        numOpenPortsRequired: 0,
        hasAdminRights: true,
        serversOnNetwork: ["home"],
      }),
      run4theh111z: server({
        hostname: "run4theh111z",
        maxRam: 512,
        moneyAvailable: 0,
        numOpenPortsRequired: 4,
        openPortCount: 2,
        ftpPortOpen: true,
        httpPortOpen: true,
        requiredHackingSkill: 505,
        serversOnNetwork: ["home"],
      }),
      "hacknet-server-0": { ctor: "HacknetServer", data: {
        hostname: "hacknet-server-0", maxRam: 8, cpuCores: 3, level: 42, cache: 4,
        totalHashesGenerated: 1234, onlineTimeSeconds: 5678, hasAdminRights: true,
      } },
      darkweb: { ctor: "DarknetServer", data: {
        hostname: "darkweb", ip: "10.20.30.41", maxRam: 16, hasAdminRights: true,
        serversOnNetwork: ["home"],
      } },
      "dnet-movable": { ctor: "DarknetServer", data: {
        hostname: "dnet-movable", ip: "10.20.30.42", maxRam: 8,
        serversOnNetwork: ["darkweb"],
      } },
    },
  );

  return JSON.stringify({
    ctor: "BitburnerSaveObject",
    data: {
      PlayerSave: JSON.stringify({ ctor: "PlayerObject", data: player }),
      AllServersSave: JSON.stringify(servers),
      FactionsSave: JSON.stringify({
        CyberSec: { favor: 20, playerReputation: 1_000_000, discovery: "known" },
        "Slum Snakes": { discovery: "known" },
      }),
      CompaniesSave: JSON.stringify({ "Noodle Bar": { favor: 100, playerReputation: 100_000 } }),
      AliasesSave: "{}",
      GlobalAliasesSave: "{}",
      VersionSave: JSON.stringify(51),
      ...(options.stockMarket !== undefined ? { StockMarketSave: JSON.stringify(options.stockMarket) } : {}),
    },
  });
}

describe("save wrapper unwrapping", () => {
  test("turns JSONMap and JSONSet back into collections", () => {
    const value = unwrap({ ctor: "JSONMap", data: [[4, 3]] });
    expect(value).toBeInstanceOf(Map);
    expect((value as Map<number, number>).get(4)).toBe(3);
    expect(unwrap({ ctor: "JSONSet", data: ["a"] })).toBeInstanceOf(Set);
  });

  test("flattens class wrappers but keeps the constructor name", () => {
    const value = unwrap({ ctor: "Server", data: { hostname: "home" } }) as Record<string, unknown>;
    expect(value["hostname"]).toBe("home");
    expect(value["__ctor"]).toBe("Server");
  });

  test("a __proto__ key does not reach Object.prototype", () => {
    const raw = JSON.parse('{"__proto__":{"ctor":"Server","data":{"hostname":"x"}}}') as unknown;
    unwrap(raw);
    expect(({} as Record<string, unknown>)["hostname"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("hostname");
  });
});

describe("decoding a save", () => {
  const snapshot = decodeSaveJson(buildSaveJson());

  test("reads the version and BitNode", () => {
    expect(snapshot.version).toBe(51);
    expect(snapshot.bitNode).toBe(1);
  });

  test("decodes the double-encoded sub-saves", () => {
    expect(snapshot.player.money).toBe(1_234_567);
    expect(snapshot.player.skills["hacking"]).toBe(812);
    expect(snapshot.player.augmentations).toHaveLength(2);
    expect(snapshot.player.factions).toEqual(["CyberSec", "NiteSec", "Sector-12"]);
  });

  test("keeps a __proto__ hostname as an ordinary server", () => {
    expect(snapshot.servers.has("__proto__")).toBe(true);
    expect(snapshot.servers.get("__proto__")?.maxRam).toBe(4);
    // The field is absent in this sparse fixture, so decoding must restore the
    // Server class default rather than make it rootable without port openers.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/Server.ts#L43-L75
    expect(snapshot.servers.get("__proto__")?.numOpenPortsRequired).toBe(5);
    // And the Map is genuinely unpolluted.
    expect(snapshot.servers.get("home")?.maxRam).toBe(64);
  });

  test("applies class defaults to absent server keys", () => {
    // run4theh111z declares no serverGrowth/minDifficulty in the fixture.
    const server = snapshot.servers.get("run4theh111z")!;
    expect(server.serverGrowth).toBe(1);
    expect(server.minDifficulty).toBe(1);
    expect(server.cpuCores).toBe(1);
    expect(server.hasAdminRights).toBe(false);
  });

  test("recomputes ramUsed, which the save never stores", () => {
    // 3.6 + 10 * 1.75 = 21.1
    expect(snapshot.servers.get("home")?.ramUsed).toBeCloseTo(21.1, 6);
    expect(snapshot.servers.get("n00dles")?.ramUsed).toBe(0);
  });

  test("reads faction and company standings from their own saves", () => {
    // NOT from PlayerSave — a parser that looks there finds nothing.
    expect(snapshot.factions["CyberSec"]?.playerReputation).toBe(1_000_000);
    expect(snapshot.factions["CyberSec"]?.favor).toBe(20);
    expect(snapshot.factions["Slum Snakes"]?.playerReputation).toBeUndefined();
    expect(snapshot.companies["Noodle Bar"]?.playerReputation).toBe(100_000);
  });

  test("detects started mechanics from their null-or-object slots", () => {
    expect(snapshot.player.hasGang).toBe(false);
    expect(snapshot.player.hasCorporation).toBe(false);
    expect(snapshot.player.hasBladeburner).toBe(true);
    expect(snapshot.player.bladeburnerRank).toBe(40);
    expect(snapshot.player.sleeveCount).toBe(2);
  });

  test("merges source-file overrides into activeSourceFiles", () => {
    // activeSourceFiles is a getter and is never stored.
    const overridden = decodeSaveJson(
      buildSaveJson({ sourceFiles: [[1, 3], [4, 3]], sourceFileOverrides: [[4, 1]] }),
    );
    expect(overridden.sourceFiles).toEqual({ "1": 3, "4": 3 });
    expect(overridden.activeSourceFiles).toEqual({ "1": 3, "4": 1 });

    // An override of 0 means "not active", not "present at zero".
    const suppressed = decodeSaveJson(
      buildSaveJson({ sourceFiles: [[1, 3], [4, 3]], sourceFileOverrides: [[4, 0]] }),
    );
    expect(suppressed.activeSourceFiles).toEqual({ "1": 3 });
  });

  test("rejects anything that is not a Bitburner save", () => {
    expect(() => decodeSaveJson("{}")).toThrow(SaveFormatError);
    expect(() => decodeSaveJson("not json")).toThrow(SaveFormatError);
    expect(() => decodeSaveJson(JSON.stringify({ ctor: "Something", data: {} }))).toThrow(SaveFormatError);
  });
});

describe("save file encodings", () => {
  const json = buildSaveJson();

  test("reads the gzip format Export Game writes", () => {
    const bytes = Bun.gzipSync(new TextEncoder().encode(json));
    expect(decodeSaveData(bytes)).toBe(json);
    expect(prepareIndexedDbSave(bytes)).toEqual({ storage: "binary", bytes });
  });

  test("reads the base64 fallback format", () => {
    const bytes = new TextEncoder().encode(Buffer.from(json, "utf8").toString("base64"));
    expect(decodeSaveData(bytes)).toBe(json);
    expect(prepareIndexedDbSave(bytes)).toEqual({ storage: "text", bytes });
  });

  test("reads the Steam Cloud format", () => {
    const gz = Bun.gzipSync(new TextEncoder().encode(json));
    const bytes = new TextEncoder().encode(Buffer.from(gz).toString("base64"));
    expect(decodeSaveData(bytes)).toBe(json);
    expect(prepareIndexedDbSave(bytes)).toEqual({ storage: "binary", bytes: new Uint8Array(gz) });
  });

  test("explains itself when handed an already-decompressed save", () => {
    const bytes = new TextEncoder().encode(json);
    expect(() => decodeSaveData(bytes)).toThrow(/original/);
  });
});

describe("seeding a simulation from a save", () => {
  const seed = saveToSeed(decodeSaveJson(buildSaveJson({ sourceFiles: [[1, 3]] })));

  test("carries live server state rather than base metadata", () => {
    const n00dles = seed.servers.find((s) => s.hostname === "n00dles")!;
    // Grown/weakened values are taken as they stand — deriving them from base
    // metadata would rewind the save to a fresh game.
    expect(n00dles.moneyAvailable).toBe(70_000);
    expect(n00dles.moneyMax).toBe(1_750_000);
    expect(n00dles.hackDifficulty).toBe(1.2);
    expect(n00dles.hasAdminRights).toBe(true);
  });

  test("preserves occupied RAM instead of granting fabricated capacity", () => {
    expect(seed.servers.find((server) => server.hostname === "home")?.ramUsed).toBeCloseTo(21.1, 6);
    expect(seed.servers.find((server) => server.hostname === "n00dles")?.ramUsed).toBe(0);
  });

  test("uses the save's own topology", () => {
    expect(seed.topology["home"]).toContain("n00dles");
    expect(seed.topology["n00dles"]).toEqual(["home"]);
    expect(seed.topology["home"]).toContain("darkweb");
    expect(seed.topology["darkweb"]).toEqual(["home"]);
    expect(seed.servers.find((server) => server.hostname === "darkweb")?.simKind).toBe("DarknetServer");
  });

  test("rejects saves connected to an unsupported movable darknet server", () => {
    const connectedToDarknet = decodeSaveJson(buildSaveJson({ currentServer: "dnet-movable" }));
    expect(() => saveToSeed(connectedToDarknet)).toThrow("movable darknet terminal state is not modeled");
  });

  test("normalizes resumable class and program work without losing effective progress", () => {
    const classSave = decodeSaveJson(buildSaveJson({
      currentWork: { ctor: "ClassWork", data: { classType: "Algorithms", location: "Rothman University", cyclesWorked: 12 } },
    }));
    expect(classSave.player.currentWork).toEqual({
      kind: "class", subject: "Algorithms", workType: "Algorithms", cyclesWorked: 12, ctor: "ClassWork",
    });

    const programSave = decodeSaveJson(buildSaveJson({
      currentWork: { ctor: "CreateProgramWork", data: { programName: "BruteSSH.exe", cyclesWorked: 50, unitCompleted: 12_345 } },
    }));
    expect(programSave.player.currentWork).toEqual({
      kind: "createProgram", subject: "BruteSSH.exe", cyclesWorked: 50, unitCompleted: 12_345, ctor: "CreateProgramWork",
    });
  });

  test("keeps hacknet servers in the fleet and preserves their economy", () => {
    expect(seed.servers.some((s) => s.hostname === "hacknet-server-0")).toBe(true);
    expect(seed.servers.some((s) => s.hostname === "home")).toBe(true);
    expect(seed.hacknet.nodes[0]).toMatchObject({
      hostname: "hacknet-server-0", level: 42, ram: 8, cores: 3, cache: 4,
      totalProduction: 1234, onlineTimeSeconds: 5678,
    });
    expect(seed.hacknet.hashes).toBe(37);
    expect(seed.hacknet.hashLevels["Sell for Money"]).toBe(2);
  });

  test("preserves the exact independently serialized port flags", () => {
    const target = seed.servers.find((s) => s.hostname === "run4theh111z")!;
    expect(target.openPortCount).toBe(2);
    expect([target.sshPortOpen, target.ftpPortOpen, target.smtpPortOpen, target.httpPortOpen]).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  test("derives home spec, money and the capability gates", () => {
    expect(seed.homeRam).toBe(64);
    expect(seed.homeCores).toBe(4);
    expect(seed.servers.find((server) => server.hostname === "home")?.ip).toBe("10.20.30.40");
    expect(seed.servers.find((server) => server.hostname === "home")?.isConnectedTo).toBe(true);
    expect(seed.currentServer).toBe("home");
    expect(seed.hasTor).toBe(true);
    expect(seed.startingMoney).toBe(1_234_567);
    expect(seed.bitnode).toBe(1);
    expect(seed.sourceFileLevel).toBe(3);
    expect(seed.gates.hasWseAccount).toBe(true);
    expect(seed.gates.inBladeburner).toBe(true);
    expect(seed.gates.inGang).toBe(false);
  });

  test("carries the player's real skills and multipliers", () => {
    expect(seed.person.skills["hacking"]).toBe(812);
    expect(seed.person.mults["hacking"]).toBe(1.5);
    expect(seed.person.hp).toEqual({ current: 7, max: 20 });
    expect(seed.playerState.entropy).toBe(2);
    expect(seed.playerState.exploits).toEqual(["Bypass", "N00dles"]);
    expect(seed.playerState.persistentIntelligenceExp).toBe(1_234);
  });

  test("carries every non-Person field needed by faction requirements", () => {
    expect(seed.playerState.factionInvitations).toEqual(["Tetrads", "Chongqing"]);
    expect(seed.playerState.augmentations).toHaveLength(2);
    expect(seed.playerState.queuedAugmentations).toEqual([{ name: "PCMatrix", level: 1 }]);
    expect(seed.playerState.sourceFiles).toEqual({ "1": 3 });
    expect(seed.playerState.ownedSourceFiles).toEqual({ "1": 3 });
    expect(seed.factions["CyberSec"]).toEqual({ rep: 1_000_000, favor: 20 });
    expect(seed.companies["Noodle Bar"]).toEqual({ rep: 100_000, favor: 100 });
    expect(seed.bladeburnerRank).toBe(40);
    expect(seed.homeFiles).toEqual(["NUKE.exe", "BruteSSH.exe", "hackers-starting-handbook.lit", "j0.msg", "saved.cct"]);
    expect(seed.servers.find((server) => server.hostname === "home")?.contractFiles).toEqual(["saved.cct"]);
    expect(seed.playtimeSinceLastAug).toBe(3_600_000);
    expect(seed.playtimeSinceLastBitnode).toBe(7_200_000);
    expect(seed.totalPlaytime).toBe(99_000_000);
    expect(seed.sleeveCount).toBe(2);
    expect(seed.version).toBe(51);
    expect(seed.servers.find((server) => server.hostname === "n00dles")?.organizationName).toBe("Noodle Bar");
  });

  test("rejects save schemas other than the pinned game version", () => {
    const stale = decodeSaveJson(buildSaveJson());
    stale.version = 50;
    expect(() => saveToSeed(stale)).toThrow("expected 51");
  });

  test("preserves gang identity, focus, current work progress, and stock state", () => {
    const detailed = decodeSaveJson(buildSaveJson({
      gang: { ctor: "Gang", data: { facName: "Slum Snakes" } },
      focus: true,
      currentWork: { ctor: "CrimeWork", data: { crimeType: "Homicide", cyclesWorked: 12, unitCompleted: 400 } },
      stockMarket: {
        ECorp: { ctor: "Stock", data: { symbol: "ECP", price: 12_345, playerShares: 77, playerAvgPx: 12_000 } },
        Orders: { ECP: [{ shares: 5 }] }, storedCycles: 19, lastUpdate: 123, ticksUntilCycle: 7,
      },
    }));
    expect(detailed.player.gangFaction).toBe("Slum Snakes");
    expect(detailed.player.focus).toBe(true);
    expect(detailed.player.currentWork).toMatchObject({
      kind: "crime", subject: "Homicide", cyclesWorked: 12, unitCompleted: 400,
    });
    expect(detailed.stockMarket).toMatchObject({ storedCycles: 19, ticksUntilCycle: 7, hasOrders: true });
    expect(detailed.stockMarket?.stocks["ECorp"]).toMatchObject({ symbol: "ECP", price: 12_345, playerShares: 77 });

    const seed = saveToSeed(detailed);
    expect(seed.playerState.gangFaction).toBe("Slum Snakes");
    expect(seed.playerState.focus).toBe(true);
    expect(seed.currentWork?.kind).toBe("crime");
    expect(seed.stockMarket?.stocks["ECorp"]?.["price"]).toBe(12_345);
  });

  test("maps reset ages to virtual wall time and invalidates unsupported saved state", async () => {
    let progression: { lastAugReset?: number; lastNodeReset?: number } | undefined;
    const result = await runGame({
      goal: parseGoals(["earn:1e99"]),
      seed: 1,
      horizonMs: 2_000,
      save: seed,
      features: only("hacking", "progression"),
      onRecord: (line) => {
        const record = JSON.parse(line) as { kind: string; key?: string; data?: unknown };
        if (record.kind === "state" && record.key === "progression") progression = record.data as typeof progression;
      },
    });

    expect(progression?.lastAugReset).toBe(DEFAULT_EPOCH_MS - 3_600_000);
    expect(progression?.lastNodeReset).toBe(DEFAULT_EPOCH_MS - 7_200_000);
    expect(result.unmodeled["initial-state running scripts"]).toBe(1);
    expect(result.unmodeled["initial-state coding contracts"]).toBe(1);
    expect(result.validity).toBe("invalid-for-goal");
  });
});
