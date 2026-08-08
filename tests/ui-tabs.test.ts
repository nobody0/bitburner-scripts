import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { FEATURES } from "../shared/features/registry.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import type { StateKey, StateMap } from "../shared/telemetry/state-map.ts";
import { appendRecords, project, emptyState, EVENT_RING, SERIES_LIMIT, type ProjectedState } from "../ui/app/project.ts";
import { NO_SORT, setView, sortOf, toggleSort } from "../ui/app/lib/viewstate.ts";
import { groupRequests } from "../ui/app/tabs/career.ts";
import { DEFAULT_BITNODE_MULTIPLIERS } from "../shared/features/bitnode.ts";
import { skillFromExp } from "../shared/formulas.ts";
import { TABS, type TabId } from "../ui/app/tabs/index.ts";

/** Tab renderers are pure string builders (only `mount` touches the DOM), so
 * they can be exercised headlessly. Two passes: against a real recorded run
 * when one exists, and against a synthetic record for every topic so the
 * populated branch of every panel is executed at least once. */

const root = resolve(import.meta.dir, "..");
const runsDir = resolve(root, "runs");
const ALL_TABS = Object.keys(TABS) as TabId[];

function renderAll(state: ProjectedState): void {
  for (const id of ALL_TABS) {
    const html = TABS[id].render(state);
    expect(typeof html, `${id} did not return markup`).toBe("string");
    expect(html.length, `${id} rendered nothing`).toBeGreaterThan(0);
  }
}

