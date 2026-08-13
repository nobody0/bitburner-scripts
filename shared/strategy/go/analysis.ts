import type { Cell, GoBoard, Stone } from "./rules.ts";

export interface GoPoint {
  x: number;
  y: number;
}

export interface GoChain {
  id: number;
  color: Exclude<Cell, "#">;
  points: GoPoint[];
  liberties: GoPoint[];
}

export interface GoAnalysis {
  board: GoBoard;
  chains: GoChain[];
  /** Extent-major chain lookup; numeric indexing avoids allocating coordinate
   * strings in the planner's hottest repeated analysis path. */
  chainAt: Array<GoChain | undefined>;
  /** Reused by effective-liberty queries; each analysis is confined to one
   * synchronous prediction, so a monotonically increasing mark is sufficient. */
  libertyScratch: { seen: Uint32Array; mark: number };
  /** Immutable topology caches shared by territory and eye-option passes. */
  neighborCache: Array<GoChain[] | undefined>;
  potentialEyeCache: Array<GoEyeCandidate[] | undefined>;
  eyesCache: Array<Map<number, GoChain[]> | undefined>;
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
  const result: GoPoint[] = [];
  // Preserve the observable north/east/south/west order without allocating
  // two intermediate arrays for every neighborhood lookup.
  for (let direction = 0; direction < 4; direction++) {
    const nx = x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
    const ny = y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
    if (cellAt(board, nx, ny) !== "#") result.push({ x: nx, y: ny });
  }
  return result;
}

export function analyzeBoard(board: GoBoard): GoAnalysis {
  const size = board.size;
  const area = size * size;
  const chains: GoChain[] = [];
  const chainAt = new Array<GoChain | undefined>(area);
  const assigned = new Uint8Array(area);
  const libertyMark = new Uint16Array(area);
  const stack = new Int16Array(area);
  const encoded: number[] = [];
  let mark = 0;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const color = cellAt(board, x, y);
      const index = x * size + y;
      if (color === "#" || assigned[index]) continue;

      encoded.length = 0;
      let top = 0;
      stack[top++] = index;
      assigned[index] = 1;
      encoded.push(index);
      while (top) {
        const point = stack[--top]!;
        const px = Math.floor(point / size);
        const py = point % size;
        // Upstream discovers north/east/south/west and traverses the resulting
        // stack in reverse. getAllChains later exposes points in x/y scan
        // order, but the discovery order remains observable in each chain's
        // shared liberty list and therefore in seeded growth-move selection.
        for (let direction = 0; direction < 4; direction++) {
          const nx = px + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
          const ny = py + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const next = nx * size + ny;
          if (!assigned[next] && board.rows[nx]![ny] === color) {
            assigned[next] = 1;
            encoded.push(next);
            stack[top++] = next;
          }
        }
      }
      const ordered = [...encoded].sort((a, b) => a - b);
      const points = ordered.map((point) => ({ x: Math.floor(point / size), y: point % size }));
      const liberties: GoPoint[] = [];
      // Empty chains cannot have an adjacent empty point outside their own
      // connected component. Stone-chain liberties retain upstream's
      // discovery-point order, then north/east/south/west.
      if (color !== ".") {
        mark++;
        for (const encodedPoint of encoded) {
          const pointX = Math.floor(encodedPoint / size);
          const pointY = encodedPoint % size;
          for (let direction = 0; direction < 4; direction++) {
            const nx = pointX + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
            const ny = pointY + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= size || ny >= size || board.rows[nx]![ny] !== ".") continue;
            const next = nx * size + ny;
            if (libertyMark[next] === mark) continue;
            libertyMark[next] = mark;
            liberties.push({ x: nx, y: ny });
          }
        }
      }
      const chain: GoChain = { id: chains.length, color, points, liberties };
      chains.push(chain);
      for (const point of points) chainAt[point.x * size + point.y] = chain;
    }
  }
  return {
    board,
    chains,
    chainAt,
    libertyScratch: { seen: new Uint32Array(area), mark: 0 },
    neighborCache: new Array(chains.length),
    potentialEyeCache: new Array(2),
    eyesCache: new Array(2),
  };
}

