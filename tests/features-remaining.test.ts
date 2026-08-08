import { describe, expect, test } from "bun:test";
import { assignCoupled, assignIndependent } from "../shared/strategy/assignment.ts";
import { BLACKOP_CONFIDENCE, STAMINA_FLOOR, stepBladeburner } from "../shared/strategy/bladeburner/decide.ts";
import { CORP_STAGES, stepCorp, type CorpView } from "../shared/strategy/corp/stages.ts";
import { reachableFrom, stepDarknet, unlockValue } from "../shared/strategy/dnet/decide.ts";
import { ASCEND_THRESHOLD, CLASH_CONFIDENCE, stepGang } from "../shared/strategy/gang/decide.ts";
import { evaluate, group, legalMoves, stepGo } from "../shared/strategy/go/decide.ts";
import { postNeeds } from "../shared/strategy/needs.ts";
import { BASELINE_ORDER, bestOrdering, favorCrossings, orderingCost, phaseOf, stepProgression } from "../shared/strategy/progression/decide.ts";
import { canSolve, rankInfiltrations, SOLVERS, solve } from "../shared/strategy/side/contracts.ts";
import { shockMultiplier, stepSleeves } from "../shared/strategy/sleeves/decide.ts";
import { chargeOrder, distinctRotations, packFragments, rotate } from "../shared/strategy/stanek/pack.ts";
import { COMMISSION, edge, evaluate4S, minProfitableShares, stepStock, type StockView } from "../shared/strategy/stock/decide.ts";
import { mulberry32 } from "../sim/core/rng.ts";

// --- assignment (shared by gang, sleeves, bladeburner) -----------------------

describe("assignment", () => {
  test("independent assignment is the exact per-agent argmax", () => {
    const agents = ["a", "b"];
    const tasks = [1, 2, 3];
    const result = assignIndependent(agents, tasks, (agent, task) => (agent === "a" ? task : -task), String);
    expect(result.choices.map((c) => c.task)).toEqual([3, 1]);
    expect(result.approximated).toBe(false);
  });

  test("coupled assignment beats independent when the payoff interacts", () => {
    // Two agents, two tasks; taking the SAME task halves both payoffs. The
    // per-agent argmax picks the same task twice and loses.
    const agents = ["a", "b"];
    const tasks = ["x", "y"];
    const base = (_agent: string, task: string): number => (task === "x" ? 10 : 9);
    const objective = (assignment: { agent: string; task: string }[]): number => {
      const total = assignment.reduce((sum, entry) => sum + base(entry.agent, entry.task), 0);
      const collided = assignment[0]!.task === assignment[1]!.task;
      return collided ? total / 2 : total;
    };
    const independent = assignIndependent(agents, tasks, base, String);
    const coupled = assignCoupled(agents, tasks, objective, base, String);
    expect(objective(independent.choices.map((c) => ({ agent: c.agent, task: c.task })))).toBe(10);
    expect(coupled.total).toBe(19);
  });

  test("above the search budget it falls back to greedy AND SAYS SO", () => {
    // A silently-approximate answer presented as exact is worse than a slower
    // one, so the flag is the contract.
    const agents = Array.from({ length: 12 }, (_, i) => i);
    const tasks = Array.from({ length: 12 }, (_, i) => i);
    const result = assignCoupled(agents, tasks, () => 1, () => 1, String, 1_000);
    expect(result.approximated).toBe(true);
  });
});

// --- gang --------------------------------------------------------------------