describe("tab rendering", () => {
  test("every tab renders with no data at all", () => {
    renderAll(emptyState());
  });

  test("every tab renders against a recorded run", () => {
    const files = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")) : [];
    if (files.length === 0) return; // runs/ is gitignored; skip on a clean checkout
    // Newest file, capped: some runs are tens of megabytes.
    const newest = files.sort().at(-1)!;
    const records: LogRecord[] = readFileSync(resolve(runsDir, newest), "utf8")
      .split("\n")
      .slice(0, 20_000)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LogRecord];
        } catch {
          return []; // last line of a live run can be a partial write
        }
      });
    if (records.length === 0) return;
    const state = project(records, Infinity, {
      id: newest,
      src: records[0]!.src,
      live: false,
      t0: records[0]!.t,
    });
    renderAll(state);
  });

  test("every feature's populated panel renders", () => {
    // One synthetic record per topic, so no panel's data branch is untested
    // just because the local save cannot reach that feature.
    const topics: { [K in StateKey]?: StateMap[K] } = {
      farm: { target: "n00dles", totals: { moneyEarned: 1e6, hacks: 12 }, inFlight: { hack: 1, grow: 2, weaken: 3 }, ramPie: { farm: 10, prep: 5, share: 0, free: 2, reserve: 4 } },
      fleet: { rootedHosts: 3, totalHosts: 9, maxRam: 64, usedRam: 32, purchased: { count: 1, totalRam: 8, limit: 25 }, home: { maxRam: 32, usedRam: 8, cores: 2 }, portOpeners: 2 },
      progression: { bitNode: 12, sourceFiles: { "4": 3 }, ownedAugs: { NeuroFlux: 5 }, augCount: 1, lastAugReset: 1, lastNodeReset: 1, multipliers: { ScriptHackMoney: 0.2 } },
      factions: { joined: ["CyberSec"], standings: [{ name: "CyberSec", rep: 100, favor: 1, favorToDonate: 150 }], invites: ["NiteSec"], favorToDonate: 150, workTypes: { CyberSec: ["hacking"] }, enemies: { CyberSec: [] }, requirements: { NiteSec: [{ type: "skills", skills: { hacking: 200 } }] }, gates: { CyberSec: { joined: true, invited: false, progress: 1, reachable: true, missing: [] }, NiteSec: { joined: false, invited: true, progress: 1, reachable: true, missing: [] }, "The Covenant": { joined: false, invited: false, progress: 0.4, reachable: true, missing: [{ kind: "skill", subject: "agility", target: 850, have: 340, progress: 0.4, owner: "career", reachable: true, why: "needs agility 850" }] }, Illuminati: { joined: false, invited: false, progress: 0, reachable: false, missing: [{ kind: "bitNode", target: 0, have: 0, progress: 0, owner: "progression", reachable: false, why: "wrong BitNode" }] } }, augMeta: { Rootkit: { prereqs: [], mults: { hacking: 1.1 } } }, ownedAugs: ["BitWire"], offers: [{ name: "Rootkit", faction: "CyberSec", price: 1.9e6, basePrice: 1e6, repReq: 100, affordableRep: true, repGap: 0, owned: false }], augTotal: 1, graftable: [{ name: "Rootkit", price: 1e6, timeMs: 6e4 }], plan: { objective: { factions: ["CyberSec"], augmentations: ["Rootkit"], value: 1.5, foreclosed: [{ name: "Volhaven", bannedBy: "Sector-12" }], why: "exact MWIS" }, action: { type: "workForFaction", faction: "CyberSec", workType: "hacking", why: "0.5 rep/sec toward 100" }, alternatives: [{ label: "work NiteSec", value: 0.2, why: "lower rate" }], blockers: [{ faction: "NiteSec", kind: "skill", subject: "hacking", target: 200, have: 50, progress: 0.25, owner: "hacking", reachable: true, why: "needs hacking 200" }], until: { kind: "rep", faction: "CyberSec", target: 100, have: 40, etaSec: 120 }, lastResult: { action: "workForFaction", ok: true, detail: "started", at: 1 }, recommendInstall: { why: "objective owned", augmentations: ["Rootkit"] } } },
      career: { karma: -100, numPeopleKilled: 0, skills: { hacking: 10, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 }, exp: { hacking: 10, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 0 }, city: "Sector-12", location: "home", entropy: 0, totalPlaytime: 1e6, jobs: { ECorp: "Software" }, companies: { ECorp: { rep: 10, favor: 1 } }, currentWork: { type: "CRIME", detail: "Mug" }, crimes: [{ name: "Mug", chance: 0.5, money: 1000, timeMs: 4000, karma: -0.25, moneyPerSec: 125 }] },
      hacknet: { servers: false, numNodes: 2, maxNumNodes: 30, purchaseNodeCost: 1e5, totalProduction: 500, productionPerSec: 1.5, nodes: [{ name: "hacknet-node-0", level: 10, ram: 2, cores: 1, production: 1.5, totalProduction: 500, timeOnline: 3600 }], nextUpgrades: [{ kind: "level", node: 0, cost: 1000 }] },
      stock: { hasWseAccount: true, hasTixApiAccess: true, has4SData: true, has4SDataApi: true, positions: [{ sym: "ECP", price: 100, ask: 100, bid: 100, maxShares: 1e6, shares: 100, avgPx: 90, sharesShort: 0, avgPxShort: 0, value: 10000, costBasis: 9000 }], signals: { ECP: { organization: "ECorp", forecast: 0.6, volatility: 0.01 } }, portfolioValue: 10000, portfolioCost: 9000 },
      gang: { faction: "Slum Snakes", isHacking: false, respect: 100, respectGainRate: 1, wantedLevel: 2, wantedLevelGainRate: 0.1, wantedPenalty: 0.9, moneyGainRate: 500, power: 10, territory: 0.2, territoryClashChance: 0.1, territoryWarfareEngaged: false, respectForNextRecruit: 200, recruitsAvailable: 1, canRecruit: true, members: [{ name: "a", task: "Mug People", earnedRespect: 10, respectGain: 0.5, wantedLevelGain: 0.01, moneyGain: 100, skills: { hack: 1, str: 10, def: 10, dex: 10, agi: 10, cha: 1 }, ascMults: { hack: 1, str: 1, def: 1, dex: 1, agi: 1, cha: 1 }, upgrades: 2, augmentations: 1 }], clashChances: { Tetrads: 0.4 } },
      corp: { name: "Acme", funds: 1e9, revenue: 1e6, expenses: 5e5, public: false, valuation: 1e10, sharePrice: 10, totalShares: 1e9, numShares: 9e8, issuedShares: 0, dividendRate: 0, dividendEarnings: 0, state: "START", divisions: [{ name: "Ag", industry: "Agriculture", awareness: 1, popularity: 1, productionMult: 2, researchPoints: 100, lastCycleRevenue: 1e6, lastCycleExpenses: 5e5, numAdVerts: 1, cities: ["Sector-12"], products: [], maxProducts: 0, offices: [{ city: "Sector-12", size: 9, numEmployees: 9, avgEnergy: 99, avgMorale: 99, jobs: { Operations: 3 } }], warehouses: [{ city: "Sector-12", level: 1, size: 100, sizeUsed: 50, smartSupplyEnabled: true }] }], investmentOffer: { round: 1, funds: 1e9, shares: 1e8 } },
      bladeburner: { rank: 100, skillPoints: 5, stamina: [50, 100], city: "Sector-12", current: { type: "Contract", name: "Tracking", elapsedMs: 1000 }, nextBlackOp: { name: "Operation Typhoon", rank: 2500 }, skills: { "Blade's Intuition": { level: 1, upgradeCost: 3 } }, actions: [{ type: "contract", name: "Tracking", chance: [0.5, 0.7], timeMs: 30000, countRemaining: 100, level: 1, maxLevel: 5 }], cities: [{ name: "Sector-12", population: 1e6, communities: 5, chaos: 10 }] },
      sleeves: { count: 1, sleeves: [{ index: 0, shock: 10, sync: 90, memory: 1, storedCycles: 0, city: "Sector-12", hp: { current: 10, max: 10 }, skills: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1 }, task: { type: "CRIME", detail: "Mug" }, purchasableAugs: [{ name: "BitWire", price: 1e6 }] }] },
      go: { status: "inProgress", currentPlayer: "Black", opponent: "Netburners", boardSize: 5, board: ["XO...", ".X...", "..O..", ".....", "....."], whiteScore: 5.5, blackScore: 3, moveCount: 4, territory: { black: 2, white: 1 }, stats: [{ opponent: "Netburners", wins: 3, losses: 1, winStreak: 2, highestWinStreak: 2, rep: 100, bonusPercent: 5, bonusDescription: "hacking speed" }] },
      stanek: { width: 3, height: 3, occupied: { "0,0": 1, "1,0": 1 }, fragments: [{ id: 1, type: "Hacking", x: 0, y: 0, rotation: 0, power: 1.5, limit: 1, effect: "+x% hacking", numCharge: 10, highestCharge: 10, chargedEffect: 1.2 }], availableTypes: [{ id: 1, type: "Hacking", power: 1.5, limit: 1 }] },
      dnet: { reachable: 4, maxDepth: 2, stasisLinkLimit: 2, stasisLinked: ["dn-1"], instability: { authenticationDurationMultiplier: 1.2, authenticationTimeoutChance: 0.05 }, servers: [{ hostname: "dn-1", depth: 1, blockedRam: 16, isOnline: true, requiredCharisma: 50, stasisLinked: true }] },
      side: { contracts: [{ host: "home", file: "c.cct", type: "Array Jumping Game", triesRemaining: 3 }], contractTotal: 900, solvableTotal: 400, unsolvableByType: { "Proper 2-Coloring of a Graph": 500 }, unsolvableTotal: 500, infiltration: [{ location: "ECorp", city: "Aevum", difficulty: 1.5, maxClearanceLevel: 37, startingSecurityLevel: 8, repReward: 100, moneyReward: 1e6, moneyPerDifficulty: 666666 }], infiltrationTotal: 1, plan: { solvable: [{ host: "home", file: "c.cct", type: "Array Jumping Game" }], solvableTotal: 400, unsolvable: [{ type: "Proper 2-Coloring of a Graph", count: 500 }], unsolvableTotal: 500, infiltration: [{ location: "ECorp", city: "Aevum", valuePerMinute: 1e5 }], casino: "no ns API", why: "test" } },
    };

    const state = emptyState();
    state.runId = "synthetic";
    state.topics = topics;
    state.caps = deriveCapabilities({
      bitNode: 1,
      sourceFiles: Object.fromEntries(FEATURES.flatMap((f) => f.bitnodes.map((n) => [String(n), 1]))),
      inGang: true,
      inBladeburner: true,
      hasCorporation: true,
      hasWseAccount: true,
      hasTixApiAccess: true,
      goPlayable: true,
    });
    renderAll(state);
  });
});

