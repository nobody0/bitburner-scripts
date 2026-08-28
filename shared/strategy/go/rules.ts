/** IPvGO board representation, exact rules primitives, and the shared decision
 * types produced by the neural engine.
 *
 * The public board format is column-major: `rows[x][y]`.  Keeping that fact in
 * this module is important because the visual examples look row-major while
 * `go.makeMove(x, y)` and every analysis grid use the former convention.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Go.ts
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardState/boardState.ts */

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

/** The player multiplier fields each opponent's Node Power bonus actually
 * lifts. v3.0.1 game data, and the ONLY description of what a Go reward does
 * that anything is allowed to price against: the API's `bonusDescription`
 * string is for humans, and a bespoke reward-to-bottleneck map is how the
 * selector came to value hacknet production as if it were the whole economy.
 * Fields resolve through `shared/strategy/multipliers.ts`, the same table the
 * augmentation scorer prices with. */
// Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/effects/effect.ts
export const GO_EFFECT_FIELDS: Readonly<Record<GoRewardOpponent, readonly string[]>> = {
  Netburners: ["hacknet_node_money"],
  "Slum Snakes": ["crime_success"],
  "The Black Hand": ["hacking_money"],
  Tetrads: ["strength", "defense", "dexterity", "agility"],
  Daedalus: ["company_rep", "faction_rep"],
  Illuminati: ["hacking_speed"],
  "????????????": ["hacking"],
};

export function isGoRewardOpponent(value: GoOpponent): value is GoRewardOpponent {
  return value !== "No AI";
}

/** The board size resetBoardState actually produces: the secret opponent
 * ignores the requested size and always plays the fixed 19x19 BitVerse. */
export function goObservedBoardSizeFor(
  opponent: GoRewardOpponent,
  requestedSize: GoSelectableBoardSize,
): GoObservedBoardSize {
  return opponent === "????????????" ? 19 : requestedSize;
}

export interface GoBoard {
  /** Columns exactly as ns.go.getBoardState returns them. */
  rows: string[];
  size: number;
}

export interface GoMove {
  x: number;
  y: number;
  /** Expected win probability across the modeled faction replies. This is the
   * primary selection key and doubles as the display score. */
  score: number;
  /** Expected loss-penalized terminal Power per total round; the tie-break. */
  powerPerRound: number;
  /** Every reply possible for the targeted seeds, with multiplicity. */
  predictedReplies?: GoPredictedReply[];
  /** Why more than one reply may remain after modeling the AI. */
  forecastCertainty?: "exact" | "seed-window" | "unseeded-defense-tie";
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
  /** Cap on candidates that proceed from the all-legal V9 proposal to exact
   * reply forecasting and post-response value inference. Production defaults
   * to eight; this override exists only for simulator quality/latency audits. */
  candidateLimit?: number;
  /** Consecutive public passes. A value of one means white just offered to end
   * the game, so black can lock in any current win immediately. */
  consecutivePasses?: number;
  komi?: number;
  /** Offline cycles determine whether White seeds its reply in the dispatch
   * tick or the following 200 ms engine tick. The worker owns that derivation
   * once this public value has been hydrated. */
  bonusCycles?: number;
  /** Present only when the main thread has proved that go.cheat is available
   * and hydrated the current game's attempt count. Chance entries are read
   * from the API up front so the Web Worker never needs Netscript access. */
  cheat?: GoCheatState;
  nextGame?: { opponent: GoRewardOpponent; boardSize: GoSelectableBoardSize };
}

export interface GoCheatState {
  unlocked: boolean;
  count: number;
  successByCount: readonly number[];
  /** Per-family exact-reply finalist budget. */
  candidateLimit: number;
  /** Number of first placements whose best continuation becomes a double-move
   * finalist. A pass ranked first suppresses the double-move family. */
  doubleMoveLimit: number;
}

/** Production cheat budgets per board size, shared by the live driver and the
 * arenas so their defaults cannot drift.
 *
 * Boards above 5x5 route to the policy-only daemon19 weights, whose value
 * head is stripped from the installed artifact: any candidateLimit > 0 needs
 * a value batch and the engine refuses it outright, so the greedy
 * doubles-only path (candidateLimit 0) is the ONLY cheat path those sizes
 * can execute — the topology-mutating single-point families are unreachable
 * there by construction. Live play only ever schedules 5x5 (the six faction
 * opponents) and 19x19 (the world daemon); 7/9/13 are listed defensively so
 * an experimental game cannot crash on an unevaluable budget.
 *
 * Policy changes belong here as one-line edits and must be justified by a
 * recorded arena run. */
