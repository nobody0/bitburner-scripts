import { describe, expect, test } from "bun:test";
import {
  initEvaluator,
  projectedRuntimeSecondsPerExp,
  skillGateRuntimeSecondsPerExp,
  stepEvaluator,
  type FleetCapacity,
} from "../shared/strategy/evaluator.ts";
import type { ServerView, WorldView } from "../shared/world.ts";

const mults = {
  hacking: 1,
  hacking_exp: 1,
  hacking_money: 1,
  hacking_grow: 1,
  hacking_speed: 1,
  hacking_chance: 1,
};

function server(
  hostname: string,
  statics: Pick<ServerView, "minDifficulty" | "baseDifficulty" | "moneyMax" | "requiredHackingSkill" | "serverGrowth">,
  prepped: boolean,
): ServerView {
  return {
    hostname,
    hasAdminRights: true,
    purchasedByPlayer: false,
    moneyAvailable: prepped ? statics.moneyMax : statics.moneyMax * 0.1,
    hackDifficulty: prepped ? statics.minDifficulty : statics.baseDifficulty,
    numOpenPortsRequired: 0,
    maxRam: 64,
    usedRam: 0,
    cpuCores: 1,
    ...statics,
  };
}

const targets = [
  server("easy", { minDifficulty: 1, baseDifficulty: 3, moneyMax: 1e6, requiredHackingSkill: 1, serverGrowth: 100 }, true),
  server("hard", { minDifficulty: 20, baseDifficulty: 80, moneyMax: 1e9, requiredHackingSkill: 200, serverGrowth: 50 }, true),
  // This cold target has the best expected exp rate for this fleet/context.
  // Keeping it last ensures an insertion-order zero-score fallback would pick
  // `easy`, not accidentally satisfy the assertion.
  server("mid", { minDifficulty: 5, baseDifficulty: 40, moneyMax: 1e8, requiredHackingSkill: 50, serverGrowth: 60 }, false),
];

const capacity: FleetCapacity = {
  fleetGb: 256,
  largestBlockGb: 128,
  hostBlocksGb: [128, 64, 32, 16],
};

function view(stockInfluence?: WorldView["stockInfluence"]): WorldView {
  return {
    time: 0,
    player: {
      money: 1e9,
      hackingSkill: 500,
      hackingExp: 1e9,
      intelligence: 0,
      mults,
    },
    servers: targets.map((target) => ({ ...target })),
    prices: { upgradeHomeRam: Infinity, cloudServer: {}, cloudServerLimit: 0 },
    nodeMults: { ScriptHackMoneyGain: 0, ScriptHackMoney: 0.3, ServerGrowthRate: 0.05 },
    ...(stockInfluence ? { stockInfluence } : {}),
  };
}

describe("zero-income hacking fallback", () => {
  test("prepares the best expected experience farm instead of using insertion order", () => {
    const { directive, memory } = stepEvaluator(view(), initEvaluator(), capacity, Infinity);

    expect(directive.farm?.host).toBe("mid");
    expect(targets.find((target) => target.hostname === directive.farm?.host)?.moneyAvailable)
      .toBeLessThan(targets.find((target) => target.hostname === directive.farm?.host)!.moneyMax);
    expect(directive.prep).toBeUndefined();
    expect(directive.segments).toEqual([
      { kind: "farm", gb: 256 },
      { kind: "prep", gb: 0 },
      { kind: "share", gb: 0 },
    ]);

    const easy = memory.entries.get("easy")!.solution!;
    const mid = memory.entries.get("mid")!.solution!;
    expect(easy.score).toBe(0);
    expect(mid.score).toBe(0);
    expect(mid.experienceScore).toBeGreaterThan(easy.experienceScore);
    expect(mid.experiencePerBatch).toBeGreaterThan(0);
  });

  test("any profitable stock manipulation remains ahead of experience", () => {
    const { directive } = stepEvaluator(
      view({ easy: { sym: "EZY", side: "long", valuePerOp: 1e9 } }),
      initEvaluator(),
      capacity,
      Infinity,
    );

    expect(directive.farm?.host).toBe("easy");
    expect(directive.farm?.solution.stockIncomePerBatch).toBeGreaterThan(0);
  });
});

describe("experience runtime utility", () => {
  test("values faster future income over both live horizons and finite sim goals", () => {
    expect(projectedRuntimeSecondsPerExp(100, 125, 1_000, 3_600)).toBeCloseTo(0.72, 12);
    expect(projectedRuntimeSecondsPerExp(100, 125, 1_000, 3_600, 10_000)).toBeCloseTo(0.02, 12);
    expect(projectedRuntimeSecondsPerExp(100, 100, 1_000, 3_600)).toBe(0);
  });

  test("values experience that directly closes a posted route skill gate", () => {
    const currentExp = 1_000;
    const value = skillGateRuntimeSecondsPerExp(currentExp, 1, 2_500, 14_400);
    expect(value).toBeGreaterThan(0);
    expect(skillGateRuntimeSecondsPerExp(currentExp, 1, 1, 14_400)).toBe(0);
    expect(skillGateRuntimeSecondsPerExp(currentExp, 1, 2_500, 7_200)).toBeCloseTo(value / 2, 12);
  });

  test("the route skill-gate term stays commensurate with the income ratio", () => {
    // The fleet's own best exp rate is the normaliser, so the term a target
    // contributes (`expRate * secondsPerExp`) can never exceed 1 — the income
    // ratio's own maximum — however close the gate is.
    for (const targetSkill of [200, 500, 1_500, 2_500]) {
      for (const bestExpPerSec of [1, 50, 5_000]) {
        const perExp = skillGateRuntimeSecondsPerExp(1_000, 1, targetSkill, 14_400, bestExpPerSec);
        expect(bestExpPerSec * perExp).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
    // Beyond the horizon the bound is inactive: the unbounded form is already
    // the right answer there, so nothing about the far-gate case changes.
    const far = skillGateRuntimeSecondsPerExp(1_000, 1, 2_500, 14_400, 1e-6);
    expect(far).toBeCloseTo(skillGateRuntimeSecondsPerExp(1_000, 1, 2_500, 14_400), 12);
  });
});
