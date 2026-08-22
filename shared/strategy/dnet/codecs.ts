/** Upstream's reversible encodings, transcribed once and used from both ends.
 *
 * Several darknet models publish their password in an ENCODED form — a base-N
 * string, a Roman numeral, an XOR mask, an arithmetic expression — and hand it
 * to us in `getServerDetails().data`. Two different parts of this repository
 * therefore need the same piece of upstream:
 *
 * - the solvers (`shared/strategy/dnet/solvers/`) need the DECODER, to turn the
 *   published form back into the password;
 * - the simulator (`sim/features/dnet.ts`) needs the ENCODER, to generate a host
 *   whose data field says what the real game's would say.
 *
 * `parseSimpleArithmeticExpression` is needed verbatim by both: the solver
 * evaluates the expression to get the password, and the generator evaluates it
 * to know what the password IS. Transcribing that twice would let the two copies
 * drift, and a drift between the sim's generator and our solver is the worst
 * kind — it passes every test and fails in the game. So it lives here, once, and
 * `sim/` imports it (`sim/` may import `shared/`; the reverse is forbidden).
 *
 * Everything here is a verbatim transcription, INCLUDING the parts that look
 * like bugs. `encodeNumberInBaseN`'s `0.0001` loop bound and
 * `parseSimpleArithmeticExpression`'s regex-rewriting evaluator are reproduced
 * as written, because what we need is not a correct implementation but THE SAME
 * implementation: a value our decoder rounds differently from upstream's encoder
 * is a password we cannot open.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/controllers/ServerGenerator.ts  (the codecs and getPassword)
 *   src/DarkNet/models/dictionaryData.ts        (the alphabets and filler)
 *   src/DarkNet/Constants.ts                    (MAX_PASSWORD_LENGTH)
 *
 * ## RAM
 *
 * This module reaches game scripts through the solvers, so it obeys the same
 * rule as `oracle.ts`: **never `RegExp.prototype.exec`**. Bitburner's static
 * analyser charges by MEMBER NAME, so a single `pattern.exec(s)` anywhere in a
 * bundle that reaches a game script bills the full 1.3 GB of `ns.exec`.
 * `String.prototype.match` is free and does the same job. `oracle.ts:126-137`
 * tells the same story at more length; `tests/ram-budget.test.ts` catches a
 * regression, but as a mysterious 1.3 GB rather than as this sentence. */

/** `dictionaryData.ts:4-7`. */
export const NUMBERS = "0123456789";
export const LETTERS_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const LETTERS_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const LETTERS = LETTERS_LOWERCASE + LETTERS_UPPERCASE;

/** `dictionaryData.ts:10`. The junk `Captcha` interleaves between the real
 * characters — and it contains no digits, which is the whole attack on that
 * model: strip every non-digit and what is left IS the password. */
export const FILLER = "/[]╬╸.-()*~:;><#\\";

/** `DarkNet/Constants.ts:11`, and the longest password the generator will MINT.
 *
 * Note what it is not: `authenticate` refuses an attempt only above
 * `MAX_PASSWORD_LENGTH * 2` (`NetscriptFunctions/Darknet.ts:102`), and it
 * THROWS rather than failing, which would kill the agent process. So a solver
 * clamps a crafted attempt to 100, not to 50 — `Pr0verFl0`'s buffer overflow
 * deliberately sends up to twice the password length and would be truncated to
 * uselessness by the tighter bound. */
export const MAX_PASSWORD_LENGTH = 50;

/** `ServerGenerator.ts:658-660`. Used by `LargestPrimeFactor` (as the small
 * factors multiplied onto the target) and by `divisibilityTest` (as the pool the
 * password's factors are drawn from), so a solver for either only ever has to
 * consider these. */
export const SMALL_PRIMES: readonly number[] = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
];

/** `ServerGenerator.ts:661-667`. */
export const LARGE_PRIMES: readonly number[] = [
  1069, 1409, 1471, 1567, 1597, 1601, 1697, 1747, 1801, 1889, 1979, 1999, 2063, 2207, 2371, 2503, 2539, 2693, 2741,
  2753, 2801, 2819, 2837, 2909, 2939, 3169, 3389, 3571, 3761, 3881, 4217, 4289, 4547, 4729, 4789, 4877, 4943, 4951,
  4957, 5393, 5417, 5419, 5441, 5519, 5527, 5647, 5779, 5881, 6007, 6089, 6133, 6389, 6451, 6469, 6547, 6661, 6719,
  6841, 7103, 7549, 7559, 7573, 7691, 7753, 7867, 8053, 8081, 8221, 8329, 8599, 8677, 8761, 8839, 8963, 9103, 9199,
  9343, 9467, 9551, 9601, 9739, 9749, 9859,
];

