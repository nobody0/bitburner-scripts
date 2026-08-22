import { describe, expect, test } from "bun:test";
import { LARGE_PRIMES, SMALL_PRIMES } from "../shared/strategy/dnet/codecs.ts";
import { DEEP_SOLVERS, correctCharsFromTiming, readMismatchIndex } from "../shared/strategy/dnet/solvers/deep.ts";
import { SOLVER_CODES, type Solver, type SolverObservation } from "../shared/strategy/dnet/solvers/types.ts";
import type { PasswordFacts } from "../shared/strategy/dnet/models.ts";
import type { OracleCapture } from "../shared/strategy/dnet/oracle.ts";

/** As in the other solver suites, the oracles here are written from upstream's
 * failure switch rather than shared with the simulator, and the assertion that
 * carries weight is the CALL COUNT — both of these would converge by brute
 * force given long enough, so only the bound is evidence. */

interface Host {
  password: string;
  facts: PasswordFacts;
  respond: (attempt: string) => { data?: string; message?: string } | undefined;
}

function crack(solver: Solver, host: Host, cap = 800): { password?: string; calls: number; code?: number } {
  let step = solver.first(host.facts);
  let calls = 0;
  while (calls < cap) {
    if (step.kind === "give-up") return { calls, code: step.code };
    if (step.kind === "answer") {
      calls++;
      return step.password === host.password ? { password: step.password, calls } : { calls, code: -1 };
    }
    calls++;
    const success = step.password === host.password;
    if (success) return { password: step.password, calls };
    const said = host.respond(step.password);
    const oracle: OracleCapture | undefined = said === undefined
      ? undefined
      : { kind: "oracle", code: 401, passwordAttempted: step.password, ...said };
    const seen: SolverObservation = {
      attempted: step.password,
      code: 401,
      success: false,
      ...(oracle ? { oracle } : {}),
    };
    step = solver.next(host.facts, step.state, seen);
  }
  return { calls, code: -2 };
}

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

