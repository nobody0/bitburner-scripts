import { describe, expect, test } from "bun:test";
import { group, playMove, scoreBoard, type GoBoard, type Stone } from "../../shared/strategy/go/decide.ts";
import { predictOpponentReplies } from "../../shared/strategy/go/opponent.ts";
import { GO_ENGINE_CYCLE_MS, goAiWaitMs, nextGoTurnTiming, whrng } from "../../shared/strategy/go/rng.ts";
import {
  goDifficultyMultiplier,
  goEffectMultiplier,
  goFavorRepCap,
  goFavorReward,
  goStreakMultiplier,
  inferGoNodePower,
} from "../../shared/strategy/go/rewards.ts";
import { WHRNG } from "../vendor/bitburner/src/Casino/RNG.ts";
import { CONSTANTS } from "../vendor/bitburner/src/Constants.ts";
import { GoColor, GoOpponent, GoPlayType, GoValidity } from "../vendor/bitburner/src/Go/Enums.ts";
import {
  evaluateIfMoveIsValid,
  simpleBoardFromBoard,
} from "../vendor/bitburner/src/Go/boardAnalysis/boardAnalysis.ts";
import { getScore } from "../vendor/bitburner/src/Go/boardAnalysis/ScoringOracle.ts";
import { getMove } from "../vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
import {
  getNewBoardState,
  getNewBoardStateFromSimpleBoard,
  makeMove,
  passTurn,
} from "../vendor/bitburner/src/Go/boardState/boardState.ts";
import type { BoardState, SimpleBoard } from "../vendor/bitburner/src/Go/Types.ts";
import { Go, Player, sleepLog } from "../vendor/bitburner/src/Go/OracleStubs.ts";
import {
  CalculateEffect,
  EffectOracleState,
  getDifficultyMultiplier,
  getMaxRep,
  getWinstreakMultiplier,
} from "../vendor/bitburner/src/Go/effects/EffectOracle.ts";
import { addRepToFavor } from "../vendor/bitburner/src/Faction/formulas/favor.ts";

describe("handcrafted Go rewards match pinned v3.0.1", () => {
  const opponents = [
    { oracle: GoOpponent.Netburners, ours: "Netburners" },
    { oracle: GoOpponent.SlumSnakes, ours: "Slum Snakes" },
    { oracle: GoOpponent.TheBlackHand, ours: "The Black Hand" },
    { oracle: GoOpponent.Tetrads, ours: "Tetrads" },
    { oracle: GoOpponent.Daedalus, ours: "Daedalus" },
    { oracle: GoOpponent.Illuminati, ours: "Illuminati" },
    { oracle: GoOpponent.w0r1d_d43m0n, ours: "????????????" },
  ] as const;

  test("effect curve and public-bonus inversion", () => {
    try {
      for (const [goPower, sf14] of [[1, 0], [4, 0], [1, 1], [4, 3]] as const) {
        EffectOracleState.goPower = goPower;
        EffectOracleState.sourceFile14Level = sf14;
        for (const opponent of opponents) for (const power of [0, 1, 25, 1_000, 1e6]) {
          const upstream = CalculateEffect(power, opponent.oracle);
          expect(goEffectMultiplier(power, opponent.ours, goPower, sf14 > 0)).toBeCloseTo(upstream, 12);
          expect(inferGoNodePower((upstream - 1) * 100, opponent.ours, goPower, sf14 > 0)).toBeCloseTo(power, 5);
        }
      }
    } finally {
      EffectOracleState.goPower = 1;
      EffectOracleState.sourceFile14Level = 0;
    }
  });

  test("SF14 favor cap", () => {
    try {
      for (const level of [0, 1, 2, 3, 10]) {
        EffectOracleState.sourceFile14Level = level;
        expect(goFavorRepCap(level)).toBe(getMaxRep());
      }
    } finally {
      EffectOracleState.sourceFile14Level = 0;
    }
  });

  test("streak and comeback multipliers", () => {
    for (let current = -12; current <= 12; current++) {
      for (let previous = -12; previous <= 12; previous++) {
        expect(goStreakMultiplier(current, previous)).toBe(getWinstreakMultiplier(current, previous));
      }
    }
  });

  test("opponent difficulty including tiny-board Illuminati", () => {
    for (const opponent of opponents) for (const size of [5, 7, 9, 13, 19]) {
      const komi = opponent.ours === "Netburners" ? 1.5
        : opponent.ours === "Slum Snakes" || opponent.ours === "The Black Hand" ? 3.5
        : opponent.ours === "Tetrads" || opponent.ours === "Daedalus" ? 5.5
        : opponent.ours === "Illuminati" ? 7.5 : 9.5;
      expect(goDifficultyMultiplier(opponent.ours, size)).toBe(getDifficultyMultiplier(komi, size));
    }
  });

  test("streak reward converts the exact capped rep grant into favor", () => {
    for (const cap of [100_000, 200_000, 300_000, 400_000]) {
      for (const favor of [0, 10, 100, 149.5]) {
        const reward = goFavorReward(favor, 0, cap);
        expect(reward.repGranted).toBe(cap / 200);
        expect(reward.favorAfter).toBe(addRepToFavor(favor, cap / 200));
        expect(goFavorReward(favor, cap, cap)).toEqual({ repGranted: 0, favorAfter: favor, favorGain: 0 });
      }
    }
  });
});