describe("gang", () => {
  const member = (name: string, task = "Unassigned") => ({
    name,
    task,
    skills: { hack: 1, str: 10, def: 10, dex: 10, agi: 10, cha: 1 },
    ascMults: { hack: 1, str: 1, def: 1, dex: 1, agi: 1, cha: 1 },
    earnedRespect: 0,
    upgrades: 0,
  });

  const view = (over: Partial<Parameters<typeof stepGang>[0]> = {}) => ({
    faction: "Slum Snakes",
    isHacking: false,
    respect: 100,
    wantedLevel: 1,
    wantedPenalty: 0.9,
    territory: 0.2,
    territoryClashChance: 0.1,
    territoryWarfareEngaged: false,
    members: [member("a")],
    taskOptions: () => [
      { name: "Mug People", respectGain: 1, moneyGain: 100, wantedGain: 0.5, training: false },
      { name: "Train Combat", respectGain: 0, moneyGain: 0, wantedGain: 0, training: true },
    ],
    ascensionGain: () => 1,
    respectForNextRecruit: 200,
    canRecruit: false,
    clashChances: {},
    weights: { respect: 1, money: 1e-6 },
    ...over,
  });

  test("the wanted penalty makes assignment COUPLED, not per-member", () => {
    // Wanted level is gang-wide, so one member's task multiplies down
    // everyone's output. The decision reports an exact search over the pair.
    const decision = stepGang(view({ members: [member("a"), member("b")] }));
    expect(decision.why).toContain("exact assignment");
    expect(decision.assignment.approximated).toBe(false);
  });

  test("ascension fires only above the analytic crossover", () => {
    expect(stepGang(view({ ascensionGain: () => ASCEND_THRESHOLD - 0.01 })).actions.some((a) => a.type === "ascend")).toBe(false);
    expect(stepGang(view({ ascensionGain: () => ASCEND_THRESHOLD + 0.01 })).actions.some((a) => a.type === "ascend")).toBe(true);
  });

  test("warfare engages only above the confidence bar — a dead member costs more than territory", () => {
    const timid = stepGang(view({ clashChances: { Tetrads: CLASH_CONFIDENCE - 0.01 } }));
    expect(timid.actions.find((a) => a.type === "warfare")).toBeUndefined();
    const bold = stepGang(view({ clashChances: { Tetrads: CLASH_CONFIDENCE + 0.01 } }));
    expect(bold.actions.find((a) => a.type === "warfare" && a.engage)).toBeDefined();
  });

  test("a crushing wanted penalty is surfaced, not silently absorbed", () => {
    expect(stepGang(view({ wantedPenalty: 0.3 })).wantedWarning).toContain("over half");
  });
});

// --- bladeburner --------------------------------------------------------------

describe("bladeburner", () => {
  const action = (over: Partial<Parameters<typeof stepBladeburner>[0]["actions"][number]> = {}) => ({
    type: "contract" as const,
    name: "Tracking",
    chance: [0.9, 0.95] as [number, number],
    timeMs: 30_000,
    countRemaining: 100,
    level: 1,
    rankGain: 5,
    ...over,
  });
  const view = (over: Partial<Parameters<typeof stepBladeburner>[0]> = {}) => ({
    rank: 100,
    skillPoints: 0,
    stamina: [100, 100] as [number, number],
    city: "Sector-12",
    chaos: 0,
    actions: [action()],
    skills: {},
    ...over,
  });

  test("resting below the stamina floor beats pushing through", () => {
    expect(stepBladeburner(view({ stamina: [40, 100] })).action.type).toBe("rest");
    expect(stepBladeburner(view({ stamina: [STAMINA_FLOOR * 100 + 1, 100] })).action.type).toBe("act");
  });

  test("every decision uses the PESSIMISTIC end of the chance interval", () => {
    // The game reports [min, max] because the estimate is imprecise. Acting on
    // the optimistic end is exactly how a Black Op gets failed.
    const decision = stepBladeburner(view({ actions: [action({ chance: [0.1, 0.99] })] }));
    expect(decision.ranked[0]!.chanceLow).toBe(0.1);
  });

  test("a Black Op below the confidence bar is REFUSED, not gambled on", () => {
    const risky = action({ type: "blackop", name: "Operation Typhoon", chance: [BLACKOP_CONFIDENCE - 0.01, 1], rankNeeded: 0, rankGain: 1000 });
    const safe = action({ name: "Tracking", rankGain: 1 });
    const decision = stepBladeburner(view({ actions: [risky, safe] }));
    expect(decision.action.type === "act" && decision.action.name).toBe("Tracking");
  });

  test("a confident Black Op is taken", () => {
    const ready = action({ type: "blackop", name: "Operation Typhoon", chance: [1, 1], rankNeeded: 0, rankGain: 1000 });
    const decision = stepBladeburner(view({ actions: [ready, action()] }));
    expect(decision.action.type === "act" && decision.action.name).toBe("Operation Typhoon");
  });

  test("skill points are spent rather than hoarded", () => {
    const decision = stepBladeburner(view({ skillPoints: 10, skills: { "Blade's Intuition": { level: 1, upgradeCost: 3 } } }));
    expect(decision.action.type).toBe("upgrade");
  });

  test("high chaos is reduced by Diplomacy before anything else", () => {
    const decision = stepBladeburner(
      view({ chaos: 100, actions: [action(), action({ type: "general", name: "Diplomacy", countRemaining: Infinity })] }),
    );
    expect(decision.action.type === "act" && decision.action.name).toBe("Diplomacy");
  });
});