/** The alphabet base-N encoding draws from: 0-9 then UPPERCASE only, so base 36
 * is the ceiling and a lowercase letter never appears.
 * `ServerGenerator.ts:420, 439`. */
const BASE_N_CHARACTERS = [...NUMBERS.split(""), ...LETTERS_UPPERCASE.split("")];

/** `ServerGenerator.ts:417-435`. Verbatim, fractional bases and all.
 *
 * The `remaining >= 0.0001` bound is upstream's, not a rounding we chose: above
 * difficulty 12 the base itself is fractional, so the encoding does not
 * terminate cleanly and this is where it stops. That is exactly why the model's
 * success check accepts a near-enough answer rather than an equal one. */
export function encodeNumberInBaseN(decimalNumber: number, base: number): string {
  let digits = Math.floor(Math.log(decimalNumber) / Math.log(base));
  let remaining = decimalNumber;
  let result = "";

  while (remaining >= 0.0001 || digits >= 0) {
    if (digits === -1) result += ".";
    const place = Math.floor(remaining / base ** digits);
    result += BASE_N_CHARACTERS[place];
    remaining -= place * base ** digits;
    digits -= 1;
  }
  return result;
}

/** `ServerGenerator.ts:437-455`. The inverse, and the whole of the
 * `ConvertToBase10` attack: `data` is `"<base>,<encoded>"`, so one call answers
 * the host with no round trip at all. */
export function parseBaseNNumberString(numberString: string, base: number): number {
  let result = 0;
  let index = 0;
  let digit = numberString.split(".")[0]!.length - 1;

  while (index < numberString.length) {
    const currentDigit = numberString[index]!;
    if (currentDigit === ".") {
      index += 1;
      continue;
    }
    result += BASE_N_CHARACTERS.indexOf(currentDigit) * base ** digit;
    index += 1;
    digit -= 1;
  }
  return result;
}

/** `ServerGenerator.ts:599-625`. Note the zero case: upstream answers `"nulla"`,
 * not the empty string, and its decoder round-trips that spelling. */
export function romanNumeralEncoder(input: number): string {
  const romanNumerals: Record<number, string> = {
    1: "I", 4: "IV", 5: "V", 9: "IX", 10: "X", 40: "XL", 50: "L",
    90: "XC", 100: "C", 400: "CD", 500: "D", 900: "CM", 1000: "M",
  };
  const keys = Object.keys(romanNumerals).map((key) => Number(key));
  let remaining = input;
  let result = "";
  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i]!;
    while (remaining >= key) {
      result += romanNumerals[key];
      remaining -= key;
    }
  }
  return result || "nulla";
}

/** `ServerGenerator.ts:628-654`. Subtractive notation handled by walking right
 * to left and subtracting anything smaller than what followed it. */
export function romanNumeralDecoder(input: string): number {
  if (input.toLowerCase() === "nulla") return 0;

  const romanToInt: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  let prevValue = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    const currentValue = romanToInt[input[i]!];
    if (currentValue === undefined) continue;
    if (currentValue < prevValue) total -= currentValue;
    else total += currentValue;
    prevValue = currentValue;
  }
  return total;
}

/** `ServerGenerator.ts:551-561`. Two jobs, and the second is a safety device.
 *
 * Above difficulty 18 upstream swaps the operators for lookalike unicode
 * (the multiply, divide, plus and minus glyphs); this puts them back. And above
 * difficulty 16 it may APPEND a hostile payload — upstream's `getCodeInjection()`
 * sets a global, raises an alert, opens the dev menu and exits the script —
 * while above difficulty 20 it splices an exit call into an existing
 * parenthesis. The game is deliberately baiting an `eval` of this string.
 * Stripping the spliced call and cutting at the first comma is upstream's own
 * defusing, and it is why our solver evaluates with the transcribed parser below
 * and NEVER with `eval` or `Function`. */
export function cleanArithmeticExpression(expression: string): string {
  const expressionWithFixedSymbols = expression
    .replaceAll("ҳ", "*")
    .replaceAll("÷", "/")
    .replaceAll("➕", "+")
    .replaceAll("➖", "-")
    .replaceAll("ns.exit(),", "");
  return expressionWithFixedSymbols.split(",")[0]!;
}

/** `ServerGenerator.ts:459-513`. A recursive evaluator that rewrites the string
 * in place: innermost parentheses first, then every multiply and divide, then
 * every add and subtract. Transcribed rather than replaced by a clean tokeniser,
 * because the password is defined as whatever THIS function returns,
 * floating-point accidents included.
 *
 * `match` throughout, never `exec` — see the RAM note at the top of this file. */