/** Test-oracle parity: production handcrafts this stream and derives a narrow
 * seed window from public playtime; only tests import the pinned game source. */
describe("Go WHRNG parity with pinned game source", () => {
  for (const totalPlaytime of [0, 1, 999, 1_000, 12_345_678, 30_000_000, 98_765_432.1]) {
    test(`totalPlaytime ${totalPlaytime}`, () => {
      const upstream = new WHRNG(totalPlaytime);
      expect(whrng(totalPlaytime, 12)).toEqual(Array.from({ length: 12 }, () => upstream.random()));
    });
  }

  test("AI waits use the upstream engine-cycle constants", () => {
    expect(GO_ENGINE_CYCLE_MS).toBe(CONSTANTS.MilliPerCycle);
    expect(goAiWaitMs(0)).toBe(200);
    expect(goAiWaitMs(10)).toBe(40);
  });
});

const toColor = (stone: Stone): GoColor => stone === "X" ? GoColor.black : GoColor.white;
const other = (stone: Stone): Stone => stone === "X" ? "O" : "X";
const board = (rows: string[]): GoBoard => ({ rows, size: rows.length });
const unpack = (value: string, size: number): string[] =>
  Array.from({ length: size }, (_, x) => value.slice(x * size, (x + 1) * size));

function oracleState(rows: SimpleBoard, previousPlayer: GoColor, history: readonly string[][]): BoardState {
  const state = getNewBoardStateFromSimpleBoard(rows, undefined, GoOpponent.Netburners, previousPlayer);
  state.previousBoards = history.map((prior) => prior.join(""));
  return state;
}

function assertPositionParity(state: BoardState, stone: Stone): [number, number][] {
  const rows = simpleBoardFromBoard(state.board);
  const handcrafted = board(rows);
  const history = state.previousBoards.map((prior) => unpack(prior, rows.length));
  const historyHashes = new Set(state.previousBoards);
  const legal: [number, number][] = [];
  for (let x = 0; x < rows.length; x++) {
    for (let y = 0; y < rows.length; y++) {
      const validity = evaluateIfMoveIsValid(state, x, y, toColor(stone), false);
      const ours = playMove(handcrafted, x, y, stone, historyHashes);
      expect(Boolean(ours), `legality drift at ${x},${y} on ${rows.join("/")}`).toBe(validity === GoValidity.valid);
      if (!ours) continue;
      const copy = oracleState(rows, state.previousPlayer!, history);
      expect(makeMove(copy, x, y, toColor(stone))).toBe(true);
      expect(ours.board.rows).toEqual(simpleBoardFromBoard(copy.board));
      legal.push([x, y]);
    }
  }
  return legal;
}

describe("handcrafted Go rules match pinned v3.0.1", () => {
  test("capture, suicide, and positional superko match on curated boards", () => {
    const positions: { rows: string[]; toMove: Stone; history?: string[][] }[] = [
      { rows: [".X.", "XO.", ".X."], toMove: "X" },
      { rows: [".X.", "X.X", ".X."], toMove: "O" },
      { rows: ["X.O", ".XO", "X.O"], toMove: "X", history: [["XXO", "..O", "XXO"]] },
      {
        rows: ["...", "...", "..."],
        toMove: "X",
        // Both old positions matter: this pins superko, not merely simple ko.
        history: [["X..", "...", "..."], ["...", "...", "..X"]],
      },
      { rows: [".....", ".....", ".....", ".....", "....."], toMove: "X" },
    ];
    for (const position of positions) {
      const state = oracleState(position.rows, toColor(other(position.toMove)), position.history ?? []);
      assertPositionParity(state, position.toMove);
    }
  });

  test("legality, captures, and liberties match across deterministic reachable games", () => {
    for (const size of [5, 7]) {
      for (let game = 0; game < 4; game++) {
        let state = oracleState(Array.from({ length: size }, () => ".".repeat(size)), GoColor.white, []);
        let stone: Stone = "X";
        let seed = 0x9e3779b9 ^ size ^ game;
        for (let turn = 0; turn < size * size; turn++) {
          const legal = assertPositionParity(state, stone);
          const rows = simpleBoardFromBoard(state.board);
          for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
            const point = state.board[x]?.[y];
            if (!point || point.color === GoColor.empty) continue;
            expect(group(board(rows), x, y).liberties).toBe(point.liberties?.length ?? 0);
          }
          if (!legal.length) break;
          seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
          const [x, y] = legal[seed % legal.length]!;
          expect(makeMove(state, x, y, toColor(stone))).toBe(true);
          stone = other(stone);
        }
      }
    }
  });

  test("area scoring matches, including the almost-empty-board exception", () => {
    const positions = [
      [".....", ".....", "..X..", ".....", "....."],
      ["XX...", "X....", ".....", "....O", "...OO"],
      ["XXXXX", "X...X", "X.O.X", "X...X", "XXXXX"],
    ];
    for (const rows of positions) {
      for (const komi of [0, 1.5, 6.5]) {
        const state = oracleState(rows, GoColor.white, []);
        state.komiOverride = komi;
        const upstream = getScore(state);
        expect(scoreBoard(board(rows), komi)).toEqual({
          X: upstream[GoColor.black].sum,
          O: upstream[GoColor.white].sum,
        });
      }
    }
  });
});

