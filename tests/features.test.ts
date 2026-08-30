import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { changedMultipliers, DEFAULT_BITNODE_MULTIPLIERS } from "../shared/features/bitnode.ts";
import { FEATURE_IDS, type FeatureId } from "../shared/features/ids.ts";
import { FEATURES, featureForBitNode } from "../shared/features/registry.ts";
import { capsDelta, deriveCapabilities, unknownCapabilities } from "../shared/features/unlock.ts";
import { MS_PER_TICK } from "../shared/strategy/stock/market.ts";
import {
  FEATURE_DRIVERS,
  FEATURE_MODULES,
  resetAllFeatures,
  selectDue,
} from "../game/lib/features/index.ts";
import { PROBE_EVERY_TICKS, TICK_MS } from "../game/lib/controller.ts";
import { purchasableAugmentation } from "../game/lib/features/remaining.ts";
import { sleeveView } from "../game/lib/features/sleeves.ts";
import { NEUROFLUX } from "../shared/strategy/factions/augs.ts";
import {
  ALL_PROBES,
  DIRECT_PROBES,
  PRICED_PROBES,
  LOCAL_PROBES,
  probeCadenceMs,
} from "../game/lib/probes/index.ts";
import { probeCtx } from "./support/probe-fixture.ts";
import { TABS } from "../ui/app/tabs/index.ts";
import type { GameState } from "../game/lib/state.ts";

const root = resolve(import.meta.dir, "..");
const nsDefs = readFileSync(resolve(root, "types/NetscriptDefinitions.d.ts"), "utf8");

/** A minimal real store for the reset-walk tests. */
function freshState(): GameState {
  return {
    topics: {},
    dirty: new Set(),
    mirrors: {},
    mirrorDirty: new Set(),
    probeFailures: {},
    featureLastRun: {},
  };
}

describe("feature registry", () => {
  test("every feature id has exactly one registry entry", () => {
    expect(FEATURES.map((f) => f.id).sort()).toEqual([...FEATURE_IDS].sort());
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
  });

  test("every feature has a tab, and every tab a feature", () => {
    for (const feature of FEATURES) {
      const tab = TABS[feature.id];
      expect(tab, `no tab for feature ${feature.id}`).toBeDefined();
      expect(tab.id).toBe(feature.id);
    }
    // Overview is the only tab without a feature.
    const extra = Object.keys(TABS).filter((id) => id !== "overview" && !FEATURE_IDS.includes(id as FeatureId));
    expect(extra).toEqual([]);
  });

  test("every feature owns at least one topic", () => {
    for (const feature of FEATURES) {
      expect(feature.topics.length, `${feature.id} owns no topic`).toBeGreaterThan(0);
    }
  });

  test("no BitNode is themed by two features", () => {
    const seen = new Map<number, FeatureId>();
    for (const feature of FEATURES) {
      for (const n of feature.bitnodes) {
        expect(seen.has(n), `BN${n} claimed by ${seen.get(n)} and ${feature.id}`).toBe(false);
        seen.set(n, feature.id);
      }
    }
    for (const n of seen.keys()) expect(featureForBitNode(n)).toBeDefined();
  });
});

describe("bitnode reference data", () => {
  test("changedMultipliers reports only true deviations", () => {
    expect(changedMultipliers(undefined)).toEqual([]);
    const active = { ...DEFAULT_BITNODE_MULTIPLIERS, ScriptHackMoney: 0.2 };
    expect(changedMultipliers(active)).toEqual([
      // Each deviation carries its facet, so a panel can group and colour it
      // without a second lookup table.
      { field: "ScriptHackMoney", value: 0.2, base: 1, group: "hacking", harderWhen: "lower", harder: true },
    ]);
    // A BitNode that leaves DaedalusAugsRequirement at 30 has not changed it.
    expect(changedMultipliers({ ...DEFAULT_BITNODE_MULTIPLIERS })).toEqual([]);
  });
});