describe("2G_cellular — prefix feedback from logs or timing", () => {
  /** authentication.ts:95-99 verbatim. */
  const host = (password: string, format: PasswordFacts["passwordFormat"]): Host => ({
    password,
    facts: { passwordLength: password.length, passwordFormat: format },
    respond: (attempt) => {
      const indexOfDifference = password.split("").findIndex((char, i) => char !== attempt[i]);
      return {
        message: `Found a mismatch while checking each character (${indexOfDifference})`,
        data: "Response time: 1234ms",
      };
    },
  });

  test("300 numeric passwords fall inside the declared budget", () => {
    const rng = seeded(0x2617);
    const solver = DEEP_SOLVERS.timingAttack;
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      // getTimingAttackConfig: length min(3 + difficulty/4, 8).
      const difficulty = Math.floor(rng() * 40);
      const length = Math.max(1, Math.ceil(Math.min(3 + difficulty / 4, 8)));
      let password = String(Math.floor(rng() * 9) + 1);
      for (let k = 1; k < length; k++) password += String(Math.floor(rng() * 10));
      const h = host(password, "numeric");
      const result = crack(solver, h);
      expect(result.password, `password ${password} (code ${result.code})`).toBe(password);
      expect(result.calls).toBeLessThanOrEqual(solver.budget(h.facts));
      worst = Math.max(worst, result.calls);
    }
    // Ten symbols per position, eight positions — but the "adopt the whole
    // confirmed prefix" rule means a lucky pad resolves several at once.
    expect(worst).toBeLessThanOrEqual(80);
  });

  test("the alphanumeric case above difficulty 16 still converges", () => {
    const solver = DEEP_SOLVERS.timingAttack;
    const h = host("a1B2", "alphanumeric");
    const result = crack(solver, h);
    expect(result.password).toBe("a1B2");
    expect(result.calls).toBeLessThanOrEqual(solver.budget(h.facts));
  });

  test("readMismatchIndex reads upstream's exact phrasing, including -1", () => {
    const capture = (message: string): SolverObservation => ({
      attempted: "0",
      code: 401,
      success: false,
      oracle: { kind: "oracle", code: 401, message },
    });
    expect(readMismatchIndex(capture("Found a mismatch while checking each character (3)"))).toBe(3);
    expect(readMismatchIndex(capture("Found a mismatch while checking each character (-1)"))).toBe(-1);
    expect(readMismatchIndex(capture("something else entirely"))).toBeUndefined();
  });

  test("the timing fallback converts the 50ms-per-character rule", () => {
    // Kept as a channel for hosts above our charisma, where heartbleed 451s and
    // the stated index is therefore unreadable.
    expect(correctCharsFromTiming(1000, 1000)).toBe(0);
    expect(correctCharsFromTiming(1150, 1000)).toBe(3);
    // Formula calibration already incorporates the calling thread count.
    expect(correctCharsFromTiming(1075, 1000, 25)).toBe(3);
  });

  test("the formula baseline solves without reading the ring", () => {
    const solver = DEEP_SOLVERS.timingAttack;
    const password = "12";
    const facts: PasswordFacts = {
      passwordLength: password.length,
      passwordFormat: "numeric",
      authenticateBaseMs: 1000,
    };
    let step = solver.first(facts);
    let calls = 0;
    while (step.kind === "attempt" && calls++ < solver.budget(facts)) {
      const attempted = step.password;
      const shared = password.split("").findIndex((char, index) => char !== attempted[index]);
      const correct = shared < 0 ? password.length : shared;
      const seen: SolverObservation = {
        attempted,
        code: 401,
        success: false,
        elapsedMs: 1000 + correct * 50,
      };
      step = solver.next(facts, step.state, seen);
    }
    expect(step.kind === "answer" ? step.password : undefined).toBe(password);
    expect(solver.needsOracle).toBe(false);
  });

  test("an unreadable ring stops as OracleUnavailable and keeps its place", () => {
    const solver = DEEP_SOLVERS.timingAttack;
    const facts: PasswordFacts = { passwordLength: 4, passwordFormat: "numeric" };
    const first = solver.first(facts);
    if (first.kind !== "attempt") throw new Error("expected an attempt");
    const step = solver.next(facts, first.state, { attempted: first.password, code: 401, success: false });
    expect(step.kind === "give-up" && step.code).toBe(SOLVER_CODES.OracleUnavailable);
  });
});

