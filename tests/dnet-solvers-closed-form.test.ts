import { describe, expect, test } from "bun:test";
import {
  FILLER,
  LARGE_PRIMES,
  SMALL_PRIMES,
  encodeNumberInBaseN,
  romanNumeralEncoder,
} from "../shared/strategy/dnet/codecs.ts";
import {
  CLOSED_FORM_SOLVERS,
  decodeArithmetic,
  decodeBaseN,
  decodeBinary,
  decodeCaptcha,
  decodeEcho,
  decodeLargestPrimeFactor,
  decodeRoman,
  decodeXorMask,
  craftBufferOverflow,
} from "../shared/strategy/dnet/solvers/closed-form.ts";
import { SOLVER_CODES } from "../shared/strategy/dnet/solvers/types.ts";
import type { PasswordFacts } from "../shared/strategy/dnet/models.ts";

/** Eight models publish their own password. These tests build the published
 * form exactly as upstream's generator does, then assert the solver reads it
 * back — which is the only property that matters, since a wrong decoding costs
 * an `authenticate` and teaches nothing.
 *
 * The generators are reproduced here from `ServerGenerator.ts` rather than
 * imported from `sim/`, deliberately: a test that shares an implementation with
 * the thing it tests only proves the two agree. `tests/dnet-codecs.test.ts`
 * pins the shared codecs against real arithmetic; these pin the solvers against
 * an independent construction of what the game would send. */

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const facts = (over: Partial<PasswordFacts>): PasswordFacts => ({ ...over });

describe("the echo vulnerability puts the password in its own hint", () => {
  test("every template shape yields the trailing token", () => {
    // ServerGenerator.ts:90-106 — six templates, then a space, then the password.
    const templates = [
      "The password is", "I wrote it down:", "Don't forget:", "My password is", "Remember:", "It's",
    ];
    for (const template of templates) {
      const decoded = decodeEcho(facts({ passwordHint: `${template} 4821`, passwordLength: 4 }));
      expect(decoded.ok && decoded.password).toBe("4821");
    }
  });

  test("a hint whose last token is not numeric is grammar drift, not an empty field", () => {
    const decoded = decodeEcho(facts({ passwordHint: "no password here" }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.empty).toBe(false);
  });

  test("a missing hint reports as empty, which is a survey problem", () => {
    const decoded = decodeEcho(facts({}));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.empty).toBe(true);
  });
});

describe("the captcha is defeated by removing the filler", () => {
  /** ServerGenerator.ts:161-179 — one to three filler characters after every
   * character except the last. */
  function fill(password: string, rng: () => number): string {
    return password
      .split("")
      .map((char, i) => {
        if (i >= password.length - 1) return char;
        let result = char;
        const count = Math.ceil(rng() * 3);
        for (let k = 0; k < count; k++) result += FILLER[Math.floor(rng() * FILLER.length)];
        return result;
      })
      .join("");
  }

  test("200 generated captchas all decode exactly", () => {
    const rng = seeded(0x9e37);
    for (let i = 0; i < 200; i++) {
      const password = String(Math.floor(rng() * 9e6) + 1);
      const decoded = decodeCaptcha(facts({ data: fill(password, rng) }));
      expect(decoded.ok && decoded.password, `captcha for ${password}`).toBe(password);
    }
  });
});

