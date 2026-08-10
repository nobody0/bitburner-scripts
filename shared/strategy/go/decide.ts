/** IPvGO decision core.
 *
 * The public board format is column-major: `rows[x][y]`.  Keeping that fact in
 * this module is important because the visual examples look row-major while
 * `go.makeMove(x, y)` and every analysis grid use the former convention.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Go.ts
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardState/boardState.ts */

import {
  predictPreparedOpponentReplies,
  prepareOpponentPosition,
  type PreparedOpponentPosition,
  type WeightedOpponentReply,
} from "./opponent.ts";
import { goDifficultyMultiplier, goStreakMultiplier, nextGoStreak } from "./rewards.ts";

export type Cell = "." | "X" | "O" | "#";
export type Stone = "X" | "O";
export type GoCurrentPlayer = "Black" | "White" | "None";
export type GoStatus = "inProgress" | "waitingOnAI" | "gameOver";
export type GoFactionOpponent =
  | "Netburners"
  | "Slum Snakes"
  | "The Black Hand"
  | "Tetrads"
  | "Daedalus"
  | "Illuminati";
export type GoRewardOpponent = GoFactionOpponent | "????????????";
export type GoOpponent = GoRewardOpponent | "No AI";
export type GoSelectableBoardSize = 5 | 7 | 9 | 13;
export type GoObservedBoardSize = GoSelectableBoardSize | 19;

export const GO_OPPONENTS = [
  "Netburners",
  "Slum Snakes",
  "The Black Hand",
  "Tetrads",
  "Daedalus",
  "Illuminati",
] as const satisfies readonly GoFactionOpponent[];

export const GO_REWARD_OPPONENTS = [...GO_OPPONENTS, "????????????"] as const satisfies readonly GoRewardOpponent[];

export function isGoRewardOpponent(value: GoOpponent): value is GoRewardOpponent {
  return value !== "No AI";
}

export interface GoBoard {
  /** Columns exactly as ns.go.getBoardState returns them. */
  rows: string[];
  size: number;
}

export interface GoMove {
  x: number;
  y: number;
  /** Blended production value used to rank this move. */
  score: number;
  /** Fixed-budget tactical value before the exact reply is blended in. */
  tacticalScore: number;
  /** Mean value after the handcrafted faction replies for the seed window. */
  forecastScore?: number;
  /** Expected seed support. An unseeded defense tie splits one seed's weight. */
  predictedReplies?: GoPredictedReply[];
  /** Why more than one reply may remain after modeling the AI. */
  forecastCertainty?: "exact" | "seed-window" | "unseeded-defense-tie";
  why: string;
  captures: number;
}

export type GoPredictedReply =
  | { x: number; y: number; count: number }
  | { x: null; y: null; count: number };

export interface GoOpponentStat {
  opponent: GoRewardOpponent;
  wins: number;
  losses: number;
  winStreak: number;
  rep: number;
  bonusPercent: number;
}

export interface GoView {
  board: GoBoard;
  currentPlayer: GoCurrentPlayer;
  opponent: GoRewardOpponent;
  status: GoStatus;
  /** Most recent position first. IPvGO uses positional superko, so legality
   * needs the complete history rather than only the immediately prior board. */
  previousBoards: readonly string[][];
  /** Plausible Player.totalPlaytime values when white constructs its WHRNG. */
  aiSeedCandidates?: readonly number[];
  /** A/B-testable blend between worst-case search and modeled faction replies. */
  forecastWeight?: number;
  /** Fresh engine tick on which the controller will dispatch this move. When
   * present, the sole seed is exact and a distinct second-turn seed can be
   * derived for every predicted response branch. */
  alignedDispatchPlaytime?: number;
  bonusCycles?: number;
  komi?: number;
  currentWinStreak?: number;
  nextGame?: { opponent: GoRewardOpponent; boardSize: GoSelectableBoardSize; why: string };
}

