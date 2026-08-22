/** Two models whose feedback gives away more than it looks like it does.
 *
 * `2G_cellular` is documented — by us and by upstream's own formula parameter —
 * as a TIMING attack, and reading it that way makes it look like the hardest
 * model in the set: measure a 50 ms difference across a network call and climb.
 * It is not. The failure response states the index of the first mismatched
 * character in words, so the attack is an ordinary prefix walk and the timing
 * channel is a fallback nobody needs.
 *
 * `Factori-Os` answers only "yes" or "no" to "is the password divisible by
 * this?", which sounds like one bit per exchange. But the password is built as a
 * product of primes drawn from two SHORT tables, so each bit lands exactly on
 * one factor's exponent, and thirty-odd exchanges reconstruct it outright.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/authentication.ts:67-74, 95-99
 *   src/DarkNet/controllers/ServerGenerator.ts:204-218, 384-391, 685-707 */

import type { PasswordFacts } from "../models.ts";
import { LARGE_PRIMES, SMALL_PRIMES } from "../codecs.ts";
import { alphabetFor } from "./search.ts";
import {
  SOLVER_CODES,
  freshState,
  type Solver,
  type SolverObservation,
  type SolverState,
  type SolverStep,
} from "./types.ts";

// --- 2G_cellular: the timing attack that does not need timing ---------------

/** The index out of `"Found a mismatch while checking each character (N)"`.
 *
 * `-1` is upstream's `findIndex` miss, meaning no character of the password
 * disagreed with ours — which, on a failure, means our attempt matched the whole
 * password and then kept going. */
export function readMismatchIndex(seen: SolverObservation): number | undefined {
  const said = `${seen.oracle?.message ?? ""} ${seen.oracle?.data ?? ""}`;
  const found = said.match(/mismatch while checking each character \((-?\d+)\)/i);
  if (!found) return undefined;
  const value = Number(found[1]);
  return Number.isInteger(value) ? value : undefined;
}

/** How many leading characters were correct, from the measured round trip.
 *
 * The fallback, and the reason it is worth keeping: each correct character adds
 * `50 ms * threadsFactor` to authentication (`effects.ts:60-89`), and this
 * arrives in `elapsedMs` — which the calling process measures for itself. So it
 * needs no `heartbleed`, and `heartbleed` is the one charisma-gated call. On a
 * host whose charisma requirement we have not met, this is the only channel this
 * model has.
 *
 * Deliberately NOT used while the index is available: a stated integer beats an
 * inferred one, and the inference needs a baseline we would have to calibrate. */
export function correctCharsFromTiming(elapsedMs: number, baselineMs: number, threadsFactor = 1): number {
  const extra = elapsedMs - baselineMs;
  if (!(extra > 0)) return 0;
  return Math.max(0, Math.round(extra / (50 * threadsFactor)));
}

/** Walk the prefix one character at a time.
 *
 * The update rule is the whole solver, and it is slightly better than
 * "try each symbol until one sticks": the reported index is the FIRST mismatch,
 * so every position before it agrees with what we sent — including the padding
 * we were not really guessing at. Whenever the index runs past the frontier we
 * therefore adopt the whole prefix, and a lucky pad can resolve several
 * positions in one exchange. */
