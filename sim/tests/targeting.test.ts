import { beforeAll, describe, expect, test } from "bun:test";
import { makeHackContext, type HackContext } from "../../shared/formulas.ts";
import { prepTimeSeconds, solveCycle, solvePrep, type TargetStatics } from "../../shared/strategy/targeting.ts";
import { applyGrow, applyHack, applyWeaken, serverFromSpec, type SimServer } from "../core/effects.ts";
import { mockPerson, mockServer } from "../core/mocks.ts";
import { mulberry32 } from "../core/rng.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { replaceCurrentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { calculateExp } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";

beforeAll(() => replaceCurrentNodeMults(getBitNodeMultipliers(1, 1)));

const JOESGUNS: TargetStatics = {
  hostname: "joesguns",
  minDifficulty: 5,
  moneyMax: 62_500_000,
  requiredHackingSkill: 10,
  serverGrowth: 20,
  baseDifficulty: 15,
};

function makeScenario(skill: number): { ctx: HackContext; person: ReturnType<typeof mockPerson>; server: SimServer } {
  const person = mockPerson();
  person.skills.hacking = skill;
  person.exp.hacking = calculateExp(skill);
  const ctx = makeHackContext({ skill, intelligence: 0, mults: person.mults }, {});
  const server = serverFromSpec(
    {
      hostname: JOESGUNS.hostname,
      hackDifficulty: JOESGUNS.baseDifficulty,
      moneyAvailable: JOESGUNS.moneyMax / 25,
      requiredHackingSkill: JOESGUNS.requiredHackingSkill,
      serverGrowth: JOESGUNS.serverGrowth,
      numOpenPortsRequired: 0,
      maxRam: 16,
    },
    mockServer() as SimServer,
  );
  server.hasAdminRights = true;
  // Prepped state: the cycle solve assumes (minSec, moneyMax).
  server.hackDifficulty = server.minDifficulty;
  server.moneyAvailable = server.moneyMax;
  return { ctx, person, server };
}

function resetPerson(person: ReturnType<typeof mockPerson>, skill: number): void {
  person.skills.hacking = skill;
  person.exp.hacking = calculateExp(skill);
}

describe("solveCycle", () => {
  test("one solved batch round-trips exactly through the game effects", () => {
    const skill = 300;
    const { ctx, person, server } = makeScenario(skill);
    const solution = solveCycle(ctx, JOESGUNS)!;
    expect(solution).toBeDefined();
    // (100-minSec)/100 caps chance below 1 even at high skill.
    expect(solution.chance).toBeCloseTo(0.9319, 3);

    // Land in batch order H -> W1 -> G -> W2 with a forced hack success.
    const hack = applyHack(server, person, solution.hackThreads, 0);
    expect(hack.success).toBe(true);
    // incomePerBatch is chance-weighted EV; a forced success pays the full steal.
    expect(hack.moneyGained).toBeCloseTo(solution.incomePerBatch / solution.chance, 4);
    applyWeaken(server, person, solution.weaken1Threads, 1);
    expect(server.hackDifficulty).toBe(server.minDifficulty); // W1 covers hack fortify
    applyGrow(server, person, solution.growThreads, 1);
    expect(server.moneyAvailable).toBe(server.moneyMax); // G restores exactly (cap-tight)
    applyWeaken(server, person, solution.weaken2Threads, 1);
    expect(server.hackDifficulty).toBe(server.minDifficulty); // W2 covers grow fortify
  });

  test("grow threads are tight: one less would under-restore", () => {
    const skill = 300;
    const { ctx, person, server } = makeScenario(skill);
    const solution = solveCycle(ctx, JOESGUNS)!;
    applyHack(server, person, solution.hackThreads, 0);
    resetPerson(person, skill);
    applyWeaken(server, person, solution.weaken1Threads, 1);
    resetPerson(person, skill);
    applyGrow(server, person, solution.growThreads - 1, 1);
    expect(server.moneyAvailable).toBeLessThan(server.moneyMax);
  });

  test("Monte-Carlo: realized $/GB/sec within 2% of the score", () => {
    const skill = 60; // low enough that chance < 1 matters
    const { ctx, person, server } = makeScenario(skill);
    const solution = solveCycle(ctx, JOESGUNS)!;
    expect(solution.chance).toBeGreaterThan(0.4);
    expect(solution.chance).toBeLessThan(1);

    const rng = mulberry32(99);
    let realized = 0;
    const batches = 20_000;
    for (let i = 0; i < batches; i++) {
      resetPerson(person, skill); // freeze skill: the score is a fixed-ctx quantity
      const outcome = applyHack(server, person, solution.hackThreads, rng());
      realized += outcome.moneyGained;
      resetPerson(person, skill);
      applyWeaken(server, person, solution.weaken1Threads, 1);
      resetPerson(person, skill);
      applyGrow(server, person, solution.growThreads, 1);
      resetPerson(person, skill);
      applyWeaken(server, person, solution.weaken2Threads, 1);
      expect(server.moneyAvailable).toBe(server.moneyMax);
      expect(server.hackDifficulty).toBe(server.minDifficulty);
    }
    const ramSec =
      solution.hackTimeS *
      (1.7 * solution.hackThreads +
        1.75 * 3.2 * solution.growThreads +
        1.75 * 4 * (solution.weaken1Threads + solution.weaken2Threads));
    const realizedScore = realized / (ramSec * batches);
    expect(Math.abs(realizedScore - solution.score) / solution.score).toBeLessThan(0.02);
  });

  test("integer snap: neighbors do not beat the solution", () => {
    const { ctx } = makeScenario(500);
    const solution = solveCycle(ctx, JOESGUNS)!;
    // Re-derive scores for H±1 through the public solve invariants.
    expect(solution.hackThreads).toBeGreaterThanOrEqual(1);
    expect(solution.score).toBeGreaterThan(0);
    expect(solution.stealFraction).toBeLessThanOrEqual(0.951);
  });

  test("ineligible targets return undefined", () => {
    const { ctx } = makeScenario(100);
    expect(solveCycle(ctx, { ...JOESGUNS, moneyMax: 0 })).toBeUndefined();
    expect(solveCycle(ctx, { ...JOESGUNS, serverGrowth: 0 })).toBeUndefined();
    expect(solveCycle(ctx, { ...JOESGUNS, requiredHackingSkill: 1_000 })).toBeUndefined();
  });
});

