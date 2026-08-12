import {
  legalMoves,
  playMove,
  scoreBoard,
  type GoBoard,
  type GoRewardOpponent,
  type Stone,
} from "../../shared/strategy/go/rules.ts";
import { decideGoNeural, GoNeuralEngine } from "../../shared/strategy/go/neural/engine.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";
import { GO_ENGINE_CYCLE_MS } from "../../shared/strategy/go/rng.ts";
export { whrng } from "../../shared/strategy/go/rng.ts";

export interface GoPolicyView {
  board: GoBoard;
  colour: Stone;
  history: readonly string[][];
  turn: number;
  consecutivePasses: number;
  komi: number;
}

export type GoPolicy = (view: GoPolicyView) => [number, number] | undefined;
export type AsyncGoPolicy = (view: GoPolicyView) => [number, number] | undefined | Promise<[number, number] | undefined>;

export const firstLegalPolicy: GoPolicy = ({ board, colour, history }) =>
  legalMoves(board, colour, history)[0];

const sharedEngine = new GoNeuralEngine((weights) => createRequiredWebGpuGoValueBackend(weights));

/** The production strategy plays black. This adapter lets the simulator drive
 * it through the generic rules runner. Without an explicit prediction the
 * reply forecast still needs some WHRNG phase, so a deterministic per-turn
 * tick keeps runs reproducible. */
export function productionPolicy(
  prediction?: { opponent: GoRewardOpponent; seedAtTurn(turn: number): number },
  engine: GoNeuralEngine = sharedEngine,
): AsyncGoPolicy {
  return async ({ board, colour, history, turn, komi, consecutivePasses }) => {
    if (colour === "O") {
      // Color swap preserves rules and makes the black-only production planner
      // usable as a white policy without teaching game/ about the simulator.
      board = {
        size: board.size,
        rows: board.rows.map((column) => [...column].map((cell) => cell === "X" ? "O" : cell === "O" ? "X" : cell).join("")),
      };
      history = history.map((position) => position.map((column) =>
        [...column].map((cell) => cell === "X" ? "O" : cell === "O" ? "X" : cell).join(""),
      ));
    }
    const seed = prediction?.seedAtTurn(turn) ?? (1_000 + turn * 2) * GO_ENGINE_CYCLE_MS;
    const decision = await decideGoNeural({
      board,
      currentPlayer: "Black",
      opponent: prediction?.opponent ?? "Netburners",
      status: "inProgress",
      previousBoards: [...history],
      komi,
      consecutivePasses,
    }, [seed], engine);
    return decision.action.type === "move" ? [decision.action.x, decision.action.y] : undefined;
  };
}

export interface SimulatedGoGame {
  board: GoBoard;
  turns: number;
  passes: number;
  score: { X: number; O: number };
  /** IPvGO awards a tied score to the player (black). */
  winner: Stone;
  completed: boolean;
}

/** Async counterpart for the neural production policy and the pinned AI
 * oracle used in tests. */
export async function simulateGoGameAsync(
  black: AsyncGoPolicy,
  white: AsyncGoPolicy,
  options: { size: number; komi: number; maxTurns?: number; initialBoard?: GoBoard },
): Promise<SimulatedGoGame> {
  const size = options.size;
  let board: GoBoard = options.initialBoard
    ? { size: options.initialBoard.size, rows: [...options.initialBoard.rows] }
    : { size, rows: Array.from({ length: size }, () => ".".repeat(size)) };
  const history: string[][] = [];
  let consecutivePasses = 0;
  let turns = 0;
  const maxTurns = options.maxTurns ?? size * size * 4;
  while (consecutivePasses < 2 && turns < maxTurns) {
    const colour: Stone = turns % 2 === 0 ? "X" : "O";
    const move = await (colour === "X" ? black : white)({
      board,
      colour,
      history,
      turn: turns,
      consecutivePasses,
      komi: options.komi,
    });
    const played = move ? playMove(board, move[0], move[1], colour, new Set(history.map((b) => b.join("")))) : undefined;
    if (move && !played) throw new Error(`policy returned illegal ${colour} move ${move[0]},${move[1]}`);
    if (played) {
      history.unshift(board.rows);
      board = played.board;
      consecutivePasses = 0;
    } else consecutivePasses++;
    turns++;
  }
  const score = scoreBoard(board, options.komi);
  return {
    board,
    turns,
    passes: consecutivePasses,
    score,
    winner: score.X >= score.O ? "X" : "O",
    completed: consecutivePasses >= 2,
  };
}