// --- sleeves ------------------------------------------------------------------

describe("sleeves", () => {
  const sleeve = (index: number, shock = 0, sync = 100) => ({ index, shock, sync, city: "Sector-12", skills: {} });
  const tasks = [
    { type: "recovery" as const, rates: {}, moneyPerSec: 0 },
    { type: "synchro" as const, rates: {}, moneyPerSec: 0 },
    { type: "crime" as const, detail: "Homicide", rates: { karma: 1 }, moneyPerSec: 100 },
    { type: "crime" as const, detail: "Heist", rates: { karma: 0.01 }, moneyPerSec: 10_000 },
  ];

  test("shock scales output DOWN, so recovery dominates when it is high", () => {
    expect(shockMultiplier(90)).toBeCloseTo(0.1, 10);
    const decision = stepSleeves({ sleeves: [sleeve(0, 90)], tasks, shockCeiling: 50, syncFloor: 50 }, postNeeds([]));
    expect(decision.assignments[0]!.task.type).toBe("recovery");
  });

  test("sleeves serve the board in PARALLEL with the player", () => {
    const board = postNeeds([
      { by: "gang", kind: "karma", target: -54_000, have: 0, weight: 10, urgency: "blocking", why: "gang" },
    ]);
    const decision = stepSleeves({ sleeves: [sleeve(0), sleeve(1)], tasks, shockCeiling: 50, syncFloor: 50 }, board);
    // Both sleeves take the karma crime — they do not interfere, so the
    // per-sleeve argmax is exact.
    expect(decision.assignments).toHaveLength(2);
    for (const entry of decision.assignments) expect(entry.task.detail).toBe("Homicide");
  });

  test("with nothing posted it falls back to income", () => {
    const decision = stepSleeves({ sleeves: [sleeve(0)], tasks, shockCeiling: 50, syncFloor: 50 }, postNeeds([]));
    expect(decision.assignments[0]!.task.detail).toBe("Heist");
  });
});

// --- stanek: exhaustive packing is PROVABLY optimal ---------------------------

