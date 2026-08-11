import { describe, expect, test } from "bun:test";
import {
  firstLegalPolicy,
  greedyPolicy,
  productionPolicy,
  simulateGoGame,
  simulateTournament,
} from "../features/go.ts";
import {
  at,
  evaluate,
  finalizeGoDecision,
  goAnalysisWidth,
  goForecastWidth,
  goPlanningBudgetMs,
  group,
  prepareGoDecision,
  solveGoEndgame,
  territory,
  type GoBoard,
  type Stone,
} from "../../shared/strategy/go/decide.ts";
import { illuminatiPolicyMove } from "../../shared/strategy/go/illuminati-book.ts";
import {
  GO_POLICY_BOOK_CAPACITY,
  goPolicyEntryCount,
} from "../../shared/strategy/go/policy-book.ts";

function referenceEvaluate(board: GoBoard, us: Stone, cohesionWeight: number): number {
  const them = us === "X" ? "O" : "X";
  const owned = territory(board);
  let value = owned[us] - owned[them];
  const counted = new Set<string>();
  const centre = (board.size - 1) / 2;
  for (let x = 0; x < board.size; x++) for (let y = 0; y < board.size; y++) {
    const cell = at(board, x, y);
    if (cell !== "X" && cell !== "O" || counted.has(`${x},${y}`)) continue;
    const chain = group(board, x, y);
    for (const [sx, sy] of chain.stones) counted.add(`${sx},${sy}`);
    let stones = chain.liberties === 1
      ? -chain.stones.length
      : chain.stones.length * (chain.liberties === 2 ? 0.8 : 1) + Math.min(chain.liberties, 4) * 0.18;
    if (chain.liberties > 1) stones += Math.max(0, chain.stones.length - 1) * cohesionWeight;
    value += cell === us ? stones : -stones;
    const influence = chain.stones.reduce(
      (sum, [sx, sy]) => sum + Math.max(0, centre - (Math.abs(sx - centre) + Math.abs(sy - centre)) * 0.25),
      0,
    ) * 0.04;
    value += cell === us ? influence : -influence;
  }
  return value;
}

