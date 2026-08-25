/** The five models that answer a guess with something useful about the guess.
 *
 * These are the cheapest of the genuinely interactive attacks — each converges
 * in well under the ~30 exchanges one vantage buys (`./types.ts` explains where
 * that number comes from), so a solve starts and finishes without ever having to
 * be resumed from somewhere else. That makes them the right place to prove the
 * whole stateful protocol works before spending it on the expensive ones.
 *
 * Every response arrives the same way and it is worth restating, because getting
 * it backwards makes the password mechanic look unreachable: `authenticate()`
 * does NOT return the model's feedback. It writes a `{code, message, data,
 * passwordAttempted}` record into the target's own log ring, and only
 * `heartbleed` reads that back. So every solver here declares `needsOracle`, and
 * every one of them is unusable below the host's charisma requirement — which is
 * the one gate `heartbleed` has and `authenticate` does not.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/authentication.ts:43-50, 51-57, 75-85, 127-143
 *   src/DarkNet/controllers/ServerGenerator.ts:107-124, 221-249, 257-264,
 *                                              283-288, 393-400 */

import type { ModelId, PasswordFacts } from "../models.ts";
import { LETTERS, NUMBERS, romanNumeralDecoder } from "../codecs.ts";
import { candidateMatchesEvidence, fixedPositionsFromEvidence, prioritizeAlphabet } from "../evidence.ts";
import {
  SOLVER_CODES,
  freshState,
  type Solver,
  type SolverObservation,
  type SolverState,
  type SolverStep,
} from "./types.ts";

/** The alphabet a per-position solver has to walk, from the format the host
 * reports. `getPasswordType` is what produced that string, so these are the only
 * five values it can hold — but only the first three are reachable for a
 * generated password, since every generator draws from digits and letters. */
export function alphabetFor(facts: PasswordFacts): string {
  let alphabet: string;
  switch (facts.passwordFormat) {
    case "numeric":
      alphabet = NUMBERS; break;
    case "alphabetic":
      alphabet = LETTERS; break;
    case "alphanumeric":
      alphabet = NUMBERS + LETTERS; break;
    default:
      // Unknown or exotic: digits first, because every model here generates a
      // numeric password unless difficulty pushed it alphanumeric.
      alphabet = NUMBERS + LETTERS;
  }
  return prioritizeAlphabet(alphabet, facts.evidence);
}

const stalled = (reason: string, state: SolverState): SolverStep => ({
  kind: "give-up",
  code: SOLVER_CODES.SolverStalled,
  reason,
  state,
});

const unparsed = (reason: string): SolverStep => ({
  kind: "give-up",
  code: SOLVER_CODES.OracleUnparsed,
  reason,
});

const noOracle = (reason: string, state: SolverState): SolverStep => ({
  kind: "give-up",
  code: SOLVER_CODES.OracleUnavailable,
  reason,
  state,
});

// --- 1. binary search on a high/low oracle ---------------------------------

/** `AccountsManager_4.2` and `BellaCuore` above difficulty 8 are the same attack
 * wearing different words, so they are one implementation.
 *
 * `AccountsManager_4.2` answers `"Lower"` when our guess was too high and
 * `"Higher"` when it was too low (`authentication.ts:43-46`). `BellaCuore` says
 * the same two things in Latin — `"ALTUS NIMIS"` for too high, `"PARUM BREVIS"`
 * for too low (`:47-50`).
 *
 * The bounds are what make this cheap. For `AccountsManager_4.2` the password is
 * a number whose LENGTH we are told, and `getPassword` strips leading zeros — so
 * a length of 2 or more means the value is at least `10^(L-1)`, which is an
 * exact bound rather than a guess and saves about three exchanges. For
 * `BellaCuore` the host publishes the range itself, as two Roman numerals in
 * `data`. */
type Direction = "higher" | "lower";

