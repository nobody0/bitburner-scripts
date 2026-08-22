import { describe, expect, test } from "bun:test";
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
 * they can be exercised headlessly against empty and populated state. */

const ALL_TABS = Object.keys(TABS) as TabId[];

function renderAll(state: ProjectedState): void {
  for (const id of ALL_TABS) {
    const html = TABS[id].render(state);
    expect(html.length, `${id} rendered nothing`).toBeGreaterThan(0);
  }
}

describe("tab rendering", () => {
  test("every tab renders with no data at all", () => {
    renderAll(emptyState());
  });

  test("Hacking server table shows and explains host CPU cores", () => {
    const state = emptyState();
    state.servers.set("iron-gym", {
      hostname: "iron-gym",
      cpuCores: 8,
      maxRam: 32,
      ramUsed: 0,
      moneyMax: 1,
      moneyAvailable: 1,
      numOpenPortsRequired: 1,
    } as StateMap["servers"][string]);

    const html = TABS.hacking.render(state);
    expect(html).toContain('data-sort-key="ports"');
    expect(html).not.toContain('data-sort-key="roll"');
    expect(html).toContain("1.4375x grow/weaken effect");
    expect(html).toContain("1 required for NUKE; 0 port-opening programs available globally");
    expect(html).toContain(">1</span>");
    expect(html).toContain("0/32 · 8c</span>");
  });

  test("the Hacking panel reads its pipelines, landing order and allocation from the rollup", () => {
    const state = emptyState();
    state.topics.farm = {
      totals: { moneyEarned: 0, hacks: 0 },
      pipelines: [
        {
          host: "phantasy", role: "farm", mode: "hgw", segment: "farm", gb: 1_024,
          inFlight: { hack: 3, grow: 4, weaken: 8 },
          planThreads: { hack: 16, grow: 5, weaken: 4 },
        },
        {
          host: "n00dles", role: "prep", segment: "prep", gb: 64,
          inFlight: { hack: 0, grow: 2, weaken: 4 },
          eta: { seconds: 252, bound: "ram", prepped: false },
        },
      ],
      landingOrder: {
        planned: "h-w1-g-w2",
        batches: 1_000,
        observed: { "h-w1-g-w2": 990, "h-h-g-w2": 10 },
        incomplete: 7,
        anomalies: [{ at: 5_000, observed: "h-h-g-w2", planned: "h-w1-g-w2", target: "phantasy" }],
      },
      allocation: {
        threads: { farm: { hack: 1_600, grow: 500, weaken: 400 } },
        effectThreads: { farm: { hack: 1_600, grow: 625, weaken: 500 } },
      },
      batches: {
        // `landed === ops` on both: a settled batch cannot have lost an op.
        // Loss lives on the abandoned counters.
        hgw: {
          batches: 100, ops: 300, landed: 300, threads: { hack: 1_700, grow: 4_000, weaken: 600 },
          gb: 100_000, moneyEarned: 5e9, hacks: 99, spanMs: 2_000_000, inOrder: 98, noHack: 1,
          abandoned: 2, abandonedOps: 6, abandonedLanded: 4,
        },
        prep: {
          batches: 4, ops: 40, landed: 40, threads: { hack: 0, grow: 800, weaken: 400 },
          gb: 20_000, moneyEarned: 0, hacks: 0, spanMs: 800_000, inOrder: 0, noHack: 0,
          abandoned: 0, abandonedOps: 0, abandonedLanded: 0,
        },
      },
      recentBatches: [
        {
          id: 41, kind: "hgw", target: "phantasy", at: 9_000, spanMs: 20_000, ops: 3, landed: 3,
          threads: { hack: 17, grow: 40, weaken: 6 }, gb: 1_000, moneyEarned: 5e7,
          order: "h-g-w2", planned: "h-g-w2",
        },
        {
          id: 42, kind: "hgw", target: "phantasy", at: 9_500, spanMs: 21_000, ops: 3, landed: 2,
          threads: { hack: 17, grow: 40, weaken: 6 }, gb: 1_000, moneyEarned: 0,
          order: "g-h", planned: "h-g-w2",
        },
      ],
    } as StateMap["farm"];

    const html = TABS.hacking.render(state);
    // Per-batch analytics: a prep wave and a farm cycle are different units of
    // work, so they get a column each rather than one blended op count.
    expect(html).toContain(">hgw<");
    expect(html).toContain(">prep<");
    expect(html).toContain(`class="batchgrid"`);
    // The per-batch view is the headline; the per-kind grid is a disclosure
    // under it. A cumulative mean per kind is a number no individual batch
    // resembles, which is the reason for the demotion.
    expect(html).toContain(`data-open-key="hacking.batchKinds"`);
    // 300 ops over 100 batches, 100_000 GB over 100 batches, $5e9 over 100.
    expect(html).toContain("3.0");
    expect(html).toContain("1.00TB");
    // Batches that landed support with no steal. There is deliberately no
    // "N lost" assertion here any more: a settled batch has `landed === ops` by
    // construction, so that badge could never fire. Loss is the abandoned
    // counters and the global op residual instead.
    expect(html).toContain("1 no-hack");
    // There is deliberately NO launched-against-landed band any more. Those two
    // counters are equal by construction — a batch settles only once its last op
    // lands — so the chart that plotted them against each other drew one curve
    // twice, and the gap it was captioned as showing was always exactly zero.
    expect(html).not.toContain("launched</span> →");
    expect(html).not.toContain("300 launched");
    // Loss is reported where it can actually be observed: batches evicted
    // without ever settling, and the ops they took with them.
    expect(html).toContain("2 abandoned, 2 ops lost");
    // Ops launched that are neither in flight nor landed, as a run-level tile.
    expect(html).toContain("ops adrift");
    // In-order is a FRACTION, so the denominator is visible: it counts every
    // batch of the kind, including ones that never had a grid to be right about.
    expect(html).toContain("98 / 100 in order");
    // And a kind that has never produced a verdict says so instead of showing
    // a red 0%. Which kinds those are is not hardcoded — prep qualifies here
    // because it has graded nothing, not because it is called "prep".
    expect(html).toContain("no landing grid");

    // Throughput and allocation are per batch kind now, so the run-wide
    // op-rate card and its kind selector are gone.
    expect(html).not.toContain("ratechart");
    expect(html).not.toContain(`data-view-key="hacking.rate"`);
    // Batches lead the tab: you must be able to see one without scrolling.
    expect(html.indexOf("Batches")).toBeLessThan(html.indexOf("Landing order"));

    // A pipeline names itself rather than being labelled "farm target" by the
    // panel, so a mode or a role the viewer has never heard of still reads.
    expect(html).toContain("phantasy");
    expect(html).toContain("hgw");
    expect(html).toContain("n00dles");
    // The prep's ETA, and WHICH constraint set it — buying RAM does nothing
    // for a latency-bound prep, so the panel must not blur the two.
    expect(html).toContain("RAM-bound");

    // Landing order: the share that landed as planned, and the reorder named
    // rather than left as two strings to diff by eye.
    expect(html).toContain("h-w1-g-w2");
    expect(html).toContain("99.00%");
    expect(html).toContain("h landed where w1 was due");
    // Batches that never launched a hack are counted apart from the reorders.
    expect(html).toContain("no hack launched");

    // Allocation: the ratio normalised against hack, and the measured core
    // multiplier — 625/500 grow effect per thread.
    expect(html).toContain("1.00 : 0.31 : 0.25");
    expect(html).toContain("1.250x");
    // Hack is the control: cores do nothing for it.
    expect(html).toContain("1.000x");
  });

  test("the Hacking panel states what planning costs the main thread", () => {
    // The failure this exists for: a planner at ~100% main-thread occupancy
    // looked healthy because the only cost row was a peak duration, and the
    // consequence (landing error) lags the cause by a whole weaken time.
    const state = emptyState();
    state.topics.farm = {
      totals: { moneyEarned: 0, hacks: 0 },
      pumpMaxMs: 92,
      pumpOccupancy: 0.63,
      pumpMs: { meanMs: 58.2, maxMs: 92, count: 11 },
      wakePumps: 5823,
      wakePumpRate: 10.8,
      wakePumpsSkipped: { gap: 812, frame: 41 },
      weakenWindow: { pumps: 1204 },
      engineLatenessMs: { meanMs: 4210, maxMs: 28900 },
      ledger: { tracked: 21438, pendingBatches: 5102, pendingOps: 20408, onTarget: 21100 },
    } as StateMap["farm"];

    const html = TABS.hacking.render(state);
    // Occupancy, not just the peak: 63% of wall time is the finding.
    expect(html).toContain(">planner<");
    expect(html).toContain("63.0%");
    expect(html).toContain("58.2ms mean");
    // Past the critical threshold it is called out rather than merely shown.
    expect(html).toContain('class="bad">63.0%');
    expect(html).toContain('class="bad">4210.0ms mean');
    // The refusals are what say whether the planner is asked too often or is
    // simply too expensive, and the weaken window bypasses both throttles.
    expect(html).toContain("10.8/s");
    expect(html).toContain("refused 812 gap / 41 frame");
    expect(html).toContain("1.204e3 weaken window");
    // Depth is the independent variable of the cost above it.
    expect(html).toContain("2.144e4 ops");
    expect(html).toContain("5.102e3 pending batches");
  });

  test("the Hacking panel falls back to the peak pump before occupancy exists", () => {
    // Replay coverage: records written before the occupancy fields existed
    // must still render their one cost number rather than a dash.
    const state = emptyState();
    state.topics.farm = { totals: { moneyEarned: 0, hacks: 0 }, pumpMaxMs: 4.6 } as StateMap["farm"];
    const html = TABS.hacking.render(state);
    expect(html).toContain("4.6ms worst");
    expect(html).not.toContain("</span> of wall");
  });

  test("every feature's populated panel renders", () => {
    // One synthetic record per topic, so no panel's data branch is untested
    // just because the local save cannot reach that feature.
    // Keep the former prose-bearing shapes here as legacy replay coverage:
    // feature panels must render old JSONL without displaying those fields.
    const topics = {
      farm: { target: "n00dles", totals: { moneyEarned: 1e6, hacks: 12 }, inFlight: { hack: 1, grow: 2, weaken: 3 }, ramPie: { farm: 10, prep: 5, share: 0, free: 2, reserve: 4 }, pipelines: [{ host: "n00dles", role: "farm", mode: "hwgw", segment: "farm", gb: 10, inFlight: { hack: 1, grow: 2, weaken: 3 }, money: 9e5, moneyMax: 1e6, security: 1.2, minSecurity: 1, planThreads: { hack: 16, grow: 5, weaken: 4 }, moneyPerSecPerGb: 3.5, hackTimeMs: 2400, weakenTimeMs: 9600 }, { host: "joesguns", role: "prep", segment: "prep", gb: 5, inFlight: { hack: 0, grow: 4, weaken: 8 }, money: 3e5, moneyMax: 1e6, security: 12, minSecurity: 5, eta: { seconds: 252, bound: "ram", prepped: false } }], landingOrder: { planned: "h-w1-g-w2", batches: 400, observed: { "h-w1-g-w2": 396, "h-g-w1-w2": 4 }, incomplete: 2, anomalies: [{ at: 5000, observed: "h-g-w1-w2", planned: "h-w1-g-w2", target: "n00dles" }] }, allocation: { threads: { farm: { hack: 1600, grow: 500, weaken: 400 } }, effectThreads: { farm: { hack: 1600, grow: 625, weaken: 500 } } }, ramWork: { nativeGbMs: 100, paddingGbMs: 10, nativeGbMsByKind: { hack: 50, grow: 30, weaken: 20 }, paddingGbMsByKind: { hack: 5, grow: 3, weaken: 2 }, nativeGbMsBySegment: { farm: 80, prep: 20, share: 0 }, paddingGbMsBySegment: { farm: 8, prep: 2, share: 0 }, nativeGbMsBySegmentKind: { farm: { hack: 50, grow: 20, weaken: 10 }, prep: { hack: 0, grow: 10, weaken: 10 }, share: { hack: 0, grow: 0, weaken: 0 } }, paddingGbMsBySegmentKind: { farm: { hack: 5, grow: 2, weaken: 1 }, prep: { hack: 0, grow: 1, weaken: 1 }, share: { hack: 0, grow: 0, weaken: 0 } } } },
      fleet: { rootedHosts: 3, totalHosts: 9, maxRam: 64, usedRam: 32, purchased: { count: 1, totalRam: 8, limit: 25 }, home: { maxRam: 32, usedRam: 8, cores: 2 }, portOpeners: 2 },
      progression: { bitNode: 12, sourceFiles: { "4": 3 }, ownedAugs: { NeuroFlux: 5 }, augCount: 1, lastAugReset: 1, lastNodeReset: 1, multipliers: { ScriptHackMoney: 0.2 } },
      factions: { joined: ["CyberSec"], standings: [{ name: "CyberSec", rep: 100, favor: 1 }], invites: ["NiteSec"], favorToDonate: 150, workTypes: { CyberSec: ["hacking"] }, enemies: { CyberSec: [] }, requirements: { NiteSec: [{ type: "skills", skills: { hacking: 200 } }] }, gates: { CyberSec: { joined: true, invited: false, progress: 1, reachable: true, missing: [] }, NiteSec: { joined: false, invited: true, progress: 1, reachable: true, missing: [] }, "The Covenant": { joined: false, invited: false, progress: 0.4, reachable: true, missing: [{ kind: "skill", subject: "agility", target: 850, have: 340, progress: 0.4, owner: "career", reachable: true }] }, Illuminati: { joined: false, invited: false, progress: 0, reachable: false, missing: [{ kind: "bitNode", target: 0, have: 0, progress: 0, owner: "progression", reachable: false }] } }, augMeta: { Rootkit: { prereqs: [], mults: { hacking: 1.1 } } }, ownedAugs: ["BitWire"], offers: [{ name: "Rootkit", faction: "CyberSec", price: 1.9e6, basePrice: 1e6, repReq: 100, affordableRep: true, repGap: 0, owned: false }], augTotal: 1, graftable: [{ name: "Rootkit", price: 1e6, timeMs: 6e4 }], plan: { context: { evaluatedAt: 0, horizonSec: 3600, ownedAugCount: 1, queuedAugCount: 0, incomePerSec: 1000, moneyAvailable: 1e6, moneyGranted: 1e6, holdsWorkSlot: true, favorToDonate: 150, priceQueue: { nonSoA: 0, ownedSoA: 0, neurofluxLevel: 0 } }, objective: { factions: ["CyberSec"], augmentations: ["Rootkit"], value: 1.5, foreclosed: [{ name: "Volhaven", bannedBy: "Sector-12" }] }, action: { type: "workForFaction", faction: "CyberSec", workType: "hacking" }, alternatives: [{ label: "work NiteSec", value: 0.2 }], blockers: [{ faction: "NiteSec", kind: "skill", subject: "hacking", target: 200, have: 50, progress: 0.25, owner: "hacking", reachable: true }], until: { kind: "rep", faction: "CyberSec", target: 100, have: 40, etaSec: 120 }, lastResult: { action: "workForFaction", ok: true, detail: "started", at: 1 }, recommendInstall: { augmentations: ["Rootkit"] } } },
      career: { karma: -100, numPeopleKilled: 0, skills: { hacking: 10, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 }, exp: { hacking: 10, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 0 }, city: "Sector-12", location: "home", entropy: 0, totalPlaytime: 1e6, jobs: { ECorp: "Software" }, companies: { ECorp: { rep: 10, favor: 1 } }, currentWork: { type: "CRIME", detail: "Mug" }, crimes: [{ name: "Mug", chance: 0.5, money: 1000, timeMs: 4000, karma: -0.25, moneyPerSec: 125 }] },
      hacknet: { servers: false, numNodes: 2, maxNumNodes: 30, purchaseNodeCost: 1e5, totalProduction: 500, productionPerSec: 1.5, nodes: [{ name: "hacknet-node-0", level: 10, ram: 2, cores: 1, production: 1.5, totalProduction: 500, timeOnline: 3600 }], nextUpgrades: [{ kind: "level", node: 0, cost: 1000 }] },
      stock: { hasWseAccount: true, hasTixApiAccess: true, has4SData: false, has4SDataApi: true, positions: [{ sym: "ECP", price: 100, ask: 100.2, bid: 99.8, maxShares: 1e6, shares: 100, avgPx: 90, sharesShort: 0, avgPxShort: 0, value: 9980, costBasis: 9000 }], signals: { ECP: { forecast: 0.6, volatility: 0.0045 } }, portfolioValue: 9980, portfolioCost: 9000, tradeCashFlow: -4e8, unlockSpend: 5.2e9, wealth: 1.2e10, orders: { ECP: [{ type: "Limit Buy Order", position: "Long", shares: 500, price: 95 }] }, market: { tick: 120, ticksUntilCycle: 43, cyclesSeen: 1, lastFlipCount: 15, lastV: 0.42 }, manipulation: { ecorp: { sym: "ECP", side: "long", valuePerOp: 12000, notional: 9980 } }, plan: { actions: [{ type: "buy" }], ranked: [{ sym: "ECP", side: "long", forecast: 0.6, volatility: 0.0045, exact: true, manipulable: true, breakEvenTicks: 4.2, expectedProfit: 5e5 }], entry: { sym: "ECP", side: "long", shares: 1000, cost: 1e5, expectedProfit: 5e5, holdTicks: 43, breakEvenTicks: 4.2 }, unlock: { type: "buy4SApi", cost: 25e9, investmentCost: 30.2e9, gainPerSec: 1e6, paybackSec: 25000, netOverHorizon: 1e9 }, reserve: { amount: 2e8, ratePerSec: 5e4 }, horizons: { positionSec: 258, unlockSec: 4320 }, flat: false, lastResult: { action: "buy", ok: true, detail: "bought 1000 ECP", at: 1 } } },
      gang: { faction: "Slum Snakes", isHacking: false, respect: 100, respectGainRate: 1, wantedLevel: 2, wantedLevelGainRate: 0.1, wantedPenalty: 0.9, moneyGainRate: 500, power: 10, territory: 0.2, territoryClashChance: 0.1, territoryWarfareEngaged: false, respectForNextRecruit: 200, recruitsAvailable: 1, canRecruit: true, members: [{ name: "a", task: "Mug People", earnedRespect: 10, respectGain: 0.5, wantedLevelGain: 0.01, moneyGain: 100, skills: { hack: 1, str: 10, def: 10, dex: 10, agi: 10, cha: 1 }, ascMults: { hack: 1, str: 1, def: 1, dex: 1, agi: 1, cha: 1 }, upgrades: 2, augmentations: 1 }], clashChances: { Tetrads: 0.4 } },
      corp: { name: "Acme", funds: 1e9, revenue: 1e6, expenses: 5e5, public: false, valuation: 1e10, sharePrice: 10, totalShares: 1e9, numShares: 9e8, issuedShares: 0, dividendRate: 0, dividendEarnings: 0, state: "START", divisions: [{ name: "Ag", industry: "Agriculture", awareness: 1, popularity: 1, productionMult: 2, researchPoints: 100, lastCycleRevenue: 1e6, lastCycleExpenses: 5e5, numAdVerts: 1, cities: ["Sector-12"], products: [], maxProducts: 0, offices: [{ city: "Sector-12", size: 9, numEmployees: 9, avgEnergy: 99, avgMorale: 99, jobs: { Operations: 3 } }], warehouses: [{ city: "Sector-12", level: 1, size: 100, sizeUsed: 50, smartSupplyEnabled: true }] }], investmentOffer: { round: 1, funds: 1e9, shares: 1e8 } },
      bladeburner: { rank: 100, skillPoints: 5, stamina: [50, 100], city: "Sector-12", current: { type: "Contract", name: "Tracking", elapsedMs: 1000 }, nextBlackOp: { name: "Operation Typhoon", rank: 2500 }, skills: { "Blade's Intuition": { level: 1, upgradeCost: 3 } }, actions: [{ type: "contract", name: "Tracking", chance: [0.5, 0.7], timeMs: 30000, countRemaining: 100, level: 1, maxLevel: 5 }], cities: [{ name: "Sector-12", population: 1e6, communities: 5, chaos: 10 }] },
      sleeves: { count: 1, sleeves: [{ index: 0, shock: 10, sync: 90, memory: 1, storedCycles: 0, city: "Sector-12", hp: { current: 10, max: 10 }, skills: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1 }, task: { type: "CRIME", detail: "Mug" }, purchasableAugs: [{ name: "BitWire", price: 1e6 }] }] },
      go: {
        status: "inProgress",
        currentPlayer: "Black",
        opponent: "Netburners",
        boardSize: 5,
        board: ["XO...", ".X...", "..O..", ".....", "....."],
        previousBoards: [["X....", ".....", ".....", ".....", "....."]],
        whiteScore: 5.5,
        blackScore: 3,
        komi: 1.5,
        bonusCycles: 12,
        moveCount: 4,
        territory: { black: 2, white: 1 },
        stats: [{ opponent: "Netburners", wins: 3, losses: 1, winStreak: 2, highestWinStreak: 2, rep: 100, bonusPercent: 5, bonusDescription: "hacking speed" }],
        plan: {
          action: { type: "move", x: 1, y: 1 },
          ranked: [{
            x: 1, y: 1, score: 0.84, powerPerRound: 5.5, captures: 1,
            predictedReplies: [{ x: 2, y: 2, count: 5 }, { x: null, y: null, count: 1 }],
          }],
          input: {
            at: 1_000, board: ["X....", ".....", ".....", ".....", "....."], previousBoards: [],
            status: "inProgress", currentPlayer: "Black", komi: 1.5,
          },
          planning: { finalistCount: 4, positionValue: 0.25 },
          selection: {
          preferred: {
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, aligned: false, waitSec: 0, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0,
          },
          candidates: [{
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, aligned: false, waitSec: 0, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0,
          }],
          context: {
            goPower: 1, hasSourceFile14: false, favorRepCap: 100_000, installRemainingSec: 3_600,
            joinedFactions: [], demands: {},
          },
        },
        },
        lastTurn: {
          at: 1_100,
          durationMs: 205,
          action: { type: "move", x: 1, y: 1 },
          opponentResponse: { type: "move", x: 2, y: 2 },
          predictionSupport: { matching: 5, total: 6 },
          prediction: {
            model: "clean-room-v3.0.1",
            sampledTotalPlaytime: 100_000,
            sampledAt: 900,
            decisionAt: 1_000,
            preparationMs: 1.2,
            finalizationMs: 0.8,
            totalPlanningMs: 2,
            engineCycleMs: 200,
            aiWaitMs: 200,
            seedCandidates: [100_200],
            dispatchPlaytime: 100_000,
            boundaryRetries: 0,
          },
          ok: true,
          detail: "move; opponent move",
        },
      },
      stanek: { width: 3, height: 3, occupied: { "0,0": 1, "1,0": 1 }, fragments: [{ id: 1, type: "Hacking", x: 0, y: 0, rotation: 0, power: 1.5, limit: 1, effect: "+x% hacking", numCharge: 10, highestCharge: 10, chargedEffect: 1.2 }], availableTypes: [{ id: 1, type: "Hacking", power: 1.5, limit: 1 }] },
      dnet: { reachable: 4, maxDepth: 2, stasisLinkLimit: 2, stasisLinked: ["dn-1"], instability: { authenticationDurationMultiplier: 1.2, authenticationTimeoutChance: 0.05 }, probed: [{ hostname: "dn-1", at: 1_000, present: true, depth: 1, blockedRam: 16, requiredCharisma: 50 }] },
      side: {
        contracts: [{ host: "home", file: "c.cct" }],
        contractTotal: 900,
        solvableTotal: 400,
        unsolvableByType: { "Proper 2-Coloring of a Graph": 500 },
        unsolvableTotal: 500,
        registryComplete: false,
        contractTypeTotal: 30,
        supportedTypeTotal: 29,
        failures: [{ host: "n00dles", file: "bad.cct", type: "Array Jumping Game", reason: "answer rejected", triesBefore: 1, at: 1 }],
        quarantinedTotal: 1,
        lastResult: { action: "contract", ok: true, detail: "20 solved", at: 1 },
      },
    };

    const state = emptyState();
    state.runId = "synthetic";
    state.topics = topics as unknown as { [K in StateKey]?: StateMap[K] };
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

    // The dense per-entity tables are sortable, one viewstate id each.
    expect(TABS["gang"].render(state)).toContain('data-sort-table="gang.members"');
    expect(TABS["sleeves"].render(state)).toContain('data-sort-table="sleeves.list"');
    expect(TABS["bladeburner"].render(state)).toContain('data-sort-table="bladeburner.actions"');
    expect(TABS["stock"].render(state)).toContain('data-sort-table="stock.positions"');
    expect(TABS["stock"].render(state)).toContain('data-sort-table="stock.market"');
    expect(TABS["hacknet"].render(state)).toContain('data-sort-table="hacknet.nodes"');
  });

  test("the stock tab reads the whole ledger the topic publishes", () => {
    const state = emptyState();
    state.topics.stock = {
      hasWseAccount: true,
      hasTixApiAccess: true,
      has4SDataApi: false,
      positions: [{ sym: "ECP", price: 100, ask: 100.2, bid: 99.8, maxShares: 1e6, shares: 100, avgPx: 90, sharesShort: 0, avgPxShort: 0, value: 9980, costBasis: 9000 }],
      portfolioValue: 9980,
      portfolioCost: 9000,
      // A book underwater and a market that has not yet earned back its access.
      tradeCashFlow: -4e8,
      unlockSpend: 5.2e9,
      wealth: 1.2e10,
      orders: { ECP: [{ type: "Limit Buy Order", position: "Long", shares: 500, price: 95 }] },
      market: { tick: 120, ticksUntilCycle: 43, cyclesSeen: 1, lastFlipCount: 15, lastV: 0.42 },
      plan: {
        actions: [],
        ranked: [{ sym: "ECP", side: "long", forecast: 0.6, volatility: 0.0045, exact: true, manipulable: true, breakEvenTicks: 4.2, expectedProfit: 5e5 }],
        // No entry, only a reserve: the case that used to render as an idle tab.
        reserve: { amount: 2e8, ratePerSec: 5e4 },
        unlock: { type: "buy4SApi", cost: 25e9, investmentCost: 30.2e9, gainPerSec: 1e6, paybackSec: 25000, netOverHorizon: 1e9 },
        horizons: { positionSec: 258, unlockSec: 4320 },
        flat: false,
      },
    } as StateMap["stock"];
    const html = TABS["stock"].render(state);

    // Realised net is cost-basis, so holding leaves it at the cash flow plus
    // the book at cost: -4e8 + 9000, still a loss.
    expect(html).toContain("realised P/L");
    expect(html).toContain("contribution");
    // A P/L is signed OUTSIDE the currency mark, and coloured by direction.
    expect(html).toContain(`<span class="bad">-$4.000e8</span>`);
    // No records were folded, so there is no interval to divide by and the tile
    // says so rather than reporting an infinite rate.
    expect(html).toContain("no trade yet");
    // The unlock ladder, three rungs rather than two loose yes/no bits. 4S is
    // unpaid here, so it is the one rung that is not `good`.
    expect(html).toContain("the unlock ladder");
    expect(html).toContain(`<span class="dot wait"`);
    // The cycle countdown now shows the flip count it was derived from.
    expect(html).toContain("15 flips");
    expect(html).toContain("v 0.42");
    // Total capital is DISTINCT from the next rung's price — the whole point of
    // publishing investmentCost.
    expect(html).toContain("total capital");
    expect(html).toContain("<td>$2.500e10</td><td>$3.020e10</td>");
    // The reserve explains a tab with no actions.
    expect(html).toContain("no entry clears its round trip yet");
    // The horizon, and the manipulable flag joining market to farm.
    expect(html).toContain("horizon");
    expect(html).toContain("the farm can drive this symbol's host");
    // Open orders are the game's, never ours, and the probe pays for them.
    expect(html).toContain("Limit Buy Order");
    // Nothing has been folded, so there is no curve and the charts are withheld
    // rather than drawn as two empty boxes.
    expect(html).not.toContain('id="stock-book"');
  });

  test("the capital charts appear once the fold has a curve to draw", () => {
    const record = (t: number, stock: Partial<StateMap["stock"]>): LogRecord =>
      ({ t, seq: t, run: "r", src: "sim", kind: "state", key: "stock", data: { hasWseAccount: true, hasTixApiAccess: true, ...stock } }) as LogRecord;
    const state = appendRecords(emptyState(), [
      record(0, { tradeCashFlow: -10_000, portfolioValue: 10_000, portfolioCost: 10_000, unlockSpend: 5.2e9 }),
      record(1_000, { tradeCashFlow: -10_000, portfolioValue: 12_000, portfolioCost: 10_000, unlockSpend: 5.2e9 }),
    ]);
    const html = TABS["stock"].render(state);
    // Both canvases, each paired with its own tooltip — the id convention
    // mountChart resolves against.
    expect(html).toContain('id="stock-book"');
    expect(html).toContain('id="stock-booktip"');
    expect(html).toContain('id="stock-earnings"');
    expect(html).toContain('id="stock-earningstip"');
    // The rate tile now has an interval to divide by.
    expect(html).toContain("/s since first trade");
  });

  test("a collapsed position horizon is named, not left as an empty action list", () => {
    const state = emptyState();
    state.topics.stock = {
      hasWseAccount: true,
      hasTixApiAccess: true,
      plan: { actions: [], ranked: [], horizons: { positionSec: 0, unlockSec: 0 }, flat: true },
    } as StateMap["stock"];
    const html = TABS["stock"].render(state);
    expect(html).toContain("collapsed");
    expect(html).toContain("no trade can clear its round trip");
  });

  test("the stock decision history names the trade, not \"hold\"", () => {
    const state = emptyState();
    state.topics.stock = { hasWseAccount: true, hasTixApiAccess: true } as StateMap["stock"];
    // A StockPlan carries neither `buy.kind` nor a named `reserve`, so without
    // the entry/unlock rungs in the shared selection chain every stock row
    // falls through to the "hold" default and the trade log says nothing.
    state.events.push(
      { t: 10, seq: 1, run: "r", src: "sim", kind: "event", name: "investment.decision", data: { subsystem: "stock", plan: { entry: { sym: "ECP", side: "long" } } } } as never,
      { t: 20, seq: 2, run: "r", src: "sim", kind: "event", name: "investment.result", data: { subsystem: "stock", result: { action: "buy", ok: true, detail: "bought 1000 ECP" } } } as never,
    );
    const html = TABS["stock"].render(state);
    expect(html).toContain("Decision history");
    expect(html).toContain("long ECP");
    expect(html).toContain("bought 1000 ECP");
    expect(html).not.toContain(">hold<");
  });

  test("structured plans expose decision evidence without authored rationale", () => {
    const state = emptyState();
    state.topics.bladeburner = {
      rank: 100, skillPoints: 3, stamina: [50, 100], city: "Sector-12",
      plan: {
        action: { type: "act", actionType: "contract", name: "Tracking" },
        ranked: [{ name: "Tracking", actionType: "contract", rankPerSec: 2.5, chanceLow: 0.8 }],
      },
    };
    state.topics.corp = {
      name: "Acme", funds: 1e9, revenue: 1e6, expenses: 5e5, public: false,
      valuation: 1e10, sharePrice: 10, totalShares: 1e9, numShares: 9e8,
      issuedShares: 0, dividendRate: 0, dividendEarnings: 0, state: "START",
      plan: {
        action: { type: "expandCity", division: "Agriculture", city: "Aevum" },
        stage: "agriculture-cities", completed: ["found", "agriculture"],
      },
    };
    state.topics.dnet = {
      maxDepth: 1, stasisLinkLimit: 2, stasisLinked: [], topologyComplete: true,
      instability: { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0.1 },
      // Home's own one-hop reading, in the shape an agent reports. The panel
      // renders the FOLD below; the driver folds this into it as one more vantage.
      probed: [
        {
          hostname: "dn-1", at: 1_000, present: true, depth: 1, blockedRam: 11, requiredCharisma: 50,
          maxRam: 16, usedRam: 0, modelId: "2G_cellular", passwordLength: 6,
          passwordFormat: "numeric", passwordHint: "the dog, obviously", data: "rex",
          logTrafficInterval: 45, difficulty: 3, isStationary: true, hasSession: false,
        },
        // A host that went offline answers with a dummy details object, so
        // everything except its liveness is absent.
        { hostname: "dn-gone", at: 1_000, present: false },
      ],
      knowledge: {
        at: 1_000,
        generation: "15:0",
        gone: 1,
        truncated: true,
        totalHosts: 220,
        agents: { live: 1, seenEver: 1, lostSinceBoot: 0 },
        overseer: { host: "darkweb", pid: 42, lastBeatAt: 900, alive: true, seedAttempts: 2 },
        hosts: [
          {
            hostname: "dn-1", depth: 1, lastSeenAt: 1_000, blockedRam: 11, requiredCharisma: 50,
            maxRam: 16, usedRam: 0, freeRam: 5, modelId: "2G_cellular", passwordLength: 6,
            passwordFormat: "numeric", passwordHint: "the dog, obviously", data: "rex",
            // Half a second, so against this fixture's 1s clock the ring has
            // genuinely minted lines and the listening ranking has something to
            // rank. A deep host really is this chatty — 2.3s at difficulty 30.
            logTrafficInterval: 0.5, difficulty: 3, isStationary: true,
            authState: "auth-required",
            facts: { depth: 1_000, modelId: 1_000, maxRam: 1_000 },
            caches: ["loot.cache", "hunt.d.cache"],
            attempt: {
              modelId: "2G_cellular", status: "failed", tried: 3, probes: 1,
              lastCode: 401, lastAt: 1_000 - 30_000,
              solving: true, solve: { phase: "narrowing", spent: 12 },
            },
          },
          { hostname: "dn-gone", lastSeenAt: 1_000, goneAt: 1_000, facts: {}, authState: "offline" },
        ],
      },
      plan: {
        ranked: [{ hostname: "dn-1", depth: 1, unlocks: 3 }],
        charismaNeeded: 50,
      },
      netDepth: 7,
      charisma: 400,
      grammar: { unrecognised: 5, shapes: { "a a: a#": 3 } },
      hold: {
        admitted: { pin: 1, walk: 1 },
        refused: { "no-slot": 2 },
        examples: [{ host: "dn-1", why: "no-slot", detail: "all 2 stasis links are spent" }],
        backdoors: {
          install: ["dn-1"],
          refused: { unstable: 1 },
          examples: [{ host: "dn-gone", why: "unstable", detail: "authentication already costs x1.30" }],
        },
      },
      listen: {
        refused: { "nothing-to-learn": 4 },
        examples: [{ host: "dn-gone", why: "nothing-to-learn", detail: "every line it can write is spam" }],
      },
      labCache: { host: "th3_l4byr1nth", filename: "lab.cache", openable: false },
      channel: { drained: 4, rejected: 1, forgotten: 0 },
      farm: {
        admitted: { phish: 1 },
        refused: { "cache-none": 2 },
        examples: [{ host: "dn-1", why: "cache-none", detail: "no .cache file on this host" }],
        cacheHunter: "dn-1",
        // Two minutes into a three-minute window, so the countdown is a real
        // number rather than "open".
        lastPhishCacheAt: 1_000 - 120_000,
      },
      spread: {
        planted: 2,
        refused: { "not-enough-ram": 3 },
        examples: [{ host: "dn-1", why: "not-enough-ram", detail: "1.00GB free, needs 2.60GB" }],
      },
    };
    state.topics.gang = {
      faction: "Slum Snakes", isHacking: false, respect: 100, respectGainRate: 1,
      wantedLevel: 2, wantedLevelGainRate: 0.1, wantedPenalty: 0.9, moneyGainRate: 500,
      power: 10, territory: 0.2, territoryClashChance: 0.1, territoryWarfareEngaged: false,
      respectForNextRecruit: 200, recruitsAvailable: 0, canRecruit: false, members: [],
      plan: {
        actions: [{ type: "assign", member: "m-1", task: "Mug People" }],
        assignment: { total: 12.5, approximated: false, choices: [{ member: "m-1", task: "Mug People", score: 12.5 }] },
      },
    };
    state.topics.sleeves = {
      count: 1,
      sleeves: [{ index: 0, shock: 0, sync: 100, memory: 1, storedCycles: 0, city: "Aevum", hp: { current: 10, max: 10 }, skills: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1 } }],
      plan: {
        assignments: [{ index: 0, task: "crime:Mug" }],
        selection: [{ index: 0, task: "crime:Mug", score: 4.2 }],
        totalScore: 4.2,
      },
    };
    state.topics.stanek = {
      width: 2, height: 2, occupied: {}, fragments: [],
      plan: {
        placements: [{ id: 1, x: 0, y: 0, rotation: 0 }], value: 9,
        approximated: false, chargeOrder: [1],
      },
    };

    const rendered = ["bladeburner", "corp", "dnet", "gang", "sleeves", "stanek"]
      .map((id) => TABS[id as TabId].render(state))
      .join("\n");
    expect(rendered).toContain("rank/sec");
    expect(rendered).toContain("agriculture-cities");
    expect(rendered).toContain("servers kept reachable");
    expect(rendered).toContain("raw score");
    expect(rendered).toContain("total score");
    expect(rendered).toContain("objective value");
    expect(rendered).not.toContain("invented");
    // The darknet's discovery surface is rendered, because the whole point of
    // acquiring it is to be able to look at it.
    expect(rendered).toContain("2G_cellular");
    expect(rendered).toContain("6 × numeric");
    expect(rendered).toContain("the dog, obviously");
    // Usable RAM is maxRam minus the owner's block, and it is what decides
    // whether an agent fits: 16 - 11 - 0.
    expect(rendered).toContain("5.00GB");
    // getDepth's -1 sentinel is "unknown", never a depth to render or sort on.
    expect(rendered).not.toContain(">-1<");
    // Why the net is not growing. `planSpread` has named its refusals since it
    // was written and nothing rendered them, so a planner that had run out of
    // reachable hosts read identically to one that had stopped working.
    expect(rendered).toContain("not-enough-ram");
    expect(rendered).toContain("1.00GB free, needs 2.60GB");

    // Solve progress, not "why untouched". Nineteen solvers exist and the five
    // dictionary models are walked, so the old column answered a question
    // nobody is asking; what an operator wants is how far each host got.
    expect(rendered).toContain("solve progress, every host");
    expect(rendered).not.toContain("why untouched");
    // The last response code, WITH its age — a code alone does not say whether
    // the conversation is live or was abandoned.
    expect(rendered).toContain("30s ago");

    // The digest caps at KNOWLEDGE_MAX_HOSTS, and a capped count that does not
    // say so is a smaller net than the one we are flying.
    expect(rendered).toContain("220");

    // Where the overseer is standing, not merely that it is.
    expect(rendered).toContain("pid 42");

    // The labyrinth cache is a DECISION — opening it multiplies every
    // augmentation still unbought by 1.9x — so it is named and its gate stated.
    expect(rendered).toContain("lab.cache");
    expect(rendered).toContain("th3_l4byr1nth");
    // The ladder's charisma gate, against what we actually hold.
    expect(rendered).toContain("Labyrinth");

    // `offline` is a real auth state that the servers table used to omit while
    // the map rendered it, so a host that answered "I am not there" was blank.
    expect(rendered).toContain("(offline)");

    // Solver progress: spent against a budget DERIVED from the published
    // password facts, plus the phase. A multi-hundred-attempt solve used to be
    // indistinguishable from an idle host.
    expect(rendered).toContain("narrowing");
    expect(rendered).toMatch(/12\/\d+/);

    // An unopened cache dies with its host, and `.d.cache` is the only kind that
    // can carry a coding contract.
    expect(rendered).toContain("loot.cache");
    expect(rendered).toContain("a .d.cache can carry a contract");

    // The net-wide phishing window, counted down. It is engine state no ns
    // member exposes, so our own sightings are the only evidence there is.
    expect(rendered).toContain("phish window");
    expect(rendered).toContain("shut — 60s left");

    // What grinding the owner's block would actually cost, as a number rather
    // than prose buried in a refusal.
    expect(rendered).toContain("11GB blocked");

    // Grammar drift is the same class of event as an unrecognised model id, and
    // it reaches the screen as a SHAPE. The line itself never leaves the game:
    // an unparsed line is one we failed to read, and the noise generator writes
    // cleartext passwords into log lines.
    expect(rendered).toContain("unparsed log lines");
    expect(rendered).toContain("a a: a#");

    // Which ring to read next, ranked by expected USEFUL lines. Depth and age
    // both fail as proxies — a deep host is chatty but its neighbour-credential
    // branch is thirty times rarer — so the panel ranks on the model's own
    // number, derived here from facts the digest already carries.
    expect(rendered).toContain("useful lines");
    expect(rendered).toContain('data-sort-table="dnet.listen"');
    // And why the rest were declined, by name.
    expect(rendered).toContain("nothing-to-learn");
    expect(rendered).toContain("every line it can write is spam");

    // The three actions with a real price. Their refusals get as much room as
    // the actions, because "why not" is the usual answer for all three.
    expect(rendered).toContain("Deliberate");
    expect(rendered).toContain("no-slot");
    expect(rendered).toContain("all 2 stasis links are spent");
    // The backdoor plan used to be ADVICE — no ns.dnet member installs one — and
    // said so. It is now carried out, from HOME: `singularity.installBackdoor`
    // acts on the terminal's current server, so the one process with a terminal
    // is the one that can spend the allowance. The panel says where it happens
    // and what refuses it, because the refusal is still the usual answer.
    expect(rendered).toContain("backdoors — installed from HOME");
    expect(rendered).toContain("ns.scan cannot see the darknet");
    expect(rendered).not.toContain("nothing out there can act on it");
  });

  test("the darknet panel survives a driver tick that no probe has preceded", () => {
    // `knowledge` comes from the DRIVER; `instability`, `stasisLinkLimit` and
    // `stasisLinked` come only from the dodged probe. The panel guarded on the
    // first and then dereferenced the other three, so the first tick of a run
    // whose probe had not landed threw a TypeError and took the whole panel
    // with it. Every other dnet fixture in this file supplies all four, which
    // is exactly why nothing caught it.
    const state = emptyState();
    state.topics.dnet = {
      maxDepth: -1,
      knowledge: {
        at: 1_000,
        generation: "15:0",
        gone: 0,
        agents: { live: 0, seenEver: 0, lostSinceBoot: 0 },
        hosts: [{ hostname: "darkweb", lastSeenAt: 1_000, isDarkweb: true, depth: -1, facts: {} }],
      },
    };

    const html = TABS.dnet.render(state);
    // It renders at all — the assertion the crash made impossible.
    expect(html).toContain("darkweb");
    // The unobserved readings say so rather than inventing a number.
    expect(html).toContain("awaiting the probe");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
    // -1 is getDepth's "no idea". It is not a depth, so it is not rendered as
    // one — in the TILE as well as in the table.
    expect(html).not.toContain(">-1<");
  });

  test("the raw event view renders payload facts and observed codes", () => {
    // Planner prose no longer exists anywhere in the pipeline, so the payload
    // renders verbatim: structured values and categorical reason codes.
    const state = emptyState();
    state.runId = "test";
    state.events.push({
      kind: "event", name: "feature.decision", data: { score: 7, reason: "insufficient-money" },
      seq: 1, t: 1_000, run: "test", src: "game",
    });
    const html = TABS.overview.render(state);
    expect(html).toContain("score");
    expect(html).toContain("insufficient-money");
  });

  test("Go shows reproducible decision inputs, forecast support, and the observed reply", () => {
    const state = emptyState();
    state.topics.go = {
      status: "inProgress",
      currentPlayer: "Black",
      opponent: "Netburners",
      boardSize: 5,
      board: ["X....", ".X...", "..O..", ".....", "....."],
      previousBoards: [],
      stats: [],
      plan: {
        action: { type: "move", x: 1, y: 1 },
        ranked: [{
          x: 1, y: 1, score: 0.84, powerPerRound: 5.5, captures: 1,
          predictedReplies: [{ x: 2, y: 2, count: 5 }, { x: null, y: null, count: 1 }],
        }],
        input: { at: 1_000, board: [".....", ".....", ".....", ".....", "....."], previousBoards: [], status: "inProgress", currentPlayer: "Black" },
        planning: { finalistCount: 4, positionValue: 0.25 },
        selection: {
          preferred: {
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, aligned: false, waitSec: 0, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0,
          },
          candidates: [{
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, aligned: false, waitSec: 0, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0,
          }],
          context: {
            goPower: 1, hasSourceFile14: false, favorRepCap: 100_000, installRemainingSec: 3_600,
            joinedFactions: [], demands: {},
          },
        },
      },
      lastTurn: {
        at: 1_100,
        durationMs: 205,
        action: { type: "move", x: 1, y: 1 },
        opponentResponse: { type: "move", x: 2, y: 2 },
        predictionSupport: { matching: 5, total: 6 },
        prediction: {
          model: "clean-room-v3.0.1",
          sampledTotalPlaytime: 100_000,
          sampledAt: 900,
          decisionAt: 1_000,
          preparationMs: 1.2,
          finalizationMs: 0.8,
          totalPlanningMs: 2,
          dispatchBreakdown: {
            totalMs: 320,
            admitMs: 18, prepareMs: 242, leaseMs: 12, finalizeMs: 8, alignMs: 38, dispatchMs: 1, residualMs: 1,
          },
          engineCycleMs: 200,
          aiWaitMs: 200,
          seedCandidates: [100_200],
          dispatchPlaytime: 100_000,
          boundaryRetries: 0,
        },
        ok: true,
        detail: "move; opponent move",
      },
    };
    const html = TABS.go.render(state);
    expect(html).toContain("Candidate analysis");
    expect(html).toContain("5.00/6");
    expect(html).toContain("forecast weight on the reply that arrived");
    expect(html).toContain("clean-room-v3.0.1");
    expect(html).toContain("exact seed");
    // Fixed game parameters sit apart from what this turn measured, so
    // neither can be read as the other.
    expect(html).toContain("engine constants — 200 ms cycle, 200 ms AI wait");
    expect(html).toContain("worker — 1.2ms preparation; 0.8ms evaluation");
    // Alignment is read off the prediction; nothing mirrors it separately.
    expect(html).toContain("same-slot; full turn 205ms");
    expect(html).toContain("dispatch tick 100.000s");
    // The total alone cannot separate a slow worker from a deliberate wait for
    // the next engine cycle, which is the reason the segments exist.
    expect(html).toContain("ready to play");
    expect(html).toContain("admit 18ms");
    expect(html).toContain("plan 242ms");
    expect(html).toContain("align 38ms (deliberate)");
    expect(html).toContain("slowest plan");
    // One board, not two: the pre-move grid said nothing the markers do not.
    expect(html.split("class=\"goboard\"").length - 1).toBe(1);
    // The ranking table changes height every turn; the stable tables sit above.
    expect(html.indexOf("Opponent reward choice")).toBeLessThan(html.indexOf(">Record<"));
    expect(html.indexOf(">Record<")).toBeLessThan(html.indexOf("Candidate analysis"));
    expect(html).toContain("class=\"go-point black chosen\"");
    expect(html).toContain("class=\"go-point white reply\"");
    expect(html).toContain("class=\"go-marker chosen\"");
    expect(html).toContain("class=\"go-marker reply\"");
    expect(html).toContain("class=\"go-link north black\"");
    expect(html).toContain("class=\"go-link east black\"");
    expect(html).toContain("aria-label=\"5 by 5 IPvGO board\"");
    expect(html.indexOf("A5 (0,4)")).toBeLessThan(html.indexOf("A1 (0,0)"));
    expect(html).toContain("Opponent reward choice");
    expect(html).toContain("GoPower");
    expect(html).toContain("install runway");
    expect(html).toContain("favor event");
  });

  test("Go renders controlled and broken nodes without inventing another probe", () => {
    const state = emptyState();
    state.topics.go = {
      status: "inProgress",
      currentPlayer: "Black",
      opponent: "Netburners",
      boardSize: 5,
      board: ["XXXXX", "X...X", "X.#.X", "X...X", "XXXXX"],
      previousBoards: [],
      stats: [],
    };

    const html = TABS.go.render(state);
    expect(html).toContain("go-point empty territory-black");
    expect(html).toContain("go-point dead");
    expect(html).toContain("go-link north black");
    expect(html).toContain("C3 (2,2) — no signal");
  });

  test("Go shades exactly the space the territory count awards", () => {
    const state = emptyState();
    state.topics.go = {
      status: "inProgress",
      currentPlayer: "Black",
      opponent: "Netburners",
      boardSize: 5,
      // One opening stone borders all 24 remaining nodes. IPvGO deliberately
      // awards no such almost-board-sized region, so the picture must not
      // claim territory the count beside it does not include.
      board: ["X....", ".....", ".....", ".....", "....."],
      previousBoards: [],
      territory: { black: 0, white: 0 },
      stats: [],
    };

    const html = TABS.go.render(state);
    expect(html).not.toContain("territory-black");
    expect(html).toContain("controlled empty nodes — black 0, white 0");
  });

  test("Side shows compact status plus the latest report-once replay", () => {
    const state = emptyState();
    state.lastT = 2_000;
    state.topics.side = {
      contracts: [{ host: "n00dles", file: "next.cct" }],
      contractTotal: 2,
      solvableTotal: 1,
      registryComplete: true,
      contractTypeTotal: 30,
      supportedTypeTotal: 30,
      failures: [{
        host: "n00dles", file: "bad.cct", type: "Array Jumping Game", reason: "answer rejected", triesBefore: 1, at: 1_000,
      }],
      quarantinedTotal: 1,
    };
    state.events.push({
      seq: 1,
      t: 1_000,
      run: "r",
      src: "game",
      kind: "event",
      name: "contract.quarantined",
      data: {
        host: "n00dles",
        file: "bad.cct",
        type: "Array Jumping Game",
        data: "[2,<script>]",
        answer: "1",
        triesBefore: 1,
        reason: "answer rejected",
        at: 1_000,
      },
    });
    state.contractReplay = state.events[0]!.data as NonNullable<typeof state.contractReplay>;

    const html = TABS.side.render(state);
    expect(html).toContain("30/30");
    expect(html).toContain("input · 12 chars");
    expect(html).toContain("[2,&lt;script&gt;]");
    expect(html).not.toContain("[2,<script>]");
    expect(html).toContain("submitted answer · 1 chars");
    expect(html).not.toContain("Infiltration value");
    expect(html).not.toContain("Casino");
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
        { ...base, seq: 1, kind: "event", name: "probe.failed", data: { id: "corp.core" } },
      ] as LogRecord[],
      Infinity,
      { id: "r", src: "game", live: true, t0: 0 },
    );
    expect(state.caps.bitNode).toBe(3);
    expect(state.topics.capabilities).toBeDefined();
    expect(state.events.length).toBe(1);
    expect(state.events[0]!.kind).toBe("event");
  });

  test("a contract replay survives eviction from the bounded event feed", () => {
    const replay = {
      host: "n00dles", file: "bad.cct", type: "Array Jumping Game", data: "[0]", answer: "1",
      reason: "answer rejected", at: 0,
    };
    const records: LogRecord[] = [
      { ...base, kind: "event", name: "contract.quarantined", data: replay },
      ...Array.from({ length: EVENT_RING + 1 }, (_, index) => ({
        ...base,
        seq: index + 1,
        t: index + 1,
        kind: "debug" as const,
        msg: "noise",
      })),
    ];
    const state = project(records, Infinity, { id: "r", src: "game", live: false, t0: 0 });
    expect(state.events.some((record) => record.kind === "event" && record.name === "contract.quarantined")).toBe(false);
    expect(state.contractReplay).toEqual(replay);
  });

  test("sim validity and authoritative gap counts survive event-ring eviction", () => {
    const records: LogRecord[] = [
      { ...base, kind: "event", name: "sim.meta", data: { driver: "game", seed: 7, scenario: "synthetic-early-game" } },
      { ...base, seq: 1, kind: "event", name: "sim.unmodeled", data: { kind: "ns", name: "go.getBoardState", detail: "runtime missing" } },
      ...Array.from({ length: EVENT_RING + 1 }, (_, index) => ({
        ...base, seq: index + 2, t: index + 2, kind: "debug" as const, msg: "noise",
      })),
      {
        ...base,
        seq: EVENT_RING + 3,
        t: EVENT_RING + 3,
        kind: "event",
        name: "sim.result",
        data: {
          validity: "invalid-for-goal", reached: false, stoppedBecause: "horizon",
          scenario: "synthetic-early-game", unmodeled: { "ns go.getBoardState": 7 },
        },
      },
    ] as LogRecord[];
    const state = project(records, Infinity, { id: "r", src: "sim", live: false, t0: 0 });

    expect(state.events.some((record) => record.kind === "event" && record.name === "sim.unmodeled")).toBe(false);
    expect(state.simResult?.validity).toBe("invalid-for-goal");
    const html = TABS["overview"].render(state);
    expect(html).toContain("invalid-for-goal");
    expect(html).toContain("go.getBoardState");
    expect(html).toContain(">7<");
    expect(html).not.toContain("this run stayed inside what the simulator models");
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
  test("progression shows separate install/node countdowns and their critical-path evidence", () => {
    const state = emptyState();
    const now = Date.now();
    state.topics.progression = {
      bitNode: 14,
      sourceFiles: {},
      ownedAugs: {},
      augCount: 0,
      lastAugReset: now - 60_000,
      lastNodeReset: now - 120_000,
      plan: {
        phase: "finishUp",
        installWanted: true,
        liquidationWanted: true,
        installBlockers: ["factions"],
        installReady: false,
        queuedAugmentations: ["BitWire"],
        install: false,
        favorCrossings: [],
        forecasts: {
          install: {
            state: "estimated", estimatedAt: now, nextRecalibrationAt: now + 600_000,
            expectedAt: now + 660_000, remainingSec: 660, confidence: "mixed", basis: "package",
            components: [
              { what: "faction unlock and reputation", resource: "reputation", sec: 600, measured: true, mode: "parallel", critical: true },
              { what: "package money", resource: "money", sec: 300, measured: true, mode: "parallel", critical: false },
              { what: "final purchase and donation sweep", resource: "install", sec: 60, measured: false, mode: "sequential", critical: true },
            ],
          },
          node: {
            state: "estimated", estimatedAt: now, nextRecalibrationAt: now + 600_000,
            expectedAt: now + 172_800_000, remainingSec: 172_800, confidence: "measured", basis: "route",
            components: [{ what: "hacking level", resource: "hacking", sec: 172_800, measured: true, mode: "sequential", critical: true }],
          },
        },
      },
    };

    const html = TABS["progression"].render(state);
    expect(html).toContain("Expected next installation");
    expect(html).toContain("Expected BitNode completion");
    expect(html).toContain("faction unlock and reputation");
    expect(html).toContain("final purchase and donation sweep");
    expect(html).toContain("model/fallback");
    expect(html).toContain("2.0d");
  });

  test("progression renders the endgame route and the cadence verdict", () => {
    const state = emptyState();
    const now = Date.now();
    state.cadenceAccrued = [[0, 0.1], [60_000, 0.4]];
    state.topics.progression = {
      bitNode: 4,
      sourceFiles: {},
      ownedAugs: {},
      augCount: 0,
      lastAugReset: now - 60_000,
      lastNodeReset: now - 120_000,
      plan: {
        phase: "start",
        installWanted: false,
        liquidationWanted: false,
        installBlockers: [],
        installReady: false,
        queuedAugmentations: [],
        install: false,
        favorCrossings: [{ faction: "CyberSec", favorNow: 120, favorAfter: 152 }],
        route: "daedalus",
        decidedAt: now - 300_000,
        routes: [
          {
            id: "daedalus", available: true, complete: false, blocker: "2.5m Daedalus rep",
            etaSec: 7_200,
            parts: [{ what: "daedalus reputation", resource: "reputation", sec: 7_000, measured: true }, { what: "install overhead", resource: "install", sec: 200, measured: false }],
          },
          {
            id: "bladeburner", available: false, complete: false, blocker: "join Bladeburner",
            etaSec: 90_000,
            parts: [{ what: "bladeburner rank", resource: "combat", sec: 90_000, measured: false }],
          },
        ],
        installDecision: {
          verdict: "push",
          effective: "push",
          pushRate: 9.1e-3,
          threshold: 2.9,
          resetValueMult: 1.2,
          resetFavorValue: 0.3,
          pushEtaSec: 4_700,
          remainingSec: 7_200,
          latched: false,
        },
        forecasts: {
          install: { state: "unknown", reason: "no data", evaluatedAt: now, nextRecalibrationAt: now + 600_000, basis: "none" },
          node: { state: "unknown", reason: "no data", evaluatedAt: now, nextRecalibrationAt: now + 600_000, basis: "none" },
        },
      },
    };

    const html = TABS["progression"].render(state);
    expect(html).toContain("Endgame route");
    expect(html).toContain("daedalus");
    expect(html).toContain("2.00h ETA · available");
    expect(html).toContain("2.5m Daedalus rep");
    expect(html).toContain("daedalus reputation");
    expect(html).toContain("Install cadence");
    expect(html).toContain("push before latch");
    expect(html).not.toContain("fastest measured ending");
    expect(html).not.toContain("accrued value below the cadence threshold");
    expect(html).toContain("cadencechart");
    expect(html).toContain("CyberSec");
    // A plan recorded before these fields existed still renders.
    delete state.topics.progression!.plan!.routes;
    delete state.topics.progression!.plan!.installDecision;
    const bare = TABS["progression"].render(state);
    expect(bare).toContain("waiting for the endgame route estimates");
    expect(bare).toContain("waiting for the cadence verdict");
  });

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
      progress: 0,
    }));
    // ...plus one distinct, higher-priority ask that must stay separate.
    const plan = {
      serving: [
        ...serving,
        { by: "factions", kind: "skill", subject: "agility", target: 850, have: 749, weight: 4.5, urgency: "blocking" as const, progress: 0.881 },
      ],
      ranked: [],
      action: { type: "idle" },
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
        { by: "factions", kind: "skill", subject: "hacking", target: 1500, have: 1348, weight: 4.6, urgency: "wanted" as const, progress: 0.898 },
        { by: "career", kind: "skill", subject: "hacking", target: 2500, have: 1348, weight: 3.2, urgency: "wanted" as const, progress: 0.539 },
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
        { by: "a", kind: "skill", subject: "agility", target: 300, have: 300, weight: 1, urgency: "wanted" as const, progress: 1 },
        { by: "b", kind: "skill", subject: "agility", target: 850, have: 300, weight: 1, urgency: "wanted" as const, progress: 0.35 },
      ],
      ranked: [],
      action: { type: "idle" },
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

