import { describe, expect, test } from "bun:test";
import {
  countClosureAffordable,
  countSlotValueFor,
  fundedActivationBatch,
  routeCountVerdict,
} from "../shared/strategy/progression/activation.ts";
import { NEUROFLUX, totalCost, weightsFromMarginals, type PriceContext } from "../shared/strategy/factions/augs.ts";
import { AUGMENTATIONS } from "../shared/features/augmentations.ts";

/** A measured route: reputation binds, hacking is the climb behind it. */
const WORTH = new Map([["money", 1_000], ["hacking", 19_174], ["reputation", 49_505]]);

const CTX: PriceContext = {
  queuedNonSoA: 0,
  ownedSoA: 0,
  neurofluxLevel: 0,
  sf11Level: 0,
  augMoneyCost: 1,
  augRepCost: 1,
};

const BITWIRE = "BitWire";
const SYNAPTIC = "Artificial Synaptic Potentiation";
const CSP1 = "Cranial Signal Processors - Gen I";
const CSP2 = "Cranial Signal Processors - Gen II";

const REP_MET = {
  standings: [{ name: "NiteSec", joined: true, rep: Infinity, favor: 0 }],
  favorToDonate: 150,
  factionRepMult: 1,
  factionWorkRepGain: 1,
};

describe("reset-activated bankroll value", () => {
  test("the funded set ranks by value per dollar and pays the escalated queue price", () => {
    const names = [BITWIRE, SYNAPTIC, CSP1];
    const weights = weightsFromMarginals(WORTH);

    const first = fundedActivationBatch({
      realizable: names,
      owned: new Set(),
      weights,
      countSlotValue: 0,
      ctx: CTX,
      money: AUGMENTATIONS[BITWIRE]!.cost,
      donation: REP_MET,
    });

    expect(first.map((candidate) => candidate.name)).toEqual([BITWIRE]);

    const sticker = names.reduce((sum, name) => sum + AUGMENTATIONS[name]!.cost, 0);
    const money = sticker * 1.2;
    const batch = fundedActivationBatch({
      realizable: names,
      owned: new Set(),
      weights: weightsFromMarginals(WORTH),
      countSlotValue: 0,
      ctx: CTX,
      money,
      donation: REP_MET,
    });

    // Comfortably over the sticker sum, but the second and later purchases pay
    // 1.9^n — so the honest funded set is a strict subset, and it fits.
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(names.length);
    expect(totalCost(batch, CTX)).toBeLessThanOrEqual(money);
  });

  test("a seller must be joined and either rep-met or donation-enabled, with the donation inside the budget", () => {
    const aug = AUGMENTATIONS[BITWIRE]!;
    const exact = aug.cost + aug.rep * 1e6;
    const base = {
      realizable: [BITWIRE],
      owned: new Set<string>(),
      weights: weightsFromMarginals(WORTH),
      countSlotValue: 0,
      ctx: CTX,
      money: exact,
    };
    expect(fundedActivationBatch({
      ...base,
      donation: { ...REP_MET, standings: [{ name: "CyberSec", joined: false, rep: Infinity, favor: 150 }] },
    })).toHaveLength(0);
    expect(fundedActivationBatch({
      ...base,
      donation: { ...REP_MET, standings: [{ name: "CyberSec", joined: true, rep: 0, favor: 149 }] },
    })).toHaveLength(0);
    const eligible = { ...REP_MET, standings: [{ name: "CyberSec", joined: true, rep: 0, favor: 150 }] };
    expect(fundedActivationBatch({ ...base, donation: eligible }).map((candidate) => candidate.name)).toEqual([BITWIRE]);
    const closesCount = (money: number) => countClosureAffordable({
      realizable: [BITWIRE],
      owned: new Set(),
      wanted: 1,
      neurofluxCountable: false,
      ctx: CTX,
      money,
      donation: eligible,
    });
    expect(closesCount(exact)).toBe(true);
    expect(closesCount(exact - 1)).toBe(false);
  });

  test("the first countable NeuroFlux level can fill one funded route slot", () => {
    const base = {
      realizable: [NEUROFLUX],
      owned: new Set<string>(),
      weights: weightsFromMarginals(WORTH),
      countSlotValue: 1,
      ctx: CTX,
      money: 1e12,
      donation: REP_MET,
    };

    // Off a finite-count route NFG remains excluded from the one-shot value
    // search. On that route its first level is one permanent distinct name.
    expect(fundedActivationBatch(base)).toHaveLength(0);
    expect(fundedActivationBatch({ ...base, neurofluxCountable: true }))
      .toMatchObject([{ name: NEUROFLUX }]);
  });

  test("the count closure answers on the escalated price of the whole set", () => {
    const names = [BITWIRE, SYNAPTIC];
    const exact = AUGMENTATIONS[SYNAPTIC]!.cost + AUGMENTATIONS[BITWIRE]!.cost * 1.9;
    const ask = (money: number): boolean => countClosureAffordable({
      realizable: names,
      owned: new Set(),
      wanted: 2,
      neurofluxCountable: true,
      ctx: CTX,
      money,
      donation: REP_MET,
    });

    expect(ask(exact)).toBe(true);
    expect(ask(exact * 0.99)).toBe(false);
    // The sticker sum would have said yes; the escalation is what makes it no.
    expect(AUGMENTATIONS[SYNAPTIC]!.cost + AUGMENTATIONS[BITWIRE]!.cost).toBeLessThan(exact);
  });

  test("a prerequisite chain fills its slots together, and an unreachable one fills none", () => {
    const chain = [CSP1, CSP2];
    // The prerequisite has to be bought FIRST, so — unlike an unordered pair —
    // the dependant is the one that pays the escalated slot.
    const chainCost = AUGMENTATIONS[CSP1]!.cost + AUGMENTATIONS[CSP2]!.cost * 1.9;

    expect(countClosureAffordable({
      realizable: chain,
      owned: new Set(),
      wanted: 2,
      neurofluxCountable: true,
      ctx: CTX,
      money: chainCost,
      donation: REP_MET,
    })).toBe(true);

    // Gen II alone cannot be transacted: its prerequisite is not purchasable
    // this sweep, so it is not a cheaper way to fill the slot at any price.
    expect(countClosureAffordable({
      realizable: [CSP2],
      owned: new Set(),
      wanted: 1,
      neurofluxCountable: true,
      ctx: CTX,
      money: 1e12,
      donation: REP_MET,
    })).toBe(false);

    // With the prerequisite already owned it is reachable again.
    expect(countClosureAffordable({
      realizable: [CSP2],
      owned: new Set([CSP1]),
      wanted: 1,
      neurofluxCountable: true,
      ctx: CTX,
      money: 1e12,
      donation: REP_MET,
    })).toBe(true);
  });

  test("the count verdict switches from the tranche rule to route policy at consolidation", () => {
    // Before consolidation (installed < required/3) the target-relative
    // tranche rule decides, whatever the route's optional-install policy says.
    const early = routeCountVerdict({
      required: 30,
      installed: 3,
      affordableDistinct: 9,
      consolidationAllowed: false,
      worth: new Map([["augmentations", 30_000]]),
    });
    expect(early.ready).toBe(true);
    expect(early.value).toBeGreaterThan(0);

    const earlyThin = routeCountVerdict({
      required: 30,
      installed: 3,
      // One augmentation is the reset the early tranche exists to reject.
      affordableDistinct: 1,
      consolidationAllowed: true,
    });
    expect(earlyThin.ready).toBe(false);
    expect(earlyThin.value).toBe(0);

    // Once consolidating, the route's own policy is the guard.
    expect(routeCountVerdict({
      required: 30,
      installed: 20,
      affordableDistinct: 1,
      consolidationAllowed: true,
    }).ready).toBe(true);
    expect(routeCountVerdict({
      required: 30,
      installed: 20,
      affordableDistinct: 10,
      consolidationAllowed: false,
    }).ready).toBe(false);

    // A closed gate never needs another count-driven reset to open it.
    expect(routeCountVerdict({
      required: 30,
      installed: 30,
      affordableDistinct: 0,
      consolidationAllowed: false,
    }).ready).toBe(true);
  });

  test("count slot value exists only on a finite-count route", () => {
    const worth = new Map([["augmentations", 30_000]]);
    expect(countSlotValueFor(worth, Infinity, 12)).toBe(0);
    expect(countSlotValueFor(worth, 30, 29)).toBeGreaterThan(0);
    // ...and rises toward closure: the last slot unblocks the whole gate.
    expect(countSlotValueFor(worth, 30, 29)).toBeGreaterThan(countSlotValueFor(worth, 30, 0));
  });
});
