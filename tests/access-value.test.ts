import { describe, expect, test } from "bun:test";
import { hackTimeSeconds, makeHackContext, expForSkill } from "../shared/formulas.ts";
import {
  backdoorCostSeconds,
  companyBackdoorSavedSeconds,
  COMPANY_REQUIRED_REP_MULTIPLIER,
  factionGateSavedSeconds,
  NOMINAL_COMPANY_REP_PER_SEC,
  NOMINAL_SEC_PER_SKILL,
  NOMINAL_VALUE_SEC_PER_WEIGHT,
  rankingValueSec,
  trainingBackdoorSavedRate,
} from "../shared/strategy/access/value.ts";

const PLAYER = {
  skill: 200,
  intelligence: 0,
  mults: { hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1 },
};

describe("backdoorCostSeconds", () => {
  test("actionSec is hackTime/4 when the skill requirement is already met", () => {
    const ctx = makeHackContext(PLAYER);
    const cost = backdoorCostSeconds({
      requiredHackingSkill: 60,
      hackDifficulty: 8,
      ctx,
      hackingExp: expForSkill(200),
      hackingSkillMult: 1,
      expPerSec: 100,
    });
    expect(cost.actionSec).toBe(hackTimeSeconds(ctx, 8, 60) / 4);
    expect(cost.skillWaitSec).toBe(0);
    expect(cost.totalSec).toBe(cost.actionSec);
  });

  test("below the requirement, the install is priced at the requirement's skill, not the current one", () => {
    const ctx = makeHackContext(PLAYER);
    const atRequirement = makeHackContext({ ...PLAYER, skill: 505 });
    const cost = backdoorCostSeconds({
      requiredHackingSkill: 505,
      hackDifficulty: 50,
      ctx,
      hackingExp: expForSkill(200),
      hackingSkillMult: 1,
      expPerSec: 100,
    });
    // The action cannot start before the requirement is met, so its duration
    // is the (shorter) one at the required skill — pricing it at the current
    // 200 would double-count the gap skillWaitSec already covers.
    expect(cost.actionSec).toBeCloseTo(hackTimeSeconds(atRequirement, 50, 505) / 4, 9);
    expect(cost.actionSec).toBeLessThan(hackTimeSeconds(ctx, 50, 505) / 4);
  });

  test("skill wait uses the measured exp rate, and the nominal constant when unmeasured", () => {
    const ctx = makeHackContext(PLAYER);
    const exp = expForSkill(200);
    const expGap = expForSkill(505) - exp;
    const measured = backdoorCostSeconds({
      requiredHackingSkill: 505,
      hackDifficulty: 50,
      ctx,
      hackingExp: exp,
      hackingSkillMult: 1,
      expPerSec: 1_000,
    });
    expect(measured.skillWaitSec).toBeCloseTo(expGap / 1_000, 6);
    const unmeasured = backdoorCostSeconds({
      requiredHackingSkill: 505,
      hackDifficulty: 50,
      ctx,
      hackingExp: exp,
      hackingSkillMult: 1,
    });
    expect(unmeasured.skillWaitSec).toBe((505 - 200) * NOMINAL_SEC_PER_SKILL);
    expect(Number.isFinite(measured.totalSec)).toBe(true);
    expect(Number.isFinite(unmeasured.totalSec)).toBe(true);
  });
});

describe("companyBackdoorSavedSeconds", () => {
  test("saves the 25% discount's grinding time at the nominal rate when unmeasured", () => {
    const saved = companyBackdoorSavedSeconds({ repTarget: 400_000, repHave: 0 });
    expect(saved).toBe((400_000 * (1 - COMPANY_REQUIRED_REP_MULTIPLIER)) / NOMINAL_COMPANY_REP_PER_SEC);
  });

  test("uses the measured rep rate when available", () => {
    const saved = companyBackdoorSavedSeconds({ repTarget: 400_000, repHave: 0, repPerSec: 50 });
    expect(saved).toBe(100_000 / 50);
  });

  test("past the discounted target, the backdoor saves the whole remaining grind", () => {
    // 320k of 400k held: the 0.75x target (300k) is already exceeded, so the
    // backdoor completes the requirement by itself.
    const saved = companyBackdoorSavedSeconds({ repTarget: 400_000, repHave: 320_000, repPerSec: 50 });
    expect(saved).toBe((400_000 - 320_000) / 50);
  });

  test("a satisfied requirement saves nothing", () => {
    expect(companyBackdoorSavedSeconds({ repTarget: 400_000, repHave: 500_000, repPerSec: 50 })).toBe(0);
  });

  test("monotonically non-increasing in reputation held", () => {
    let previous = Infinity;
    for (const have of [0, 100_000, 299_999, 300_000, 350_000, 400_000]) {
      const saved = companyBackdoorSavedSeconds({ repTarget: 400_000, repHave: have, repPerSec: 25 });
      expect(saved).toBeGreaterThanOrEqual(0);
      expect(saved).toBeLessThanOrEqual(previous);
      previous = saved;
    }
  });
});

describe("trainingBackdoorSavedRate", () => {
  test("is the 10% discount off the current drain", () => {
    expect(trainingBackdoorSavedRate(2_400)).toBeCloseTo(240, 9);
    expect(trainingBackdoorSavedRate(0)).toBe(0);
    expect(trainingBackdoorSavedRate(-5)).toBe(0);
  });
});

describe("factionGateSavedSeconds", () => {
  test("the last blocker of a faction is worth the whole remaining horizon", () => {
    expect(factionGateSavedSeconds({ horizonSec: 3_600, otherBlockersSec: 0 })).toBe(3_600);
  });

  test("other unmet blockers reduce the gate's value, floored at zero", () => {
    expect(factionGateSavedSeconds({ horizonSec: 3_600, otherBlockersSec: 600 })).toBe(3_000);
    expect(factionGateSavedSeconds({ horizonSec: 3_600, otherBlockersSec: 10_000 })).toBe(0);
  });
});

describe("rankingValueSec", () => {
  test("passes a measured value through and falls back to the weight scale", () => {
    expect(rankingValueSec({ weight: 5, valueSec: 1234 })).toBe(1234);
    expect(rankingValueSec({ weight: 5 })).toBe(5 * NOMINAL_VALUE_SEC_PER_WEIGHT);
  });
});
