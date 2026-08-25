import { describe, expect, test } from "bun:test";
import { romanNumeralEncoder } from "../shared/strategy/dnet/codecs.ts";
import {
  SEARCH_SOLVERS,
  alphabetFor,
  chineseRemainder,
  distinctPermutations,
  readRmsd,
} from "../shared/strategy/dnet/solvers/search.ts";
import { SOLVER_CODES, type Solver, type SolverObservation } from "../shared/strategy/dnet/solvers/types.ts";
import type { PasswordFacts } from "../shared/strategy/dnet/models.ts";
import type { OracleCapture } from "../shared/strategy/dnet/oracle.ts";

/** Convergence tests, driven by a reimplementation of upstream's own failure
 * switch (`authentication.ts:43-143`).
 *
 * Two properties are asserted for every solver, and the SECOND is the one that
 * matters: that it converges, and that it converges inside its own declared
 * `budget()`. Every solver here would find the password eventually by brute
 * force, so convergence alone is nearly free evidence — the bound is the claim.
 *
 * The oracles below are written from upstream, not imported from `sim/`, so that
 * a mistake shared between the simulator and the solver cannot hide here. */

interface Host {
  password: string;
  facts: PasswordFacts;
  /** Upstream's `data` field for a failed attempt, or undefined when the model
   *  produces no usable feedback for this attempt. */
  respond: (attempt: string) => string | undefined;
}

