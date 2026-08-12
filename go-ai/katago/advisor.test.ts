import { describe, expect, test } from "bun:test";
import {
  buildForcedReplyKataGoQuery,
  buildKataGoQuery,
  parseKataGoVertex,
} from "./advisor.ts";
import { comparePredictiveCandidates, type PredictiveCandidate } from "./predictive-advisor.ts";

describe("KataGo IPvGO adviser query", () => {
  test("transmits holes as walls and masks moves with native legality", () => {
    const board = { size: 5, rows: ["#....", ".X...", "..O..", ".....", "....#"] };
    const query = buildKataGoQuery("test", board, [], 7.5, 16);
    expect(query.blockedPoints).toEqual(["(0,0)", "(4,4)"]);
    expect(query.initialStones).toEqual([["B", "(1,1)"], ["W", "(2,2)"]]);
    expect(query.rules).toMatchObject({ ko: "POSITIONAL", scoring: "AREA", suicide: false });
    expect(query.allowMoves[0].moves).not.toContain("(0,0)");
    expect(query.allowMoves[0].moves).not.toContain("(1,1)");
    expect(query.allowMoves[0].moves).toContain("pass");
  });

  test("requests enough visits for KataGo to return a child move", () => {
    const board = { size: 5, rows: [".....", ".....", ".....", ".....", "....."] };
    expect(buildKataGoQuery("minimum", board, [], 1.5, 1).maxVisits).toBe(2);
  });

  test("forces a candidate-specific predicted White response", () => {
    const board = { size: 5, rows: ["#....", ".X...", "..O..", ".....", "....#"] };
    const query = buildForcedReplyKataGoQuery("forced", board, 7.5, 4, [3, 1], [0, 4]);
    expect(query.moves).toEqual([["B", "(3,1)"]]);
    expect(query.allowMoves).toEqual([{ player: "W", moves: ["(0,4)"], untilDepth: 1 }]);
    expect(query.blockedPoints).toEqual(["(0,0)", "(4,4)"]);
  });

  test("converts KataGo's GTP coordinates to column-major IPvGO coordinates", () => {
    expect(parseKataGoVertex("A5", 5)).toEqual([0, 0]);
    expect(parseKataGoVertex("E1", 5)).toEqual([4, 4]);
    expect(parseKataGoVertex("J10", 19)).toEqual([8, 9]);
    expect(parseKataGoVertex("pass", 19)).toBe("pass");
  });

  test("ranks an exact native win above an optimistic continuation", () => {
    const guaranteed: PredictiveCandidate = {
      move: "pass",
      predictedWhite: "pass",
      evaluation: { visits: 0, winrate: 1, scoreLead: 1.5 },
      exactOutcome: true,
      powerPerRound: 1.01,
    };
    const estimate: PredictiveCandidate = {
      move: [2, 2],
      predictedWhite: [3, 3],
      evaluation: { visits: 8, winrate: 0.9999, scoreLead: 24 },
      exactOutcome: false,
      powerPerRound: 1.19,
    };
    expect([estimate, guaranteed].sort(comparePredictiveCandidates)[0]).toBe(guaranteed);
  });

  test("uses Power per round only after win probability ties", () => {
    const candidate = (
      move: readonly [number, number],
      winrate: number,
      powerPerRound: number,
    ): PredictiveCandidate => ({
      move,
      predictedWhite: "pass",
      evaluation: { visits: 8, winrate, scoreLead: 1 },
      exactOutcome: false,
      powerPerRound,
    });
    const safer = candidate([0, 0], 0.900001, 1);
    const faster = candidate([1, 1], 0.9, 100);
    expect([faster, safer].sort(comparePredictiveCandidates)[0]).toBe(safer);
    const equallySafeFaster = candidate([2, 2], 0.900001, 2);
    expect([safer, equallySafeFaster].sort(comparePredictiveCandidates)[0]).toBe(equallySafeFaster);
  });
});