describe("capability derivation", () => {
  test("nothing probed yields unknown everywhere, never a false lock", () => {
    const caps = unknownCapabilities();
    for (const id of FEATURE_IDS) {
      // The always-on features are known without any reading. `stock` is one of
      // them: the market is MONEY-gated, not capability-gated — a WSE account
      // costs $200m and the TIX API $5b, with no source file and no BitNode
      // requirement — so the account flags travel as ordinary state on the topic
      // and the driver buys its own way in.
      if (["progression", "hacking", "career", "hacknet", "side", "stock"].includes(id)) {
        expect(caps.unlocked[id]).toBe("yes");
      } else {
        expect(caps.unlocked[id], `${id} should be unknown, not locked`).toBe("unknown");
      }
    }
  });

  test("fresh BN1 locks the node-gated features with a reason", () => {
    const caps = deriveCapabilities({
      bitNode: 1,
      sourceFiles: {},
      inGang: false,
      inBladeburner: false,
      hasCorporation: false,
      canSelfFundCorporation: "NoSf3OrDisabled",
      canSeedFundCorporation: "NoSf3OrDisabled",
      hasWseAccount: false,
      hasTixApiAccess: false,
      goPlayable: true,
    });
    expect(caps.unlocked.gang).toBe("no");
    expect(caps.unlocked.corp).toBe("no");
    expect(caps.unlocked.sleeves).toBe("no");
    expect(caps.unlocked.factions).toBe("no");
    expect(caps.unlocked.go).toBe("yes");
    for (const id of FEATURE_IDS) {
      if (caps.unlocked[id] !== "yes") expect(caps.reason[id], `${id} locked without a reason`).toBeTruthy();
    }
  });

  test("being in the BitNode unlocks it just like holding the source file", () => {
    expect(deriveCapabilities({ bitNode: 10, sourceFiles: {} }).unlocked.sleeves).toBe("yes");
    expect(deriveCapabilities({ bitNode: 1, sourceFiles: { "10": 1 } }).unlocked.sleeves).toBe("yes");
    expect(deriveCapabilities({ bitNode: 1, sourceFiles: { "4": 3 } }).unlocked.factions).toBe("yes");
    expect(deriveCapabilities({ bitNode: 1, sourceFiles: {} }).unlocked.factions).toBe("no");
  });

  test("an in-gang reading beats the BitNode test", () => {
    // SF2 plus karma grants a gang outside BN2, which is why gang uses the
    // live inGang() flag rather than a node check.
    expect(deriveCapabilities({ bitNode: 1, sourceFiles: { "2": 1 }, inGang: true }).unlocked.gang).toBe("yes");
  });

  test("corporation creation access is distinct from corporation ownership", () => {
    const seed = deriveCapabilities({
      bitNode: 3,
      sourceFiles: {},
      hasCorporation: false,
      canSelfFundCorporation: "Success",
      canSeedFundCorporation: "Success",
    });
    expect(seed.unlocked.corp).toBe("yes");
    expect(seed.corporation.exists).toBe("no");
    expect(seed.corporation.seedFundCheck).toBe("Success");

    const disabled = deriveCapabilities({
      bitNode: 3,
      sourceFiles: {},
      hasCorporation: false,
      canSelfFundCorporation: "NoSf3OrDisabled",
      canSeedFundCorporation: "NoSf3OrDisabled",
    });
    expect(disabled.unlocked.corp).toBe("no");
  });
});

/** A value that satisfies whatever a probe body does to it: callable, any
 * property, iterable, array-like, number-coercible. Probe bodies are only
 * exercised for the SHAPE of what they emit, never for correct values, so a
 * self-similar stand-in beats hand-writing an ns mock per feature.
 *
 * The target must be an arrow function: a normal function has a
 * non-configurable `prototype`, which trips the proxy invariant as soon as a
 * body calls Object.keys/entries on a result. */
function universal(): never {
  const target = (() => {}) as never;
  return new Proxy(target, {
    apply: () => universal(),
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
    get(_target, prop) {
      if (prop === Symbol.iterator) {
        return function* () {
          yield universal();
          yield universal();
        };
      }
      if (prop === Symbol.toPrimitive) return () => 1;
      // Must not look like a promise, or `await` would hang on it.
      if (prop === "then" || prop === "constructor") return undefined;
      if (prop === "length") return 2;
      if (prop === "map") return (fn: (v: unknown, i: number) => unknown) => [fn(universal(), 0), fn(universal(), 1)];
      if (prop === "slice" || prop === "filter" || prop === "sort" || prop === "concat") return () => [universal()];
      if (prop === "toFixed") return () => "1";
      return universal();
    },
  }) as never;
}

const probeContext = {
  player: {
    factions: ["CyberSec"],
    jobs: { ECorp: "Software" },
    karma: -1,
    numPeopleKilled: 0,
    skills: {},
    exp: {},
    city: "Sector-12",
    location: "home",
    entropy: 0,
    totalPlaytime: 1,
  },
  servers: {
    home: { hostname: "home", maxRam: 64, ramUsed: 8, cpuCores: 1, hasAdminRights: true, purchasedByPlayer: false },
  },
  caps: deriveCapabilities({ bitNode: 1 }),
  state: freshState(),
  // Every priced read a probe makes goes through here, so the universal proxy
  // answers the whole table at once. `enums` carries one real faction: the
  // loops that walk FactionName must actually iterate, or the probes that
  // depend on them would pass by emitting nothing.
  nsp: async () => universal(),
  enums: { FactionName: { CyberSec: "CyberSec" } },
} as never;

async function runAllProbes(): Promise<{
  emissions: Map<string, { key: string; data: unknown }[]>;
  threw: string[];
}> {
  const emissions = new Map<string, { key: string; data: unknown }[]>();
  const threw: string[] = [];
  for (const probe of [...LOCAL_PROBES, ...DIRECT_PROBES, ...PRICED_PROBES]) {
    try {
      let emitted: { key: string; data: unknown }[];
      // The Go probe intentionally validates the game's finite board sizes;
      // the generic two-element proxy is not a legal board fixture.
      const stubNs = probe.id === "go.board"
        ? ({ go: { getBoardState: () => Array<string>(5).fill("....."), getMoveHistory: () => [] } } as never)
        : universal();
      if (probe.kind === "local") {
        emitted = probe.run(probeContext);
      } else if (probe.kind === "direct") {
        emitted = probe.run(stubNs, probeContext);
      } else {
        emitted = await probe.run(probeContext);
      }
      emissions.set(probe.id, emitted);
    } catch (error) {
      threw.push(`${probe.id}: ${String(error).slice(0, 120)}`);
    }
  }
  return { emissions, threw };
}

