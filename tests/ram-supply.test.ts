import { describe, expect, test } from "bun:test";
import {
  RAM_COST_CONSTANTS,
  cheapestRamSupply,
  cloudServerCost,
  marginalCostPerGb,
  roundedRamPurchase,
} from "../shared/strategy/ram-supply.ts";

describe("RAM supply", () => {
  test("home follows the exact doubling formula", () => {
    const quote = marginalCostPerGb("home", {
      home: { currentRam: 8, costMultiplier: 1 },
    })!;
    expect(quote.addedRam).toBe(8);
    expect(quote.cost).toBe(
      8 * RAM_COST_CONSTANTS.BaseCostFor1GBOfRamHome * Math.pow(1.58, 3),
    );
    expect(quote.costPerGb).toBeCloseTo(126_000, -3);
  });

  test("64 GB is derived as the largest unsoftcapped cloud purchase", () => {
    const quote = marginalCostPerGb("cloud", {
      cloud: { costMultiplier: 1, softcap: 1.3, maxRam: 2 ** 20, slotsAvailable: 1, servers: [] },
    })!;
    expect(quote.kind).toBe("buyServer");
    expect(quote.targetRam).toBe(2 ** 6);
    expect(quote.costPerGb).toBe(RAM_COST_CONSTANTS.BaseCostFor1GBOfRamServer);
    expect(quote.availableGb).toBe(64 * 1);
  });

  test("execution rounds a continuous allocation down to a purchasable rung", () => {
    const state = {
      cloud: { costMultiplier: 1, softcap: 1.1, maxRam: 1024, slotsAvailable: 25, servers: [] },
    };
    expect(roundedRamPurchase("cloud", state, 100_000)).toBeUndefined();
    expect(roundedRamPurchase("cloud", state, 110_000)).toMatchObject({ targetRam: 2, cost: 110_000 });
    expect(roundedRamPurchase("cloud", state, 1_000_000)).toMatchObject({ targetRam: 16, cost: 880_000 });
  });

  test("a neutral softcap still selects the derived zero-exponent frontier", () => {
    const quote = marginalCostPerGb("cloud", {
      cloud: { costMultiplier: 2, softcap: 1, maxRam: 1024, slotsAvailable: 1, servers: [] },
    })!;
    expect(quote.targetRam).toBe(64);
    expect(quote.costPerGb).toBe(2 * RAM_COST_CONSTANTS.BaseCostFor1GBOfRamServer);
  });

  test("BitNode multipliers choose supply without a node-specific branch", () => {
    const state = {
      home: { currentRam: 8, costMultiplier: 0.1 },
      cloud: { costMultiplier: 4, softcap: 2, maxRam: 1024, slotsAvailable: 1, servers: [] },
    };
    expect(cheapestRamSupply(state)?.source).toBe("home");
  });

  test("upgrade marginal is the difference of exact total costs", () => {
    const quote = marginalCostPerGb("cloud", {
      cloud: {
        costMultiplier: 1,
        softcap: 1.3,
        maxRam: 1024,
        slotsAvailable: 0,
        servers: [{ host: "pserv-0", ram: 32 }],
      },
    })!;
    expect(quote.targetRam).toBe(64);
    expect(quote.cost).toBe(cloudServerCost(64, 1, 1.3) - cloudServerCost(32, 1, 1.3));
  });
});