describe("stream projection", () => {
  const base = { seq: 0, t: 0, run: "r", src: "sim" as const };

  test("the money chart follows both the getPlayer mirror and the player topic", () => {
    const viaMirror = project(
      [{ ...base, kind: "state", key: "getPlayer", data: { money: 5 } } as LogRecord],
      Infinity,
      { id: "r", src: "sim", live: false, t0: 0 },
    );
    expect(viaMirror.moneySeries).toEqual([[0, 5]]);
    // Regression: the old viewer charted only `getPlayer`, so a run that
    // published the typed `player` topic drew an empty chart.
    const viaTopic = project(
      [{ ...base, kind: "state", key: "player", data: { money: 7 } } as LogRecord],
      Infinity,
      { id: "r", src: "sim", live: false, t0: 0 },
    );
    expect(viaTopic.moneySeries).toEqual([[0, 7]]);
  });

  test("totals prefer the farm rollup, fall back to hack.done, else report absence", () => {
    // Regression: totals used to be blanked on `src === "game"` rather than on
    // the absence of a totals source, so sim runs without per-op events showed
    // a confident 0.
    const none = project([{ ...base, kind: "event", name: "start.boot" } as LogRecord], Infinity, {
      id: "r",
      src: "game",
      live: true,
      t0: 0,
    });
    expect(none.hasTotals).toBe(false);

    const viaEvents = project(
      [{ ...base, kind: "event", name: "hack.done", data: { success: true, moneyGained: 250 } } as LogRecord],
      Infinity,
      { id: "r", src: "sim", live: false, t0: 0 },
    );
    expect(viaEvents.hasTotals).toBe(true);
    expect(viaEvents.earned).toBe(250);
    expect(viaEvents.hacks).toBe(1);

    const viaFarm = project(
      [
        { ...base, kind: "event", name: "hack.done", data: { success: true, moneyGained: 250 } },
        { ...base, seq: 1, kind: "state", key: "farm", data: { totals: { moneyEarned: 9000, hacks: 42 } } },
      ] as LogRecord[],
      Infinity,
      { id: "r", src: "game", live: true, t0: 0 },
    );
    expect(viaFarm.earned).toBe(9000);
    expect(viaFarm.hacks).toBe(42);
  });

  test("the replay cutoff truncates the fold", () => {
    const records = [
      { ...base, kind: "state", key: "getPlayer", data: { money: 1 } },
      { ...base, seq: 1, t: 100, kind: "state", key: "getPlayer", data: { money: 2 } },
    ] as LogRecord[];
    const full = project(records, Infinity, { id: "r", src: "sim", live: false, t0: 0 });
    expect(full.moneySeries.length).toBe(2);
    const clipped = project(records, 50, { id: "r", src: "sim", live: false, t0: 0 });
    expect(clipped.moneySeries).toEqual([[0, 1]]);
  });

  test("a game run's replay range is its own timeline, not 0..now", () => {
    // Regression: the scrub slider used min=0 while game records carry
    // Date.now() timestamps, so the whole run occupied its final pixel and
    // every drag produced a cutoff decades before t0 — an empty page and a
    // hugely negative "elapsed". The slider must span [t0, tLast].
    const t0 = 1_786_117_518_978;
    const records = [
      { ...base, src: "game" as const, t: t0, kind: "state", key: "getPlayer", data: { money: 1 } },
      { ...base, src: "game" as const, seq: 1, t: t0 + 60_000, kind: "state", key: "getPlayer", data: { money: 2 } },
    ] as LogRecord[];
    const min = records[0]!.t;
    const max = records[records.length - 1]!.t;
    expect(min).toBe(t0);

    // Midpoint of the correct range keeps the run visible and elapsed positive.
    const mid = min + (max - min) / 2;
    const clipped = project(records, mid, { id: "r", src: "game", live: false, t0 });
    expect(clipped.moneySeries).toEqual([[t0, 1]]);
    expect(clipped.lastT - t0).toBeGreaterThanOrEqual(0);

    // Midpoint of the old 0-based range fell before the run entirely.
    const broken = project(records, max / 2, { id: "r", src: "game", live: false, t0 });
    expect(broken.moneySeries).toEqual([]);
  });

  test("state records are folded into topics and kept out of the event feed", () => {
    const state = project(
      [
        { ...base, kind: "state", key: "capabilities", data: deriveCapabilities({ bitNode: 3 }) },
        { ...base, seq: 1, kind: "event", name: "probe.skipped", data: { id: "corp.core" } },
      ] as LogRecord[],
      Infinity,
      { id: "r", src: "game", live: true, t0: 0 },
    );
    expect(state.caps.bitNode).toBe(3);
    expect(state.topics.capabilities).toBeDefined();
    expect(state.events.length).toBe(1);
    expect(state.events[0]!.kind).toBe("event");
  });
});