/** Drive a solver against a host until it opens it or stops. */
function crack(solver: Solver, host: Host, cap = 500): { password?: string; calls: number; code?: number } {
  let step = solver.first(host.facts);
  let calls = 0;
  while (calls < cap) {
    if (step.kind === "give-up") return { calls, code: step.code };
    if (step.kind === "answer") {
      calls++;
      return step.password === host.password
        ? { password: step.password, calls }
        : { calls, code: -1 };
    }
    calls++;
    const success = step.password === host.password;
    const data = success ? undefined : host.respond(step.password);
    const oracle: OracleCapture | undefined = data === undefined
      ? undefined
      : { kind: "oracle", code: 401, data, passwordAttempted: step.password };
    const seen: SolverObservation = {
      attempted: step.password,
      code: success ? 200 : 401,
      success,
      ...(oracle ? { oracle } : {}),
    };
    if (success) return { password: step.password, calls };
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

describe("AccountsManager_4.2 — guess the number", () => {
  /** authentication.ts:43-46 */
  const host = (password: string): Host => ({
    password,
    facts: { passwordLength: password.length, passwordFormat: "numeric" },
    respond: (attempt) => (Number(attempt) > Number(password) ? "Lower" : "Higher"),
  });

  test("400 passwords all fall, inside the declared budget", () => {
    const rng = seeded(0xa11);
    const solver = SEARCH_SOLVERS.guessNumber;
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      // getGuessNumberConfig: floor(random * 10 * (difficulty + 3) / 3).
      const difficulty = Math.floor(rng() * 40);
      const password = String(Math.floor((rng() * 10 * (difficulty + 3)) / 3));
      const h = host(password);
      const result = crack(solver, h);
      expect(result.password, `password ${password} (code ${result.code})`).toBe(password);
      expect(result.calls).toBeLessThanOrEqual(solver.budget(h.facts));
      worst = Math.max(worst, result.calls);
    }
    // The length bound is what keeps this cheap: a 4-digit password is found in
    // ~14 exchanges, not the ~34 an unbounded search over 0..1e9 would need.
    expect(worst).toBeLessThanOrEqual(16);
  });

  test("the reported length bounds the search, because leading zeros are stripped", () => {
    const solver = SEARCH_SOLVERS.guessNumber;
    const first = solver.first({ passwordLength: 4, passwordFormat: "numeric" });
    expect(first.kind).toBe("attempt");
    // Midpoint of [1000, 9999], not of [0, 1e9].
    if (first.kind === "attempt") expect(Number(first.password)).toBeGreaterThan(1000);
  });

  test("an unreadable ring gives up as OracleUnavailable, keeping its state", () => {
    const solver = SEARCH_SOLVERS.guessNumber;
    const facts: PasswordFacts = { passwordLength: 3, passwordFormat: "numeric" };
    const first = solver.first(facts);
    if (first.kind !== "attempt") throw new Error("expected an attempt");
    const step = solver.next(facts, first.state, { attempted: first.password, code: 401, success: false });
    expect(step.kind).toBe("give-up");
    if (step.kind === "give-up") {
      expect(step.code).toBe(SOLVER_CODES.OracleUnavailable);
      expect(step.state, "a budget-style stop must stay resumable").toBeDefined();
    }
  });
});

describe("BellaCuore — the same search, in Latin", () => {
  /** authentication.ts:47-50, with the range published as two numerals. */
  const host = (password: number, lo: number, hi: number): Host => ({
    password: String(password),
    facts: {
      passwordLength: String(password).length,
      passwordFormat: "numeric",
      data: `${romanNumeralEncoder(lo)},${romanNumeralEncoder(hi)}`,
    },
    respond: (attempt) => (Number(attempt) > password ? "ALTUS NIMIS" : "PARUM BREVIS"),
  });

  test("300 ranged hosts all fall, inside the declared budget", () => {
    const rng = seeded(0xbe11a);
    const solver = SEARCH_SOLVERS.romanRange;
    for (let i = 0; i < 300; i++) {
      // getRomanNumeralConfig, the difficulty >= 8 branch.
      const difficulty = 8 + Math.floor(rng() * 32);
      const password = Math.floor(rng() * 10 * (10 * (difficulty + 1)));
      const lo = rng() < 0.3 ? 0 : Math.floor(password * (rng() * 0.2 + 0.6));
      const hi = password + Math.floor(rng() * difficulty * 10 + 10);
      const h = host(password, lo, hi);
      const result = crack(solver, h);
      expect(result.password, `password ${password} in [${lo}, ${hi}] (code ${result.code})`).toBe(String(password));
      expect(result.calls).toBeLessThanOrEqual(solver.budget(h.facts));
    }
  });

  test("a bare numeral has no range, so this solver refuses rather than guessing", () => {
    const step = SEARCH_SOLVERS.romanRange.first({ data: romanNumeralEncoder(42) });
    expect(step.kind).toBe("give-up");
    if (step.kind === "give-up") expect(step.code).toBe(SOLVER_CODES.OracleUnparsed);
  });
});

describe("BigMo%od — the outer modulo that does nothing", () => {
  /** authentication.ts:75-85 verbatim. */
  const host = (password: string): Host => ({
    password,
    facts: { passwordLength: password.length, passwordFormat: "numeric" },
    respond: (attempt) => {
      const input = Number(attempt);
      const result = (Number(password) % input) % (((input - 1) % 32) + 1);
      return String(result);
    },
  });

  test("the identity holds: any modulus at or below 32 returns a clean residue", () => {
    // This is the entire attack, so it is asserted directly rather than only
    // implied by convergence.
    for (let n = 2; n <= 32; n++) {
      expect(((n - 1) % 32) + 1, `modulus ${n} is not its own outer modulus`).toBe(n);
    }
  });

  test("300 passwords are reconstructed by CRT, inside the declared budget", () => {
    const rng = seeded(0xb1601);
    const solver = SEARCH_SOLVERS.tripleModulo;
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      const difficulty = Math.floor(rng() * 50);
      const length = Math.max(1, Math.ceil(3 + difficulty / 5));
      let password = String(Math.floor(rng() * 9) + 1);
      for (let k = 1; k < length; k++) password += String(Math.floor(rng() * 10));
      const h = host(password);
      const result = crack(solver, h);
      expect(result.password, `password ${password} (code ${result.code})`).toBe(password);
      expect(result.calls).toBeLessThanOrEqual(solver.budget(h.facts));
      worst = Math.max(worst, result.calls);
    }
    expect(worst).toBeLessThanOrEqual(12);
  });

  test("chineseRemainder solves what it claims to", () => {
    expect(chineseRemainder([32n, 27n, 25n], [5n, 7n, 13n]) as bigint % 32n).toBe(5n);
    expect(chineseRemainder([32n, 27n, 25n], [5n, 7n, 13n]) as bigint % 27n).toBe(7n);
    expect(chineseRemainder([32n, 27n, 25n], [5n, 7n, 13n]) as bigint % 25n).toBe(13n);
  });
});

