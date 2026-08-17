import { describe, expect, test } from "bun:test";

import { GO_ARENA_OPPONENTS } from "../go-ai/teacher/arena.ts";
import {
  advance,
  predictiveWinGroupMoves,
  rankingMoves,
  weightedReplyValues,
} from "../go-ai/teacher/export-v9-advisers.ts";
import type { GoArenaTurnTrace } from "../go-ai/teacher/arena.ts";
import type { GoBoard } from "../go-ai/teacher/strategy/decide.ts";
import { encodeOpponentFutureBehavior } from "../shared/strategy/go/opponent.ts";


describe("V9 external corpus reply semantics", () => {
  test("actor rankings retain the complete weighted defense tie", () => {
    const board: GoBoard = {
      size: 5,
      rows: ["XOXX.", "X....", ".....", "....X", ".XXOX"],
    };
    const opponent = GO_ARENA_OPPONENTS.find(({ name }) => name === "Illuminati")!;
    const behavior = encodeOpponentFutureBehavior(opponent.name, opponent.komi);
    const values = weightedReplyValues(
      board, [], 0, opponent, 1_270, behavior, true, 4,
    );

    expect(values).toHaveLength(2);
    expect(values.map(({ weight }) => weight)).toEqual([0.5, 0.5]);
    expect(new Set(values.map(({ state }) => state.split("|", 1)[0])).size).toBe(2);
    expect(values.every(({ behavior: actual, elapsed, won }) =>
      actual[1] === -1 && actual[2] === -1 && actual[3] === -1
        && elapsed === 4 && won === 1)).toBe(true);
  });

  test("a superko-invalidated upstream move remains a no-op, not a pass", () => {
    const trace: GoArenaTurnTrace = {
      turn: 0,
      dispatchPlaytime: 1_000,
      board: [".....", ".....", ".....", ".....", "....."],
      previousBoards: [],
      consecutivePasses: 1,
      black: { type: "move", x: 0, y: 0 },
      policyBook: false,
      predicted: [],
      white: { type: "move", x: 1, y: 1, noOp: true },
      planningMs: 0,
    };
    const after = advance(trace);

    expect(after.responseNoOp).toBe(true);
    expect(after.responsePass).toBe(false);
    expect(after.passes).toBe(0);
    expect(after.history).toHaveLength(1);
  });

  test("ranking candidates put plausible root finalists before ordinary negatives", () => {
    expect(rankingMoves([0, 1, 2, 3, 4, 25], [2, 4, 2], 2, 25, 2))
      .toEqual([2, 4, 0, 3, 25]);
  });

  test("predictive win groups preserve win-first and terminal certainty", () => {
    const candidate = (
      move: "pass" | [number, number], winrate: number, exactOutcome: boolean,
    ) => ({
      move,
      predictedWhite: "pass" as const,
      evaluation: { visits: 2, winrate, scoreLead: 1 },
      exactOutcome,
      powerPerRound: 1,
    });
    const selected = candidate([0, 0], 0.8, false);
    const advice = {
      move: selected.move,
      predictedWhite: "pass" as const,
      candidateCount: 4,
      exactTerminal: false,
      selectionValue: 1,
      candidates: [
        selected,
        candidate([0, 1], 0.8, false),
        candidate([0, 2], 0.8, true),
        candidate([0, 3], 0.7, false),
      ],
      proposalMoves: [[0, 0] as [number, number]],
      visits: 2,
    };
    expect(predictiveWinGroupMoves(advice, 5)).toEqual([0, 1]);
  });
});