function readDirection(seen: SolverObservation): Direction | undefined {
  const said = `${seen.oracle?.data ?? ""} ${seen.oracle?.message ?? ""}`.toUpperCase();
  if (said.includes("LOWER") || said.includes("ALTUS NIMIS")) return "lower";
  if (said.includes("HIGHER") || said.includes("PARUM BREVIS")) return "higher";
  return undefined;
}

interface Bounds {
  lo: number;
  hi: number;
}

/** The range implied by a reported password length, for a numeric password with
 * no leading zero. A length we were not told leaves the range wide open. */
function boundsFromLength(facts: PasswordFacts): Bounds {
  const length = facts.passwordLength;
  if (length === undefined || length < 1) return { lo: 0, hi: 10 ** 9 };
  const lo = length === 1 ? 0 : 10 ** (length - 1);
  let hi = 10 ** length - 1;
  // getGuessNumberConfig is tighter than the displayed power-of-ten hint.
  // Its exact upper bound is public through difficulty, so use it when held.
  if (facts.difficulty !== undefined) {
    hi = Math.min(hi, Math.ceil((10 * (facts.difficulty + 3)) / 3) - 1);
  }
  return { lo, hi };
}

/** The range `BellaCuore` publishes in `data` as `"<min>,<max>"`. */
function boundsFromRomanRange(facts: PasswordFacts): Bounds | undefined {
  const data = (facts.data ?? "").trim();
  const comma = data.indexOf(",");
  if (comma === -1) return undefined;
  const lo = romanNumeralDecoder(data.slice(0, comma).trim());
  const hi = romanNumeralDecoder(data.slice(comma + 1).trim());
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return undefined;
  return { lo, hi };
}

function binarySearchSolver(model: ModelId, startBounds: (facts: PasswordFacts) => Bounds | undefined): Solver {
  const midpoint = (b: Bounds): number => Math.floor((b.lo + b.hi) / 2);
  const admissible = (facts: PasswordFacts, b: Bounds): number[] | undefined => {
    if ((facts.evidence?.length ?? 0) === 0 || b.hi - b.lo > 100_000) return undefined;
    const out: number[] = [];
    for (let value = b.lo; value <= b.hi; value++) {
      if (candidateMatchesEvidence(String(value), facts.evidence)) out.push(value);
    }
    return out;
  };

  return {
    needsOracle: true,
    budget: (facts) => {
      const b = startBounds(facts) ?? { lo: 0, hi: 10 ** 9 };
      const candidates = admissible(facts, b);
      return Math.ceil(Math.log2(Math.max(2, candidates?.length ?? (b.hi - b.lo + 1)))) + 2;
    },

    first(facts): SolverStep {
      const b = startBounds(facts);
      if (!b) return unparsed(`${model}: could not establish a search range`);
      const state = freshState(model, facts, "search");
      state.scratch["lo"] = b.lo;
      state.scratch["hi"] = b.hi;
      const candidates = admissible(facts, b);
      if (candidates?.length === 0) return unparsed(`${model}: log evidence eliminates the published range`);
      if (candidates !== undefined) state.scratch["candidates"] = candidates;
      const guess = candidates === undefined ? midpoint(b) : candidates[Math.floor(candidates.length / 2)]!;
      return {
        kind: "attempt",
        password: String(guess),
        state,
        needsOracle: true,
        note: `binary search in [${b.lo}, ${b.hi}]`,
      };
    },

    next(facts, state, seen): SolverStep {
      if (seen.success) return { kind: "answer", password: seen.attempted, note: `${model}: opened` };
      if (!seen.oracle) {
        return noOracle(`${model}: needs the log ring, which was not readable`, state);
      }
      const direction = readDirection(seen);
      if (!direction) {
        return unparsed(`${model}: response ${JSON.stringify(seen.oracle.data ?? "")} is not higher/lower`);
      }
      const attempted = Number(seen.attempted);
      if (!Number.isFinite(attempted)) {
        // Every comparison against NaN is false, so `hi = NaN - 1` would slip
        // past the `lo > hi` exhaustion check below and `midpoint` would hand
        // back NaN for every remaining turn — about thirty `authenticate` calls
        // spent sending the string "NaN". Only reachable on a resume whose
        // pending attempt is not a number, which is exactly when the state we
        // are holding is not ours.
        return unparsed(`${model}: resumed on ${JSON.stringify(seen.attempted)}, which is not a number`);
      }
      let lo = Number(state.scratch["lo"]);
      let hi = Number(state.scratch["hi"]);
      // The guess itself is now excluded, whichever way the answer pointed.
      if (direction === "lower") hi = attempted - 1;
      else lo = attempted + 1;

      if (lo > hi) {
        // The oracle contradicted itself, or the bound we started from was wrong.
        // Either way the password provably is not where our model says it is.
        return {
          kind: "give-up",
          code: SOLVER_CODES.SolverExhausted,
          reason: `${model}: the search range collapsed without a hit`,
        };
      }
      const held = state.scratch["candidates"] as number[] | undefined;
      const candidates = held?.filter((value) => value >= lo && value <= hi);
      if (candidates !== undefined && candidates.length === 0) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.SolverExhausted,
          reason: `${model}: the failure response eliminated every evidence-compatible candidate`,
        };
      }
      const next = {
        ...state,
        spent: state.spent + 1,
        scratch: { ...state.scratch, lo, hi, ...(candidates !== undefined ? { candidates } : {}) },
      };
      const guess = candidates === undefined ? midpoint({ lo, hi }) : candidates[Math.floor(candidates.length / 2)]!;
      return {
        kind: "attempt",
        password: String(guess),
        state: next,
        needsOracle: true,
        note: `binary search in [${lo}, ${hi}]`,
      };
    },
  };
}

