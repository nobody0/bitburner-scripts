/** `DeepGreen` and `RateMyPix.Auth`: two models, one attack.
 *
 * Both answer with a COUNT of how many characters we placed exactly right, and
 * nothing about which ones. `DeepGreen` dresses it up as Mastermind and adds a
 * misplaced-character count; `RateMyPix.Auth` renders it as a row of chillies.
 * Neither says where.
 *
 * The naive reading is that a count is nearly useless — and it would be, if we
 * had to send plausible passwords. We do not. **The attempt is unconstrained**:
 * nothing requires it to be the right length or drawn from the password's
 * alphabet. So pick a BLANK symbol that cannot occur in the password, and a
 * count becomes a group test:
 *
 *     "5~~~~~"  ->  "is position 0 a 5?"
 *     "55~~~~"  ->  "how many of positions 0 and 1 are 5?"
 *
 * That turns an opaque scalar into a binary search, and the whole password falls
 * out in roughly `alphabet + L*log2(L)` exchanges rather than the `10^L` a
 * Mastermind solver over plausible candidates would face. `DeepGreen` reaches
 * length 10, where that difference is 43 exchanges against ten billion.
 *
 * The first phase is free of ambiguity for a reason worth stating: against an
 * all-`s` attempt the misplaced count is provably 0, because upstream computes
 * it over the characters that did NOT match in place, and every remaining
 * password character is by definition not `s`. So the exact count is clean.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/authentication.ts:34-42 (Mastermind), 58-66 (spice)
 *   src/DarkNet/utils/darknetAuthUtils.ts:21-51 (the counting) */

import type { ModelId, PasswordFacts } from "../models.ts";
import { LETTERS, NUMBERS } from "../codecs.ts";
import { alphabetFor } from "./search.ts";
import {
  SOLVER_CODES,
  freshState,
  type Solver,
  type SolverObservation,
  type SolverState,
  type SolverStep,
} from "./types.ts";

/** A character that cannot appear in a generated password, so its positions are
 * guaranteed misses. Every generator draws from digits and letters
 * (`getPassword`), so any punctuation does — and `~` survives a JSON round trip
 * through the log ring without escaping, which `"` and `\` would not. */
const BLANK = "~";

/** A pending split: we asked how many of `left` hold `symbol`, and `right` gets
 * whatever is left over from `count`. */
interface Split {
  symbol: string;
  left: number[];
  right: number[];
  count: number;
}

interface Task {
  symbol: string;
  positions: number[];
  count: number;
}

/** How many characters we placed exactly right, out of one model's rendering. */
type ReadCount = (seen: SolverObservation) => number | undefined;

/** `DeepGreen`: `data` is `"<exact>,<misplaced>"`. Only the first half is used —
 * the misplaced count is real information, but the group test does not need it
 * and mixing the two would make the arithmetic harder to check. */
const readMastermindCount: ReadCount = (seen) => {
  const raw = (seen.oracle?.data ?? "").trim();
  // `Number("")` is 0 and `Number.isInteger(0)` is true, so an absent or empty
  // payload would otherwise read as a CONFIDENT count of zero — every group
  // would record "no matches", the search would exhaust, and it would blame the
  // reported format for a payload that was never there. `readSpiceCount` below
  // guards the same case.
  if (raw.length === 0) return undefined;
  const comma = raw.indexOf(",");
  const head = comma === -1 ? raw : raw.slice(0, comma).trim();
  if (head.length === 0) return undefined;
  const value = Number(head);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
};

/** `RateMyPix.Auth`: `data` is `"<chillies>/<length>"`, one chilli per
 * exactly-correct character — or the literal `"0"` when there are none, because
 * `[].join("") || "0"` is how upstream renders the empty case.
 *
 * The chilli is U+1F336 followed by U+FE0F, three UTF-16 units, so counting by
 * `.length` or by `[...str]` both get it wrong. Count the base code point. */
const readSpiceCount: ReadCount = (seen) => {
  const raw = (seen.oracle?.data ?? "").trim();
  if (raw.length === 0) return undefined;
  const slash = raw.lastIndexOf("/");
  const peppers = slash === -1 ? raw : raw.slice(0, slash);
  if (peppers === "0") return 0;
  let count = 0;
  for (const char of peppers) if (char === "\u{1F336}") count++;
  return count;
};

/** Build the attempt that asks "how many of `positions` hold `symbol`?" */
function probe(symbol: string, positions: readonly number[], length: number): string {
  const chars = new Array<string>(length).fill(BLANK);
  for (const at of positions) if (at >= 0 && at < length) chars[at] = symbol;
  return chars.join("");
}

function groupTestSolver(model: ModelId, readCount: ReadCount): Solver {
  return {
    needsOracle: true,

    budget: (facts) => {
      const length = facts.passwordLength ?? 8;
      const alphabet = alphabetFor(facts).length;
      // One pass over the alphabet to get the counts, then a binary split per
      // character per position.
      return alphabet + length * Math.ceil(Math.log2(Math.max(2, length))) + length + 4;
    },

    first(facts): SolverStep {
      const length = facts.passwordLength;
      if (length === undefined || length < 1) {
        return { kind: "give-up", code: SOLVER_CODES.OracleUnparsed, reason: `${model}: needs passwordLength` };
      }
      const alphabet = alphabetFor(facts);
      const state = freshState(model, facts, "counts");
      state.scratch["symbolIndex"] = 0;
      state.scratch["counts"] = {};
      state.scratch["solved"] = new Array<string | null>(length).fill(null);
      return {
        kind: "attempt",
        password: alphabet[0]!.repeat(length),
        state,
        needsOracle: true,
        note: `counting ${JSON.stringify(alphabet[0])}`,
      };
    },

    next(facts, state, seen): SolverStep {
      if (seen.success) return { kind: "answer", password: seen.attempted, note: `${model}: opened` };
      if (!seen.oracle) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.OracleUnavailable,
          reason: `${model}: needs the log ring, which was not readable`,
          state,
        };
      }
      const observed = readCount(seen);
      if (observed === undefined) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.OracleUnparsed,
          reason: `${model}: response ${JSON.stringify(seen.oracle.data ?? "")} carries no exact-match count`,
        };
      }
      const length = (state.scratch["solved"] as (string | null)[]).length;
      const alphabet = alphabetFor(facts);

      if (state.phase === "counts") return afterCount(model, state, seen, observed, alphabet, length);
      return afterSplit(model, state, observed, length);
    },
  };
}

