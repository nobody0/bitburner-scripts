/** Upstream-backed Go opponent and board adapters. This module is confined to
 * sim/: production imports neither vendored source nor hidden game state. */
import type { GoBoard } from "../../shared/strategy/go/decide.ts";
import type { AsyncGoPolicy } from "./go.ts";
import { GoColor, GoOpponent, GoPlayType } from "../vendor/bitburner/src/Go/Enums.ts";
import { getMove } from "../vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
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

/** Exact upstream obstacle generation plus a deterministic sample of the one
 * intentionally unseeded handicap tie-break. */
export function oracleInitialBoard(size: 5 | 7 | 9 | 13, opponent: GoOpponent, seed: number): GoBoard {
  const originalRandom = Math.random;
  Player.totalPlaytime = seed;
  Math.random = randomFor(seed ^ 0xa5a5a5a5);
  try {
    const state = getNewBoardState(size, opponent, true);
    return { size: state.board.length, rows: simpleBoardFromBoard(state.board) };
  } finally {
    Math.random = originalRandom;
  }
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