export type GoAction =
  | { type: "move"; x: number; y: number; why: string }
  | { type: "pass"; why: string }
  | { type: "resume"; why: string }
  | { type: "newGame"; opponent: GoRewardOpponent; boardSize: GoSelectableBoardSize; why: string };

export interface GoDecision {
  action: GoAction;
  ranked: GoMove[];
  why: string;
  /** Number of fully evaluated tactical finalists. */
  finalists: number;
  /** Static value of the exact input position from black's perspective. */
  positionValue: number;
}

interface PreparedMove {
  x: number;
  y: number;
  played: PlayedMove;
  tacticalScore: number;
  opponent?: PreparedOpponentPosition;
}

export interface GoPreparedDecision {
  view: GoView;
  positionValue: number;
  history: ReadonlySet<string>;
  moves: readonly PreparedMove[];
  immediate?: GoDecision;
}

export interface PlayedMove {
  board: GoBoard;
  captures: number;
}


export function at(board: GoBoard, x: number, y: number): Cell {
  return (board.rows[x]?.[y] ?? "#") as Cell;
}

function other(colour: Stone): Stone {
  return colour === "X" ? "O" : "X";
}

function boardHash(board: GoBoard): string {
  return board.rows.join("");
}

/** Stones and unique liberties in the connected group at (x,y). */
export function group(board: GoBoard, x: number, y: number): { stones: [number, number][]; liberties: number } {
  const colour = at(board, x, y);
  if (colour !== "X" && colour !== "O") return { stones: [], liberties: 0 };
  const seen = new Set<string>();
  const liberties = new Set<string>();
  const stones: [number, number][] = [];
  const stack: [number, number][] = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    const key = `${cx},${cy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stones.push([cx, cy]);
    for (const [nx, ny] of neighbors(cx, cy)) {
      const cell = at(board, nx, ny);
      if (cell === ".") liberties.add(`${nx},${ny}`);
      else if (cell === colour && !seen.has(`${nx},${ny}`)) stack.push([nx, ny]);
    }
  }
  return { stones, liberties: liberties.size };
}

function neighbors(x: number, y: number): [number, number][] {
  return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
}

function write(board: GoBoard, x: number, y: number, cell: Cell): GoBoard {
  const rows = [...board.rows];
  const column = rows[x]!;
  rows[x] = column.slice(0, y) + cell + column.slice(y + 1);
  return { rows, size: board.size };
}

/** Apply the game's capture, suicide and repetition rules. */
// Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardState/boardState.ts
export function playMove(
  board: GoBoard,
  x: number,
  y: number,
  colour: Stone,
  previousHashes: ReadonlySet<string> = new Set(),
): PlayedMove | undefined {
  if (at(board, x, y) !== ".") return undefined;
  let next = write(board, x, y, colour);
  let captures = 0;
  const checked = new Set<string>();
  for (const [nx, ny] of neighbors(x, y)) {
    if (at(next, nx, ny) !== other(colour) || checked.has(`${nx},${ny}`)) continue;
    const enemy = group(next, nx, ny);
    for (const [sx, sy] of enemy.stones) checked.add(`${sx},${sy}`);
    if (enemy.liberties !== 0) continue;
    captures += enemy.stones.length;
    for (const [sx, sy] of enemy.stones) next = write(next, sx, sy, ".");
  }
  if (group(next, x, y).liberties === 0) return undefined;
  if (previousHashes.has(boardHash(next))) return undefined;
  return { board: next, captures };
}

export function legalMoves(
  board: GoBoard,
  colour: Stone = "X",
  previousBoards: readonly string[][] = [],
): [number, number][] {
  const history = new Set(previousBoards.map((prior) => prior.join("")));
  const moves: [number, number][] = [];
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      if (playMove(board, x, y, colour, history)) moves.push([x, y]);
    }
  }
  return moves;
}

export function territory(board: GoBoard): { X: number; O: number } {
  const score = { X: 0, O: 0 };
  const seen = new Set<string>();
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      if (at(board, x, y) !== "." || seen.has(`${x},${y}`)) continue;
      const region: [number, number][] = [];
      const borders = new Set<Cell>();
      const stack: [number, number][] = [[x, y]];
      while (stack.length) {
        const [rx, ry] = stack.pop()!;
        const key = `${rx},${ry}`;
        if (seen.has(key) || at(board, rx, ry) !== ".") continue;
        seen.add(key);
        region.push([rx, ry]);
        for (const [nx, ny] of neighbors(rx, ry)) {
          const cell = at(board, nx, ny);
          if (cell === ".") stack.push([nx, ny]);
          else if (cell === "X" || cell === "O") borders.add(cell);
        }
      }
      // Upstream deliberately does not award an almost-board-sized empty
      // chain. Without this rule, one opening stone owns nearly the board.
      if (region.length <= board.size ** 2 - 3 && borders.size === 1) {
        score[[...borders][0] as Stone] += region.length;
      }
    }
  }
  return score;
}

/** Exact IPvGO area score before opponent-specific komi is applied. */
// Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/scoring.ts
export function scoreBoard(board: GoBoard, komi = 0): { X: number; O: number } {
  const owned = territory(board);
  let black = owned.X;
  let white = owned.O + komi;
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      const cell = at(board, x, y);
      if (cell === "X") black++;
      else if (cell === "O") white++;
    }
  }
  return { X: black, O: white };
}

/** Score from `us`: real stones/territory plus tactical safety and influence. */
export function evaluate(board: GoBoard, us: Stone): number {
  const them = other(us);
  const owned = territory(board);
  let value = owned[us] - owned[them];
  const counted = new Set<string>();
  const centre = (board.size - 1) / 2;
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      const cell = at(board, x, y);
      if (cell !== "X" && cell !== "O") continue;
      const key = `${x},${y}`;
      if (counted.has(key)) continue;
      const chain = group(board, x, y);
      for (const [sx, sy] of chain.stones) counted.add(`${sx},${sy}`);
      // A chain in atari is not merely "one liberty worse": the entire chain
      // disappears on the next capture. Price that exposure proportional to
      // its size so shallow search does not sacrifice a large network for a
      // small influence gain two plies away.
      const stones = chain.liberties === 1
        ? -chain.stones.length
        : chain.stones.length * (chain.liberties === 2 ? 0.8 : 1) + Math.min(chain.liberties, 4) * 0.18;
      value += cell === us ? stones : -stones;
      // On an open tiny board, central influence is useful without dominating
      // captures or actual territory.
      const influence = chain.stones.reduce(
        (sum, [sx, sy]) => sum + Math.max(0, centre - (Math.abs(sx - centre) + Math.abs(sy - centre)) * 0.25),
        0,
      ) * 0.04;
      value += cell === us ? influence : -influence;
    }
  }
  return value;
}

function orderedChildren(board: GoBoard, colour: Stone, history: ReadonlySet<string>, us: Stone) {
  const children: { move: [number, number]; played: PlayedMove; order: number }[] = [];
  const centre = (board.size - 1) / 2;
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      const played = playMove(board, x, y, colour, history);
      if (!played) continue;
      const centrality = board.size - Math.abs(x - centre) - Math.abs(y - centre);
      const adjacent = neighbors(x, y).reduce((score, [nx, ny]) => {
        const cell = at(board, nx, ny);
        if (cell === colour) return score + 3;
        if (cell === other(colour)) return score + 5;
        if (cell === ".") return score + 1;
        return score;
      }, 0);
      children.push({
        move: [x, y],
        played,
        // This ordering is intentionally local. Calling the full-board
        // evaluator for every legal point made an empty 13x13 opening take
        // tens of seconds. Captures and contact dominate; centrality only
        // provides a stable opening tie-break.
        order: played.captures * 1_000 + adjacent * 10 + centrality * 0.02,
      });
    }
  }
  children.sort((a, b) => colour === us ? b.order - a.order : a.order - b.order || a.move[0] - b.move[0] || a.move[1] - b.move[1]);
  return children;
}

function immediateDecision(view: GoView, positionValue: number): GoDecision | undefined {
  const preferredOpponent = view.nextGame?.opponent ?? view.opponent;
  const boardSize = view.nextGame?.boardSize ?? 5;
  if (view.status === "gameOver" || view.currentPlayer === "None") {
    return {
      action: {
        type: "newGame",
        opponent: preferredOpponent,
        boardSize,
        why: view.nextGame?.why ?? "completed subnet; start the highest-value reward",
      },
      ranked: [],
      why: `new ${boardSize}x${boardSize} game against ${preferredOpponent}`,
      finalists: 0,
      positionValue,
    };
  }
  return undefined;
}

/** Seed-independent, fixed-budget half of a Go decision. Every legal move gets
 * a cheap tactical ordering, but only a small finalist set gets a full-board
 * evaluation. This bound is what keeps planning inside one engine tick. */
export function prepareGoDecision(
  view: GoView,
  prepareForecast = Boolean(view.aiSeedCandidates?.length || view.alignedDispatchPlaytime !== undefined),
): GoPreparedDecision {
  const positionValue = evaluate(view.board, "X");
  const immediate = immediateDecision(view, positionValue);
  if (immediate) return { view, positionValue, history: new Set(), moves: [], immediate };
  if (view.currentPlayer !== "Black") {
    const decision: GoDecision = {
      action: { type: "resume", why: "request the pending white move after an interrupted wait" },
      ranked: [],
      why: "resuming opponent turn",
      finalists: 0,
      positionValue,
    };
    return { view, positionValue, history: new Set(), moves: [], immediate: decision };
  }

  const us: Stone = "X";
  const history = new Set((view.previousBoards ?? []).map((board) => board.join("")));
  const forecastHistory = [view.board.rows, ...(view.previousBoards ?? [])];
  const finalistWidth = 4;
  const baseMoves = orderedChildren(view.board, us, history, us)
    .slice(0, finalistWidth)
    .map(({ move: [x, y], played }) => ({
      x,
      y,
      played,
      tacticalScore: evaluate(played.board, us),
    }))
    .sort((a, b) => b.tacticalScore - a.tacticalScore || b.played.captures - a.played.captures || a.x - b.x || a.y - b.y);
  // One exact forecast stays inside the ordinary 5x5 turn budget. It informs
  // the move-versus-pass decision and makes the returned reply immediately
  // actionable; broader alternatives remain simulator work, not live latency.
  const moves = baseMoves.map((move, index) => ({
    ...move,
    ...(prepareForecast && index === 0
      ? { opponent: prepareOpponentPosition(move.played.board, view.opponent, forecastHistory) }
      : {}),
  }));
  return { view, positionValue, history, moves };
}

export function terminalGoRewardValue(board: GoBoard, view: GoView): number {
  const score = scoreBoard(board, view.komi ?? 0);
  const margin = score.X - score.O;
  const won = margin >= 0;
  const next = nextGoStreak(view.currentWinStreak ?? 0, won);
  const power = score.X * goDifficultyMultiplier(view.opponent, board.size)
    * goStreakMultiplier(next.current, next.previous);
  // Winning preserves/builds the streak and is lexicographically more
  // important than a plausible score swing; exact Node Power breaks ties.
  return (won ? 1_000 : -1_000) + margin * 10 + power;
}

function replyBoard(
  board: GoBoard,
  reply: WeightedOpponentReply,
  history: ReadonlySet<string>,
): GoBoard {
  if (!reply.move) return board;
  return playMove(board, reply.move.x, reply.move.y, "O", history)?.board ?? board;
}

/** Cheap seed-dependent half. The exact immediate faction reply is blended
 * into the tactical score. A later turn is planned from its freshly observed
 * board and clock instead of synchronously expanding stale future ticks. */
export function finalizeGoDecision(
  prepared: GoPreparedDecision,
  seedCandidates: readonly number[] = prepared.view.aiSeedCandidates ?? [],
): GoDecision {
  if (prepared.immediate) return prepared.immediate;
  const { view, positionValue } = prepared;
  const us: Stone = "X";
  const ranked = prepared.moves.map((candidate) => {
    const { x, y, played } = candidate;
    let score = candidate.tacticalScore;
    let forecastScore: number | undefined;
    let predictedReplies: GoMove["predictedReplies"];
    let prediction = "";
    let forecastCertainty: GoMove["forecastCertainty"];
    if (seedCandidates.length && candidate.opponent) {
      const forecasts = seedCandidates.map((seed) => predictPreparedOpponentReplies(candidate.opponent!, seed));
      const counts = new Map<string, number>();
      let expected = 0;
      const nextHistory = new Set(prepared.history);
      nextHistory.add(boardHash(view.board));
      for (const forecast of forecasts) {
        for (const white of forecast.replies) {
          const key = white.move ? `${white.move.x},${white.move.y}` : "pass";
          counts.set(key, (counts.get(key) ?? 0) + white.probability);
          expected += white.probability * evaluate(replyBoard(played.board, white, nextHistory), us);
        }
      }
      expected /= forecasts.length;
      forecastScore = expected;
      const defaultWeight = 0.35;
      const forecastWeight = Math.max(0, Math.min(1, view.forecastWeight ?? defaultWeight));
      score = candidate.tacticalScore * (1 - forecastWeight) + expected * forecastWeight;
      const orderedCounts = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      predictedReplies = orderedCounts.map(([key, count]) => {
        if (key === "pass") return { x: null, y: null, count };
        const [px, py] = key.split(",").map(Number);
        if (px === undefined || py === undefined) throw new Error(`invalid forecast coordinate ${key}`);
        return { x: px, y: py, count };
      });
      const modal = orderedCounts[0];
      if (modal) prediction = `; forecast ${modal[0]} with ${modal[1].toFixed(2)}/${forecasts.length} support`;
      const hasTie = forecasts.some((forecast) => forecast.certainty === "unseeded-defense-tie");
      forecastCertainty = hasTie ? "unseeded-defense-tie"
        : forecasts.length > 1 ? "seed-window"
        : "exact";
    }
    return {
      x,
      y,
      score,
      tacticalScore: candidate.tacticalScore,
      ...(forecastScore !== undefined ? { forecastScore } : {}),
      ...(forecastCertainty ? { forecastCertainty } : {}),
      ...(predictedReplies ? { predictedReplies } : {}),
      captures: played.captures,
      why: `fixed-budget tactical shortlist${prediction}`,
    } satisfies GoMove;
  }).sort((a, b) => Number(Boolean(b.predictedReplies)) - Number(Boolean(a.predictedReplies))
    || b.score - a.score || b.captures - a.captures || a.x - b.x || a.y - b.y);

  if (!ranked.length) {
    return { action: { type: "pass", why: "no legal move" }, ranked: [], why: "passing", finalists: 0, positionValue };
  }
  const best = ranked[0]!;
  if (best.score < positionValue - 0.15) {
    return {
      action: { type: "pass", why: "every legal line loses value" },
      ranked: ranked.slice(0, 8),
      why: "preserve settled territory",
      finalists: ranked.length,
      positionValue,
    };
  }
  return {
    action: { type: "move", x: best.x, y: best.y, why: best.why },
    ranked: ranked.slice(0, 8),
    why: `fixed-budget tactical shortlist of ${ranked.length} moves`,
    finalists: ranked.length,
    positionValue,
  };
}

export function stepGo(view: GoView): GoDecision {
  return finalizeGoDecision(prepareGoDecision(view));
}