describe("stanek packing", () => {
  const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
  const line = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
  const el = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];

  test("rotation normalises to the origin", () => {
    expect(rotate(line, 1)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }]);
    expect(rotate(square, 2)).toEqual(rotate(square, 0));
  });

  test("distinct rotations are deduplicated — a square has one, an L has four", () => {
    expect(distinctRotations(square)).toHaveLength(1);
    expect(distinctRotations(line)).toHaveLength(2);
    expect(distinctRotations(el)).toHaveLength(4);
  });

  test("the packing is PROVABLY optimal, not merely good", () => {
    // The grid is small enough to enumerate every placement, so this is the
    // strongest evidence available anywhere in the roster: no better packing
    // exists, rather than "ours beats first-fit".
    const fragments = [
      { id: 1, shape: square, power: 1, weight: 4 },
      { id: 2, shape: line, power: 1, weight: 3 },
    ];
    const result = packFragments(fragments, 3, 3);
    expect(result.approximated).toBe(false);
    // 4 + 3 = 7 cells in a 9-cell grid; both fit.
    expect(result.value).toBe(7);
    expect(result.placements).toHaveLength(2);
  });

  test("it will LEAVE OUT a large fragment to fit two smaller ones", () => {
    // The branch that skips a fragment is what makes the search correct — a
    // greedy largest-first packer gets this wrong.
    const fragments = [
      { id: 1, shape: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], power: 1, weight: 4 },
      { id: 2, shape: [{ x: 0, y: 0 }], power: 1, weight: 3 },
      { id: 3, shape: [{ x: 0, y: 0 }], power: 1, weight: 3 },
    ];
    // A 1x2 grid fits only the two singles.
    const result = packFragments(fragments, 1, 2);
    expect(result.value).toBe(6);
    expect(result.placements.map((p) => p.id).sort()).toEqual([2, 3]);
  });

  test("beats first-fit packing", () => {
    const fragments = [
      { id: 1, shape: el, power: 1, weight: 1 },
      { id: 2, shape: square, power: 1, weight: 10 },
    ];
    // First-fit would place the L first and block the high-value square.
    const result = packFragments(fragments, 2, 2);
    expect(result.placements.map((p) => p.id)).toEqual([2]);
    expect(result.value).toBe(10);
  });

  test("charge order follows the objective weights", () => {
    const fragments = [
      { id: 1, shape: [{ x: 0, y: 0 }], power: 1, weight: 1 },
      { id: 2, shape: [{ x: 0, y: 0 }], power: 1, weight: 9 },
    ];
    const packed = packFragments(fragments, 2, 1);
    expect(chargeOrder(fragments, packed.placements)[0]).toBe(2);
  });
});

// --- go -----------------------------------------------------------------------

describe("go", () => {
  const board = (rows: string[]) => ({ rows, size: rows[0]!.length });

  test("liberty counting drives the evaluation", () => {
    // A group in atari is nearly worthless; ignoring liberties plays blind.
    const b = board(["XO.", "...", "..."]);
    expect(group(b, 0, 0).liberties).toBe(1);
    expect(group(b, 1, 0).liberties).toBe(2);
  });

  test("legal moves are the empty points", () => {
    expect(legalMoves(board(["X.", ".O"]))).toEqual([[1, 0], [0, 1]]);
  });

  test("evaluation prefers our stones and penalises atari", () => {
    const safe = board(["XX.", "...", "..."]);
    const atari = board(["XO.", "...", "..."]);
    expect(evaluate(safe, "X")).toBeGreaterThan(evaluate(atari, "X"));
  });

  test("it plays a legal move on an empty board", () => {
    const decision = stepGo({
      board: board([".....", ".....", ".....", ".....", "....."]),
      currentPlayer: "Black",
      opponent: "Netburners",
      opponentValue: {},
      maxDepth: 2,
    });
    expect(decision.action.type).toBe("move");
    expect(decision.why).toContain("exhaustive");
  });

  test("a full board passes rather than crashing", () => {
    const decision = stepGo({
      board: board(["XX", "XX"]),
      currentPlayer: "Black",
      opponent: "Netburners",
      opponentValue: {},
      maxDepth: 2,
    });
    expect(decision.action.type).toBe("pass");
  });
});

// --- side: every contract type has a KNOWN CORRECT ANSWER ---------------------

