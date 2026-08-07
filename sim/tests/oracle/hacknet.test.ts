import { describe, expect, it } from "bun:test";
import { HacknetNodeConstants, HacknetServerConstants } from "../../vendor/bitburner/src/Hacknet/data/Constants.ts";
import {
  calculateCoreUpgradeCost as coreCostNode,
  calculateLevelUpgradeCost as levelCostNode,
  calculateRamUpgradeCost as ramCostNode,
} from "../../vendor/bitburner/src/Hacknet/formulas/HacknetNodes.ts";
import {
  calculateCoreUpgradeCost as coreCostServer,
  calculateLevelUpgradeCost as levelCostServer,
  calculateRamUpgradeCost as ramCostServer,
} from "../../vendor/bitburner/src/Hacknet/formulas/HacknetServers.ts";

// Ported from bitburner-src v3.0.1 test/jest/Hacknet.test.ts (limit checks).
describe("HacknetNode calculations (game oracle)", () => {
  it("level cost applies limits", () => {
    expect(levelCostNode(1, NaN, 1)).toBe(0);
    expect(levelCostNode(1, -1, 1)).toBe(0);
    expect(levelCostNode(1, 0, 1)).toBe(0);
    expect(levelCostNode(1, 1, 1)).toBeGreaterThan(0);
    expect(levelCostNode(1, 0.4, 1)).toBe(0);
    expect(levelCostNode(1, 0.5, 1)).toBeGreaterThan(0);
    expect(levelCostNode(HacknetNodeConstants.MaxLevel, 1, 1)).toBe(Infinity);
    expect(levelCostNode(HacknetNodeConstants.MaxLevel + 1, 1, 1)).toBe(Infinity);
    expect(levelCostNode(HacknetNodeConstants.MaxLevel - 1, 1, 1)).toBeGreaterThan(0);
    expect(levelCostNode(HacknetNodeConstants.MaxLevel - 2, 5, 1)).toBe(Infinity);
  });

  it("ram cost applies limits", () => {
    expect(ramCostNode(1, NaN, 1)).toBe(0);
    expect(ramCostNode(1, 0, 1)).toBe(0);
    expect(ramCostNode(HacknetNodeConstants.MaxRam, 1, 1)).toBe(Infinity);
    expect(ramCostNode(HacknetNodeConstants.MaxRam - 1, 1, 1)).toBeGreaterThan(0);
  });

  it("core cost applies limits", () => {
    expect(coreCostNode(1, NaN, 1)).toBe(0);
    expect(coreCostNode(1, 0, 1)).toBe(0);
    expect(coreCostNode(HacknetNodeConstants.MaxCores, 1, 1)).toBe(Infinity);
    expect(coreCostNode(HacknetNodeConstants.MaxCores - 1, 1, 1)).toBeGreaterThan(0);
  });
});

describe("HacknetServer calculations (game oracle)", () => {
  it("cost functions apply limits", () => {
    expect(levelCostServer(1, 0, 1)).toBe(0);
    expect(levelCostServer(HacknetServerConstants.MaxLevel, 1, 1)).toBe(Infinity);
    expect(levelCostServer(HacknetServerConstants.MaxLevel - 1, 1, 1)).toBeGreaterThan(0);
    expect(ramCostServer(HacknetServerConstants.MaxRam, 1, 1)).toBe(Infinity);
    expect(coreCostServer(HacknetServerConstants.MaxCores, 1, 1)).toBe(Infinity);
  });
});
