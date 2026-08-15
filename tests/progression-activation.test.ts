import { describe, expect, test } from "bun:test";
import {
  activationCatalog,
  countClosureAffordable,
  countSlotValueFor,
  fundedActivationBatch,
  routeCountVerdict,
  type ActivationOffer,
} from "../shared/strategy/progression/activation.ts";
import { defaultWeights, NEUROFLUX, scoreAug, totalCost, type PriceContext } from "../shared/strategy/factions/augs.ts";
import { AUGMENTATIONS } from "../shared/features/augmentations.ts";

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

/** Every listed augmentation on offer from a joined faction at met rep. */
function offersFor(names: readonly string[], faction = "CyberSec"): ActivationOffer[] {
  return names.map((name) => ({ name, faction, affordableRep: true }));
}

describe("reset-activated bankroll value", () => {
  test("the funded set starts with the highest augmentation value per dollar", () => {
    const names = [BITWIRE, SYNAPTIC, CSP1];
    const weights = defaultWeights();
    const ranked = [...activationCatalog(names).values()].sort((a, b) =>
      a.baseCost / Math.max(1e-9, scoreAug(a, weights))
      - b.baseCost / Math.max(1e-9, scoreAug(b, weights)),
    );
    const best = ranked[0]!;

    const batch = fundedActivationBatch({
      realizable: names,
      offers: offersFor(names),
      joined: new Set(["CyberSec"]),
      owned: new Set(),
      weights,
      countSlotValue: 0,
      ctx: CTX,
      money: best.baseCost,
    });

    expect(batch.map((candidate) => candidate.name)).toEqual([best.name]);
  });

  test("the funded batch pays the queue escalation, not the sum of sticker prices", () => {
    const names = [BITWIRE, SYNAPTIC, CSP1];
    const sticker = names.reduce((sum, name) => sum + AUGMENTATIONS[name]!.cost, 0);
    const money = sticker * 1.2;

    const batch = fundedActivationBatch({
      realizable: names,
      offers: offersFor(names),
      joined: new Set(["CyberSec"]),
      owned: new Set(),
      weights: defaultWeights(),
      countSlotValue: 0,
      ctx: CTX,
      money,
    });

    // Comfortably over the sticker sum, but the second and later purchases pay
    // 1.9^n — so the honest funded set is a strict subset, and it fits.
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(names.length);
    expect(totalCost(batch, CTX)).toBeLessThanOrEqual(money);
  });

  test("the funded batch only buys from joined factions at met reputation", () => {
    const names = [BITWIRE, SYNAPTIC];
    const plenty = 1e12;
    const base = {
      realizable: names,
      joined: new Set(["CyberSec"]),
      owned: new Set<string>(),
      weights: defaultWeights(),
      countSlotValue: 0,
      ctx: CTX,
      money: plenty,
    };

    expect(fundedActivationBatch({ ...base, offers: offersFor(names) })).toHaveLength(2);
    expect(fundedActivationBatch({
      ...base,
      offers: offersFor(names, "NiteSec"),
    })).toHaveLength(0);
    expect(fundedActivationBatch({
      ...base,
      offers: offersFor(names).map((offer) => ({ ...offer, affordableRep: false })),
    })).toHaveLength(0);
  });

  test("the first countable NeuroFlux level can fill one funded route slot", () => {
    const base = {
      realizable: [NEUROFLUX],
      offers: offersFor([NEUROFLUX]),
      joined: new Set(["CyberSec"]),
      owned: new Set<string>(),
      weights: defaultWeights(),
      countSlotValue: 1,
      ctx: CTX,
      money: 1e12,
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
      offers: offersFor(names),
      joined: new Set(["CyberSec"]),
      owned: new Set(),
      wanted: 2,
      neurofluxCountable: true,
      ctx: CTX,
      money,
    });

    expect(ask(exact)).toBe(true);
    expect(ask(exact * 0.99)).toBe(false);
    // The sticker sum would have said yes; the escalation is what makes it no.
    expect(AUGMENTATIONS[SYNAPTIC]!.cost + AUGMENTATIONS[BITWIRE]!.cost).toBeLessThan(exact);
  });

  test("a prerequisite chain fills its slots together, and an unreachable one fills none", () => {
    const joined = new Set(["CyberSec"]);
    const chain = [CSP1, CSP2];
    // The prerequisite has to be bought FIRST, so — unlike an unordered pair —
    // the dependant is the one that pays the escalated slot.
    const chainCost = AUGMENTATIONS[CSP1]!.cost + AUGMENTATIONS[CSP2]!.cost * 1.9;

    expect(countClosureAffordable({
      realizable: chain,
      offers: offersFor(chain),
      joined,
      owned: new Set(),
      wanted: 2,
      neurofluxCountable: true,
      ctx: CTX,
      money: chainCost,
    })).toBe(true);

    // Gen II alone cannot be transacted: its prerequisite is not purchasable
    // this sweep, so it is not a cheaper way to fill the slot at any price.
    expect(countClosureAffordable({
      realizable: [CSP2],
      offers: offersFor([CSP2]),
      joined,
      owned: new Set(),
      wanted: 1,
      neurofluxCountable: true,
      ctx: CTX,
      money: 1e12,
    })).toBe(false);

    // With the prerequisite already owned it is reachable again.
    expect(countClosureAffordable({
      realizable: [CSP2],
      offers: offersFor([CSP2]),
      joined,
      owned: new Set([CSP1]),
      wanted: 1,
      neurofluxCountable: true,
      ctx: CTX,
      money: 1e12,
    })).toBe(true);
  });

  test("wanting nothing is always affordable", () => {
    expect(countClosureAffordable({
      realizable: [],
      offers: [],
      joined: new Set(),
      owned: new Set(),
      wanted: 0,
      neurofluxCountable: true,
      ctx: CTX,
      money: 0,
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
    });
    expect(early.ready).toBe(true);
    expect(early.value).toBeGreaterThan(0);

    const earlyThin = routeCountVerdict({
      required: 30,
      installed: 3,
      affordableDistinct: 2,
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

  test("count slot value is flat off a finite-count route", () => {
    expect(countSlotValueFor(Infinity, 12)).toBe(countSlotValueFor(Infinity, 0));
    expect(countSlotValueFor(30, 29)).toBeGreaterThan(0);
  });
});
