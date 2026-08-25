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

/** Local work stays broad enough to drain efficiently; telemetry carries only
 * the front batch plus totals. Keep these limits shared so probe and driver
 * cannot silently disagree. */
export const CONTRACT_BATCH_SIZE = 20;
export const CONTRACT_QUEUE_LIMIT = 100;
export const CONTRACT_REPORT_LIMIT = CONTRACT_BATCH_SIZE;
/** Recent solves retained as examples. Sized to one batch so the ring is never
 * a lossy sample of a SINGLE driver tick; the per-origin totals are the
 * census. */
export const CONTRACT_SOLVE_RING = CONTRACT_BATCH_SIZE;

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

/** 0! through 26!: the v3.0.1 generator caps both dimensions at 14. */
const UNIQUE_PATH_FACTORIALS: readonly bigint[] = [
  1n, 1n, 2n, 6n, 24n, 120n, 720n, 5040n, 40320n, 362880n,
  3628800n, 39916800n, 479001600n, 6227020800n, 87178291200n,
  1307674368000n, 20922789888000n, 355687428096000n,
  6402373705728000n, 121645100408832000n, 2432902008176640000n,
  51090942171709440000n, 1124000727777607680000n,
  25852016738884976640000n, 620448401733239439360000n,
  15511210043330985984000000n, 403291461126605635584000000n,
];