describe("coding contracts — proven, not measured", () => {
  test("solvers are proven against known answers", () => {
    const cases: [string, unknown, unknown][] = [
      ["Subarray with Maximum Sum", [-2, 1, -3, 4, -1, 2, 1, -5, 4], 6],
      ["Array Jumping Game", [2, 3, 1, 1, 4], 1],
      ["Array Jumping Game", [3, 2, 1, 0, 4], 0],
      ["Array Jumping Game II", [2, 3, 1, 1, 4], 2],
      ["Array Jumping Game II", [3, 2, 1, 0, 4], 0],
      ["Merge Overlapping Intervals", [[1, 3], [8, 10], [2, 6], [15, 18]], [[1, 6], [8, 10], [15, 18]]],
      ["Unique Paths in a Grid I", [3, 7], 28],
      ["Unique Paths in a Grid II", [[0, 0, 0], [0, 1, 0], [0, 0, 0]], 2],
      ["Total Ways to Sum", 5, 6],
      ["Total Ways to Sum II", [10, [1, 2, 5]], 10],
      ["Algorithmic Stock Trader I", [7, 1, 5, 3, 6, 4], 5],
      ["Algorithmic Stock Trader II", [7, 1, 5, 3, 6, 4], 7],
      ["Algorithmic Stock Trader III", [3, 3, 5, 0, 0, 3, 1, 4], 6],
      ["Algorithmic Stock Trader IV", [2, [3, 2, 6, 5, 0, 3]], 7],
      ["Minimum Path Sum in a Triangle", [[2], [3, 4], [6, 5, 7], [4, 1, 8, 3]], 11],
      ["Find Largest Prime Factor", 13195, 29],
      ["Spiralize Matrix", [[1, 2, 3], [4, 5, 6], [7, 8, 9]], [1, 2, 3, 6, 9, 8, 7, 4, 5]],
      ["Encryption I: Caesar Cipher", ["MEDIUM", 1], "LDCHTL"],
      ["Encryption II: Vigenère Cipher", ["DASHBOARD", "LINUX"], "OIFBYZIEX"],
    ];
    for (const [type, data, expected] of cases) {
      expect(solve(type, data), `${type} produced the wrong answer`).toEqual(expected);
    }
  });

  test("stock trader IV with k >= n/2 degenerates to the unlimited case", () => {
    expect(solve("Algorithmic Stock Trader IV", [100, [7, 1, 5, 3, 6, 4]])).toBe(7);
  });

  test("an unknown type returns undefined — never a guess", () => {
    // A wrong answer burns one of three tries; the third destroys the
    // contract. Not attempting is strictly better than attempting badly.
    expect(solve("Proper 2-Coloring of a Graph", [])).toBeUndefined();
    expect(canSolve("Proper 2-Coloring of a Graph")).toBe(false);
  });

  test("a solver that throws on malformed data returns undefined, not a partial answer", () => {
    expect(solve("Merge Overlapping Intervals", null)).toBeUndefined();
  });

  test("every registered solver is callable and declared", () => {
    for (const type of Object.keys(SOLVERS)) expect(canSolve(type)).toBe(true);
    expect(Object.keys(SOLVERS).length).toBeGreaterThanOrEqual(17);
  });

  test("infiltration ranks by reward per real-time minute, not raw reward", () => {
    const ranked = rankInfiltrations([
      { location: "Slow", city: "Aevum", difficulty: 3, maxClearanceLevel: 40, repReward: 0, moneyReward: 1_000_000 },
      { location: "Fast", city: "Aevum", difficulty: 0.5, maxClearanceLevel: 5, repReward: 0, moneyReward: 200_000 },
    ]);
    expect(ranked[0]!.location).toBe("Fast");
  });
});

// --- stock ---------------------------------------------------------------------