// --- 2. the nested modulo, which is not nested ------------------------------

/** `BigMo%od`. The hint calls it `(password % n) % (n % 32)`, and the response is
 * `(P % n) % (((n - 1) % 32) + 1)` (`authentication.ts:75-85`).
 *
 * The attack is the arithmetic identity hiding in the second modulus: for any
 * `n <= 32`, `((n - 1) % 32) + 1` is just `n`, so the outer modulo is applied
 * against `n` itself and does nothing at all. The response is therefore exactly
 * `P mod n` — a clean residue, for free, for any modulus we care to name up to
 * 32.
 *
 * So ask for residues against pairwise-coprime prime powers and reconstruct by
 * the Chinese remainder theorem. The eleven below multiply to about 1.4e14,
 * comfortably past the 1e13 a 13-digit password can reach, and eleven exchanges
 * is well inside one vantage.
 *
 * `n <= 1` is never sent: `(P % 1) % 1` is 0 whatever the password is. */
// Largest coprime information first. The previous ascending tail spent an extra
// exchange at long lengths even though every modulus costs the same call.
const CRT_MODULI = [32, 31, 29, 27, 25, 23, 19, 17, 13, 11, 7] as const;

const tripleModuloSolver: Solver = {
  needsOracle: true,
  budget: () => CRT_MODULI.length + 1,

  first(facts): SolverStep {
    const state = freshState("BigMo%od", facts, "residues");
    state.scratch["index"] = 0;
    state.scratch["residues"] = [];
    return {
      kind: "attempt",
      password: String(CRT_MODULI[0]),
      state,
      needsOracle: true,
      note: `residue against ${CRT_MODULI[0]}`,
    };
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "BigMo%od: opened" };
    if (!seen.oracle) return noOracle("BigMo%od: needs the log ring, which was not readable", state);

    const raw = (seen.oracle.data ?? "").trim();
    const residue = Number(raw);
    if (raw.length === 0 || !Number.isInteger(residue) || residue < 0) {
      return unparsed(`BigMo%od: response ${JSON.stringify(raw)} is not a residue`);
    }
    const index = Number(state.scratch["index"] ?? 0);
    const residues = [...(state.scratch["residues"] as number[] ?? []), residue];
    const used = CRT_MODULI.slice(0, residues.length);

    // Reconstruct as soon as the moduli span the whole value range; there is no
    // reason to spend the remaining exchanges once the answer is determined.
    const span = used.reduce((product, m) => product * BigInt(m), 1n);
    const length = facts.passwordLength ?? 13;
    const ceiling = 10n ** BigInt(Math.max(1, Math.min(length, 18)));
    if (span > ceiling || residues.length === CRT_MODULI.length) {
      const value = chineseRemainder(used.map(BigInt), residues.map(BigInt));
      if (value === undefined) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.SolverExhausted,
          reason: "BigMo%od: the residues were mutually inconsistent",
        };
      }
      return { kind: "answer", password: value.toString(), note: `BigMo%od: reconstructed from ${residues.length} residues` };
    }

    const nextIndex = index + 1;
    return {
      kind: "attempt",
      password: String(CRT_MODULI[nextIndex]),
      state: {
        ...state,
        spent: state.spent + 1,
        scratch: { ...state.scratch, index: nextIndex, residues },
      },
      needsOracle: true,
      note: `residue against ${CRT_MODULI[nextIndex]}`,
    };
  },
};

