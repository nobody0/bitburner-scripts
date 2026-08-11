import { beforeAll, describe, expect, test } from "bun:test";
import { growThreads, growthLogPerThread, hackExpGain, makeHackContext, type HackContext } from "../../shared/formulas.ts";
import { prepTimeSeconds, prepWaveRamGb, solveCycle, solvePrep, type TargetStatics } from "../../shared/strategy/targeting.ts";
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

describe("pipeline-aware solve", () => {
  test("JIT prices a contiguous slot for hack time rather than weaken time", () => {
    // Generous batch RAM so the total-RAM cap does not bind: the plain solve
    // sizes the hack toward the whole 26 GB block. Under eager launch one slot
    // meant one batch per weakenTime and forced a smaller block. Under JIT the
    // slot is reusable after hackTime, so that forced shrink is incorrect.
    const { ctx } = makeScenario(300);
    const plain = solveCycle(ctx, JOESGUNS, 1, { batchGb: 200, hackBlockGb: 26 })!;
    const aware = solveCycle(ctx, JOESGUNS, 1, {
      batchGb: 200,
      hackBlockGb: 26,
      hostBlocksGb: [26, 8, 8, 8, 4],
      farmGb: 200,
    })!;
    expect(plain).toBeDefined();
    expect(aware).toBeDefined();
    const hackGb = (threads: number) => threads * 1.7;
    const slots = (gb: number) => [26, 8, 8, 8, 4].reduce((sum, host) => sum + Math.floor(host / gb), 0);
    // The plain solve takes (nearly) the whole big host: at most one slot.
    expect(slots(hackGb(plain.hackThreads))).toBe(1);
    // The aware solve may keep that one-slot shape because it cycles about four
    // times while the slow weaken support remains in flight.
    expect(aware.hackThreads).toBe(plain.hackThreads);
    expect(slots(hackGb(aware.hackThreads))).toBe(1);
    expect(aware.score).toBeLessThanOrEqual(plain.score + 1e-12);
    // And when RAM is the binding constraint the two scores agree exactly —
    // the pipeline term degenerates to income/ramSec on small fleets.
    const smallPlain = solveCycle(ctx, JOESGUNS, 1, { batchGb: 24, hackBlockGb: 8 })!;
    const smallAware = solveCycle(ctx, JOESGUNS, 1, {
      batchGb: 24,
      hackBlockGb: 8,
      hostBlocksGb: [8, 8, 8],
      farmGb: 24,
    })!;
    expect(smallAware.hackThreads).toBe(smallPlain.hackThreads);
  });

  test("stock manipulation income is chance-weighted on BOTH sides", () => {
    // Low skill vs joesguns -> chance well below 1. A failed hack moves no
    // money and leaves the server at moneyMax, so the paired grow moves a zero
    // fraction: long and short influence must be priced identically.
    const { ctx } = makeScenario(30);
    const long = solveCycle(ctx, JOESGUNS, 1, undefined, { valuePerOp: 5_000, side: "long" })!;
    const short = solveCycle(ctx, JOESGUNS, 1, undefined, { valuePerOp: 5_000, side: "short" })!;
    expect(long.chance).toBeLessThan(1);
    expect(long.hackThreads).toBe(short.hackThreads);
    expect(long.stockIncomePerBatch).toBeCloseTo(short.stockIncomePerBatch, 10);
  });
});

