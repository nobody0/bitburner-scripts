import { describe, expect, test } from "bun:test";
import { gangRespectGain, gangWantedGain, gangWantedPenalty, type GangTaskStats } from "../shared/strategy/gang/formulas.ts";

const gang = { respect: 100, wantedLevel: 25, territory: 0.5 };
const member = { skills: { hack: 100, str: 100, def: 100, dex: 100, agi: 100, cha: 100 } };
const task = (over: Partial<GangTaskStats> = {}): GangTaskStats => ({
  name: "test", baseRespect: 0.001, baseWanted: 0.1, difficulty: 1,
  hackWeight: 0, strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25, chaWeight: 0,
  territory: { respect: 1, wanted: 1 }, ...over,
});

describe("pinned gang formulas", () => {
  test("wanted penalty is respect divided by respect plus wanted", () => {
    expect(gangWantedPenalty(gang)).toBe(0.8);
  });

  test("respect matches the upstream territory and softcap exponent", () => {
    const weight = 100 - 4;
    const territory = Math.max(0.005, Math.pow(50, 1) / 100);
    const expected = Math.pow(11 * 0.001 * weight * territory * 0.8, (0.2 * 0.5 + 0.8) * 0.9);
    expect(gangRespectGain(gang, member, task(), 0.9)).toBeCloseTo(expected, 12);
  });

  test("zero base and non-positive stat weight produce no respect", () => {
    expect(gangRespectGain(gang, member, task({ baseRespect: 0 }), 1)).toBe(0);
    expect(gangRespectGain(gang, { skills: { hack: 1, str: 1, def: 1, dex: 1, agi: 1, cha: 1 } }, task(), 1)).toBe(0);
  });

  test("vigilante wanted is negative and positive wanted is capped", () => {
    const vigilante = task({ baseWanted: -0.001 });
    expect(gangWantedGain(gang, member, vigilante)).toBeLessThan(0);
    const capped = task({ baseWanted: 1e12, difficulty: 28 });
    expect(gangWantedGain(gang, member, capped)).toBe(100);
  });
});
