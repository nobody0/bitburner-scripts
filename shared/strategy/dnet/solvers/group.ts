/** `DeepGreen` and `RateMyPix.Auth`: two related count attacks.
 *
 * Both answer with a COUNT of how many characters we placed exactly right, and
 * nothing about which ones. `DeepGreen` dresses it up as Mastermind and adds a
 * misplaced-character count; `RateMyPix.Auth` renders it as a row of chillies.
 * Neither says where. RateMyPix therefore uses the exact-count positional group
 * test below. DeepGreen's extra count is stronger: exact plus misplaced is the
 * multiset overlap, so it first packs several repeated symbols into one
 * 100-character probe and bisects only the groups that occur.
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
 * That turns an opaque scalar into a binary search rather than the `10^L` a
 * Mastermind solver over plausible candidates would face.
 *
 * The first phase is free of ambiguity for a reason worth stating: against an
 * all-`s` attempt the misplaced count is provably 0, because upstream computes
 * it over the characters that did NOT match in place, and every remaining
 * password character is by definition not `s`. So the exact count is clean.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/authentication.ts:34-42 (Mastermind), 58-66 (spice)
 *   src/DarkNet/utils/darknetAuthUtils.ts:21-51 (the counting) */

import type { ModelId } from "../models.ts";
import { LETTERS, NUMBERS } from "../codecs.ts";
import { fixedPositionsFromEvidence, prioritizeAlphabet } from "../evidence.ts";
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

/** `DeepGreen` reports exact and misplaced matches; their sum is multiset overlap. */
function readMastermindCounts(seen: SolverObservation): { exact: number; total: number } | undefined {
  const raw = (seen.oracle?.data ?? "").trim();
  const parts = raw.split(",");
  if (parts.length !== 2) return undefined;
  const exact = Number(parts[0]);
  const misplaced = Number(parts[1]);
  if (!Number.isInteger(exact) || exact < 0 || !Number.isInteger(misplaced) || misplaced < 0) return undefined;
  return { exact, total: exact + misplaced };
}

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
      // At most one pass over the alphabet to get counts (the last count is
      // inferred), then binary splits for every symbol except the fallback,
      // whose remaining positions are inferred.
      return alphabet + length * Math.ceil(Math.log2(Math.max(2, length))) + length + 4;
    },

    first(facts): SolverStep {
      const length = facts.passwordLength;
      if (length === undefined || length < 1) {
        return { kind: "give-up", code: SOLVER_CODES.OracleUnparsed, reason: `${model}: needs passwordLength` };
      }
      const alphabet = prioritizeAlphabet(alphabetFor(facts), facts.evidence);
      const state = freshState(model, facts, "counts");
      state.scratch["symbolIndex"] = 0;
      state.scratch["alphabet"] = alphabet;
      state.scratch["counts"] = {};
      const solved = fixedPositionsFromEvidence(length, facts.evidence).map((char) => char ?? null);
      state.scratch["solved"] = solved;
      if (solved.every((char) => char !== null)) {
        return { kind: "answer", password: solved.join(""), note: `${model}: every position came from harvested placement hints` };
      }
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
      const alphabet = String(state.scratch["alphabet"] ?? alphabetFor(facts));

      if (state.phase === "counts") return afterCount(model, state, seen, observed, alphabet, length);
      return afterSplit(model, state, observed, length);
    },
  };
}

interface SymbolTask { symbols: string; count: number }

/** DeepGreen exposes misplaced matches as well as exact ones. Repeating every
 * symbol in a tested group `length` times makes exact+misplaced equal the total
 * number of password characters drawn from that group. At the engine's
 * 100-character attempt ceiling this tests several alphabet symbols at once,
 * then bisects only groups that actually occur. */