describe("probe table", () => {
  const allProbes = [...LOCAL_PROBES, ...DIRECT_PROBES, ...PRICED_PROBES];

  test("probe ids are unique", () => {
    expect(new Set(allProbes.map((p) => p.id)).size).toBe(allProbes.length);
  });

  test("every ns method a direct probe declares exists in the type definitions", () => {
    // Priced probes name their members as typed `ctx.nsp` paths, so a typo
    // there is a compile error. A DIRECT probe still declares a `methods` list
    // — the runner re-prices it against the live API and refuses the call if
    // anything in it stopped being free — and a typo in THAT is silent: the
    // price lookup throws, the runner reports drift, and the probe never runs.
    // Both halves of a dotted name are checked: the namespace must be a real
    // property of the NS interface, and the leaf a declared method somewhere.
    const names = DIRECT_PROBES.flatMap((probe) => probe.methods);
    const missing: string[] = [];
    for (const name of names) {
      const segments = name.split(".");
      const leaf = segments[segments.length - 1]!;
      // Namespaces are declared `readonly gang: Gang;` on the NS interface.
      if (segments.length > 1 && !new RegExp(`^\\s*(readonly\\s+)?${segments[0]}:\\s*\\w`, "m").test(nsDefs)) {
        missing.push(`${name} (no ns.${segments[0]} namespace)`);
        continue;
      }
      if (!new RegExp(`(^|\\s)${leaf}\\s*[(<]`, "m").test(nsDefs)) missing.push(`${name} (no such method)`);
    }
    expect(missing).toEqual([]);
  });

  test("the Go score has exactly one producer", () => {
    // The score is an exact function of the board. When the 2 s core probe
    // also read it from the game, its clock and the board's clock disagreed,
    // so a probe firing between our move landing and White replying published
    // a score one stone ahead of the position shown beside it.
    const core = DIRECT_PROBES.find((probe) => probe.id === "go.core");
    expect(core).toBeDefined();
    expect(core!.methods).toContain("go.getGameState");
    const emitted = core!.run({
      go: {
        getGameState: () => ({ currentPlayer: "Black", whiteScore: 99, blackScore: 99, komi: 5.5, bonusCycles: 0 }),
        getOpponent: () => "Netburners",
        analysis: { getStats: () => ({}) },
      },
    } as never, probeContext);
    const data = emitted[0]?.data as Record<string, unknown>;
    expect(data).toBeDefined();
    expect(data).not.toHaveProperty("blackScore");
    expect(data).not.toHaveProperty("whiteScore");
    // Komi is immutable opponent metadata, not board-derived, so it stays.
    expect(data["komi"]).toBe(5.5);
  });

  test("every feature with a topic is reachable by some probe", () => {
    const probed = new Set(allProbes.map((p) => p.feature));
    // Every feature except those with no ns surface must have a probe.
    for (const feature of FEATURES) {
      expect(probed.has(feature.id), `${feature.id} has no probe`).toBe(true);
    }
  });

  test("no probe's declared cadence is silently coarsened by the caller", () => {
    // Acquisition cadence must honor each probe's declared `everyMs` without a
    // coarser caller-imposed floor.
    // five and measured volatility 3.5x too high off the aliased samples.
    //
    // So the controller derives its interval FROM the table instead of choosing
    // one, and this pins that: whatever the fastest probe asks for, the caller
    // runs at least that often. `everyMs` is the sole authority on cadence.
    const fastest = probeCadenceMs(ALL_PROBES);
    expect(fastest).toBeGreaterThan(0);
    expect(PROBE_EVERY_TICKS * TICK_MS).toBeLessThanOrEqual(fastest);
    // And at least one tick: nothing is read faster than the frame.
    expect(PROBE_EVERY_TICKS).toBeGreaterThanOrEqual(1);
  });

  test("every probe body runs and emits at least one topic", async () => {
    const { emissions, threw } = await runAllProbes();
    expect(threw).toEqual([]);
    for (const probe of allProbes) {
      expect(emissions.get(probe.id)?.length, `${probe.id} emitted nothing`).toBeGreaterThan(0);
    }
  });

  test("no two probes on one topic write the same field", async () => {
    // Topic merges are SHALLOW (`{...prev, ...next}`), so when a fast `core`
    // probe and a slow detail probe both write a field, the faster one wins
    // and silently replaces real data with whatever it could afford — a panel
    // that blanks on a cadence rather than an error. Asserted by actually
    // running the bodies: reading the source cannot see shorthand emits.
    //
    // Exception: a probe MAY rewrite a field if it republishes the complete
    // value. hacking.cloud rebuilds the whole FleetRollup through fleetFrom,
    // and `joined` is the same Player-derived list wherever it appears.
    const SHARED_OK = new Set(["fleet:*", "factions:joined"]);
    const { emissions } = await runAllProbes();
    const owners = new Map<string, Set<string>>();
    for (const [id, emitted] of emissions) {
      for (const { key, data } of emitted) {
        if (SHARED_OK.has(`${key}:*`)) continue;
        for (const field of Object.keys(data as object)) {
          const owned = `${key}:${field}`;
          if (SHARED_OK.has(owned)) continue;
          owners.set(owned, (owners.get(owned) ?? new Set()).add(id));
        }
      }
    }
    const contested = [...owners.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([field, ids]) => `${field} written by ${[...ids].join(" and ")}`);
    expect(contested).toEqual([]);
  });
});

