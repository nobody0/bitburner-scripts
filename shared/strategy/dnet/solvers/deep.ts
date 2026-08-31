/** Two models whose feedback gives away more than it looks like it does.
 *
 * `2G_cellular` is documented — by us and by upstream's own formula parameter —
 * as a TIMING attack. The failure log states the first mismatch index directly;
 * when charisma blocks that log, the shared pinned timing transcription supplies
 * the zero-prefix baseline and the measured call duration supplies the same
 * index. Either channel turns it into an ordinary prefix walk.
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
import { LARGE_PRIMES, NUMBERS, SMALL_PRIMES } from "../codecs.ts";
import { candidateMatchesEvidence, fixedPositionsFromEvidence } from "../evidence.ts";
import { alphabetFor } from "./search.ts";
import {
  SOLVER_CODES,
  freshState,
  type Solver,
  type SolverObservation,
  type SolverState,
  type SolverStep,
} from "./types.ts";

// --- 2G_cellular: one prefix walk, two feedback channels --------------------

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
 * `stepMs` is the formula-calibrated delay added by one correct character
 * (`effects.ts:60-89`), and this
 * arrives in `elapsedMs` — which the calling process measures for itself. So it
 * needs no `heartbleed`, and `heartbleed` is the one charisma-gated call. On a
 * host whose charisma requirement we have not met, this is the only channel this
 * model has.
 *
 * Deliberately not used while the index is available: a stated integer beats an
 * inferred one, and the inference needs a baseline we would have to calibrate. */
export function correctCharsFromTiming(elapsedMs: number, baselineMs: number, stepMs = 50): number {
  const extra = elapsedMs - baselineMs;
  if (!(extra > 0) || !(stepMs > 0)) return 0;
  return Math.max(0, Math.round(extra / stepMs));
}

/** Walk the prefix one character at a time.
 *
 * The update rule is the whole solver, and it is slightly better than
 * "try each symbol until one sticks": the reported index is the FIRST mismatch,
 * so every position before it agrees with what we sent — including the padding
 * we were not really guessing at. Whenever the index runs past the frontier we
 * therefore adopt the whole prefix, and a lucky pad can resolve several
 * positions in one exchange. Alternating the unhinted alphabet forward and
 * backward also prevents late symbols paying the same bad rank at every
 * position, while harvested symbols remain first. */
