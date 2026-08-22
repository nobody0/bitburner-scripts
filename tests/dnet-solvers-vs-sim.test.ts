import { describe, expect, test } from "bun:test";
import { generateSecret, passwordRng } from "../sim/features/dnet-generators.ts";
import { checkPassword, type PacketWorld } from "../sim/features/dnet-feedback.ts";
import { CLOSED_FORM_SOLVERS } from "../shared/strategy/dnet/solvers/closed-form.ts";
import { SEARCH_SOLVERS } from "../shared/strategy/dnet/solvers/search.ts";
import { DEEP_SOLVERS } from "../shared/strategy/dnet/solvers/deep.ts";
import { GROUP_SOLVERS, blankIsSafe } from "../shared/strategy/dnet/solvers/group.ts";
import { HILL_SOLVERS } from "../shared/strategy/dnet/solvers/hill.ts";
import { solverFor } from "../shared/strategy/dnet/solvers/index.ts";
import type { Solver, SolverObservation } from "../shared/strategy/dnet/solvers/types.ts";
import type { ModelId, PasswordFacts } from "../shared/strategy/dnet/models.ts";

/** The end-to-end proof: every solver, against the SIMULATOR's transcription of
 * upstream's generators and its failure switch.
 *
 * The per-solver suites drive each attack against an oracle written inside the
 * test, which proves the algorithm. This proves something different and harder
 * to fake — that the algorithm works on the passwords the game actually mints,
 * read through the fields `getServerDetails` actually returns. Those two halves
 * were transcribed independently, from upstream, by different authors; if either
 * misread it, the passwords stop opening here.
 *
 * `tests/` importing from `sim/` is the established direction (`sim/` may import
 * `game/` and `shared/`, never the reverse). */

/** Everything `getServerDetails` would tell us about a generated host — which is
 * all a solver is ever allowed to see. The password itself is held only by the
 * oracle below. */
function mint(modelId: string, difficulty: number, hostname: string, draw: number): {
  password: string;
  facts: PasswordFacts;
  server: { modelId: string; hostname: string; password: string; passwordHint: string; data: string; difficulty: number };
} {
  const secret = generateSecret(modelId, difficulty, passwordRng(draw, hostname));
  return {
    password: secret.password,
    facts: {
      passwordLength: secret.passwordLength,
      passwordFormat: secret.passwordFormat,
      passwordHint: secret.hint,
      data: secret.data,
      difficulty,
    },
    server: {
      modelId,
      hostname,
      password: secret.password,
      passwordHint: secret.hint,
      data: secret.data,
      difficulty,
    },
  };
}

/** The sim's own packet world, which only `OpenWebAccessPoint` reads.
 *
 * `rand` MUST vary. Upstream mints a fresh junk blob around the same password on
 * every failed attempt, and above difficulty 16 the password is embedded bare —
 * so the attack is to intersect the runs common to several captures. A constant
 * `rand` would make every capture identical, the intersection would never
 * narrow, and the test would be measuring nothing. */
const world: PacketWorld = {
  movablePasswords: () => [],
  serverNames: () => ["darkweb"],
  lastAttempted: () => null,
  rand: (() => {
    let state = 0x5eed;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  })(),
};

interface Outcome {
  opened: boolean;
  calls: number;
  detail: string;
}

/** Drive one solver against one minted host, exactly as the job loop would:
 * attempt, read the response out of the log ring, hand it back. */
