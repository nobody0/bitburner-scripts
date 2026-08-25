/** The eight models that hand us the password and hope we do not notice.
 *
 * Each of these publishes its own secret in an encoded form, in the
 * `passwordHint` or `data` fields that `getServerDetails` returns for 0.1 GB.
 * No `authenticate`, no `heartbleed`, no log ring, no charisma: one call to read
 * the host, one call to open it.
 *
 * That makes them worth doing before anything else, and by a wide margin. The
 * model pool is banded by difficulty (`ServerGenerator.ts:18-62`) and the band a
 * fresh net's shallow rows draw from — difficulty <= 2 — is exactly four models:
 * `ZeroLogon` and `FreshInstall_1.0`, which are already solved dictionaries, and
 * `DeskMemo_3.1` and `CloudBlare(tm)`, which are here. So these two arms alone
 * close the whole of the shallow net, at zero round trips and zero risk.
 *
 * ## The shape of a closed-form solver
 *
 * `first()` returns an `answer`, not an `attempt`: we are not guessing, we are
 * asserting. If that assertion is refused, something is wrong with our reading
 * of the game rather than with our luck, and `next()` says so — except for the
 * two numeric models, whose success check accepts a near-enough answer and whose
 * encoding is deliberately lossy, where a small rounding ladder is legitimate.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/controllers/ServerGenerator.ts  (every generator quoted below)
 *   src/DarkNet/effects/authentication.ts:86-94, 152-164  (the tolerance) */

import type { ModelId, PasswordFacts } from "../models.ts";
import {
  LARGE_PRIMES,
  NUMBERS,
  SMALL_PRIMES,
  parseBaseNNumberString,
  parseSimpleArithmeticExpressionFast,
  romanNumeralDecoder,
} from "../codecs.ts";
import { SOLVER_CODES, freshState, type Solver, type SolverState, type SolverStep } from "./types.ts";

/** A decode either produces the password or explains why it could not. The
 * explanation matters: "the field was empty" is a survey problem, while "the
 * field was there and did not parse" is grammar drift and has to be loud. */
export type Decoded = { ok: true; password: string } | { ok: false; reason: string; empty: boolean };

const missing = (field: string): Decoded => ({ ok: false, reason: `${field} is empty`, empty: true });
const unparsed = (reason: string): Decoded => ({ ok: false, reason, empty: false });

// --- the eight decoders -----------------------------------------------------

/** `DeskMemo_3.1` — the echo vulnerability. `ServerGenerator.ts:90-106`.
 *
 * The generator builds `hint = "<one of six templates> <password>"` and stores
 * nothing in `data`. So the password is the last whitespace-separated token of
 * the hint, in plain sight. */
export function decodeEcho(facts: PasswordFacts): Decoded {
  const hint = facts.passwordHint ?? "";
  if (hint.length === 0) return missing("passwordHint");
  const tokens = hint.trim().split(/\s+/);
  const candidate = tokens[tokens.length - 1] ?? "";
  if (candidate.length === 0) return unparsed("hint has no trailing token");
  // The generator's password is numeric. A trailing token that is not numeric
  // means the templates changed and we are reading the wrong word.
  if (![...candidate].every((char) => NUMBERS.includes(char))) {
    return unparsed(`hint's trailing token ${JSON.stringify(candidate)} is not numeric`);
  }
  return { ok: true, password: candidate };
}

/** `CloudBlare(tm)` — the captcha. `ServerGenerator.ts:161-188`.
 *
 * `data` is the password with one to three filler characters inserted after
 * every character but the last. The filler alphabet contains no digit
 * (`codecs.ts`, and `tests/dnet-codecs.test.ts` pins that), and the password is
 * numeric — so removing every non-digit leaves exactly the password. */
export function decodeCaptcha(facts: PasswordFacts): Decoded {
  const data = facts.data ?? "";
  if (data.length === 0) return missing("data");
  const digits = [...data].filter((char) => NUMBERS.includes(char)).join("");
  if (digits.length === 0) return unparsed("captcha data holds no digits");
  return { ok: true, password: digits };
}

/** `110100100` — binary encoding. `ServerGenerator.ts:299-311`.
 *
 * `data` is each character's code point as a zero-padded 8-bit string, joined by
 * spaces. Works unchanged for the alphanumeric case above difficulty 8. */
