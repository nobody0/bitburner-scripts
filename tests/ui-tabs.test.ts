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

  test("every feature's populated panel renders", () => {
    // One synthetic record per topic, so no panel's data branch is untested
    // just because the local save cannot reach that feature.
    // Keep the former prose-bearing shapes here as legacy replay coverage:
    // feature panels must render old JSONL without displaying those fields.
    const topics = {
      farm: { target: "n00dles", totals: { moneyEarned: 1e6, hacks: 12 }, inFlight: { hack: 1, grow: 2, weaken: 3 }, ramPie: { farm: 10, prep: 5, share: 0, free: 2, reserve: 4 } },
      fleet: { rootedHosts: 3, totalHosts: 9, maxRam: 64, usedRam: 32, purchased: { count: 1, totalRam: 8, limit: 25 }, home: { maxRam: 32, usedRam: 8, cores: 2 }, portOpeners: 2 },
      progression: { bitNode: 12, sourceFiles: { "4": 3 }, ownedAugs: { NeuroFlux: 5 }, augCount: 1, lastAugReset: 1, lastNodeReset: 1, multipliers: { ScriptHackMoney: 0.2 } },
      factions: { joined: ["CyberSec"], standings: [{ name: "CyberSec", rep: 100, favor: 1 }], invites: ["NiteSec"], favorToDonate: 150, workTypes: { CyberSec: ["hacking"] }, enemies: { CyberSec: [] }, requirements: { NiteSec: [{ type: "skills", skills: { hacking: 200 } }] }, gates: { CyberSec: { joined: true, invited: false, progress: 1, reachable: true, missing: [] }, NiteSec: { joined: false, invited: true, progress: 1, reachable: true, missing: [] }, "The Covenant": { joined: false, invited: false, progress: 0.4, reachable: true, missing: [{ kind: "skill", subject: "agility", target: 850, have: 340, progress: 0.4, owner: "career", reachable: true, why: "needs agility 850" }] }, Illuminati: { joined: false, invited: false, progress: 0, reachable: false, missing: [{ kind: "bitNode", target: 0, have: 0, progress: 0, owner: "progression", reachable: false, why: "wrong BitNode" }] } }, augMeta: { Rootkit: { prereqs: [], mults: { hacking: 1.1 } } }, ownedAugs: ["BitWire"], offers: [{ name: "Rootkit", faction: "CyberSec", price: 1.9e6, basePrice: 1e6, repReq: 100, affordableRep: true, repGap: 0, owned: false }], augTotal: 1, graftable: [{ name: "Rootkit", price: 1e6, timeMs: 6e4 }], plan: { context: { evaluatedAt: 0, horizonSec: 3600, ownedAugCount: 1, queuedAugCount: 0, incomePerSec: 1000, moneyAvailable: 1e6, moneyGranted: 1e6, holdsWorkSlot: true, favorToDonate: 150, priceQueue: { nonSoA: 0, ownedSoA: 0, neurofluxLevel: 0 } }, objective: { factions: ["CyberSec"], augmentations: ["Rootkit"], value: 1.5, foreclosed: [{ name: "Volhaven", bannedBy: "Sector-12" }], why: "exact MWIS" }, action: { type: "workForFaction", faction: "CyberSec", workType: "hacking", why: "0.5 rep/sec toward 100" }, alternatives: [{ label: "work NiteSec", value: 0.2, why: "lower rate" }], blockers: [{ faction: "NiteSec", kind: "skill", subject: "hacking", target: 200, have: 50, progress: 0.25, owner: "hacking", reachable: true, why: "needs hacking 200" }], until: { kind: "rep", faction: "CyberSec", target: 100, have: 40, etaSec: 120 }, lastResult: { action: "workForFaction", ok: true, detail: "started", at: 1 }, recommendInstall: { why: "objective owned", augmentations: ["Rootkit"] } } },
      career: { karma: -100, numPeopleKilled: 0, skills: { hacking: 10, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 }, exp: { hacking: 10, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 0 }, city: "Sector-12", location: "home", entropy: 0, totalPlaytime: 1e6, jobs: { ECorp: "Software" }, companies: { ECorp: { rep: 10, favor: 1 } }, currentWork: { type: "CRIME", detail: "Mug" }, crimes: [{ name: "Mug", chance: 0.5, money: 1000, timeMs: 4000, karma: -0.25, moneyPerSec: 125 }] },
      hacknet: { servers: false, numNodes: 2, maxNumNodes: 30, purchaseNodeCost: 1e5, totalProduction: 500, productionPerSec: 1.5, nodes: [{ name: "hacknet-node-0", level: 10, ram: 2, cores: 1, production: 1.5, totalProduction: 500, timeOnline: 3600 }], nextUpgrades: [{ kind: "level", node: 0, cost: 1000 }] },
      stock: { hasWseAccount: true, hasTixApiAccess: true, has4SData: false, has4SDataApi: true, positions: [{ sym: "ECP", price: 100, ask: 100.2, bid: 99.8, maxShares: 1e6, shares: 100, avgPx: 90, sharesShort: 0, avgPxShort: 0, value: 9980, costBasis: 9000 }], signals: { ECP: { forecast: 0.6, volatility: 0.0045 } }, portfolioValue: 9980, portfolioCost: 9000, market: { tick: 120, ticksUntilCycle: 43, cyclesSeen: 1, lastFlipCount: 0, lastV: 0.42 }, manipulation: { ecorp: { sym: "ECP", side: "long", valuePerOp: 12000, notional: 9980, why: "grow ecorp to push ECP up" } }, plan: { actions: [{ type: "buy", why: "long ECP" }], ranked: [{ sym: "ECP", side: "long", forecast: 0.6, volatility: 0.0045, exact: true, breakEvenTicks: 4.2, expectedProfit: 5e5, why: "4S forecast 0.600" }], entry: { sym: "ECP", side: "long", shares: 1000, cost: 1e5, expectedProfit: 5e5, holdTicks: 43, breakEvenTicks: 4.2 }, unlock: { type: "buy4SApi", cost: 25e9, investmentCost: 25e9, gainPerSec: 1e6, paybackSec: 25000, netOverHorizon: 1e9, why: "exact forecasts" }, flat: false, why: "1 action(s)", lastResult: { action: "buy", ok: true, detail: "bought 1000 ECP", at: 1 } } },
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
          action: { type: "move", x: 1, y: 1, why: "neural value 0.840 win" },
          ranked: [{
            x: 1, y: 1, score: 0.84, powerPerRound: 5.5, captures: 1,
            predictedReplies: [{ x: 2, y: 2, count: 5 }, { x: null, y: null, count: 1 }],
            why: "neural value; forecast 2,2 with 5.00/6 support",
          }],
          why: "neural value over 4 candidates",
          input: {
            at: 1_000, board: ["X....", ".....", ".....", ".....", "....."], previousBoards: [],
            status: "inProgress", currentPlayer: "Black", opponent: "Netburners", blackScore: 1, whiteScore: 1.5, komi: 1.5,
          },
          planning: { finalistCount: 4, positionValue: 0.25 },
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
          selection: {
          preferred: {
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0, why: "hacking throughput",
          },
          candidates: [{
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0, why: "hacking throughput",
          }],
          context: {
            goPower: 1, hasSourceFile14: false, favorRepCap: 100_000, installRemainingSec: 3_600,
            joinedFactions: [], demands: {}, factionFavor: {},
          },
        },
        },
        lastTurn: {
          at: 1_100,
          durationMs: 205,
          action: { type: "move", x: 1, y: 1, why: "neural value 0.840 win" },
          opponentResponse: { type: "move", x: 2, y: 2 },
          predictionSupport: { matching: 5, total: 6 },
          ok: true,
          detail: "move; opponent move",
        },
      },
      stanek: { width: 3, height: 3, occupied: { "0,0": 1, "1,0": 1 }, fragments: [{ id: 1, type: "Hacking", x: 0, y: 0, rotation: 0, power: 1.5, limit: 1, effect: "+x% hacking", numCharge: 10, highestCharge: 10, chargedEffect: 1.2 }], availableTypes: [{ id: 1, type: "Hacking", power: 1.5, limit: 1 }] },
      dnet: { reachable: 4, maxDepth: 2, stasisLinkLimit: 2, stasisLinked: ["dn-1"], instability: { authenticationDurationMultiplier: 1.2, authenticationTimeoutChance: 0.05 }, servers: [{ hostname: "dn-1", depth: 1, blockedRam: 16, isOnline: true, requiredCharisma: 50, stasisLinked: true }] },
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
    expect(TABS["hacknet"].render(state)).toContain('data-sort-table="hacknet.nodes"');
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
      reachable: 2, maxDepth: 1, stasisLinkLimit: 2, stasisLinked: [], topologyComplete: true,
      instability: { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0.1 },
      servers: [{ hostname: "dn-1", depth: 1, blockedRam: 8, isOnline: true, requiredCharisma: 50 }],
      plan: {
        action: { type: "stasis", hostname: "dn-1" },
        ranked: [{ hostname: "dn-1", depth: 1, unlocks: 3 }],
        charismaNeeded: 50,
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
  });

  test("the raw event view drops planner prose but keeps observed codes", () => {
    const state = emptyState();
    state.runId = "test";
    state.events.push({
      kind: "event", name: "feature.decision", data: { why: "invented summary", score: 7, reason: "insufficient-money" },
      seq: 1, t: 1_000, run: "test", src: "game",
    });
    const html = TABS.overview.render(state);
    expect(html).toContain("score");
    expect(html).toContain("insufficient-money");
    expect(html).not.toContain("invented summary");
    expect(html).not.toContain('"why"');
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
        input: { at: 1_000, board: [".....", ".....", ".....", ".....", "....."], previousBoards: [], status: "inProgress", currentPlayer: "Black", opponent: "Netburners" },
        planning: { finalistCount: 4, positionValue: 0.25 },
        prediction: {
          model: "clean-room-v3.0.1",
          sampledTotalPlaytime: 100_000,
          sampledAt: 900,
          decisionAt: 1_000,
          preparationMs: 1.2,
          finalizationMs: 0.8,
          totalPlanningMs: 2,
          readyToDispatchMs: 0.4,
          engineCycleMs: 200,
          aiWaitMs: 200,
          seedCandidates: [100_200],
          dispatchPlaytime: 100_000,
          boundaryRetries: 0,
        },
        selection: {
          preferred: {
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0,
          },
          candidates: [{
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0,
          }],
          context: {
            goPower: 1, hasSourceFile14: false, favorRepCap: 100_000, installRemainingSec: 3_600,
            joinedFactions: [], demands: {}, factionFavor: {},
          },
        },
      },
      lastTurn: {
        at: 1_100,
        durationMs: 205,
        action: { type: "move", x: 1, y: 1 },
        opponentResponse: { type: "move", x: 2, y: 2 },
        predictionSupport: { matching: 5, total: 6 },
        ok: true,
        detail: "move; opponent move",
      },
    };
    const html = TABS.go.render(state);
    expect(html).toContain("Candidate analysis");
    expect(html).toContain("5.00/6 expected seed support");
    expect(html).toContain("clean-room-v3.0.1");
    expect(html).toContain("exact seed");
    expect(html).toContain("200 ms cycles");
    expect(html).toContain("dispatch tick 100.000 s");
    expect(html).toContain("ready-to-play 0.4 ms");
    expect(html).toContain("AI cycle 200 ms");
    expect(html).toContain("class=\"go-point black chosen\"");
    expect(html).toContain("class=\"go-point white reply\"");
    expect(html).toContain("class=\"go-point empty chosen\"");
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
        installBlockers: [{ kind: "factions" }],
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
      why: "best finite-horizon package",
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
        why: "finite-horizon package frontier",
        intent,
      },
      action: { type: "donate", faction: "CyberSec", amount: 2_666_666_667, why: "income beats work" },
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
