import type { Cell, GoBoard, Stone } from "./decide.ts";

export interface GoPoint {
  x: number;
  y: number;
}

export interface GoChain {
  id: string;
  color: Exclude<Cell, "#">;
  points: GoPoint[];
  liberties: GoPoint[];
}

export interface GoAnalysis {
  board: GoBoard;
  chains: GoChain[];
  chainAt: Map<string, GoChain>;
}

export interface GoEyeCandidate {
  chain: GoChain;
  neighbors: GoChain[];
}

const key = (x: number, y: number): string => `${x},${y}`;

export function cellAt(board: GoBoard, x: number, y: number): Cell {
  return (board.rows[x]?.[y] ?? "#") as Cell;
}

/** Cardinal order used throughout the upstream AI. Ordering is observable:
 * several option builders choose the first equally-ranked point.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/goAI.ts
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/boardAnalysis.ts */
export function cardinal(board: GoBoard, x: number, y: number): GoPoint[] {
  return [[x, y + 1], [x + 1, y], [x, y - 1], [x - 1, y]]
    .filter(([nx, ny]) => cellAt(board, nx, ny) !== "#")
    .map(([nx, ny]) => ({ x: nx, y: ny }));
}

function connected(board: GoBoard, start: GoPoint, color: Exclude<Cell, "#">): GoPoint[] {
  const result: GoPoint[] = [];
  const seen = new Uint8Array(board.size * board.size);
  const stack = [start.x * board.size + start.y];
  while (stack.length) {
    const index = stack.pop()!;
    if (seen[index]) continue;
    const x = Math.floor(index / board.size);
    const y = index % board.size;
    if (cellAt(board, x, y) !== color) continue;
    seen[index] = 1;
    result.push({ x, y });
    // Push in reverse so traversal itself follows north/east/south/west. Chain
    // members are sorted below because getAllChains exposes scan order.
    const next = cardinal(board, x, y);
    for (let i = next.length - 1; i >= 0; i--) {
      const point = next[i]!;
      const nextIndex = point.x * board.size + point.y;
      if (!seen[nextIndex]) stack.push(nextIndex);
    }
  }
  return result.sort((a, b) => a.x - b.x || a.y - b.y);
}

export function analyzeBoard(board: GoBoard): GoAnalysis {
  const chains: GoChain[] = [];
  const chainAt = new Map<string, GoChain>();
  const assigned = new Uint8Array(board.size * board.size);
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      const color = cellAt(board, x, y);
      const id = key(x, y);
      const index = x * board.size + y;
      if (color === "#" || assigned[index]) continue;
      const points = connected(board, { x, y }, color);
      const pointIds = new Set(points.map((point) => key(point.x, point.y)));
      for (const point of points) assigned[point.x * board.size + point.y] = 1;
      const liberties: GoPoint[] = [];
      const seenLiberties = new Set<string>();
      for (const point of points) {
        for (const neighbor of cardinal(board, point.x, point.y)) {
          const neighborKey = key(neighbor.x, neighbor.y);
          if (cellAt(board, neighbor.x, neighbor.y) !== "." || seenLiberties.has(neighborKey)) {
            continue;
          }
          // `assigned` is not sufficient for an empty chain currently being
          // analyzed; coordinate membership is the actual upstream check.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/boardAnalysis.ts
          if (pointIds.has(neighborKey)) continue;
          seenLiberties.add(neighborKey);
          liberties.push(neighbor);
        }
      }
      const chain: GoChain = { id, color, points, liberties };
      chains.push(chain);
      for (const point of points) chainAt.set(key(point.x, point.y), chain);
    }
  }
  return { board, chains, chainAt };
}

export function neighboringChains(analysis: GoAnalysis, points: readonly GoPoint[]): GoChain[] {
  const own = new Set(points.map((point) => key(point.x, point.y)));
  const found = new Set<string>();
  const result: GoChain[] = [];
  for (const point of points) {
    for (const neighbor of cardinal(analysis.board, point.x, point.y)) {
      const neighborKey = key(neighbor.x, neighbor.y);
      if (own.has(neighborKey) || cellAt(analysis.board, neighbor.x, neighbor.y) === ".") continue;
      const chain = analysis.chainAt.get(neighborKey);
      if (!chain || found.has(chain.id)) continue;
      found.add(chain.id);
      result.push(chain);
    }
  }
  return result;
}