describe("stock", () => {
  const view = (over: Partial<StockView> = {}): StockView => ({
    positions: [],
    signals: {},
    has4SData: true,
    has4SDataApi: true,
    hasTixApi: true,
    moneyGranted: 1e9,
    totalMoney: 1e9,
    horizonSec: 3_600,
    incomePerSec: 0,
    ...over,
  });

  test("forecast 0.5 is exactly zero edge — no information means no trade", () => {
    expect(edge({ forecast: 0.5, volatility: 0.01 }, false)).toBe(0);
    expect(edge({ forecast: 0.6, volatility: 0.01 }, false)).toBeCloseTo(0.002, 10);
    expect(edge({ forecast: 0.4, volatility: 0.01 }, false)).toBeCloseTo(-0.002, 10);
  });

  test("the position must clear BOTH commissions", () => {
    // Both the buy and the sell are charged, so the round trip is $200k.
    const shares = minProfitableShares(100, 0.001, 10);
    expect(shares).toBeCloseTo((2 * COMMISSION) / (0.001 * 100 * 10), 6);
    expect(minProfitableShares(100, 0, 10)).toBe(Infinity);
  });

  test("without a forecast it REFUSES to trade rather than guessing", () => {
    const decision = stepStock(view({ has4SData: false, totalMoney: 100 }));
    expect(decision.actions).toHaveLength(0);
    expect(decision.hold).toContain("per round trip to guess");
  });

  test("without TIX it says so instead of silently doing nothing", () => {
    expect(stepStock(view({ hasTixApi: false })).hold).toContain("TIX API");
  });

  test("4S is evaluated as an investment against the horizon", () => {
    const rich = evaluate4S(view({ has4SData: false, totalMoney: 1e12, horizonSec: 86_400 }));
    expect(rich.buy).toBe(true);
    const shortHorizon = evaluate4S(view({ has4SData: false, totalMoney: 1e12, horizonSec: 1 }));
    expect(shortHorizon.buy).toBe(false);
    // Spending half the bankroll on data leaves nothing to trade with.
    const broke = evaluate4S(view({ has4SData: false, totalMoney: 1.5e9 }));
    expect(broke.buy).toBe(false);
    expect(broke.why).toContain("still have capital");
  });

  test("it exits a position whose forecast turned", () => {
    const decision = stepStock(
      view({
        positions: [{ sym: "ECP", price: 100, ask: 100, bid: 100, maxShares: 1e6, shares: 100, avgPx: 90, sharesShort: 0, avgPxShort: 0 }],
        signals: { ECP: { forecast: 0.3, volatility: 0.01 } },
      }),
    );
    expect(decision.actions.some((a) => a.type === "sell")).toBe(true);
  });
});

// --- corp ---------------------------------------------------------------------