function neighboringChain(analysis: GoAnalysis, source: GoChain): GoChain[] {
  const cached = analysis.neighborCache[source.id];
  if (cached) return cached;
  const size = analysis.board.size;
  const found = new Uint8Array(analysis.chains.length);
  found[source.id] = 1;
  const result: GoChain[] = [];
  for (const point of source.points) {
    for (let direction = 0; direction < 4; direction++) {
      const nx = point.x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
      const ny = point.y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const chain = analysis.chainAt[nx * size + ny];
      // getAllNeighboringChains ignores empty cells even when they belong to
      // a different disconnected empty chain.
      if (!chain || chain.color === "." || found[chain.id]) continue;
      found[chain.id] = 1;
      result.push(chain);
    }
  }
  analysis.neighborCache[source.id] = result;
  return result;
}

export function neighboringChains(analysis: GoAnalysis, points: readonly GoPoint[]): GoChain[] {
  const size = analysis.board.size;
  const own = new Uint8Array(size * size);
  for (const point of points) own[point.x * size + point.y] = 1;
  const found = new Uint8Array(analysis.chains.length);
  const result: GoChain[] = [];
  for (const point of points) {
    for (let direction = 0; direction < 4; direction++) {
      const nx = point.x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
      const ny = point.y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const index = nx * size + ny;
      if (own[index] || analysis.board.rows[nx]![ny] === ".") continue;
      const chain = analysis.chainAt[index];
      if (!chain || found[chain.id]) continue;
      found[chain.id] = 1;
      result.push(chain);
    }
  }
  return result;
}

export function effectiveLiberties(analysis: GoAnalysis, x: number, y: number, player: Stone): GoPoint[] {
  const size = analysis.board.size;
  const scratch = analysis.libertyScratch;
  const mark = ++scratch.mark;
  const seen = scratch.seen;
  const result: GoPoint[] = [];
  const allied: GoChain[] = [];
  // Preserve upstream's direct-liberties-first ordering, followed by each
  // adjacent allied chain in north/east/south/west order.
  for (let direction = 0; direction < 4; direction++) {
    const nx = x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
    const ny = y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    const color = analysis.board.rows[nx]![ny];
    if (color === ".") {
      const index = nx * size + ny;
      if (index !== x * size + y && seen[index] !== mark) {
        seen[index] = mark;
        result.push({ x: nx, y: ny });
      }
    } else if (color === player) {
      const chain = analysis.chainAt[nx * size + ny];
      if (chain) allied.push(chain);
    }
  }
  for (const chain of allied) for (const point of chain.liberties) {
    const index = point.x * size + point.y;
    if (index === x * size + y || seen[index] === mark) continue;
    seen[index] = mark;
    result.push(point);
  }
  return result;
}

export function weakestNeighborChain(analysis: GoAnalysis, x: number, y: number, player: Stone): GoChain | undefined {
  const size = analysis.board.size;
  let weakest: GoChain | undefined;
  for (let direction = 0; direction < 4; direction++) {
    const nx = x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
    const ny = y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= size || ny >= size || analysis.board.rows[nx]![ny] !== player) continue;
    const chain = analysis.chainAt[nx * size + ny];
    if (chain && (!weakest || chain.liberties.length < weakest.liberties.length)) weakest = chain;
  }
  return weakest;
}

function replace(board: GoBoard, x: number, y: number, color: Cell): GoBoard {
  const rows = [...board.rows];
  const column = rows[x]!;
  rows[x] = column.slice(0, y) + color + column.slice(y + 1);
  return { rows, size: board.size };
}

interface LocalGroupWorkspace {
  seen: Uint8Array;
  libertySeen: Uint8Array;
  checked: Uint8Array;
  stack: Int16Array;
  points: number[];
}

