/** Coding-contract solvers.
 *
 * The strongest evidence in the whole roster, and the reason is structural:
 * every contract type has a KNOWN CORRECT ANSWER, so solver correctness is
 * checked against the game's validators over generated instances rather than
 * measured against a baseline.
 * Nothing else in the project gets to say that.
 *
 * The registry is keyed by the contract type string the game reports. An
 * unknown type returns `undefined` — never a guess — because a wrong answer
 * costs a try, and some contracts allow only one.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/CodingContract/ContractTypes.ts */

export type ContractSolver = (data: unknown) => unknown;

/** Bump after changing answer behavior so a hot handoff releases contracts
 * quarantined by an older solver build. */
export const CONTRACT_SOLVER_VERSION = 1;

/** Local work stays broad enough to drain efficiently; telemetry carries only
 * the front batch plus totals. Keep these limits shared so probe and driver
 * cannot silently disagree. */
export const CONTRACT_BATCH_SIZE = 20;
export const CONTRACT_QUEUE_LIMIT = 100;
export const CONTRACT_REPORT_LIMIT = CONTRACT_BATCH_SIZE;

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
  if (values.length <= 1) return 0;
  let jumps = 0;
  let edge = 0;
  let reach = 0;
  for (let i = 0; i < values.length - 1; i++) {
    if (i > reach) return 0;
    reach = Math.max(reach, i + values[i]!);
    if (i !== edge) continue;
    jumps++;
    edge = reach;
    if (edge >= values.length - 1) return jumps;
  }
  return 0;
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
  const cols = grid[0]?.length ?? 0;
  const ways = new Array<number>(cols).fill(0);
  ways[0] = 1;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r]![c] === 1) ways[c] = 0;
      else if (c > 0) ways[c] = ways[c]! + ways[c - 1]!;
    }
  }
  return ways[cols - 1] ?? 0;
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

/** Matrix entries in clockwise spiral order. */
function spiralizeMatrix(data: unknown): number[] {
  const matrix = data as number[][];
  const out: number[] = [];
  let top = 0;
  let bottom = matrix.length - 1;
  let left = 0;
  let right = (matrix[0]?.length ?? 0) - 1;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) out.push(matrix[top]![c]!);
    top++;
    for (let r = top; r <= bottom; r++) out.push(matrix[r]![right]!);
    right--;
    if (top <= bottom) {
      for (let c = right; c >= left; c--) out.push(matrix[bottom]![c]!);
      bottom--;
    }
    if (left <= right) {
      for (let r = bottom; r >= top; r--) out.push(matrix[r]![left]!);
      left++;
    }
  }
  return out;
}

/** All valid four-octet renderings of a digit string. */
function generateIPAddresses(data: unknown): string[] {
  const digits = data as string;
  const out: string[] = [];
  const valid = (part: string): boolean => part.length === 1 || (part[0] !== "0" && Number(part) <= 255);
  for (let a = 1; a <= 3; a++) {
    for (let b = 1; b <= 3; b++) {
      for (let c = 1; c <= 3; c++) {
        const d = digits.length - a - b - c;
        if (d < 1 || d > 3) continue;
        const parts = [digits.slice(0, a), digits.slice(a, a + b), digits.slice(a + b, a + b + c), digits.slice(-d)];
        if (parts.every(valid)) out.push(parts.join("."));
      }
    }
  }
  return out;
}

/** One shortest UDLR path through a zero-cell grid. */
function shortestPathInGrid(data: unknown): string {
  const grid = data as number[][];
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return "";
  const end = rows * cols - 1;
  const parent = new Int32Array(rows * cols).fill(-1);
  const move = new Array<string>(rows * cols);
  const queue = new Int32Array(rows * cols);
  const directions: readonly [number, number, string][] = [[-1, 0, "U"], [1, 0, "D"], [0, -1, "L"], [0, 1, "R"]];
  let head = 0;
  let tail = 1;
  queue[0] = 0;
  parent[0] = 0;
  while (head < tail && parent[end] === -1) {
    const at = queue[head++]!;
    const r = Math.floor(at / cols);
    const c = at % cols;
    for (const [dr, dc, letter] of directions) {
      const nr = r + dr;
      const nc = c + dc;
      const next = nr * cols + nc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols || grid[nr]![nc] !== 0 || parent[next] !== -1) continue;
      parent[next] = at;
      move[next] = letter;
      queue[tail++] = next;
    }
  }
  if (parent[end] === -1) return "";
  const path: string[] = [];
  for (let at = end; at !== 0; at = parent[at]!) path.push(move[at]!);
  return path.reverse().join("");
}