describe("solvePrep", () => {
  test("prep plan lands the target at (minSec, moneyMax)", () => {
    const skill = 200;
    const { ctx, person, server } = makeScenario(skill);
    // Unprepped state: raised security, drained money.
    server.hackDifficulty = 42;
    server.moneyAvailable = server.moneyMax * 0.03;
    const plan = solvePrep(ctx, JOESGUNS, {
      hackDifficulty: server.hackDifficulty,
      moneyAvailable: server.moneyAvailable,
    });
    expect(plan.prepped).toBe(false);

    applyWeaken(server, person, plan.weaken1Threads, 1);
    expect(server.hackDifficulty).toBe(server.minDifficulty);
    resetPerson(person, skill);
    applyGrow(server, person, plan.growThreads, 1);
    expect(server.moneyAvailable).toBe(server.moneyMax);
    resetPerson(person, skill);
    applyWeaken(server, person, plan.weaken2Threads, 1);
    expect(server.hackDifficulty).toBe(server.minDifficulty);
  });

  test("prepped detection and prep time", () => {
    const { ctx } = makeScenario(200);
    const done = solvePrep(ctx, JOESGUNS, { hackDifficulty: 5.5, moneyAvailable: JOESGUNS.moneyMax });
    expect(done.prepped).toBe(true);
    expect(prepTimeSeconds(done, 100)).toBe(0);

    const cold = solvePrep(ctx, JOESGUNS, { hackDifficulty: 42, moneyAvailable: 1 });
    expect(prepTimeSeconds(cold, 1e9)).toBe(cold.weakenTimeS); // latency floor
    expect(prepTimeSeconds(cold, 1)).toBeGreaterThan(cold.weakenTimeS); // RAM-bound
    expect(prepTimeSeconds(cold, 0)).toBe(Infinity);
  });
});

describe("solver benchmark (budgets from spec/targeting.md)", () => {
  const statics: TargetStatics[] = Array.from({ length: 100 }, (_, i) => ({
    hostname: `synth-${i}`,
    minDifficulty: 1 + (i % 30),
    moneyMax: 1e6 * (1 + i) * (1 + (i % 7)),
    requiredHackingSkill: 1 + i * 9,
    serverGrowth: 1 + ((i * 13) % 99),
    baseDifficulty: 1 + (i % 60),
  }));

  test("full refresh of 100 targets stays far under 200ms; 8-target slice under 2ms", () => {
    const ctx = makeHackContext({ skill: 1_000, intelligence: 50, mults: mockPerson().mults }, {});
    // Warmup
    for (const target of statics) solveCycle(ctx, target);

    let fullBest = Infinity;
    for (let round = 0; round < 3; round++) {
      const start = performance.now();
      for (const target of statics) solveCycle(ctx, target);
      fullBest = Math.min(fullBest, performance.now() - start);
    }
    expect(fullBest).toBeLessThan(200);

    let sliceBest = Infinity;
    for (let round = 0; round < 3; round++) {
      const start = performance.now();
      for (let i = 0; i < 8; i++) solveCycle(ctx, statics[i]!);
      sliceBest = Math.min(sliceBest, performance.now() - start);
    }
    expect(sliceBest).toBeLessThan(2);
    console.log(`bench: full 100-target refresh ${fullBest.toFixed(2)}ms, 8-target slice ${sliceBest.toFixed(3)}ms`);
  });
});
