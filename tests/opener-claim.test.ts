import { describe, expect, test } from "bun:test";
import { hackingModule } from "../game/lib/features/hacking.ts";
import { postNeeds } from "../shared/strategy/needs.ts";

describe("economic opener claim", () => {
  test("posts the modeled next program as an income-investment step", () => {
    const claims = hackingModule.claims!({
      now: 1_000,
      activeFeatures: new Set(["hacking"]),
      board: postNeeds([]),
      horizons: {
        node: { state: "unknown", evaluatedAt: 1_000, nextRecalibrationAt: 2_000, basis: "test", reason: "test" },
        install: { state: "unknown", evaluatedAt: 1_000, nextRecalibrationAt: 2_000, basis: "test", reason: "test" },
      },
      caps: {},
      state: {
        topics: {
          player: { skills: { hacking: 100, intelligence: 0 } },
          fleet: {
            rootedHosts: 1,
            totalHosts: 2,
            maxRam: 8,
            usedRam: 0,
            purchased: { count: 0, totalRam: 0 },
            portOpeners: 0,
            home: { maxRam: 8, usedRam: 0, cores: 1 },
            openerPlan: {
              program: "BruteSSH.exe",
              targetOpeners: 1,
              cost: 700_000,
              addedMoneyPerSec: 3_000,
              addedHackingExpPerSec: 2,
            },
          },
        },
      },
    } as never);

    expect(claims).toContainEqual(expect.objectContaining({
      by: "hacking",
      id: "opener-investment:BruteSSH.exe",
      resource: "money",
      amount: 700_000,
      shape: "step",
      pricing: "economic",
      returnPerDollarSec: 3_000 / 700_000,
    }));
  });
});