describe("incremental projection", () => {
  const base = { seq: 0, t: 0, run: "r", src: "sim" as const };

  function stream(n: number): LogRecord[] {
    const records: LogRecord[] = [];
    for (let i = 0; i < n; i++) {
      records.push({ ...base, seq: i * 2, t: i, kind: "state", key: "getPlayer", data: { money: i } } as LogRecord);
      records.push({ ...base, seq: i * 2 + 1, t: i, kind: "event", name: "hack.done", data: { success: true, moneyGained: 2 } } as LogRecord);
    }
    return records;
  }

  test("folding in batches gives the same state as folding the whole stream", () => {
    // This is the property that lets a live run stop re-folding its history on
    // every frame — the reason the viewer degraded the longer it was open.
    const records = stream(50);
    const whole = project(records, Infinity, { id: "r", src: "sim", live: true, t0: 0 });

    const incremental = emptyState();
    incremental.runId = "r";
    incremental.src = "sim";
    incremental.live = true;
    incremental.t0 = 0;
    for (let i = 0; i < records.length; i += 7) appendRecords(incremental, records.slice(i, i + 7));

    expect(incremental.moneySeries).toEqual(whole.moneySeries);
    expect(incremental.events.length).toBe(whole.events.length);
    expect(incremental.earned).toBe(whole.earned);
    expect(incremental.hacks).toBe(whole.hacks);
    expect(incremental.lastT).toBe(whole.lastT);
    expect(incremental.topics).toEqual(whole.topics);
  });

  test("the event feed is a ring, not an unbounded log", () => {
    // A 12-hour run emits far more than the feed can show; retaining all of it
    // just to slice the tail is how a viewer tab reaches a gigabyte.
    const state = project(stream(EVENT_RING * 2), Infinity, { id: "r", src: "sim", live: true, t0: 0 });
    expect(state.events.length).toBe(EVENT_RING);
    // The ring keeps the NEWEST records — an old tail would be useless.
    expect(state.events[state.events.length - 1]!.t).toBe(EVENT_RING * 2 - 1);
  });

  test("the money series is downsampled but keeps its endpoints", () => {
    const points = SERIES_LIMIT * 3;
    const state = project(stream(points), Infinity, { id: "r", src: "sim", live: true, t0: 0 });
    expect(state.moneySeries.length).toBeLessThanOrEqual(SERIES_LIMIT);
    // The axis labels are drawn from the first and last points, so losing
    // either would mislabel the whole chart.
    expect(state.moneySeries[0]).toEqual([0, 0]);
    expect(state.moneySeries[state.moneySeries.length - 1]).toEqual([points - 1, points - 1]);
  });
});

