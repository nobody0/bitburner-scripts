import { describe, expect, test } from "bun:test";
import {
  BITNODE_COUNT,
  DEFAULT_BITNODE_MULTIPLIERS,
  MULTIPLIER_FACETS,
  MULTIPLIER_GROUPS,
  bitNodeMultipliers,
  changedMultipliers,
} from "../shared/features/bitnode.ts";

/** The multiplier facets are editorial — which subsystem a field belongs to,
 * and which direction of change hurts the run. They are not transcribed from
 * the game, so `sim/tests/bitnode-parity.test.ts` cannot pin them. This does:
 * a vendor bump that introduces a multiplier must classify it, or the BitNode
 * panel silently files it under the fallback and colours it wrong. */

describe("bitnode multiplier facets", () => {
  test("every known multiplier is classified", () => {
    const unclassified = Object.keys(DEFAULT_BITNODE_MULTIPLIERS).filter((f) => MULTIPLIER_FACETS[f] === undefined);
    expect(unclassified).toEqual([]);
  });

  test("no facet names a field the game does not have", () => {
    const unknown = Object.keys(MULTIPLIER_FACETS).filter((f) => DEFAULT_BITNODE_MULTIPLIERS[f] === undefined);
    expect(unknown).toEqual([]);
  });

  test("every facet group is in the display order", () => {
    const groups = new Set(MULTIPLIER_GROUPS);
    const orphans = Object.entries(MULTIPLIER_FACETS)
      .filter(([, facet]) => !groups.has(facet.group))
      .map(([field]) => field);
    expect(orphans).toEqual([]);
  });

  test("a cost multiplier above 1.0 reads as harder, a gain multiplier below 1.0 too", () => {
    const changed = changedMultipliers({
      AugmentationMoneyCost: 1.5, // a cost: up is worse
      CrimeMoney: 0.5, // a gain: down is worse
      HacknetNodeMoney: 2, // a gain: up is better
      BladeburnerSkillCost: 0.5, // a cost: down is better
    });
    const byField = new Map(changed.map((c) => [c.field, c.harder]));
    expect(byField.get("AugmentationMoneyCost")).toBe(true);
    expect(byField.get("CrimeMoney")).toBe(true);
    expect(byField.get("HacknetNodeMoney")).toBe(false);
    expect(byField.get("BladeburnerSkillCost")).toBe(false);
  });

  test("BN1 changes nothing, and every other node classifies whatever it changes", () => {
    expect(changedMultipliers(bitNodeMultipliers(1))).toEqual([]);
    for (let n = 2; n <= BITNODE_COUNT; n++) {
      const changed = changedMultipliers(bitNodeMultipliers(n, 3));
      expect(changed.length, `BN${n} changed nothing`).toBeGreaterThan(0);
      for (const entry of changed) {
        expect(MULTIPLIER_GROUPS).toContain(entry.group);
      }
    }
  });
});