function localGroupWorkspace(size: number): LocalGroupWorkspace {
  const area = size * size;
  return {
    seen: new Uint8Array(area),
    libertySeen: new Uint8Array(area),
    checked: new Uint8Array(area),
    stack: new Int16Array(area),
    points: [],
  };
}

function localGroup(
  board: GoBoard,
  x: number,
  y: number,
  color: Stone,
  workspace: LocalGroupWorkspace,
): { points: number[]; liberties: number } {
  const size = board.size;
  const { seen, libertySeen, stack, points } = workspace;
  seen.fill(0);
  libertySeen.fill(0);
  points.length = 0;
  let liberties = 0;
  let top = 0;
  const start = x * size + y;
  stack[top++] = start;
  seen[start] = 1;
  while (top) {
    const point = stack[--top]!;
    points.push(point);
    const px = Math.floor(point / size);
    const py = point % size;
    for (let direction = 0; direction < 4; direction++) {
      const nx = px + (direction === 0 ? 1 : direction === 1 ? -1 : 0);
      const ny = py + (direction === 2 ? 1 : direction === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const next = nx * size + ny;
      const cell = board.rows[nx]![ny];
      if (cell === color && !seen[next]) {
        seen[next] = 1;
        stack[top++] = next;
      } else if (cell === "." && !libertySeen[next]) {
        libertySeen[next] = 1;
        liberties++;
      }
    }
  }
  return { points, liberties };
}

/** Upstream evaluateMoveResult semantics: enemy captures win over suicide.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/boardAnalysis.ts */
export function evaluateMove(
  board: GoBoard,
  x: number,
  y: number,
  player: Stone,
  workspace = localGroupWorkspace(board.size),
  preparedAnalysis?: GoAnalysis,
): GoBoard {
  if (cellAt(board, x, y) === "#") return board;
  if (cellAt(board, x, y) === "." && preparedAnalysis) {
    const size = board.size;
    const enemy: Stone = player === "X" ? "O" : "X";
    const adjacentEnemy = new Uint8Array(preparedAnalysis.chains.length);
    const adjacentAllies = new Uint8Array(preparedAnalysis.chains.length);
    let captures = false;
    let survives = false;
    for (let direction = 0; direction < 4; direction++) {
      const nx = x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
      const ny = y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const color = board.rows[nx]![ny];
      if (color === ".") {
        survives = true;
        continue;
      }
      const chain = preparedAnalysis.chainAt[nx * size + ny];
      if (!chain) continue;
      if (color === enemy) {
        if (chain.liberties.length === 1) {
          adjacentEnemy[chain.id] = 1;
          captures = true;
        }
      } else if (color === player) {
        adjacentAllies[chain.id] = 1;
        if (chain.liberties.length > 1) survives = true;
      }
    }
    const rows = [...board.rows];
    const edited = new Array<string[] | undefined>(size);
    const set = (px: number, py: number, color: Cell): void => {
      const column = edited[px] ??= [...rows[px]!];
      column[py] = color;
    };
    set(x, y, player);
    if (captures) {
      for (const chain of preparedAnalysis.chains) {
        if (!adjacentEnemy[chain.id]) continue;
        for (const point of chain.points) set(point.x, point.y, ".");
      }
    } else if (!survives) {
      set(x, y, ".");
      for (const chain of preparedAnalysis.chains) {
        if (!adjacentAllies[chain.id]) continue;
        for (const point of chain.points) set(point.x, point.y, ".");
      }
    }
    for (let column = 0; column < size; column++) {
      if (edited[column]) rows[column] = edited[column]!.join("");
    }
    return { rows, size };
  }
  let result = replace(board, x, y, player);
  const enemy: Stone = player === "X" ? "O" : "X";
  const checked = workspace.checked;
  checked.fill(0);
  let capturedEnemy = false;
  for (const neighbor of cardinal(result, x, y)) {
    const neighborIndex = neighbor.x * board.size + neighbor.y;
    if (cellAt(result, neighbor.x, neighbor.y) !== enemy || checked[neighborIndex]) continue;
    const chain = localGroup(result, neighbor.x, neighbor.y, enemy, workspace);
    for (const point of chain.points) checked[point] = 1;
    if (chain.liberties !== 0) continue;
    capturedEnemy = true;
    for (const point of chain.points) result = replace(result, Math.floor(point / board.size), point % board.size, ".");
  }
  // Upstream removes captured enemy chains instead of treating a capturing
  // move as suicide. Only inspect the newly placed friendly chain when no
  // enemy was removed.
  if (!capturedEnemy) {
    const own = localGroup(result, x, y, player, workspace);
    if (own.liberties === 0) for (const point of own.points) {
      result = replace(result, Math.floor(point / board.size), point % board.size, ".");
    }
  }
  return result;
}

/** Evaluate legality from the already-built chain graph. The numeric result
 * distinguishes ordinary moves from captures so callers only materialize a
 * result board when a non-empty superko history actually needs its hash. */
function legalMoveKindFromAnalysis(
  board: GoBoard,
  analysis: GoAnalysis,
  x: number,
  y: number,
  player: Stone,
): 0 | 1 | 2 {
  if (cellAt(board, x, y) !== ".") return 0;
  const enemy: Stone = player === "X" ? "O" : "X";
  let survives = false;
  let captures = false;
  for (let direction = 0; direction < 4; direction++) {
    const nx = x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
    const ny = y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= board.size || ny >= board.size) continue;
    const color = board.rows[nx]![ny];
    if (color === ".") {
      survives = true;
      continue;
    }
    const chain = analysis.chainAt[nx * board.size + ny];
    if (!chain) continue;
    if (color === player && chain.liberties.length > 1) survives = true;
    else if (color === enemy && chain.liberties.length === 1) captures = true;
  }
  if (!survives && !captures) return 0;
  return captures ? 2 : 1;
}