const timingAttackSolver: Solver = {
  needsOracle: false,
  budget: (facts) => alphabetFor(facts).length * (facts.passwordLength ?? 8) + 2,

  first(facts): SolverStep {
    const length = facts.passwordLength;
    if (length === undefined || length < 1) {
      return { kind: "give-up", code: SOLVER_CODES.OracleUnparsed, reason: "2G_cellular: needs passwordLength" };
    }
    const alphabet = alphabetFor(facts);
    const state = freshState("2G_cellular", facts, "prefix");
    const fixed = fixedPositionsFromEvidence(length, facts.evidence);
    const preferred = hintedPrefix(alphabet, facts.evidence);
    const storedFixed = fixed.map((char) => char ?? null);
    const known = advanceFixedPrefix("", storedFixed);
    if (known.length === length) {
      return { kind: "answer", password: known, note: "2G_cellular: whole prefix came from harvested placement hints" };
    }
    state.scratch["known"] = known;
    state.scratch["symbol"] = 0;
    state.scratch["alphabet"] = alphabet;
    state.scratch["preferred"] = preferred;
    state.scratch["fixed"] = storedFixed;
    const order = positionAlphabet(alphabet, preferred, known.length);
    return {
      kind: "attempt",
      password: timingProbe(known, order[0]!, length, alphabet, preferred, storedFixed, 0),
      state,
      needsOracle: false,
      note: `prefix walk, position ${known.length + 1}`,
    };
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "2G_cellular: opened" };
    const length = facts.passwordLength ?? seen.attempted.length;
    const alphabet = String(state.scratch["alphabet"] ?? alphabetFor(facts));
    const index = readMismatchIndex(seen)
      ?? (facts.authenticateBaseMs !== undefined && seen.elapsedMs !== undefined
        ? correctCharsFromTiming(seen.elapsedMs, facts.authenticateBaseMs, facts.authenticateStepMs)
        : undefined);
    if (index === undefined) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.OracleUnavailable,
        reason: "2G_cellular: needs either a mismatch log or the formula timing baseline",
        state,
      };
    }

    let known = String(state.scratch["known"] ?? "");
    let symbol = Number(state.scratch["symbol"] ?? 0);
    const preferred = String(state.scratch["preferred"] ?? "");
    const fixed = (state.scratch["fixed"] as (string | null)[] | undefined)
      ?? new Array<string | null>(length).fill(null);
    let order = positionAlphabet(alphabet, preferred, known.length);

    if (index === -1) {
      // Nothing disagreed, so the password is our attempt cut to its length.
      return { kind: "answer", password: seen.attempted.slice(0, length), note: "2G_cellular: prefix matched whole" };
    }
    if (index > known.length) {
      // Everything before the mismatch is confirmed — including any padding that
      // happened to be right.
      known = seen.attempted.slice(0, index);
      known = advanceFixedPrefix(known, fixed);
      symbol = 0;
    } else {
      // The frontier character was wrong; move to the next symbol.
      symbol += 1;
      if (symbol >= order.length) {
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
    order = positionAlphabet(alphabet, preferred, known.length);
    return {
      kind: "attempt",
      password: timingProbe(known, order[symbol]!, length, alphabet, preferred, fixed, symbol),
      state: {
        ...state,
        spent: state.spent + 1,
        scratch: { ...state.scratch, known, symbol, preferred, fixed },
      },
      needsOracle: false,
      note: `prefix walk, position ${known.length + 1}`,
    };
  },
};

/** Hint characters stay first; only the unhinted tail is mirrored. */
function positionAlphabet(alphabet: string, preferred: string, position: number): string {
  const rest = [...alphabet].filter((char) => !preferred.includes(char));
  // Numeric passwords longer than one character have passed through Number()
  // and therefore cannot begin with zero. Keep it in the exhaustive tail for
  // Keep zero in the exhaustive tail for unusual one-character numeric facts.
  // before the nine symbols the generator can actually leave at position 0.
  if (position === 0 && alphabet === NUMBERS && !preferred.includes("0")) {
    const zero = rest.indexOf("0");
    if (zero >= 0) rest.push(...rest.splice(zero, 1));
  }
  if (position % 2 === 1) rest.reverse();
  return preferred + rest.join("");
}

function hintedPrefix(alphabet: string, evidence: PasswordFacts["evidence"]): string {
  let preferred = "";
  for (const item of evidence ?? []) {
    const chars = item.kind === "contains" ? item.chars : item.placed;
    for (const char of chars) {
      if (alphabet.includes(char) && !preferred.includes(char)) preferred += char;
    }
  }
  return preferred;
}

function advanceFixedPrefix(known: string, fixed: readonly (string | null)[]): string {
  let next = known;
  while (next.length < fixed.length && fixed[next.length] !== null) next += fixed[next.length];
  return next;
}