function pricedProbe(id: string) {
  const found = PRICED_PROBES.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing priced probe ${id}`);
  return found;
}

describe("v3.0.1 feature observation contracts", () => {
  test("the fast fleet probe preserves cloud limits between priced observations", () => {
    const state = freshState();
    state.topics.fleet = {
      rootedHosts: 1,
      totalHosts: 1,
      maxRam: 8,
      usedRam: 0,
      portOpeners: 0,
      purchased: { count: 0, totalRam: 0, limit: 25, maxRamPerServer: 1_048_576 },
      home: { maxRam: 8, usedRam: 0, cores: 1 },
    };
    const probe = LOCAL_PROBES.find((entry) => entry.id === "hacking.fleet")!;
    const servers = {
      home: {
        hostname: "home",
        hasAdminRights: true,
        maxRam: 8,
        ramUsed: 0,
        cpuCores: 1,
        purchasedByPlayer: true,
        openPortCount: 0,
      },
    };

    const [emission] = probe.run({
      servers: servers as never,
      state,
      player: {} as never,
      caps: unknownCapabilities(),
    } as never);

    expect((emission.data as { purchased: unknown }).purchased).toEqual({
      count: 0,
      totalRam: 0,
      limit: 25,
      maxRamPerServer: 1_048_576,
    });
  });

  test("Bladeburner reads exact rank gain and Black Op rank gates", async () => {
    const probe = pricedProbe("bladeburner.actions");
    const [emission] = await probe.run(probeCtx({
      "bladeburner.getContractNames": () => [],
      "bladeburner.getOperationNames": () => [],
      "bladeburner.getBlackOpNames": () => ["Operation Typhoon"],
      "bladeburner.getGeneralActionNames": () => [],
      "bladeburner.getActionEstimatedSuccessChance": () => [1, 1],
      "bladeburner.getActionTime": () => 1_000,
      "bladeburner.getActionCountRemaining": () => 1,
      "bladeburner.getActionCurrentLevel": () => 1,
      "bladeburner.getActionMaxLevel": () => 1,
      "bladeburner.getActionRankGain": () => 50,
      "bladeburner.getActionRankLoss": () => 7,
      "bladeburner.getBlackOpRank": () => 2_500,
      "bladeburner.getSkillNames": () => [],
    }));
    expect((emission!.data as { actions: { rankGain: number; rankLoss: number; rankNeeded?: number }[] }).actions[0])
      .toMatchObject({ rankGain: 50, rankLoss: 7, rankNeeded: 2_500 });
  });

  test("gang publishes the source task catalog and usable ascension gain", async () => {
    const probe = pricedProbe("gang.core");
    const gang = {
      "gang.getGangInformation": () => ({
        faction: "Slum Snakes", isHacking: false, respect: 1, respectGainRate: 0, wantedLevel: 1,
        wantedLevelGainRate: 0, wantedPenalty: 1, moneyGainRate: 0, power: 1, territory: 0.1,
        territoryClashChance: 0, territoryWarfareEngaged: false, respectForNextRecruit: 5,
      }),
      "gang.getMemberNames": () => ["m"],
      "gang.getMemberInformation": () => ({
        name: "m", task: "Mug People", earnedRespect: 0, respectGain: 2, wantedLevelGain: 0.5, moneyGain: 3,
        hack: 1, str: 2, def: 3, dex: 4, agi: 5, cha: 6,
        hack_asc_mult: 1, str_asc_mult: 1, def_asc_mult: 1, dex_asc_mult: 1, agi_asc_mult: 1, cha_asc_mult: 1,
        upgrades: [], augmentations: [],
      }),
      "gang.getAscensionResult": () => ({ respect: 0, hack: 2, str: 1.4, def: 1.3, dex: 1.2, agi: 1.1, cha: 1.5 }),
      "gang.getRecruitsAvailable": () => 0,
      "gang.getTaskNames": () => ["Mug People"],
      "gang.getTaskStats": () => ({
        name: "Mug People", isHacking: false, isCombat: true,
        baseMoney: 1, baseRespect: 2, baseWanted: 3, difficulty: 4,
        hackWeight: 0, strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25, chaWeight: 0,
        territory: { money: 1, respect: 1, wanted: 1 },
      }),
    };
    const [emission] = await probe.run(probeCtx(gang));
    const data = emission.data as { tasks: { name: string }[]; ascensionGain: Record<string, number> };
    expect(data.tasks.map((task) => task.name)).toEqual(["Mug People"]);
    expect(data.ascensionGain.m).toBe(1.1);
  });

  test("Stanek keeps definition shapes and rotates occupied cells", async () => {
    const probe = pricedProbe("stanek.core");
    const fragment = {
      id: 7, type: 1, x: 3, y: 4, rotation: 1, power: 2, limit: 1, effect: "x",
      numCharge: 0, highestCharge: 0, chargedEffect: 0, shape: [[true, false], [true, true]],
    };
    const [emission] = await probe.run(probeCtx({
      "stanek.giftWidth": () => 5,
      "stanek.giftHeight": () => 5,
      "stanek.activeFragments": () => [fragment],
      "stanek.fragmentDefinitions": () => [fragment],
    }));
    const data = emission.data as { occupied: Record<string, number>; availableTypes: { shape: { x: number; y: number }[] }[] };
    expect(data.occupied).toEqual({ "3,4": 7, "4,4": 7, "3,5": 7 });
    expect(data.availableTypes[0]!.shape).toEqual([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]);
  });

  test("sleeve crime rates replace player-effective gains and remain pre-shock", () => {
    const state = freshState();
    state.topics.progression = { bitNode: 1, sourceFiles: {}, multipliers: { CrimeSuccessRate: 1, CrimeMoney: 2, CrimeExpGain: 3 } } as never;
    state.topics.player = { mults: {
      crime_money: 4,
      strength_exp: 5, defense_exp: 5, dexterity_exp: 5, agility_exp: 5,
    } } as never;
    state.topics.career = { crimes: [{
      name: "Test", chance: 1, timeMs: 1_000, money: 800, karma: -2, kills: 1, difficulty: 1,
      weights: { strength: 100 }, exp: { strength: 150, defense: 150, dexterity: 150, agility: 150 },
      moneyPerSec: 800, gainsAreEffective: true,
    }] } as never;
    state.topics.sleeves = { count: 1, sleeves: [{
      index: 0, shock: 50, sync: 50, memory: 1, storedCycles: 0, city: "Sector-12", hp: { current: 1, max: 1 },
      skills: { hacking: 1, strength: 10_000, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      mults: { crime_success: 1, crime_money: 2, strength_exp: 2, defense_exp: 2, dexterity_exp: 2, agility_exp: 2 },
    }] } as never;
    const crime = sleeveView(state)!.tasks.find((task) => task.type === "crime")!;
    const outcome = crime.outcomes[0]!;
    // Experience is pre-shock; crime money, karma, and kills bypass shock.
    expect(outcome.rates.combatSkills).toBe(30);
    expect(outcome.shockExemptRates).toEqual({ money: 400, karma: 1, kills: 1 });
  });
});

describe("feature modules", () => {
  test("every feature id has exactly one module, keyed by its own id", () => {
    expect(Object.keys(FEATURE_MODULES).sort()).toEqual([...FEATURE_IDS].sort());
    for (const id of FEATURE_IDS) {
      expect(FEATURE_MODULES[id].driver.id, `module ${id} holds a driver for another feature`).toBe(id);
    }
  });

  test("drivers are derived from the module registry, in registry order", () => {
    // One list, not two. A second hand-maintained array is exactly how the
    // tab bar, the scheduler and the telemetry drift apart.
    expect(FEATURE_DRIVERS.map((d) => d.id)).toEqual([...FEATURE_IDS]);
  });

  describe("the install barrier's augmentation half", () => {
    /** A state carrying exactly the fields `purchasableAugmentation` reads. */
    function withOffers(
      offers: { name: string; faction: string; price: number; affordableRep: boolean; owned?: boolean }[],
      over: { money?: number; joined?: string[]; ownedAugs?: string[]; prereqs?: Record<string, string[]> } = {},
    ) {
      const state = freshState();
      state.topics.player = { money: over.money ?? 1e12 } as unknown as GameState["topics"]["player"];
      state.topics.factions = {
        joined: over.joined ?? ["CyberSec"],
        ownedAugs: over.ownedAugs ?? [],
        offers: offers.map((offer) => ({ repReq: 0, owned: false, ...offer })),
        ...(over.prereqs
          ? { augMeta: Object.fromEntries(Object.entries(over.prereqs).map(([name, prereqs]) => [name, { prereqs }])) }
          : {}),
      } as unknown as GameState["topics"]["factions"];
      return {
        state,
        caps: unknownCapabilities(),
        now: 0,
        selectedFeatures: new Set(FEATURE_IDS),
        activeFeatures: new Set(FEATURE_IDS),
      };
    }

    const oneOff = { name: "Cranial Signal Processors - Gen I", faction: "CyberSec", price: 1e6, affordableRep: true };

    test("NeuroFlux DOES hold the barrier, and holds it even when already owned", () => {
      // It is the one repeatable augmentation, which invites the assumption that
      // blocking on it can never clear. It can: `getAugCost` scales both its price
      // and its reputation requirement by 1.14 per level, on top of the
      // 1.9-per-queued escalation, so every level bought makes the next strictly
      // dearer in BOTH currencies and the affordable set runs out. Buying as many
      // levels as the cash allows is the POINT of the last-chance drain — money
      // does not survive an install and a permanent multiplier does.
      const offer = { name: NEUROFLUX, faction: "CyberSec", price: 1e6, affordableRep: true };
      expect(purchasableAugmentation(withOffers([offer]))).toBe(NEUROFLUX);
      // Exempt from the owned test, and from that alone: the next level is a fresh
      // purchase, where every other augmentation is bought exactly once.
      expect(purchasableAugmentation(withOffers([{ ...offer, owned: true }]))).toBe(NEUROFLUX);
      // It still has to be affordable, which is what makes the barrier terminate.
      expect(purchasableAugmentation(withOffers([offer], { money: 1 }))).toBeUndefined();
      expect(purchasableAugmentation(withOffers([{ ...offer, affordableRep: false }]))).toBeUndefined();
    });

    test("a one-off augmentation DOES hold it — that is the point", () => {
      expect(purchasableAugmentation(withOffers([oneOff]))).toBe(oneOff.name);
    });

    test("only offers that can actually be BOUGHT count", () => {
      // `factions.offers` spans every faction the node defines, joined or not,
      // filtered only by `owned`. So "affordable by price" alone is nowhere near
      // "can be bought", and each of these would otherwise stall the reset forever.
      expect(purchasableAugmentation(withOffers([oneOff], { money: 1 })), "too expensive").toBeUndefined();
      expect(purchasableAugmentation(withOffers([oneOff], { joined: [] })), "faction not joined").toBeUndefined();
      expect(
        purchasableAugmentation(withOffers([{ ...oneOff, affordableRep: false }])),
        "reputation not met",
      ).toBeUndefined();
      expect(purchasableAugmentation(withOffers([{ ...oneOff, owned: true }])), "already owned").toBeUndefined();
      expect(
        purchasableAugmentation(withOffers([oneOff], { prereqs: { [oneOff.name]: ["Something Else"] } })),
        "prerequisite unowned",
      ).toBeUndefined();
      // ...and with the prerequisite owned it counts again.
      expect(
        purchasableAugmentation(
          withOffers([oneOff], { prereqs: { [oneOff.name]: ["Something Else"] }, ownedAugs: ["Something Else"] }),
        ),
      ).toBe(oneOff.name);
    });

    test("no offers probed yet is not evidence of exhaustion", () => {
      const ctx = withOffers([]);
      delete (ctx.state.topics.factions as { offers?: unknown }).offers;
      expect(purchasableAugmentation(ctx)).toBeUndefined();
    });
  });

  test("reset hooks are registered, not hardcoded in the controller", () => {
    // The property that matters: resetAllFeatures() reaches every module that
    // declares a reset, so adding a feature with cross-run state cannot
    // silently leak it across a BitNode reset because nobody edited the loop.
    const declared = FEATURE_IDS.filter((id) => FEATURE_MODULES[id].reset !== undefined);
    expect(declared, "no module declares a reset — the walk would be vacuous").not.toEqual([]);

    type ResetHook = ((state: GameState, kind: "augmentation" | "bitnode") => void) | undefined;
    const called: FeatureId[] = [];
    const originals = new Map<FeatureId, ResetHook>();
    for (const id of declared) {
      originals.set(id, FEATURE_MODULES[id].reset);
      (FEATURE_MODULES[id] as { reset?: ResetHook }).reset = () => called.push(id);
    }
    try {
      resetAllFeatures(freshState(), "bitnode");
    } finally {
      for (const id of declared) (FEATURE_MODULES[id] as { reset?: ResetHook }).reset = originals.get(id);
    }
    expect(called.sort()).toEqual([...declared].sort());
  });

  test("a node reset clears every feature-published topic, not just module state", () => {
    // A node reset clears every module-published topic so no prior-node state
    // enters the new node's first decisions. Each module
    // clears its own published topics via reset(state).
    const state = freshState();
    state.topics.factions = { joined: ["Daedalus"], ownedAugs: ["The Red Pill"] };
    state.topics.gang = { faction: "x" } as never;
    state.topics.farm = { target: "n00dles" } as never;
    state.topics.fleet = { sharePower: 1 } as never;
    state.topics.progression = {
      bitNode: 2,
      sourceFiles: { "1": 3 },
      ownedAugs: {},
      augCount: 0,
      lastAugReset: 0,
      lastNodeReset: 0,
      multipliers: { ScriptHackMoney: 0.2 },
      plan: {
        phase: "start",
        installWanted: false,
        liquidationWanted: false,
        installBlockers: [],
        installReady: false,
        queuedAugmentations: [],
        install: false,
        favorCrossings: [],
        forecasts: {
          node: { state: "unknown", evaluatedAt: 0, nextRecalibrationAt: 1, basis: "test", reason: "test" },
          install: { state: "unknown", evaluatedAt: 0, nextRecalibrationAt: 1, basis: "test", reason: "test" },
        },
      },
    };
    resetAllFeatures(state, "bitnode");
    expect(state.topics.factions).toBeUndefined();
    expect(state.topics.gang).toBeUndefined();
    expect(state.topics.farm).toBeUndefined();
    expect(state.topics.fleet).toBeUndefined();
    // Field-level for progression: the plan and the multiplier latch are the
    // feature's own; bitNode/sourceFiles were just written by the gate batch
    // that DETECTED the reset and must survive.
    expect(state.topics.progression?.plan).toBeUndefined();
    expect(state.topics.progression?.multipliers).toBeUndefined();
    expect(state.topics.progression?.bitNode).toBe(2);
  });

  test("the controller resets features by registry walk, not by name", () => {
    // The whole point of the registry. Before it existed the loop called
    // resetHackingState() directly, so every new feature meant editing the
    // core loop — and forgetting to meant leaking state across a node reset.
    const controller = readFileSync(resolve(root, "game/lib/controller.ts"), "utf8");
    expect(controller).toContain("resetAllFeatures(state, kind)");
    expect(controller).not.toContain("resetHackingState");
  });

  test("the loop's infrastructure files mention only the features they are allowed to", () => {
    // A drift detector, not a purity claim. The allowed mentions are
    // legitimate and documented; anything else means feature logic has
    // leaked back into always-on infrastructure.
    //   - controller: `progression` is the meta layer (the coordination
    //     digest hangs off its topic, its refresh is deliberately ordered
    //     last, and the route + horizon handed to every driver are read back
    //     off its published plan — the DECISION still lives in the feature
    //     module); `hacking` owns the dispatcher heap that dodge placement
    //     leases.
    //   - fleet: the sweep leases the same heap, and hacking is the fleet's
    //     first customer. It runs unconditionally every sweep, which is
    //     exactly the kind of place feature logic accretes — hence its own
    //     scan rather than an exemption.
    const scans: [string, Set<FeatureId>][] = [
      ["game/lib/controller.ts", new Set<FeatureId>(["progression", "hacking"])],
      ["game/lib/fleet.ts", new Set<FeatureId>(["hacking"])],
    ];
    for (const [file, allowed] of scans) {
      const source = readFileSync(resolve(root, file), "utf8");
      const named = FEATURE_IDS.filter((id) => new RegExp(`\\b${id}\\b`).test(source));
      expect(named.filter((id) => !allowed.has(id)), file).toEqual([]);
    }
  });

  test("feature modules do not declare guessed peak RAM demand", () => {
    for (const module of Object.values(FEATURE_MODULES)) {
      expect(module).not.toHaveProperty('peakStepGb');
      expect(module).not.toHaveProperty('reserveStepGb');
    }
  });
});

describe("feature drivers", () => {
  test("driver cadences are positive", () => {
    for (const driver of FEATURE_DRIVERS) {
      expect(driver.everyMs, `${driver.id} has a non-positive cadence`).toBeGreaterThan(0);
    }
  });

  test("a driver for a gated feature requires that feature", () => {
    // A driver that acts on a locked feature spends a stub launch discovering
    // an API that throws. "Always playable" is not restated here: with nothing
    // probed, unknownCapabilities() reports exactly those as "yes", so this
    // tracks shared/features/unlock.ts instead of drifting from it.
    const unprobed = unknownCapabilities();
    for (const driver of FEATURE_DRIVERS) {
      if (unprobed.unlocked[driver.id] === "yes") continue;
      expect(driver.requires, `${driver.id} runs without a capability gate`).toBe(driver.id);
    }
  });

  test("career automation follows the Singularity capability, not its always-visible strategy feature", () => {
    const career = FEATURE_MODULES.career.driver;
    expect(career.requires).toBe("factions");

    const cold = deriveCapabilities({ bitNode: 1, sourceFiles: {} });
    expect(selectDue([career], {}, cold, 10_000)).toEqual([]);

    const singularity = deriveCapabilities({ bitNode: 1, sourceFiles: { "4": 1 } });
    expect(selectDue([career], {}, singularity, 10_000)).toEqual([career]);
  });

  test("only hacking and stock run faster than the 5 s floor, each for a reason", () => {
    // Hacking keeps a 200ms fallback heartbeat and also wakes at the finer JIT
    // deadlines; slower feature cadences would miss those scheduling windows.
    //
    // `stock` is the one other exception. Its probes stay at 4 s because the
    // market updates every 6 s (4 s while burning stored cycles), while its pure
    // no-4S signal — measured volatility and the estimated forecast — is
    // recovered by observing every tick exactly once. A poller slower than the
    // tick sees only a fraction of the Bernoulli direction samples.
    // The driver itself retries at controller cadence so a plan/claim/action
    // handshake cannot lose a whole market tick to one RAM-grant miss.
    const hacking = FEATURE_DRIVERS.find((d) => d.id === "hacking")!;
    expect(hacking.everyMs).toBe(200);
    const stock = FEATURE_DRIVERS.find((d) => d.id === "stock")!;
    expect(stock.everyMs).toBe(500);
    expect(stock.everyMs).toBeLessThan(MS_PER_TICK);
    // A normal Stanek charge takes 1 s (200 ms while consuming stored cycles).
    // The controller awaits feature drivers serially, so it must remain a
    // deliberately cold action rather than occupying every hot-path pass.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Stanek.ts#L45-L54
    const stanek = FEATURE_DRIVERS.find((d) => d.id === "stanek")!;
    // chargeFragment itself awaits for 1 s, and feature ticks are serial. Keep
    // it off the hot path so Stanek cannot throttle the 200 ms dispatcher.
    expect(stanek.everyMs).toBe(30_000);
    for (const driver of FEATURE_DRIVERS) {
      if (driver.id === "hacking" || driver.id === "stock" || driver.id === "stanek") continue;
      expect(driver.everyMs, `${driver.id} is unexpectedly hot`).toBeGreaterThanOrEqual(5_000);
    }
  });
});

describe("driver scheduling", () => {
  const caps = deriveCapabilities({ bitNode: 1, sourceFiles: {}, inGang: false, goPlayable: true });
  const drivers = [
    { id: "hacking" as FeatureId, everyMs: 200, tick() {} },
    { id: "gang" as FeatureId, everyMs: 1_000, requires: "gang" as FeatureId, tick() {} },
    { id: "go" as FeatureId, everyMs: 1_000, requires: "go" as FeatureId, tick() {} },
  ];

  test("a locked feature never ticks", () => {
    // caps has gang "no" and go "yes" on a fresh BN1.
    const due = selectDue(drivers, {}, caps, 10_000).map((d) => d.id);
    expect(due).toContain("hacking");
    expect(due).toContain("go");
    expect(due).not.toContain("gang");
  });

  test("an unknown feature never ticks either", () => {
    // "we have not looked" is not "you may play it": acting on an unprobed
    // feature spends a stub launch on an API that may throw.
    const due = selectDue(drivers, {}, unknownCapabilities(), 10_000).map((d) => d.id);
    expect(due).toEqual(["hacking"]);
  });

  test("cadence is respected, and a never-run driver is always due", () => {
    // hacking ran 50ms ago against a 200ms cadence: not yet.
    expect(selectDue(drivers, { hacking: 9_950 }, caps, 10_000).map((d) => d.id)).toEqual(["go"]);
    expect(selectDue(drivers, { hacking: 9_800 }, caps, 10_000).map((d) => d.id)).toContain("hacking");
    // Clearing an entry — what an unlock does — makes the driver due at once,
    // instead of waiting out a cadence it was never eligible for.
    expect(selectDue(drivers, { go: 9_999 }, caps, 10_000).map((d) => d.id)).toEqual(["hacking"]);
    expect(selectDue(drivers, {}, caps, 10_000).map((d) => d.id)).toEqual(["hacking", "go"]);
  });
});

describe("capability deltas", () => {
  const fresh = deriveCapabilities({ bitNode: 1, sourceFiles: {}, inGang: false });

  test("only no|unknown -> yes counts as an unlock", () => {
    const withGang = deriveCapabilities({ bitNode: 1, sourceFiles: { "2": 1 }, inGang: true });
    expect(capsDelta(fresh, withGang).unlocked).toContain("gang");
    // The gate finally reporting is information, not a change in what we can
    // play — otherwise every cold boot would look like a wave of unlocks.
    expect(capsDelta(unknownCapabilities(), fresh).unlocked).toEqual([]);
  });

  test("losing a feature is reported separately", () => {
    const withGang = deriveCapabilities({ bitNode: 1, sourceFiles: { "2": 1 }, inGang: true });
    const delta = capsDelta(withGang, fresh);
    expect(delta.locked).toContain("gang");
    expect(delta.unlocked).toEqual([]);
  });

});

describe("feature dodges are centralised and priced", () => {
  test("no feature driver reaches the game except through the ns proxy", () => {
    // main.js is ONE bundle. Bitburner's static analyser charges home for
    // every ns member NAMED anywhere in it, regardless of the receiver — so a
    // dotted `ns.singularity.*` in any driver would bill the whole automation
    // for it whether or not the call ever runs. The proxy's path is a string
    // literal, which the analyser cannot see; that indirection IS the budget,
    // and a driver that steps around it silently blows the 3.6 GB allocation.
    const files = [
      "game/lib/features/factions.ts",
      "game/lib/features/career.ts",
      "game/lib/features/hacknet.ts",
      "game/lib/features/stock.ts",
      "game/lib/features/hacking.ts",
      "game/lib/features/dnet.ts",
      "game/lib/features/remaining.ts",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");
      // `ctx.ns.exec` is the one exception, and it is deliberate: main.js has
      // already paid for `exec` statically, and it is the only ns in the realm
      // that can reach `darkweb` (see tests/dnet-seed-unpinned.test.ts).
      const reaches = source.replace(/ctx\.ns\.exec\b/g, "");
      expect(reaches, `${file} calls ns directly`).not.toMatch(/\bctx\.ns\.[a-z]/);
    }
  });
});
