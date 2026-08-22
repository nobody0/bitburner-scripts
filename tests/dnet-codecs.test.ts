import { describe, expect, test } from "bun:test";
import {
  FILLER,
  LARGE_PRIMES,
  NUMBERS,
  SMALL_PRIMES,
  cleanArithmeticExpression,
  encodeNumberInBaseN,
  getPassword,
  getPasswordType,
  parseBaseNNumberString,
  parseSimpleArithmeticExpression,
  romanNumeralDecoder,
  romanNumeralEncoder,
} from "../shared/strategy/dnet/codecs.ts";

/** These are TRANSCRIPTIONS, so what has to be tested is not "does it compute a
 * sensible answer" but "does it compute upstream's answer".
 *
 * Two independent checks do that work. Round-tripping encoder against decoder
 * catches a transcription that is self-consistently wrong in one direction. And
 * for the arithmetic parser, comparing against real JavaScript evaluation on
 * SAFE generated expressions catches a parser that agrees with itself but not
 * with arithmetic — the failure that would silently cost us every `MathML` host.
 *
 * The one thing deliberately NOT tested against a general implementation is
 * fractional-base encoding, because upstream's is lossy by construction and the
 * model's success check accepts a near-enough answer. That tolerance is the
 * subject of its own case below. */

describe("the alphabets and tables are transcribed", () => {
  test("the captcha filler contains no digit, which is what makes that model free", () => {
    // The whole `CloudBlare(tm)` attack is "strip every non-digit". If upstream
    // ever puts a digit in the filler, that stops being true and this fails
    // here rather than on a darknet host at 3am.
    for (const char of FILLER) expect(NUMBERS.includes(char), `filler contains the digit ${char}`).toBe(false);
    expect(FILLER.length).toBe(17);
  });

  test("the prime tables are the ones the two arithmetic models draw from", () => {
    expect(SMALL_PRIMES.length).toBe(25);
    expect(SMALL_PRIMES[0]).toBe(2);
    expect(SMALL_PRIMES[SMALL_PRIMES.length - 1]).toBe(97);
    expect(LARGE_PRIMES.length).toBe(83);
    // Every entry must actually be prime, or a factoriser built on the table
    // would "solve" a host to the wrong answer.
    const isPrime = (n: number): boolean => {
      if (n < 2) return false;
      for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
      return true;
    };
    for (const p of SMALL_PRIMES) expect(isPrime(p), `${p} is not prime`).toBe(true);
    for (const p of LARGE_PRIMES) expect(isPrime(p), `${p} is not prime`).toBe(true);
    // The two pools must not overlap: the largest-prime-factor attack assumes
    // the residue after stripping small primes IS a large-prime entry.
    for (const p of LARGE_PRIMES) expect(SMALL_PRIMES.includes(p)).toBe(false);
  });
});

describe("roman numerals round-trip", () => {
  test("zero is 'nulla', not the empty string", () => {
    expect(romanNumeralEncoder(0)).toBe("nulla");
    expect(romanNumeralDecoder("nulla")).toBe(0);
    expect(romanNumeralDecoder("NULLA")).toBe(0);
  });

  test("every value a RomanNumeral host can hold survives the round trip", () => {
    // The generator draws `floor(random * 10 * (10 * (difficulty + 1)))`, so at
    // difficulty 40 the ceiling is 4100. Walk well past it.
    for (let n = 0; n <= 5000; n++) {
      expect(romanNumeralDecoder(romanNumeralEncoder(n)), `${n} did not round-trip`).toBe(n);
    }
  });
});

describe("base-N conversion round-trips on the integer bases", () => {
  test("the encoder uses digits then UPPERCASE, so base 36 is the ceiling", () => {
    expect(encodeNumberInBaseN(255, 16)).toBe("FF");
    expect(parseBaseNNumberString("FF", 16)).toBe(255);
    expect(encodeNumberInBaseN(8, 2)).toBe("1000");
    expect(parseBaseNNumberString("1000", 2)).toBe(8);
  });

  test("every integer base the generator picks round-trips exactly", () => {
    // `bases` in getConvertToBase10Config, and the password is
    // `ceil(random * 99 * (difficulty + 1))` so it is a positive integer.
    const bases = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16];
    for (const base of bases) {
      for (const value of [1, 2, 7, 42, 99, 100, 511, 1234, 4000]) {
        const encoded = encodeNumberInBaseN(value, base);
        expect(Math.round(parseBaseNNumberString(encoded, base)), `${value} in base ${base} (${encoded})`).toBe(value);
      }
    }
  });

  test("a fractional base is lossy, and that is why the model accepts near-enough", () => {
    // Above difficulty 12 upstream adds `bases[i]/10` to the base. The encoding
    // no longer terminates cleanly, so the decoder cannot be exact — the
    // success check compensates with |delta| < 0.01 or relative < 0.005. A
    // solver that demanded equality here would never open one of these hosts.
    const base = 8.3;
    const value = 4242;
    const decoded = parseBaseNNumberString(encodeNumberInBaseN(value, base), base);
    expect(Math.abs(decoded - value)).toBeLessThan(1);
    // And the tolerance upstream actually applies is comfortably met.
    expect(Math.abs(decoded - value) / value).toBeLessThan(0.005);
  });
});

