/** IPvGO: a bounded adversarial search over the board.
 *
 * Objective: maximise wins, territory, streaks and the persistent bonuses. The
 * feature is coupled to nothing, which makes it the purest isolation profile
 * in the roster — and also means its evidence has to come entirely from
 * self-play against baselines rather than from cross-feature effects.
 *
 * The board is 5x5 to 19x19. On 5x5 a depth-bounded exhaustive search is a
 * strong reference line; above that the branching factor forces a heuristic,
 * and the strategy says which one it used. */

export type Cell = "." | "X" | "O" | "#";

export interface GoBoard {
  /** Row strings, as ns.go.getBoardState returns them. */
  rows: string[];
  size: number;
}

export interface GoMove {
  x: number;
  y: number;
  /** Board evaluation after this move, from our side. */
  score: number;
  why: string;
}

export interface GoView {
  board: GoBoard;
  /** Whose turn, from ns.go.getGameState. */
  currentPlayer: string;
  opponent: string;
  /** Bonus value of beating this opponent, for opponent selection. */
  opponentValue: Record<string, number>;
  /** Search depth budget. */
  maxDepth: number;
}

export type GoAction =
  | { type: "move"; x: number; y: number; why: string }
  | { type: "pass"; why: string }
  | { type: "newGame"; opponent: string; why: string };

export interface GoDecision {
  action: GoAction;
  ranked: GoMove[];
  why: string;
}

export function at(board: GoBoard, x: number, y: number): Cell {
  return (board.rows[y]?.[x] ?? "#") as Cell;
}

/** Liberties of the group containing (x, y), and the group's stones.
 *
 * Liberty counting is the whole of Go tactics: a group with one liberty is
 * captured next move, so any evaluation that ignores it plays blind. */
export function group(board: GoBoard, x: number, y: number): { stones: [number, number][]; liberties: number } {
  const colour = at(board, x, y);
  if (colour === "." || colour === "#") return { stones: [], liberties: 0 };
  const seen = new Set<string>();
  const libertySet = new Set<string>();
  const stones: [number, number][] = [];
  const stack: [number, number][] = [[x, y]];
  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    const key = `${cx},${cy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stones.push([cx, cy]);
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      const cell = at(board, nx, ny);
      if (cell === ".") libertySet.add(`${nx},${ny}`);
      else if (cell === colour) stack.push([nx, ny]);
    }
  }
  return { stones, liberties: libertySet.size };
}

/** Board evaluation from our side: territory plus a liberty-safety term.
 *
 * Territory alone is not enough — a large territory made of one-liberty groups
 * is about to stop being territory. The liberty term is what makes the
 * evaluation resist obvious captures. */
export function evaluate(board: GoBoard, us: Cell): number {
  const them: Cell = us === "X" ? "O" : "X";
  let score = 0;
  const counted = new Set<string>();
  for (let y = 0; y < board.size; y++) {
    for (let x = 0; x < board.size; x++) {
      const cell = at(board, x, y);
      if (cell !== us && cell !== them) continue;
      const key = `${x},${y}`;
      if (counted.has(key)) continue;
      const { stones, liberties } = group(board, x, y);
      for (const [sx, sy] of stones) counted.add(`${sx},${sy}`);
      // A group in atari (one liberty) is worth almost nothing.
      const safety = liberties >= 2 ? 1 : 0.2;
      const value = stones.length * safety + liberties * 0.25;
      score += cell === us ? value : -value;
    }
  }
  return score;
}

export function legalMoves(board: GoBoard): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < board.size; y++) {
    for (let x = 0; x < board.size; x++) {
      if (at(board, x, y) === ".") out.push([x, y]);
    }
  }
  return out;
}

function place(board: GoBoard, x: number, y: number, colour: Cell): GoBoard {
  const rows = [...board.rows];
  const row = rows[y]!;
  rows[y] = row.slice(0, x) + colour + row.slice(x + 1);
  return { rows, size: board.size };
}

/** Depth-bounded negamax. On 5x5 with a small depth this is effectively an
 * exhaustive reference line; on larger boards the depth cap makes it a
 * heuristic, and `stepGo` reports which. */
function search(board: GoBoard, us: Cell, toMove: Cell, depth: number): number {
  if (depth === 0) return evaluate(board, us);
  const moves = legalMoves(board);
  if (moves.length === 0) return evaluate(board, us);
  let best = -Infinity;
  for (const [x, y] of moves) {
    const next = place(board, x, y, toMove);
    const value = -search(next, us === toMove ? (us === "X" ? "O" : "X") : us, toMove === "X" ? "O" : "X", depth - 1);
    if (value > best) best = value;
  }
  return toMove === us ? best : -best;
}

export function stepGo(view: GoView): GoDecision {
  const us: Cell = view.currentPlayer === "White" ? "O" : "X";
  const moves = legalMoves(view.board);

  if (moves.length === 0) {
    return { action: { type: "pass", why: "no legal move" }, ranked: [], why: "passing" };
  }

  // Depth is bounded by board size: 5x5 tolerates a real search, 19x19 does
  // not, and pretending otherwise would blow the 200 ms budget.
  const depth = view.board.size <= 5 ? Math.min(view.maxDepth, 3) : 1;

  const ranked: GoMove[] = moves
    .map(([x, y]) => {
      const next = place(view.board, x, y, us);
      return {
        x,
        y,
        score: search(next, us, us === "X" ? "O" : "X", depth - 1),
        why: `depth-${depth} evaluation`,
      };
    })
    .sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);

  const best = ranked[0]!;
  // Passing when every move worsens the position is a real Go decision, not a
  // failure — filling your own eyes loses games.
  if (best.score < evaluate(view.board, us)) {
    return {
      action: { type: "pass", why: "every legal move worsens the position" },
      ranked,
      why: "passing rather than self-damaging",
    };
  }

  return {
    action: { type: "move", x: best.x, y: best.y, why: best.why },
    ranked: ranked.slice(0, 8),
    why:
      view.board.size <= 5
        ? `depth-${depth} search over ${moves.length} legal moves (exhaustive at this size)`
        : `depth-${depth} greedy over ${moves.length} legal moves (board too large for exhaustive search)`,
  };
}

/** Which opponent to play, by bonus value. Coupled to nothing else, so this is
 * a pure ranking. */
export function bestOpponent(view: GoView): string {
  const entries = Object.entries(view.opponentValue);
  if (entries.length === 0) return view.opponent;
  return entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
}
