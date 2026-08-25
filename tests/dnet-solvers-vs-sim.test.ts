import { describe, expect, test } from "bun:test";
import {
  DNET_AUTH_CASES,
  benchmarkHintEvidence,
  mintDnetAuthHost,
  runDnetAuthentication,
} from "../sim/dnet-auth-benchmark.ts";
import { CLOSED_FORM_SOLVERS } from "../shared/strategy/dnet/solvers/closed-form.ts";
import { blankIsSafe } from "../shared/strategy/dnet/solvers/group.ts";
import { MODEL_IDS, type ModelId } from "../shared/strategy/dnet/models.ts";

/** End-to-end proof against the simulator's independently transcribed password
 * generators and failure switch. Dictionary models go through planAttempt;
 * conversations dispatch through solverFor rather than naming a solver here. */

/** Measured maxima over every difficulty and 25 deterministic hosts per row.
 * Re-measure with BB_RECORD_SOLVER_COST=1 and only move a value downward. */
const EXPECTED_WORST: Record<Exclude<ModelId, "(The Labyrinth)">, number> = {
  ZeroLogon: 1,
  "FreshInstall_1.0": 1,
  Laika4: 2,
  TopPass: 38,
  "EuroZone Free": 10,
  "DeskMemo_3.1": 1,
  "CloudBlare(tm)": 1,
  "110100100": 1,
  OrdoXenos: 1,
  "PrimeTime 2": 1,
  OctantVoxel: 1,
  MathML: 1,
  Pr0verFl0: 1,
  "AccountsManager_4.2": 6,
  "BigMo%od": 8,
  BellaCuore: 11,
  "PHP 5.4": 23,
  NIL: 62,
  "Factori-Os": 119,
  DeepGreen: 33,
  "RateMyPix.Auth": 104,
  OpenWebAccessPoint: 4,
  KingOfTheHill: 42,
  "2G_cellular": 205,
};

describe("every password model opens hosts the simulator minted", () => {
  for (const { model, difficulties } of DNET_AUTH_CASES) {
    test(model, () => {
      let worst = 0;
      let hosts = 0;
      for (const difficulty of difficulties) {
        for (let seed = 0; seed < 25; seed++) {
          const result = runDnetAuthentication(model, difficulty, seed);
          expect(result.opened, `${model} @${difficulty} seed ${seed}: ${result.detail}`).toBe(true);
          if (result.budget !== undefined) {
            expect(result.calls, `${model} @${difficulty} seed ${seed} exceeded budget ${result.budget}`)
              .toBeLessThanOrEqual(result.budget);
          }
          worst = Math.max(worst, result.calls);
          hosts++;
        }
      }
      expect(hosts).toBe(difficulties.length * 25);
      if (process.env["BB_RECORD_SOLVER_COST"]) console.log(`COST ${model} ${worst}`);
      expect(worst, `${model} got more expensive; re-measure before moving this`)
        .toBe(EXPECTED_WORST[model]);
    });
  }
});

test("the benchmark matrix covers all 24 password models exactly once", () => {
  expect(DNET_AUTH_CASES.map(({ model }) => model).sort())
    .toEqual(MODEL_IDS.filter((model) => model !== "(The Labyrinth)").sort());
});

test("every model still solves with every harvested hint shape attached", () => {
  for (const { model, difficulties } of DNET_AUTH_CASES) {
    for (const difficulty of difficulties) {
      const seed = 7;
      const host = mintDnetAuthHost(model, difficulty, seed);
      for (const profile of ["contains", "placement", "combined"] as const) {
        const result = runDnetAuthentication(model, difficulty, seed, {
          evidence: benchmarkHintEvidence(host.password, profile),
        });
        expect(result.opened, `${model} @${difficulty} with ${profile} evidence: ${result.detail}`).toBe(true);
        if (result.budget !== undefined) expect(result.calls).toBeLessThanOrEqual(result.budget);
      }
    }
  }
});

test("harvested hints materially reduce the expensive conversations", () => {
  const ceilings: Partial<Record<Exclude<ModelId, "(The Labyrinth)">, number>> = {
    "2G_cellular": 41,
    "Factori-Os": 49,
    "RateMyPix.Auth": 65,
    DeepGreen: 17,
    TopPass: 2,
  };
  for (const { model, difficulties } of DNET_AUTH_CASES) {
    const ceiling = ceilings[model];
    if (ceiling === undefined) continue;
    let calls = 0;
    let hosts = 0;
    for (const difficulty of difficulties) {
      for (let seed = 0; seed < 25; seed++) {
        const host = mintDnetAuthHost(model, difficulty, seed);
        calls += runDnetAuthentication(model, difficulty, seed, {
          evidence: benchmarkHintEvidence(host.password, "combined"),
        }).calls;
        hosts++;
      }
    }
    expect(calls / hosts, `${model} stopped making enough use of harvested hints`).toBeLessThanOrEqual(ceiling);
  }
});

describe("the shallow net is fully covered", () => {
  test("every model a difficulty <= 2 host can draw is solvable", () => {
    const shallowPool = ["ZeroLogon", "DeskMemo_3.1", "FreshInstall_1.0", "CloudBlare(tm)"];
    const solved = new Set(DNET_AUTH_CASES.map(({ model }) => model as string));
    for (const model of shallowPool) expect(solved.has(model), `${model} has no benchmark case`).toBe(true);
  });

  test("the group test's blank symbol cannot occur in any generated password", () => {
    expect(blankIsSafe()).toBe(true);
  });

  test("the closed-form models cost exactly one call and never read the ring", () => {
    for (const name of ["echo", "captcha", "binary", "xorMask", "largestPrimeFactor", "bufferOverflow"] as const) {
      const solver = CLOSED_FORM_SOLVERS[name];
      expect(solver.needsOracle, `${name} reads the log ring`).toBe(false);
      expect(solver.budget({}), `${name} costs more than one call`).toBe(1);
    }
  });
});