export const GO_CHEAT_LIMITS_BY_SIZE: Readonly<Record<number, {
  candidateLimit: number;
  doubleMoveLimit: number;
}>> = {
  5: { candidateLimit: 4, doubleMoveLimit: 2 },
  7: { candidateLimit: 0, doubleMoveLimit: 1 },
  9: { candidateLimit: 0, doubleMoveLimit: 1 },
  13: { candidateLimit: 0, doubleMoveLimit: 1 },
  19: { candidateLimit: 0, doubleMoveLimit: 1 },
};

export type GoCheatAction =
  | { type: "cheatTwoMoves"; x1: number; y1: number; x2: number; y2: number }
  | { type: "cheatRemoveRouter"; x: number; y: number }
  | { type: "cheatDestroyNode"; x: number; y: number }
  | { type: "cheatRepairNode"; x: number; y: number };

export type GoPlayingAction =
  | { type: "move"; x: number; y: number }
  | { type: "pass" }
  | GoCheatAction;

export type GoAction =
  | GoPlayingAction
  | { type: "resume" }
  | { type: "newGame"; opponent: GoRewardOpponent; boardSize: GoSelectableBoardSize };

export function isGoCheatAction(action: GoAction): action is GoCheatAction {
  return action.type === "cheatTwoMoves"
    || action.type === "cheatRemoveRouter"
    || action.type === "cheatDestroyNode"
    || action.type === "cheatRepairNode";
}

export interface GoDecision {
  action: GoAction;
  ranked: GoMove[];
  /** Number of fully evaluated candidates, including the pass option. */
  finalists: number;
  /** Predicted win probability of the exact input position as it stands. */
  positionValue: number;
  /** Reply forecast for the chosen action; present even when it is a pass,
   * which never appears in the move-only ranking. */
  forecast?: GoPredictedReply[];
  /** Aggregated win probability of the selected action after the opponent's
   * predicted reply. Absent on the policy-only contract, whose value head is
   * neutral by construction and carries no such signal. */
  predictedWin?: number;
  /** Engine cycles this decision must be delayed by. Non-zero only when every
   * candidate was predicted to lose at the requested tick and waiting reached
   * a seed where one wins; the caller must dispatch in that later tick or the
   * decision does not describe the game it will be played in. */
  dispatchOffsetMs?: number;
  /** Set when a losing move was swapped for a game-ending pass to bank the
   * standing score. Only ever set while White's pass is on the table, so the
   * swap ends the game immediately rather than conceding a free move. */
  passReason?: "banking-lost-position";
  /** Present only when the evaluation was asked to seed the double-move cheat
   * family from a certified first stone: true when that move was found among
   * the legal candidates (seeded double offered, plain certified move
   * force-retained as a value-batch finalist), false when it had to be
   * dropped — in which case no returned cheat ever competed against the
   * certified continuation and callers must not let it override one. */
  preferredFirstMoveRetained?: boolean;
}

interface PlayedMove {
  board: GoBoard;
  captures: number;
}

export interface GoCheatTransition {
  board: GoBoard;
  captures: number;
}

export function at(board: GoBoard, x: number, y: number): Cell {
  return (board.rows[x]?.[y] ?? "#") as Cell;
}

function other(colour: Stone): Stone {
  return colour === "X" ? "O" : "X";
}