describe("NIL — yes and yesn't, per position", () => {
  /** authentication.ts:51-57 verbatim. */
  const host = (password: string, format: PasswordFacts["passwordFormat"]): Host => ({
    password,
    facts: { passwordLength: password.length, passwordFormat: format },
    respond: (attempt) =>
      attempt.split("").map((char, i) => (char === password[i] ? "yes" : "yesn't")).join(","),
  });

  test("a numeric password of any length falls in at most ten exchanges", () => {
    // The cost depends on the ALPHABET, not the length — that is the point.
    const rng = seeded(0x1417);

    const solver = SEARCH_SOLVERS.yesNo;
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const length = 3 + Math.floor(rng() * 20);
      let password = "";
      for (let k = 0; k < length; k++) password += String(Math.floor(rng() * 10));
      const h = host(password, "numeric");
      const result = crack(solver, h);
      expect(result.password, `password ${password} (code ${result.code})`).toBe(password);
      worst = Math.max(worst, result.calls);
    }
    expect(worst).toBeLessThanOrEqual(11);
  });

  test("drained character hints move known symbols to the front without removing any", () => {
    const alphabet = alphabetFor({
      passwordFormat: "numeric",
      evidence: [{ kind: "contains", chars: ["7", "4"], at: 1 }],
    });
    expect(alphabet).toBe("7401235689");
    expect(new Set(alphabet).size).toBe(10);
  });

  test("the alphanumeric case still converges, and still inside budget", () => {
    const solver = SEARCH_SOLVERS.yesNo;
    const h = host("a1B2c3", "alphanumeric");
    const result = crack(solver, h);
    expect(result.password).toBe("a1B2c3");
    expect(result.calls).toBeLessThanOrEqual(solver.budget(h.facts));
  });

  test("placement hints stay fixed while NIL probes unknown positions", () => {
    const solver = SEARCH_SOLVERS.yesNo;
    const h = host("401", "numeric");
    h.facts.evidence = [
      { kind: "contains", chars: ["9"], at: 1 },
      { kind: "placement", attempted: "412", placed: ["4"], at: 2 },
    ];
    const result = crack(solver, h);
    expect(result.password).toBe("401");
    expect(result.calls).toBeLessThan(10);
  });

  test("without a reported length there is nothing to probe with", () => {
    const step = SEARCH_SOLVERS.yesNo.first({ passwordFormat: "numeric" });
    expect(step.kind).toBe("give-up");
  });
});

