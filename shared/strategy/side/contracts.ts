/** Coding-contract solvers and infiltration ranking.
 *
 * The strongest evidence in the whole roster, and the reason is structural:
 * every contract type has a KNOWN CORRECT ANSWER, so solver correctness is
 * PROVEN over generated instances rather than measured against a baseline.
 * Nothing else in the project gets to say that.
 *
 * The registry is keyed by the contract type string the game reports. An
 * unknown type returns `undefined` — never a guess — because a wrong answer
 * costs a try, and three wrong answers destroy the contract. */

export type ContractSolver = (data: unknown) => unknown;

/** Largest sum of any contiguous subarray. */
function maxSubarraySum(data: unknown): number {
  const values = data as number[];
  let best = values[0] ?? 0;
  let current = best;
  for (let i = 1; i < values.length; i++) {
    current = Math.max(values[i]!, current + values[i]!);
    best = Math.max(best, current);
  }
  return best;
}

/** Can you reach the end of the array? */
function arrayJumpingGame(data: unknown): number {
  const values = data as number[];
  let reach = 0;
  for (let i = 0; i < values.length; i++) {
    if (i > reach) return 0;
    reach = Math.max(reach, i + values[i]!);
  }
  return 1;
}

/** Minimum jumps to reach the end, or 0 when unreachable. */
function arrayJumpingGameII(data: unknown): number {
  const values = data as number[];
  const n = values.length;
  if (n <= 1) return 0;
  const best = new Array<number>(n).fill(Infinity);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(best[i]!)) continue;
    for (let step = 1; step <= values[i]!; step++) {
      const j = i + step;
      if (j >= n) break;
      best[j] = Math.min(best[j]!, best[i]! + 1);
    }
  }
  return Number.isFinite(best[n - 1]!) ? best[n - 1]! : 0;
}

/** Merge overlapping intervals, sorted ascending. */
function mergeOverlappingIntervals(data: unknown): number[][] {
  const intervals = (data as number[][]).map((pair) => [pair[0]!, pair[1]!]).sort((a, b) => a[0]! - b[0]!);
  const out: number[][] = [];
  for (const [start, end] of intervals) {
    const last = out[out.length - 1];
    if (last && start! <= last[1]!) last[1] = Math.max(last[1]!, end!);
    else out.push([start!, end!]);
  }
  return out;
}

/** Unique paths through an m x n grid. */
function uniquePathsI(data: unknown): number {
  const [rows, cols] = data as [number, number];
  const grid = new Array<number>(cols).fill(1);
  for (let r = 1; r < rows; r++) {
    for (let c = 1; c < cols; c++) grid[c] = grid[c]! + grid[c - 1]!;
  }
  return grid[cols - 1] ?? 1;
}

/** Unique paths with obstacles (1 = blocked). */
function uniquePathsII(data: unknown): number {
  const grid = data as number[][];
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const ways = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r]![c] === 1) continue;
      if (r === 0 && c === 0) ways[r]![c] = 1;
      else ways[r]![c] = (r > 0 ? ways[r - 1]![c]! : 0) + (c > 0 ? ways[r]![c - 1]! : 0);
    }
  }
  return ways[rows - 1]?.[cols - 1] ?? 0;
}

/** Total ways to sum to n using smaller positive integers. */
function totalWaysToSum(data: unknown): number {
  const target = data as number;
  const ways = new Array<number>(target + 1).fill(0);
  ways[0] = 1;
  for (let coin = 1; coin < target; coin++) {
    for (let value = coin; value <= target; value++) ways[value] = ways[value]! + ways[value - coin]!;
  }
  return ways[target] ?? 0;
}

/** Total ways to sum to n using the given denominations. */
function totalWaysToSumII(data: unknown): number {
  const [target, coins] = data as [number, number[]];
  const ways = new Array<number>(target + 1).fill(0);
  ways[0] = 1;
  for (const coin of coins) {
    for (let value = coin; value <= target; value++) ways[value] = ways[value]! + ways[value - coin]!;
  }
  return ways[target] ?? 0;
}

/** Maximum profit from one stock transaction. */
function stockTraderI(data: unknown): number {
  const prices = data as number[];
  let lowest = Infinity;
  let best = 0;
  for (const price of prices) {
    lowest = Math.min(lowest, price);
    best = Math.max(best, price - lowest);
  }
  return best;
}

/** Maximum profit with unlimited transactions. */
function stockTraderII(data: unknown): number {
  const prices = data as number[];
  let total = 0;
  for (let i = 1; i < prices.length; i++) {
    const gain = prices[i]! - prices[i - 1]!;
    if (gain > 0) total += gain;
  }
  return total;
}

/** Maximum profit with at most `k` transactions — the general case. */
function stockTraderK(prices: number[], k: number): number {
  if (prices.length === 0 || k === 0) return 0;
  // With k >= n/2 there is no effective limit; the unlimited answer applies.
  if (k >= prices.length / 2) return stockTraderII(prices);
  const buy = new Array<number>(k + 1).fill(-Infinity);
  const sell = new Array<number>(k + 1).fill(0);
  for (const price of prices) {
    for (let t = 1; t <= k; t++) {
      buy[t] = Math.max(buy[t]!, sell[t - 1]! - price);
      sell[t] = Math.max(sell[t]!, buy[t]! + price);
    }
  }
  return sell[k] ?? 0;
}