export function legalPoints(
  board: GoBoard,
  player: Stone,
  history: readonly string[][] = [],
  preparedAnalysis?: GoAnalysis,
  preparedHistory?: ReadonlySet<string>,
): GoPoint[] {
  const prior = preparedHistory ? undefined : history.map((position) => position.join(""));
  const priorSet = preparedHistory ?? (prior!.length > 4 ? new Set(prior) : undefined);
  const hasHistory = preparedHistory ? preparedHistory.size > 0 : prior!.length > 0;
  const current = hasHistory ? board.rows.join("") : "";
  const result: GoPoint[] = [];
  const workspace = localGroupWorkspace(board.size);
  const analysis = preparedAnalysis ?? analyzeBoard(board);
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      const kind = legalMoveKindFromAnalysis(board, analysis, x, y, player);
      if (!kind) continue;
      if (hasHistory) {
        if (kind === 2) {
          const next = evaluateMove(board, x, y, player, workspace, analysis).rows.join("");
          if ((priorSet ? priorSet.has(next) : prior!.includes(next))) continue;
        } else {
          const changed = x * board.size + y;
          if (priorSet) {
            const next = current.slice(0, changed) + player + current.slice(changed + 1);
            if (priorSet.has(next)) continue;
            result.push({ x, y });
            continue;
          }
          let repeated = false;
          for (const previous of prior!) {
            if (previous[changed] !== player || previous.length !== current.length) continue;
            let equal = true;
            for (let index = 0; index < current.length; index++) {
              if (index !== changed && previous[index] !== current[index]) {
                equal = false;
                break;
              }
            }
            if (equal) {
              repeated = true;
              break;
            }
          }
          if (repeated) continue;
        }
      }
      result.push({ x, y });
    }
  }
  return result;
}

function spread(chain: GoChain): { north: number; east: number; south: number; west: number } {
  const first = chain.points[0]!;
  let north = first.y;
  let east = first.x;
  let south = first.y;
  let west = first.x;
  for (let index = 1; index < chain.points.length; index++) {
    const point = chain.points[index]!;
    north = Math.max(north, point.y);
    east = Math.max(east, point.x);
    south = Math.min(south, point.y);
    west = Math.min(west, point.x);
  }
  return { north, east, south, west };
}

