import { describe, expect, test } from "bun:test";
import type { AugInfo, PriceContext } from "../shared/strategy/factions/augs.ts";
import {
  allocateResidualDonations,
  assignDonationSellers,
  selectDonationAwareBatch,
} from "../shared/strategy/factions/liquidation.ts";

const ctx: PriceContext = {
  queuedNonSoA: 0,
  ownedSoA: 0,
  neurofluxLevel: 0,
  sf11Level: 0,
  augMoneyCost: 1,
  augRepCost: 1,
};

function aug(name: string, cost: number, rep: number, factions = ["A"]): AugInfo {
  return { name, baseCost: cost, baseRepRequirement: rep, factions, prereqs: [], mults: { hacking: 1.01 } };
}

function standing(name: string, rep = 0, favor = 150) {
  return { name, joined: true, rep, favor };
}

describe("donation-aware final liquidation", () => {
  test("seller assignment minimizes the whole set and charges one highest target per faction", () => {
    const shared = aug("shared", 2e6, 1_000, ["A", "B"]);
    const onlyA = aug("only-a", 1e6, 1_000, ["A"]);
    const plan = assignDonationSellers({
      augs: [shared, onlyA],
      standings: [standing("A"), standing("B", 900)],
      favorToDonate: 150,
      factionRepMult: 1,
      factionWorkRepGain: 1,
      ctx,
    });
    expect(plan!.cost).toBe(1e9);
    expect(plan!.donations).toEqual([{ faction: "A", repTarget: 1_000, amount: 1e9 }]);
    expect(plan!.candidates.map((candidate) => candidate.faction)).toEqual(["A", "A"]);
  });

  test("required value is protected, then the funded set is bought dearest-first", () => {
    const required = aug("required", 500e6, 1_000);
    const optional = aug("optional", 1e6, 0);
    const catalog = new Map([[required.name, required], [optional.name, optional]]);
    const input = {
      valueOrder: [optional.name],
      required: [required.name],
      catalog,
      standings: [standing("A")],
      owned: new Set<string>(),
      ctx,
      favorToDonate: 150,
      factionRepMult: 1,
      factionWorkRepGain: 1,
    } as const;
    const requiredOnly = selectDonationAwareBatch({ ...input, money: 1.5e9 });
    expect(requiredOnly.requiredFunded).toBe(true);
    expect(requiredOnly.order.map((candidate) => candidate.name)).toEqual([required.name]);

    const plan = selectDonationAwareBatch({ ...input, money: 2e9 });
    expect(plan.order.map((candidate) => candidate.name)).toEqual([required.name, optional.name]);
  });
});

describe("pure favor liquidation", () => {
  test("spends the whole snapshot across useful factions and excludes locked ones", () => {
    const money = 25e9;
    const allocation = allocateResidualDonations({
      money,
      standings: [standing("A"), standing("B"), standing("locked", 0, 149)],
      favorToDonate: 150,
      factionRepMult: 1,
      factionWorkRepGain: 1,
      futureWorkSec: { A: 1_000, B: 1_000, locked: 10_000 },
    });
    expect(allocation).toHaveLength(2);
    expect(allocation.some((entry) => entry.faction === "locked")).toBe(false);
    expect(allocation.reduce((sum, entry) => sum + entry.amount, 0)).toBeCloseTo(money, 5);
  });

  test("zero-value ties send the remainder to the highest-current-reputation faction", () => {
    const allocation = allocateResidualDonations({
      money: 1e9,
      standings: [standing("A", 100), standing("B", 200)],
      favorToDonate: 150,
      factionRepMult: 1,
      factionWorkRepGain: 1,
      futureWorkSec: {},
    });
    expect(allocation).toHaveLength(1);
    expect(allocation[0]).toMatchObject({ faction: "B", amount: 1e9 });
  });
});
