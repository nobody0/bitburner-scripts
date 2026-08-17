import { describe, expect, test } from "bun:test";
import { legalMoves, playMove } from "../../shared/strategy/go/rules.ts";
import { oracleInitialBoard, oracleWhitePolicy } from "../features/go-oracle.ts";
import {
  GO_ARENA_OPPONENTS,
  configureGoArenaEngine,
  goArenaDefenseRoll,
  goProfileArenaSeedCases,
  goArenaSeedPairs,
  playGoArenaGame,
  playGoArenaPosition,
  summarizeGoArena,
} from "../go-arena.ts";
import { GoOpponent } from "../vendor/bitburner/src/Go/Enums.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";

const hasWebGpu = Boolean((globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu);

describe("upstream-backed Go arena", () => {
  test("unseeded sampling uses independent reproducible corpus dimensions", () => {
    const first = goArenaSeedPairs(4, 1_000, 123_456, 987_654);
    const shiftedPlaytime = goArenaSeedPairs(4, 99_000, 123_456, 987_654);
    expect(first.map(({ handicapSeed }) => handicapSeed))
      .toEqual(shiftedPlaytime.map(({ handicapSeed }) => handicapSeed));
    expect(new Set(first.map(({ handicapSeed }) => handicapSeed)).size).toBe(4);
    expect(first.map(({ defenseSeed }) => defenseSeed))
      .toEqual(shiftedPlaytime.map(({ defenseSeed }) => defenseSeed));
    expect(new Set(first.map(({ defenseSeed }) => defenseSeed)).size).toBe(4);
    expect(first.map(({ defenseSeed }) => defenseSeed))
      .not.toEqual(first.map(({ handicapSeed }) => handicapSeed));
    const defenseRolls = first.map(({ defenseSeed }) => goArenaDefenseRoll(defenseSeed));
    expect(new Set(defenseRolls).size).toBe(4);
    expect(defenseRolls.every((roll) => roll >= 0 && roll < 1 && roll !== 0.5)).toBe(true);

    const daemonA = oracleInitialBoard(13, GoOpponent.w0r1d_d43m0n, 1_000, first[0]!.handicapSeed);
    const daemonB = oracleInitialBoard(13, GoOpponent.w0r1d_d43m0n, 1_000, first[1]!.handicapSeed);
    expect(daemonA.rows).not.toEqual(daemonB.rows);
  });

  test("profile corpora are balanced and opponent-separated", () => {
    const small5 = goProfileArenaSeedCases("small5", 3, 1_000, 2_000, 3_000);
    expect(small5).toHaveLength(6);
    expect(small5.every((corpus) => corpus.cases.length === 3)).toBe(true);
    expect(new Set(small5.map((corpus) => corpus.cases[0]!.seed)).size).toBe(6);
    expect(new Set(small5.map((corpus) => corpus.cases[0]!.handicapSeed)).size).toBe(6);
    expect(new Set(small5.map((corpus) => corpus.cases[0]!.defenseSeed)).size).toBe(6);

    const daemon = goProfileArenaSeedCases("daemon19", 3, 1_000, 2_000, 3_000);
    expect(daemon.map((corpus) => corpus.opponent)).toEqual(["????????????"]);
    expect(daemon[0]!.cases).toHaveLength(3);
  });

  test.skipIf(hasWebGpu)("cheating is an explicit arena A/B configuration", async () => {
    configureGoArenaEngine((weights) => new StubGoValueBackend(weights));
    const ordinary = await playGoArenaGame(GO_ARENA_OPPONENTS[0]!, 1_000);
    const cheating = await playGoArenaGame(GO_ARENA_OPPONENTS[0]!, 1_000, 0.5, false, {
      cheat: { enabled: true, successChance: 1, candidateLimit: 4, doubleMoveLimit: 2 },
    });
    expect(ordinary.cheatsPlayed).toBe(0);
    expect(ordinary.actions.every((action) => !action.startsWith("cheat"))).toBe(true);
    expect(cheating.cheatsPlayed).toBeGreaterThan(0);
    expect(cheating.actions.every((action) => action === "pass" || action.startsWith("cheat"))).toBe(true);
  });

  test.skipIf(!hasWebGpu)("realistic seed timing keeps every forecasted immediate reply honest", async () => {
    const game = await playGoArenaGame(GO_ARENA_OPPONENTS[0]!, 1_000, 0.5, true);
    expect(game.completed).toBe(true);
    expect(game.trace?.length).toBeGreaterThan(0);
    for (const turn of game.trace ?? []) {
      const actual = turn.white.type === "move" ? `${turn.white.x},${turn.white.y}` : "pass";
      const predicted = turn.predicted.map((reply) => reply.x === null ? "pass" : `${reply.x},${reply.y}`);
      expect(predicted, `turn ${turn.turn} at ${turn.dispatchPlaytime}`).toContain(actual);
    }
  });

  test.skipIf(!hasWebGpu)("the scaled 7x7 exact lane stays aligned with the upstream Illuminati", async () => {
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
    const initial = oracleInitialBoard(13, GoOpponent.w0r1d_d43m0n, 1_000, 123_456);
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

  test.skipIf(!hasWebGpu)("the 19x19 daemon lane predicts each immediate upstream reply", async () => {
    const game = await playGoArenaGame(GO_ARENA_OPPONENTS[6]!, 1_000, 0.5, true);
    expect(game.completed).toBe(true);
    expect(game.size).toBe(19);
    expect(game.planningMs.length).toBeGreaterThan(0);
    for (const turn of game.trace ?? []) {
      if (turn.black.type === "pass") continue;
      const actual = turn.white.type === "move" ? `${turn.white.x},${turn.white.y}` : "pass";
      const predicted = turn.predicted.map((reply) => reply.x === null ? "pass" : `${reply.x},${reply.y}`);
      expect(predicted, `19x19 turn ${turn.turn} at ${turn.dispatchPlaytime}`).toContain(actual);
    }
    // Inference is the deployed WebGPU backend; Bun skips this and the
    // Chromium arena runs it through `bun run go:gpu -- --arena`.
  }, 120_000);

  test.skipIf(!hasWebGpu)("a public midgame snapshot replays the original continuation exactly", async () => {
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

  test.skipIf(!hasWebGpu)("summary reports confidence, tail latency, and replayable losses", async () => {
    const opponent = GO_ARENA_OPPONENTS[5]!;
    const games = await Promise.all([1_000, 5_000].map((seed) => playGoArenaGame(opponent, seed)));
    const summary = summarizeGoArena(opponent.name, games);
    expect(summary.games).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.decisions).toBeGreaterThan(0);
    expect(summary.latencyMs.p99).toBeGreaterThanOrEqual(summary.latencyMs.p50);
    expect(summary.wilsonLower95).toBeGreaterThanOrEqual(0);
    expect(summary.losingSeeds.every(({ seed, handicapSeed }) =>
      (seed === 1_000 || seed === 5_000) && Number.isInteger(handicapSeed))).toBe(true);
  });
});
