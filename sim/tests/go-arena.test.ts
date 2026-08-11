import { describe, expect, test } from "bun:test";
import { legalMoves, playMove } from "../../shared/strategy/go/decide.ts";
import { oracleInitialBoard, oracleWhitePolicy } from "../features/go-oracle.ts";
import {
  GO_ARENA_OPPONENTS,
  playGoArenaGame,
  playGoArenaPosition,
  summarizeGoArena,
} from "../go-arena.ts";
import { GoOpponent } from "../vendor/bitburner/src/Go/Enums.ts";

describe("upstream-backed Go arena", () => {
  test("realistic seed timing keeps every forecasted immediate reply honest", async () => {
    const game = await playGoArenaGame(GO_ARENA_OPPONENTS[0]!, 1_000, 0.5, true);
    expect(game.completed).toBe(true);
    expect(game.trace?.length).toBeGreaterThan(0);
    for (const turn of game.trace ?? []) {
      const actual = turn.white.type === "move" ? `${turn.white.x},${turn.white.y}` : "pass";
      const predicted = turn.predicted.map((reply) => reply.x === null ? "pass" : `${reply.x},${reply.y}`);
      expect(predicted, `turn ${turn.turn} at ${turn.dispatchPlaytime}`).toContain(actual);
    }
  });

  test("the scaled 7x7 exact lane stays aligned with the upstream Illuminati", async () => {
    const game = await playGoArenaGame({
      ...GO_ARENA_OPPONENTS[5]!,
      requestedSize: 7,
    }, 1_000, 0.5, true);
    expect(game.completed).toBe(true);
    for (const turn of game.trace ?? []) {
      if (turn.black.type === "pass") continue;
      const actual = turn.white.type === "move" ? `${turn.white.x},${turn.white.y}` : "pass";
      const predicted = turn.predicted.map((reply) => reply.x === null ? "pass" : `${reply.x},${reply.y}`);
      expect(predicted, `7x7 turn ${turn.turn} at ${turn.dispatchPlaytime}`).toContain(actual);
    }
  });

  test("the secret-opponent oracle preserves an observed midgame instead of resetting it", async () => {
    const initial = oracleInitialBoard(13, GoOpponent.w0r1d_d43m0n, 1_000);
    const [x, y] = legalMoves(initial, "X")[0]!;
    const first = playMove(initial, x, y, "X");
    expect(first).toBeDefined();
    const policy = oracleWhitePolicy(GoOpponent.w0r1d_d43m0n, () => 1_200);
    const move = await policy({
      board: first!.board,
      colour: "O",
      history: [initial.rows],
      turn: 1,
      consecutivePasses: 0,
      komi: 9.5,
    });
    if (move) expect(playMove(first!.board, move[0], move[1], "O", new Set([initial.rows.join("")]))).toBeDefined();
  });

  test("a public midgame snapshot replays the original continuation exactly", async () => {
    const opponent = GO_ARENA_OPPONENTS[5]!;
    const original = await playGoArenaGame(opponent, 123_456, 0.5, true);
    const turn = original.trace?.[3];
    expect(turn?.black.type).toBe("move");
    if (!turn || turn.black.type !== "move") return;
    const replay = await playGoArenaPosition(opponent, 123_456, 0.5, {
      board: { size: 5, rows: turn.board },
      previousBoards: turn.previousBoards,
      consecutivePasses: turn.consecutivePasses,
      dispatchPlaytime: turn.dispatchPlaytime,
    }, [turn.black.x, turn.black.y]);
    expect(replay.completed).toBe(true);
    expect(replay.score).toEqual(original.score);
  });

  test("summary reports confidence, tail latency, and replayable losses", async () => {
    const opponent = GO_ARENA_OPPONENTS[5]!;
    const games = await Promise.all([1_000, 5_000].map((seed) => playGoArenaGame(opponent, seed)));
    const summary = summarizeGoArena(opponent.name, games);
    expect(summary.games).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.decisions).toBeGreaterThan(0);
    expect(summary.latencyMs.p99).toBeGreaterThanOrEqual(summary.latencyMs.p50);
    expect(summary.wilsonLower95).toBeGreaterThanOrEqual(0);
    expect(summary.losingSeeds.every(({ seed }) => seed === 1_000 || seed === 5_000)).toBe(true);
  });
});