describe("the arithmetic parser agrees with arithmetic", () => {
  /** Build an expression from the same grammar upstream generates: integers
   * 1..98 joined by + - * /, with optional parenthesised sub-expressions. */
  function generate(rng: () => number, depth: number): string {
    const operators = ["+", "-", "*", "/"];
    const parts: string[] = [];
    const operatorCount = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < operatorCount; i++) {
      parts.push(String(Math.ceil(rng() * 98)));
      parts.push(operators[Math.floor(rng() * operators.length)]!);
      if (depth > 0 && rng() < 0.3) {
        parts.push("(", generate(rng, depth - 1), ")", operators[Math.floor(rng() * operators.length)]!);
      }
    }
    parts.push(String(Math.ceil(rng() * 98)));
    return parts.join(" ");
  }

  test("500 generated expressions match real evaluation", () => {
    // Seeded so a failure is reproducible.
    let state = 0x2f6e2b1;
    const rng = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let i = 0; i < 500; i++) {
      const expression = generate(rng, 2);
      // The reference: JavaScript's own evaluation of the SAME arithmetic. Safe
      // because we generated the string ourselves from digits and operators —
      // never do this to a string a darknet host handed us.
      const expected = Function(`"use strict"; return (${expression});`)() as number;
      const actual = parseSimpleArithmeticExpression(expression);
      expect(Number.isFinite(actual), `${expression} did not evaluate`).toBe(true);
      // Upstream's evaluator rewrites through decimal strings, so it loses a
      // little precision on division chains. Relative tolerance, not exact.
      const scale = Math.max(1, Math.abs(expected));
      expect(Math.abs(actual - expected) / scale, `${expression}: got ${actual}, want ${expected}`)
        .toBeLessThan(1e-6);
    }
  });

});

describe("the expression cleaner defuses what the game plants in it", () => {
  test("the lookalike unicode operators are restored", () => {
    // Above difficulty 18 upstream swaps these in to break naive parsers.
    expect(parseSimpleArithmeticExpression("6 ҳ 7")).toBe(42);
    expect(parseSimpleArithmeticExpression("84 ÷ 2")).toBe(42);
    expect(parseSimpleArithmeticExpression("40 ➕ 2")).toBe(42);
    expect(parseSimpleArithmeticExpression("44 ➖ 2")).toBe(42);
  });

  test("the injected payload is stripped, and evaluating it changes nothing", () => {
    // This is upstream's `getCodeInjection()` verbatim. It is appended to the
    // hint above difficulty 16 SPECIFICALLY to punish a script that calls eval
    // on the data field: it sets a global, alerts, opens the dev menu and exits
    // the script. Our parser must return the arithmetic answer and touch none
    // of that.
    const injection =
      ' , !globalThis.pwn3d && (globalThis.pwn3d=true, alert("You\'ve been hacked! You evaluated a string'
      + ' and let me inject code, didn\'t you? HAHAHAHA!") , globalThis.openDevMenu() ) , ns.exit()';
    const hostile = `6 * 7${injection}`;
    expect(parseSimpleArithmeticExpression(hostile)).toBe(42);
    expect((globalThis as Record<string, unknown>)["pwn3d"]).toBeUndefined();
  });

  test("the spliced exit call inside a parenthesis is removed", () => {
    // Above difficulty 20 upstream replaces the first "(" with "(ns.exit(),".
    const spliced = "4 + 5 * (ns.exit(), 6 + 7 ) / 2";
    expect(cleanArithmeticExpression(spliced)).toBe("4 + 5 * ( 6 + 7 ) / 2");
    expect(parseSimpleArithmeticExpression(spliced)).toBeCloseTo(36.5, 10);
  });
});

describe("password generation has the properties solvers rely on", () => {
  const cycle = (values: number[]): (() => number) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };

  test("a numeric password never has a leading zero, so it may be shorter than asked", () => {
    // `Number(password).toString()` strips them. A solver that seeded its search
    // from the REQUESTED length rather than the reported one would be searching
    // the wrong range.
    const password = getPassword(4, false, cycle([0, 0, 0.5, 0.7]));
    expect(password.startsWith("0")).toBe(false);
    expect(password.length).toBeLessThan(4);
  });

  test("a fractional length generates ceil(length) characters", () => {
    // The loop bound is a bare `i < cappedLength`, and several callers pass a
    // fraction (e.g. `2 + difficulty / 7`).
    const letters = getPassword(3.5, true, cycle([0.5]));
    expect(letters.length).toBe(4);
  });

  test("format detection matches what getServerDetails reports", () => {
    expect(getPasswordType("12345")).toBe("numeric");
    expect(getPasswordType("abcDEF")).toBe("alphabetic");
    expect(getPasswordType("a1b2")).toBe("alphanumeric");
    expect(getPasswordType("a-b!")).toBe("ASCII");
    expect(getPasswordType("naïve")).toBe("unicode");
  });
});