describe("binary and xor encodings are reversible", () => {
  test("binary decodes both the numeric and the alphanumeric case", () => {
    const encode = (p: string): string =>
      p.split("").map((c) => c.charCodeAt(0).toString(2).padStart(8, "0")).join(" ");
    for (const password of ["4821", "a1B2c3", "77"]) {
      const decoded = decodeBinary(facts({ data: encode(password) }));
      expect(decoded.ok && decoded.password).toBe(password);
    }
  });

  test("a non-binary group is reported as unparsed rather than decoded to junk", () => {
    const decoded = decodeBinary(facts({ data: "00110001 nonsense" }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.empty).toBe(false);
  });

  test("200 generated xor masks all decode exactly", () => {
    // ServerGenerator.ts:313-336 — a fresh 0..31 mask per character.
    const rng = seeded(0x1234);
    for (let i = 0; i < 200; i++) {
      const length = 3 + Math.floor(rng() * 3);
      let password = "";
      for (let k = 0; k < length; k++) password += String(Math.floor(rng() * 10));
      // Upstream RE-ROLLS the whole mask set until the masked half contains
      // neither ";" nor " " (ServerGenerator.ts:318-328), because either would
      // break its own encoding. Reproducing that loop is what makes splitting
      // on those characters safe rather than merely usually safe.
      let masked = "";
      let masks: string[] = [];
      do {
        masked = "";
        masks = [];
        for (const char of password) {
          const mask = Math.floor(rng() * 32);
          masks.push(mask.toString(2).padStart(8, "0"));
          masked += String.fromCharCode(char.charCodeAt(0) ^ mask);
        }
      } while (masked.includes(";") || masked.includes(" "));
      const decoded = decodeXorMask(facts({ data: `${masked};${masks.join(" ")}` }));
      expect(decoded.ok && decoded.password, `xor for ${password}`).toBe(password);
    }
  });

  test("a mask count that disagrees with the payload is refused", () => {
    const decoded = decodeXorMask(facts({ data: "abc;00000001 00000010" }));
    expect(decoded.ok).toBe(false);
  });
});

describe("the largest prime factor falls out of the small-prime table", () => {
  test("every large prime is recovered from a generated target", () => {
    // ServerGenerator.ts:669-683 — one large prime times up to six small ones.
    const rng = seeded(0xbeef);
    for (const largest of LARGE_PRIMES) {
      const factorCount = 1 + Math.floor(rng() * 6);
      let target = BigInt(largest);
      for (let i = 0; i < factorCount; i++) {
        target *= BigInt(SMALL_PRIMES[Math.floor(rng() * SMALL_PRIMES.length)]!);
      }
      const decoded = decodeLargestPrimeFactor(facts({ data: target.toString() }));
      expect(decoded.ok && decoded.password, `target ${target}`).toBe(String(largest));
    }
  });

  test("a target at the ceiling stays exact, which is why this uses BigInt", () => {
    // The worst case upstream can build: the largest entry times 97 six times,
    // which lands just under MAX_SAFE_INTEGER where doubles stop being exact.
    let target = BigInt(9859);
    for (let i = 0; i < 6; i++) target *= 97n;
    expect(target).toBeGreaterThan(8_000_000_000_000_000n);
    const decoded = decodeLargestPrimeFactor(facts({ data: target.toString() }));
    expect(decoded.ok && decoded.password).toBe("9859");
  });

  test("a residue outside the table is reported, not authenticated against", () => {
    // 1_000_003 is prime and not in LARGE_PRIMES. Answering with it would burn
    // an attempt and teach nothing; saying so names the drift.
    const decoded = decodeLargestPrimeFactor(facts({ data: String(1_000_003 * 2) }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("large-prime table");
  });
});

describe("base-N and arithmetic land inside the engine's tolerance", () => {
  /** The engine accepts `|delta| < 0.01` OR `delta / password < 0.005`
   * (`authentication.ts:152-158`). That is the bar these two must clear. */
  const accepted = (password: string, attempt: string): boolean => {
    const difference = Math.abs(Number(attempt) - Number(password));
    return difference < 0.01 || difference / Number(password) < 0.005;
  };

  test("every integer base decodes to a value the engine would accept", () => {
    const bases = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16];
    const rng = seeded(0x77);
    for (const base of bases) {
      for (let i = 0; i < 20; i++) {
        const password = Math.ceil(rng() * 99 * 20);
        const decoded = decodeBaseN(facts({ data: `${base},${encodeNumberInBaseN(password, base)}` }));
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(accepted(String(password), decoded.password), `base ${base} value ${password}`).toBe(true);
        }
      }
    }
  });

  test("a fractional base still lands inside the tolerance", () => {
    // Above difficulty 12 upstream adds base/10, and its own encoder is lossy
    // there. This is the case the rounding ladder exists for.
    const rng = seeded(0x88);
    for (const base of [8.3, 11.5, 13.2, 16.7]) {
      for (let i = 0; i < 20; i++) {
        const password = Math.ceil(rng() * 99 * 30);
        const decoded = decodeBaseN(facts({ data: `${base},${encodeNumberInBaseN(password, base)}` }));
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(accepted(String(password), decoded.password), `base ${base} value ${password}`).toBe(true);
        }
      }
    }
  });

  test("an arithmetic hint evaluates to its own password", () => {
    const decoded = decodeArithmetic(facts({ data: "4 + 5 * ( 6 + 7 ) / 2" }));
    expect(decoded.ok && Number(decoded.password)).toBeCloseTo(36.5, 10);
  });

  test("the hostile arithmetic hint is solved without executing it", () => {
    const hostile = "6 * 7 , !globalThis.pwn3d && (globalThis.pwn3d=true, globalThis.openDevMenu() ) , ns.exit()";
    const decoded = decodeArithmetic(facts({ data: hostile }));
    expect(decoded.ok && decoded.password).toBe("42");
    expect((globalThis as Record<string, unknown>)["pwn3d"]).toBeUndefined();
  });
});