/** Solve `x = r_i (mod m_i)` for pairwise-coprime moduli. BigInt because the
 * product runs past `MAX_SAFE_INTEGER` once enough residues are in. */
export function chineseRemainder(moduli: readonly bigint[], residues: readonly bigint[]): bigint | undefined {
  let value = residues[0] ?? 0n;
  let modulus = moduli[0] ?? 1n;
  for (let i = 1; i < moduli.length; i++) {
    const m = moduli[i]!;
    const r = residues[i]!;
    const inverse = modularInverse(modulus % m, m);
    if (inverse === undefined) return undefined;
    let step = ((r - (value % m)) * inverse) % m;
    if (step < 0n) step += m;
    value += modulus * step;
    modulus *= m;
  }
  return value;
}

function modularInverse(a: bigint, m: bigint): bigint | undefined {
  let [old_r, r] = [((a % m) + m) % m, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) return undefined;
  return ((old_s % m) + m) % m;
}

// --- 3. the per-position oracle ---------------------------------------------

/** `NIL`, the "yesn't" model. `authentication.ts:51-57`.
 *
 * The response compares our attempt to the password CHARACTER BY CHARACTER and
 * answers `"yes"` or `"yesn't"` for each position independently. That
 * independence is the whole attack, and it makes the cost depend on the ALPHABET
 * rather than on the length: guess `"555…5"` and every position holding a 5
 * answers `"yes"` at once. Ten attempts resolve a numeric password of any
 * length; the alphanumeric case above difficulty 8 costs up to 62.
 *
 * The password length is needed to build the constant strings, and is the one
 * fact this solver cannot proceed without. */