export function boardHash(board: GoBoard): string {
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

export function neighbors(x: number, y: number): [number, number][] {
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

/** Resolve captures exactly like updateCaptures(): remove every captured
 * enemy chain, or captured friendly chains only when no enemy chain was
 * removed. Cheat actions mutate the board first and invoke this once. */
function resolveCheatCaptures(board: GoBoard, colour: Stone): GoCheatTransition {
  const enemy = other(colour);
  const enemyBefore = board.rows.reduce((sum, column) =>
    sum + [...column].filter((cell) => cell === enemy).length, 0);
  const captured = (target: Stone): number[] => {
    const seen = new Uint8Array(board.size * board.size);
    const result: number[] = [];
    for (let x = 0; x < board.size; x++) for (let y = 0; y < board.size; y++) {
      const point = x * board.size + y;
      if (seen[point] || at(board, x, y) !== target) continue;
      const found = fastGroup(board, x, y);
      for (const stone of found.stones) seen[stone] = 1;
      if (found.liberties === 0) result.push(...found.stones);
    }
    return result;
  };
  const capturedEnemy = captured(enemy);
  const removed = capturedEnemy.length ? capturedEnemy : captured(colour);
  let next = board;
  for (const point of removed) next = write(next, Math.floor(point / board.size), point % board.size, ".");
  const enemyAfter = next.rows.reduce((sum, column) =>
    sum + [...column].filter((cell) => cell === enemy).length, 0);
  return { board: next, captures: Math.max(0, enemyBefore - enemyAfter) };
}

/** First half of playTwoMoves. This deliberately performs no legality,
 * capture, suicide or repetition processing. */
export function placeCheatRouterRaw(board: GoBoard, x: number, y: number): GoBoard | undefined {
  return at(board, x, y) === "." ? write(board, x, y, "X") : undefined;
}

/** Apply any successful go.cheat action. Unlike an ordinary move, upstream
 * does not add the pre-cheat board to previousBoards. */
export function applyGoCheat(board: GoBoard, action: GoCheatAction): GoCheatTransition | undefined {
  if (action.type === "cheatTwoMoves") {
    const first = placeCheatRouterRaw(board, action.x1, action.y1);
    if (!first) return undefined;
    // Upstream validates both coordinates against the original board and even
    // permits identical points; assigning the same point twice is a one-router
    // cheat. Production generation uses distinct points.
    const second = action.x1 === action.x2 && action.y1 === action.y2
      ? first
      : placeCheatRouterRaw(first, action.x2, action.y2);
    return second ? resolveCheatCaptures(second, "X") : undefined;
  }
  if (action.type === "cheatRemoveRouter") {
    if (at(board, action.x, action.y) !== "O") return undefined;
    return resolveCheatCaptures(write(board, action.x, action.y, "."), "X");
  }
  if (action.type === "cheatDestroyNode") {
    if (at(board, action.x, action.y) !== ".") return undefined;
    return resolveCheatCaptures(write(board, action.x, action.y, "#"), "X");
  }
  if (at(board, action.x, action.y) !== "#") return undefined;
  return resolveCheatCaptures(write(board, action.x, action.y, "."), "X");
}

/** Exact legal-placement indices with one group analysis per stone group.
 * Most empty points are then O(1); only captures need to materialize a board
 * to check positional superko. This matters when V9 asks for a legal plane on
 * hundreds of post-response candidates. */
export function legalMoveIndices(
  board: GoBoard,
  colour: Stone = "X",
  previousHashes: ReadonlySet<string> = new Set(),
): number[] {
  const size = board.size;
  const area = size * size;
  const liberties = new Int16Array(area);
  liberties.fill(-1);
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
    const point = x * size + y;
    const cell = at(board, x, y);
    if ((cell !== "X" && cell !== "O") || liberties[point] >= 0) continue;
    const found = fastGroup(board, x, y);
    for (const stone of found.stones) liberties[stone] = found.liberties;
  }
  const result: number[] = [];
  const enemy = other(colour);
  const currentHash = previousHashes.size ? boardHash(board) : "";
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
    if (at(board, x, y) !== ".") continue;
    let survives = false;
    let captures = false;
    for (let direction = 0; direction < 4; direction++) {
      const nx = x + (direction === 0 ? 1 : direction === 1 ? -1 : 0);
      const ny = y + (direction === 2 ? 1 : direction === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const cell = at(board, nx, ny);
      if (cell === ".") survives = true;
      else if (cell === colour && liberties[nx * size + ny]! > 1) survives = true;
      else if (cell === enemy && liberties[nx * size + ny] === 1) captures = true;
    }
    const point = x * size + y;
    const repeats = survives && !captures && previousHashes.size > 0
      ? previousHashes.has(currentHash.slice(0, point) + colour + currentHash.slice(point + 1))
      : false;
    if (captures ? playMove(board, x, y, colour, previousHashes) : survives && !repeats) {
      result.push(x * size + y);
    }
  }
  return result;
}

export function legalMoves(
  board: GoBoard,
  colour: Stone = "X",
  previousBoards: readonly string[][] = [],
): [number, number][] {
  const history = new Set(previousBoards.map((prior) => prior.join("")));
  return legalMoveIndices(board, colour, history).map((point) => [
    Math.floor(point / board.size), point % board.size,
  ]);
}

/** Owner of every controlled empty node, keyed `x,y`. `territory` counts this
 * map, so any presentation that shades controlled space agrees by construction
 * with the counts telemetry publishes. */
export function territoryOwners(board: GoBoard): Map<string, Stone> {
  const owners = new Map<string, Stone>();
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
        const owner = [...borders][0] as Stone;
        for (const [rx, ry] of region) owners.set(`${rx},${ry}`, owner);
      }
    }
  }
  return owners;
}

export function territory(board: GoBoard): { X: number; O: number } {
  const score = { X: 0, O: 0 };
  for (const owner of territoryOwners(board).values()) score[owner] += 1;
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