/** Every minimally edited valid-parenthesis expression. */
function sanitizeParentheses(data: unknown): string[] {
  const text = data as string;
  let removeLeft = 0;
  let removeRight = 0;
  for (const char of text) {
    if (char === "(") removeLeft++;
    else if (char === ")" && removeLeft > 0) removeLeft--;
    else if (char === ")") removeRight++;
  }
  const out = new Set<string>();
  const visit = (index: number, balance: number, left: number, right: number, built: string): void => {
    if (text.length - index < left + right) return;
    if (index === text.length) {
      if (balance === 0 && left === 0 && right === 0) out.add(built);
      return;
    }
    const char = text[index]!;
    if (char === "(") {
      if (left > 0) visit(index + 1, balance, left - 1, right, built);
      visit(index + 1, balance + 1, left, right, built + char);
    } else if (char === ")") {
      if (right > 0) visit(index + 1, balance, left, right - 1, built);
      if (balance > 0) visit(index + 1, balance - 1, left, right, built + char);
    } else visit(index + 1, balance, left, right, built + char);
  };
  visit(0, 0, removeLeft, removeRight, "");
  return [...out];
}

/** Insert +, -, and * between digits to hit a target. */
function validMathExpressions(data: unknown): string[] {
  const [digits, target] = data as [string, number];
  const out: string[] = [];
  const visit = (index: number, expression: string, total: number, term: number): void => {
    if (index === digits.length) {
      if (total === target) out.push(expression);
      return;
    }
    for (let end = index; end < digits.length && (end === index || digits[index] !== "0"); end++) {
      const token = digits.slice(index, end + 1);
      const value = Number(token);
      if (index === 0) visit(end + 1, token, value, value);
      else {
        visit(end + 1, `${expression}+${token}`, total + value, value);
        visit(end + 1, `${expression}-${token}`, total - value, -value);
        visit(end + 1, `${expression}*${token}`, total - term + term * value, term * value);
      }
    }
  };
  visit(0, "", 0, 0);
  return out;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/** The game's extended Hamming layout, including its historical bit order. */
function hammingEncode(data: unknown): string {
  const source = (data as number).toString(2);
  const bits: number[] = [0];
  let read = 0;
  for (let position = 1; read < source.length; position++) {
    if (isPowerOfTwo(position)) bits[position] = 0;
    else bits[position] = Number(source[read++]!);
  }
  let syndrome = 0;
  for (let i = 1; i < bits.length; i++) if (bits[i]) syndrome ^= i;
  for (let parity = 1; parity < bits.length; parity *= 2) bits[parity] = syndrome & parity ? 1 : 0;
  bits[0] = bits.reduce((ones, bit) => ones + bit, 0) % 2;
  return bits.join("");
}

function hammingDecode(data: unknown): number {
  const bits = [...(data as string)].map(Number);
  let syndrome = 0;
  for (let i = 1; i < bits.length; i++) if (bits[i]) syndrome ^= i;
  if (syndrome > 0 && syndrome < bits.length) bits[syndrome] = bits[syndrome] ? 0 : 1;
  let binary = "";
  for (let i = 1; i < bits.length; i++) if (!isPowerOfTwo(i)) binary += bits[i];
  return Number.parseInt(binary, 2);
}

/** A coloring for every component, or [] when the graph is not bipartite. */
function properTwoColoring(data: unknown): number[] {
  const [count, edges] = data as [number, [number, number][]];
  const adjacent = Array.from({ length: count }, () => [] as number[]);
  for (const [a, b] of edges) {
    adjacent[a]!.push(b);
    adjacent[b]!.push(a);
  }
  const colors = new Array<number>(count).fill(-1);
  const queue = new Int32Array(count);
  for (let root = 0; root < count; root++) {
    if (colors[root] !== -1) continue;
    let head = 0;
    let tail = 1;
    queue[0] = root;
    colors[root] = 0;
    while (head < tail) {
      const vertex = queue[head++]!;
      for (const neighbor of adjacent[vertex]!) {
        if (colors[neighbor] === -1) {
          colors[neighbor] = 1 - colors[vertex]!;
          queue[tail++] = neighbor;
        } else if (colors[neighbor] === colors[vertex]) return [];
      }
    }
  }
  return colors;
}

function rleCompress(data: unknown): string {
  const plain = data as string;
  let out = "";
  for (let start = 0; start < plain.length;) {
    let end = start + 1;
    while (end < plain.length && end - start < 9 && plain[end] === plain[start]) end++;
    out += `${end - start}${plain[start]}`;
    start = end;
  }
  return out;
}

function lzDecompress(data: unknown): string {
  const encoded = data as string;
  let plain = "";
  for (let i = 0; i < encoded.length;) {
    const literal = Number(encoded[i++]);
    plain += encoded.slice(i, i + literal);
    i += literal;
    if (i >= encoded.length) break;
    const length = Number(encoded[i++]);
    if (length === 0) continue;
    const offset = Number(encoded[i++]);
    for (let j = 0; j < length; j++) plain += plain[plain.length - offset];
  }
  return plain;
}

/** Shortest valid encoding via a four-state suffix dynamic program. */
function lzCompress(data: unknown): string {
  const plain = data as string;
  const memo = new Map<string, string | null>();
  const better = (best: string | undefined, candidate: string): string =>
    best === undefined || candidate.length < best.length || (candidate.length === best.length && candidate < best)
      ? candidate
      : best;
  const encode = (at: number, literal: boolean, maySkip: boolean): string | undefined => {
    if (at === plain.length) return "";
    const key = `${at}:${literal ? 1 : 0}:${maySkip ? 1 : 0}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached ?? undefined;
    let best: string | undefined;
    if (maySkip) {
      const suffix = encode(at, !literal, false);
      if (suffix !== undefined) best = `0${suffix}`;
    }
    if (literal) {
      for (let length = 1; length <= 9 && at + length <= plain.length; length++) {
        const suffix = encode(at + length, false, true);
        if (suffix !== undefined) best = better(best, `${length}${plain.slice(at, at + length)}${suffix}`);
      }
    } else {
      for (let offset = 1; offset <= 9 && offset <= at; offset++) {
        for (let length = 1; length <= 9 && at + length <= plain.length; length++) {
          let valid = true;
          for (let j = 0; j < length; j++) {
            if (plain[at + j] !== plain[at + j - offset]) { valid = false; break; }
          }
          if (!valid) break;
          const suffix = encode(at + length, true, true);
          if (suffix !== undefined) best = better(best, `${length}${offset}${suffix}`);
        }
      }
    }
    memo.set(key, best ?? null);
    return best;
  };
  return encode(0, true, true) ?? "";
}

function nearestSquareRoot(data: unknown): bigint {
  const value = data as bigint;
  if (value < 2n) return value;
  let root = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const next = (root + value / root) >> 1n;
    if (next >= root) break;
    root = next;
  }
  const upper = root + 1n;
  return value - root * root < upper * upper - value ? root : upper;
}

/** Segmented sieve over the game's at-most-one-million-wide interval. */
function totalPrimes(data: unknown): number {
  let [low, high] = data as [number, number];
  low = Math.max(low, 2);
  if (low > high) return 0;
  const limit = Math.floor(Math.sqrt(high));
  const composite = new Uint8Array(limit + 1);
  const primes: number[] = [];
  for (let n = 2; n <= limit; n++) {
    if (composite[n]) continue;
    primes.push(n);
    if (n * n <= limit) for (let multiple = n * n; multiple <= limit; multiple += n) composite[multiple] = 1;
  }
  const range = new Uint8Array(high - low + 1);
  for (const prime of primes) {
    for (let multiple = Math.max(prime * prime, Math.ceil(low / prime) * prime); multiple <= high; multiple += prime) {
      range[multiple - low] = 1;
    }
  }
  let count = 0;
  for (const marked of range) if (!marked) count++;
  return count;
}

/** Largest all-zero rectangle via one monotonic-stack pass per row. */
function largestRectangle(data: unknown): number[][] {
  const grid = data as number[][];
  const cols = grid[0]?.length ?? 0;
  const heights = new Array<number>(cols).fill(0);
  let bestArea = 0;
  let answer = [[0, 0], [0, 0]];
  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < cols; col++) heights[col] = grid[row]![col] === 0 ? heights[col]! + 1 : 0;
    const stack: number[] = [];
    for (let col = 0; col <= cols; col++) {
      const height = col === cols ? 0 : heights[col]!;
      while (stack.length > 0 && heights[stack[stack.length - 1]!]! > height) {
        const index = stack.pop()!;
        const left = (stack[stack.length - 1] ?? -1) + 1;
        const area = heights[index]! * (col - left);
        if (area > bestArea) {
          bestArea = area;
          answer = [[row - heights[index]! + 1, left], [row, col - 1]];
        }
      }
      stack.push(col);
    }
  }
  return answer;
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
export const SOLVERS: Readonly<Record<string, ContractSolver>> = {
  "Subarray with Maximum Sum": maxSubarraySum,
  "Array Jumping Game": arrayJumpingGame,
  "Array Jumping Game II": arrayJumpingGameII,
  "Merge Overlapping Intervals": mergeOverlappingIntervals,
  "Generate IP Addresses": generateIPAddresses,
  "Unique Paths in a Grid I": uniquePathsI,
  "Unique Paths in a Grid II": uniquePathsII,
  "Shortest Path in a Grid": shortestPathInGrid,
  "Sanitize Parentheses in Expression": sanitizeParentheses,
  "Find All Valid Math Expressions": validMathExpressions,
  "Total Ways to Sum": totalWaysToSum,
  "Total Ways to Sum II": totalWaysToSumII,
  "Algorithmic Stock Trader I": stockTraderI,
  "Algorithmic Stock Trader II": stockTraderII,
  "Algorithmic Stock Trader III": (data) => stockTraderK(data as number[], 2),
  "Algorithmic Stock Trader IV": (data) => {
    const [k, prices] = data as [number, number[]];
    return stockTraderK(prices, k);
  },
  "Minimum Path Sum in a Triangle": minimumPathSumTriangle,
  "Find Largest Prime Factor": largestPrimeFactor,
  "Spiralize Matrix": spiralizeMatrix,
  "HammingCodes: Integer to Encoded Binary": hammingEncode,
  "HammingCodes: Encoded Binary to Integer": hammingDecode,
  "Proper 2-Coloring of a Graph": properTwoColoring,
  "Compression I: RLE Compression": rleCompress,
  "Compression II: LZ Decompression": lzDecompress,
  "Compression III: LZ Compression": lzCompress,
  "Encryption I: Caesar Cipher": caesarCipher,
  "Encryption II: Vigenère Cipher": vigenereCipher,
  "Square Root": nearestSquareRoot,
  "Total Number of Primes": totalPrimes,
  "Largest Rectangle in a Matrix": largestRectangle,
};

/** Solve one contract, or `undefined` when the type is unknown.
 *
 * `undefined` rather than a guess is the whole contract: a wrong answer burns
 * a try and some types self-destruct after the first miss, so not attempting
 * is strictly better than attempting badly. */
export function solve(type: string, data: unknown): unknown {
  if (!Object.hasOwn(SOLVERS, type)) return undefined;
  const solver = SOLVERS[type];
  try {
    return solver!(data);
  } catch {
    // A solver that throws on malformed data must not take the driver down,
    // and must not submit a partial answer either.
    return undefined;
  }
}

export function canSolve(type: string): boolean {
  return Object.hasOwn(SOLVERS, type);
}