const timingAttackSolver: Solver = {
  needsOracle: true,
  budget: (facts) => alphabetFor(facts).length * (facts.passwordLength ?? 8) + 2,

  first(facts): SolverStep {
    const length = facts.passwordLength;
    if (length === undefined || length < 1) {
      return { kind: "give-up", code: SOLVER_CODES.OracleUnparsed, reason: "2G_cellular: needs passwordLength" };
    }
    const alphabet = alphabetFor(facts);
    const state = freshState("2G_cellular", facts, "prefix");
    state.scratch["known"] = "";
    state.scratch["symbol"] = 0;
    return {
      kind: "attempt",
      password: padTo("", alphabet[0]!, length, alphabet),
      state,
      needsOracle: true,
      note: "prefix walk, position 1",
    };
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "2G_cellular: opened" };
    const length = facts.passwordLength ?? seen.attempted.length;
    const alphabet = alphabetFor(facts);
    if (!seen.oracle) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.OracleUnavailable,
        reason: "2G_cellular: needs the log ring, or a measured round trip",
        state,
      };
    }
    const index = readMismatchIndex(seen);
    if (index === undefined) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.OracleUnparsed,
        reason: `2G_cellular: response ${JSON.stringify(seen.oracle.message ?? "")} states no mismatch index`,
      };
    }

    let known = String(state.scratch["known"] ?? "");
    let symbol = Number(state.scratch["symbol"] ?? 0);

    if (index === -1) {
      // Nothing disagreed, so the password is our attempt cut to its length.
      return { kind: "answer", password: seen.attempted.slice(0, length), note: "2G_cellular: prefix matched whole" };
    }
    if (index > known.length) {
      // Everything before the mismatch is confirmed — including any padding that
      // happened to be right.
      known = seen.attempted.slice(0, index);
      symbol = 0;
    } else {
      // The frontier character was wrong; move to the next symbol.
      symbol += 1;
      if (symbol >= alphabet.length) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.SolverExhausted,
          reason: `2G_cellular: no symbol fits position ${known.length + 1}`,
        };
      }
    }

    if (known.length >= length) {
      return { kind: "answer", password: known.slice(0, length), note: "2G_cellular: every position resolved" };
    }
    return {
      kind: "attempt",
      password: padTo(known, alphabet[symbol]!, length, alphabet),
      state: { ...state, spent: state.spent + 1, scratch: { ...state.scratch, known, symbol } },
      needsOracle: true,
      note: `prefix walk, position ${known.length + 1}`,
    };
  },
};

/** `known` + the frontier guess + filler out to the password's length. The
 * filler is a DIFFERENT symbol from the guess so that a matching pad is
 * informative rather than a coincidence we cannot attribute. */
function padTo(known: string, guess: string, length: number, alphabet: string): string {
  const filler = alphabet[0] === guess ? (alphabet[1] ?? alphabet[0]!) : alphabet[0]!;
  const head = known + guess;
  return head.length >= length ? head.slice(0, length) : head + filler.repeat(length - head.length);
}

// --- Factori-Os: one bit per exchange, aimed carefully ----------------------

/** The password is `getPasswordMadeUpOfPrimesProduct` (`ServerGenerator.ts:685-707`):
 * a small starting integer multiplied by a handful of values drawn from
 * `SMALL_PRIMES` or from 1..5, then by one `LARGE_PRIMES` entry above difficulty
 * 12 and a second above difficulty 24.
 *
 * So its prime factorisation is entirely inside two tables we hold. Ask
 * `p, p^2, p^3, ...` for each small prime and the answers give each exponent
 * exactly; what remains is a residue that is 1, one large prime, or two. The
 * reported password length bounds which large primes can possibly fit, which is
 * what keeps the second phase to a few asks instead of all 83.
 *
 * Two traps, both of which cost an exchange and teach nothing:
 *
 * - **Never send `0`.** `Number(password) % 0` is `NaN`, which is falsy, so
 *   upstream's `if (... || password % attemptedDivisor || ...)` takes the
 *   *success* branch and reports "Password IS divisible by '0'". A solver that
 *   believed it would conclude nonsense.
 * - **Never send a non-number or the empty string** — same branch, same lie.
 *
 * The engine compares with `Number(server.password)` rather than BigInt, which
 * looks like it should break above `MAX_SAFE_INTEGER` — and does not, because
 * the generator will not emit such a password: its loop repeats
 * `while (BigInt(Number(password)) !== password)` (`ServerGenerator.ts:705`),
 * so every password it produces is EXACTLY representable as a double. A remainder
 * against a small divisor is then exact too. So a long password is not a reason
 * to refuse; it is only a reason to reconstruct in BigInt, which this does.
 *
 * What this genuinely cannot do is the difficulty > 24 case, where a SECOND
 * large prime is multiplied in: the candidate set becomes pairs, and the
 * reported length does not narrow it enough to be worth walking. That gives up
 * by name rather than guessing. */

