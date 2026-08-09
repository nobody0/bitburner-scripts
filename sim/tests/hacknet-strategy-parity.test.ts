import { describe, expect, test } from "bun:test";
import { freshProduction, productionDelta } from "../../shared/strategy/hacknet/formulas.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { replaceCurrentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { calculateMoneyGainRate } from "../vendor/bitburner/src/Hacknet/formulas/HacknetNodes.ts";
import { calculateHashGainRate } from "../vendor/bitburner/src/Hacknet/formulas/HacknetServers.ts";

describe("shared Hacknet production shapes match the pinned game", () => {
  test("fresh nodes and servers", () => {
    replaceCurrentNodeMults(getBitNodeMultipliers(1, 1));
    expect(freshProduction(false, 1.7, 1)).toBe(calculateMoneyGainRate(1, 1, 1, 1.7));
    expect(freshProduction(true, 1.7, 1)).toBe(calculateHashGainRate(1, 0, 1, 1, 1.7));
  });

  test("one-step node deltas", () => {
    replaceCurrentNodeMults(getBitNodeMultipliers(1, 1));
    const level = 37, ram = 8, cores = 5, mult = 1.4;
    const production = calculateMoneyGainRate(level, ram, cores, mult);
    const node = { level, ram, cores, production };
    expect(productionDelta(node, "level", false)).toBeCloseTo(calculateMoneyGainRate(level + 1, ram, cores, mult) - production, 10);
    expect(productionDelta(node, "ram", false)).toBeCloseTo(calculateMoneyGainRate(level, ram * 2, cores, mult) - production, 10);
    expect(productionDelta(node, "core", false)).toBeCloseTo(calculateMoneyGainRate(level, ram, cores + 1, mult) - production, 10);
  });

  test("one-step server deltas include occupied RAM", () => {
    replaceCurrentNodeMults(getBitNodeMultipliers(9, 1));
    const level = 51, ram = 16, ramUsed = 5, cores = 7, mult = 1.3;
    const production = calculateHashGainRate(level, ramUsed, ram, cores, mult);
    const node = { level, ram, ramUsed, cores, production };
    expect(productionDelta(node, "level", true)).toBeCloseTo(calculateHashGainRate(level + 1, ramUsed, ram, cores, mult) - production, 10);
    expect(productionDelta(node, "ram", true)).toBeCloseTo(calculateHashGainRate(level, ramUsed, ram * 2, cores, mult) - production, 10);
    expect(productionDelta(node, "core", true)).toBeCloseTo(calculateHashGainRate(level, ramUsed, ram, cores + 1, mult) - production, 10);
  });
});