const yesNoSolver: Solver = {
  needsOracle: true,
  budget: (facts) => alphabetFor(facts).length + 2,

  first(facts): SolverStep {
    const length = facts.passwordLength;
    if (length === undefined || length < 1) {
      return unparsed("NIL: needs passwordLength to build a probe");
    }
    const alphabet = alphabetFor(facts);
    const state = freshState("NIL", facts, "positions");
    state.scratch["index"] = 0;
    state.scratch["alphabet"] = alphabet;
    const known = fixedPositionsFromEvidence(length, facts.evidence).map((char) => char ?? null);
    state.scratch["known"] = known;
    if (known.every((char) => char !== null)) {
      return { kind: "answer", password: known.join(""), note: "NIL: every position came from harvested placement hints" };
    }
    return {
      kind: "attempt",
      password: positionProbe(known, alphabet[0]!),
      state,
      needsOracle: true,
      note: `per-position probe for ${JSON.stringify(alphabet[0])}`,
    };
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "NIL: opened" };
    if (!seen.oracle) return noOracle("NIL: needs the log ring, which was not readable", state);

    const raw = (seen.oracle.data ?? "").trim();
    const verdicts = raw.split(",").map((part) => part.trim());
    if (verdicts.length === 0 || !verdicts.every((v) => v === "yes" || v === "yesn't")) {
      return unparsed(`NIL: response ${JSON.stringify(raw)} is not a yes/yesn't list`);
    }
    const known = [...(state.scratch["known"] as (string | null)[])];
    const alphabet = String(state.scratch["alphabet"] ?? alphabetFor(facts));
    const symbol = alphabet[Number(state.scratch["index"] ?? 0)] ?? "";
    verdicts.forEach((verdict, i) => {
      // Known positions are preserved in the probe, so their "yes" confirms
      // the harvested character rather than the symbol under test elsewhere.
      if (verdict === "yes" && i < known.length && known[i] === null) known[i] = symbol;
    });

    if (known.every((char) => char !== null)) {
      return { kind: "answer", password: known.join(""), note: "NIL: every position resolved" };
    }

    const index = Number(state.scratch["index"] ?? 0) + 1;
    // If every position survived every symbol but the final one, the final
    // symbol is forced at all unresolved positions. Asking it would only
    // confirm what alphabet completeness already proves.
    if (index === alphabet.length - 1) {
      for (let at = 0; at < known.length; at++) if (known[at] === null) known[at] = alphabet[index]!;
      return { kind: "answer", password: known.join(""), note: "NIL: inferred the final alphabet symbol" };
    }

    if (index >= alphabet.length) {
      // Every symbol tried and positions still unresolved: the password contains
      // something outside the format the host reported.
      return {
        kind: "give-up",
        code: SOLVER_CODES.SolverExhausted,
        reason: `NIL: exhausted the ${alphabet.length}-symbol alphabet with ${known.filter((c) => c === null).length} positions unresolved`,
      };
    }
    return {
      kind: "attempt",
      password: positionProbe(known, alphabet[index]!),
      state: { ...state, spent: state.spent + 1, scratch: { ...state.scratch, index, known } },
      needsOracle: true,
      note: `per-position probe for ${JSON.stringify(alphabet[index])}`,
    };
  },
};

// --- 4. the sorted echo, in two regimes -------------------------------------

/** `PHP 5.4`. `ServerGenerator.ts:107-124`, `authentication.ts:127-143`.
 *
 * `data` hands over the password's characters SORTED, which gives us the
 * multiset for free and leaves only the ordering. How that ordering is found
 * depends on a length threshold in upstream's own feedback arm, and the two
 * regimes could hardly be more different:
 *
 * **Below length 5** the arm returns before computing anything — it requires
 * `password.length >= 5` — so there is no oracle at all. With at most four
 * characters drawn from a known multiset that is fine: enumerate the distinct
 * permutations (24 at the very worst, usually far fewer) and walk them. Because
 * this regime reads no response, it is the one interactive model that runs
 * BELOW the charisma gate. `getPassword` strips leading zeros from a numeric
 * password, so any ordering starting with `0` is skipped rather than tried.
 *
 * **At length 5 and above** the response carries the root-mean-square deviation
 * between our attempt and the password, digit by digit, to three decimals. That
 * is not a gradient to descend, it is a linear equation to solve. With
 * `SE = L * rmsd^2` and `SE0 = sum(p_i^2)` known for free from the multiset,
 * probing `000…9…000` with the 9 at position `i` gives
 * `SE_i = SE0 + 81 - 18*p_i`, so `p_i = (SE0 + 81 - SE_i) / 18` — one exchange
 * per position, exactly, and the last digit falls out of the multiset. */
