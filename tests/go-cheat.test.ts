import { describe, expect, test } from "bun:test";
import { applyGoCheat, type GoBoard, type GoView } from "../shared/strategy/go/rules.ts";
import { decideGoNeural, GoNeuralEngine } from "../shared/strategy/go/neural/engine.ts";
import { goOpponentSeedCandidates } from "../shared/strategy/go/rng.ts";
import { StubGoValueBackend } from "./support/go-value-backend.ts";

const empty: GoBoard = { size: 5, rows: Array<string>(5).fill(".....") };

function view(successChance: number): GoView {
  return {
    board: empty,
    currentPlayer: "Black",
    opponent: "Netburners",
    status: "inProgress",
    previousBoards: [],
    consecutivePasses: 0,
    komi: 1.5,
    bonusCycles: 0,
    cheat: {
      unlocked: true,
      count: 0,
      successByCount: [successChance],
      candidateLimit: 2,
      doubleMoveLimit: 1,
    },
  };
}

describe("IPvGO cheat planning", () => {
  test("applies both routers before the one shared capture resolution", () => {
    const board: GoBoard = {
      size: 5,
      rows: [".X...", "XOX..", ".....", ".....", "....."],
    };
    const played = applyGoCheat(board, {
      type: "cheatTwoMoves",
      x1: 2, y1: 1,
      x2: 4, y2: 4,
    });
    expect(played?.board.rows[1]?.[1]).toBe(".");
    expect(played?.board.rows[2]?.[1]).toBe("X");
    expect(played?.board.rows[4]?.[4]).toBe("X");
    expect(played?.captures).toBe(1);
  });

  test("does not report friendly suicide cleanup as a capture", () => {
    const board: GoBoard = {
      size: 5,
      rows: [".O...", "O.O..", ".O.O.", "..O..", "....."],
    };
    const played = applyGoCheat(board, {
      type: "cheatTwoMoves",
      x1: 0, y1: 0,
      x2: 2, y2: 2,
    });
    expect(played?.board.rows[0]?.[0]).toBe(".");
    expect(played?.board.rows[2]?.[2]).toBe(".");
    expect(played?.captures).toBe(0);
  });

  test("a successful dispatch seed excludes ordinary placements", async () => {
    const dispatch = 10_000;
    const engine = new GoNeuralEngine((weights) => new StubGoValueBackend(weights));
    const decision = await decideGoNeural(
      view(1),
      goOpponentSeedCandidates(dispatch, 0),
      engine,
      dispatch,
    );
    expect(decision.action.type.startsWith("cheat") || decision.action.type === "pass").toBe(true);
    expect(decision.action.type).toBe("cheatTwoMoves");
    await engine.dispose();
  });

  test("a failed dispatch seed uses the ordinary policy", async () => {
    const dispatch = 10_000;
    const engine = new GoNeuralEngine((weights) => new StubGoValueBackend(weights));
    const decision = await decideGoNeural(
      view(0),
      goOpponentSeedCandidates(dispatch, 0),
      engine,
      dispatch,
    );
    expect(decision.action.type === "move" || decision.action.type === "pass").toBe(true);
    await engine.dispose();
  });
});
