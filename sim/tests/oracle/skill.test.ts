import { describe, expect, test } from "bun:test";
import { CONSTANTS } from "../../vendor/bitburner/src/Constants.ts";
import { calculateExp, calculateSkill } from "../../vendor/bitburner/src/PersonObjects/formulas/skill.ts";

// Ported from bitburner-src v3.0.1 test/jest/formulas/Skill.test.ts.
describe("calculateSkill (game oracle)", () => {
  test("correct inverse for skills 2..299", () => {
    for (let skill = 2; skill < 300; skill++) {
      const xp1 = calculateExp(skill);
      expect(calculateSkill(xp1)).toBe(skill);
      expect(calculateSkill(xp1 * 0.999999999)).toBe(skill - 1);

      const xp2 = calculateExp(skill, 1.4);
      expect(calculateSkill(xp2, 1.4)).toBe(skill);
      expect(calculateSkill(xp2 * 0.999999999, 1.4)).toBe(skill - 1);

      if (skill < 4) continue;
      const xp3 = calculateExp(skill, 3.3);
      expect(calculateSkill(xp3, 3.3)).toBe(skill);
      expect(calculateSkill(xp3 * 0.999999999, 3.3)).toBe(skill - 1);
    }
  });

  test("special cases", () => {
    if (CONSTANTS.isDevBranch) {
      expect(() => calculateExp(NaN)).toThrow();
    } else {
      expect(calculateExp(NaN)).toBe(0);
    }
    expect(calculateExp(Infinity)).toBe(Number.MAX_VALUE);
    expect(calculateExp(-Infinity)).toBe(0);

    expect(calculateSkill(calculateExp(0))).toBe(1);
    expect(calculateSkill(calculateExp(0, 1.4), 1.4)).toBe(1);
    expect(calculateSkill(calculateExp(0, 3.3), 3.3)).toBe(3);
    expect(calculateSkill(calculateExp(1))).toBe(1);
    expect(calculateSkill(calculateExp(1, 1.4), 1.4)).toBe(1);
    expect(calculateSkill(calculateExp(1, 3.3), 3.3)).toBe(3);
  });
});
