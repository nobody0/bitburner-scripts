import { describe, expect, test } from "bun:test";
import { solvedModels, solverFor } from "../shared/strategy/dnet/solvers/index.ts";
import type { SolverObservation, SolverStep } from "../shared/strategy/dnet/solvers/types.ts";
import { generateSecret, passwordRng } from "../sim/features/dnet-generators.ts";
import {
  ahead,
  emptyMaze,
  markBlocked,
  stepMaze,
  type Cell,
  type MazeKnowledge,
} from "../shared/strategy/dnet/maze.ts";

/** Does it STOP?
 *
 * This file exists because 147 passing tests did not notice three separate
 * infinite loops. Every one of them verified that a mechanism produced the right
 * answer when the world behaved, and that its failure paths had the right SHAPE
 * — the right code, the right reason string — without ever checking that a
 * failure path is actually reached.
 *
 * The three, all found by review rather than by tests:
 *
 * - a solver that gave up was re-derived from scratch every tick, for ever,
 *   because the give-up was never written anywhere the next derivation reads;
 * - the maze walker had no memory of a refused move, so it returned the same
 *   direction into the same wall indefinitely — and because it beats on every
 *   iteration, neither the long-job beat nor the job timeout would ever fire;
 * - a resumed solve at its budget sent one more attempt on every vantage, for
 *   ever, because the budget was checked after the resume rather than before.
 *
 * The common shape is that each was driven by a HOSTILE or DEGENERATE response
 * rather than a helpful one, and nothing drove them that way. So this file is
 * organised around adversaries, not around features: every solver and the walker
 * are run against oracles that refuse to cooperate, and the only thing asserted
 * is that they reach a terminal state inside their own declared budget.
 *
 * A test here should never assert WHICH terminal state. That is the other
 * suites' job, and pinning it here would make this file fail for reasons that
 * are not about termination. */

/** Real facts for a real host of this model, so a solver is not tripping over a
 * malformed `data` field it would never see in the game. Only the RESPONSES are
 * hostile. */
function factsFor(model: string, difficulty: number) {
  const secret = generateSecret(model, difficulty, passwordRng(0.31337, `term-${model}`));
  return {
    passwordLength: secret.passwordLength,
    passwordFormat: secret.passwordFormat,
    passwordHint: secret.hint,
    data: secret.data,
    difficulty,
  };
}

/** The ways a host can answer without ever helping. Each is a real thing the
 * engine or the net can do to us. */
const ADVERSARIES: Record<string, (attempted: string) => SolverObservation> = {
  /** The log ring was unreadable — below the charisma gate, or heartbleed
   *  refused. The solver gets a refusal and nothing else, for ever. */
  "no oracle at all": (attempted) => ({ attempted, code: 401, success: false }),

  /** The ring answers, but always with the same thing. This is the shape that
   *  caught the maze walker: a response that never changes must not produce a
   *  decision that never changes. */
  "the same response every time": (attempted) => ({
    attempted,
    code: 401,
    success: false,
    oracle: { kind: "oracle", code: 401, data: "0,0", message: "no", passwordAttempted: attempted },
  }),

  /** A present but empty payload. `Number("")` is 0 and `Number.isInteger(0)` is
   *  true, so this reads as a confident zero to anything that does not guard it. */
  "an empty payload": (attempted) => ({
    attempted,
    code: 401,
    success: false,
    oracle: { kind: "oracle", code: 401, data: "", message: "", passwordAttempted: attempted },
  }),

  /** Grammar drift: the model answers in a shape we do not know. */
  "a response in the wrong grammar": (attempted) => ({
    attempted,
    code: 401,
    success: false,
    oracle: { kind: "oracle", code: 401, data: "who knows", message: "???", passwordAttempted: attempted },
  }),

  /** An oracle belonging to somebody else's attempt. The ring is shared, so this
   *  is what a mismatched fold looks like. */
  "an oracle for a different attempt": (attempted) => ({
    attempted,
    code: 401,
    success: false,
    oracle: { kind: "oracle", code: 401, data: "1,1", passwordAttempted: "not-ours" },
  }),
};

/** Drive a solver until it stops, or until it has plainly failed to.
 *
 * The cap is generous on purpose: the assertion is not "it stopped quickly", it
 * is "it stopped at all, and within what it said it would spend". */
function runToEnd(model: string, facts: ReturnType<typeof factsFor>, answer: (attempted: string) => SolverObservation) {
  const solver = solverFor(model)!;
  const budget = solver.budget(facts);
  const hardCap = budget * 4 + 50;
  let step: SolverStep = solver.first(facts);
  let calls = 0;
  const sent: string[] = [];

  while (step.kind !== "give-up") {
    if (step.kind === "answer") {
      // An assertion the solver believes is the password. One call, then it is
      // the caller's business — there is nothing left to loop over.
      return { stopped: true, calls: calls + 1, sent, terminal: "answer" as const };
    }
    calls++;
    sent.push(step.password);
    if (calls > hardCap) return { stopped: false, calls, sent, terminal: "looped" as const };
    step = solver.next(facts, step.state, answer(step.password));
  }
  return { stopped: true, calls, sent, terminal: "give-up" as const };
}