/** Minimum path sum through a triangle. */
function minimumPathSumTriangle(data: unknown): number {
  const triangle = data as number[][];
  const best = [...(triangle[triangle.length - 1] ?? [])];
  for (let row = triangle.length - 2; row >= 0; row--) {
    for (let col = 0; col <= row; col++) {
      best[col] = triangle[row]![col]! + Math.min(best[col]!, best[col + 1]!);
    }
  }
  return best[0] ?? 0;
}

/** Largest prime factor. */
function largestPrimeFactor(data: unknown): number {
  let n = data as number;
  let largest = 1;
  for (let factor = 2; factor * factor <= n; factor++) {
    while (n % factor === 0) {
      largest = factor;
      n /= factor;
    }
  }
  return n > 1 ? n : largest;
}

/** Number of distinct 2-colourings... actually: spiralize a matrix. */
function spiralizeMatrix(data: unknown): number[] {
  const matrix = (data as number[][]).map((row) => [...row]);
  const out: number[] = [];
  while (matrix.length > 0) {
    out.push(...(matrix.shift() ?? []));
    for (const row of matrix) {
      const value = row.pop();
      if (value !== undefined) out.push(value);
    }
    const last = matrix.pop();
    if (last) out.push(...last.reverse());
    for (let i = matrix.length - 1; i >= 0; i--) {
      const value = matrix[i]!.shift();
      if (value !== undefined) out.push(value);
    }
  }
  return out;
}

/** Caesar cipher: shift each letter LEFT by n. */
function caesarCipher(data: unknown): string {
  const [text, shift] = data as [string, number];
  return text
    .split("")
    .map((char) => {
      if (char < "A" || char > "Z") return char;
      const code = char.charCodeAt(0) - 65;
      return String.fromCharCode(((code - shift + 26) % 26) + 65);
    })
    .join("");
}

/** Vigenère cipher. */
function vigenereCipher(data: unknown): string {
  const [text, keyword] = data as [string, string];
  return text
    .split("")
    .map((char, index) => {
      if (char < "A" || char > "Z") return char;
      const shift = keyword.charCodeAt(index % keyword.length) - 65;
      return String.fromCharCode(((char.charCodeAt(0) - 65 + shift) % 26) + 65);
    })
    .join("");
}

/** Every solver, keyed by the game's contract type string. */
export const SOLVERS: Record<string, ContractSolver> = {
  "Subarray with Maximum Sum": maxSubarraySum,
  "Array Jumping Game": arrayJumpingGame,
  "Array Jumping Game II": arrayJumpingGameII,
  "Merge Overlapping Intervals": mergeOverlappingIntervals,
  "Unique Paths in a Grid I": uniquePathsI,
  "Unique Paths in a Grid II": uniquePathsII,
  "Total Ways to Sum": totalWaysToSum,
  "Total Ways to Sum II": totalWaysToSumII,
  "Algorithmic Stock Trader I": (data) => stockTraderI(data),
  "Algorithmic Stock Trader II": (data) => stockTraderII(data),
  "Algorithmic Stock Trader III": (data) => stockTraderK(data as number[], 2),
  "Algorithmic Stock Trader IV": (data) => {
    const [k, prices] = data as [number, number[]];
    return stockTraderK(prices, k);
  },
  "Minimum Path Sum in a Triangle": minimumPathSumTriangle,
  "Find Largest Prime Factor": largestPrimeFactor,
  "Spiralize Matrix": spiralizeMatrix,
  "Encryption I: Caesar Cipher": caesarCipher,
  "Encryption II: Vigenère Cipher": vigenereCipher,
};

/** Solve one contract, or `undefined` when the type is unknown.
 *
 * `undefined` rather than a guess is the whole contract: a wrong answer burns
 * one of three tries and the third destroys the contract, so not attempting is
 * strictly better than attempting badly. */
export function solve(type: string, data: unknown): unknown {
  const solver = SOLVERS[type];
  if (!solver) return undefined;
  try {
    return solver(data);
  } catch {
    // A solver that throws on malformed data must not take the driver down,
    // and must not submit a partial answer either.
    return undefined;
  }
}

export function canSolve(type: string): boolean {
  return type in SOLVERS;
}

// --- infiltration -----------------------------------------------------------

export interface InfiltrationTarget {
  location: string;
  city: string;
  difficulty: number;
  maxClearanceLevel: number;
  repReward: number;
  moneyReward: number;
}

/** Rank infiltration targets by reward per REAL-TIME MINUTE.
 *
 * Difficulty and clearance level both drive how long a run takes and how
 * likely it is to fail, so raw reward is the wrong ranking — a lucrative
 * target that cannot be cleared is worth nothing. */
export function rankInfiltrations(
  targets: readonly InfiltrationTarget[],
  /** How much the run values reputation against money. */
  repWeight = 1,
): (InfiltrationTarget & { valuePerMinute: number })[] {
  return targets
    .map((target) => {
      // Each clearance level is one minigame; difficulty scales failure odds.
      const minutes = Math.max(0.5, (target.maxClearanceLevel * (1 + target.difficulty)) / 6);
      const value = target.moneyReward + target.repReward * repWeight;
      return { ...target, valuePerMinute: value / minutes };
    })
    .sort((a, b) => b.valuePerMinute - a.valuePerMinute || (a.location < b.location ? -1 : 1));
}