const divisibilitySolver: Solver = {
  needsOracle: true,
  budget: (facts) => SMALL_PRIMES.length * 2 + LARGE_PRIMES.length + 4,

  first(facts): SolverStep {
    const state = freshState("Factori-Os", facts, "small");
    state.scratch["primeIndex"] = 0;
    state.scratch["power"] = 1;
    state.scratch["known"] = "1";
    return {
      kind: "attempt",
      password: String(SMALL_PRIMES[0]),
      state,
      needsOracle: true,
      note: `divisibility by ${SMALL_PRIMES[0]}`,
    };
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "Factori-Os: opened" };
    const known = BigInt(String(state.scratch["known"] ?? "1"));

    if (state.phase === "small") {
      // Only this phase asks a question, so only this phase needs an answer.
      // The large phase sends candidate passwords, which report themselves.
      if (!seen.oracle) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.OracleUnavailable,
          reason: "Factori-Os: needs the log ring, which was not readable",
          state,
        };
      }
      const raw = (seen.oracle.data ?? "").trim().toLowerCase();
      if (raw !== "true" && raw !== "false") {
        return {
          kind: "give-up",
          code: SOLVER_CODES.OracleUnparsed,
          reason: `Factori-Os: response ${JSON.stringify(raw)} is not a divisibility verdict`,
        };
      }
      const divides = raw === "true";
      let primeIndex = Number(state.scratch["primeIndex"] ?? 0);
      let power = Number(state.scratch["power"] ?? 1);
      const prime = BigInt(SMALL_PRIMES[primeIndex]!);
      let accumulated = known;

      if (divides) {
        // p^power divides, so this prime carries at least one more factor than
        // we had banked. Fold exactly one in and raise the power we ask about.
        accumulated = known * prime;
        power += 1;
      } else {
        primeIndex += 1;
        power = 1;
      }

      if (primeIndex >= SMALL_PRIMES.length) {
        return enterLargePhase(facts, state, accumulated);
      }
      const candidate = divides
        ? BigInt(SMALL_PRIMES[primeIndex]!) ** BigInt(power)
        : BigInt(SMALL_PRIMES[primeIndex]!);
      return {
        kind: "attempt",
        password: candidate.toString(),
        state: {
          ...state,
          spent: state.spent + 1,
          scratch: { ...state.scratch, primeIndex, power, known: accumulated.toString() },
        },
        needsOracle: true,
        note: `divisibility by ${candidate}`,
      };
    }

    // --- the large-prime residue ---
    //
    // These are sent as CANDIDATE PASSWORDS, not as divisibility questions.
    // Asking "does q divide the password?" costs an exchange and, when the
    // answer is yes, still needs a second exchange to authenticate with
    // `small * q`. Sending `small * q` itself collapses the two: a wrong guess
    // is refused exactly as a divisibility question would be, and a right one
    // opens the host instead of merely confirming it.
    const candidates = state.scratch["candidates"] as string[];
    const at = Number(state.scratch["candidateIndex"] ?? 0);
    const next = at + 1;
    if (next >= candidates.length) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.SolverExhausted,
        reason:
          `Factori-Os: the small factors gave ${known}, and no admissible large prime completed it`
          + " — above difficulty 24 upstream uses two large primes, which this does not reconstruct",
      };
    }
    return {
      kind: "attempt",
      password: candidates[next]!,
      state: { ...state, spent: state.spent + 1, scratch: { ...state.scratch, candidateIndex: next } },
      // A candidate password needs no feedback: it either opens the host or it
      // does not, and `authenticate` reports that in its own return value.
      needsOracle: false,
      note: `candidate password ${candidates[next]}`,
    };
  },
};

/** Move to asking about large primes, having pinned the small part.
 *
 * Only the entries that could still fit the reported length are asked about, in
 * ascending order — which is usually a handful rather than all 83. */
function enterLargePhase(facts: PasswordFacts, state: SolverState, small: bigint): SolverStep {
  const length = facts.passwordLength;
  const candidates: string[] = [];

  // The small part alone is a real possibility below difficulty 12, where no
  // large prime is multiplied in at all — so it is the first candidate.
  if (length === undefined || small.toString().length === length) candidates.push(small.toString());

  if (length !== undefined && length >= 1) {
    const low = 10n ** BigInt(length - 1);
    const high = 10n ** BigInt(length);
    for (const prime of LARGE_PRIMES) {
      const product = small * BigInt(prime);
      // The reported length is what makes this a handful of candidates rather
      // than all 83: only a residue that lands the product on the right number
      // of digits can possibly be the one.
      if (product >= low && product < high) candidates.push(product.toString());
    }
  } else {
    for (const prime of LARGE_PRIMES) candidates.push((small * BigInt(prime)).toString());
  }

  if (candidates.length === 0) {
    return {
      kind: "give-up",
      code: SOLVER_CODES.SolverExhausted,
      reason: `Factori-Os: small factors gave ${small}, which no large prime completes to ${length} digits`,
    };
  }
  return {
    kind: "attempt",
    password: candidates[0]!,
    state: {
      ...state,
      phase: "large",
      spent: state.spent + 1,
      scratch: { ...state.scratch, known: small.toString(), candidates, candidateIndex: 0 },
    },
    needsOracle: false,
    note: `candidate password ${candidates[0]}`,
  };
}



