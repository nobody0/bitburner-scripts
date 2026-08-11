import {
  evaluate,
  legalMoves,
  playMove,
  scoreBoard,
  stepGo,
  type GoBoard,
  type GoRewardOpponent,
  type Stone,
} from "../../shared/strategy/go/decide.ts";
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

export const greedyPolicy: GoPolicy = ({ board, colour, history }) => {
  const hashes = new Set(history.map((prior) => prior.join("")));
  return legalMoves(board, colour, history)
    .map((move) => ({ move, played: playMove(board, move[0], move[1], colour, hashes)! }))
    .sort((a, b) =>
      evaluate(b.played.board, colour) - evaluate(a.played.board, colour) ||
      b.played.captures - a.played.captures ||
      a.move[0] - b.move[0] || a.move[1] - b.move[1]
    )[0]?.move;
};

/** The production strategy currently plays black. This adapter lets the
 * simulator run it against transparent, synthetic baselines. */
export function productionPolicy(
  prediction?: { opponent: GoRewardOpponent; seedAtTurn(turn: number): number; forecastWeight?: number },
): GoPolicy {
  return ({ board, colour, history, turn, komi, consecutivePasses }) => {
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
    const decision = stepGo({
      board,
      currentPlayer: "Black",
      opponent: prediction?.opponent ?? "Netburners",
      status: "inProgress",
      previousBoards: [...history],
      komi,
      consecutivePasses,
      ...(prediction ? { aiSeedCandidates: [prediction.seedAtTurn(turn)] } : {}),
      ...(prediction?.forecastWeight !== undefined ? { forecastWeight: prediction.forecastWeight } : {}),
    });
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

/** Complete deterministic rules simulation. Policies see public board/history
 * plus only any forecast seed deliberately supplied by the test harness. */
export function simulateGoGame(
  black: GoPolicy,
  white: GoPolicy,
  options: { size: number; komi: number; maxTurns?: number; initialBoard?: GoBoard },
): SimulatedGoGame {
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
    const move = (colour === "X" ? black : white)({
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
      // The game stores positions only when a router is placed; passes are not
      // part of the positional-superko history.
      history.unshift(board.rows);
      board = played.board;
      consecutivePasses = 0;
    } else {
      consecutivePasses++;
    }
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

/** Async counterpart for policies backed by the pinned AI oracle in tests. */
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

export interface GoTournamentResult {
  games: number;
  completed: number;
  wins: number;
  losses: number;
  /** Candidate's area points minus its opponents' points. */
  pointDifference: number;
}

/** Color-balanced comparison against named, transparent policies. A capped
 * game contributes its measured score but is not reported as completed. */
export function simulateTournament(
  candidate: GoPolicy,
  opponents: readonly GoPolicy[],
  options: { size: number; komi: number; maxTurns?: number },
): GoTournamentResult {
  const result: GoTournamentResult = { games: 0, completed: 0, wins: 0, losses: 0, pointDifference: 0 };
  for (const opponent of opponents) {
    for (const candidateColour of ["X", "O"] as const) {
      const game = candidateColour === "X"
        ? simulateGoGame(candidate, opponent, options)
        : simulateGoGame(opponent, candidate, options);
      const candidateScore = game.score[candidateColour];
      const opponentScore = game.score[candidateColour === "X" ? "O" : "X"];
      result.games++;
      if (game.completed) result.completed++;
      result.pointDifference += candidateScore - opponentScore;
      if (game.winner === candidateColour) result.wins++;
      else result.losses++;
    }
  }
  return result;
}
