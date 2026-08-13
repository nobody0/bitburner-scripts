import type { GoBoard, Stone } from "./rules.ts";
import { analyzeBoard, cellAt, effectiveLiberties, pointKey, type GoPoint } from "./analysis.ts";

/** Independently transcribed IPvGO 3x3 tactical vocabulary.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/patternMatching.ts */
const BASE_PATTERNS: readonly (readonly string[])[] = [
  ["XOX", "...", "???"],
  ["XO.", "...", "?.?"],
  ["XO?", "X..", "o.?"],
  [".O.", "X..", "..."],
  ["XO?", "O.x", "?x?"],
  ["XO?", "O.X", "???"],
  ["?X?", "O.O", "xxx"],
  ["OX?", "x.O", "???"],
  ["X.?", "O.?", "   "],
  ["OX?", "X.O", "   "],
  ["?X?", "o.O", "   "],
  ["?XO", "o.o", "   "],
  ["?OX", "X.O", "   "],
];

function rotate(pattern: readonly string[]): string[] {
  return [
    `${pattern[2]![0]}${pattern[1]![0]}${pattern[0]![0]}`,
    `${pattern[2]![1]}${pattern[1]![1]}${pattern[0]![1]}`,
    `${pattern[2]![2]}${pattern[1]![2]}${pattern[0]![2]}`,
  ];
}

const vertical = (pattern: readonly string[]): string[] => [pattern[2]!, pattern[1]!, pattern[0]!];
// Upstream's horizontal transform uses Array.join() without a separator. That
// observable comma is intentional here: it makes those transformed patterns
// fail just as they do in the game rather than silently "fixing" its AI.
// Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Go/boardAnalysis/patternMatching.ts
const horizontal = (pattern: readonly string[]): string[] => pattern.map((row) => [...row].reverse().join());

function expandedGoPatterns(): string[][] {
  const r1 = BASE_PATTERNS.map(rotate);
  const r2 = r1.map(rotate);
  const r3 = r2.map(rotate);
  const rotated = [...BASE_PATTERNS.map((pattern) => [...pattern]), ...r1, ...r2, ...r3];
  const mirrored = [...rotated, ...rotated.map(vertical)];
  return [...mirrored, ...mirrored.map(horizontal)];
}

const PATTERNS = expandedGoPatterns().map((pattern) => pattern.join(""));

function patternCell(board: GoBoard, x: number, y: number): ReturnType<typeof cellAt> | undefined {
  if (x < 0 || y < 0 || x >= board.size || y >= board.size) return undefined;
  return cellAt(board, x, y);
}

function matches(token: string, cell: ReturnType<typeof patternCell>, player: Stone): boolean {
  const opponent: Stone = player === "X" ? "O" : "X";
  if (token === "X") return cell === player;
  if (token === "O") return cell === opponent;
  if (token === "x") return cell !== opponent;
  if (token === "o") return cell !== player;
  if (token === ".") return cell === ".";
  // The game's pattern neighborhood exposes offline nodes as null but array
  // edges as undefined. Its space token matches only the former.
  if (token === " ") return cell === "#";
  return token === "?";
}

function matchesAnyPattern(board: GoBoard, x: number, y: number, player: Stone): boolean {
  return PATTERNS.some((pattern) => {
    let index = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const token = pattern[index++]!;
        if (!matches(token, patternCell(board, x + dx, y + dy), player)) return false;
      }
    }
    return true;
  });
}

export function patternMoves(
  board: GoBoard,
  player: Stone,
  available: readonly GoPoint[],
  smart: boolean,
): GoPoint[] {
  const allowed = new Set(available.map(pointKey));
  const analysis = analyzeBoard(board);
  const moves: GoPoint[] = [];
  for (let x = 0; x < board.size; x++) {
    for (let y = 0; y < board.size; y++) {
      if (!allowed.has(`${x},${y}`)) continue;
      // Match is player-relative. Avoid rebuilding the transformed board by
      // applying the same token relation directly here.
      const matched = matchesAnyPattern(board, x, y, player);
      if (matched && (!smart || effectiveLiberties(analysis, x, y, player).length > 1)) moves.push({ x, y });
    }
  }
  return moves;
}
