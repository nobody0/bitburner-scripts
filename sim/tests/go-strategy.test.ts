import { describe, expect, test } from "bun:test";
import {
  firstLegalPolicy,
  greedyPolicy,
  productionPolicy,
  simulateGoGame,
  simulateGoGameAsync,
  simulateTournament,
  type AsyncGoPolicy,
} from "../features/go.ts";
import { getMove } from "../vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
import { getNewBoardStateFromSimpleBoard } from "../vendor/bitburner/src/Go/boardState/boardState.ts";
import { GoColor, GoOpponent, GoPlayType } from "../vendor/bitburner/src/Go/Enums.ts";
import { Go } from "../vendor/bitburner/src/Go/OracleStubs.ts";
import { oracleInitialBoard } from "../features/go-oracle.ts";

function oracleWhitePolicy(opponent: GoOpponent, seedAtTurn: (turn: number) => number): AsyncGoPolicy {
  return async ({ board, history, turn, consecutivePasses }) => {
    const state = getNewBoardStateFromSimpleBoard(board.rows, undefined, opponent, GoColor.black);
    state.previousBoards = history.map((position) => position.join(""));
    state.passCount = consecutivePasses;
    state.ai = opponent;
    Go.currentGame = state;
    const play = await getMove(state, GoColor.white, opponent, false, seedAtTurn(turn));
    return play.type === GoPlayType.move ? [play.x, play.y] : undefined;
  };
}

describe("Go strategy simulation", () => {
  test("the rules runner is deterministic and ends only on two passes or its explicit cap", () => {
    const options = { size: 5, komi: 1.5 };
    const first = simulateGoGame(productionPolicy(), greedyPolicy, options);
    const second = simulateGoGame(productionPolicy(), greedyPolicy, options);
    expect(second).toEqual(first);
    expect(first.completed || first.turns === 100).toBe(true);
  });

  test("the fixed tactical shortlist dominates transparent baselines", () => {
    const opponents = [firstLegalPolicy, greedyPolicy];
    const options = { size: 5, komi: 1.5 };
    const production = simulateTournament(productionPolicy(), opponents, options);

    // This does not claim the baselines are faction AIs. It pins a transparent,
    // color-balanced regression target for the bounded live policy.
    expect(production).toEqual({ games: 4, completed: 4, wins: 4, losses: 0, pointDifference: 100 });
  }, 20_000);

  test("seed-aware planning improves measured results against the pinned faction AI", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      let blindDifference = 0;
      let awareDifference = 0;
      let blindWins = 0;
      let awareWins = 0;
      for (const [opponent, komi] of [
        [GoOpponent.Netburners, 1.5],
        [GoOpponent.TheBlackHand, 3.5],
      ] as const) {
        for (const baseSeed of [1_000, 5_000, 9_000, 13_000, 17_000, 21_000]) {
          // Black forecasts the seed used on the immediately following white
          // turn. The odd/even pair therefore shares one AI seed.
          const seedAtTurn = (turn: number) => baseSeed + Math.floor(turn / 2) * 401;
          const oracle = oracleWhitePolicy(opponent, seedAtTurn);
          const options = {
            size: 5,
            komi,
            maxTurns: 100,
            initialBoard: oracleInitialBoard(5, opponent, baseSeed),
          };
          const blind = await simulateGoGameAsync(productionPolicy(), oracle, options);
          const aware = await simulateGoGameAsync(
            productionPolicy({ opponent, seedAtTurn }),
            oracle,
            options,
          );
          blindDifference += blind.score.X - blind.score.O;
          awareDifference += aware.score.X - aware.score.O;
          if (blind.winner === "X") blindWins++;
          if (aware.winner === "X") awareWins++;
        }
      }
      expect({ blindDifference, awareDifference, blindWins, awareWins }).toEqual({
        blindDifference: 196,
        awareDifference: 230,
        blindWins: 11,
        awareWins: 12,
      });
      expect(awareDifference).toBeGreaterThan(blindDifference);
      expect(awareWins).toBeGreaterThan(blindWins);
    } finally {
      Math.random = originalRandom;
    }
  }, 40_000);
});