describe("corp staged script", () => {
  const view = (over: Partial<CorpView> = {}): CorpView => ({
    hasCorporation: true,
    funds: 0,
    revenue: 0,
    expenses: 0,
    public: false,
    divisions: [],
    moneyGranted: 0,
    ...over,
  });

  test("stages run in order and each names its expected effect", () => {
    for (const stage of CORP_STAGES) {
      expect(stage.expect.length).toBeGreaterThan(5);
      expect(stage.id.length).toBeGreaterThan(2);
    }
  });

  test("founding comes first, then Agriculture", () => {
    expect(stepCorp(view({ hasCorporation: false })).action.type).toBe("createCorporation");
    expect(stepCorp(view()).action.type).toBe("expandIndustry");
  });

  test("a stall is attributable to a named stage", () => {
    const decision = stepCorp(
      view({ divisions: [{ name: "Ag", industry: "Agriculture", cities: ["Sector-12"], researchPoints: 0, products: [], maxProducts: 0, offices: [], warehouses: [] }] }),
    );
    expect(decision.stage).toBeTruthy();
    expect(decision.why).toContain(decision.stage);
  });

  test("the optimality boundary is stated, not implied", () => {
    // This feature makes a narrower claim than the rest of the roster, and it
    // has to say so rather than letting the reader assume otherwise.
    const done = stepCorp(
      view({
        divisions: [
          { name: "Ag", industry: "Agriculture", cities: ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"], researchPoints: 0, products: [], maxProducts: 0, offices: [], warehouses: Array.from({ length: 6 }, (_, i) => ({ city: `c${i}`, level: 1, size: 1, sizeUsed: 0, smartSupplyEnabled: true })) },
          { name: "Tob", industry: "Tobacco", cities: [], researchPoints: 0, products: ["p"], maxProducts: 1, offices: [], warehouses: [] },
        ],
      }),
    );
    expect(done.why).toContain("no optimality claim");
  });
});

// --- dnet ----------------------------------------------------------------------

describe("darknet", () => {
  const servers = [
    { hostname: "root", depth: 0, blockedRam: 0, isOnline: true, requiredCharisma: 0, stasisLinked: false, neighbours: ["mid"] },
    { hostname: "mid", depth: 1, blockedRam: 0, isOnline: false, requiredCharisma: 0, stasisLinked: false, neighbours: ["leaf"] },
    { hostname: "leaf", depth: 2, blockedRam: 0, isOnline: true, requiredCharisma: 0, stasisLinked: false, neighbours: [] },
  ];

  test("an offline server is only traversable while held in stasis", () => {
    expect(reachableFrom(servers, new Set())).toEqual(new Set(["root"]));
    expect(reachableFrom(servers, new Set(["mid"]))).toEqual(new Set(["root", "mid", "leaf"]));
  });

  test("stasis links are spent where they unlock the most", () => {
    expect(unlockValue({ servers, stasisLinked: [] } as never, "mid")).toBe(2);
    const decision = stepDarknet({
      servers,
      reachable: 1,
      maxDepth: 2,
      stasisLinkLimit: 1,
      stasisLinked: [],
      instability: { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0 },
      charisma: 100,
      instabilityCeiling: 0.5,
    });
    expect(decision.action.type).toBe("stasis");
    expect(decision.action.type === "stasis" && decision.action.hostname).toBe("mid");
  });

  test("high instability stops backdooring instead of making it worse", () => {
    const decision = stepDarknet({
      servers,
      reachable: 1,
      maxDepth: 2,
      stasisLinkLimit: 1,
      stasisLinked: [],
      instability: { authenticationDurationMultiplier: 3, authenticationTimeoutChance: 0.9 },
      charisma: 100,
      instabilityCeiling: 0.5,
    });
    expect(decision.action.type).toBe("idle");
  });

  test("charisma blocks become a NEED for career, not a grind here", () => {
    const decision = stepDarknet({
      servers: [{ ...servers[0]!, requiredCharisma: 500 }],
      reachable: 0,
      maxDepth: 0,
      stasisLinkLimit: 0,
      stasisLinked: [],
      instability: { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0 },
      charisma: 10,
      instabilityCeiling: 0.5,
    });
    expect(decision.charismaNeeded).toBe(500);
  });
});

// --- progression ----------------------------------------------------------------

describe("progression", () => {
  const view = (over: Partial<Parameters<typeof stepProgression>[0]> = {}) => ({
    queued: [],
    affordableValueProduct: 1,
    factionWorkInProgress: false,
    money: 0,
    earnedThisRun: 0,
    factions: {},
    favorToDonate: 150,
    homeRam: 8,
    homeRamUpgradeCost: Infinity,
    runSec: 0,
    ...over,
  });

  test("the run-phase machine promotes on value, then on cash", () => {
    expect(phaseOf(view())).toBe("start");
    expect(phaseOf(view({ affordableValueProduct: 2.0 }))).toBe("finishUp");
    // 1.5 promotes only with no faction work in progress.
    expect(phaseOf(view({ affordableValueProduct: 1.5, factionWorkInProgress: true }))).toBe("start");
    expect(phaseOf(view({ affordableValueProduct: 1.5, factionWorkInProgress: false }))).toBe("finishUp");
    expect(phaseOf(view({ earnedThisRun: 100, money: 60, queued: ["a"] }))).toBe("ending");
  });

  test("the home-RAM budget rises from 10% to 50% in finishUp", () => {
    expect(stepProgression(view()).homeRamBudgetFraction).toBe(0.1);
    expect(stepProgression(view({ affordableValueProduct: 2 })).homeRamBudgetFraction).toBe(0.5);
  });

  test("favor crossings are the exact install-timing crossover", () => {
    // Favor is banked ONLY at install, and crossing the donation threshold
    // converts every future rep requirement from hours of work into money.
    const crossings = favorCrossings(view({ factions: { CyberSec: { rep: 1e9, favor: 0 } }, favorToDonate: 150 }));
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.favorAfter).toBeGreaterThanOrEqual(150);
    // A faction nowhere near the threshold does not cross.
    expect(favorCrossings(view({ factions: { CyberSec: { rep: 10, favor: 0 } } }))).toHaveLength(0);
  });

  test("installing is recommended only in `ending` with something queued", () => {
    expect(stepProgression(view({ earnedThisRun: 100, money: 60 })).install).toBe(false);
    expect(stepProgression(view({ earnedThisRun: 100, money: 60, queued: ["a"] })).install).toBe(true);
  });

  test("BitNode ordering is exact for a small set and beats the baseline order", () => {
    const nodes: [number, number][] = [[4, 3], [1, 3], [5, 1], [2, 3]];
    const hours = { 1: 10, 2: 20, 4: 5, 5: 30 };
    const wants = { 2: [4], 5: [1], 1: [] as number[], 4: [] as number[] };
    const best = bestOrdering(nodes, hours, 0.5, wants);
    expect(best.exact).toBe(true);
    // The optimum is never worse than the baseline's ordering of the same set.
    const baselineSubset = BASELINE_ORDER.filter(([node]) => nodes.some(([n]) => n === node));
    expect(best.hours).toBeLessThanOrEqual(orderingCost(baselineSubset, hours, 0.5, wants) + 1e-9);
  });

  test("above the exact limit it falls back and says so", () => {
    const nodes: [number, number][] = Array.from({ length: 12 }, (_, i) => [i + 1, 3]);
    expect(bestOrdering(nodes, {}, 0.5, {}).exact).toBe(false);
  });

  test("the baseline is the real predecessor ordering, revisits included", () => {
    // 15 entries but only 13 DISTINCT nodes: BN5 and BN7 are each visited
    // twice, at level 1 first and level 3 later. That is the whole point of
    // their stated rationale — take the cheap early level of a node that
    // unlocks something, come back for the rest once it is easier.
    expect(BASELINE_ORDER).toHaveLength(15);
    expect(BASELINE_ORDER[0]).toEqual([4, 3]);
    expect(new Set(BASELINE_ORDER.map(([node]) => node)).size).toBe(13);
    const revisited = [...new Set(BASELINE_ORDER.map(([node]) => node))].filter(
      (node) => BASELINE_ORDER.filter(([n]) => n === node).length > 1,
    );
    expect(revisited.sort()).toEqual([5, 7]);
    // ...and each revisit is at a HIGHER level than the first.
    for (const node of revisited) {
      const levels = BASELINE_ORDER.filter(([n]) => n === node).map(([, level]) => level);
      expect(levels[1]).toBeGreaterThan(levels[0]!);
    }
  });
});

// --- determinism sweep ---------------------------------------------------------

describe("every strategy is deterministic", () => {
  test("repeated calls with the same input give the same answer", () => {
    const rng = mulberry32(5);
    for (let trial = 0; trial < 20; trial++) {
      const fragments = Array.from({ length: 3 }, (_, i) => ({
        id: i,
        shape: [{ x: 0, y: 0 }, { x: Math.round(rng()), y: 0 }],
        power: 1,
        weight: Math.round(rng() * 10),
      }));
      const a = packFragments(fragments, 3, 3);
      const b = packFragments(fragments, 3, 3);
      expect(a.value).toBe(b.value);
      expect(a.placements).toEqual(b.placements);
    }
  });
});