function timingProbe(
  known: string,
  guess: string,
  length: number,
  alphabet: string,
  preferred: string,
  fixed: readonly (string | null)[],
  cycle: number,
): string {
  let attempt = known + guess;
  while (attempt.length < length) {
    const position = attempt.length;
    const order = positionAlphabet(alphabet, preferred, position);
    attempt += fixed[position] ?? order[(cycle + position - known.length - 1) % order.length]!;
  }
  return attempt.slice(0, length);
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
 * Above difficulty 24 a SECOND large prime is multiplied in. Locate one of the
 * two with direct divisibility probes, then enumerate only length-compatible,
 * exactly representable partners. Duplicate factors remain valid, because the
 * generator draws the two primes independently. */

const divisibilitySolver: Solver = {
  needsOracle: true,
  budget: (facts) => SMALL_PRIMES.length * 2 + LARGE_PRIMES.length * 2 + 8,

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

    if (state.phase === "large-pair") {
      if (!seen.oracle) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.OracleUnavailable,
          reason: "Factori-Os: needs the log ring while locating the first large factor",
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
      const largePrime = Number(state.scratch["largePrime"]);
      const excluded = ((state.scratch["excludedLarge"] as number[] | undefined) ?? []);
      if (raw === "true") {
        const candidates = pairCandidates(facts, known, largePrime, excluded);
        if (candidates.length === 0) {
          return {
            kind: "give-up",
            code: SOLVER_CODES.SolverExhausted,
            reason: "Factori-Os: the located large factor has no length-compatible partner",
          };
        }
        return {
          kind: "attempt",
          password: candidates[0]!,
          state: {
            ...state,
            phase: "large",
            spent: state.spent + 1,
            scratch: { ...state.scratch, candidates, candidateIndex: 0 },
          },
          needsOracle: false,
          note: `two-large-factor candidate 1/${candidates.length}`,
        };
      }
      const nextExcluded = [...excluded, largePrime];
      const ranked = state.scratch["largeOrder"] as number[];
      const nextAt = Number(state.scratch["largeAt"]) + 1;
      const nextPrime = ranked[nextAt];
      if (nextPrime === undefined) {
        return { kind: "give-up", code: SOLVER_CODES.SolverExhausted, reason: "Factori-Os: no large factor divides the password" };
      }
      return {
        kind: "attempt",
        password: String(nextPrime),
        state: {
          ...state,
          spent: state.spent + 1,
          scratch: { ...state.scratch, largePrime: nextPrime, excludedLarge: nextExcluded, largeAt: nextAt },
        },
        needsOracle: true,
        note: `posterior-ranked large factor ${nextAt + 1}/${ranked.length}`,
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
        reason: `Factori-Os: the known factors ${known} had no admissible large-prime completion`,
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
  if ((facts.difficulty ?? 0) > 24) {
    const ranked = rankLargeFactors(facts, small, []);
    if (ranked.length === 0) {
      return { kind: "give-up", code: SOLVER_CODES.SolverExhausted, reason: "Factori-Os: no admissible large-prime pair" };
    }
    return {
      kind: "attempt",
      password: String(ranked[0]),
      state: {
        ...state,
        phase: "large-pair",
        spent: state.spent + 1,
        scratch: {
          ...state.scratch,
          known: small.toString(),
          largePrime: ranked[0],
          excludedLarge: [],
          largeOrder: ranked,
          largeAt: 0,
        },
      },
      needsOracle: true,
      note: `posterior-ranked first large factor; ${ranked.length} admissible`,
    };
  }
  const length = facts.passwordLength;
  const candidates: string[] = [];

  // The small part alone is a real possibility below difficulty 12, where no
  // large prime is multiplied in at all — so it is the first candidate.
  if ((length === undefined || small.toString().length === length)
    && candidateMatchesEvidence(small.toString(), facts.evidence)) candidates.push(small.toString());

  if (length !== undefined && length >= 1) {
    const low = 10n ** BigInt(length - 1);
    const high = 10n ** BigInt(length);
    for (const prime of LARGE_PRIMES) {
      const product = small * BigInt(prime);
      // The reported length is what makes this a handful of candidates rather
      // than all 83: only a residue that lands the product on the right number
      // of digits can possibly be the one.
      if (product >= low && product < high && candidateMatchesEvidence(product.toString(), facts.evidence)) {
        candidates.push(product.toString());
      }
    }
  } else {
    for (const prime of LARGE_PRIMES) {
      const candidate = (small * BigInt(prime)).toString();
      if (candidateMatchesEvidence(candidate, facts.evidence)) candidates.push(candidate);
    }
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

function pairCandidates(facts: PasswordFacts, small: bigint, first: number, excluded: readonly number[] = []): string[] {
  const length = facts.passwordLength;
  const low = length === undefined ? undefined : 10n ** BigInt(Math.max(0, length - 1));
  const high = length === undefined ? undefined : 10n ** BigInt(length);
  const candidates: string[] = [];
  for (const partner of LARGE_PRIMES) {
    if (excluded.includes(partner)) continue;
    const product = small * BigInt(first) * BigInt(partner);
    if (low !== undefined && high !== undefined && (product < low || product >= high)) continue;
    if (BigInt(Number(product)) !== product) continue;
    const value = product.toString();
    if (candidateMatchesEvidence(value, facts.evidence) && !candidates.includes(value)) candidates.push(value);
  }
  return candidates;
}

/** Rank a factor ask by how many still-admissible ordered generator draws it
 * covers. Password length, exact Number representability, harvested evidence,
 * and earlier negative divisibility answers all condition that posterior. */
function rankLargeFactors(facts: PasswordFacts, small: bigint, excluded: readonly number[]): number[] {
  const banned = new Set(excluded);
  const length = facts.passwordLength;
  const scores = new Map<number, number>();
  const hasEvidence = (facts.evidence?.length ?? 0) > 0;
  const smallNumber = Number(small);
  for (const first of LARGE_PRIMES) {
    if (banned.has(first)) continue;
    if (!hasEvidence && length !== undefined && Number.isFinite(smallNumber)) {
      const scale = smallNumber * first;
      const lowPartner = 10 ** (length - 1) / scale;
      const highPartner = 10 ** length / scale;
      const from = lowerBound(LARGE_PRIMES, lowPartner);
      const to = lowerBound(LARGE_PRIMES, highPartner);
      let count = 0;
      let includesSelf = false;
      for (let index = from; index < to; index++) {
        const partner = LARGE_PRIMES[index]!;
        if (banned.has(partner)) continue;
        count++;
        if (partner === first) includesSelf = true;
      }
      const score = count * 2 - (includesSelf ? 1 : 0);
      if (score > 0) scores.set(first, score);
      continue;
    }
    let score = 0;
    for (const partner of LARGE_PRIMES) {
      if (banned.has(partner)) continue;
      const product = small * BigInt(first) * BigInt(partner);
      if (length !== undefined && product.toString().length !== length) continue;
      if (BigInt(Number(product)) !== product) continue;
      if (!candidateMatchesEvidence(product.toString(), facts.evidence)) continue;
      // The two independent draws can put distinct factors in either order.
      score += first === partner ? 1 : 2;
    }
    if (score > 0) scores.set(first, score);
  }
  return [...scores.keys()].sort((left, right) => scores.get(right)! - scores.get(left)! || left - right);
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
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
 * in `plan.ts` (which today only bleeds hosts we already hold), not a solver. */
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

/** Whether this token's head can be a hostname at all.
 *
 * It used to accept only `[A-Za-z0-9_.-]`, described as "the character class
 * `generateDarknetServerName` draws a hostname from". That was wrong, and it
 * threw away real passwords: `connectors` alone contributes `; : $ ^ % @ &`,
 * `decorateName` appends `:<digits>`, `l33tifyName` can inject a multi-code-
 * unit emoji, `safelyReverseString` can reverse any of it, and `presetNames`
 * holds `);DROP-TABLE-SERVERS;--`, `茶店` and `...`. Genuine hostnames like
 * `apex@matrix`, `digital_citadel:6576` and `🅱️1trunners` were all refused,
 * and refusing the head means never reading the password after it.
 *
 * So the only thing a hostname genuinely cannot contain is WHITESPACE — the
 * capture's own delimiter. `sim/tests/dnet-parity.test.ts` holds this to every
 * character the transcribed generator can emit. Discrimination is not lost:
 * `passwordFromNamedPacket` tells the candidate splits apart by the reported
 * password LENGTH, which is a fact about the model rather than a guess about
 * punctuation.
 *
 * A character loop rather than a RegExp: see the RAM note in `oracle.ts`. */
function hostish(name: string): boolean {
  if (name.length === 0) return false;
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    // space, tab, LF, VT, FF, CR
    if (code === 32 || (code >= 9 && code <= 13)) return false;
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