export function effectiveLiberties(analysis: GoAnalysis, x: number, y: number, player: Stone): GoPoint[] {
  const neighbors = cardinal(analysis.board, x, y)
    .filter((point) => {
      const color = cellAt(analysis.board, point.x, point.y);
      return color === "." || color === player;
    });
  const direct = neighbors.filter((point) => cellAt(analysis.board, point.x, point.y) === ".");
  const allied = neighbors
    .filter((point) => cellAt(analysis.board, point.x, point.y) === player)
    .flatMap((point) => analysis.chainAt.get(key(point.x, point.y))?.liberties ?? []);
  const seen = new Set<string>();
  return [...direct, ...allied].filter((point) => {
    const id = key(point.x, point.y);
    if ((point.x === x && point.y === y) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function weakestNeighborChain(analysis: GoAnalysis, x: number, y: number, player: Stone): GoChain | undefined {
  const friendly = cardinal(analysis.board, x, y)
    .filter((point) => cellAt(analysis.board, point.x, point.y) === player)
    .map((point) => analysis.chainAt.get(key(point.x, point.y)))
    .filter((chain): chain is GoChain => Boolean(chain));
  const minimum = friendly.reduce((value, chain) => Math.min(value, chain.liberties.length), friendly[0]?.liberties.length ?? 99);
  return friendly.find((chain) => chain.liberties.length === minimum);
}

function replace(board: GoBoard, x: number, y: number, color: Cell): GoBoard {
  const rows = [...board.rows];
  const column = rows[x]!;
  rows[x] = column.slice(0, y) + color + column.slice(y + 1);
  return { rows, size: board.size };
}

function localGroup(board: GoBoard, x: number, y: number, color: Stone): { points: GoPoint[]; liberties: number } {
  const points: GoPoint[] = [];
  const seen = new Set<string>();
  const liberties = new Set<string>();
  const stack: GoPoint[] = [{ x, y }];
  while (stack.length) {
    const point = stack.pop()!;
    const id = key(point.x, point.y);
    if (seen.has(id) || cellAt(board, point.x, point.y) !== color) continue;
    seen.add(id);
    points.push(point);
    for (const neighbor of cardinal(board, point.x, point.y)) {
      const cell = cellAt(board, neighbor.x, neighbor.y);
      if (cell === ".") liberties.add(key(neighbor.x, neighbor.y));
      else if (cell === color && !seen.has(key(neighbor.x, neighbor.y))) stack.push(neighbor);
    }
  }
  return { points, liberties: liberties.size };
}

/** Upstream evaluateMoveResult semantics: enemy captures win over suicide.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/boardAnalysis.ts */
export function evaluateMove(board: GoBoard, x: number, y: number, player: Stone): GoBoard {
  if (cellAt(board, x, y) === "#") return board;
  let result = replace(board, x, y, player);
  const enemy: Stone = player === "X" ? "O" : "X";
  const checked = new Set<string>();
  let capturedEnemy = false;
  for (const neighbor of cardinal(result, x, y)) {
    if (cellAt(result, neighbor.x, neighbor.y) !== enemy || checked.has(key(neighbor.x, neighbor.y))) continue;
    const chain = localGroup(result, neighbor.x, neighbor.y, enemy);
    for (const point of chain.points) checked.add(key(point.x, point.y));
    if (chain.liberties !== 0) continue;
    capturedEnemy = true;
    for (const point of chain.points) result = replace(result, point.x, point.y, ".");
  }
  // Upstream removes captured enemy chains instead of treating a capturing
  // move as suicide. Only inspect the newly placed friendly chain when no
  // enemy was removed.
  if (!capturedEnemy) {
    const own = localGroup(result, x, y, player);
    if (own.liberties === 0) for (const point of own.points) result = replace(result, point.x, point.y, ".");
  }
  return result;
}

export function legalPoints(board: GoBoard, player: Stone, history: readonly string[][] = []): GoPoint[] {
  const prior = new Set(history.map((position) => position.join("")));
  const result: GoPoint[] = [];
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      if (cellAt(board, x, y) !== ".") continue;
      const next = evaluateMove(board, x, y, player);
      if (cellAt(next, x, y) !== player || prior.has(next.rows.join(""))) continue;
      result.push({ x, y });
    }
  }
  return result;
}

function spread(chain: GoChain): { north: number; east: number; south: number; west: number } {
  return chain.points.reduce((result, point) => ({
    north: Math.max(result.north, point.y),
    east: Math.max(result.east, point.x),
    south: Math.min(result.south, point.y),
    west: Math.min(result.west, point.x),
  }), {
    north: chain.points[0]!.y,
    east: chain.points[0]!.x,
    south: chain.points[0]!.y,
    west: chain.points[0]!.x,
  });
}

export function potentialEyes(
  analysis: GoAnalysis,
  player: Stone,
  requestedMaxSize?: number,
): GoEyeCandidate[] {
  const nodeCount = analysis.board.rows.reduce((sum, column) => sum + [...column].filter((cell) => cell !== "#").length, 0);
  const maxSize = requestedMaxSize ?? Math.min(nodeCount * 0.4, 11);
  return analysis.chains
    .filter((chain) => chain.color === "." && chain.points.length <= maxSize)
    .flatMap((chain) => {
      const neighbors = neighboringChains(analysis, chain.points);
      const hasWhite = neighbors.some((neighbor) => neighbor.color === "O");
      const hasBlack = neighbors.some((neighbor) => neighbor.color === "X");
      return (player === "O" ? hasWhite && !hasBlack : hasBlack && !hasWhite) ? [{ chain, neighbors }] : [];
    });
}

/** True eyes keyed by the surrounding stone chain, preserving insertion order. */
export function eyesByChain(analysis: GoAnalysis, player: Stone): Map<string, GoChain[]> {
  const result = new Map<string, GoChain[]>();
  const boardMax = analysis.board.size - 1;
  for (const candidate of potentialEyes(analysis, player)) {
    if (candidate.neighbors.length === 0) continue;
    const encircling = candidate.neighbors.length === 1
      ? candidate.neighbors
      : candidate.neighbors.filter((neighbor, index) => {
          const candidateSpread = spread(candidate.chain);
          const neighborSpread = spread(neighbor);
          if (
            !(neighborSpread.north > candidateSpread.north || candidateSpread.north === boardMax && neighborSpread.north === boardMax)
            || !(neighborSpread.east > candidateSpread.east || candidateSpread.east === boardMax && neighborSpread.east === boardMax)
            || !(neighborSpread.south < candidateSpread.south || candidateSpread.south === 0 && neighborSpread.south === 0)
            || !(neighborSpread.west < candidateSpread.west || candidateSpread.west === 0 && neighborSpread.west === 0)
          ) return false;
          let evaluation = analysis.board;
          for (let other = 0; other < candidate.neighbors.length; other++) {
            if (other === index) continue;
            for (const point of candidate.neighbors[other]!.points) evaluation = replace(evaluation, point.x, point.y, ".");
          }
          const evaluated = analyzeBoard(evaluation);
          const expanded = evaluated.chainAt.get(key(candidate.chain.points[0]!.x, candidate.chain.points[0]!.y));
          return expanded ? neighboringChains(analysis, expanded.points).length === 1 : false;
        });
    for (const neighbor of encircling) {
      const eyes = result.get(neighbor.id) ?? [];
      eyes.push(candidate.chain);
      result.set(neighbor.id, eyes);
    }
  }
  return result;
}

export function allEyes(analysis: GoAnalysis, player: Stone): GoChain[][] {
  return [...eyesByChain(analysis, player).values()];
}

export function disputedTerritory(
  board: GoBoard,
  player: Stone,
  history: readonly string[][],
  excludeFriendlyEyes: boolean,
  preparedAnalysis?: GoAnalysis,
  preparedLegal?: readonly GoPoint[],
): GoPoint[] {
  const analysis = preparedAnalysis ?? analyzeBoard(board);
  let valid = preparedLegal ? [...preparedLegal] : legalPoints(board, player, history);
  if (excludeFriendlyEyes) {
    const friendly = new Set(allEyes(analysis, player)
      .filter((eyes) => eyes.length >= 2)
      .flatMap((eyes) => eyes.flatMap((eye) => eye.points))
      .map((point) => key(point.x, point.y)));
    valid = valid.filter((point) => !friendly.has(key(point.x, point.y)));
  }
  const opponent: Stone = player === "X" ? "O" : "X";
  const enemySpaces = potentialEyes(analysis, opponent);
  const inside = new Set(enemySpaces.flatMap((space) => space.chain.points).map((point) => key(point.x, point.y)));
  const playable = new Set<string>();
  for (const space of enemySpaces) {
    for (const border of space.neighbors) {
      if (border.liberties.length > 4) continue;
      if (!neighboringChains(analysis, border.points).some((chain) => chain.color === player)) continue;
      const libertiesInside = border.liberties.filter((point) => space.chain.points.some((insidePoint) => insidePoint.x === point.x && insidePoint.y === point.y));
      if (libertiesInside.length !== border.liberties.length) continue;
      for (const point of libertiesInside) playable.add(key(point.x, point.y));
    }
  }
  return valid.filter((point) => !inside.has(key(point.x, point.y)) || playable.has(key(point.x, point.y)));
}

export function disputedMoves(analysis: GoAnalysis, available: readonly GoPoint[], maxChainSize = 99): GoPoint[] {
  return available.filter((point) => {
    const chain = analysis.chainAt.get(key(point.x, point.y));
    if (!chain || chain.points.length > maxChainSize) return false;
    // Upstream passes its size-filtered chain list into
    // getAllNeighboringChains, so large neighboring stone chains are absent as
    // well as large candidate empty chains. This is observable once open
    // expansion points are exhausted.
    const neighbors = neighboringChains(analysis, chain.points)
      .filter((neighbor) => neighbor.points.length <= maxChainSize);
    return neighbors.some((neighbor) => neighbor.color === "O") && neighbors.some((neighbor) => neighbor.color === "X");
  });
}

export function pointKey(point: GoPoint): string {
  return key(point.x, point.y);
}