export function decodeBinary(facts: PasswordFacts): Decoded {
  const data = facts.data ?? "";
  if (data.trim().length === 0) return missing("data");
  const groups = data.trim().split(/\s+/);
  let password = "";
  for (const group of groups) {
    if (!/^[01]{1,16}$/.test(group)) return unparsed(`${JSON.stringify(group)} is not a binary group`);
    password += String.fromCharCode(parseInt(group, 2));
  }
  return { ok: true, password };
}

/** `OrdoXenos` — the XOR mask. `ServerGenerator.ts:313-336`.
 *
 * `data` is `"<masked>;<mask> <mask> ..."`, one 8-bit mask per character. The
 * generator loops until the masked half contains no `;` and no space, which is
 * what makes splitting on `;` and on whitespace safe rather than merely likely. */
export function decodeXorMask(facts: PasswordFacts): Decoded {
  const data = facts.data ?? "";
  if (data.length === 0) return missing("data");
  const semicolon = data.indexOf(";");
  if (semicolon === -1) return unparsed("xor data has no ';' separator");
  const masked = data.slice(0, semicolon);
  const maskStrings = data.slice(semicolon + 1).trim().split(/\s+/);
  if (masked.length !== maskStrings.length) {
    return unparsed(`xor data has ${masked.length} characters but ${maskStrings.length} masks`);
  }
  let password = "";
  for (let i = 0; i < masked.length; i++) {
    const mask = maskStrings[i]!;
    if (!/^[01]{1,16}$/.test(mask)) return unparsed(`${JSON.stringify(mask)} is not a binary mask`);
    password += String.fromCharCode(masked.charCodeAt(i) ^ parseInt(mask, 2));
  }
  return { ok: true, password };
}

/** `PrimeTime 2` — the largest prime factor. `ServerGenerator.ts:247-255, 669-683`.
 *
 * `data` is the target, built as one entry from `LARGE_PRIMES` multiplied by up
 * to six entries from `SMALL_PRIMES`. So the attack is not "factorise a large
 * number" — trial division to the square root would be ~9e7 steps on a target
 * that reaches 8.2e15. Divide out the 25 small primes and whatever survives IS
 * the answer, in at most a few dozen operations.
 *
 * BigInt throughout: the target's ceiling sits just under `MAX_SAFE_INTEGER`,
 * which is too close to trust to floating point. */
export function decodeLargestPrimeFactor(facts: PasswordFacts): Decoded {
  const data = (facts.data ?? "").trim();
  if (data.length === 0) return missing("data");
  if (!/^\d+$/.test(data)) return unparsed(`${JSON.stringify(data)} is not a whole number`);

  let remaining = BigInt(data);
  if (remaining <= 1n) return unparsed(`target ${data} has no prime factor`);
  for (const prime of SMALL_PRIMES) {
    const p = BigInt(prime);
    while (remaining % p === 0n) remaining /= p;
  }
  // Everything above 97 that divides the target was, by construction, the single
  // large prime. If it is not one we know, our transcription of the tables is
  // stale — say so rather than authenticating against a guess.
  if (remaining === 1n) return unparsed(`target ${data} is built only from small primes`);
  if (!LARGE_PRIMES.includes(Number(remaining))) {
    return unparsed(`residue ${remaining} is not in the transcribed large-prime table`);
  }
  return { ok: true, password: remaining.toString() };
}

/** `OctantVoxel` — convert to base 10. `ServerGenerator.ts:347-361`.
 *
 * `data` is `"<base>,<encoded>"`. Above difficulty 12 the base is FRACTIONAL,
 * and upstream's encoder does not terminate cleanly on a fractional base — which
 * is precisely why this model's success check accepts a near-enough answer
 * rather than an equal one. We therefore return the raw conversion and let the
 * rounding ladder in `next()` handle the rest. */
export function decodeBaseN(facts: PasswordFacts): Decoded {
  const data = (facts.data ?? "").trim();
  if (data.length === 0) return missing("data");
  const comma = data.indexOf(",");
  if (comma === -1) return unparsed("base-N data has no ',' separator");
  const base = Number(data.slice(0, comma));
  const encoded = data.slice(comma + 1).trim();
  if (!Number.isFinite(base) || base <= 1) return unparsed(`${JSON.stringify(data.slice(0, comma))} is not a base`);
  if (encoded.length === 0) return unparsed("base-N data has no encoded value");
  const value = parseBaseNNumberString(encoded, base);
  if (!Number.isFinite(value)) return unparsed(`${JSON.stringify(encoded)} did not convert in base ${base}`);
  // The generated password is a whole number (`ceil(random * 99 * (d + 1))`),
  // so rounding is the right first guess even when the encoding was lossy.
  return { ok: true, password: String(Math.round(value)) };
}