describe("Go strategy simulation", () => {
  test("planning widths scale deterministically from the 5x5 to 19x19 budget", () => {
    const sizes = [5, 7, 9, 13, 19] as const;
    const views = sizes.map((size) => ({
      board: { size, rows: size === 19 ? Array.from({ length: 19 }, () => "X".repeat(19)) : [] },
      opponent: "Illuminati" as const,
    }));
    expect(views.map(goAnalysisWidth)).toEqual([5, 20, 30, 60, 120]);
    expect(views.map(goForecastWidth)).toEqual([5, 3, 2, 1, 2]);
    expect(sizes.map(goPlanningBudgetMs)).toEqual([2, 3.5, 5, 8, 20]);
  });

  test("19x19 exact forecasting compares two candidates throughout the game", () => {
    const rows = Array.from({ length: 19 }, () => ".".repeat(19));
    expect(goForecastWidth({ board: { size: 19, rows }, opponent: "????????????" })).toBe(2);
    const tactical = rows.map((column, x) => x < 14 ? "X".repeat(19) : column);
    expect(goForecastWidth({ board: { size: 19, rows: tactical }, opponent: "????????????" })).toBe(2);
  });

  test("5x5 work is concentrated on the opponents that benefit from it", () => {
    const opponents = [
      "Netburners",
      "Slum Snakes",
      "The Black Hand",
      "Tetrads",
      "Daedalus",
      "Illuminati",
    ] as const;
    const views = opponents.map((opponent) => ({ board: { size: 5 as const, rows: [] }, opponent }));
    expect(views.map(goAnalysisWidth)).toEqual([4, 4, 4, 4, 5, 5]);
    expect(views.map(goForecastWidth)).toEqual([4, 3, 4, 4, 5, 5]);
  });

  test("the Illuminati policy book reaches midgame boards and has no fallback guess", () => {
    expect(illuminatiPolicyMove([".....", "...O.", "..OX.", "....#", "..#.."])).toEqual([1, 2]);
    expect(illuminatiPolicyMove([".....", ".....", ".....", ".....", "....."])).toBeUndefined();
  });

  test("policy-book capacity changes selection only, never search depth", () => {
    const common = {
      board: { size: 5, rows: [".....", "...O.", "..OX.", "....#", "..#.."] },
      currentPlayer: "Black" as const,
      opponent: "Illuminati" as const,
      status: "inProgress" as const,
      previousBoards: [],
      alignedDispatchPlaytime: 1_200,
      consecutivePasses: 0,
      komi: 7.5,
    };
    const withBook = finalizeGoDecision(prepareGoDecision(common, true), [1_400]);
    const withoutBook = finalizeGoDecision(prepareGoDecision({ ...common, policyBook: false }, true), [1_400]);
    expect(withBook.why).toStartWith("offline teacher policy");
    expect(withBook.finalists).toBe(withoutBook.finalists);
    const byCoordinate = (decision: typeof withBook) => [...decision.ranked]
      .sort((a, b) => a.x - b.x || a.y - b.y);
    expect(byCoordinate(withBook)).toEqual(byCoordinate(withoutBook));
  });

  test("policy-book capacity scales with measured opponent difficulty", () => {
    const opponents = [
      "Netburners",
      "Slum Snakes",
      "The Black Hand",
      "Tetrads",
      "Daedalus",
      "Illuminati",
    ] as const;
    expect(opponents.map((opponent) => GO_POLICY_BOOK_CAPACITY[opponent])).toEqual([4, 8, 12, 24, 64, 164]);
    expect(opponents.map(goPolicyEntryCount)).toEqual([4, 8, 12, 24, 64, 164]);
    expect(GO_POLICY_BOOK_CAPACITY["????????????"]).toBe(64);
    expect(goPolicyEntryCount("????????????")).toBe(0);
  });

  test("the allocation-free evaluator preserves the reference score", () => {
    const boards: GoBoard[] = [
      { size: 5, rows: [".....", ".XX..", ".XO..", "..O..", "#...."] },
      { size: 5, rows: ["X.X..", "XOX..", ".O...", "..OO.", "....#"] },
      { size: 7, rows: [".......", ".XXX...", ".X.X...", ".XXX...", "...OO..", "...O...", "#......"] },
    ];
    for (const board of boards) for (const us of ["X", "O"] as const) for (const cohesion of [0, 0.25, 1.1]) {
      expect(evaluate(board, us, cohesion)).toBeCloseTo(referenceEvaluate(board, us, cohesion), 12);
    }
  });

  test("the rules runner is deterministic and ends only on two passes or its explicit cap", () => {
    const options = { size: 5, komi: 1.5 };
    const first = simulateGoGame(productionPolicy(), greedyPolicy, options);
    const second = simulateGoGame(productionPolicy(), greedyPolicy, options);
    expect(second).toEqual(first);
    expect(first.completed || first.turns === 100).toBe(true);
  });

  test("the fixed tactical shortlist beats transparent baselines in aggregate", () => {
    const opponents = [firstLegalPolicy, greedyPolicy];
    const options = { size: 5, komi: 1.5 };
    const production = simulateTournament(productionPolicy(), opponents, options);

    // This does not claim the baselines are faction AIs. It pins a transparent,
    // color-balanced regression target for the bounded live policy.
    expect(production).toEqual({ games: 4, completed: 4, wins: 3, losses: 1, pointDifference: 35 });
  }, 20_000);

  test("the opponent-tuned forecast width compares exact immediate replies", () => {
    const view = {
      board: { size: 5, rows: [".....", ".O...", ".....", ".....", "#...."] },
      currentPlayer: "Black" as const,
      opponent: "Illuminati" as const,
      status: "inProgress" as const,
      previousBoards: [],
      komi: 7.5,
    };
    const decision = finalizeGoDecision(prepareGoDecision(view, true), [1_200]);
    expect(decision.ranked).toHaveLength(5);
    expect(decision.ranked.filter((move) => move.forecastCertainty === "exact")).toHaveLength(5);
  });

  test("a white pass is accepted immediately when exact komi scoring says black won", () => {
    const board = { size: 5, rows: ["XXXXX", "XXXXX", "XXXXX", "XXXXX", "XXXX."] };
    const decision = finalizeGoDecision(prepareGoDecision({
      board,
      currentPlayer: "Black",
      opponent: "Illuminati",
      status: "inProgress",
      previousBoards: [],
      consecutivePasses: 1,
      komi: 7.5,
    }));
    expect(decision.action).toMatchObject({ type: "pass" });
    expect(decision.why).toBe("end a won game");
  });

  test("the offline teacher proves a closed endgame instead of fabricating a leaf", () => {
    const solution = solveGoEndgame({
      board: { size: 5, rows: Array.from({ length: 5 }, () => "XXXXX") },
      previousBoards: [],
      opponent: "Illuminati",
      komi: 7.5,
      consecutivePasses: 1,
    }, 1_000, 0, 20);
    expect(solution).toEqual({ action: { type: "pass" }, value: 1_425, nodes: 1 });
  });

});