function crack(solver: Solver, host: ReturnType<typeof mint>, cap = 400): Outcome {
  let step = solver.first(host.facts);
  let calls = 0;
  while (calls < cap) {
    if (step.kind === "give-up") return { opened: false, calls, detail: `gave up ${step.code}: ${step.reason}` };
    const attempt = step.password;
    calls++;
    const response = checkPassword(host.server, attempt, 1000, world);
    if (response.ok) {
      return { opened: true, calls, detail: step.kind === "answer" ? "answered" : "attempted" };
    }
    if (step.kind === "answer") {
      return { opened: false, calls, detail: `asserted ${JSON.stringify(attempt)} and was refused` };
    }
    const seen: SolverObservation = {
      attempted: attempt,
      code: 401,
      success: false,
      oracle: {
        kind: "oracle",
        code: 401,
        message: response.message,
        data: response.data,
        passwordAttempted: attempt,
      },
    };
    step = solver.next(host.facts, step.state, seen);
  }
  return { opened: false, calls, detail: "ran past the cap" };
}

/** Every solved model, the solver that owns it, the difficulty band it can
 * actually be drawn at (`ServerGenerator.ts:18-62`), and the WORST number of
 * `authenticate` calls it took over the hosts below.
 *
 * `worst` is a measured ratchet, in the spirit of `sim/tests/baselines/`: only
 * ever move it in the improving direction, and only from a run actually
 * observed. Relaxing one to make a red test green converts it from evidence
 * into decoration. Re-measure with `BB_RECORD_SOLVER_COST=1`.
 *
 * The column is worth reading as a whole. Eight of the fifteen open in ONE call
 * because the host publishes its own password; the interactive ones cost about
 * what the plan predicted; and only `2G_cellular` at its alphanumeric worst runs
 * past the ~32 exchanges a single vantage window buys, which is the case the
 * resumable state exists for. */
const SOLVED: { model: ModelId; difficulties: number[]; worst: number }[] = [
  // Closed form — the password is published, so one call and no oracle.
  { model: "DeskMemo_3.1", difficulties: [0, 1, 2, 4, 6, 8], worst: 1 },
  { model: "CloudBlare(tm)", difficulties: [0, 1, 2, 4, 6, 8], worst: 1 },
  { model: "110100100", difficulties: [10, 14, 18, 24, 30], worst: 1 },
  { model: "OrdoXenos", difficulties: [10, 14, 18, 24, 30], worst: 1 },
  { model: "PrimeTime 2", difficulties: [10, 14, 18, 24, 30], worst: 1 },
  // Both tolerance models decoded exactly every time, so the rounding ladder
  // never had to fire — but it stays, because a fractional base is lossy by
  // construction and this is a sample, not a proof.
  { model: "OctantVoxel", difficulties: [4, 8, 12, 16, 20], worst: 1 },
  { model: "MathML", difficulties: [10, 14, 18, 22, 30], worst: 1 },
  { model: "Pr0verFl0", difficulties: [4, 6, 8, 12], worst: 1 },
  // Feedback-driven.
  { model: "AccountsManager_4.2", difficulties: [4, 6, 8, 12, 16], worst: 7 },
  { model: "BigMo%od", difficulties: [10, 14, 18, 24, 30], worst: 9 },
  // BOTH regimes. Below difficulty 8 `data` is a bare Roman numeral and the
  // answer is a decode; at or above it is a range and the answer is a search.
  { model: "BellaCuore", difficulties: [2, 4, 6, 7, 10, 14, 18, 24], worst: 11 },
  { model: "PHP 5.4", difficulties: [4, 8, 14, 21, 28], worst: 23 },
  { model: "NIL", difficulties: [4, 6, 8, 12], worst: 63 },
  { model: "Factori-Os", difficulties: [4, 8, 12, 16, 20], worst: 104 },
  // Group testing: a count becomes a binary search once the attempt is allowed
  // to contain a character the password cannot.
  { model: "DeepGreen", difficulties: [4, 8, 14, 20, 28], worst: 72 },
  { model: "RateMyPix.Auth", difficulties: [8, 14, 20, 28], worst: 110 },
  // Not a minigame: the capture leaks the password outright below difficulty 17,
  // and above it the same password sits in every fresh blob.
  { model: "OpenWebAccessPoint", difficulties: [4, 8, 12, 16, 20, 26], worst: 4 },
  { model: "KingOfTheHill", difficulties: [8, 14, 20, 28, 36], worst: 54 },
  // The one that spans vantage windows: 62 symbols by up to 8 positions.
  { model: "2G_cellular", difficulties: [10, 14, 18, 24], worst: 266 },
];