/** Phase one: how many of each symbol the password holds. */
function afterCount(
  model: ModelId,
  state: SolverState,
  seen: SolverObservation,
  observed: number,
  alphabet: string,
  length: number,
): SolverStep {
  const symbol = seen.attempted[0] ?? "";
  const counts = { ...(state.scratch["counts"] as Record<string, number>) };
  if (observed > 0) counts[symbol] = observed;

  const placed = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const symbolIndex = Number(state.scratch["symbolIndex"] ?? 0) + 1;

  // Stop early the moment the counts account for every position — there is no
  // reason to ask about the rest of the alphabet.
  if (placed >= length || symbolIndex >= alphabet.length) {
    if (placed < length) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.SolverExhausted,
        reason:
          `${model}: the ${alphabet.length}-symbol alphabet accounts for only ${placed} of ${length} positions,`
          + " so the password holds something outside the reported format",
      };
    }
    return beginLocating(model, state, counts, length);
  }
  return {
    kind: "attempt",
    password: alphabet[symbolIndex]!.repeat(length),
    state: { ...state, spent: state.spent + 1, scratch: { ...state.scratch, symbolIndex, counts } },
    needsOracle: true,
    note: `counting ${JSON.stringify(alphabet[symbolIndex])}`,
  };
}

/** Turn the counts into a queue of "which of these positions hold this symbol?"
 * and ask the first one. */
function beginLocating(
  model: ModelId,
  state: SolverState,
  counts: Record<string, number>,
  length: number,
): SolverStep {
  const all = Array.from({ length }, (_, i) => i);
  const queue: Task[] = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([symbol, count]) => ({ symbol, positions: all, count }));
  const solved = new Array<string | null>(length).fill(null);
  return advance(model, { ...state, phase: "locate" }, queue, solved, length);
}

/** Phase two: resolve one pending split, then ask the next question. */
function afterSplit(model: ModelId, state: SolverState, observed: number, length: number): SolverStep {
  const split = state.scratch["split"] as Split | undefined;
  const queue = [...(state.scratch["queue"] as Task[])];
  const solved = [...(state.scratch["solved"] as (string | null)[])];
  if (!split) {
    return {
      kind: "give-up",
      code: SOLVER_CODES.SolverStalled,
      reason: `${model}: a split response arrived with no split outstanding`,
      state,
    };
  }
  if (observed > split.count || observed > split.left.length) {
    return {
      kind: "give-up",
      code: SOLVER_CODES.OracleUnparsed,
      reason: `${model}: reported ${observed} matches among ${split.left.length} positions holding at most ${split.count}`,
    };
  }
  queue.push({ symbol: split.symbol, positions: split.left, count: observed });
  queue.push({ symbol: split.symbol, positions: split.right, count: split.count - observed });
  return advance(model, state, queue, solved, length);
}

/** Drain everything the queue can settle without asking, then ask about the
 * first thing it cannot. */
function advance(
  model: ModelId,
  state: SolverState,
  queue: Task[],
  solved: (string | null)[],
  length: number,
): SolverStep {
  const pending = [...queue];
  while (pending.length > 0) {
    const task = pending.shift()!;
    // Nothing of this symbol here, or every position here is this symbol:
    // either way there is nothing to ask.
    if (task.count === 0) continue;
    if (task.count === task.positions.length) {
      for (const at of task.positions) solved[at] = task.symbol;
      continue;
    }
    if (task.positions.length <= 1) continue;

    const half = Math.ceil(task.positions.length / 2);
    const split: Split = {
      symbol: task.symbol,
      left: task.positions.slice(0, half),
      right: task.positions.slice(half),
      count: task.count,
    };
    return {
      kind: "attempt",
      password: probe(task.symbol, split.left, length),
      state: {
        ...state,
        phase: "locate",
        spent: state.spent + 1,
        scratch: { ...state.scratch, queue: pending, solved, split },
      },
      needsOracle: true,
      note: `locating ${JSON.stringify(task.symbol)} among ${split.left.length} positions`,
    };
  }

  if (solved.every((char) => char !== null)) {
    return { kind: "answer", password: solved.join(""), note: `${model}: every position located` };
  }
  return {
    kind: "give-up",
    code: SOLVER_CODES.SolverStalled,
    reason: `${model}: the search settled with ${solved.filter((c) => c === null).length} positions unresolved`,
    state,
  };
}

/** The blank symbol, exported so a test can assert it stays outside every
 * alphabet a password can be drawn from. */
export const GROUP_BLANK = BLANK;

export function blankIsSafe(): boolean {
  return !NUMBERS.includes(BLANK) && !LETTERS.includes(BLANK);
}

export const GROUP_SOLVERS = {
  mastermind: groupTestSolver("DeepGreen", readMastermindCount),
  spiceLevel: groupTestSolver("RateMyPix.Auth", readSpiceCount),
} as const;