export function parseSimpleArithmeticExpression(expression: string): number {
  const tokens = cleanArithmeticExpression(expression).split("");

  // Identify parentheses.
  let currentDepth = 0;
  const depth = tokens.map((token) => {
    if (token === "(") {
      currentDepth += 1;
    } else if (token === ")") {
      currentDepth -= 1;
      return currentDepth + 1;
    }
    return currentDepth;
  });
  const depth1Start = depth.indexOf(1);
  // The last index at depth 1 before the first return to depth 0.
  const firstZeroAfterDepth1Start = depth.indexOf(0, depth1Start);
  const depth1End = firstZeroAfterDepth1Start === -1 ? depth.length - 1 : firstZeroAfterDepth1Start - 1;
  if (depth1Start !== -1) {
    const subExpression = tokens.slice(depth1Start + 1, depth1End).join("");
    const inner = parseSimpleArithmeticExpression(subExpression);
    tokens.splice(depth1Start, depth1End - depth1Start + 1, inner.toString());
    return parseSimpleArithmeticExpression(tokens.join(""));
  }

  let remainingExpression = tokens.join("");

  const multiplicationDivisionPattern = /(-?\d*\.?\d+) *([*/]) *(-?\d*\.?\d+)/;
  let found = remainingExpression.match(multiplicationDivisionPattern);
  while (found) {
    const left = found[1]!;
    const operator = found[2]!;
    const right = found[3]!;
    const value = operator === "*" ? parseFloat(left) * parseFloat(right) : parseFloat(left) / parseFloat(right);
    // Upstream's own guard against an intermediate collapsing to "0" and being
    // re-consumed as a bare literal by the next pass.
    const valueString = Math.abs(value) < 0.000001 ? value.toFixed(20) : value.toString();
    remainingExpression = remainingExpression.replace(found[0], valueString);
    found = remainingExpression.match(multiplicationDivisionPattern);
  }

  const additionSubtractionPattern = /(-?\d*\.?\d+) *([+-]) *(-?\d*\.?\d+)/;
  found = remainingExpression.match(additionSubtractionPattern);
  while (found) {
    const left = found[1]!;
    const operator = found[2]!;
    const right = found[3]!;
    const value = operator === "+" ? parseFloat(left) + parseFloat(right) : parseFloat(left) - parseFloat(right);
    remainingExpression = remainingExpression.replace(found[0], value.toString());
    found = remainingExpression.match(additionSubtractionPattern);
  }

  const leftover = remainingExpression.match(/(-?\d*\.?\d+)/)?.[1] ?? "";
  return parseFloat(leftover);
}

/** `ServerGenerator.ts:564-579`. The shape of every generated password, and the
 * source of three properties every length-seeded solver depends on:
 *
 * - `length` is often FRACTIONAL at the call site, and the loop bound is a bare
 *   `i < cappedLength`, so the generated string is `ceil(length)` characters;
 * - a numeric password is passed through `Number(...).toString()`, which strips
 *   leading zeros — so a numeric password of length >= 2 never begins with `0`,
 *   and the result can be SHORTER than the requested length;
 * - a numeric password above `MAX_SAFE_INTEGER` is truncated to 15 characters.
 *
 * The consequence for a solver is that the only trustworthy length is
 * `getServerDetails().passwordLength`, never one recomputed from difficulty.
 *
 * `random` is a parameter only so the simulator can drive it from a per-host
 * stream; upstream reads `Math.random()` directly. */
export function getPassword(length: number, allowLetters = false, random: () => number = Math.random): string {
  const characters = NUMBERS + (allowLetters ? LETTERS : "");
  let password = "";
  const cappedLength = Math.max(Math.min(length, MAX_PASSWORD_LENGTH), 1);
  for (let i = 0; i < cappedLength; i++) {
    password += characters[Math.floor(random() * characters.length)];
  }
  if (!allowLetters && Number(password) > Number.MAX_SAFE_INTEGER) {
    password = password.slice(0, 15);
  }
  if (!allowLetters) return Number(password).toString();
  return password;
}

/** `ServerGenerator.ts:581-597`. What `getServerDetails().passwordFormat`
 * reports, and therefore which alphabet a per-position solver must walk. */
export function getPasswordType(
  password: string,
): "numeric" | "alphabetic" | "alphanumeric" | "ASCII" | "unicode" {
  const passwordArr = password.split("");
  if (passwordArr.every((char) => NUMBERS.includes(char))) return "numeric";
  if (passwordArr.every((char) => LETTERS.includes(char))) return "alphabetic";
  if (passwordArr.every((char) => NUMBERS.includes(char) || LETTERS.includes(char))) return "alphanumeric";
  if (passwordArr.every((char) => char.charCodeAt(0) < 128)) return "ASCII";
  return "unicode";
}
