import { describe, expect, test } from "bun:test";
import { scenarioFingerprint } from "../scenario.ts";

describe("simulation scenario fingerprints", () => {
  test("ignore object insertion order but retain every experimental input", () => {
    const a = scenarioFingerprint({ seed: 1, world: { money: 1_000, ram: 8 } });
    const reordered = scenarioFingerprint({ world: { ram: 8, money: 1_000 }, seed: 1 });
    expect(reordered).toBe(a);
    expect(scenarioFingerprint({ seed: 2, world: { money: 1_000, ram: 8 } })).not.toBe(a);
    expect(scenarioFingerprint({ seed: 1, world: { money: 2_000, ram: 8 } })).not.toBe(a);
  });
});
