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
import { alignedAiSeed, consumeGoWaits, GO_ENGINE_CYCLE_MS } from "./rng.ts";
import { goPolicyMove } from "./policy-book.ts";
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
  /** Simulator A/B override for the bounded 5x5 tactical shortlist. */
  analysisWidth?: number;
  /** Simulator A/B override for candidates receiving exact opponent analysis. */
  forecastWidth?: number;
  /** Simulator A/B override for the connected-chain evaluator bonus. */
  cohesionWeight?: number;
  /** Simulator A/B bonus for continuations already ahead after komi. */
  scoreLeadBonus?: number;
  /** Simulator A/B override for cheap black continuations after white's reply. */
  continuationWidth?: number;
  /** Simulator A/B empty-point threshold for one selective extra forecast. */
  deepForecastThreshold?: number;
  /** Simulator A/B count of black continuations receiving that extra forecast. */
  deepForecastWidth?: number;
  /** Simulator A/B count of root finalists eligible for deeper forecasting. */
  deepRootWidth?: number;
  /** Split a fixed deep-continuation budget across two roots when their
   * static values are within this gap. Undefined keeps fixed-root behavior. */
  deepAdaptiveGap?: number;
  /** Simulator A/B control for the offline-distilled early/midgame policy. */
  policyBook?: boolean;
  /** Simulator/teacher control for opponent-specific bait candidate injection. */
  baitType?: "sacrifice" | "threat";
  /** Fresh engine tick on which the controller will dispatch this move. When
   * present, the sole seed is exact and a distinct second-turn seed can be
   * derived for every predicted response branch. */
  alignedDispatchPlaytime?: number;
  /** Consecutive public passes. A value of one means white just offered to end
   * the game, so black can lock in any current win immediately. */
  consecutivePasses?: number;
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
  candidateKind?: "sacrifice-bait" | "defense-bait";
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

/** Allocation-light group scan for the legality hot path. Encoded stones are
 * `x * size + y`; the public group() keeps its coordinate-friendly shape. */