const sortedEchoSolver: Solver = {
  needsOracle: true,

  budget: (facts) => {
    const length = facts.passwordLength ?? 4;
    return length >= 5 ? length + 2 : 24;
  },

  first(facts): SolverStep {
    const sorted = (facts.data ?? "").trim();
    if (sorted.length === 0) return unparsed("PHP 5.4: data does not carry the sorted password");
    const length = facts.passwordLength ?? sorted.length;

    if (length < 5) {
      const orderings = distinctPermutations(sorted)
        .filter((candidate) => !isLeadingZero(candidate, facts))
        .filter((candidate) => candidateMatchesEvidence(candidate, facts.evidence));
      if (orderings.length === 0) {
        return { kind: "give-up", code: SOLVER_CODES.SolverExhausted, reason: "PHP 5.4: no admissible ordering" };
      }
      const state = freshState("PHP 5.4", facts, "permute");
      state.scratch["orderings"] = orderings;
      state.scratch["index"] = 0;
      return {
        kind: "attempt",
        password: orderings[0]!,
        // Below length 5 the model produces no feedback, so this runs where
        // heartbleed cannot: below the host's charisma requirement.
        needsOracle: false,
        state,
        note: `ordering 1/${orderings.length} of a known multiset`,
      };
    }

    const state = freshState("PHP 5.4", facts, "rmsd");
    const containsEvidence = facts.evidence?.filter((item) => item.kind === "contains");
    if (!candidateMatchesEvidence(sorted, containsEvidence)) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.SolverExhausted,
        reason: "PHP 5.4: harvested character hints contradict the published multiset",
      };
    }
    const fixed = fixedPositionsFromEvidence(length, facts.evidence);
    const digits = fixed.map((char) => {
      if (char === undefined) return null;
      return /^\d$/.test(char) ? Number(char) : Number.NaN;
    });
    const completed = finishRmsPassword(sorted, digits, facts);
    if (completed) return completed;
    const position = digits.findIndex((digit) => digit === null);
    state.scratch["position"] = position;
    state.scratch["digits"] = digits;
    return {
      kind: "attempt",
      password: probeAt(position, length),
      state,
      needsOracle: true,
      note: `rms probe for position ${position + 1}`,
    };
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "PHP 5.4: opened" };
    const sorted = (facts.data ?? "").trim();

    if (state.phase === "permute") {
      const orderings = state.scratch["orderings"] as string[];
      const index = Number(state.scratch["index"] ?? 0) + 1;
      if (index >= orderings.length) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.SolverExhausted,
          reason: `PHP 5.4: all ${orderings.length} orderings of the multiset were refused`,
        };
      }
      return {
        kind: "attempt",
        password: orderings[index]!,
        needsOracle: false,
        state: { ...state, spent: state.spent + 1, scratch: { ...state.scratch, index } },
        note: `ordering ${index + 1}/${orderings.length} of a known multiset`,
      };
    }

    if (!seen.oracle) return noOracle("PHP 5.4: needs the log ring, which was not readable", state);
    const rmsd = readRmsd(seen.oracle.data ?? "");
    if (rmsd === undefined) {
      return unparsed(`PHP 5.4: response ${JSON.stringify(seen.oracle.data ?? "")} carries no RMS deviation`);
    }

    const digits = [...(state.scratch["digits"] as (number | null)[])];
    const length = digits.length;
    const position = Number(state.scratch["position"] ?? 0);
    const squareTotal = [...sorted].reduce((total, char) => total + Number(char) ** 2, 0);
    // SE_i = SE0 + 81 - 18 * p_i, and SE = L * rmsd^2.
    const observed = length * rmsd * rmsd;
    const digit = Math.round((squareTotal + 81 - observed) / 18);
    if (!Number.isFinite(digit) || digit < 0 || digit > 9) {
      return stalled(`PHP 5.4: position ${position + 1} solved to ${digit}, which is not a digit`, state);
    }
    digits[position] = digit;
    const completed = finishRmsPassword(sorted, digits, facts);
    if (completed) return completed;
    const nextPosition = digits.findIndex((held) => held === null);
    return {
      kind: "attempt",
      password: probeAt(nextPosition, length),
      state: {
        ...state,
        spent: state.spent + 1,
        scratch: { ...state.scratch, position: nextPosition, digits },
      },
      needsOracle: true,
      note: `rms probe for position ${nextPosition + 1}`,
    };
  },
};

function positionProbe(known: readonly (string | null)[], symbol: string): string {
  return known.map((char) => char ?? symbol).join("");
}