/** Unique paths through the game's at-most-14 x 14 grid. */
function uniquePathsI(data: unknown): number {
  const [rows, cols] = data as [number, number];
  const rowSteps = rows - 1;
  const colSteps = cols - 1;
  return Number(
    UNIQUE_PATH_FACTORIALS[rowSteps + colSteps]!
    / (UNIQUE_PATH_FACTORIALS[rowSteps]! * UNIQUE_PATH_FACTORIALS[colSteps]!),
  );
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

/** p(n) - 1 through n=100, the v3.0.1 generator's exact ceiling.
 * Slot zero preserves the previous solver's out-of-generator result. */
const TOTAL_WAYS_TO_SUM: readonly number[] = [
  1, 0, 1, 2, 4, 6, 10, 14, 21, 29, 41, 55, 76, 100, 134, 175, 230, 296, 384, 489,
  626, 791, 1001, 1254, 1574, 1957, 2435, 3009, 3717, 4564, 5603, 6841, 8348, 10142,
  12309, 14882, 17976, 21636, 26014, 31184, 37337, 44582, 53173, 63260, 75174, 89133,
  105557, 124753, 147272, 173524, 204225, 239942, 281588, 329930, 386154, 451275,
  526822, 614153, 715219, 831819, 966466, 1121504, 1300155, 1505498, 1741629, 2012557,
  2323519, 2679688, 3087734, 3554344, 4087967, 4697204, 5392782, 6185688, 7089499,
  8118263, 9289090, 10619862, 12132163, 13848649, 15796475, 18004326, 20506254,
  23338468, 26543659, 30167356, 34262961, 38887672, 44108108, 49995924, 56634172,
  64112358, 72533806, 82010176, 92669719, 104651418, 118114303, 133230929, 150198135,
  169229874, 190569291,
];

/** Total ways to sum to n using smaller positive integers. */
function totalWaysToSum(data: unknown): number {
  const target = data as number;
  return TOTAL_WAYS_TO_SUM[target]!;
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
  while (n % 2 === 0) {
    largest = 2;
    n /= 2;
  }
  while (n % 3 === 0) {
    largest = 3;
    n /= 3;
  }
  // Every prime above three is 6k - 1 or 6k + 1.
  for (let factor = 5, step = 2; factor * factor <= n; factor += step, step = 6 - step) {
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

/** Insert +, -, and * between digits to hit a target.
 *
 * The contract asks for every expression, and twelve digits admit 4^11 of them,
 * so this is a search and the cost is per-node. Three things hold it down.
 *
 * Nothing is rendered on the way down: each token's inclusive end and the
 * operator in front of it pack into one preallocated slot, and a string is built
 * only for an accepting leaf, of which a target in [-100, 100] admits very few.
 *
 * The last two digits are resolved where they are reached rather than by
 * recursive calls into a base case, which removes the call overhead from the two
 * widest levels of the tree.
 *
 * And a reach bound prunes whole subtrees. `*` rescales only the CURRENT term —
 * it can never touch a total that earlier terms already committed — so the
 * amount a suffix can still move the running total is bounded, by
 * `reachA[i] + |term| * reachB[i]`. Once the running total has drifted further
 * from the target than the remaining digits can pull it back, the subtree is
 * dead. That is about half of all node entries on a twelve-digit instance. */
function validMathExpressions(data: unknown): string[] {
  const [digits, target] = data as [string, number];
  const length = digits.length;
  const out: string[] = [];
  if (length === 0) return out;
  const values = new Int32Array(length);
  for (let i = 0; i < length; i++) values[i] = digits.charCodeAt(i) - 48;
  // path[depth] packs the token's inclusive end index with the operator in
  // front of it (0 = "+", 1 = "-", 2 = "*"); depth 0 carries no operator.
  const path = new Int32Array(length);
  const OPERATORS = "+-*";

  // reachA[i] + T * reachB[i] bounds how far digits[i..] can still move the
  // total, given the current term has magnitude T. Taking the token at i with
  // value v: "+v" and "-v" move by at most v and hand v on as the next term,
  // while "*v" moves by at most T * |v - 1| and hands on T * v. Maximising each
  // coefficient separately over every token length keeps the bound linear in T,
  // which is all that is needed for it to be sound.
  const reachA = new Float64Array(length + 1);
  const reachB = new Float64Array(length + 1);
  for (let i = length - 1; i >= 0; i--) {
    const last = values[i] === 0 ? i : length - 1;
    let value = 0;
    let boundA = 0;
    let boundB = 0;
    for (let end = i; end <= last; end++) {
      value = value * 10 + values[end]!;
      const carried = reachB[end + 1]!;
      const additive = value + reachA[end + 1]! + value * carried;
      const scaling = (value >= 1 ? value - 1 : 1) + value * carried;
      if (additive > boundA) boundA = additive;
      if (scaling > boundB) boundB = scaling;
    }
    reachA[i] = boundA;
    reachB[i] = boundB;
  }

  const render = (depth: number): string => {
    let expression = digits.slice(0, (path[0]! >> 2) + 1);
    for (let d = 1; d < depth; d++) {
      const packed = path[d]!;
      expression += OPERATORS[packed & 3]! + digits.slice((path[d - 1]! >> 2) + 1, (packed >> 2) + 1);
    }
    return expression;
  };
  /** A token that closes the expression: its three operators are three leaves. */
  const close = (depth: number, span: number, total: number, term: number, value: number): void => {
    if (total + value === target) { path[depth] = span; out.push(render(depth + 1)); }
    if (total - value === target) { path[depth] = span | 1; out.push(render(depth + 1)); }
    if (total - term + term * value === target) { path[depth] = span | 2; out.push(render(depth + 1)); }
  };
  const tail = values[length - 1]!;
  const tailSpan = (length - 1) << 2;

  const visit = (index: number, depth: number, total: number, term: number): void => {
    const gap = target - total;
    const reach = reachA[index]! + (term < 0 ? -term : term) * reachB[index]!;
    if (gap > reach || -gap > reach) return;
    // A token may not carry a leading zero, so a zero here stands alone.
    const last = values[index] === 0 ? index : length - 1;
    let value = 0;
    for (let end = index; end <= last; end++) {
      value = value * 10 + values[end]!;
      const span = end << 2;
      if (end + 1 === length) {
        // Inlined rather than routed through close(): this is the widest level
        // of the tree, so a call here costs more than the duplication does.
        if (total + value === target) { path[depth] = span; out.push(render(depth + 1)); }
        if (total - value === target) { path[depth] = span | 1; out.push(render(depth + 1)); }
        if (total - term + term * value === target) { path[depth] = span | 2; out.push(render(depth + 1)); }
      } else if (end + 2 === length) {
        // One digit will be left over, so both remaining levels resolve here.
        path[depth] = span;
        close(depth + 1, tailSpan, total + value, value, tail);
        path[depth] = span | 1;
        close(depth + 1, tailSpan, total - value, -value, tail);
        path[depth] = span | 2;
        close(depth + 1, tailSpan, total - term + term * value, term * value, tail);
      } else {
        path[depth] = span;
        visit(end + 1, depth + 1, total + value, value);
        path[depth] = span | 1;
        visit(end + 1, depth + 1, total - value, -value);
        path[depth] = span | 2;
        visit(end + 1, depth + 1, total - term + term * value, term * value);
      }
    }
  };

  // The first token carries no operator, so the top level is its own loop.
  const first = values[0] === 0 ? 0 : length - 1;
  let value = 0;
  for (let end = 0; end <= first; end++) {
    value = value * 10 + values[end]!;
    path[0] = end << 2;
    if (end + 1 === length) {
      if (value === target) out.push(render(1));
    } else if (end + 2 === length) close(1, tailSpan, value, value, tail);
    else visit(end + 1, 1, value, value);
  }
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

/** Shortest valid encoding via a four-state suffix dynamic program.
 *
 * The game accepts any encoding that round-trips and is no longer than its own
 * (`answer.length <= encoded.length && decode(answer) === plain`), so only the
 * LENGTH of the encoding is ever compared. That makes the value of a state an
 * integer rather than a string: the table prices every suffix state in
 * characters, and one forward walk renders the single winning encoding. The
 * older form carried candidate result strings through the memo and broke ties
 * lexicographically, which built and compared O(n^2) characters of strings to
 * decide something no validator looks at.
 */
const LZ_UNREACHABLE = 0x3fff_ffff;
/** State index for "encoding plain[at..], where the next chunk is a literal
 * or a back-reference, with or without a zero-length chunk still available". */
const LZ_LITERAL_SKIP = 3;
const LZ_LITERAL_ONLY = 2;
const LZ_REFERENCE_SKIP = 1;
const LZ_REFERENCE_ONLY = 0;

function lzCompress(data: unknown): string {
  const plain = data as string;
  const length = plain.length;
  if (length === 0) return "";
  const cost = new Int32Array((length + 1) * 4);
  for (let at = length - 1; at >= 0; at--) {
    // A literal chunk costs its length digit plus the characters it carries.
    let literalBest = LZ_UNREACHABLE;
    for (let run = 1; run <= 9 && at + run <= length; run++) {
      const total = 1 + run + cost[(at + run) * 4 + LZ_REFERENCE_SKIP]!;
      if (total < literalBest) literalBest = total;
    }
    // A back-reference costs two characters whatever its length, so only the
    // reachable lengths matter — and they extend while the copy still holds.
    let referenceBest = LZ_UNREACHABLE;
    for (let offset = 1; offset <= 9 && offset <= at; offset++) {
      for (let run = 1; run <= 9 && at + run <= length; run++) {
        if (plain[at + run - 1] !== plain[at + run - 1 - offset]) break;
        const total = 2 + cost[(at + run) * 4 + LZ_LITERAL_SKIP]!;
        if (total < referenceBest) referenceBest = total;
      }
    }
    // The zero-length chunk spends one character to swap the chunk type, and
    // cannot be spent twice in a row — so it reads the no-skip state opposite.
    const skipToReference = 1 + referenceBest;
    const skipToLiteral = 1 + literalBest;
    cost[at * 4 + LZ_LITERAL_ONLY] = literalBest;
    cost[at * 4 + LZ_REFERENCE_ONLY] = referenceBest;
    cost[at * 4 + LZ_LITERAL_SKIP] = skipToReference < literalBest ? skipToReference : literalBest;
    cost[at * 4 + LZ_REFERENCE_SKIP] = skipToLiteral < referenceBest ? skipToLiteral : referenceBest;
  }
  let out = "";
  let at = 0;
  let state = LZ_LITERAL_SKIP;
  while (at < length) {
    const target = cost[at * 4 + state]!;
    const literal = state === LZ_LITERAL_SKIP || state === LZ_LITERAL_ONLY;
    const maySkip = state === LZ_LITERAL_SKIP || state === LZ_REFERENCE_SKIP;
    if (maySkip && 1 + cost[at * 4 + (literal ? LZ_REFERENCE_ONLY : LZ_LITERAL_ONLY)]! === target) {
      out += "0";
      state = literal ? LZ_REFERENCE_ONLY : LZ_LITERAL_ONLY;
      continue;
    }
    let advanced = 0;
    if (literal) {
      for (let run = 1; run <= 9 && at + run <= length; run++) {
        if (1 + run + cost[(at + run) * 4 + LZ_REFERENCE_SKIP]! !== target) continue;
        out += `${run}${plain.slice(at, at + run)}`;
        advanced = run;
        state = LZ_REFERENCE_SKIP;
        break;
      }
    } else {
      for (let offset = 1; offset <= 9 && offset <= at && advanced === 0; offset++) {
        for (let run = 1; run <= 9 && at + run <= length; run++) {
          if (plain[at + run - 1] !== plain[at + run - 1 - offset]) break;
          if (2 + cost[(at + run) * 4 + LZ_LITERAL_SKIP]! !== target) continue;
          out += `${run}${offset}`;
          advanced = run;
          state = LZ_LITERAL_SKIP;
          break;
        }
      }
    }
    // The walk only follows transitions the table priced, so finding none means
    // table and walk disagree. Throwing is caught by solve(), which then makes
    // no attempt at all — strictly better than submitting a wrong encoding.
    if (advanced === 0) throw new Error("LZ reconstruction lost the priced path");
    at += advanced;
  }
  return out;
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

const PRIME_RANK_MAX = 6_000_000;
const PRIME_RANK_ODDS = ((PRIME_RANK_MAX - 3) >> 1) + 1;
const PRIME_RANK_WORDS = (PRIME_RANK_ODDS + 31) >> 5;

interface PrimeRank {
  /** One bit per odd integer from three: set means composite. */
  composites: Uint32Array;
  /** Number of odd primes in every complete preceding word. */
  prefix: Uint32Array;
}

let primeRank: PrimeRank | undefined;

function popcount32(value: number): number {
  value -= (value >>> 1) & 0x5555_5555;
  value = (value & 0x3333_3333) + ((value >>> 2) & 0x3333_3333);
  return (((value + (value >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
}

/** Build π(x) ranks once, only if this contract type is actually encountered.
 * v3.0.1 generates high <= 6,000,000, so odd-only bits plus one rank per word
 * cover the entire domain in about 750 KB. */
function buildPrimeRank(): PrimeRank {
  const composites = new Uint32Array(PRIME_RANK_WORDS);
  for (let index = 0;; index++) {
    const prime = 2 * index + 3;
    if (prime * prime > PRIME_RANK_MAX) break;
    if (composites[index >> 5]! & (1 << (index & 31))) continue;
    for (let multiple = (prime * prime - 3) >> 1; multiple < PRIME_RANK_ODDS; multiple += prime) {
      const word = multiple >> 5;
      composites[word] = composites[word]! | (1 << (multiple & 31));
    }
  }

  const prefix = new Uint32Array(PRIME_RANK_WORDS + 1);
  for (let word = 0; word < PRIME_RANK_WORDS; word++) {
    const valid = Math.min(32, PRIME_RANK_ODDS - word * 32);
    const mask = valid === 32 ? 0xffff_ffff : 0xffff_ffff >>> (32 - valid);
    prefix[word + 1] = prefix[word]! + valid - popcount32(composites[word]! & mask);
  }
  return { composites, prefix };
}

function primeCountAtMost(value: number, rank: PrimeRank): number {
  if (value < 2) return 0;
  if (value < 3) return 1;
  const slots = ((value - 3) >> 1) + 1;
  const word = slots >> 5;
  const remainder = slots & 31;
  let count = 1 + rank.prefix[word]!; // Include two by hand.
  if (remainder > 0) {
    const mask = 0xffff_ffff >>> (32 - remainder);
    count += remainder - popcount32(rank.composites[word]! & mask);
  }
  return count;
}

/** Number of primes in the game's bounded inclusive range. */
function totalPrimes(data: unknown): number {
  const [low, high] = data as [number, number];
  if (low > high) return 0;
  if (low < 0 || high > PRIME_RANK_MAX) throw new RangeError("prime range exceeds the v3.0.1 contract bounds");
  const rank = primeRank ??= buildPrimeRank();
  return primeCountAtMost(high, rank) - primeCountAtMost(low - 1, rank);
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