describe("every solved model opens a host the simulator minted", () => {
  for (const { model, difficulties, worst: expectedWorst } of SOLVED) {
    test(`${model}`, () => {
      // Through `solverFor`, NOT through a hand-picked solver.
      //
      // This test used to name the solver for each model directly, and that hid
      // a real bug for as long as it existed: `BellaCuore` has two regimes, and
      // pointing the table at the range solver meant the decode regime was never
      // exercised here at all — while in the game every host below difficulty 8
      // was permanently unattemptable, because the range solver gave up on a
      // `data` with no comma and `planAttempt` turns a give-up into "no task".
      // Dispatching the way the game dispatches is the only version of this test
      // that could have caught it.
      const solver = solverFor(model);
      expect(solver, `${model} has no solver registered`).toBeDefined();
      if (!solver) return;
      let worst = 0;
      let hosts = 0;
      for (const difficulty of difficulties) {
        for (let seed = 0; seed < 25; seed++) {
          const host = mint(model, difficulty, `depth${difficulty}_h${seed}`, (seed * 977 + 13) / 4096);
          const result = crack(solver, host);
          expect(
            result.opened,
            `${model} @${difficulty} seed ${seed}: password ${JSON.stringify(host.password)} — ${result.detail}`,
          ).toBe(true);
          expect(result.calls, `${model} @${difficulty} seed ${seed} exceeded its declared budget`)
            .toBeLessThanOrEqual(solver.budget(host.facts));
          worst = Math.max(worst, result.calls);
          hosts++;
        }
      }
      expect(hosts).toBe(difficulties.length * 25);
      if (process.env["BB_RECORD_SOLVER_COST"]) console.log(`COST ${model} ${worst}`);
      // The ratchet. A refactor that makes a model costlier fails here rather
      // than quietly slowing the net down.
      expect(worst, `${model} got more expensive; re-measure before moving this`).toBe(expectedWorst);
    });
  }
});

describe("the shallow net is fully covered", () => {
  test("every model a difficulty <= 2 host can draw is now solvable", () => {
    // ServerGenerator.ts:44-47 — at difficulty <= 2 the pool is tier 0 plus
    // tier 1, and that is exactly these four. Two were already dictionaries;
    // the other two are closed-form now, so the shallow net has no unsolved
    // model left in it at all.
    const shallowPool = ["ZeroLogon", "DeskMemo_3.1", "FreshInstall_1.0", "CloudBlare(tm)"];
    const solvedHere = new Set(SOLVED.map((entry) => entry.model as string));
    const dictionaries = new Set(["ZeroLogon", "FreshInstall_1.0"]);
    for (const model of shallowPool) {
      expect(
        solvedHere.has(model) || dictionaries.has(model),
        `${model} can appear at difficulty <= 2 and has no solver`,
      ).toBe(true);
    }
  });

  test("the group test's blank symbol cannot occur in any generated password", () => {
    // The whole attack rests on the attempt being allowed to hold a character
    // the password cannot. If a generator ever drew punctuation, the counts
    // would stop meaning what the solver thinks they mean.
    expect(blankIsSafe()).toBe(true);
  });

  test("the closed-form models cost exactly one call and never read the ring", () => {
    // The claim that makes them worth shipping first: no round trip, and no
    // charisma, because heartbleed is the only charisma-gated call.
    for (const name of ["echo", "captcha", "binary", "xorMask", "largestPrimeFactor", "bufferOverflow"] as const) {
      const solver = CLOSED_FORM_SOLVERS[name];
      expect(solver.needsOracle, `${name} reads the log ring`).toBe(false);
      expect(solver.budget({}), `${name} costs more than one call`).toBe(1);
    }
  });
});