/** Validate resolved positions against the published multiset. Once only one
 * position remains, its digit is free; once all are resolved, every generic
 * placement constraint is checked before asserting the password. */
function finishRmsPassword(
  sorted: string,
  digits: (number | null)[],
  facts: PasswordFacts,
): SolverStep | undefined {
  const remaining = [...sorted];
  for (const digit of digits) {
    if (digit === null) continue;
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.SolverExhausted,
        reason: `PHP 5.4: placement evidence fixed an invalid digit ${digit}`,
      };
    }
    const at = remaining.indexOf(String(digit));
    if (at === -1) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.SolverExhausted,
        reason: `PHP 5.4: resolved digit ${digit} is absent from the published multiset`,
      };
    }
    remaining.splice(at, 1);
  }

  const unknown = digits.flatMap((digit, index) => digit === null ? [index] : []);
  if (unknown.length > 1) return undefined;
  if (unknown.length === 1) {
    if (remaining.length !== 1) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.SolverExhausted,
        reason: "PHP 5.4: the final position has no unique multiset completion",
      };
    }
    digits[unknown[0]!] = Number(remaining[0]);
    remaining.length = 0;
  }
  if (remaining.length !== 0) {
    return {
      kind: "give-up",
      code: SOLVER_CODES.SolverExhausted,
      reason: "PHP 5.4: resolved positions did not consume the published multiset",
    };
  }
  const password = digits.join("");
  if (!candidateMatchesEvidence(password, facts.evidence)) {
    return {
      kind: "give-up",
      code: SOLVER_CODES.SolverExhausted,
      reason: "PHP 5.4: the RMS solution contradicts harvested placement evidence",
    };
  }
  return { kind: "answer", password, note: "PHP 5.4: positions solved by RMS and the published multiset" };
}

/** `"0…090…0"` — a 9 at `position`, zeros elsewhere. The attempt must be the
 * same length as the password or upstream's arm returns before measuring. */
function probeAt(position: number, length: number): string {
  return "0".repeat(position) + "9" + "0".repeat(Math.max(0, length - position - 1));
}

/** The deviation out of `"<sorted>; RMS Deviation:<x.xxx>"`. */
export function readRmsd(data: string): number | undefined {
  const found = data.match(/RMS Deviation:\s*(-?\d+(?:\.\d+)?)/i);
  if (!found) return undefined;
  const value = Number(found[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** Every distinct ordering of a multiset, in a stable order so a resumed solve
 * continues where it left off rather than restarting. */
export function distinctPermutations(characters: string): string[] {
  const source = [...characters].sort();
  const out: string[] = [];
  const used = new Array<boolean>(source.length).fill(false);
  const current: string[] = [];
  const walk = (): void => {
    if (current.length === source.length) {
      out.push(current.join(""));
      return;
    }
    let previous: string | undefined;
    for (let i = 0; i < source.length; i++) {
      if (used[i]) continue;
      // Skip a repeated character at the same depth, which is what makes these
      // DISTINCT permutations rather than n! with duplicates.
      if (source[i] === previous) continue;
      previous = source[i];
      used[i] = true;
      current.push(source[i]!);
      walk();
      current.pop();
      used[i] = false;
    }
  };
  walk();
  return out;
}

/** A numeric password never begins with `0` — `getPassword` puts it through
 * `Number(...).toString()` — so such an ordering can be skipped unattempted. */
function isLeadingZero(candidate: string, facts: PasswordFacts): boolean {
  if (candidate.length < 2) return false;
  if (facts.passwordFormat !== undefined && facts.passwordFormat !== "numeric") return false;
  return candidate.startsWith("0");
}

export const SEARCH_SOLVERS = {
  guessNumber: binarySearchSolver("AccountsManager_4.2", boundsFromLength),
  romanRange: binarySearchSolver("BellaCuore", boundsFromRomanRange),
  tripleModulo: tripleModuloSolver,
  yesNo: yesNoSolver,
  sortedEcho: sortedEchoSolver,
} as const;