describe("handcrafted faction AI matches the pinned AI", () => {
  const opponents = [
    { oracle: GoOpponent.Netburners, forecast: "Netburners" },
    { oracle: GoOpponent.SlumSnakes, forecast: "Slum Snakes" },
    { oracle: GoOpponent.TheBlackHand, forecast: "The Black Hand" },
    { oracle: GoOpponent.Tetrads, forecast: "Tetrads" },
    { oracle: GoOpponent.Daedalus, forecast: "Daedalus" },
    { oracle: GoOpponent.Illuminati, forecast: "Illuminati" },
    { oracle: GoOpponent.w0r1d_d43m0n, forecast: "????????????" },
  ] as const;

  const forecastContains = (
    forecast: ReturnType<typeof predictOpponentReplies>,
    actual: { x: number | null; y: number | null },
  ): boolean => forecast.replies.some(({ move }) => move
    ? actual.x === move.x && actual.y === move.y
    : actual.x === null && actual.y === null);

  test("the empty-board response follows the exact seeded pipeline", async () => {
    const rows = Array.from({ length: 5 }, () => ".....");
    let matches = 0;
    let total = 0;
    for (const opponent of opponents) {
      for (let seed = 1_000; seed < 1_100; seed += 3) {
        const state = oracleState(rows, GoColor.black, []);
        state.ai = opponent.oracle;
        Go.currentGame = state;
        const actual = await getMove(state, GoColor.white, opponent.oracle, false, seed);
        const forecast = predictOpponentReplies(board(rows), opponent.forecast, seed);
        if (forecastContains(forecast, actual)) matches++;
        total++;
      }
    }
    expect(matches).toBe(total);
  });

  test("every actual reply is in the exact predicted set on reachable midgames", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0.5; // The pinned AI has one intentionally unseeded defend tie-break.
    try {
      let matches = 0;
      let total = 0;
      for (const opponent of opponents) {
        for (let game = 0; game < 3; game++) {
          const state = oracleState(Array.from({ length: 5 }, () => "....."), GoColor.white, []);
          state.ai = opponent.oracle;
          for (let turn = 0; turn < 8; turn++) {
            const legal: [number, number][] = [];
            for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
              if (evaluateIfMoveIsValid(state, x, y, GoColor.black, false) === GoValidity.valid) legal.push([x, y]);
            }
            if (!legal.length) break;
            const black = legal[(game * 7 + turn * 3) % legal.length]!;
            expect(makeMove(state, black[0], black[1], GoColor.black)).toBe(true);

            const rows = simpleBoardFromBoard(state.board);
            const history = state.previousBoards.map((prior) => unpack(prior, 5));
            const seed = 1_000 + game * 101 + turn * 17;
            const forecast = predictOpponentReplies(board(rows), opponent.forecast, seed, history, state.passCount);
            for (const { move } of forecast.replies) if (move) {
              expect(playMove(board(rows), move.x, move.y, "O", new Set(state.previousBoards))).toBeDefined();
            }
            Go.currentGame = state;
            const actual = await getMove(state, GoColor.white, opponent.oracle, false, seed);
            if (actual.type !== "move") break;
            const matched = forecastContains(forecast, actual);
            expect(matched, `${opponent.forecast} game=${game} turn=${turn} seed=${seed} board=${rows.join("/")} predicted=${forecast.replies.map(({ move }) => move ? `${move.x},${move.y}` : "pass").join("|")} actual=${actual.x},${actual.y}`).toBe(true);
            if (matched) matches++;
            total++;
            expect(makeMove(state, actual.x, actual.y, GoColor.white)).toBe(true);
          }
        }
      }
      expect(matches).toBe(total);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("the unseeded defense tie is represented as the complete honest set", async () => {
    const rows = ["XOXX.", "X....", ".....", "....X", ".XXOX"];
    const seed = 1_270;
    const forecast = predictOpponentReplies(board(rows), "Illuminati", seed);
    expect(forecast).toEqual({
      replies: [
        { move: { x: 1, y: 1 }, probability: 0.5, branch: "defendCapture", wait: { cycleWaitsAfterSeed: 4, fixedSleepMsAfterSeed: 0 } },
        { move: { x: 3, y: 3 }, probability: 0.5, branch: "defendCapture", wait: { cycleWaitsAfterSeed: 4, fixedSleepMsAfterSeed: 0 } },
      ],
      certainty: "unseeded-defense-tie",
    });
    const originalRandom = Math.random;
    try {
      for (const random of [0, 0.25, 0.5, 0.999999]) {
        Math.random = () => random;
        const state = oracleState(rows, GoColor.black, []);
        state.ai = GoOpponent.Illuminati;
        Go.currentGame = state;
        const actual = await getMove(state, GoColor.white, state.ai, false, seed);
        expect(forecastContains(forecast, actual), `Math.random=${random}; actual=${actual.x},${actual.y}`).toBe(true);
      }
    } finally {
      Math.random = originalRandom;
    }
  });

  test("branch wait traces reproduce upstream wall time and yield a distinct next-turn seed", async () => {
    const rows = Array.from({ length: 5 }, () => ".....");
    for (const bonusCycles of [0, 1, 4, 20]) {
      for (const seed of [1_000, 1_217, 4_019]) {
        const state = oracleState(rows, GoColor.black, []);
        state.ai = GoOpponent.Daedalus;
        Go.currentGame = state;
        Go.storedCycles = bonusCycles;
        sleepLog.length = 0;
        const actual = await getMove(state, GoColor.white, state.ai, true, seed);
        const forecast = predictOpponentReplies(board(rows), "Daedalus", seed);
        const reply = forecast.replies.find(({ move }) => move
          ? actual.x === move.x && actual.y === move.y
          : actual.x === null && actual.y === null);
        expect(reply).toBeDefined();
        const placementMs = actual.type === GoPlayType.move ? (Go.storedCycles > 0 ? 40 : 200) : 0;
        const timing = nextGoTurnTiming(10_000, bonusCycles, reply!.wait);
        expect(timing.responseWallMs).toBe(sleepLog.reduce((sum, milliseconds) => sum + milliseconds, 0) + placementMs);
        expect(timing.nextSeed).not.toBe(seed);
        expect(timing.nextSeed).toBeGreaterThan(timing.responsePlaytimeMs);
      }
    }
  });

  test("generated obstacle games match across factions and board sizes", async () => {
    const originalRandom = Math.random;
    try {
      for (const [opponentIndex, opponent] of opponents.slice(0, 6).entries()) {
        for (const size of [5, 7, 9, 13] as const) {
          const gameSeed = 20_000 + opponentIndex * 2_003 + size * 101;
          Player.totalPlaytime = gameSeed;
          const state = getNewBoardState(size, opponent.oracle, true);
          state.ai = opponent.oracle;
          for (let turn = 0; turn < (size <= 7 ? 10 : 4); turn++) {
            const legal: [number, number][] = [];
            for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
              if (evaluateIfMoveIsValid(state, x, y, GoColor.black, false) === GoValidity.valid) legal.push([x, y]);
            }
            if (!legal.length) passTurn(state, GoColor.black, false);
            else {
              const move = legal[(turn * 11 + opponentIndex * 7 + size) % legal.length]!;
              expect(makeMove(state, move[0], move[1], GoColor.black)).toBe(true);
            }
            const rows = simpleBoardFromBoard(state.board);
            const history = state.previousBoards.map((prior) => unpack(prior, size));
            const seed = gameSeed + turn * 401;
            const forecast = predictOpponentReplies(board(rows), opponent.forecast, seed, history, state.passCount);
            Math.random = () => [0, 0.25, 0.5, 0.999999][turn % 4]!;
            Go.currentGame = state;
            const actual = await getMove(state, GoColor.white, opponent.oracle, false, seed);
            expect(
              forecastContains(forecast, actual),
              `${opponent.forecast} ${size}x${size} turn=${turn} board=${rows.join("/")} predicted=${forecast.replies.map(({ move }) => move ? `${move.x},${move.y}` : "pass").join("|")} actual=${actual.x},${actual.y}`,
            ).toBe(true);
            if (actual.type === GoPlayType.move) expect(makeMove(state, actual.x, actual.y, GoColor.white)).toBe(true);
            else passTurn(state, GoColor.white, false);
          }
        }
      }
    } finally {
      Math.random = originalRandom;
    }
  }, 30_000);
});