/** `MathML` — the parsed expression. `ServerGenerator.ts:363-382`.
 *
 * `data` is an arithmetic expression whose VALUE is the password. Evaluated with
 * the transcribed parser in `codecs.ts` and never with `eval`: above difficulty
 * 16 upstream appends a payload that opens the dev menu and kills the script,
 * specifically to catch a solver that takes the shortcut.
 *
 * The password is `${result}`, which may be fractional — and may be NEGATIVE,
 * which is worth knowing about. The engine's tolerance check is
 * `difference < 0.01 || difference / Number(correctPassword) < 0.005`
 * (`authentication.ts:152-158`), and the second half is trivially true whenever
 * the password is negative, since a positive difference divided by a negative
 * number is always below any positive bound. So on such a host EVERY parseable
 * numeric attempt authenticates. We do not lean on that — evaluating the
 * expression answers correctly either way — but it explains why one of these
 * hosts may open on a value that looks wrong. */
export function decodeArithmetic(facts: PasswordFacts): Decoded {
  const data = (facts.data ?? "").trim();
  if (data.length === 0) return missing("data");
  const value = parseSimpleArithmeticExpressionFast(data);
  if (!Number.isFinite(value)) return unparsed(`${JSON.stringify(data)} did not evaluate`);
  return { ok: true, password: String(value) };
}

/** `BellaCuore` — the Roman numeral, BELOW difficulty 8.
 * `ServerGenerator.ts:221-231`.
 *
 * Two regimes share one model id, and they are told apart by the shape of
 * `data`: below difficulty 8 it is a single numeral naming the password, and at
 * or above it is `"<min>,<max>"` bounding a search. Reading the shape rather
 * than the difficulty means we do not need a fact we might not hold. */
export function decodeRoman(facts: PasswordFacts): Decoded {
  const data = (facts.data ?? "").trim();
  if (data.length === 0) return missing("data");
  if (data.includes(",")) return unparsed("roman data is a range, which needs the search solver");
  const value = romanNumeralDecoder(data);
  if (!Number.isFinite(value)) return unparsed(`${JSON.stringify(data)} is not a Roman numeral`);
  return { ok: true, password: String(value) };
}

/** `Pr0verFl0` — the buffer overflow. `authentication.ts:101-118`.
 *
 * Not a decoder: nothing is published. It is a closed-form CRAFT, and the
 * cheapest solve in the whole feature — one attempt, no oracle, no charisma.
 *
 * Upstream simulates a buffer holding the received value followed by the
 * expected one, each `L` characters wide, and lets a long attempt overwrite the
 * expected half:
 *
 *     buffer      = "_"*L + mask*L                       // 2L wide
 *     overwritten = attempt.slice(0, 2L) + buffer.slice(attempt.length)
 *     success     <=> overwritten[0..L) === overwritten[L..2L)
 *
 * Send an attempt of exactly `2L` characters and the tail slice is empty, so
 * `overwritten` IS the attempt and the test collapses to "are its two halves
 * equal". Any such string wins; `"00...0"` is as good as any. `L` runs 4 to 7
 * (`ServerGenerator.ts:289-297`), so the attempt is at most 14 characters — far
 * under the 100 above which `authenticate` throws and kills the agent.
 *
 * The one fact it needs is the length, which `getServerDetails` reports and the
 * hint also states in words ("Warning: password buffer is L bytes"). */
export function craftBufferOverflow(facts: PasswordFacts): Decoded {
  const length = facts.passwordLength ?? lengthFromBufferHint(facts.passwordHint ?? "");
  if (length === undefined || length < 1) return missing("passwordLength");
  // Two equal halves. Guard the engine's own limit rather than trusting the
  // reported length: a throw out there kills the process, it does not fail the
  // attempt.
  if (length * 2 > 100) return unparsed(`buffer of ${length} would need a ${length * 2}-character attempt`);
  return { ok: true, password: "0".repeat(length * 2) };
}

/** The length out of `"Warning: password buffer is N bytes"`, for the case where
 * the survey has the hint but not the length. */