function fastGroup(board: GoBoard, x: number, y: number): { stones: number[]; liberties: number } {
  const colour = at(board, x, y);
  if (colour !== "X" && colour !== "O") return { stones: [], liberties: 0 };
  const size = board.size;
  const area = size * size;
  const seen = new Uint8Array(area);
  const libertySeen = new Uint8Array(area);
  const stack = new Int16Array(area);
  const stones: number[] = [];
  let liberties = 0;
  let top = 0;
  const start = x * size + y;
  stack[top++] = start;
  seen[start] = 1;
  while (top) {
    const point = stack[--top]!;
    stones.push(point);
    const px = Math.floor(point / size);
    const py = point % size;
    for (let direction = 0; direction < 4; direction++) {
      const nx = px + (direction === 0 ? 1 : direction === 1 ? -1 : 0);
      const ny = py + (direction === 2 ? 1 : direction === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const next = nx * size + ny;
      const cell = board.rows[nx]![ny];
      if (cell === colour && !seen[next]) {
        seen[next] = 1;
        stack[top++] = next;
      } else if (cell === "." && !libertySeen[next]) {
        libertySeen[next] = 1;
        liberties++;
      }
    }
  }
  return { stones, liberties };
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
  const size = board.size;
  const checked = new Uint8Array(size * size);
  for (let direction = 0; direction < 4; direction++) {
    const nx = x + (direction === 0 ? 1 : direction === 1 ? -1 : 0);
    const ny = y + (direction === 2 ? 1 : direction === 3 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    const neighbor = nx * size + ny;
    if (at(next, nx, ny) !== other(colour) || checked[neighbor]) continue;
    const enemy = fastGroup(next, nx, ny);
    for (const point of enemy.stones) checked[point] = 1;
    if (enemy.liberties !== 0) continue;
    captures += enemy.stones.length;
    for (const point of enemy.stones) {
      next = write(next, Math.floor(point / size), point % size, ".");
    }
  }
  if (fastGroup(next, x, y).liberties === 0) return undefined;
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
export function evaluate(
  board: GoBoard,
  us: Stone,
  cohesionWeight = 0.55,
  komi = 0,
  scoreLeadBonus = 0,
): number {
  const them = other(us);
  const size = board.size;
  const area = size * size;
  const indexOf = (x: number, y: number) => x * size + y;
  const emptySeen = new Uint8Array(area);
  const stack = new Int16Array(area);
  let blackTerritory = 0;
  let whiteTerritory = 0;

  // Compute territory without allocating coordinate strings and Sets for
  // every empty region. This is the hottest leaf operation in the bounded
  // search, especially when comparing quiet continuations on a 5x5 board.
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const start = indexOf(x, y);
      if (board.rows[x]![y] !== "." || emptySeen[start]) continue;
      let top = 0;
      let regionSize = 0;
      let borders = 0;
      stack[top++] = start;
      emptySeen[start] = 1;
      while (top) {
        const point = stack[--top]!;
        const px = Math.floor(point / size);
        const py = point % size;
        regionSize++;
        for (let direction = 0; direction < 4; direction++) {
          const nx = px + (direction === 0 ? 1 : direction === 1 ? -1 : 0);
          const ny = py + (direction === 2 ? 1 : direction === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const cell = board.rows[nx]![ny];
          if (cell === "X") borders |= 1;
          else if (cell === "O") borders |= 2;
          else if (cell === ".") {
            const next = indexOf(nx, ny);
            if (!emptySeen[next]) {
              emptySeen[next] = 1;
              stack[top++] = next;
            }
          }
        }
      }
      if (regionSize <= area - 3) {
        if (borders === 1) {
          blackTerritory += regionSize;
        } else if (borders === 2) {
          whiteTerritory += regionSize;
        }
      }
    }
  }

  let value = us === "X"
    ? blackTerritory - whiteTerritory
    : whiteTerritory - blackTerritory;
  const counted = new Uint8Array(area);
  const libertyMark = new Uint16Array(area);
  let groupMark = 0;
  let blackPieces = 0;
  let whitePieces = 0;
  const centre = (board.size - 1) / 2;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const cell = board.rows[x]![y] as Cell;
      if (cell !== "X" && cell !== "O") continue;
      const start = indexOf(x, y);
      if (counted[start]) continue;
      groupMark++;
      let top = 0;
      let stonesInChain = 0;
      let liberties = 0;
      let influenceSum = 0;
      stack[top++] = start;
      counted[start] = 1;
      while (top) {
        const point = stack[--top]!;
        const px = Math.floor(point / size);
        const py = point % size;
        stonesInChain++;
        influenceSum += Math.max(0, centre - (Math.abs(px - centre) + Math.abs(py - centre)) * 0.25);
        for (let direction = 0; direction < 4; direction++) {
          const nx = px + (direction === 0 ? 1 : direction === 1 ? -1 : 0);
          const ny = py + (direction === 2 ? 1 : direction === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const next = indexOf(nx, ny);
          const neighbor = board.rows[nx]![ny];
          if (neighbor === cell && !counted[next]) {
            counted[next] = 1;
            stack[top++] = next;
          } else if (neighbor === "." && libertyMark[next] !== groupMark) {
            libertyMark[next] = groupMark;
            liberties++;
          }
        }
      }
      // A chain in atari is not merely "one liberty worse": the entire chain
      // disappears on the next capture. Price that exposure proportional to
      // its size so shallow search does not sacrifice a large network for a
      // small influence gain two plies away.
      let stones = liberties === 1
        ? -stonesInChain
        : stonesInChain * (liberties === 2 ? 0.8 : 1) + Math.min(liberties, 4) * 0.18;
      // Liberty bonuses are paid once per chain, so without an explicit
      // cohesion term the evaluator preferred several disconnected routers to
      // one equally safe network. That produced diagonal strings which the
      // stronger faction AIs surrounded one stone at a time.
      if (liberties > 1) stones += Math.max(0, stonesInChain - 1) * cohesionWeight;
      if (cell === "X") blackPieces += stonesInChain;
      else whitePieces += stonesInChain;
      value += cell === us ? stones : -stones;
      // On an open tiny board, central influence is useful without dominating
      // captures or actual territory.
      const influence = influenceSum * 0.04;
      value += cell === us ? influence : -influence;
    }
  }
  const blackLeads = blackTerritory + blackPieces >= whiteTerritory + whitePieces + komi;
  if (scoreLeadBonus && (us === "X" ? blackLeads : !blackLeads)) value += scoreLeadBonus;
  return value;
}

function opponentCohesion(opponent: GoRewardOpponent, boardSize: number): number {
  if (boardSize !== 5) return 0.55;
  if (opponent === "Slum Snakes") return 0.25;
  if (opponent === "Illuminati") return 0.4;
  if (opponent === "The Black Hand") return 1.1;
  if (opponent === "Tetrads" || opponent === "Daedalus") return 0.8;
  return 0.55;
}

/** Published p95 planning targets. Work is still node-bounded rather than
 * clock-cutoff-driven, so simulator and live choices remain identical. */
export function goPlanningBudgetMs(boardSize: GoObservedBoardSize): number {
  if (boardSize === 5) return 2;
  if (boardSize === 7) return 3.5;
  if (boardSize === 9) return 5;
  if (boardSize === 13) return 8;
  return 20;
}

/** Deterministic work bounds fitted to the size-scaled planning budget. */
export function goAnalysisWidth(view: Pick<GoView, "board" | "opponent" | "analysisWidth">): number {
  if (view.analysisWidth !== undefined) return Math.max(1, Math.floor(view.analysisWidth));
  if (view.board.size === 5) {
    return view.opponent === "Illuminati" || view.opponent === "Daedalus" ? 5 : 4;
  }
  if (view.board.size === 7) return 20;
  if (view.board.size === 9) return 30;
  if (view.board.size === 13) return 60;
  return 120;
}

export function goForecastWidth(
  view: Pick<GoView, "board" | "opponent" | "forecastWidth">,
): number {
  if (view.forecastWidth !== undefined) return Math.max(0, Math.floor(view.forecastWidth));
  if (view.board.size === 19) return 2;
  if (view.board.size === 13) return 1;
  if (view.board.size === 9) return 2;
  if (view.board.size === 7) return 3;
  if (view.opponent === "Slum Snakes") return 3;
  if (view.opponent === "Illuminati") return 5;
  if (view.opponent === "Daedalus") return 5;
  if (view.opponent === "Netburners") return 4;
  if (view.opponent === "The Black Hand" || view.opponent === "Tetrads") return 4;
  return 3;
}

export function usesExactGoForecast(view: Pick<GoView, "board" | "opponent" | "forecastWidth" | "policyBook">): boolean {
  return goForecastWidth(view) > 0
    || view.opponent === "????????????"
      && (view.policyBook ?? true)
      && goPolicyMove(view.opponent, view.board.rows) !== undefined;
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
        // Contact without a capture is not automatically urgent. The old
        // weight of five caused every 5x5 handicap opening to shortlist only
        // moves touching white, exactly the local fight the stronger AIs are
        // built to win. Captures retain their dominant 1,000-point ordering.
        if (cell === other(colour)) return score + 2;
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
  // The game boots into an untouched 7x7 Netburners board. No move means no
  // score, streak, or favor has been invested, so replace a pristine board
  // when the bottleneck model wants a different game rather than spending
  // minutes finishing an irrelevant default. Once either side has moved, the
  // normal finish-what-we-started rule applies.
  const pristineRetarget = view.nextGame !== undefined
    && view.previousBoards.length === 0
    && (view.opponent !== preferredOpponent || view.board.size !== boardSize);
  if (view.status === "gameOver" || view.currentPlayer === "None" || pristineRetarget) {
    return {
      action: {
        type: "newGame",
        opponent: preferredOpponent,
        boardSize,
        why: pristineRetarget
          ? "untouched subnet has no invested reward; start the highest-value game"
          : view.nextGame?.why ?? "completed subnet; start the highest-value reward",
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
  const cohesion = view.cohesionWeight ?? opponentCohesion(view.opponent, view.board.size);
  const positionValue = evaluate(view.board, "X", cohesion);
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
  if ((view.consecutivePasses ?? 0) > 0) {
    const score = scoreBoard(view.board, view.komi ?? 0);
    if (score.X >= score.O) {
      const decision: GoDecision = {
        action: { type: "pass", why: `accept white's pass and win ${score.X}-${score.O}` },
        ranked: [],
        why: "end a won game",
        finalists: 0,
        positionValue,
      };
      return { view, positionValue, history: new Set(), moves: [], immediate: decision };
    }
  }

  const us: Stone = "X";
  const history = new Set((view.previousBoards ?? []).map((board) => board.join("")));
  const forecastHistory = [view.board.rows, ...(view.previousBoards ?? [])];
  const finalistWidth = goAnalysisWidth(view);
  const forecastWidth = goForecastWidth(view);
  const policyAction = (view.policyBook ?? true)
    && (view.board.size === 5 || view.opponent === "????????????" && view.board.size === 19)
    ? goPolicyMove(view.opponent, view.board.rows)
    : undefined;
  const ordered = orderedChildren(view.board, us, history, us);
  // A 5x5 board has at most 25 legal points, so its complete static evaluation
  // is cheap and prevents the local contact ordering from deleting a vital
  // quiet move before the exact opponent model sees it. Larger boards retain
  // the strict local prefilter.
  const widenQuietMoves = view.board.size === 5;
  const scoredMoves = (widenQuietMoves ? ordered : ordered.slice(0, finalistWidth))
    .map(({ move: [x, y], played }) => ({
      x,
      y,
      played,
      tacticalScore: evaluate(played.board, us, cohesion),
    }))
    .sort((a, b) => b.tacticalScore - a.tacticalScore || b.played.captures - a.played.captures || a.x - b.x || a.y - b.y);
  let candidateMoves = scoredMoves;
  if (view.baitType) {
    const bait = scoredMoves.find((move) => {
      if (move.played.captures > 0) return false;
      if (view.baitType === "sacrifice") {
        const placed = fastGroup(move.played.board, move.x, move.y);
        return placed.stones.length <= 2 && placed.liberties === 1;
      }
      const checked = new Uint8Array(view.board.size * view.board.size);
      for (const [nx, ny] of neighbors(move.x, move.y)) {
        if (at(move.played.board, nx, ny) !== "O") continue;
        const index = nx * view.board.size + ny;
        if (checked[index]) continue;
        const enemy = fastGroup(move.played.board, nx, ny);
        for (const point of enemy.stones) checked[point] = 1;
        if (enemy.liberties === 1) return true;
      }
      return false;
    });
    if (bait && bait !== scoredMoves[0]) {
      const tagged = {
        ...bait,
        candidateKind: view.baitType === "sacrifice" ? "sacrifice-bait" as const : "defense-bait" as const,
      };
      candidateMoves = [scoredMoves[0]!, tagged, ...scoredMoves.slice(1).filter((move) => move !== bait)];
    }
  }
  let baseMoves = candidateMoves.slice(0, finalistWidth);
  if (policyAction) {
    const policyIndex = baseMoves.findIndex((move) => move.x === policyAction[0] && move.y === policyAction[1]);
    if (policyIndex > 0) {
      baseMoves = [baseMoves[policyIndex]!, ...baseMoves.slice(0, policyIndex), ...baseMoves.slice(policyIndex + 1)];
    }
  }
  const effectiveForecastWidth = forecastWidth || Number(
    view.opponent === "????????????" && policyAction !== undefined,
  );
  // Prepare the opponent's option space for every finalist. Forecasting only
  // the first candidate made prediction explanatory rather than selective:
  // the sole forecasted move was then sorted ahead of every alternative.
  const moves = baseMoves.map((move, index) => ({
    ...move,
    ...(prepareForecast && index < effectiveForecastWidth
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

export interface GoEndgameSolution {
  action: { type: "move"; x: number; y: number } | { type: "pass" };
  value: number;
  nodes: number;
}

interface GoEndgameState {
  board: GoBoard;
  history: readonly string[][];
  passes: number;
  dispatchPlaytime: number;
  bonusCycles: number;
}

interface GoEndgameResult {
  value: number;
  exact: boolean;
  action?: GoEndgameSolution["action"];
}

function nextEndgameDispatch(
  dispatchPlaytime: number,
  bonusCycles: number,
  wait: WeightedOpponentReply["wait"],
): { dispatchPlaytime: number; bonusCycles: number } {
  const initial = consumeGoWaits(bonusCycles, 1);
  const remainder = consumeGoWaits(initial.bonusCycles, wait.cycleWaitsAfterSeed);
  const wallMs = initial.wallMs + remainder.wallMs + wait.fixedSleepMsAfterSeed;
  return {
    dispatchPlaytime: dispatchPlaytime + Math.floor(wallMs / GO_ENGINE_CYCLE_MS) * GO_ENGINE_CYCLE_MS,
    bonusCycles: remainder.bonusCycles,
  };
}

/** Exact-to-terminal search against the modeled faction policy. This is
 * deliberately available only as a small-endgame primitive: callers discard
 * the result unless every branch completed below the deterministic node cap. */
export function solveGoEndgame(
  view: Pick<GoView, "board" | "previousBoards" | "opponent" | "komi" | "currentWinStreak" | "consecutivePasses">,
  dispatchPlaytime: number,
  bonusCycles = 0,
  nodeLimit = 2_048,
): GoEndgameSolution | undefined {
  // The second daemon seed depends on random sleep timing. Only the immediate
  // reply is reliable; daemon labels come from complete upstream rollouts in
  // go-book-train rather than this multi-turn clean-room solver.
  if (view.opponent === "????????????") return undefined;
  const budget = { used: 0, limit: Math.max(1, Math.floor(nodeLimit)) };
  const memo = new Map<string, GoEndgameResult>();
  const terminal = (board: GoBoard) => terminalGoRewardValue(board, view as GoView);

  const search = (state: GoEndgameState): GoEndgameResult => {
    if (state.passes >= 2) return { value: terminal(state.board), exact: true };
    if (++budget.used > budget.limit) return { value: evaluate(state.board, "X"), exact: false };
    const seedPhase = ((state.dispatchPlaytime % 30_000_000) + 30_000_000) % 30_000_000;
    const key = `${boardHash(state.board)}|${state.history.map((board) => board.join("")).join("/")}|${state.passes}|${seedPhase}|${state.bonusCycles}`;
    const cached = memo.get(key);
    if (cached) return cached;

    const historyHashes = new Set(state.history.map((board) => board.join("")));
    const moves = orderedChildren(state.board, "X", historyHashes, "X")
      .sort((a, b) => b.played.captures - a.played.captures || b.order - a.order);
    const actions: ({ action: GoEndgameSolution["action"]; board: GoBoard; history: readonly string[][]; passes: number })[] = [
      ...moves.map(({ move: [x, y], played }) => ({
        action: { type: "move" as const, x, y },
        board: played.board,
        history: [state.board.rows, ...state.history],
        passes: 0,
      })),
      { action: { type: "pass" as const }, board: state.board, history: state.history, passes: state.passes + 1 },
    ];

    let bestValue = -Infinity;
    let bestAction: GoEndgameSolution["action"] | undefined;
    let exact = true;
    for (const candidate of actions) {
      let candidateValue: number;
      let candidateExact = true;
      if (candidate.passes >= 2) {
        candidateValue = terminal(candidate.board);
      } else {
        const prepared = prepareOpponentPosition(
          candidate.board,
          view.opponent,
          candidate.history,
          candidate.passes,
        );
        const forecast = predictPreparedOpponentReplies(
          prepared,
          alignedAiSeed(state.dispatchPlaytime, state.bonusCycles),
        );
        candidateValue = 0;
        for (const white of forecast.replies) {
          let afterWhite = candidate.board;
          let afterHistory = candidate.history;
          let afterPasses = candidate.passes + 1;
          if (white.move) {
            const played = playMove(candidate.board, white.move.x, white.move.y, "O", new Set(
              candidate.history.map((board) => board.join("")),
            ));
            if (!played) {
              candidateExact = false;
              continue;
            }
            afterWhite = played.board;
            afterHistory = [candidate.board.rows, ...candidate.history];
            afterPasses = 0;
          }
          const timing = nextEndgameDispatch(
            state.dispatchPlaytime,
            state.bonusCycles,
            white.wait,
          );
          const child = afterPasses >= 2
            ? { value: terminal(afterWhite), exact: true }
            : search({
              board: afterWhite,
              history: afterHistory,
              passes: afterPasses,
              dispatchPlaytime: timing.dispatchPlaytime,
              bonusCycles: timing.bonusCycles,
            });
          candidateValue += white.probability * child.value;
          candidateExact &&= child.exact;
        }
      }
      exact &&= candidateExact;
      if (candidateValue > bestValue) {
        bestValue = candidateValue;
        bestAction = candidate.action;
      }
    }
    const result = { value: bestValue, exact, ...(bestAction ? { action: bestAction } : {}) };
    memo.set(key, result);
    return result;
  };

  const result = search({
    board: view.board,
    history: view.previousBoards,
    passes: view.consecutivePasses ?? 0,
    dispatchPlaytime,
    bonusCycles,
  });
  return result.exact && result.action
    ? { action: result.action, value: result.value, nodes: budget.used }
    : undefined;
}

/** One cheap initiative ply after the exact white reply. Evaluating directly
 * on white's turn systematically undervalues moves whose payoff is a forced
 * connection or capture on black's next action. The width remains fixed and
 * uses no opponent analysis, keeping this much cheaper than another forecast. */
function continuationValue(
  board: GoBoard,
  history: ReadonlySet<string>,
  cohesion: number,
  width: number,
  komi: number,
  scoreLeadBonus: number,
): number {
  const replies = board.size === 19
    ? boundedLargeBoardContinuations(board, history, width)
    : orderedChildren(board, "X", history, "X").slice(0, width);
  const value = (position: GoBoard) => evaluate(position, "X", cohesion, komi, scoreLeadBonus);
  let best = value(board);
  for (const reply of replies) best = Math.max(best, value(reply.played.board));
  return best;
}

/** The exact opponent reply leaves roughly two hundred legal black points on
 * the BitVerse board. Generating all resulting boards merely to retain four is
 * the dominant 19x19 tail cost. Prefilter by the same local order used by the
 * full search, while retaining contact moves which may capture; only this
 * bounded set pays full capture, suicide, superko, and evaluation work. */
function boundedLargeBoardContinuations(
  board: GoBoard,
  history: ReadonlySet<string>,
  width: number,
): { move: [number, number]; played: PlayedMove; order: number }[] {
  const centre = (board.size - 1) / 2;
  const candidates: { move: [number, number]; order: number; contact: boolean }[] = [];
  for (let x = 0; x < board.size; x++) for (let y = 0; y < board.size; y++) {
    if (at(board, x, y) !== ".") continue;
    const centrality = board.size - Math.abs(x - centre) - Math.abs(y - centre);
    let adjacent = 0;
    let contact = false;
    for (const [nx, ny] of neighbors(x, y)) {
      const cell = at(board, nx, ny);
      if (cell === "X") adjacent += 3;
      else if (cell === "O") {
        adjacent += 2;
        contact = true;
      } else if (cell === ".") adjacent++;
    }
    candidates.push({ move: [x, y], order: adjacent * 10 + centrality * 0.02, contact });
  }
  candidates.sort((a, b) => b.order - a.order || a.move[0] - b.move[0] || a.move[1] - b.move[1]);
  const selected = new Map<number, typeof candidates[number]>();
  for (const candidate of candidates.slice(0, Math.max(16, width * 4))) {
    selected.set(candidate.move[0] * board.size + candidate.move[1], candidate);
  }
  let contacts = 0;
  for (const candidate of candidates) {
    if (!candidate.contact) continue;
    selected.set(candidate.move[0] * board.size + candidate.move[1], candidate);
    if (++contacts >= 16) break;
  }
  return [...selected.values()].flatMap((candidate) => {
    const played = playMove(board, candidate.move[0], candidate.move[1], "X", history);
    return played ? [{ ...candidate, played, order: played.captures * 1_000 + candidate.order }] : [];
  }).sort((a, b) => b.order - a.order || a.move[0] - b.move[0] || a.move[1] - b.move[1])
    .slice(0, width);
}

function deepContinuationValue(
  board: GoBoard,
  historyRows: readonly string[][],
  firstWhite: WeightedOpponentReply,
  view: GoView,
  cohesion: number,
  continuationWidth: number,
  deepWidth: number,
  scoreLeadBonus: number,
): number {
  const history = new Set(historyRows.map((position) => position.join("")));
  const value = (position: GoBoard) => evaluate(
    position,
    "X",
    cohesion,
    view.komi ?? 0,
    scoreLeadBonus,
  );
  const continuations = orderedChildren(board, "X", history, "X")
    .slice(0, continuationWidth)
    .map((candidate) => ({ ...candidate, value: value(candidate.played.board) }))
    .sort((a, b) => b.value - a.value || b.played.captures - a.played.captures)
    .slice(0, deepWidth);
  let best = value(board);
  if (view.alignedDispatchPlaytime === undefined) return best;
  const timing = nextEndgameDispatch(
    view.alignedDispatchPlaytime,
    view.bonusCycles ?? 0,
    firstWhite.wait,
  );
  for (const continuation of continuations) {
    const forecastHistory = [board.rows, ...historyRows];
    const prepared = prepareOpponentPosition(
      continuation.played.board,
      view.opponent,
      forecastHistory,
    );
    const forecast = predictPreparedOpponentReplies(
      prepared,
      alignedAiSeed(timing.dispatchPlaytime, timing.bonusCycles),
    );
    let expected = 0;
    for (const secondWhite of forecast.replies) {
      const afterSecondWhite = replyBoard(
        continuation.played.board,
        secondWhite,
        new Set(forecastHistory.map((position) => position.join(""))),
      );
      const finalHistory = new Set(forecastHistory.map((position) => position.join("")));
      if (secondWhite.move) finalHistory.add(boardHash(continuation.played.board));
      expected += secondWhite.probability * continuationValue(
        afterSecondWhite,
        finalHistory,
        cohesion,
        Math.min(4, continuationWidth),
        view.komi ?? 0,
        scoreLeadBonus,
      );
    }
    best = Math.max(best, expected);
  }
  return best;
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
  const cohesion = view.cohesionWeight ?? opponentCohesion(view.opponent, view.board.size);
  const defaultContinuationWidth = view.board.size === 5
    ? view.opponent === "Illuminati" ? 14
      : view.opponent === "Tetrads" ? 12
      : view.opponent === "Netburners" ? 8
      : 4
    : view.board.size === 19 ? 2 : 4;
  const continuationWidth = Math.max(1, Math.floor(view.continuationWidth ?? defaultContinuationWidth));
  // On the tiny high-komi board, crossing from 7.5 points behind to a real
  // lead is strategically discontinuous: preserving a win matters more than
  // adding the same number of heuristic liberties while still losing.
  const scoreLeadBonus = view.scoreLeadBonus ?? (view.opponent === "Illuminati" ? 8 : 0);
  const illuminatiTiny = view.opponent === "Illuminati" && view.board.size === 5;
  const deepForecastThreshold = Math.max(0, Math.floor(
    view.deepForecastThreshold ?? (illuminatiTiny ? 12 : 0),
  ));
  const deepForecastWidth = Math.max(0, Math.floor(
    view.deepForecastWidth ?? (illuminatiTiny ? 2 : 0),
  ));
  const deepRootWidth = Math.max(0, Math.floor(
    view.deepRootWidth ?? (illuminatiTiny ? 1 : prepared.moves.length),
  ));
  const adaptiveGap = view.deepAdaptiveGap ?? (illuminatiTiny ? 0.05 : undefined);
  const adaptiveDeepening = adaptiveGap !== undefined
    && prepared.moves.length > 1
    && prepared.moves[0]!.tacticalScore - prepared.moves[1]!.tacticalScore <= Math.max(0, adaptiveGap);
  const ranked = prepared.moves.map((candidate, candidateIndex) => {
    const candidateDeepWidth = adaptiveDeepening
      ? candidateIndex < 2 ? Math.max(1, Math.floor(deepForecastWidth / 2)) : 0
      : candidateIndex < deepRootWidth ? deepForecastWidth : 0;
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
      for (let forecastIndex = 0; forecastIndex < forecasts.length; forecastIndex++) {
        const forecast = forecasts[forecastIndex]!;
        for (const white of forecast.replies) {
          const key = white.move ? `${white.move.x},${white.move.y}` : "pass";
          counts.set(key, (counts.get(key) ?? 0) + white.probability);
          const afterWhite = replyBoard(played.board, white, nextHistory);
          const continuationHistory = new Set(nextHistory);
          if (white.move) continuationHistory.add(boardHash(played.board));
          let leaf: number | undefined;
          if (
            candidateDeepWidth > 0
            && seedCandidates.length === 1
            && view.alignedDispatchPlaytime !== undefined
          ) {
            let emptyPoints = 0;
            for (const column of afterWhite.rows) for (let point = 0; point < column.length; point++) {
              if (column[point] === ".") emptyPoints++;
            }
            if (emptyPoints <= deepForecastThreshold) {
              const afterWhiteHistory = white.move
                ? [played.board.rows, view.board.rows, ...view.previousBoards]
                : [view.board.rows, ...view.previousBoards];
              leaf = deepContinuationValue(
                afterWhite,
                afterWhiteHistory,
                white,
                view,
                cohesion,
                continuationWidth,
                candidateDeepWidth,
                scoreLeadBonus,
              );
            }
          }
          leaf ??= continuationValue(
            afterWhite,
            continuationHistory,
            cohesion,
            continuationWidth,
            view.komi ?? 0,
            scoreLeadBonus,
          );
          expected += white.probability * leaf;
        }
      }
      expected /= forecasts.length;
      forecastScore = expected;
      // Exact reply information is blended with the shape value before white
      // moves. The latter contains initiative/influence information that a
      // shallow two-ply leaf cannot recover on its own.
      const defaultWeight = view.opponent === "Netburners" ? 0.5
        : view.opponent === "Slum Snakes" ? 0.5
        : view.opponent === "The Black Hand" ? 1
        : view.opponent === "Tetrads" ? 0.7
        : view.opponent === "Daedalus" ? 0.8
        : view.opponent === "Illuminati" ? 1
        : 0.35;
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
      why: `${candidate.candidateKind ?? "fixed-budget tactical shortlist"}${prediction}`,
    } satisfies GoMove;
  }).sort((a, b) => Number(Boolean(b.predictedReplies)) - Number(Boolean(a.predictedReplies))
    || b.score - a.score || b.captures - a.captures || a.x - b.x || a.y - b.y);

  const bookAction = (view.board.size === 5 || view.opponent === "????????????" && view.board.size === 19)
    && (view.policyBook ?? true)
    ? goPolicyMove(view.opponent, view.board.rows)
    : undefined;
  if (bookAction) {
    // Board-only keys deliberately omit private state and history. Applying a
    // stored action only when it remains in the freshly legal, exactly
    // forecasted shortlist makes every miss or superko disagreement safe.
    const bookIndex = ranked.findIndex((move) =>
      move.x === bookAction[0]
      && move.y === bookAction[1]
      && (view.opponent !== "????????????" || move.predictedReplies !== undefined)
    );
    if (bookIndex >= 0) {
      const bookMove = ranked[bookIndex]!;
      const bookRanked = [bookMove, ...ranked.slice(0, bookIndex), ...ranked.slice(bookIndex + 1)];
      return {
        action: { type: "move", x: bookMove.x, y: bookMove.y, why: "offline teacher policy" },
        ranked: bookRanked.slice(0, 8),
        why: "offline teacher policy with exact reply forecast",
        finalists: ranked.length,
        positionValue,
      };
    }
  }

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