describe("Factori-Os — divisibility, aimed by the reported length", () => {
  /** authentication.ts:67-74 verbatim, including the `% 0` trap. */
  const host = (password: bigint): Host => ({
    password: password.toString(),
    facts: { passwordLength: password.toString().length, passwordFormat: "numeric" },
    respond: (attempt) => {
      const p = Number(password);
      const divisor = Number(attempt);
      if (isNaN(divisor) || p % divisor || attempt === "") return { data: "false" };
      return { data: "true" };
    },
  });

  /** getPasswordMadeUpOfPrimesProduct, ServerGenerator.ts:685-707. */
  function generate(difficulty: number, rng: () => number): bigint {
    const scale = Math.min(difficulty / 2, 15);
    let password = BigInt(Math.floor(rng() * 5 * (scale + 1)) + 1);
    for (let i = 0; i < scale / 3; i++) {
      if (rng() < 0.5) password *= BigInt(Math.ceil(rng() * 5));
      else password *= BigInt(SMALL_PRIMES[Math.floor(rng() * SMALL_PRIMES.length)]!);
    }
    if (difficulty > 12) password *= BigInt(LARGE_PRIMES[Math.floor(rng() * LARGE_PRIMES.length)]!);
    return password;
  }

  test("generated passwords are reconstructed, inside the declared budget", () => {
    const rng = seeded(0xfac7);
    const solver = DEEP_SOLVERS.divisibility;
    let worst = 0;
    let total = 0;
    let solved = 0;
    for (let i = 0; i < 200; i++) {
      const difficulty = Math.floor(rng() * 24);
      const password = generate(difficulty, rng);
      if (password.toString().length > 15) continue; // refused by design, tested below
      const h = host(password);
      const result = crack(solver, h);
      expect(result.password, `password ${password} at difficulty ${difficulty} (code ${result.code})`)
        .toBe(password.toString());
      expect(result.calls).toBeLessThanOrEqual(solver.budget(h.facts));
      worst = Math.max(worst, result.calls);
      total += result.calls;
      solved++;
    }
    expect(solved).toBeGreaterThan(150);

    // MEASURED, not chosen — and the expensive half is not the factoring.
    //
    // The 25 small primes plus their exponent ladders cost around thirty
    // exchanges. The rest is the large-prime residue, which can only be found by
    // walking the admissible candidates one at a time: the reported length
    // narrows the table to a 10x window of products, and no compound question
    // bisects it (asking about q1*q2 is always refused, since only one of them
    // divides). So when the small part is itself small, most of the 83-entry
    // table stays admissible and the walk is long.
    //
    // That puts this model comfortably past the ~32 exchanges one vantage
    // window buys, which is exactly why the protocol carries resumable state.
    expect(worst).toBeLessThanOrEqual(110);
    expect(total / solved).toBeLessThanOrEqual(60);
  });

  test("a long password is still attempted, because the generator keeps it exact", () => {
    // The generator loops `while (BigInt(Number(password)) !== password)`
    // (ServerGenerator.ts:705), so every password it emits is exactly
    // representable as a double however many digits it has — which means the
    // engine's Number()-based remainder is exact and the answers are reliable.
    // Refusing on length alone would decline hosts we can actually open.
    const step = DEEP_SOLVERS.divisibility.first({ passwordLength: 18, passwordFormat: "numeric" });
    expect(step.kind).toBe("attempt");
  });

  test("an 18-digit exactly-representable password is reconstructed", () => {
    // 2^60 is 19 digits and exactly representable; scale it into the shape the
    // generator makes.
    const password = 2n ** 40n * 3n * 1069n;
    expect(BigInt(Number(password))).toBe(password);
    const h = host(password);
    const result = crack(DEEP_SOLVERS.divisibility, h);
    expect(result.password, `code ${result.code}`).toBe(password.toString());
  });

  test("zero is never sent, because upstream would call it a divisor", () => {
    // `p % 0` is NaN, which is falsy, so upstream's guard takes the SUCCESS
    // branch and answers "Password IS divisible by '0'". A solver that sent it
    // would poison its own reconstruction.
    const solver = DEEP_SOLVERS.divisibility;
    const h = host(2n * 3n * 5n * 1069n);
    let step = solver.first(h.facts);
    let guard = 0;
    while (step.kind === "attempt" && guard++ < 200) {
      expect(Number(step.password), "a divisor of 0 was attempted").toBeGreaterThan(0);
      const said = h.respond(step.password)!;
      step = solver.next(h.facts, step.state, {
        attempted: step.password,
        code: 401,
        success: step.password === h.password,
        oracle: { kind: "oracle", code: 401, passwordAttempted: step.password, ...said },
      });
    }
  });

  test("a response that is neither true nor false is grammar drift", () => {
    const solver = DEEP_SOLVERS.divisibility;
    const facts: PasswordFacts = { passwordLength: 6, passwordFormat: "numeric" };
    const first = solver.first(facts);
    if (first.kind !== "attempt") throw new Error("expected an attempt");
    const step = solver.next(facts, first.state, {
      attempted: first.password,
      code: 401,
      success: false,
      oracle: { kind: "oracle", code: 401, data: "perhaps" },
    });
    expect(step.kind === "give-up" && step.code).toBe(SOLVER_CODES.OracleUnparsed);
  });
});
