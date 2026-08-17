/** Upstream-backed Go opponent and board adapters. This module is confined to
 * sim/: production imports neither vendored source nor hidden game state. */
import type { GoBoard } from "../../shared/strategy/go/rules.ts";
import type { AsyncGoPolicy } from "./go.ts";
import { GoColor, GoOpponent, GoPlayType } from "../vendor/bitburner/src/Go/Enums.ts";
import { getExpansionMoveArray, getMove } from "../vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
import { simpleBoardFromBoard } from "../vendor/bitburner/src/Go/boardAnalysis/boardAnalysis.ts";
import {
  getNewBoardState,
  getNewBoardStateFromSimpleBoard,
} from "../vendor/bitburner/src/Go/boardState/boardState.ts";
import { Go, Player } from "../vendor/bitburner/src/Go/OracleStubs.ts";

function randomFor(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Exact upstream obstacle generation plus a reproducible sample of the
 * intentionally unseeded handicap placement. The two seeds are deliberately
 * separate so an evaluation can pair the same start across candidates without
 * coupling handicap layouts to total playtime. */
export function oracleInitialBoard(
  size: 5 | 7 | 9 | 13,
  opponent: GoOpponent,
  obstacleSeed: number,
  handicapSeed: number,
): GoBoard {
  const originalRandom = Math.random;
  Player.totalPlaytime = obstacleSeed;
  Math.random = randomFor(handicapSeed);
  try {
    const state = getNewBoardState(size, opponent, true);
    return { size: state.board.length, rows: simpleBoardFromBoard(state.board) };
  } finally {
    Math.random = originalRandom;
  }
}

/** Enumerates every distinct initial board the game can create. Illuminati's
 * 5x5 handicap stone uses Math.random and therefore is not determined by the
 * obstacle/AI seed. */
export function oracleInitialBoards(
  size: 5,
  opponent: GoOpponent,
  obstacleSeed: number,
): GoBoard[] {
  if (opponent !== GoOpponent.Illuminati) {
    return [oracleInitialBoard(size, opponent, obstacleSeed, 0)];
  }
  Player.totalPlaytime = obstacleSeed;
  const state = getNewBoardState(size, GoOpponent.Netburners, true);
  const rows = simpleBoardFromBoard(state.board);
  const available = state.board.flat().filter((point) => point !== null);
  const expansion = getExpansionMoveArray(state.board, available).map((move) => move.point);
  const points = [...expansion];
  if (state.board[2]?.[2]) points.push(state.board[2][2]!);
  const boards = new Map<string, GoBoard>();
  if (expansion.length === 0) {
    // applyHandicap draws only from the expansion list; when it is empty, the
    // 20% center shortcut is the sole way a stone appears, so the untouched
    // board is a possible (and with an open center, the likeliest) opening.
    boards.set(rows.join(""), { size, rows: [...rows] });
  }
  for (const point of points) {
    const variant = rows.map((row) => row.split(""));
    variant[point.x]![point.y] = "O";
    const board = { size, rows: variant.map((row) => row.join("")) };
    boards.set(board.rows.join(""), board);
  }
  return [...boards.values()];
}

export function oracleWhitePolicy(opponent: GoOpponent, seedAtTurn: (turn: number) => number): AsyncGoPolicy {
  return async ({ board, history, turn, consecutivePasses }) => {
    // Passing w0r1d_d43m0n to getNewBoardStateFromSimpleBoard discards the
    // supplied position: upstream intentionally replaces it with a fresh
    // BitVerse board. Reconstruct secret-opponent midgames with the equivalent
    // smart AI first, then restore the actual opponent identity below.
    const reconstructionOpponent = opponent === GoOpponent.w0r1d_d43m0n
      ? GoOpponent.Illuminati
      : opponent;
    const state = getNewBoardStateFromSimpleBoard(board.rows, undefined, reconstructionOpponent, GoColor.black);
    state.previousBoards = history.map((position) => position.join(""));
    state.passCount = consecutivePasses;
    state.ai = opponent;
    Go.currentGame = state;
    const play = await getMove(state, GoColor.white, opponent, false, seedAtTurn(turn));
    return play.type === GoPlayType.move ? [play.x, play.y] : undefined;
  };
}