function lengthFromBufferHint(hint: string): number | undefined {
  const found = hint.match(/buffer is (\d+) bytes/i);
  if (!found) return undefined;
  const value = Number(found[1]);
  return Number.isInteger(value) ? value : undefined;
}

// --- wrapping a decoder as a Solver ----------------------------------------

/** How a closed-form solver behaves when its answer is REFUSED.
 *
 * For most of these a refusal is a bug report: the field was there, it parsed,
 * and the value was wrong, which means our reading of the generator is wrong.
 * Saying `SolverExhausted` puts that in the response-code panel where it will be
 * noticed, instead of quietly retrying forever.
 *
 * The two numeric models are the exception, and only because upstream says so:
 * their success check is `|delta| < 0.01 || relative < 0.005`, and their
 * encoding is lossy on purpose. A three-step ladder around our answer is
 * legitimate there, not a guess. */
type Refusal = "report" | "ladder";

function closedForm(
  model: ModelId,
  decode: (facts: PasswordFacts) => Decoded,
  onRefusal: Refusal,
  label: string,
): Solver {
  const ladderOffsets = [1, -1, 2];
  return {
    needsOracle: false,
    budget: () => (onRefusal === "ladder" ? 1 + ladderOffsets.length : 1),

    first(facts: PasswordFacts): SolverStep {
      const decoded = decode(facts);
      if (!decoded.ok) {
        return {
          kind: "give-up",
          // An empty field is something a survey can fix; a field that would not
          // parse is not. They must not read alike.
          code: decoded.empty ? SOLVER_CODES.OracleUnavailable : SOLVER_CODES.OracleUnparsed,
          reason: `${label}: ${decoded.reason}`,
        };
      }
      if (onRefusal === "report") {
        return { kind: "answer", password: decoded.password, note: `${label}: decoded from the host's own hint` };
      }
      // The ladder needs to remember where it is, so it sends the same value as
      // a tracked attempt rather than as a bare assertion.
      const state = freshState(model, facts, "ladder");
      state.scratch["base"] = decoded.password;
      state.scratch["step"] = 0;
      return {
        kind: "attempt",
        password: decoded.password,
        state,
        needsOracle: false,
        note: `${label}: decoded, exact value first`,
      };
    },

    next(facts: PasswordFacts, state: SolverState, seen): SolverStep {
      if (seen.success) return { kind: "answer", password: seen.attempted, note: `${label}: opened` };
      if (onRefusal === "report") {
        return {
          kind: "give-up",
          code: SOLVER_CODES.SolverExhausted,
          reason: `${label}: the decoded password was refused, so our reading of this model is wrong`,
        };
      }
      const base = Number(state.scratch["base"]);
      const step = Number(state.scratch["step"] ?? 0);
      if (!Number.isFinite(base) || step >= ladderOffsets.length) {
        return {
          kind: "give-up",
          code: SOLVER_CODES.SolverExhausted,
          reason: `${label}: the decoded value and its neighbours were all refused`,
        };
      }
      const password = String(Math.round(base) + ladderOffsets[step]!);
      return {
        kind: "attempt",
        password,
        state: { ...state, spent: state.spent + 1, scratch: { ...state.scratch, step: step + 1 } },
        needsOracle: false,
        note: `${label}: rounding ladder ${step + 1}/${ladderOffsets.length}`,
      };
    },
  };
}

/** The solver for each closed-form model, by the mechanic it exploits. */
export const CLOSED_FORM_SOLVERS = {
  echo: closedForm("DeskMemo_3.1", decodeEcho, "report", "echo vulnerability"),
  captcha: closedForm("CloudBlare(tm)", decodeCaptcha, "report", "captcha"),
  binary: closedForm("110100100", decodeBinary, "report", "binary encoding"),
  xorMask: closedForm("OrdoXenos", decodeXorMask, "report", "xor mask"),
  largestPrimeFactor: closedForm("PrimeTime 2", decodeLargestPrimeFactor, "report", "largest prime factor"),
  romanNumeral: closedForm("BellaCuore", decodeRoman, "report", "roman numeral"),
  bufferOverflow: closedForm("Pr0verFl0", craftBufferOverflow, "report", "buffer overflow"),
  // The two the engine grades with a tolerance.
  baseN: closedForm("OctantVoxel", decodeBaseN, "ladder", "base-N conversion"),
  arithmetic: closedForm("MathML", decodeArithmetic, "ladder", "arithmetic expression"),
} as const;