describe("every solver stops when the host will not help", () => {
  // Difficulties chosen so each model is actually reachable at one of them, and
  // so both of BellaCuore's regimes and the alphanumeric variants are covered.
  const DIFFICULTIES = [2, 8, 20, 30];

  for (const model of solvedModels()) {
    for (const [adversary, answer] of Object.entries(ADVERSARIES)) {
      test(`${model} vs ${adversary}`, () => {
        for (const difficulty of DIFFICULTIES) {
          const facts = factsFor(model, difficulty);
          const solver = solverFor(model)!;
          const result = runToEnd(model, facts, answer);
          expect(
            result.stopped,
            `${model} @${difficulty} never stopped: ${result.calls} calls, last sent ${JSON.stringify(result.sent.slice(-3))}`,
          ).toBe(true);
          // And it stopped inside what it declared. A solver that overruns its
          // own budget is one the job loop cannot bound either.
          expect(
            result.calls,
            `${model} @${difficulty} spent ${result.calls} against a declared budget of ${solver.budget(facts)}`,
          ).toBeLessThanOrEqual(solver.budget(facts) + 1);
        }
      });
    }
  }
});

describe("a solver never sends something the engine would throw on", () => {
  test("no attempt exceeds the length authenticate refuses", () => {
    // `authenticate` THROWS above MAX_PASSWORD_LENGTH * 2 = 100, and a throw
    // kills the agent process rather than failing the attempt — so this is a
    // liveness property, not a politeness one.
    for (const model of solvedModels()) {
      for (const difficulty of [2, 20, 40]) {
        const facts = factsFor(model, difficulty);
        const result = runToEnd(model, facts, ADVERSARIES["the same response every time"]!);
        for (const password of result.sent) {
          expect(password.length, `${model} @${difficulty} sent ${password.length} characters`).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  test("no attempt is a divisor the engine would misreport", () => {
    // `Factori-Os` computes `password % attempt`; `% 0` is NaN, which is falsy,
    // so upstream reports that the password IS divisible by zero. A solver that
    // sent it would poison its own reconstruction.
    const facts = factsFor("Factori-Os", 8);
    const result = runToEnd("Factori-Os", facts, ADVERSARIES["the same response every time"]!);
    for (const password of result.sent) expect(Number(password)).toBeGreaterThan(0);
  });
});

describe("the maze walker stops when every move is refused", () => {
  /** The engine answers a blocked move by leaving the position UNCHANGED and
   * re-rendering the same surroundings. So the walker sees an identical world on
   * every call — which is precisely the input that made it bump one wall for
   * ever. */
  test("a walker whose every move is refused terminates", () => {
    // PATH is a SPACE, so the OPEN slots are the blanks: row 0 column 1 is
    // north, row 2 column 1 is south. Both open here; east and west walled.
    const render = "# #\n#@#\n# #";
    let known: MazeKnowledge = emptyMaze();
    const at: Cell = [5, 5];
    const tried: string[] = [];

    for (let i = 0; i < 200; i++) {
      const step = stepMaze(known, at, render, { width: 21, height: 13 });
      if (step.kind !== "go") {
        // Terminated. That is the whole assertion.
        expect(tried.length, "it gave up without ever trying a direction").toBeGreaterThan(0);
        return;
      }
      tried.push(step.direction);
      // The engine refused: position unchanged, and the walker must record it.
      known = markBlocked(step.known, at, step.direction);
    }
    throw new Error(`the walker never stopped; it tried ${JSON.stringify(tried.slice(0, 8))}...`);
  });

  test("a refused direction is never offered twice from the same cell", () => {
    // The narrower property underneath the one above, and the one that actually
    // failed: without it the walk is not merely slow, it cannot progress at all.
    const render = "   \n @ \n   "; // everything open
    let known: MazeKnowledge = emptyMaze();
    const at: Cell = [5, 5];
    const seen = new Set<string>();

    for (let i = 0; i < 20; i++) {
      const step = stepMaze(known, at, render, { width: 21, height: 13 });
      if (step.kind !== "go") break;
      expect(seen.has(step.direction), `${step.direction} was offered twice after being refused`).toBe(false);
      seen.add(step.direction);
      known = markBlocked(step.known, at, step.direction);
    }
    // Four directions, so it must have run out rather than looped.
    expect(seen.size).toBeLessThanOrEqual(4);
  });

  test("a walk in a real maze still finishes once refusals are recorded", () => {
    // The regression guard for the fix: recording blocked edges must not break
    // ordinary progress.
    const maze = ["#####", "#   #", "### #", "#   #", "#####"];
    const exit: Cell = [3, 3];
    let known: MazeKnowledge = emptyMaze();
    let at: Cell = [1, 1];
    const PATHCH = " ";
    for (let i = 0; i < 100; i++) {
      const rows: string[] = [];
      for (let y = at[1] - 1; y <= at[1] + 1; y++) {
        let row = "";
        for (let x = at[0] - 1; x <= at[0] + 1; x++) {
          row += (y === at[1] && x === at[0]) ? "@" : (maze[y]?.[x] ?? PATHCH);
        }
        rows.push(row);
      }
      const step = stepMaze(known, at, rows.join("\n"), { width: 5, height: 5 });
      if (step.kind !== "go") break;
      const next = ahead(at, step.direction);
      const wallX = (at[0] + next[0]) / 2;
      const wallY = (at[1] + next[1]) / 2;
      if (maze[wallY]?.[wallX] === PATHCH) {
        known = step.known;
        at = next;
        if (at[0] === exit[0] && at[1] === exit[1]) return;
      } else {
        known = markBlocked(step.known, at, step.direction);
      }
    }
    throw new Error(`never reached the exit; stopped at ${at[0]},${at[1]}`);
  });
});