describe("panel view state", () => {
  test("a filter chip changes what the panel renders", () => {
    const state = emptyState();
    state.runId = "r";
    state.topics = {
      progression: {
        bitNode: 12,
        sourceFiles: {},
        ownedAugs: {},
        augCount: 0,
        lastAugReset: 1,
        lastNodeReset: 1,
        multipliers: { ...DEFAULT_BITNODE_MULTIPLIERS, CrimeMoney: 0.5, HacknetNodeMoney: 4 },
      },
    } as ProjectedState["topics"];

    setView("bitnode.mults", "all");
    const all = TABS["progression"].render(state);
    expect(all).toContain("Crime Money");
    expect(all).toContain("Hacknet Node Money");

    // "harder" keeps the nerfed gain and drops the buffed one — the filter is
    // by FAVOURABILITY, not by whether the number went up.
    setView("bitnode.mults", "harder");
    const harder = TABS["progression"].render(state);
    expect(harder).toContain("Crime Money");
    expect(harder).not.toContain("Hacknet Node Money");

    setView("bitnode.mults", "all");
  });

  test("the first click on any column ranks by it, biggest first", () => {
    const tableDefault = { key: "money", dir: -1 } as const;
    // Nothing clicked yet: the table's own default applies.
    expect(sortOf("demo", tableDefault)).toEqual(tableDefault);

    // The handler passes NO_SORT, never the clicked key: passing the clicked
    // key would make the first click on ANY column read as "flip", so ranking
    // a table by skill would open with the weakest server at the top.
    toggleSort("demo", "skill", NO_SORT);
    expect(sortOf("demo", tableDefault)).toEqual({ key: "skill", dir: -1 });

    // Clicking the active column flips it.
    toggleSort("demo", "skill", NO_SORT);
    expect(sortOf("demo", tableDefault)).toEqual({ key: "skill", dir: 1 });

    // Switching columns starts descending again.
    toggleSort("demo", "host", NO_SORT);
    expect(sortOf("demo", tableDefault)).toEqual({ key: "host", dir: -1 });
  });
});