const mastermindSolver: Solver = {
  needsOracle: true,
  budget: (facts) => {
    const length = facts.passwordLength ?? 10;
    const alphabet = alphabetFor(facts).length;
    return alphabet + length * Math.ceil(Math.log2(Math.max(2, length))) + length + 8;
  },

  first(facts): SolverStep {
    const length = facts.passwordLength;
    if (length === undefined || length < 1) {
      return { kind: "give-up", code: SOLVER_CODES.OracleUnparsed, reason: "DeepGreen: needs passwordLength" };
    }
    const alphabet = prioritizeAlphabet(alphabetFor(facts), facts.evidence);
    const solved = fixedPositionsFromEvidence(length, facts.evidence).map((char) => char ?? null);
    if (solved.every((char) => char !== null)) {
      return { kind: "answer", password: solved.join(""), note: "DeepGreen: every position came from harvested hints" };
    }
    const width = Math.max(1, Math.floor(100 / length));
    const groups: string[] = [];
    for (let at = 0; at < alphabet.length; at += width) groups.push(alphabet.slice(at, at + width));
    const state = freshState("DeepGreen", facts, "symbol-groups");
    state.scratch["alphabet"] = alphabet;
    state.scratch["solved"] = solved;
    state.scratch["groups"] = groups;
    state.scratch["groupIndex"] = 0;
    state.scratch["accounted"] = 0;
    state.scratch["symbolTasks"] = [];
    return symbolGroupProbe(state, groups[0]!, length, `alphabet group 1/${groups.length}`);
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "DeepGreen: opened" };
    if (!seen.oracle) {
      return { kind: "give-up", code: SOLVER_CODES.OracleUnavailable, reason: "DeepGreen: needs the log ring", state };
    }
    const observed = readMastermindCounts(seen);
    if (!observed) {
      return {
        kind: "give-up", code: SOLVER_CODES.OracleUnparsed,
        reason: `DeepGreen: response ${JSON.stringify(seen.oracle.data ?? "")} carries no exact/misplaced counts`,
      };
    }
    const length = (state.scratch["solved"] as (string | null)[]).length;
    if (state.phase === "symbol-groups") return afterSymbolGroup(state, observed.total, length);
    if (state.phase === "symbol-split") return afterSymbolSplit(state, observed.total, length);
    if (state.phase === "locate") return afterSplit("DeepGreen", state, observed.exact, length);
    return {
      kind: "give-up", code: SOLVER_CODES.SolverStalled,
      reason: `DeepGreen: unexpected phase ${JSON.stringify(state.phase)}`,
      state,
    };
  },
};

function symbolGroupProbe(state: SolverState, symbols: string, length: number, note: string): SolverStep {
  return {
    kind: "attempt",
    password: [...symbols].map((symbol) => symbol.repeat(length)).join(""),
    state,
    needsOracle: true,
    note,
  };
}

function afterSymbolGroup(state: SolverState, observed: number, length: number): SolverStep {
  const groups = state.scratch["groups"] as string[];
  const groupIndex = Number(state.scratch["groupIndex"] ?? 0);
  const tasks = [...(state.scratch["symbolTasks"] as SymbolTask[])];
  const symbols = groups[groupIndex]!;
  if (observed > 0) tasks.push({ symbols, count: observed });
  const accounted = Number(state.scratch["accounted"] ?? 0) + observed;
  const next = groupIndex + 1;
  if (accounted >= length || next >= groups.length - 1) {
    if (accounted < length && next < groups.length) tasks.push({ symbols: groups[next]!, count: length - accounted });
    return advanceSymbolTasks(state, tasks, {}, length);
  }
  return symbolGroupProbe({
    ...state,
    spent: state.spent + 1,
    scratch: { ...state.scratch, groupIndex: next, accounted, symbolTasks: tasks },
  }, groups[next]!, length, `alphabet group ${next + 1}/${groups.length}`);
}