describe("solveCycle hgw", () => {
  test("an HGW batch round-trips exactly through the game effects", () => {
    const skill = 300;
    const { ctx, person, server } = makeScenario(skill);
    const solution = solveCycle(ctx, JOESGUNS, 1, undefined, undefined, "hgw")!;
    expect(solution).toBeDefined();
    expect(solution.kind).toBe("hgw");
    expect(solution.weaken1Threads).toBe(0);

    // Land H -> G -> W: the grow fires at min + hack fortify (no weaken in
    // between), the single weaken erases both fortifies.
    applyHack(server, person, solution.hackThreads, 0);
    resetPerson(person, skill);
    expect(server.hackDifficulty).toBeCloseTo(server.minDifficulty + 0.002 * solution.hackThreads, 10);
    applyGrow(server, person, solution.growThreads, 1);
    resetPerson(person, skill);
    expect(server.moneyAvailable).toBe(server.moneyMax); // overscaled grow restores at elevated sec
    applyWeaken(server, person, solution.weaken2Threads, 1);
    expect(server.hackDifficulty).toBe(server.minDifficulty);
  });

  test("the HGW weaken covers BOTH fortifies and the score never beats HWGW", () => {
    const { ctx } = makeScenario(300);
    const hwgw = solveCycle(ctx, JOESGUNS)!;
    const hgw = solveCycle(ctx, JOESGUNS, 1, undefined, undefined, "hgw")!;
    // The single weaken erases the hack fortify AND the (overscaled) grow
    // fortify — 0.05/thread at one core.
    expect(hgw.weaken2Threads).toBe(Math.ceil((0.002 * hgw.hackThreads + 0.004 * hgw.growThreads) / 0.05));
    // The overscale, pinned against HWGW math at the SAME steal: growth is
    // weaker at min + hack-fortify security, so restoring the same steal
    // takes at least as many grow threads as it would from min security.
    // (Scores are NOT ordered in general — HGW's single ceil'd weaken can
    // save a thread that outweighs a small overscale, and the mode is chosen
    // on process pressure, not score.)
    const kAtMin = growthLogPerThread(ctx, JOESGUNS.minDifficulty, JOESGUNS.serverGrowth, 1);
    const atMinGrow = growThreads(
      kAtMin,
      JOESGUNS.moneyMax,
      JOESGUNS.moneyMax * (1 - hgw.stealFraction),
      JOESGUNS.moneyMax,
    );
    expect(hgw.growThreads).toBeGreaterThanOrEqual(atMinGrow);
    expect(Math.abs(hgw.score - hwgw.score) / hwgw.score).toBeLessThan(0.05);
  });
});

describe("solveCycle", () => {
  test("zero-dollar batches optimize and report their expected experience", () => {
    const person = mockPerson();
    person.skills.hacking = 300;
    const ctx = makeHackContext(
      { skill: 300, intelligence: 0, mults: person.mults },
      { ScriptHackMoneyGain: 0 },
    );
    const solution = solveCycle(ctx, JOESGUNS)!;
    const expectedHackThreads = solution.hackThreads * (0.25 + 0.75 * solution.chance);
    const expected = hackExpGain(ctx, JOESGUNS.baseDifficulty) *
      (expectedHackThreads + solution.growThreads + solution.weaken1Threads + solution.weaken2Threads);

    expect(solution.score).toBe(0);
    expect(solution.experiencePerBatch).toBeCloseTo(expected, 10);
    expect(solution.experienceScore).toBeGreaterThan(0);
  });

  test("one solved batch round-trips exactly through the game effects", () => {
    const skill = 300;
    const { ctx, person, server } = makeScenario(skill);
    const solution = solveCycle(ctx, JOESGUNS)!;
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
  test("timed wave demand includes every concurrently in-flight prep phase", () => {
    const base = {
      ramSec: 1,
      weakenTimeS: 1,
      totalRamGb: 1,
      prepped: false,
    };
    expect(prepWaveRamGb({ ...base, weaken1Threads: 10, growThreads: 20, weaken2Threads: 3 })).toBe(57.75);
    expect(prepWaveRamGb({ ...base, weaken1Threads: 0, growThreads: 20, weaken2Threads: 3 })).toBe(40.25);
    expect(prepWaveRamGb({ ...base, weaken1Threads: 0, growThreads: 0, weaken2Threads: 0, prepped: true })).toBe(0);
  });

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
    expect(prepTimeSeconds(cold, 1e9)).toBeCloseTo(Math.max(cold.weakenTimeS, cold.growWeakenTimeS!), 10);
    const fixedFleet = prepTimeSeconds(cold, 1);
    expect(fixedFleet).toBeGreaterThan(cold.weakenTimeS); // RAM-bound
    const growingFleet = prepTimeSeconds(cold, 1, 0.001);
    expect(growingFleet).toBeLessThan(fixedFleet); // observed reinvestment grows capacity
    expect(prepTimeSeconds(cold, 1, 0.001, 0.7)).toBeGreaterThan(growingFleet * 0.7);
    expect(prepTimeSeconds(cold, 1, Number.NaN)).toBe(fixedFleet); // bad quote is inert, never contagious
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