describe("career request grouping", () => {
  test("identical asks from many factions collapse to one row", () => {
    // A late-game save posts one request per (faction, requirement) pair: the
    // panel used to show eleven consecutive rows that differed only in who was
    // asking, which is noise around a single piece of work.
    const serving = ["ECorp", "MegaCorp", "NWO", "Blade Industries"].map((company) => ({
      by: "factions",
      kind: "companyRep",
      subject: company,
      target: 400_000,
      have: 0,
      weight: 1,
      urgency: "wanted" as const,
      why: `${company} needs reputation`,
      progress: 0,
    }));
    // ...plus one distinct, higher-priority ask that must stay separate.
    const plan = {
      serving: [
        ...serving,
        { by: "factions", kind: "skill", subject: "agility", target: 850, have: 749, weight: 4.5, urgency: "blocking" as const, why: "The Covenant needs agility 850", progress: 0.881 },
      ],
      ranked: [],
      action: { type: "idle", why: "" },
      why: "",
      incomeFallback: false,
    };

    const groups = groupRequests(plan as never);
    // Four company-rep asks share a kind but not a subject, so they stay
    // distinct; what collapses is repeated (kind, subject, urgency).
    expect(groups.length).toBe(5);
    // Blocking sorts first regardless of how many wanted rows there are.
    expect(groups[0]!.urgency).toBe("blocking");
    expect(groups[0]!.subject).toBe("agility");

    // The same subject asked for twice collapses, and keeps every asker.
    const duplicated = groupRequests({
      ...plan,
      serving: [
        { by: "factions", kind: "skill", subject: "hacking", target: 1500, have: 1348, weight: 4.6, urgency: "wanted" as const, why: "Illuminati", progress: 0.898 },
        { by: "career", kind: "skill", subject: "hacking", target: 2500, have: 1348, weight: 3.2, urgency: "wanted" as const, why: "Daedalus", progress: 0.539 },
      ],
    } as never);
    expect(duplicated.length).toBe(1);
    expect(duplicated[0]!.askers.sort()).toEqual(["career", "factions"]);
    // The displayed milestone is ONE request, whole: the nearest one, which is
    // what the work will hit first. Taking the closest progress but the
    // furthest target would draw an 89.8% bar labelled "1.35k / 2.50k" — a bar
    // and a label that disagree by 35 points.
    expect(duplicated[0]!.progress).toBeCloseTo(0.898, 3);
    expect(duplicated[0]!.have).toBe(1348);
    expect(duplicated[0]!.target).toBe(1500);
    // The harder target is still known, as the note beside it.
    expect(duplicated[0]!.finalTarget).toBe(2500);
  });

  test("a group is only done when its shown milestone is", () => {
    // The meter turns green off `progress >= 1`. Under the old independent
    // maxima, one satisfied requirement turned the whole group green while
    // harder ones were still open.
    const groups = groupRequests({
      serving: [
        { by: "a", kind: "skill", subject: "agility", target: 300, have: 300, weight: 1, urgency: "wanted" as const, why: "met", progress: 1 },
        { by: "b", kind: "skill", subject: "agility", target: 850, have: 300, weight: 1, urgency: "wanted" as const, why: "open", progress: 0.35 },
      ],
      ranked: [],
      action: { type: "idle", why: "" },
      why: "",
      incomeFallback: false,
    } as never);
    expect(groups.length).toBe(1);
    // The nearest milestone IS met, so green is correct here — and the target
    // shown is the one that was met, not the one that was not.
    expect(groups[0]!.progress).toBe(1);
    expect(groups[0]!.target).toBe(300);
    expect(groups[0]!.finalTarget).toBe(850);
  });
});