function afterSymbolSplit(state: SolverState, observed: number, length: number): SolverStep {
  const pending = state.scratch["symbolSplit"] as SymbolTask | undefined;
  if (!pending || observed > pending.count) {
    return { kind: "give-up", code: SOLVER_CODES.OracleUnparsed, reason: "DeepGreen: invalid alphabet split response" };
  }
  const half = Math.ceil(pending.symbols.length / 2);
  const tasks = [...(state.scratch["symbolTasks"] as SymbolTask[])];
  tasks.push({ symbols: pending.symbols.slice(0, half), count: observed });
  tasks.push({ symbols: pending.symbols.slice(half), count: pending.count - observed });
  return advanceSymbolTasks(state, tasks, { ...(state.scratch["counts"] as Record<string, number>) }, length);
}

function advanceSymbolTasks(
  state: SolverState,
  tasks: SymbolTask[],
  counts: Record<string, number>,
  length: number,
): SolverStep {
  const pending = [...tasks];
  while (pending.length > 0) {
    const task = pending.shift()!;
    if (task.count === 0) continue;
    if (task.symbols.length === 1) {
      counts[task.symbols] = task.count;
      continue;
    }
    const half = Math.ceil(task.symbols.length / 2);
    const left = task.symbols.slice(0, half);
    return symbolGroupProbe({
      ...state,
      phase: "symbol-split",
      spent: state.spent + 1,
      scratch: { ...state.scratch, symbolTasks: pending, counts, symbolSplit: task },
    }, left, length, `splitting ${task.symbols.length} possible symbols`);
  }
  return beginLocating("DeepGreen", { ...state, scratch: { ...state.scratch, counts } }, counts, length);
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

  // Counts sum to the password length. Once only the final alphabet symbol is
  // unmeasured, its count is the remainder and another authenticate is pure
  // redundancy.
  if (placed < length && symbolIndex === alphabet.length - 1) {
    counts[alphabet[symbolIndex]!] = length - placed;
    return beginLocating(model, state, counts, length);
  }

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
  const solved = [...(state.scratch["solved"] as (string | null)[])];
  const all = Array.from({ length }, (_, i) => i).filter((at) => solved[at] === null);
  if (all.length === 0) {
    return { kind: "answer", password: solved.join(""), note: `${model}: every position located` };
  }
  const remainingCounts: Record<string, number> = {};
  for (const [symbol, total] of Object.entries(counts)) {
    const remaining = total - solved.filter((placed) => placed === symbol).length;
    if (remaining > 0) remainingCounts[symbol] = remaining;
  }
  const remainingTotal = Object.values(remainingCounts).reduce((sum, count) => sum + count, 0);
  if (remainingTotal !== all.length) {
    return {
      kind: "give-up",
      code: SOLVER_CODES.OracleUnparsed,
      reason: `${model}: harvested placements conflict with the reported character counts`,
    };
  }
  // Locate every symbol except the most frequent one. Once those positions are
  // known, every unresolved slot must be the omitted fallback symbol.
  const fallback = Object.entries(remainingCounts).reduce((best, entry) =>
    entry[1] > best[1] ? entry : best);
  const queue: Task[] = Object.entries(remainingCounts)
    .filter(([symbol, count]) => count > 0 && symbol !== fallback[0])
    .map(([symbol, count]) => ({ symbol, positions: all, count }));
  return advance(model, {
    ...state, phase: "locate", scratch: { ...state.scratch, fallback: fallback[0] },
  }, queue, solved, length);
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
  const fallback = state.scratch["fallback"];
  if (typeof fallback === "string") {
    for (let at = 0; at < solved.length; at++) if (solved[at] === null) solved[at] = fallback;
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

/** That the blank symbol stays outside every alphabet a password can be drawn
 * from, asserted by test through this rather than by exporting `BLANK`. */
export function blankIsSafe(): boolean {
  return !NUMBERS.includes(BLANK) && !LETTERS.includes(BLANK);
}

export const GROUP_SOLVERS = {
  mastermind: mastermindSolver,
  spiceLevel: groupTestSolver("RateMyPix.Auth", readSpiceCount),
} as const;