// --- OpenWebAccessPoint: read the password out of the noise ----------------

/** The packet sniffer does not have a minigame; it has a leak.
 *
 * Every failed attempt answers with ~130 characters of junk with the password
 * hidden inside (`packetSniffing.ts:16-24`), and the shape of the hiding depends
 * on one threshold:
 *
 * - **difficulty <= 16** — the blob contains the literal `" <hostname>:<password> "`,
 *   space-delimited. One failed attempt is enough, and `oracle.ts` already mines
 *   this shape for NEIGHBOURS' credentials; here we want the host's own.
 * - **difficulty > 16** — the blob contains the BARE password, with no host and
 *   no delimiters, inside alphanumeric junk. One blob cannot give it up. But
 *   each failure mints a FRESH blob around the SAME password, so the password is
 *   in the intersection of the length-`L` substrings of every blob we collect,
 *   and the junk almost never agrees twice.
 *
 * Worth stating plainly: this model's cheapest channel is not here at all. Its
 * own log NOISE emits `"Logging in with passcode: <password>"` unprompted, which
 * `harvestLogs` already parses — so a `bleed` against one of these hosts can
 * hand over the credential with no attempt at all. That is a scheduling change
 * in `queue.ts` (which today only bleeds hosts we already hold), not a solver. */
const PACKET_BLOBS_WANTED = 3;

const packetSnifferSolver: Solver = {
  needsOracle: true,
  // The blobs, plus however many runs survive intersecting them. A generous
  // ceiling rather than a tight one: the survivors are free shots, and the real
  // bound is that each is a genuine attempt at the password.
  budget: (facts) => PACKET_BLOBS_WANTED + 4 + Math.max(8, facts.passwordLength ?? 8) * 4,

  first(facts): SolverStep {
    const state = freshState("OpenWebAccessPoint", facts, "collect");
    state.scratch["blobs"] = [];
    return {
      kind: "attempt",
      password: throwaway(facts),
      state,
      needsOracle: true,
      note: "one deliberate failure, to mint a packet capture",
    };
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "OpenWebAccessPoint: opened" };
    // Walking the survivors of an earlier intersection: each is a real shot, so
    // there is nothing to read back. Checked BEFORE the oracle guard below,
    // because the attempts this phase emits declare `needsOracle: false` and the
    // job therefore skips the `heartbleed` — so an oracle guard in front of it
    // aborted the walk on its very first candidate, every time.
    if (state.phase === "try") {
      const shared = state.scratch["shared"] as string[];
      const at = Number(state.scratch["at"] ?? 0) + 1;
      if (at >= shared.length) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.SolverExhausted,
          reason: `OpenWebAccessPoint: all ${shared.length} candidates from the capture intersection were refused`,
        };
      }
      return {
        kind: "attempt",
        password: shared[at]!,
        state: { ...state, spent: state.spent + 1, scratch: { ...state.scratch, at } },
        needsOracle: false,
        note: `candidate ${at + 1}/${shared.length} from the capture intersection`,
      };
    }

    // Every phase below this point reads the capture back out of the log ring.
    if (!seen.oracle) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.OracleUnavailable,
        reason: "OpenWebAccessPoint: needs the log ring, which was not readable",
        state,
      };
    }
    const blob = seen.oracle.data ?? "";
    if (blob.length === 0) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.OracleUnparsed,
        reason: "OpenWebAccessPoint: the response carried no packet capture",
      };
    }

    // The easy half: below difficulty 17 the capture names its own host.
    const named = passwordFromNamedPacket(blob, facts);
    if (named !== undefined) {
      return { kind: "answer", password: named, note: "OpenWebAccessPoint: read out of its own capture" };
    }

    // The hard half: intersect this blob's substrings with the ones before it.
    const length = facts.passwordLength;
    if (length === undefined || length < 1) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.OracleUnparsed,
        reason: "OpenWebAccessPoint: a bare password needs passwordLength to be found",
      };
    }
    const blobs = [...(state.scratch["blobs"] as string[]), blob];
    const shared = intersectSubstrings(blobs, length);
    if (shared.length === 1) {
      return { kind: "answer", password: shared[0]!, note: `OpenWebAccessPoint: unique across ${blobs.length} captures` };
    }
    if (blobs.length >= PACKET_BLOBS_WANTED) {
      if (shared.length === 0) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.SolverExhausted,
          reason: `OpenWebAccessPoint: ${blobs.length} captures share no ${length}-character run`,
        };
      }
      // Several survivors: they are cheap to try, and one of them is the answer.
      return {
        kind: "attempt",
        password: shared[0]!,
        state: { ...state, phase: "try", spent: state.spent + 1, scratch: { ...state.scratch, blobs, shared, at: 0 } },
        needsOracle: false,
        note: `candidate 1/${shared.length} from the capture intersection`,
      };
    }
    return {
      kind: "attempt",
      password: throwaway(facts),
      state: { ...state, spent: state.spent + 1, scratch: { ...state.scratch, blobs } },
      needsOracle: true,
      note: `capture ${blobs.length}/${PACKET_BLOBS_WANTED}`,
    };
  },
};