describe("PHP 5.4 — the sorted echo, in both regimes", () => {
  /** authentication.ts:127-143. Note the two guards: the arm returns the static
   * hint unless the password is at least 5 long AND the attempt matches its
   * length. */
  const host = (password: string): Host => {
    const sorted = password.split("").sort().join("");
    return {
      password,
      facts: { passwordLength: password.length, passwordFormat: "numeric", data: sorted },
      respond: (attempt) => {
        if (password.length < 5 || attempt.length !== password.length) return sorted;
        let squaredError = 0;
        for (let i = 0; i < attempt.length; i++) {
          squaredError += (Number(attempt[i]) - Number(password[i])) ** 2;
        }
        const rmsd = Math.sqrt(squaredError / attempt.length);
        return `${sorted}; RMS Deviation:${rmsd.toFixed(3)}`;
      },
    };
  };

  test("at length 5 and above the RMS deviation solves each position outright", () => {
    const rng = seeded(0x5432);
    const solver = SEARCH_SOLVERS.sortedEcho;
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      const length = 5 + Math.floor(rng() * 5);
      let password = String(Math.floor(rng() * 9) + 1);
      for (let k = 1; k < length; k++) password += String(Math.floor(rng() * 10));
      const h = host(password);
      const result = crack(solver, h);
      expect(result.password, `password ${password} (code ${result.code})`).toBe(password);
      expect(result.calls).toBeLessThanOrEqual(solver.budget(h.facts));
      worst = Math.max(worst, result.calls);
    }
    // One exchange per position, less the one the multiset gives away.
    expect(worst).toBeLessThanOrEqual(10);
  });

  test("below length 5 there is NO oracle, so it walks the multiset — and needs no charisma", () => {
    const rng = seeded(0x99);
    const solver = SEARCH_SOLVERS.sortedEcho;
    for (let i = 0; i < 200; i++) {
      const length = 2 + Math.floor(rng() * 3);
      let password = String(Math.floor(rng() * 9) + 1);
      for (let k = 1; k < length; k++) password += String(Math.floor(rng() * 10));
      const h = host(password);
      const result = crack(solver, h);
      expect(result.password, `password ${password} (code ${result.code})`).toBe(password);
      expect(result.calls).toBeLessThanOrEqual(solver.budget(h.facts));
    }
    // The claim that makes this regime special: it reads no response at all, so
    // it works on a host whose charisma requirement we have not met.
    const step = solver.first({ passwordLength: 4, passwordFormat: "numeric", data: "1234" });
    expect(step.kind === "attempt" && step.needsOracle).toBe(false);
  });

  test("a numeric ordering with a leading zero is never attempted", () => {
    const solver = SEARCH_SOLVERS.sortedEcho;
    const facts: PasswordFacts = { passwordLength: 3, passwordFormat: "numeric", data: "013" };
    let step = solver.first(facts);
    const tried: string[] = [];
    let guard = 0;
    while (step.kind === "attempt" && guard++ < 30) {
      tried.push(step.password);
      step = solver.next(facts, step.state, { attempted: step.password, code: 401, success: false });
    }
    expect(tried.length).toBeGreaterThan(0);
    for (const candidate of tried) expect(candidate.startsWith("0"), `${candidate} starts with 0`).toBe(false);
  });

  test("placement evidence skips RMS probes for already fixed positions", () => {
    const plain = host("57312");
    const hinted = host("57312");
    hinted.facts.evidence = [
      { kind: "placement", attempted: "5!!!2", placed: ["5", "2"], at: 1 },
    ];
    const withoutHints = crack(SEARCH_SOLVERS.sortedEcho, plain);
    const withHints = crack(SEARCH_SOLVERS.sortedEcho, hinted);
    expect(withoutHints.password).toBe("57312");
    expect(withHints.password).toBe("57312");
    expect(withHints.calls).toBeLessThan(withoutHints.calls);
  });

  test("contradictory harvested evidence does not fall back to an evidence-blind search", () => {
    const step = SEARCH_SOLVERS.sortedEcho.first({
      passwordLength: 5,
      passwordFormat: "numeric",
      data: "12345",
      evidence: [{ kind: "contains", chars: ["9", "9"], at: 1 }],
    });
    expect(step.kind).toBe("give-up");
    if (step.kind === "give-up") expect(step.code).toBe(SOLVER_CODES.SolverExhausted);
  });

  test("distinctPermutations does not repeat a repeated character", () => {
    expect(distinctPermutations("aab").sort()).toEqual(["aab", "aba", "baa"]);
    expect(distinctPermutations("1111")).toEqual(["1111"]);
  });

  test("readRmsd finds the deviation in upstream's own phrasing", () => {
    expect(readRmsd("01234; RMS Deviation:3.162")).toBeCloseTo(3.162, 6);
    expect(readRmsd("no deviation here")).toBeUndefined();
  });
});