describe("roman numerals split into two regimes by the shape of data", () => {
  test("a bare numeral is the password", () => {
    for (const value of [7, 42, 399, 1994, 4100]) {
      const decoded = decodeRoman(facts({ data: romanNumeralEncoder(value) }));
      expect(decoded.ok && decoded.password).toBe(String(value));
    }
  });

  test("a comma means a RANGE, which this solver refuses rather than misreads", () => {
    // At difficulty >= 8 the data is "<min>,<max>" and the attack is a binary
    // search. Decoding it as a single numeral would silently answer the minimum.
    const decoded = decodeRoman(facts({ data: `${romanNumeralEncoder(100)},${romanNumeralEncoder(400)}` }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("range");
  });
});

describe("the Solver wrapper behaves as the protocol requires", () => {
  test("a closed-form solver asserts rather than guesses, and needs no oracle", () => {
    const solver = CLOSED_FORM_SOLVERS.echo;
    expect(solver.needsOracle).toBe(false);
    expect(solver.budget({})).toBe(1);
    const step = solver.first(facts({ passwordHint: "The password is 4821" }));
    expect(step.kind).toBe("answer");
    if (step.kind === "answer") expect(step.password).toBe("4821");
  });

  test("a refused assertion reports that our model is wrong, loudly", () => {
    // This is the important one. If the decode succeeded and the password was
    // still refused, retrying is pointless — the generator changed.
    const solver = CLOSED_FORM_SOLVERS.echo;
    const step = solver.next(
      facts({ passwordHint: "The password is 4821" }),
      { model: "DeskMemo_3.1", fingerprint: "x", phase: "", spent: 1, scratch: {} },
      { attempted: "4821", code: 401, success: false },
    );
    expect(step.kind).toBe("give-up");
    if (step.kind === "give-up") expect(step.code).toBe(SOLVER_CODES.SolverExhausted);
  });

  test("an empty field and an unreadable field give up under different codes", () => {
    const empty = CLOSED_FORM_SOLVERS.captcha.first(facts({}));
    expect(empty.kind === "give-up" && empty.code).toBe(SOLVER_CODES.OracleUnavailable);
    const junk = CLOSED_FORM_SOLVERS.binary.first(facts({ data: "not binary at all" }));
    expect(junk.kind === "give-up" && junk.code).toBe(SOLVER_CODES.OracleUnparsed);
  });

  test("the two tolerance models walk a bounded rounding ladder, then stop", () => {
    const solver = CLOSED_FORM_SOLVERS.baseN;
    const f = facts({ data: `16,${encodeNumberInBaseN(255, 16)}` });
    let step = solver.first(f);
    expect(step.kind).toBe("attempt");

    const attempted: string[] = [];
    let guard = 0;
    while (step.kind === "attempt" && guard++ < 10) {
      attempted.push(step.password);
      step = solver.next(f, step.state, { attempted: step.password, code: 401, success: false });
    }
    // The exact value first, then a bounded ladder around it — never unbounded.
    expect(attempted[0]).toBe("255");
    expect(attempted.length).toBe(solver.budget(f));
    expect(step.kind).toBe("give-up");
    if (step.kind === "give-up") expect(step.code).toBe(SOLVER_CODES.SolverExhausted);
  });

  test("a success on any ladder rung is taken as the answer", () => {
    const solver = CLOSED_FORM_SOLVERS.arithmetic;
    const f = facts({ data: "6 * 7" });
    const step = solver.first(f);
    expect(step.kind).toBe("attempt");
    if (step.kind !== "attempt") return;
    const done = solver.next(f, step.state, { attempted: "42", code: 200, success: true });
    expect(done.kind).toBe("answer");
    if (done.kind === "answer") expect(done.password).toBe("42");
  });
});

describe("Pr0verFl0 — one crafted string, no oracle, no charisma", () => {
  /** authentication.ts:101-118 verbatim: the buffer simulation upstream runs. */
  function overflowSucceeds(password: string, attempted: string): boolean {
    if (password === attempted) return true;
    const maskCharacter = attempted === "\u25a0".repeat(password.length) ? "?" : "\u25a0";
    const buffer = "\u02cd".repeat(password.length) + maskCharacter.repeat(password.length);
    const overwritten = attempted.slice(0, buffer.length) + buffer.slice(attempted.length);
    return overwritten.slice(0, password.length) === overwritten.slice(password.length);
  }

  test("the crafted attempt opens every buffer length the generator can roll", () => {
    // getBufferOverflowConfig: length is floor(4 + random * 4), so 4..7, and the
    // password may contain letters.
    for (let length = 4; length <= 7; length++) {
      const password = "a1B2c3D4".slice(0, length);
      const crafted = craftBufferOverflow(facts({ passwordLength: length }));
      expect(crafted.ok).toBe(true);
      if (!crafted.ok) continue;
      expect(crafted.password.length).toBe(length * 2);
      expect(overflowSucceeds(password, crafted.password), `length ${length}`).toBe(true);
    }
  });

  test("the length can be read out of the hint when the survey lacks it", () => {
    const crafted = craftBufferOverflow(facts({ passwordHint: "Warning: password buffer is 5 bytes" }));
    expect(crafted.ok && crafted.password).toBe("0".repeat(10));
  });

  test("an attempt that would exceed the engine's 100-character throw is refused", () => {
    // authenticate() THROWS above 100 characters, which kills the agent rather
    // than failing the attempt — so this must never be sent optimistically.
    const crafted = craftBufferOverflow(facts({ passwordLength: 60 }));
    expect(crafted.ok).toBe(false);
  });

  test("it is one call, needs no oracle, and asserts rather than guesses", () => {
    const solver = CLOSED_FORM_SOLVERS.bufferOverflow;
    expect(solver.needsOracle).toBe(false);
    expect(solver.budget({ passwordLength: 5 })).toBe(1);
    const step = solver.first(facts({ passwordLength: 5 }));
    expect(step.kind).toBe("answer");
  });
});