describe("skill progress uses the multiplier the game applies", () => {
  function careerState(mult: number, nodeMult: number, exp: number): ProjectedState {
    const state = emptyState();
    state.runId = "r";
    state.player = { mults: { hacking: mult } } as never;
    state.topics = {
      progression: {
        bitNode: 1,
        sourceFiles: {},
        ownedAugs: {},
        augCount: 0,
        lastAugReset: 1,
        lastNodeReset: 1,
        multipliers: { ...DEFAULT_BITNODE_MULTIPLIERS, HackingLevelMultiplier: nodeMult },
      },
      career: {
        karma: 0,
        numPeopleKilled: 0,
        skills: { hacking: skillFromExp(exp, mult * nodeMult), strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 1 },
        exp: { hacking: exp, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 0 },
        city: "Sector-12",
        location: "home",
        entropy: 0,
        totalPlaytime: 1,
        jobs: {},
      },
    } as ProjectedState["topics"];
    return state;
  }

  test("a stat augmentation does not desynchronise the level from its bar", () => {
    // 1.2m experience under a 1.2x multiplier: level 297, 53% of the way to
    // 298. Reading it at 1x claims level 268 and 94% — both numbers plausible,
    // both wrong, and the panel showed the true level beside the wrong bar.
    const exp = 1.2e6;
    const state = careerState(1.2, 1, exp);
    const level = state.topics.career!.skills.hacking;
    expect(level).toBe(skillFromExp(exp, 1.2));
    expect(level).not.toBe(skillFromExp(exp, 1));

    const html = TABS["career"].render(state);
    // The bar is drawn to the NEXT real level, so the label names level+1.
    expect(html).toContain(`to ${level + 1}`);
    // And it must not be the number a 1x reading would have produced.
    expect(html).not.toContain(`to ${skillFromExp(exp, 1) + 1}`);
  });

  test("the BitNode multiplier counts too", () => {
    // BN12 scales stat levels as well; ignoring it desynchronises the same way.
    const exp = 1.2e6;
    const state = careerState(1, 0.7, exp);
    const level = state.topics.career!.skills.hacking;
    expect(level).toBe(skillFromExp(exp, 0.7));
    expect(TABS["career"].render(state)).toContain(`to ${level + 1}`);
  });

  test("an unexplained level falls back to raw experience rather than a wrong bar", () => {
    // Multipliers we cannot see (a modded save, a field we do not model) would
    // otherwise produce a confident, wrong percentage.
    const state = careerState(1, 1, 1.2e6);
    state.topics.career!.skills.hacking = 9_999;
    const html = TABS["career"].render(state);
    expect(html).toContain("9999");
    expect(html).toContain("exp");
    expect(html).not.toContain("to 10000");
  });
});

describe("filter badges count the rows their filter shows", () => {
  test("a pending invitation is counted by the reachable badge that includes it", () => {
    const state = emptyState();
    state.runId = "r";
    state.topics = {
      factions: {
        joined: ["CyberSec"],
        invites: ["NiteSec"],
        gates: {
          CyberSec: { joined: true, invited: false, progress: 1, reachable: true, missing: [] },
          NiteSec: { joined: false, invited: true, progress: 1, reachable: true, missing: [] },
          Tetrads: { joined: false, invited: false, progress: 0.3, reachable: true, missing: [] },
          Illuminati: { joined: false, invited: false, progress: 0, reachable: false, missing: [] },
        },
      },
    } as ProjectedState["topics"];

    setView("factions.mode", "open");
    const html = TABS["factions"].render(state);
    // Two rows are reachable-and-not-joined: NiteSec (invited) and Tetrads.
    // The badge used to exclude invited factions while the filter included
    // them, so it read "1" above a two-row table.
    // Matched on the row marker rather than the bare name: every faction also
    // appears in the augmentation table's "from" column.
    const row = (name: string) => new RegExp(`●</span>${name}`);
    expect(html).toMatch(row("NiteSec"));
    expect(html).toMatch(row("Tetrads"));
    expect(html).not.toMatch(row("Illuminati"));
    expect(html).toMatch(/reachable<span class="badge">2<\/span>/);

    setView("factions.mode", "all");
  });
});