/** A format-shaped string we do not expect to work. Its only job is to make the
 * host answer, because the capture is written BY the failure. */
function throwaway(facts: PasswordFacts): string {
  const length = Math.max(1, Math.min(facts.passwordLength ?? 4, 16));
  return (facts.passwordFormat === "numeric" ? "0" : "a").repeat(length);
}

/** `" <hostname>:<password> "`, which is what a capture holds below difficulty
 * 17. The trailing space is the delimiter, not a character class — a password
 * may contain anything except one. */
export function passwordFromNamedPacket(blob: string, facts: PasswordFacts): string | undefined {
  const length = facts.passwordLength;
  for (const token of blob.split(" ")) {
    const head = token.indexOf(":");
    if (head <= 0 || !hostish(token.slice(0, head))) continue;
    // EVERY colon is a possible split, not just the first, because both halves
    // can contain one. `decorateName` appends `:<digits>` to about one hostname
    // in twenty (`DarknetServerOptions.ts:178-180`), and `getBaseName` draws
    // from the common-password dictionary a twentieth of the time — which holds
    // `":)"`, `"::"` and a punctuation run. So a single greedy match reads
    // `n0de-hub:8231:47219` as the password `8231:47219` and, with the length
    // fact refusing it, throws away a password that was sitting in plain sight;
    // worse, it reads `hunter2::abcd` as `:abcd` and ASSERTS it, which reports
    // `SolverExhausted` — "our reading of this model is wrong" — on a host we
    // could have opened. The reported length is what tells the splits apart.
    for (let cut = head; cut !== -1; cut = token.indexOf(":", cut + 1)) {
      const password = token.slice(cut + 1);
      if (password.length === 0) continue;
      if (length === undefined) return password;
      if (password.length === length) return password;
    }
  }
  return undefined;
}

/** The character class `generateDarknetServerName` draws a hostname from. A
 * character loop rather than a RegExp: see the RAM note in `oracle.ts`. */
function hostish(name: string): boolean {
  for (const ch of name) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9")
      || ch === "_" || ch === "." || ch === "-";
    if (!ok) return false;
  }
  return true;
}

/** Every run of `length` characters common to all the blobs.
 *
 * The password is in each of them by construction; the junk is drawn afresh
 * every time, so a coincidental agreement across three captures is rare. */
export function intersectSubstrings(blobs: readonly string[], length: number): string[] {
  const runs = (text: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i + length <= text.length; i++) out.add(text.slice(i, i + length));
    return out;
  };
  if (blobs.length === 0) return [];
  let shared = runs(blobs[0]!);
  for (const blob of blobs.slice(1)) {
    const next = runs(blob);
    shared = new Set([...shared].filter((run) => next.has(run)));
  }
  return [...shared].sort();
}

export const DEEP_SOLVERS = {
  timingAttack: timingAttackSolver,
  divisibility: divisibilitySolver,
  packetSniffer: packetSnifferSolver,
} as const;