describe("faction decision review", () => {
  test("shows decision inputs, package economics, cycle exclusions, and transition history", () => {
    const state = emptyState();
    state.lastT = 10_000;
    const intent = {
      faction: "CyberSec",
      repTarget: 2_000,
      augmentations: ["Synaptic Enhancement Implant"],
      value: 1.03,
      etaSec: 120,
      rate: 0.0086,
      marginalRate: 0.007,
      unlockSec: 0,
      repSec: 90,
      moneySec: 120,
      favorAfterInstall: 151,
      totalCost: 2_674_166_667,
      purchaseCost: 7_500_000,
      donationCost: 2_666_666_667,
      purpose: "augmentations" as const,
    };
    const plan = {
      context: {
        evaluatedAt: 9_000,
        horizonSec: 3_600,
        route: "daedalus" as const,
        targetAugCount: 30,
        ownedAugCount: 12,
        queuedAugCount: 2,
        incomePerSec: 5_000_000,
        moneyAvailable: 1_500_000_000,
        moneyGranted: 2_674_166_667,
        holdsWorkSlot: true,
        favorToDonate: 150,
        priceQueue: { nonSoA: 2, ownedSoA: 0, neurofluxLevel: 0 },
      },
      objective: {
        factions: ["CyberSec"],
        augmentations: intent.augmentations,
        value: intent.value,
        foreclosed: [{ name: "NiteSec", bannedBy: "CyberSec" }],
        intent,
      },
      action: { type: "donate", faction: "CyberSec", amount: 2_666_666_667 },
      alternatives: [],
      blockers: [],
      invalidation: [{ label: "owned", value: 12 }],
    };
    state.topics.factions = { joined: ["CyberSec"], plan };
    state.events.push({
      kind: "event",
      name: "faction.decision",
      data: { plan },
      seq: 1,
      t: 9_000,
      run: "test",
      src: "game",
    });

    const html = TABS["factions"].render(state);
    expect(html).toContain("planning window");
    expect(html).toContain("marginal/sec");
    expect(html).toContain("forecloses this install cycle");
    expect(html).toContain("Decision history");
    expect(html).toContain("$2.667e9 to CyberSec");
    expect(html).not.toContain("income beats work");
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

/** The reworked Batches card, driven through the real fold so the per-batch
 * history exists — the card's primary view is a scatter over it, and setting
 * `topics.farm` directly leaves it empty. */
describe("the Batches card is per-batch", () => {
  const batch = (id: number, at: number, over: Record<string, unknown> = {}) => ({
    id, kind: "hgw", target: "phantasy", at, spanMs: 2_000, ops: 4, landed: 4,
    threads: { hack: 10, grow: 20, weaken: 5 }, gb: 500, moneyEarned: 1_000,
    order: "h-w1-g-w2", planned: "h-w1-g-w2", ...over,
  });

  const farm = (t: number, over: Record<string, unknown>): LogRecord =>
    ({ t, seq: t, run: "r", src: "sim", kind: "state", key: "farm",
       data: { totals: { moneyEarned: 0, hacks: 0 }, ...over } }) as LogRecord;

  function populated(): ProjectedState {
    return appendRecords(emptyState(), [
      farm(1_000, {
        launched: { hack: 10, grow: 10, weaken: 10 },
        landed: { hack: 10, grow: 10, weaken: 10 },
        inFlight: { hack: 0, grow: 0, weaken: 0 },
        pumpOccupancy: 0.04,
        batches: {
          hgw: {
            batches: 20, ops: 80, landed: 80, threads: { hack: 200, grow: 400, weaken: 100 },
            gb: 10_000, moneyEarned: 20_000, hacks: 20, spanMs: 40_000, graded: 20, inOrder: 20,
            noHack: 0, abandoned: 0, abandonedOps: 0, abandonedLanded: 0,
          },
        },
        recentBatches: [batch(1, 1_000), batch(2, 1_100)],
      }),
      farm(3_000, {
        // Three ops launched that are neither in flight nor landed: adrift.
        launched: { hack: 20, grow: 20, weaken: 20 },
        landed: { hack: 19, grow: 19, weaken: 19 },
        inFlight: { hack: 0, grow: 0, weaken: 0 },
        pumpOccupancy: 0.06,
        batches: {
          hgw: {
            batches: 40, ops: 160, landed: 160, threads: { hack: 400, grow: 800, weaken: 200 },
            gb: 20_000, moneyEarned: 40_000, hacks: 40, spanMs: 80_000, graded: 40, inOrder: 39,
            noHack: 0, abandoned: 1, abandonedOps: 4, abandonedLanded: 3,
          },
        },
        recentBatches: [batch(3, 3_000, { moneyEarned: 9_000 }), batch(4, 3_100, { order: "g-h-w1-w2" })],
      }),
    ]);
  }

  test("the per-batch timeline leads, and the per-kind grid is demoted below it", () => {
    const html = TABS.hacking.render(populated());
    expect(html).toContain(`id="batch-timeline"`);
    // Both present, and in this order: the batch is the unit, the kind is a summary.
    expect(html.indexOf("batch-timeline")).toBeGreaterThan(-1);
    expect(html.indexOf(`class="batchgrid"`)).toBeGreaterThan(html.indexOf("batch-timeline"));
  });

  test("the metric chips pick what the scatter plots, defaulting to a rate", () => {
    const html = TABS.hacking.render(populated());
    // Size-normalised by default: ranking batches on raw earnings ranks them by
    // size, and a prep wave and a farm cycle differ by orders of magnitude.
    expect(html).toContain(`data-view-key="hacking.batchMetric"`);
    expect(html).toContain(">$/GB·s<");
    expect(html).toMatch(/class="chip pick sel"[^>]*data-view-value="rate"/);
  });

  test("the sample is reported as a sample, with its census beside it", () => {
    // Four batches caught out of forty settled. Presenting the four as if they
    // were the population is the trap this wording exists to avoid.
    const html = TABS.hacking.render(populated());
    expect(html).toContain("4 of 40 batches sampled");
  });

  test("loss is reported where it can be observed", () => {
    const html = TABS.hacking.render(populated());
    // The abandoned batch, and the op it took with it.
    expect(html).toContain("1 abandoned, 1 ops lost");
    // And the run-level residual: 60 launched, 57 landed, none in flight.
    expect(html).toContain("ops adrift");
    expect(html).toContain(`id="ops-lost"`);
  });

  test("picking a batch opens it, and names what it is compared against", () => {
    setView("hacking.batch", "3");
    const html = TABS.hacking.render(populated());
    expect(html).toContain("batch #3");
    expect(html).toContain("phantasy");
    // 9000 over 500 GB * 2 s = $9/GB·s against a median of $1 — the outlier is
    // the point of picking it.
    expect(html).toContain("x its kind's median");
    setView("hacking.batch", "");
  });

  test("a picked batch that has aged out says so rather than vanishing", () => {
    setView("hacking.batch", "99999");
    const html = TABS.hacking.render(populated());
    expect(html).toContain("no longer held");
    setView("hacking.batch", "");
  });

  test("health gauges are drawn as trends, not as a row of latest values", () => {
    const html = TABS.hacking.render(populated());
    // Occupancy is the leading indicator the tab's own notes name, and it was
    // published and drawn nowhere.
    expect(html).toContain(`id="health-occupancy"`);
    expect(html).toContain(`id="health-inorder"`);
  });

  test("a compacted run says why the card is empty", () => {
    const state = emptyState();
    state.compacted = true;
    const html = TABS.hacking.render(state);
    expect(html).toContain("served compacted");
    // Not "waiting for a batch to settle", which blames the farm for a
    // limitation of how the run was stored.
    expect(html).not.toContain("waiting for a batch to settle");
  });
});

/** The pure-failure case, end to end through the wire shape.
 *
 * A kind whose every batch dies before settling has `batches: 0`. Both the
 * emitter's publication filter and the tab's own filter tested that field
 * alone, so the mode most worth reporting rendered exactly like one the save
 * had never used. */
describe("a batch kind that only ever fails is still reported", () => {
  test("an abandoned-only kind gets a column and says what happened", () => {
    const state = emptyState();
    state.topics.farm = {
      totals: { moneyEarned: 0, hacks: 0 },
      batches: {
        hwgw: {
          batches: 0, ops: 0, landed: 0, threads: { hack: 0, grow: 0, weaken: 0 },
          gb: 0, moneyEarned: 0, hacks: 0, spanMs: 0, graded: 0, inOrder: 0, noHack: 0,
          abandoned: 7, abandonedOps: 28, abandonedLanded: 12,
        },
      },
    } as StateMap["farm"];
    const html = TABS.hacking.render(state);
    expect(html).toContain(">hwgw<");
    expect(html).toContain("7 abandoned, 16 ops lost");
    // And it is not mistaken for a farm that has not started yet.
    expect(html).not.toContain("waiting for a batch to settle");
  });
});
