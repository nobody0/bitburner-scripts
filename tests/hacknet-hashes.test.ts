import { describe, expect, test } from "bun:test";
import { HASH_UPGRADE, stepHashes } from "../shared/strategy/hacknet/hashes.ts";

const quotes = [
  { name: HASH_UPGRADE.money, level: 0, cost: 4 },
  { name: HASH_UPGRADE.maxMoney, level: 0, cost: 50 },
  { name: HASH_UPGRADE.bladeRank, level: 0, cost: 250 },
];

describe("goal-aware hash spending", () => {
  test("an economic target mutation must beat selling the same hashes", () => {
    const weak = stepHashes({
      current: 100,
      capacity: 1_000,
      productionPerSec: 1,
      upgrades: quotes,
      goals: [{ name: HASH_UPGRADE.maxMoney, target: "omega-net", priority: 30, valueDollars: 1_000, why: "farm" }],
    });
    expect(weak.spend?.name).toBe(HASH_UPGRADE.money);
    expect(weak.ranked[0]).toMatchObject({ name: HASH_UPGRADE.maxMoney, eligible: false, netDollars: -12_499_000 });

    const strong = stepHashes({
      current: 100,
      capacity: 1_000,
      productionPerSec: 1,
      upgrades: quotes,
      goals: [{ name: HASH_UPGRADE.maxMoney, target: "omega-net", priority: 30, valueDollars: 20_000_000, why: "farm" }],
    });
    expect(strong.spend?.name).toBe(HASH_UPGRADE.maxMoney);
  });

  test("reserves for an active goal instead of cashing out", () => {
    const decision = stepHashes({
      current: 100,
      capacity: 1_000,
      productionPerSec: 1,
      upgrades: quotes,
      goals: [{ name: HASH_UPGRADE.bladeRank, priority: 90, why: "rank blocks the route" }],
    });
    expect(decision.spend).toBeUndefined();
    expect(decision.reserve?.name).toBe(HASH_UPGRADE.bladeRank);
  });

  test("requests cache capacity when a goal can never fit", () => {
    const decision = stepHashes({
      current: 64,
      capacity: 64,
      productionPerSec: 1,
      upgrades: quotes,
      goals: [{ name: HASH_UPGRADE.bladeRank, priority: 90, why: "rank blocks the route" }],
    });
    expect(decision.capacityTarget).toBe(250);
  });

  test("observed availability is authoritative", () => {
    const decision = stepHashes({
      current: 100,
      capacity: 100,
      productionPerSec: 1,
      upgrades: [{ name: HASH_UPGRADE.money, level: 0, cost: 4 }],
      goals: [{ name: HASH_UPGRADE.bladeRank, priority: 99, why: "locked action" }],
    });
    expect(decision.spend?.name).toBe(HASH_UPGRADE.money);
  });
});
