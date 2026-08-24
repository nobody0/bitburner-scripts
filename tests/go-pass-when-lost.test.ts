import { describe, expect, test } from "bun:test";
import type { GoBoard, GoView } from "../shared/strategy/go/rules.ts";
import { scoreBoard } from "../shared/strategy/go/rules.ts";
import {
  decideGoNeural,
  GoNeuralEngine,
  type GoPassWhenLostV1,
} from "../shared/strategy/go/neural/engine.ts";
import { goOpponentSeedCandidates } from "../shared/strategy/go/rng.ts";
import { StubGoValueBackend } from "./support/go-value-backend.ts";

const DISPATCH = 10_000;

/** Black is behind and every legal Black move is an own-eye fill: the exact
 * spiral position — playing on can only hand the group to White, while
 * passing now banks the standing ten points. */
const doomed: GoBoard = {
  size: 5,
  rows: ["X.X.X", "XXXXX", "OOOOO", "OO.OO", "OOOO."],
};

/** Same shape mirrored, plus one open dame at (2,0): claiming it is safe
 * (the group keeps both eyes) and banks one more point than passing. */
const harvest: GoBoard = {
  size: 5,
  rows: ["OOOO.", "OO.OO", ".OOOO", "XXXXX", "X.X.X"],
};

/** A lone White stone in atari at (0,1): the capture at (0,0) banks two more
 * points and White has no reply that takes them back. */
const capture: GoBoard = {
  size: 5,
  rows: [".OX.X", "XXXXX", "OOOOO", "OO.OO", "OOOO."],
};

function view(board: GoBoard, consecutivePasses: number): GoView {
  return {
    board,
    currentPlayer: "Black",
    opponent: "Netburners",
    status: "inProgress",
    previousBoards: [],
    consecutivePasses,
    komi: 1.5,
    bonusCycles: 0,
  };
}

/** The stub backend's value head is neutral (predictedWin 0.5 everywhere), so
 * tests that want the position treated as lost raise winAbort above it. */
const treatAsLost: GoPassWhenLostV1 = { winAbort: 0.6, rolloutConfirm: false };

function engine(): GoNeuralEngine {
  return new GoNeuralEngine((weights) => new StubGoValueBackend(weights));
}

const seeds = goOpponentSeedCandidates(DISPATCH, 0);

describe("pass-when-lost banking", () => {
  test("the fixtures are behind, so the win-lock cannot be what passes", () => {
    for (const board of [doomed, harvest, capture]) {
      const score = scoreBoard(board, 1.5);
      expect(score.X).toBeLessThan(score.O);
    }
  });

  test("banks a doomed position by passing instead of filling its own eye", async () => {
    const testEngine = engine();
    const decision = await decideGoNeural(
      view(doomed, 1), seeds, testEngine, DISPATCH, { passWhenLost: treatAsLost });
    expect(decision.action).toEqual({ type: "pass" });
    expect(decision.passReason).toBe("banking-lost-position");
    await testEngine.dispose();
  });

  test("keeps a safe point that banks more than passing would", async () => {
    const testEngine = engine();
    const decision = await decideGoNeural(
      view(harvest, 1), seeds, testEngine, DISPATCH, { passWhenLost: treatAsLost });
    expect(decision.action).toEqual({ type: "move", x: 2, y: 0 });
    expect(decision.passReason).toBeUndefined();
    await testEngine.dispose();
  });

  test("keeps a capture that banks more than passing would", async () => {
    const testEngine = engine();
    const decision = await decideGoNeural(
      view(capture, 1), seeds, testEngine, DISPATCH, { passWhenLost: treatAsLost });
    expect(decision.action).toEqual({ type: "move", x: 0, y: 0 });
    expect(decision.passReason).toBeUndefined();
    await testEngine.dispose();
  });

  test("does nothing while White's pass is not on the table", async () => {
    const testEngine = engine();
    const configured = await decideGoNeural(
      view(doomed, 0), seeds, testEngine, DISPATCH, { passWhenLost: treatAsLost });
    const disabled = await decideGoNeural(
      view(doomed, 0), seeds, testEngine, DISPATCH, { passWhenLost: null });
    expect(configured).toEqual(disabled);
    expect(configured.action.type).toBe("move");
    await testEngine.dispose();
  });

  test("a predicted win above winAbort keeps the move", async () => {
    const testEngine = engine();
    const decision = await decideGoNeural(
      view(doomed, 1), seeds, testEngine, DISPATCH,
      { passWhenLost: { winAbort: 0.4, rolloutConfirm: false } });
    expect(decision.action.type).toBe("move");
    expect(decision.passReason).toBeUndefined();
    await testEngine.dispose();
  });

  test("an ahead position still locks the win via the immediate rule", async () => {
    const ahead: GoBoard = {
      size: 5,
      rows: ["O.O.O", "OOOOO", "XXXXX", "XX.XX", "XXXX."],
    };
    const testEngine = engine();
    const decision = await decideGoNeural(
      view(ahead, 1), seeds, testEngine, DISPATCH,
      { passWhenLost: { winAbort: 1, rolloutConfirm: false } });
    expect(decision.action).toEqual({ type: "pass" });
    expect(decision.positionValue).toBe(1);
    expect(decision.passReason).toBeUndefined();
    await testEngine.dispose();
  });

  test("the rollout guard confirms the loss before the swap", async () => {
    const testEngine = engine();
    const decision = await decideGoNeural(
      view(doomed, 1), seeds, testEngine, DISPATCH,
      { passWhenLost: { winAbort: 0.6, rolloutConfirm: true, rolloutPlies: 8 } });
    expect(decision.action).toEqual({ type: "pass" });
    expect(decision.passReason).toBe("banking-lost-position");
    await testEngine.dispose();
  });
});