/** Upstream tests whether one neighboring chain fully surrounds an empty
 * region by copying the board, erasing every other neighboring chain,
 * rebuilding every chain, and then counting the original stone chains beside
 * the expanded empty region. A flood fill over exactly those erased cells is
 * behaviorally identical and avoids the repeated whole-board rebuild. */
function fullyEncircles(
  analysis: GoAnalysis,
  candidate: GoChain,
  neighbors: readonly GoChain[],
  keptIndex: number,
): boolean {
  const size = analysis.board.size;
  const area = size * size;
  const removed = new Uint8Array(area);
  for (let index = 0; index < neighbors.length; index++) {
    if (index === keptIndex) continue;
    for (const point of neighbors[index]!.points) removed[point.x * size + point.y] = 1;
  }
  const expanded = new Uint8Array(area);
  const stack = new Int16Array(area);
  let top = 0;
  const first = candidate.points[0]!;
  const start = first.x * size + first.y;
  expanded[start] = 1;
  stack[top++] = start;
  while (top) {
    const encoded = stack[--top]!;
    const x = Math.floor(encoded / size);
    const y = encoded % size;
    for (let direction = 0; direction < 4; direction++) {
      const nx = x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
      const ny = y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const next = nx * size + ny;
      if (expanded[next]) continue;
      if (analysis.board.rows[nx]![ny] !== "." && !removed[next]) continue;
      expanded[next] = 1;
      stack[top++] = next;
    }
  }
  const found = new Uint8Array(analysis.chains.length);
  let count = 0;
  for (let encoded = 0; encoded < area; encoded++) {
    if (!expanded[encoded]) continue;
    const x = Math.floor(encoded / size);
    const y = encoded % size;
    for (let direction = 0; direction < 4; direction++) {
      const nx = x + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
      const ny = y + (direction === 0 ? 1 : direction === 2 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const next = nx * size + ny;
      if (expanded[next]) continue;
      const chain = analysis.chainAt[next];
      if (!chain || chain.color === "." || found[chain.id]) continue;
      found[chain.id] = 1;
      if (++count > 1) return false;
    }
  }
  return count === 1;
}

function potentialEyes(
  analysis: GoAnalysis,
  player: Stone,
  requestedMaxSize?: number,
): GoEyeCandidate[] {
  const playerIndex = player === "X" ? 0 : 1;
  if (requestedMaxSize === undefined) {
    const cached = analysis.potentialEyeCache[playerIndex];
    if (cached) return cached;
  }
  let nodeCount = 0;
  for (const column of analysis.board.rows) {
    for (let index = 0; index < column.length; index++) {
      if (column[index] !== "#") nodeCount++;
    }
  }
  const maxSize = requestedMaxSize ?? Math.min(nodeCount * 0.4, 11);
  const result: GoEyeCandidate[] = [];
  for (const chain of analysis.chains) {
    if (chain.color !== "." || chain.points.length > maxSize) continue;
    const neighbors = neighboringChain(analysis, chain);
    let hasWhite = false;
    let hasBlack = false;
    for (const neighbor of neighbors) {
      if (neighbor.color === "O") hasWhite = true;
      else if (neighbor.color === "X") hasBlack = true;
    }
    if (player === "O" ? hasWhite && !hasBlack : hasBlack && !hasWhite) result.push({ chain, neighbors });
  }
  if (requestedMaxSize === undefined) analysis.potentialEyeCache[playerIndex] = result;
  return result;
}

/** True eyes keyed by the surrounding stone chain, preserving insertion order. */
export function eyesByChain(analysis: GoAnalysis, player: Stone): Map<number, GoChain[]> {
  const playerIndex = player === "X" ? 0 : 1;
  const cached = analysis.eyesCache[playerIndex];
  if (cached) return cached;
  const result = new Map<number, GoChain[]>();
  const boardMax = analysis.board.size - 1;
  for (const candidate of potentialEyes(analysis, player)) {
    if (candidate.neighbors.length === 0) continue;
    const candidateSpread = candidate.neighbors.length === 1 ? undefined : spread(candidate.chain);
    const encircling = candidate.neighbors.length === 1
      ? candidate.neighbors
      : candidate.neighbors.filter((neighbor, index) => {
          const neighborSpread = spread(neighbor);
          if (
            !(neighborSpread.north > candidateSpread!.north || candidateSpread!.north === boardMax && neighborSpread.north === boardMax)
            || !(neighborSpread.east > candidateSpread!.east || candidateSpread!.east === boardMax && neighborSpread.east === boardMax)
            || !(neighborSpread.south < candidateSpread!.south || candidateSpread!.south === 0 && neighborSpread.south === 0)
            || !(neighborSpread.west < candidateSpread!.west || candidateSpread!.west === 0 && neighborSpread.west === 0)
          ) return false;
          return fullyEncircles(analysis, candidate.chain, candidate.neighbors, index);
        });
    for (const neighbor of encircling) {
      const eyes = result.get(neighbor.id) ?? [];
      eyes.push(candidate.chain);
      result.set(neighbor.id, eyes);
    }
  }
  analysis.eyesCache[playerIndex] = result;
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
  const size = board.size;
  let valid = preparedLegal ? [...preparedLegal] : legalPoints(board, player, history);
  if (excludeFriendlyEyes) {
    const friendly = new Uint8Array(size * size);
    for (const eyes of allEyes(analysis, player)) {
      if (eyes.length < 2) continue;
      for (const eye of eyes) for (const point of eye.points) friendly[point.x * size + point.y] = 1;
    }
    valid = valid.filter((point) => !friendly[point.x * size + point.y]);
  }
  const opponent: Stone = player === "X" ? "O" : "X";
  const enemySpaces = potentialEyes(analysis, opponent);
  const inside = new Uint8Array(size * size);
  for (const space of enemySpaces) for (const point of space.chain.points) inside[point.x * size + point.y] = 1;
  const playable = new Uint8Array(size * size);
  for (const space of enemySpaces) {
    const spacePoints = new Uint8Array(size * size);
    for (const point of space.chain.points) spacePoints[point.x * size + point.y] = 1;
    for (const border of space.neighbors) {
      if (border.liberties.length > 4) continue;
      if (!neighboringChain(analysis, border).some((chain) => chain.color === player)) continue;
      const libertiesInside = border.liberties.filter((point) => spacePoints[point.x * size + point.y]);
      if (libertiesInside.length !== border.liberties.length) continue;
      for (const point of libertiesInside) playable[point.x * size + point.y] = 1;
    }
  }
  return valid.filter((point) => {
    const index = point.x * size + point.y;
    return !inside[index] || Boolean(playable[index]);
  });
}

export function disputedMoves(analysis: GoAnalysis, available: readonly GoPoint[], maxChainSize = 99): GoPoint[] {
  const disputedByChain = new Map<number, boolean>();
  return available.filter((point) => {
    const chain = analysis.chainAt[point.x * analysis.board.size + point.y];
    if (!chain || chain.points.length > maxChainSize) return false;
    const cached = disputedByChain.get(chain.id);
    if (cached !== undefined) return cached;
    // Upstream passes its size-filtered chain list into
    // getAllNeighboringChains, so large neighboring stone chains are absent as
    // well as large candidate empty chains. This is observable once open
    // expansion points are exhausted.
    const neighbors = neighboringChain(analysis, chain)
      .filter((neighbor) => neighbor.points.length <= maxChainSize);
    const disputed = neighbors.some((neighbor) => neighbor.color === "O")
      && neighbors.some((neighbor) => neighbor.color === "X");
    disputedByChain.set(chain.id, disputed);
    return disputed;
  });
}

export function pointKey(point: GoPoint): string {
  return key(point.x, point.y);
}
