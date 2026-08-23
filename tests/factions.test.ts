import { describe, expect, test } from "bun:test";
import type { PlayerRequirement } from "@ns";
import {
  augCost,
  basePriceMultiplier,
  canAfford,
  closePrereqs,
  countSlotWeight,
  entropyCost,
  estimatedCost,
  MULTIPLE_AUG_MULTIPLIER,
  NEUROFLUX,
  orderPurchases,
  orderPurchasesWithNeuroflux,
  scoreAug,
  selectAffordableBatch,
  totalCost,
  weightsFromMarginals,
  type AugInfo,
  type PriceContext,
  type PurchaseCandidate,
} from "../shared/strategy/factions/augs.ts";
import {
  combinedEtaSec,
  evaluate,
  evaluateAll,
  estimateBlockerSec,
  isReachable,
  negate,
  type Blocker,
  type RequirementView,
} from "../shared/strategy/factions/requirements.ts";
import { mulberry32 } from "../sim/core/rng.ts";

function view(overrides: Partial<RequirementView> = {}): RequirementView {
  return {
    money: 0,
    skills: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
    karma: 0,
    numPeopleKilled: 0,
    augCount: 0,
    jobs: {},
    companyRep: {},
    jobTitles: [],
    city: "Sector-12",
    location: "home",
    backdoored: new Set(),
    files: new Set(),
    hacknetRam: 0,
    hacknetCores: 0,
    hacknetLevels: 0,
    bitNode: 1,
    sourceFiles: {},
    bladeburnerRank: 0,
    numInfiltrations: 0,
    ...overrides,
  };
}

describe("requirement interpreter — regressions from the predecessor scripts", () => {
  test("an empty blocker list means SATISFIED (theirs returned false, because [] is truthy)", () => {
    // src/_lib/factions.ts:182-186 — the `not` case returns false whether the
    // inner call succeeded or not, because an empty array is truthy in JS. The
    // consequence was that every `notEmployedBy` faction — the entire criminal
    // ladder — was permanently unreachable.
    const requirement: PlayerRequirement = { type: "not", condition: { type: "employedBy", company: "ECorp" as never } };
    expect(evaluate(requirement, view())).toEqual([]);
    expect(evaluate(requirement, view({ jobs: { ECorp: "Software" } }))).toHaveLength(1);
    expect(evaluate(requirement, view({ jobs: { ECorp: "Software" } }))[0]!.kind).toBe("quitCompany");
  });

  test("a satisfiable OR is satisfiable (theirs returned false unconditionally)", () => {
    // src/_lib/factions.ts:187-197 — `someCondition` falls through to
    // `return false` after its success loop.
    const requirement: PlayerRequirement = {
      type: "someCondition",
      conditions: [
        { type: "skills", skills: { hacking: 2500 } },
        { type: "money", money: 100 },
      ],
    };
    expect(evaluate(requirement, view({ money: 1_000 }))).toEqual([]);
  });

  test("numAugmentations emits a GOAL, not 'unachievable' (theirs made Daedalus unplannable)", () => {
    // src/_lib/factions.ts:102-112.
    const requirement: PlayerRequirement = { type: "numAugmentations", numAugmentations: 30 };
    const blockers = evaluate(requirement, view({ augCount: 12 }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ kind: "augCount", target: 30, have: 12, reachable: true });
    expect(blockers[0]!.progress).toBeCloseTo(0.4, 10);
  });

  test("hacknet and bladeburner requirements are real (theirs were `return false` TODOs)", () => {
    // Netburners and Bladeburners were unreachable.
    const cases: [PlayerRequirement, string][] = [
      [{ type: "hacknetRAM", hacknetRAM: 8 }, "hacknetRam"],
      [{ type: "hacknetCores", hacknetCores: 4 }, "hacknetCores"],
      [{ type: "hacknetLevels", hacknetLevels: 100 }, "hacknetLevels"],
      [{ type: "bladeburnerRank", bladeburnerRank: 25 }, "bladeburnerRank"],
    ];
    for (const [requirement, kind] of cases) {
      const blockers = evaluate(requirement, view());
      expect(blockers, `${kind} produced no blocker`).toHaveLength(1);
      expect(blockers[0]!.kind).toBe(kind as Blocker["kind"]);
      expect(blockers[0]!.reachable, `${kind} reported unreachable`).toBe(true);
    }
  });

  test("infiltration is explicit manual work, not a need Side pretends it can deliver", () => {
    const requirement: PlayerRequirement = { type: "numInfiltrations", numInfiltrations: 1 };
    expect(evaluate(requirement, view())[0]).toMatchObject({
      kind: "infiltrations",
      target: 1,
      have: 0,
      reachable: false,
    });
    expect(evaluate(requirement, view({ numInfiltrations: 1 }))).toEqual([]);
  });
});

describe("requirement interpreter — semantics", () => {
  test("karma is an UPPER bound on a negative number", () => {
    const requirement: PlayerRequirement = { type: "karma", karma: -45 };
    expect(evaluate(requirement, view({ karma: -50 }))).toEqual([]);
    expect(evaluate(requirement, view({ karma: -45 }))).toEqual([]);
    expect(evaluate(requirement, view({ karma: -10 }))).toHaveLength(1);
    expect(evaluate(requirement, view({ karma: -10 }))[0]!.progress).toBeCloseTo(10 / 45, 10);
  });

  test("the four combat skills collapse into ONE goal", () => {
    // `haveCombatSkills(n)` emits all four at once; treating them as four
    // competing goals is not how the game presents it, and would make career
    // rank one stat above the others for no reason.
    const requirement: PlayerRequirement = {
      type: "skills",
      skills: { strength: 30, defense: 30, dexterity: 30, agility: 30 },
    };
    const blockers = evaluate(requirement, view());
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.kind).toBe("combatSkills");
    // ...but a MIXED skill requirement stays separate.
    const mixed = evaluate({ type: "skills", skills: { strength: 30, hacking: 100 } }, view());
    expect(mixed.map((b) => b.kind).sort()).toEqual(["skill", "skill"]);
  });

  test("AND unions blockers; OR picks the cheapest REACHABLE branch", () => {
    const and: PlayerRequirement = {
      type: "everyCondition",
      conditions: [
        { type: "money", money: 100 },
        { type: "karma", karma: -10 },
      ],
    };
    expect(evaluateAll([and], view())).toHaveLength(2);

    // One branch needs the wrong BitNode (unreachable), the other is money.
    const or: PlayerRequirement = {
      type: "someCondition",
      conditions: [
        { type: "bitNodeN", bitNodeN: 9 },
        { type: "money", money: 100 },
      ],
    };
    const picked = evaluate(or, view());
    expect(picked).toHaveLength(1);
    expect(picked[0]!.kind).toBe("money");
  });

  test("an OR with every branch impossible is impossible", () => {
    const or: PlayerRequirement = {
      type: "someCondition",
      conditions: [
        { type: "bitNodeN", bitNodeN: 9 },
        { type: "sourceFile", sourceFile: 12 },
      ],
    };
    expect(isReachable(evaluate(or, view()))).toBe(false);
  });

  test("De Morgan pushes `not` inward before deciding revocability", () => {
    const requirement: PlayerRequirement = {
      type: "not",
      condition: {
        type: "everyCondition",
        conditions: [
          { type: "employedBy", company: "ECorp" as never },
          { type: "employedBy", company: "MegaCorp" as never },
        ],
      },
    };
    // not(A and B) = (not A) or (not B); employed at neither satisfies both.
    expect(evaluate(requirement, view())).toEqual([]);
    // Employed at both: quitting EITHER suffices, so the OR picks one.
    const blocked = evaluate(requirement, view({ jobs: { ECorp: "Software", MegaCorp: "Software" } }));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.kind).toBe("quitCompany");

    expect(negate({ type: "someCondition", conditions: [] }).type).toBe("everyCondition");
    expect(negate({ type: "not", condition: { type: "money", money: 1 } })).toEqual({ type: "money", money: 1 });
  });

  test("a negated non-revocable requirement is honestly unreachable", () => {
    // Karma only ever decreases, so "must NOT have karma <= -9" cannot be
    // restored once crossed.
    const requirement: PlayerRequirement = { type: "not", condition: { type: "karma", karma: -9 } };
    expect(evaluate(requirement, view({ karma: 0 }))).toEqual([]);
    const blocked = evaluate(requirement, view({ karma: -50 }));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.reachable).toBe(false);
  });

  test("blockers carry the feature that can deliver them", () => {
    const owners = evaluateAll(
      [
        { type: "karma", karma: -45 },
        { type: "skills", skills: { hacking: 100 } },
        { type: "hacknetRAM", hacknetRAM: 8 },
        { type: "backdoorInstalled", server: "CSEC" },
      ],
      view(),
    ).map((blocker) => [blocker.kind, blocker.owner]);
    expect(new Map(owners as [string, string][])).toEqual(
      new Map([
        ["karma", "career"],
        ["skill", "hacking"],
        ["hacknetRam", "hacknet"],
        ["backdoor", "hacking"],
      ]),
    );
  });

  test("ETA sums within one owner and maxes across owners", () => {
    // One feature has one time slot, so its blockers are sequential; different
    // features genuinely run in parallel.
    const blockers = evaluateAll(
      [
        { type: "karma", karma: -45 },
        { type: "numPeopleKilled", numPeopleKilled: 30 },
        { type: "hacknetRAM", hacknetRAM: 8 },
      ],
      view(),
    );
    // career: 10 + 10 = 20; hacknet: 5. Max is 20, not the 25 sum.
    expect(combinedEtaSec(blockers, (b) => (b.owner === "career" ? 10 : 5))).toBe(20);
  });
});

// --- augmentation pricing ---------------------------------------------------

function aug(name: string, overrides: Partial<AugInfo> = {}): AugInfo {
  return { name, baseCost: 1e6, baseRepRequirement: 1000, factions: ["CyberSec"], prereqs: [], mults: {}, ...overrides };
}

function priceCtx(overrides: Partial<PriceContext> = {}): PriceContext {
  return { queuedNonSoA: 0, ownedSoA: 0, neurofluxLevel: 0, sf11Level: 0, augMoneyCost: 1, augRepCost: 1, ...overrides };
}

describe("augmentation pricing", () => {
  test("money scales with the queue but REPUTATION DOES NOT", () => {
    // The single fact the whole purchase plan rests on: rep targets are
    // order-independent, money is not.
    const a = aug("A");
    const first = augCost(a, priceCtx({ queuedNonSoA: 0 }));
    const fourth = augCost(a, priceCtx({ queuedNonSoA: 3 }));
    expect(fourth.moneyCost / first.moneyCost).toBeCloseTo(Math.pow(1.9, 3), 10);
    expect(fourth.repCost).toBe(first.repCost);
  });

  test("SF11 discounts the escalation", () => {
    expect(basePriceMultiplier(0)).toBe(MULTIPLE_AUG_MULTIPLIER);
    expect(basePriceMultiplier(1)).toBeCloseTo(1.9 * 0.96, 12);
    expect(basePriceMultiplier(3)).toBeCloseTo(1.9 * 0.93, 12);
    // Clamped, not indexed off the end.
    expect(basePriceMultiplier(9)).toBe(basePriceMultiplier(3));
  });

  test("NeuroFlux scales 1.14^level on BOTH rep and money", () => {
    const nfg = aug(NEUROFLUX, { baseCost: 750_000, baseRepRequirement: 500 });
    const level0 = augCost(nfg, priceCtx({ neurofluxLevel: 0 }));
    const level5 = augCost(nfg, priceCtx({ neurofluxLevel: 5 }));
    expect(level5.repCost / level0.repCost).toBeCloseTo(Math.pow(1.14, 5), 10);
    expect(level5.moneyCost / level0.moneyCost).toBeCloseTo(Math.pow(1.14, 5), 10);
    // NOT 1.9 — the predecessor scripts use 1.9 here and overprice it wildly.
    expect(level5.repCost / level0.repCost).not.toBeCloseTo(Math.pow(1.9, 5), 2);
  });

  test("SoA augmentations price on their own curve and are OUTSIDE the queue count", () => {
    const soa = aug("Wisdom of Athena", { baseCost: 1e6, baseRepRequirement: 1000 });
    const owned2 = augCost(soa, priceCtx({ ownedSoA: 2, queuedNonSoA: 5 }));
    // 7^2 on money, 1.3^2 on rep, and the 1.9^5 queue multiplier does NOT apply.
    expect(owned2.moneyCost).toBeCloseTo(1e6 * 49, 6);
    expect(owned2.repCost).toBeCloseTo(1000 * 1.69, 10);
  });

  test("every NeuroFlux purchase pays both the queue and level multipliers", () => {
    // queueAugmentation appends a distinct PlayerOwnedAugmentation for every
    // NeuroFlux level, so each purchase increases both exponents.
    const nfg = aug(NEUROFLUX, { baseCost: 750_000, baseRepRequirement: 500 });
    const prices: number[] = [];
    for (let level = 0; level < 5; level++) {
      const ctx = priceCtx({
        queuedNonSoA: 1 + level,
        neurofluxLevel: level,
      });
      prices.push(augCost(nfg, ctx).moneyCost);
    }
    // Every adjacent level is x1.14 for NFG level and x1.9 for the new queue
    // entry (before the Source File 11 discount).
    expect(prices[1]! / prices[0]!).toBeCloseTo(1.9 * 1.14, 10);
    expect(prices[2]! / prices[1]!).toBeCloseTo(1.9 * 1.14, 10);
    expect(prices[3]! / prices[2]!).toBeCloseTo(1.9 * 1.14, 10);
    expect(prices[4]! / prices[3]!).toBeCloseTo(1.9 * 1.14, 10);
  });

  test("positive augmentation requirements count installed only; zero also sees queued non-NeuroFlux", () => {
    expect(evaluate(
      { type: "numAugmentations", numAugmentations: 30 },
      view({ augCount: 29, purchasedAugCount: 30 }),
    )[0]).toMatchObject({ target: 30, have: 29 });
    expect(evaluate(
      { type: "numAugmentations", numAugmentations: 0 },
      view({ augCount: 0, purchasedAugCount: 1 }),
    )).toHaveLength(1);
  });

  test("totalCost counts every NeuroFlux purchase in the queue exponent", () => {
    const nfg = aug(NEUROFLUX, { baseCost: 750_000, baseRepRequirement: 500 });
    const order = [
      { name: NEUROFLUX, aug: nfg, faction: "CyberSec" },
      { name: NEUROFLUX, aug: nfg, faction: "CyberSec" },
      { name: NEUROFLUX, aug: nfg, faction: "CyberSec" },
    ];
    // Fresh context: level 0, nothing queued. Expected:
    //   level 0 at 1.9^0, level 1 at 1.9^1, level 2 at 1.9^2.
    const fresh = totalCost(order, priceCtx());
    const expectedFresh = 750_000 * (1 + 1.14 * 1.9 + 1.14 ** 2 * 1.9 ** 2);
    expect(fresh).toBeCloseTo(expectedFresh, 6);
    // One NFG already queued in the context; projected purchases continue to
    // add one queue entry apiece.
    const queued = totalCost(order, priceCtx({ queuedNonSoA: 1, neurofluxLevel: 1 }));
    const expectedQueued = 750_000 * (
      1.14 * 1.9 + 1.14 ** 2 * 1.9 ** 2 + 1.14 ** 3 * 1.9 ** 3
    );
    expect(queued).toBeCloseTo(expectedQueued, 6);
  });
});

describe("purchase ordering — brute-force oracle", () => {
  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    const out: T[][] = [];
    for (let i = 0; i < items.length; i++) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
    }
    return out;
  }

  function candidate(name: string, baseCost: number, prereqs: string[] = []): PurchaseCandidate {
    return { name, aug: aug(name, { baseCost, prereqs }), faction: "CyberSec" };
  }

  test("interleaves a funded NeuroFlux level at its minimum-cost position", () => {
    const ctx = priceCtx();
    const set = [candidate("dear", 100), candidate("cheap", 1)];
    const nfg = candidate(NEUROFLUX, 50);
    const order = orderPurchasesWithNeuroflux(set, nfg, 1, ctx);
    expect(order.map((item) => item.name)).toEqual(["dear", NEUROFLUX, "cheap"]);

    let best = Infinity;
    for (const permutation of permutations([...set, nfg])) {
      best = Math.min(best, totalCost(permutation, ctx));
    }
    expect(totalCost(order, ctx)).toBeCloseTo(best, 12);
  });

  test("matches the exhaustive optimum over all permutations (no prerequisites)", () => {
    const rng = mulberry32(7);
    const ctx = priceCtx();
    for (let trial = 0; trial < 40; trial++) {
      const size = 2 + Math.floor(rng() * 6); // up to 7
      const set = Array.from({ length: size }, (_, i) => candidate(`A${i}`, Math.round(rng() * 1e9) + 1));
      const ours = totalCost(orderPurchases(set, ctx), ctx);
      let best = Infinity;
      for (const permutation of permutations(set)) best = Math.min(best, totalCost(permutation, ctx));
      expect(ours).toBeCloseTo(best, 6);
    }
  });

  test("matches the constrained optimum when prerequisites force order", () => {
    const ctx = priceCtx();
    // B needs A, and A is CHEAPER — so expensive-first must yield to the
    // constraint, which is exactly where a naive sort would be wrong.
    const set = [candidate("A", 1e6), candidate("B", 5e8, ["A"]), candidate("C", 2e8)];
    const order = orderPurchases(set, ctx);
    expect(order.findIndex((c) => c.name === "A")).toBeLessThan(order.findIndex((c) => c.name === "B"));

    let best = Infinity;
    for (const permutation of permutations(set)) {
      if (permutation.findIndex((c) => c.name === "A") > permutation.findIndex((c) => c.name === "B")) continue;
      best = Math.min(best, totalCost(permutation, ctx));
    }
    expect(totalCost(order, ctx)).toBeCloseTo(best, 6);
  });

  test("matches brute force on random PREREQUISITE GRAPHS, not just chains", () => {
    // Bitburner's prerequisite graph branches — up to four prerequisites, depth
    // five — so no chain rule is exact and the DP has to earn its keep here.
    const rng = mulberry32(23);
    const ctx = priceCtx();
    for (let trial = 0; trial < 30; trial++) {
      const size = 3 + Math.floor(rng() * 4); // up to 6
      const names = Array.from({ length: size }, (_, i) => `A${i}`);
      const prereqs = new Map<string, string[]>();
      for (let i = 0; i < size; i++) {
        // Only earlier-indexed items may be prerequisites: keeps it acyclic
        // while still allowing branching and shared parents.
        const picks = names.slice(0, i).filter(() => rng() < 0.4);
        prereqs.set(names[i]!, picks);
      }
      const set = names.map((name) =>
        candidate(name, Math.round(rng() * 1e9) + 1, prereqs.get(name) ?? []),
      );

      const legal = (permutation: PurchaseCandidate[]): boolean =>
        permutation.every((entry, at) =>
          entry.aug.prereqs.every((prereq) => permutation.findIndex((c) => c.name === prereq) < at),
        );
      let best = Infinity;
      for (const permutation of permutations(set)) {
        if (legal(permutation)) best = Math.min(best, totalCost(permutation, ctx));
      }

      const order = orderPurchases(set, ctx);
      expect(legal(order), `order violates precedence: ${order.map((c) => c.name).join(",")}`).toBe(true);
      expect(totalCost(order, ctx)).toBeCloseTo(best, 6);
    }
  });

  test("most-expensive-first is what minimises the total", () => {
    const ctx = priceCtx();
    const set = [candidate("cheap", 1e6), candidate("dear", 1e9)];
    expect(orderPurchases(set, ctx).map((c) => c.name)).toEqual(["dear", "cheap"]);
    expect(totalCost(orderPurchases(set, ctx), ctx)).toBeLessThan(totalCost([set[0]!, set[1]!], ctx));
  });

  describe("choosing by value, paying by price", () => {
    const none = new Set<string>();

    test("the SET follows value, the ORDER follows price", () => {
      // Value order is cheap-then-dear; buying in that order would charge the 1.9x
      // escalation to the dear one. Both are chosen, and the order is reversed.
      const ctx = priceCtx();
      const cheapButBest = candidate("best", 1e6);
      const dearButWorse = candidate("worse", 1e9);
      const plan = selectAffordableBatch({
        candidates: [cheapButBest, dearButWorse],
        owned: none,
        ctx,
        money: 1e12,
      });
      expect(plan.order.map((c) => c.name)).toEqual(["worse", "best"]);
      expect(plan.dropped).toEqual([]);
      // And the quoted total is the one we will actually be charged.
      expect(plan.totalCost).toBeCloseTo(totalCost(plan.order, ctx), 6);
      expect(plan.totalCost).toBeLessThan(totalCost([cheapButBest, dearButWorse], ctx));
    });

    test("the budget is tested against the ORDERED cost, not the naive one", () => {
      // Exactly the failure the ordering exists to prevent: a batch that is
      // affordable when bought expensive-first and not affordable otherwise. Priced
      // in value order it would be rejected, and the augmentation left behind.
      const ctx = priceCtx();
      const set = [candidate("cheap", 1e6), candidate("dear", 1e9)];
      const naive = totalCost(set, ctx);
      const ordered = totalCost(orderPurchases(set, ctx), ctx);
      expect(ordered).toBeLessThan(naive);
      const money = (naive + ordered) / 2; // affordable one way only
      const plan = selectAffordableBatch({ candidates: set, owned: none, ctx, money });
      expect(plan.order).toHaveLength(2);
      expect(plan.totalCost).toBeLessThanOrEqual(money);
    });

    test("one unaffordable item does not veto everything cheaper behind it", () => {
      const ctx = priceCtx();
      const plan = selectAffordableBatch({
        candidates: [candidate("unreachable", 1e12), candidate("affordable", 1e6)],
        owned: none,
        ctx,
        money: 1e8,
      });
      expect(plan.order.map((c) => c.name)).toEqual(["affordable"]);
      expect(plan.dropped.map((c) => c.name)).toEqual(["unreachable"]);
    });

    test("a dependant goes with its dropped prerequisite", () => {
      // Buying the dependant would simply fail in game: the prerequisite is neither
      // owned nor in the batch. Counting it as affordable would wedge the drain.
      const ctx = priceCtx();
      const plan = selectAffordableBatch({
        candidates: [candidate("parent", 1e12), candidate("child", 1e6, ["parent"])],
        owned: none,
        ctx,
        money: 1e8,
      });
      expect(plan.order).toEqual([]);
      expect(plan.dropped.map((c) => c.name)).toEqual(["parent", "child"]);
    });

    test("the ESTIMATE screens and the SOLVER prices, and the plan never overspends", () => {
      // The screen uses `estimatedCost` because it runs once per candidate and the
      // exact ordering is exponential. With prerequisites the estimate can only be
      // pessimistic, so the direction of the error is safe: a candidate may be
      // dropped that the solver would have fitted, but the plan that comes back is
      // never one we cannot pay for.
      const ctx = priceCtx();
      const rng = mulberry32(99);
      for (let trial = 0; trial < 30; trial++) {
        const size = 2 + Math.floor(rng() * 5);
        const names = Array.from({ length: size }, (_, i) => `A${i}`);
        const candidates = names.map((name, i) =>
          candidate(name, Math.round(rng() * 1e9) + 1, names.slice(0, i).filter(() => rng() < 0.35)),
        );
        const money = rng() * 4e9;
        const plan = selectAffordableBatch({ candidates, owned: none, ctx, money });
        expect(plan.totalCost, `plan of ${plan.order.length} exceeds $${money}`).toBeLessThanOrEqual(money);
        expect(totalCost(plan.order, ctx)).toBeCloseTo(plan.totalCost, 6);
        // Every accepted item's prerequisites precede it, or the purchases fail.
        for (const [at, entry] of plan.order.entries()) {
          for (const prereq of entry.aug.prereqs) {
            expect(plan.order.findIndex((c) => c.name === prereq)).toBeLessThan(at);
          }
        }
      }
    });

    test("without prerequisites the estimate IS exact, so nothing is lost screening with it", () => {
      const ctx = priceCtx();
      const rng = mulberry32(5);
      for (let trial = 0; trial < 20; trial++) {
        const set = Array.from({ length: 2 + Math.floor(rng() * 6) }, (_, i) =>
          candidate(`A${i}`, Math.round(rng() * 1e9) + 1),
        );
        expect(estimatedCost(set, ctx)).toBeCloseTo(totalCost(orderPurchases(set, ctx), ctx), 6);
      }
    });

    test("an OWNED prerequisite does not block its dependant", () => {
      const ctx = priceCtx();
      const plan = selectAffordableBatch({
        candidates: [candidate("child", 1e6, ["parent"])],
        owned: new Set(["parent"]),
        ctx,
        money: 1e8,
      });
      expect(plan.order.map((c) => c.name)).toEqual(["child"]);
    });
  });
});

describe("prerequisite closure", () => {
  test("pulls in transitive prerequisites, in dependency order", () => {
    const catalog = new Map<string, AugInfo>([
      ["C", aug("C", { prereqs: ["B"] })],
      ["B", aug("B", { prereqs: ["A"] })],
      ["A", aug("A")],
    ]);
    expect(closePrereqs(["C"], catalog, new Set())).toEqual(["A", "B", "C"]);
  });

  test("skips what is already owned", () => {
    const catalog = new Map<string, AugInfo>([
      ["B", aug("B", { prereqs: ["A"] })],
      ["A", aug("A")],
    ]);
    expect(closePrereqs(["B"], catalog, new Set(["A"]))).toEqual(["B"]);
  });

  test("a cycle cannot hang the controller's 200ms tick", () => {
    const catalog = new Map<string, AugInfo>([
      ["A", aug("A", { prereqs: ["B"] })],
      ["B", aug("B", { prereqs: ["A"] })],
    ]);
    expect(closePrereqs(["A"], catalog, new Set()).sort()).toEqual(["A", "B"]);
  });
});

describe("affordability", () => {
  const base = { moneyCost: 1e6, repCost: 50_000, money: 5e6 };

  test("donation can close the gap with the money left AFTER the purchase", () => {
    // Materially better than a plain `rep >= repReq` test — the difference
    // between "wait for reputation" and "pay for it".
    const short = canAfford({ ...base, factionRep: 0, donationRate: { factionRepMult: 1, factionWorkRepGain: 1 } });
    // 50,000 rep at 1e6 per rep-unit needs $50bn — far more than the $4m spare.
    expect(short.ok).toBe(false);
    const cheap = canAfford({
      ...base,
      repCost: 2,
      factionRep: 0,
      donationRate: { factionRepMult: 1, factionWorkRepGain: 1 },
    });
    expect(cheap.ok).toBe(true);
    expect(cheap.needDonation).toBeCloseTo(2e6, 6);
  });

  test("locked donations are reported as locked, not as insufficient reputation", () => {
    const verdict = canAfford({ ...base, factionRep: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("donations locked");
  });

  test("no money is the first check", () => {
    expect(canAfford({ ...base, money: 1, factionRep: 1e9 }).reason).toBe("not enough money");
  });
});

describe("augmentation scoring", () => {
  test("a count slot is worth the seconds it removes from the count leg", () => {
    // The leg finishes in `remaining / augsPerSec`, so one slot removes
    // `1 / augsPerSec` of it — `worth / remaining`. Slots therefore get MORE
    // valuable as the gate closes, because the last one unblocks the gate.
    // The predecessor ramped the other way, from 1 down to a 1/5 floor, to keep
    // cheap filler from dominating a high-impact augmentation; filler and
    // multipliers are quoted in the same seconds now and compete on merit.
    const worth = new Map([["augmentations", 30_000]]);
    expect(countSlotWeight(worth, 30)).toBeCloseTo(1_000, 9);
    expect(countSlotWeight(worth, 1)).toBeCloseTo(30_000, 9);
    // No finite gate, or no measured acquisition rate: no slot value at all.
    expect(countSlotWeight(worth, Infinity)).toBe(0);
    expect(countSlotWeight(new Map(), 10)).toBe(0);
  });

  test("multiplicative bonuses become an additive set problem in log space", () => {
    const weights = { hacking: 1 };
    const a = aug("A", { mults: { hacking: 1.2 } });
    const b = aug("B", { mults: { hacking: 1.5 } });
    expect(scoreAug(a, weights) + scoreAug(b, weights)).toBeCloseTo(Math.log(1.2 * 1.5), 12);
  });

  test("experience multipliers contribute sub-linearly", () => {
    const weights = { hacking: 1, hacking_exp: 1 };
    const stat = aug("S", { mults: { hacking: 1.5 } });
    const exp = aug("E", { mults: { hacking_exp: 1.5 } });
    expect(scoreAug(exp, weights)).toBeLessThan(scoreAug(stat, weights));
  });

  test("a randomised augmentation scores only its bonus, never its placeholder mults", () => {
    const ucm = aug("Unstable Circadian Modulator", { multsUnknown: true, mults: { hacking: 99 } });
    expect(scoreAug(ucm, { hacking: 1 })).toBe(0);
  });

  test("The Red Pill is a route GATE, and a gate is not a rate", () => {
    // It carries no multipliers at all, so as a RATE it is worth nothing —
    // which is what the install cadence must see, since the cadence compares
    // value streams and a flat 9 in stream units made any package containing
    // it look infinitely worth pushing for. Its real worth is "the run cannot
    // end without this", and that belongs to the route requiring it: see
    // `packages.ts#routeAwareScore`, tested below at the horizon it unblocks.
    expect(scoreAug(aug("The Red Pill"), {})).toBe(0);
  });

  test("an effect no multiplier field expresses is priced in the channel it acts on", () => {
    // Neuroreceptor Management Implant removes the unfocused work penalty, so
    // every second the slot spends unfocused earns full rate instead of 80% —
    // a multiplier on whatever the slot is earning, which is reputation.
    const implant = aug("Neuroreceptor Management Implant");
    expect(scoreAug(implant, {})).toBe(0);
    const worth = new Map([["reputation", 50_000]]);
    expect(scoreAug(implant, {}, worth)).toBeCloseTo(Math.log(1 / 0.8) * 50_000, 6);
    // ...and nothing at all when reputation is not what the route is short of.
    expect(scoreAug(implant, {}, new Map([["reputation", 0]]))).toBe(0);
  });
});

// --- never attempt work a faction does not offer ------------------------------

import { blockersFor, chooseWorkType, stepFactions } from "../shared/strategy/factions/decide.ts";
import { workRepPerSec } from "../shared/strategy/factions/rep.ts";
import { factionPackageFrontier } from "../shared/strategy/factions/packages.ts";
import { selectFactionPlan } from "../shared/strategy/factions/portfolio.ts";
import { initFactionMemory } from "../shared/strategy/factions/plan.ts";
import type { FactionStanding, FactionsView } from "../shared/strategy/factions/state.ts";

const FIXTURE_WORTH = new Map([
  ["augmentations", 30], ["hacking", 10], ["reputation", 10], ["money", 10],
]);

function factionsView(over: Partial<FactionsView> = {}): FactionsView {
  return {
    time: 0,
    person: {
      skills: { hacking: 500, strength: 500, defense: 500, dexterity: 500, agility: 500, charisma: 500, intelligence: 0 },
      mults: { faction_rep: 1 },
    } as FactionsView["person"],
    requirementView: view(),
    repContext: { factionWorkRepGain: 1, shareBonus: 1, sf15Level: 0, hasFocusAug: false },
    priceContext: priceCtx(),
    factions: [],
    catalog: new Map(),
    owned: new Set(),
    queued: new Set(),
    // A measured route, so count slots, multipliers and favor are all priced in
    // the same BN-seconds. `weights` is DERIVED from it exactly as the driver
    // derives it — a fixture where the two disagree exercises a state the game
    // cannot reach, and silently changes which half of a package dominates.
    weights: weightsFromMarginals(FIXTURE_WORTH),
    horizonSec: 3_600,
    rates: { best: new Map(), worth: FIXTURE_WORTH },
    targetAugCount: 30,
    favorToDonate: 150,
    moneyGranted: 0,
    moneyAvailable: 0,
    pendingProceeds: 0,
    proceedsSettling: false,
    holdsWorkSlot: true,
    incomePerSec: 1000,
    sf4Level: 3,
    bitNode: 4,
    ...over,
  };
}

function standing(name: string, offers: { hacking: boolean; field: boolean; security: boolean }) {
  return {
    name,
    joined: true,
    invited: false,
    rep: 0,
    favor: 0,
    requirements: [],
    enemies: [],
    offers,
    special: false,
  };
}

describe("work type selection weighs everything the work produces", () => {
  // MEASURED on a live BN12 install: progression posted `combatSkills 219 /
  // 1500` at weight 5, career took the work slot with Mug, and The Black Hand
  // sat at "idle" — while its FIELD work would have paid combat experience AND
  // reputation from the same second. The chooser picked on reputation alone and
  // the claim announced reputation alone, so nothing in the auction could see
  // the second half of what faction work does.
  const tetrads = standing("Tetrads", { hacking: true, field: true, security: true });

  const choose = (over: Partial<FactionsView> = {}) =>
    chooseWorkType("Tetrads", tetrads, factionsView({ factions: [tetrads], ...over }), initFactionMemory());

  test("reputation still decides when nothing else is priced", () => {
    // The rule this replaces, preserved exactly: with no worth table every
    // option is unpriced and the ordering degenerates to reputation per second.
    const person = factionsView().person;
    const ctx = factionsView().repContext;
    const best = (["hacking", "field", "security"] as const)
      .map((type) => ({ type, rep: workRepPerSec(type, person, 0, ctx, true) }))
      .sort((a, b) => b.rep - a.rep)[0]!;
    expect(choose()).toMatchObject({ type: best.type });
    expect(choose()?.repPerSec).toBeCloseTo(best.rep, 9);
  });

  test("the work announces the combat and charisma experience it also pays", () => {
    const produces = choose({
      rates: { best: new Map(), worth: new Map([["combat", 5e6], ["reputation", 1]]) },
    })?.produces ?? {};
    // Field and security pay all four combat stats, so the WEAKEST of them —
    // which is what a combat gate is actually met by — advances at that rate.
    expect(produces["combat"]).toBeGreaterThan(0);
    expect(produces["reputation"]).toBeGreaterThan(0);
    // ...and the individual stats stay visible for a single-stat requirement.
    expect(produces["skill:strength"]).toBeGreaterThan(0);
  });

  test("a valued combat gate moves the choice off the best reputation rate", () => {
    // Hacking work pays the most reputation for this person and no combat
    // experience at all. Once combat is worth something, the type that earns
    // BOTH wins — which is the decision crime was winning by default.
    expect(choose()?.produces["combat"] ?? 0).toBe(0);
    const withCombat = choose({
      rates: { best: new Map(), worth: new Map([["combat", 1e9], ["reputation", 1]]) },
    });
    expect(withCombat?.produces["combat"]).toBeGreaterThan(0);
    expect(withCombat?.type).not.toBe("hacking");
  });
});

describe("work type selection — found in the real game", () => {
  // THE BUG: `workTypes` was never populated by any probe, and the view
  // defaulted missing data to "offers all three". The driver then issued
  // `workForFaction(Tetrads, "hacking")` — Tetrads offers field and security
  // only — so the call failed every 30s forever and reputation never accrued,
  // while the panel cheerfully reported "next work Tetrads (hacking)".
  const wanted = aug("PCMatrix", { factions: ["Tetrads"], baseRepRequirement: 1e5, mults: { hacking: 1.5 } });
  const catalog = new Map([["PCMatrix", wanted]]);

  test("never picks a work type the faction does not offer", () => {
    const { decision } = stepFactions(
      factionsView({
        factions: [standing("Tetrads", { hacking: false, field: true, security: true })],
        catalog,
      }),
      initFactionMemory(),
    );
    if (decision.action.type === "workForFaction") {
      expect(decision.action.workType).not.toBe("hacking");
      expect(["field", "security"]).toContain(decision.action.workType);
    }
  });

  test("a faction offering NO work is never selected for work at all", () => {
    // Shadows of Anarchy gains reputation only by infiltrating.
    const faction = standing("Shadows of Anarchy", { hacking: false, field: false, security: false });
    const world = factionsView({
      factions: [faction],
      catalog: new Map([["PCMatrix", aug("PCMatrix", { factions: ["Shadows of Anarchy"], mults: { hacking: 1.5 } })]]),
    });
    const { decision } = stepFactions(
      world,
      initFactionMemory(),
    );
    expect(decision.action.type).not.toBe("workForFaction");
    expect(factionPackageFrontier(faction, [], world)).toEqual([]);
  });

  test("unknown work types mean DO NOT WORK, not 'try everything'", () => {
    // The view maps a missing `workTypes` probe reading to all-false. Not
    // working for one probe cycle is cheap; working the wrong type forever is
    // not — and the failure is silent, which is worse.
    const { decision } = stepFactions(
      factionsView({
        factions: [standing("Tetrads", { hacking: false, field: false, security: false })],
        catalog,
      }),
      initFactionMemory(),
    );
    expect(decision.action.type).not.toBe("workForFaction");
  });

  test("without the work slot it says only one activity can run", () => {
    // The panel previously showed the intended work as if it were running,
    // which read as a contradiction against the game's own display.
    const { decision } = stepFactions(
      factionsView({
        factions: [standing("Tetrads", { hacking: false, field: true, security: true })],
        catalog,
        holdsWorkSlot: false,
      }),
      initFactionMemory(),
    );
    expect(decision.action.type).toBe("idle");
  });
});

describe("grafting economics", () => {
  test("entropy cost uses only affected weighted fields and discounts experience", () => {
    const cost = entropyCost({ hacking: 1, hacking_exp: 1, unrelated: 1 });
    expect(cost).toBeCloseTo(1.5 * -Math.log(0.98), 12);
  });
});

describe("faction breakpoint package planner", () => {
  const hacking = { hacking: true, field: false, security: false };
  const packageStanding = (
    name: string,
    over: Partial<FactionStanding> = {},
  ): FactionStanding => ({ ...standing(name, hacking), ...over });

  function enemyChoice() {
    const firstA = packageStanding("A", { joined: false, invited: true, enemies: ["B"] });
    const firstB = packageStanding("B", { joined: false, invited: true, enemies: ["A"] });
    const catalog = new Map([
      ["A-fast", aug("A-fast", { factions: ["A"], baseCost: 0, baseRepRequirement: 100 })],
      ["A-deep", aug("A-deep", { factions: ["A"], baseCost: 0, baseRepRequirement: 1_000 })],
      ["B-next", aug("B-next", { factions: ["B"], baseCost: 0, baseRepRequirement: 200 })],
    ]);
    const first = stepFactions(
      factionsView({ factions: [firstA, firstB], catalog, horizonSec: 100_000, moneyAvailable: 1e15 }),
      initFactionMemory(),
    );
    return { firstA, firstB, catalog, first };
  }

  test("batches planned and compatible unplanned invitations into one action", () => {
    const planned = packageStanding("Planned", { joined: false, invited: true });
    const safe = packageStanding("Safe", { joined: false, invited: true });
    const safeEnemy = packageStanding("SafeEnemy", {
      joined: false,
      invited: true,
      enemies: ["Irrelevant"],
    });
    const blocker = packageStanding("Blocker", {
      joined: false,
      invited: true,
      enemies: ["Planned"],
    });
    const irrelevant = packageStanding("Irrelevant", { joined: false, invited: false });
    const catalog = new Map([
      ["planned aug", aug("planned aug", {
        factions: ["Planned"],
        baseCost: 0,
        baseRepRequirement: 100,
        mults: { hacking: 2 },
      })],
    ]);

    const { decision } = stepFactions(
      factionsView({
        factions: [planned, safe, safeEnemy, blocker, irrelevant],
        catalog,
        horizonSec: 100_000,
        moneyAvailable: 1e15,
      }),
      initFactionMemory(),
    );

    expect(decision.objective?.factions).toContain("Planned");
    expect(decision.action).toEqual({
      type: "joinFactions",
      factions: ["Planned", "Safe", "SafeEnemy"],
    });
  });

  test("does not opportunistically join a faction that blocks the committed plan", () => {
    const planned = packageStanding("Planned", { joined: false, invited: false });
    const blocker = packageStanding("Blocker", {
      joined: false,
      invited: true,
      enemies: ["Planned"],
    });
    const catalog = new Map([
      ["planned aug", aug("planned aug", {
        factions: ["Planned"],
        baseCost: 0,
        baseRepRequirement: 100,
        mults: { hacking: 2 },
      })],
    ]);

    const { decision } = stepFactions(
      factionsView({ factions: [planned, blocker], catalog, horizonSec: 100_000, moneyAvailable: 1e15 }),
      initFactionMemory(),
    );

    expect(decision.objective?.factions).toContain("Planned");
    expect(decision.action.type).not.toBe("joinFactions");
  });

  test("checks the planned faction's enemy list when the invite omits the reverse edge", () => {
    const planned = packageStanding("Planned", {
      joined: false,
      invited: false,
      enemies: ["Blocker"],
    });
    const blocker = packageStanding("Blocker", { joined: false, invited: true, enemies: [] });
    const catalog = new Map([
      ["planned aug", aug("planned aug", {
        factions: ["Planned"],
        baseCost: 0,
        baseRepRequirement: 100,
        mults: { hacking: 2 },
      })],
    ]);

    const { decision } = stepFactions(
      factionsView({ factions: [planned, blocker], catalog, horizonSec: 100_000, moneyAvailable: 1e15 }),
      initFactionMemory(),
    );

    expect(decision.action.type).not.toBe("joinFactions");
  });

  test("switches to the runner-up before an unattractive deep breakpoint", () => {
    const factions = [packageStanding("A"), packageStanding("B")];
    const catalog = new Map([
      ["A-fast", aug("A-fast", { factions: ["A"], baseCost: 0, baseRepRequirement: 100 })],
      ["A-deep", aug("A-deep", { factions: ["A"], baseCost: 0, baseRepRequirement: 1_000 })],
      ["B-next", aug("B-next", { factions: ["B"], baseCost: 0, baseRepRequirement: 200 })],
    ]);
    const world = factionsView({ factions, catalog, horizonSec: 100_000, moneyAvailable: 1e15 });
    const selection = selectFactionPlan(world, new Map(factions.map((faction) => [faction.name, []])));

    expect(selection.intent?.faction).toBe("A");
    expect(selection.intent?.repTarget).toBe(100);
    expect(selection.runnerUp?.faction).toBe("B");
  });

  test("advances to the recorded runner after banking the first package reputation", () => {
    const factions = [packageStanding("A"), packageStanding("B")];
    const catalog = new Map([
      ["A-fast", aug("A-fast", { factions: ["A"], baseCost: 1, baseRepRequirement: 100 })],
      ["A-deep", aug("A-deep", { factions: ["A"], baseCost: 1, baseRepRequirement: 1_000 })],
      ["B-next", aug("B-next", { factions: ["B"], baseCost: 1, baseRepRequirement: 200 })],
    ]);
    const first = stepFactions(
      factionsView({ factions, catalog, horizonSec: 100_000, moneyAvailable: 1e15 }),
      initFactionMemory(),
    );
    expect(first.decision.objective?.intent?.faction).toBe("A");
    expect(first.decision.objective?.runnerUp?.faction).toBe("B");

    const advanced = stepFactions(
      factionsView({
        factions: [{ ...factions[0]!, rep: 100 }, factions[1]!],
        catalog,
        horizonSec: 100_000,
        moneyAvailable: 1e15,
        // The old continuation guard saw that its last A order was still
        // running and idled, even though completing A promoted B. This is the
        // exact stale-work state observed in the full BitNode simulation.
        currentWork: { kind: "faction", faction: "A", workType: "hacking", focused: true },
      }),
      first.memory,
    );
    expect(advanced.decision.objective?.intent?.faction).toBe("B");
    expect(advanced.decision.action).toMatchObject({ type: "workForFaction", faction: "B" });
    expect(advanced.decision.recommendInstall).toBeUndefined();
  });

  test("does not select an end-loaded completed package again while it remains unowned", () => {
    const faction = packageStanding("A");
    const catalog = new Map([
      ["A-fast", aug("A-fast", { factions: ["A"], baseCost: 1, baseRepRequirement: 100 })],
    ]);
    const first = stepFactions(
      factionsView({ factions: [faction], catalog, horizonSec: 100_000, moneyAvailable: 1e15 }),
      initFactionMemory(),
    );
    expect(first.decision.objective?.intent?.augmentations).toEqual(["A-fast"]);

    const completed = stepFactions(
      factionsView({
        factions: [{ ...faction, rep: 100 }],
        catalog,
        horizonSec: 100_000,
        moneyAvailable: 1e15,
      }),
      first.memory,
    );

    expect(completed.memory.bankedAugmentations).toEqual(["A-fast"]);
    expect(completed.decision.objective?.intent).toBeUndefined();
    expect(completed.decision.action).toMatchObject({ type: "idle" });
    // Completing work is not itself permission to start the purchase
    // transaction; progression still owns the cadence decision.
    expect(completed.decision.recommendInstall).toBeUndefined();
  });

  test("never records a runner-up that the chosen package has already foreclosed", () => {
    // WAS: "moves to a compatible fresh package when a completed package's
    // recorded runner is enemy-blocked". The recovery is no longer needed
    // because the state cannot arise. The old selector chose its runner-up by
    // rate alone, so it would happily nominate B while committing to A — and
    // joining A bans B for the whole cycle. The plan is a SET now, and a set is
    // built under the mutual-enemy constraint, so B is never in it and C (the
    // compatible faction) is the runner from the start.
    //
    // This matters beyond bookkeeping: the runner-up is the opportunity cost
    // that decides when to STOP pushing the chosen faction. Costing it against
    // a faction we have already foreclosed stops the push early in favour of
    // work that can never happen.
    const a = packageStanding("A", { joined: false, invited: true, enemies: ["B"] });
    const b = packageStanding("B", { joined: false, invited: true, enemies: ["A"] });
    const c = packageStanding("C");
    const catalog = new Map([
      ["A-aug", aug("A-aug", { factions: ["A"], baseCost: 1, baseRepRequirement: 100 })],
      ["B-aug", aug("B-aug", { factions: ["B"], baseCost: 1, baseRepRequirement: 200 })],
      ["C-aug", aug("C-aug", { factions: ["C"], baseCost: 1, baseRepRequirement: 1_000 })],
    ]);
    const first = stepFactions(
      factionsView({ factions: [a, b, c], catalog, horizonSec: 100_000, moneyAvailable: 1e15 }),
      initFactionMemory(),
    );
    expect(first.decision.objective?.intent?.faction).toBe("A");
    expect(first.decision.objective?.runnerUp?.faction).toBe("C");
    expect(first.decision.objective?.factions).not.toContain("B");

    const completed = stepFactions(
      factionsView({
        factions: [{ ...a, joined: true, invited: false, rep: 100 }, b, c],
        catalog,
        horizonSec: 100_000,
        moneyAvailable: 1e15,
      }),
      first.memory,
    );
    expect(completed.memory.bankedAugmentations).toEqual(["A-aug"]);
    expect(completed.decision.objective?.intent?.faction).toBe("C");
    expect(completed.decision.action).toMatchObject({ type: "workForFaction", faction: "C" });
  });

  test("does not close an end-loaded transaction before its banked base package is funded", () => {
    const faction = packageStanding("A", { rep: 100 });
    const wanted = aug("A-base", {
      factions: ["A"],
      baseCost: 1_000,
      baseRepRequirement: 100,
      mults: { hacking: 1.1 },
    });
    const memory = {
      ...initFactionMemory(),
      objective: {
        factions: ["A"],
        augmentations: [wanted.name],
        value: 1,
        foreclosed: [],
        intent: {
          faction: "A", repTarget: 100, augmentations: [wanted.name], value: 1,
          activationValue: 0.1, etaSec: 1, marginalRate: 1,
          marginalActivationRate: 0.1, favorAfterInstall: 0,
          purpose: "augmentations" as const, unlockSec: 0, repSec: 0,
          moneySec: 1, totalCost: 1_000, purchaseCost: 1_000,
          donationCost: 0, rate: 1,
        },
      },
    };
    const short = stepFactions(factionsView({
      factions: [faction],
      catalog: new Map([[wanted.name, wanted]]),
      installRequested: true,
      moneyAvailable: 999,
    }), memory);
    expect(short.memory.bankedAugmentations).toEqual([wanted.name]);
    expect(short.decision.recommendInstall).toBeUndefined();
    expect(short.decision.action.type).not.toBe("purchaseAugmentation");

    const funded = stepFactions(factionsView({
      factions: [faction],
      catalog: new Map([[wanted.name, wanted]]),
      installRequested: true,
      moneyAvailable: 1_000,
      moneyGranted: 1_000,
    }), short.memory);
    expect(funded.decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: wanted.name });
    expect(funded.decision.drainCeiling).toBe(1_000);
  });

  test("a cadence-requested reset freezes the affordable subset of a larger bank", () => {
    const faction = packageStanding("A", { rep: 100 });
    const cheap = aug("A-cheap", {
      factions: ["A"], baseCost: 1_000, baseRepRequirement: 100, mults: { hacking: 1.1 },
    });
    const dear = aug("A-dear", {
      factions: ["A"], baseCost: 1e12, baseRepRequirement: 100, mults: { hacking: 1.2 },
    });
    const result = stepFactions(factionsView({
      factions: [faction],
      catalog: new Map([[cheap.name, cheap], [dear.name, dear]]),
      installRequested: true,
      moneyAvailable: 1_000,
      moneyGranted: 1_000,
    }), {
      ...initFactionMemory(),
      bankedAugmentations: [cheap.name, dear.name],
    });

    expect(result.decision.action).toMatchObject({
      type: "purchaseAugmentation",
      augmentation: cheap.name,
    });
    expect(result.memory.drainOrder).toEqual([cheap.name]);
    expect(result.decision.drainCeiling).toBe(1_000);
  });

  test("the final sweep preserves the exact one-shot subset progression funded", () => {
    const faction = packageStanding("A", { rep: 100 });
    const cadence = aug("cadence-funded", {
      factions: ["A"], baseCost: 1_000, baseRepRequirement: 100, mults: { hacking: 1.01 },
    });
    const tempting = aug("tempting-substitute", {
      factions: ["A"], baseCost: 1_000, baseRepRequirement: 100, mults: { hacking: 10 },
    });
    const result = stepFactions(factionsView({
      factions: [faction],
      catalog: new Map([[cadence.name, cadence], [tempting.name, tempting]]),
      installRequested: true,
      installFundedAugmentations: [cadence.name],
      moneyAvailable: 1_000,
      moneyGranted: 1_000,
    }), {
      ...initFactionMemory(),
      bankedAugmentations: [cadence.name, tempting.name],
    });

    expect(result.memory.drainOrder).toEqual([cadence.name]);
    expect(result.decision.action).toMatchObject({
      type: "purchaseAugmentation",
      augmentation: cadence.name,
    });
  });

  test("an unaffordable optional bank cannot hold a funded Red Pill reset hostage", () => {
    const faction = packageStanding("Daedalus", { rep: 2_500_000 });
    const pill = aug("The Red Pill", {
      factions: ["Daedalus"],
      baseCost: 100,
      baseRepRequirement: 2_500_000,
    });
    const optional = aug("Optional luxury", {
      factions: ["Daedalus"],
      baseCost: 1e12,
      baseRepRequirement: 100,
      mults: { hacking: 10 },
    });
    const memory = {
      ...initFactionMemory(),
      bankedAugmentations: [pill.name, optional.name],
    };

    const closing = stepFactions(factionsView({
      factions: [faction],
      catalog: new Map([[pill.name, pill], [optional.name, optional]]),
      route: "daedalus",
      installRequested: true,
      moneyAvailable: 100,
      moneyGranted: 100,
    }), memory);

    expect(closing.decision.action).toMatchObject({
      type: "purchaseAugmentation",
      augmentation: "The Red Pill",
    });
    expect(closing.memory.drainOrder).toEqual(["The Red Pill"]);
    expect(closing.decision.drainCeiling).toBe(100);
  });

  test("does not abandon an unfinished base package when its work target is transiently unavailable", () => {
    const faction = packageStanding("A");
    const wanted = aug("A-base", {
      factions: ["A"], baseCost: 1, baseRepRequirement: 100, mults: { hacking: 1.1 },
    });
    const catalog = new Map([[wanted.name, wanted]]);
    const first = stepFactions(
      factionsView({ factions: [faction], catalog, moneyAvailable: 1e15 }),
      initFactionMemory(),
    );
    expect(first.decision.objective?.intent?.repTarget).toBe(100);

    // A stale/temporarily absent work-type probe means no executable target
    // this tick. It does not mean the committed 100-rep package is complete.
    const unavailable = stepFactions(factionsView({
      factions: [{ ...faction, offers: { hacking: false, field: false, security: false } }],
      catalog,
      installRequested: true,
      moneyAvailable: 1e15,
    }), first.memory);
    expect(unavailable.decision.action).toMatchObject({ type: "idle" });
    expect(unavailable.decision.recommendInstall).toBeUndefined();
    expect(unavailable.decision.drainCeiling).toBeUndefined();
  });

  test("an actionable joined package replaces a speculative unjoined latch immediately", () => {
    const locked = packageStanding("Locked", {
      joined: false,
      invited: false,
      requirements: [{ type: "city", city: "Aevum" }],
    });
    const available = packageStanding("Available", { joined: true });
    const catalog = new Map([
      ["locked-aug", aug("locked-aug", { factions: ["Locked"], baseCost: 1, baseRepRequirement: 100, mults: { hacking: 1.1 } })],
      ["available-aug", aug("available-aug", { factions: ["Available"], baseCost: 1, baseRepRequirement: 100, mults: { hacking: 10 } })],
    ]);
    const first = stepFactions(
      factionsView({ factions: [locked], catalog, horizonSec: 100_000, moneyAvailable: 1e15 }),
      initFactionMemory(),
    );
    expect(first.decision.objective?.intent?.faction).toBe("Locked");

    const replanned = stepFactions(
      factionsView({ factions: [locked, available], catalog, horizonSec: 100_000, moneyAvailable: 1e15 }),
      first.memory,
    );
    expect(replanned.decision.objective?.intent?.faction).toBe("Available");
    expect(replanned.decision.action).toMatchObject({ type: "workForFaction", faction: "Available" });
  });

  test("only pushes a post-plan augmentation inside one percent of the elapsed install", () => {
    const factions = [packageStanding("A"), packageStanding("B")];
    const catalog = new Map([
      ["A-fast", aug("A-fast", { factions: ["A"], baseCost: 1, baseRepRequirement: 100 })],
      ["A-deep", aug("A-deep", { factions: ["A"], baseCost: 1, baseRepRequirement: 1_000 })],
      ["B-next", aug("B-next", { factions: ["B"], baseCost: 1, baseRepRequirement: 200 })],
    ]);
    const first = stepFactions(
      factionsView({ factions, catalog, horizonSec: 100_000, moneyAvailable: 1e15 }),
      initFactionMemory(),
    );
    const committed = stepFactions(
      factionsView({
        factions,
        catalog,
        horizonSec: 100_000,
        installCycleSec: 1,
        installRequested: true,
        moneyAvailable: 1e15,
      }),
      first.memory,
    );
    expect(committed.decision.action).toMatchObject({ type: "workForFaction", faction: "A" });
    expect(committed.decision.recommendInstall).toBeUndefined();

    const held = stepFactions(
      factionsView({
        factions: [{ ...factions[0]!, rep: 100 }, factions[1]!],
        catalog,
        horizonSec: 100_000,
        installCycleSec: 1,
        installRequested: true,
        moneyAvailable: 1e15,
      }),
      first.memory,
    );
    expect(held.decision.objective?.intent?.faction).toBe("B");
    expect(held.decision.action.type).not.toBe("workForFaction");
    expect(held.decision.action.type).toBe("purchaseAugmentation");
    expect(held.decision.drainCeiling).toBeDefined();
    expect(held.memory.drainCeiling).toBe(held.decision.drainCeiling);
    expect(held.memory.drainOrder?.length).toBeGreaterThan(0);

    const draining = stepFactions(
      factionsView({
        factions: [{ ...factions[0]!, rep: 100 }, factions[1]!],
        catalog,
        horizonSec: 100_000,
        installCycleSec: 100_000,
        installRequested: true,
        moneyAvailable: 1e15,
      }),
      held.memory,
    );
    expect(draining.decision.action.type).not.toBe("workForFaction");
    expect(draining.decision.drainCeiling).toBe(held.decision.drainCeiling);
    expect(draining.memory.drainOrder).toEqual(held.memory.drainOrder);

    const cadenceReconsidered = stepFactions(
      factionsView({
        factions: [{ ...factions[0]!, rep: 100 }, factions[1]!],
        catalog,
        horizonSec: 100_000,
        installCycleSec: 100_000,
        installRequested: false,
        moneyAvailable: 1e15,
      }),
      held.memory,
    );
    expect(cadenceReconsidered.decision.action.type).not.toBe("workForFaction");
    expect(cadenceReconsidered.decision.action).toMatchObject({ type: "purchaseAugmentation", faction: "A" });
    expect(cadenceReconsidered.decision.drainCeiling).toBe(held.decision.drainCeiling);
    expect(cadenceReconsidered.memory.drainOrder).toEqual(held.memory.drainOrder);

    const cheapExtra = stepFactions(
      factionsView({
        factions: [{ ...factions[0]!, rep: 100 }, factions[1]!],
        catalog,
        horizonSec: 100_000,
        installCycleSec: 100_000,
        installRequested: true,
        moneyAvailable: 1e15,
      }),
      first.memory,
    );
    expect(cheapExtra.decision.action).toMatchObject({ type: "workForFaction", faction: "B" });
    expect(cheapExtra.decision.recommendInstall).toBeUndefined();
  });

  test("a deep breakpoint competes with ENDING the cycle, not only with switching", () => {
    // WAS: "pushes the best faction farther when switching is much worse" —
    // which pushed A all the way to its deepest breakpoint whenever no other
    // faction offered a better rate. That comparison was missing its third
    // option. Reputation is not the only cost of going deeper: ten times the
    // grind for one more augmentation also delays the install that switches the
    // first one on, and an install is what every earned multiplier is waiting
    // for. With nothing banked at A yet, there is nothing for a reset to
    // destroy, so the cheap breakpoint wins and A-deep is next cycle's work.
    const factions = [packageStanding("A"), packageStanding("B")];
    const catalog = new Map([
      ["A-fast", aug("A-fast", { factions: ["A"], baseCost: 0, baseRepRequirement: 100 })],
      ["A-deep", aug("A-deep", { factions: ["A"], baseCost: 0, baseRepRequirement: 1_000 })],
      ["B-later", aug("B-later", { factions: ["B"], baseCost: 0, baseRepRequirement: 10_000 })],
    ]);
    const world = factionsView({ factions, catalog, horizonSec: 100_000, moneyAvailable: 1e15 });
    const selection = selectFactionPlan(world, new Map(factions.map((faction) => [faction.name, []])));

    expect(selection.intent?.faction).toBe("A");
    expect(selection.intent?.repTarget).toBe(100);
    // ...and the budget it was solved for is published, so the choice of cycle
    // length can be argued with rather than inferred from the breakpoint.
    expect(selection.portfolio.budgetSec).toBeGreaterThan(0);
    expect(selection.horizonCurve.length).toBeGreaterThan(1);

    // The same faction IS pushed deeper once reputation is banked there, because
    // then ending the cycle forfeits it.
    const banked = selectFactionPlan(
      factionsView({
        factions: [packageStanding("A", { rep: 900 }), packageStanding("B")],
        catalog,
        horizonSec: 100_000,
        moneyAvailable: 1e15,
      }),
      new Map(factions.map((faction) => [faction.name, []])),
    );
    expect(banked.intent?.repTarget).toBe(1_000);
    expect(banked.intent?.augmentations).toContain("A-deep");
  });

  test("does not count a shared augmentation again as runner-up value", () => {
    const factions = [packageStanding("A"), packageStanding("B")];
    const catalog = new Map([
      ["shared", aug("shared", { factions: ["A", "B"], baseCost: 0, baseRepRequirement: 100 })],
      ["A-unique", aug("A-unique", { factions: ["A"], baseCost: 0, baseRepRequirement: 1_000 })],
    ]);
    const world = factionsView({ factions, catalog, horizonSec: 100_000, moneyAvailable: 1e15 });
    const selection = selectFactionPlan(world, new Map(factions.map((faction) => [faction.name, []])));

    expect(selection.intent?.faction).toBe("A");
    expect(selection.intent?.repTarget).toBe(1_000);
    expect(selection.runnerUp).toBeUndefined();
  });

  test("gives The Red Pill terminal value only on faction-acquisition routes", () => {
    const factions = [packageStanding("Daedalus"), packageStanding("CyberSec")];
    const catalog = new Map([
      ["The Red Pill", aug("The Red Pill", { factions: ["Daedalus"], baseCost: 0, baseRepRequirement: 1_000 })],
      ["quick", aug("quick", { factions: ["CyberSec"], baseCost: 0, baseRepRequirement: 100 })],
      [NEUROFLUX, aug(NEUROFLUX, { factions: ["CyberSec"], baseCost: 1, baseRepRequirement: 0, mults: { hacking: 2 } })],
    ]);
    const blockers = new Map(factions.map((faction) => [faction.name, []]));
    const labyrinth = selectFactionPlan(
      factionsView({ factions, catalog, route: "labyrinth", horizonSec: 100_000, moneyAvailable: 1e15 }),
      blockers,
    );
    const daedalus = selectFactionPlan(
      factionsView({ factions, catalog, route: "daedalus", horizonSec: 100_000, moneyAvailable: 1e15, owned: new Set([NEUROFLUX]) }),
      blockers,
    );
    const gang = selectFactionPlan(
      factionsView({ factions, catalog, route: "gang", horizonSec: 100_000, moneyAvailable: 1e15, owned: new Set([NEUROFLUX]) }),
      blockers,
    );
    expect(labyrinth.intent?.faction).toBe("CyberSec");
    expect(daedalus.intent?.faction).toBe("Daedalus");
    expect(gang.intent?.faction).toBe("Daedalus");
  });

  test("does not select a faction whose requirement owner is unavailable", () => {
    const blocked: FactionStanding = standing("The Dark Army", { hacking: true, field: false, security: false });
    blocked.joined = false;
    blocked.requirements = [{ type: "city", city: "Chongqing" } as PlayerRequirement];
    const selection = stepFactions(
      factionsView({
        factions: [blocked],
        catalog: new Map([["A", aug("A", { factions: [blocked.name], mults: { hacking: 2 } })]]),
        availableOwners: new Set(["hacking", "factions", "progression"]),
        horizonSec: 100_000,
        moneyAvailable: 1e15,
      }),
      initFactionMemory(),
    );
    expect(selection.decision.objective?.intent).toBeUndefined();
    expect(selection.decision.action.type).toBe("idle");
  });

  test("backdoor ranking includes observed skill and port gates", () => {
    const csec = evaluate(
      { type: "backdoorInstalled", server: "CSEC" },
      view({
        skills: { hacking: 200 },
        portOpeners: 1,
        backdoorAccess: {
          CSEC: { requiredHackingSkill: 1, numOpenPortsRequired: 1, openPortCount: 0 },
        },
      }),
    )[0]!;
    const run4 = evaluate(
      { type: "backdoorInstalled", server: "run4theh111z" },
      view({
        skills: { hacking: 200 },
        portOpeners: 1,
        backdoorAccess: {
          run4theh111z: { requiredHackingSkill: 505, numOpenPortsRequired: 5, openPortCount: 0 },
        },
      }),
    )[0]!;
    expect(estimateBlockerSec(csec, 0)).toBe(300);
    expect(estimateBlockerSec(run4, 0)).toBe(11_850);
  });

  test("backdoor ranking prefers driver-priced install and skill-wait estimates", () => {
    const priced = evaluate(
      { type: "backdoorInstalled", server: "CSEC" },
      view({
        skills: { hacking: 200 },
        portOpeners: 1,
        backdoorAccess: {
          // hackTime/4 at the acting skill, and a measured exp-rate wait —
          // both precomputed by the driver; the interpreter only adds gates.
          CSEC: { requiredHackingSkill: 1, numOpenPortsRequired: 1, openPortCount: 0, installSec: 12.5, skillWaitSec: 0 },
        },
      }),
    )[0]!;
    expect(estimateBlockerSec(priced, 0)).toBe(12.5);

    // Partially priced: a measured install with an unmeasured wait falls back
    // to the nominal per-level constant for the wait component only.
    const partial = evaluate(
      { type: "backdoorInstalled", server: "run4theh111z" },
      view({
        skills: { hacking: 200 },
        portOpeners: 1,
        backdoorAccess: {
          run4theh111z: { requiredHackingSkill: 505, numOpenPortsRequired: 5, openPortCount: 0, installSec: 900 },
        },
      }),
    )[0]!;
    expect(estimateBlockerSec(partial, 0)).toBe(900 + 305 * 30 + 4 * 600);
  });

  test("does not horizon-filter the terminal package out of its own route", () => {
    const daedalus = packageStanding("Daedalus");
    const catalog = new Map([
      ["The Red Pill", aug("The Red Pill", {
        factions: ["Daedalus"],
        baseCost: 0,
        baseRepRequirement: 2_500_000,
      })],
    ]);
    const selection = selectFactionPlan(
      factionsView({
        factions: [daedalus],
        catalog,
        route: "daedalus",
        // Deliberately much shorter than the package ETA. This represents
        // estimator disagreement, not a reason to abandon the chosen route.
        horizonSec: 1,
        moneyAvailable: 1e15,
      }),
      new Map([["Daedalus", []]]),
    );
    expect(selection.intent?.augmentations).toContain("The Red Pill");
    expect(selection.horizonStarved).toBeUndefined();
  });

  test("horizonStarved means DROPPED, not merely discounted", () => {
    const catalog = new Map([
      ["Neurotrainer I", aug("Neurotrainer I", {
        factions: ["CyberSec"],
        baseCost: 0,
        baseRepRequirement: 1_000,
      })],
    ]);
    // The package repays well outside the horizon but keeps over half its
    // value realizable, so it is discounted and still selectable. A selectable
    // package is not starvation — the install verdict must not be told the
    // frontier was filtered empty.
    const discounted = selectFactionPlan(
      factionsView({
        factions: [packageStanding("CyberSec")],
        catalog,
        horizonSec: 300,
        moneyAvailable: 1e15,
      }),
      new Map([["CyberSec", []]]),
    );
    expect(discounted.intent?.augmentations).toContain("Neurotrainer I");
    // Genuinely inside the discount band: past the horizon, but under twice it.
    expect(discounted.intent!.etaSec).toBeGreaterThan(300);
    expect(discounted.intent!.etaSec).toBeLessThanOrEqual(600);
    expect(discounted.horizonStarved).toBeUndefined();

    // Far enough out that under half the value is realizable: dropped as
    // noise, nothing left to select, and THAT is starvation.
    const dropped = selectFactionPlan(
      factionsView({
        factions: [packageStanding("CyberSec")],
        catalog,
        horizonSec: 1,
        moneyAvailable: 1e15,
      }),
      new Map([["CyberSec", []]]),
    );
    expect(dropped.intent).toBeUndefined();
    expect(dropped.horizonStarved).toBe(true);
  });

  test("builds Daedalus invite prerequisites before making Red Pill mandatory", () => {
    const daedalus = packageStanding("Daedalus", {
      joined: false,
      invited: false,
      requirements: [{ type: "numAugmentations", numAugmentations: 30 }],
    });
    const cybersec = packageStanding("CyberSec");
    const catalog = new Map([
      ["The Red Pill", aug("The Red Pill", {
        factions: ["Daedalus"],
        baseCost: 0,
        baseRepRequirement: 2_500_000,
      })],
      ["Count builder", aug("Count builder", {
        factions: ["CyberSec"],
        baseCost: 0,
        baseRepRequirement: 100,
        mults: { hacking: 1.1 },
      })],
    ]);
    const selection = selectFactionPlan(
      factionsView({
        factions: [daedalus, cybersec],
        catalog,
        route: "daedalus",
        horizonSec: 1_000,
        moneyAvailable: 1e15,
        requirementView: view({ augCount: 10 }),
      }),
      new Map([
        ["Daedalus", blockersFor(daedalus, factionsView({ requirementView: view({ augCount: 10 }) }))],
        ["CyberSec", []],
      ]),
    );
    expect(selection.intent?.faction).toBe("CyberSec");
    expect(selection.intent?.augmentations).toContain("Count builder");
  });

  test("preempts an optional latched package when the selected route's Red Pill becomes actionable", () => {
    const cybersec = packageStanding("CyberSec");
    const daedalus = packageStanding("Daedalus", {
      joined: false,
      invited: false,
      requirements: [{ type: "numAugmentations", numAugmentations: 30 }],
    });
    const catalog = new Map([
      ["optional", aug("optional", { factions: ["CyberSec"], baseCost: 0, baseRepRequirement: 100_000 })],
      ["The Red Pill", aug("The Red Pill", {
        factions: ["Daedalus"], baseCost: 0, baseRepRequirement: 2_500_000,
      })],
    ]);
    const first = stepFactions(
      factionsView({
        factions: [cybersec, daedalus], catalog, route: "daedalus",
        horizonSec: 100_000, moneyAvailable: 1e15,
        requirementView: view({ augCount: 10 }),
      }),
      initFactionMemory(),
    );
    expect(first.decision.objective?.intent?.faction).toBe("CyberSec");

    const actionable = stepFactions(
      factionsView({
        factions: [cybersec, { ...daedalus, joined: true }], catalog, route: "daedalus",
        horizonSec: 100_000, moneyAvailable: 1e15,
        requirementView: view({ augCount: 30 }),
      }),
      first.memory,
    );
    expect(actionable.decision.objective?.intent?.faction).toBe("Daedalus");
    expect(actionable.decision.objective?.intent?.augmentations).toContain("The Red Pill");
    expect(actionable.decision.action).toMatchObject({ type: "workForFaction", faction: "Daedalus" });
  });

  test("refreshes a latched package's estimates after its faction is joined", () => {
    const locked = packageStanding("Daedalus", {
      joined: false,
      invited: false,
      requirements: [{ type: "money", money: 100_000 }],
    });
    const catalog = new Map([
      ["The Red Pill", aug("The Red Pill", {
        factions: ["Daedalus"],
        baseCost: 0,
        baseRepRequirement: 2_500_000,
      })],
    ]);
    const first = stepFactions(
      factionsView({
        factions: [locked],
        catalog,
        route: "daedalus",
        horizonSec: Infinity,
        moneyAvailable: 0,
        requirementView: view({ money: 0 }),
      }),
      initFactionMemory(),
    );
    expect(first.decision.objective?.intent?.unlockSec).toBeGreaterThan(0);

    const joined = stepFactions(
      factionsView({
        time: 30_000,
        factions: [{ ...locked, joined: true }],
        catalog,
        route: "daedalus",
        horizonSec: Infinity,
        moneyAvailable: 0,
        requirementView: view({ money: 0 }),
      }),
      first.memory,
    );
    expect(joined.decision.objective?.intent?.repTarget).toBe(2_500_000);
    expect(joined.decision.objective?.intent?.unlockSec).toBe(0);
    expect(joined.decision.objective?.intent?.etaSec).toBeLessThan(
      first.decision.objective!.intent!.etaSec,
    );
  });

  test("repeat NeuroFlux yields the work frontier to missing distinct count slots", () => {
    const joined = packageStanding("A", { joined: true, rep: 0 });
    const unjoined = packageStanding("B", { joined: false, invited: true, rep: 0 });
    const neuroflux = aug(NEUROFLUX, {
      factions: ["A", "B"],
      baseCost: 750_000,
      baseRepRequirement: 500,
      mults: { hacking: 1.01, faction_rep: 1.01 },
    });
    const world = factionsView({
      factions: [joined, unjoined],
      catalog: new Map([[NEUROFLUX, neuroflux]]),
      owned: new Set([NEUROFLUX]),
      targetAugCount: 30,
      horizonSec: 100_000,
      moneyAvailable: 1e15,
    });
    const selection = selectFactionPlan(world, new Map([["A", []], ["B", []]]));
    expect(selection.intent).toBeUndefined();

    // Once the finite gate is complete, another NFG level is ordinary
    // multiplier value again. Routes without a count gate behave the same.
    const completed = selectFactionPlan({
      ...world,
      targetAugCount: 1,
    }, new Map([["A", []], ["B", []]]));
    expect(completed.intent?.faction).toBe("A");
    expect(completed.intent?.augmentations).toEqual([NEUROFLUX]);
    expect(completed.intent!.value).toBeGreaterThan(0);
    expect(completed.intent!.purchaseCost).toBeGreaterThan(0);

    const openEnded = selectFactionPlan({
      ...world,
      targetAugCount: Infinity,
    }, new Map([["A", []], ["B", []]]));
    expect(openEnded.intent?.augmentations).toEqual([NEUROFLUX]);
  });

  test("The Red Pill is valued at the horizon its route cannot finish without", () => {
    const factions = [packageStanding("Daedalus")];
    const catalog = new Map([["The Red Pill", aug("The Red Pill", {
      factions: ["Daedalus"], baseCost: 0, baseRepRequirement: 100,
    })]]);
    const frontier = (route: FactionsView["route"], horizonSec: number) =>
      selectFactionPlan(
        factionsView({ factions, catalog, route, horizonSec, moneyAvailable: 1e15, targetAugCount: Infinity }),
        new Map(factions.map((faction) => [faction.name, []])),
      ).frontiers.get("Daedalus")?.[0];

    // Priced in the same BN-seconds as every multiplier beside it, so a longer
    // remaining run makes the thing that ends it worth proportionally more.
    expect(frontier("daedalus", 100_000)?.value).toBeGreaterThan(frontier("daedalus", 10_000)!.value);
    // ...and it is worth that to the routes that REQUIRE it, not to a
    // Bladeburner run that would be dragged through an unrelated faction.
    expect(frontier("bladeburner", 100_000)?.value ?? 0).toBe(0);
  });

  test("an augmentation with no multipliers is worth its count slot and nothing more", () => {
    // CashRoot carried a hand-set `0.5` "bootstrap value" for its one-off $1m
    // and free port opener. Both effects are real and neither had a unit; the
    // opener is priced where it lands (the server-access needs the board posts
    // for it) rather than restated as another number nobody derived.
    const factions = [packageStanding("Sector-12"), packageStanding("CyberSec")];
    const catalog = new Map([
      ["CashRoot Starter Kit", aug("CashRoot Starter Kit", {
        factions: ["Sector-12"],
        baseCost: 12_500_000,
        baseRepRequirement: 12_500,
      })],
      ["quick", aug("quick", {
        factions: ["CyberSec"],
        baseCost: 1,
        baseRepRequirement: 100,
        mults: { hacking: 1.5 },
      })],
    ]);
    const blockers = new Map(factions.map((faction) => [faction.name, []]));
    // Only the count gate is priced here, so the frontier isolates slot value
    // from the favor breakpoints that would otherwise dominate it.
    const countOnly = { best: new Map(), worth: new Map([["augmentations", 30], ["hacking", 10]]) };
    const bootstrap = selectFactionPlan(
      factionsView({ factions, catalog, horizonSec: 100_000, moneyAvailable: 1e15, rates: countOnly }),
      blockers,
    );
    expect(bootstrap.intent?.faction).toBe("CyberSec");
    const cashRoot = bootstrap.frontiers.get("Sector-12")?.find((pkg) =>
      pkg.augmentations.includes("CashRoot Starter Kit"));
    // A finite Daedalus gate makes it one real slot.
    expect(cashRoot?.value).toBeGreaterThan(0);
    const noCount = selectFactionPlan(
      factionsView({
        factions,
        catalog,
        route: "bladeburner",
        targetAugCount: Infinity,
        horizonSec: 100_000,
        moneyAvailable: 1e15,
        rates: countOnly,
      }),
      blockers,
    );
    const noCountCashRoot = noCount.frontiers.get("Sector-12")?.find((pkg) =>
      pkg.augmentations.includes("CashRoot Starter Kit"));
    // With no count gate there is no slot either, and no multipliers to value.
    expect(noCountCashRoot?.value ?? 0).toBe(0);

    const established = selectFactionPlan(
      factionsView({
        factions,
        catalog,
        horizonSec: 100_000,
        moneyAvailable: 1e15,
        requirementView: { ...view(), files: new Set(["BruteSSH.exe"]) },
      }),
      blockers,
    );
    expect(established.intent?.faction).toBe("CyberSec");

    const installed = selectFactionPlan(
      factionsView({
        factions,
        catalog,
        horizonSec: 100_000,
        moneyAvailable: 1e15,
        owned: new Set(["CashRoot Starter Kit"]),
        requirementView: { ...view(), files: new Set(["BruteSSH.exe"]) },
      }),
      blockers,
    );
    expect(installed.intent?.faction).toBe("CyberSec");
  });

  test("count pressure versus multiplier quality is decided by measurement, not a ramp", () => {
    // The predecessor RAMPED this: count worth 1 unit per slot early, decaying
    // to a 1/5 floor near closure so quality would break the closing ties.
    // Both halves were a policy nobody measured. Which of the two matters is
    // now whatever the route says it is — and on a route that is genuinely
    // gated on augmentation COUNT, filling a slot sooner really is worth more
    // than a 30% hacking multiplier.
    const factions = [packageStanding("cheap"), packageStanding("quality")];
    const catalog = new Map([
      ["cheap-slot", aug("cheap-slot", { factions: ["cheap"], baseCost: 0, baseRepRequirement: 100 })],
      ["quality-slot", aug("quality-slot", {
        factions: ["quality"], baseCost: 0, baseRepRequirement: 150, mults: { hacking: 1.3 },
      })],
    ]);
    const blockers = new Map(factions.map((faction) => [faction.name, []]));
    const pick = (worth: [string, number][], owned = new Set<string>()) => selectFactionPlan(
      factionsView({
        factions, catalog, owned, horizonSec: 100_000, moneyAvailable: 1e15,
        rates: { best: new Map(), worth: new Map(worth) },
      }),
      blockers,
    ).intent?.faction;

    const nearlyClosed = new Set(Array.from({ length: 26 }, (_, index) => `installed-${index}`));
    // Count-gated: the cheaper slot is reachable sooner and closes the gate.
    expect(pick([["augmentations", 30_000], ["hacking", 10]])).toBe("cheap");
    expect(pick([["augmentations", 30_000], ["hacking", 10]], nearlyClosed)).toBe("cheap");
    // Multiplier-gated — a route with no finite count gate to close, or one
    // whose remaining climb dwarfs it: quality wins at either end.
    expect(pick([["hacking", 30_000]])).toBe("quality");
    expect(pick([["hacking", 30_000]], nearlyClosed)).toBe("quality");
  });

  test("enemy membership blocks only this install cycle", () => {
    const west = packageStanding("Sector-12", { enemies: ["Chongqing"] });
    const east = packageStanding("Chongqing", { joined: false, enemies: ["Sector-12"] });
    const catalog = new Map([
      ["East aug", aug("East aug", { factions: ["Chongqing"], baseCost: 0, baseRepRequirement: 100 })],
    ]);
    const thisCycle = factionsView({ factions: [west, east], catalog, horizonSec: 100_000 });
    expect(factionPackageFrontier(east, [], thisCycle)).toEqual([]);

    const nextCycleWest = { ...west, joined: false };
    const nextCycle = factionsView({ factions: [nextCycleWest, east], catalog, horizonSec: 100_000 });
    expect(factionPackageFrontier(east, [], nextCycle).length).toBeGreaterThan(0);
  });

  test("pushes past the pre-join breakpoint when joining forecloses the alternative", () => {
    // WAS: "keeps the pre-join stopping point when joining forecloses the
    // runner-up". Both names describe the same trap from opposite sides. A and
    // B ban each other, so committing to A means B will not happen this cycle —
    // and the old selector nonetheless priced A's next breakpoint against
    // switching to B, stopped at the shallow one, and then had no runner to
    // switch to. Stopping to preserve an option that no longer exists is not
    // caution. With B excluded from the set by the enemy constraint, A's deeper
    // breakpoint is measured against ending the cycle, and wins.
    const { firstA, firstB, catalog, first } = enemyChoice();
    expect(first.decision.objective?.intent?.repTarget).toBe(1_000);
    expect(first.decision.objective?.factions).not.toContain("B");

    const afterJoin = stepFactions(
      factionsView({
        factions: [
          { ...firstA, joined: true, invited: false, rep: 100 },
          { ...firstB, invited: false },
        ],
        catalog,
        owned: new Set(["A-fast"]),
        queued: new Set(["A-fast"]),
        horizonSec: 100_000,
        moneyAvailable: 1e15,
      }),
      first.memory,
    );
    expect(afterJoin.decision.objective?.intent?.repTarget).toBe(1_000);
    expect(afterJoin.decision.objective?.intent?.augmentations).toContain("A-deep");
  });

  test("does not install when the completed package is already installed", () => {
    const { firstA, firstB, catalog, first } = enemyChoice();
    const afterJoin = stepFactions(
      factionsView({
        factions: [
          { ...firstA, joined: true, invited: false, rep: 100 },
          { ...firstB, invited: false },
        ],
        catalog,
        owned: new Set(["A-fast"]),
        horizonSec: 100_000,
        moneyAvailable: 1e15,
      }),
      first.memory,
    );
    expect(afterJoin.decision.recommendInstall).toBeUndefined();
  });

  test("drains other joined factions from highest priority downward before install", () => {
    const { firstA, firstB, catalog: baseCatalog, first } = enemyChoice();
    const catalog = new Map(baseCatalog);
    catalog.set("low", aug("low", { factions: ["C"], baseCost: 1, baseRepRequirement: 0, mults: { hacking: 1.1 } }));
    catalog.set("high", aug("high", { factions: ["C"], baseCost: 1, baseRepRequirement: 0, mults: { hacking: 2 } }));
    // A's ladder is owned out, so the committed SET really is complete and the
    // drain is the state under test. Leaving A-deep unowned no longer reaches
    // it: the plan is a portfolio now, and a portfolio with reputation work
    // still outstanding at one member is not a concluded cycle — purchases stay
    // end-loaded behind it, which is the whole point of end-loading.
    const afterJoin = stepFactions(
      factionsView({
        factions: [
          { ...firstA, joined: true, invited: false, rep: 100 },
          { ...firstB, invited: false },
          packageStanding("C", { rep: 1e9 }),
        ],
        catalog,
        owned: new Set(["A-fast", "A-deep"]),
        queued: new Set(["A-fast"]),
        horizonSec: 100_000,
        moneyAvailable: 1e15,
        moneyGranted: 1e15,
      }),
      first.memory,
    );
    expect(afterJoin.decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: "high", faction: "C" });
    expect(afterJoin.decision.recommendInstall).toBeUndefined();
  });

  test("the final sweep donates only while preserving the unlocked purchase", () => {
    const { firstA, firstB, catalog: baseCatalog, first } = enemyChoice();
    const catalog = new Map(baseCatalog);
    catalog.set("last", aug("last", { factions: ["C"], baseCost: 1_000_000, baseRepRequirement: 1_000 }));
    const afterJoin = stepFactions(
      factionsView({
        factions: [
          { ...firstA, joined: true, invited: false, rep: 100 },
          { ...firstB, invited: false },
          packageStanding("C", { rep: 0, favor: 150 }),
        ],
        catalog,
        // As above: the set must be complete for the final sweep to be the
        // state under test.
        owned: new Set(["A-fast", "A-deep"]),
        queued: new Set(["A-fast"]),
        horizonSec: 100_000,
        moneyAvailable: 1_001_000_000,
        moneyGranted: 0,
      }),
      first.memory,
    );
    expect(afterJoin.decision.action).toMatchObject({
      type: "donate",
      faction: "C",
      amount: 1_000_000_000,
      purchaseCost: 1_000_000,
    });
  });

  test("creates exact favor breakpoints only while future augmentations remain", () => {
    const faction = packageStanding("A", { rep: 0, favor: 0 });
    const future = aug("Future", { factions: ["A"], baseCost: 0, baseRepRequirement: 1e9 });
    const world = factionsView({
      factions: [faction],
      catalog: new Map([[future.name, future]]),
      favorToDonate: 5,
      horizonSec: 100_000,
    });
    const frontier = factionPackageFrontier(faction, [], world);
    expect(frontier.some((pkg) => pkg.purpose === "favor" && pkg.favorAfterInstall >= 1)).toBe(true);

    const finished = factionsView({ ...world, owned: new Set([future.name]) });
    expect(factionPackageFrontier(faction, [], finished)).toEqual([]);
  });

  test("bounds smooth favor sampling when a noisy horizon is enormous", () => {
    const faction = packageStanding("A", { rep: 0, favor: 0 });
    const future = aug("Distant", { factions: ["A"], baseCost: 0, baseRepRequirement: 1e15 });
    const frontier = factionPackageFrontier(
      faction,
      [],
      factionsView({ factions: [faction], catalog: new Map([[future.name, future]]), horizonSec: 1e15 }),
    );
    // One augmentation breakpoint, at most eight smooth samples, plus the exact
    // donation discontinuity (which can coincide with a sample).
    expect(frontier.length).toBeLessThanOrEqual(10);
  });

  test("can push favor beyond donation unlock when the faction still dominates", () => {
    const faction = packageStanding("A", { favor: 5 });
    const future = aug("Future", { factions: ["A"], baseCost: 0, baseRepRequirement: 1e9 });
    const frontier = factionPackageFrontier(
      faction,
      [],
      factionsView({
        factions: [faction],
        catalog: new Map([[future.name, future]]),
        favorToDonate: 5,
        horizonSec: 100_000,
      }),
    );
    expect(frontier.some((pkg) => pkg.purpose === "favor" && pkg.favorAfterInstall > 5)).toBe(true);
  });

  test("publishes the exact donation even before its arbiter grant arrives", () => {
    const faction = packageStanding("A", { favor: 150 });
    const wanted = aug("Wanted", { factions: ["A"], baseCost: 0, baseRepRequirement: 1_000 });
    const { decision } = stepFactions(
      factionsView({
        factions: [faction],
        catalog: new Map([[wanted.name, wanted]]),
        horizonSec: 100_000,
        incomePerSec: 10_000_000,
        moneyAvailable: 1,
        moneyGranted: 0,
      }),
      initFactionMemory(),
    );
    expect(decision.action).toMatchObject({ type: "donate", faction: "A", amount: 1_000_000_000 });
  });

  test("travels to New Tokyo, then protects a worthwhile graft until completion", () => {
    const faction = packageStanding("CyberSec", { rep: 0 });
    const wanted = aug("Graft target", {
      factions: ["CyberSec"],
      baseCost: 10_000_000,
      baseRepRequirement: 1_000_000,
      mults: { hacking: 100 },
    });
    const base = factionsView({
      factions: [faction],
      catalog: new Map([[wanted.name, wanted]]),
      graftable: [{ name: wanted.name, price: 10_000_000, timeMs: 60_000 }],
      moneyAvailable: 10_000_000,
      moneyGranted: 10_000_000,
      horizonSec: 1_000_000,
      favorToDonate: 0,
    });
    const first = stepFactions(base, initFactionMemory());
    expect(first.decision.action).toMatchObject({ type: "travelTo", city: "New Tokyo" });

    const started = stepFactions(
      { ...base, requirementView: { ...base.requirementView, city: "New Tokyo" } },
      first.memory,
    );
    expect(started.decision.action).toMatchObject({ type: "graft", augmentation: wanted.name });

    const running = stepFactions(
      { ...base, currentWork: { kind: "grafting", detail: wanted.name, focused: false } },
      started.memory,
    );
    expect(running.decision.action).toMatchObject({ type: "idle", reason: "continue" });
  });
});

describe("the last-chance drain", () => {
  // THE BUG: the driver's `aug-fund` money claim was derived from
  // `plan.objective.augmentations`. By the time the drain runs the objective is
  // complete, so there was no objective augmentation, no claim, no grant — and
  // `nextPurchase` tests the GRANTED budget, so it bought nothing. Every install
  // silently threw away the cash on hand, and once the install barrier started
  // blocking on "an augmentation is still purchasable" the run deadlocked
  // outright: progression waited for a purchase that factions was never funded to
  // make. The decision has to publish what it WOULD buy so a claim can be derived
  // from the plan rather than from the already-funded action.
  const nfg = aug(NEUROFLUX, { baseCost: 750_000, baseRepRequirement: 0, factions: ["CyberSec"] });
  const owned = aug("Owned Thing", { factions: ["CyberSec"] });

  function drained(over: Partial<FactionsView> = {}) {
    return stepFactions(
      factionsView({
        factions: [standing("CyberSec", { hacking: true, field: true, security: true })],
        catalog: new Map([[NEUROFLUX, nfg], ["Owned Thing", owned]]),
        owned: new Set(["Owned Thing"]),
        // A non-empty queue is what makes an install worth recommending at all.
        queued: new Set(["Owned Thing"]),
        moneyGranted: 0,
        moneyAvailable: 1e9,
        ...over,
      }),
      initFactionMemory(),
    ).decision;
  }

  test("publishes what it would buy even when nothing has been granted yet", () => {
    const decision = drained();
    expect(decision.drainCeiling).toBeDefined();
    // Unfunded, so it cannot act — but it says what the money is for.
    expect(decision.action.type).toBe("purchaseAugmentation");
    expect(decision.nextBuy).toMatchObject({ name: NEUROFLUX });
    expect(decision.nextBuy!.price).toBeGreaterThan(0);
  });

  test("the published price is what the purchase will actually cost", () => {
    const decision = drained();
    const expected = augCost(nfg, priceCtx()).moneyCost;
    expect(decision.nextBuy!.price).toBeCloseTo(expected, 6);
  });

  test("drops favor-only work once the route is locked into its final count batch", () => {
    const faction = {
      ...standing("A", { hacking: true, field: false, security: false }),
      rep: 100,
      favor: 10,
    };
    const owned = aug("already unlocked", {
      factions: ["A"], baseCost: 0, baseRepRequirement: 100, mults: { hacking: 1.1 },
    });
    const future = aug("future", {
      factions: ["A"], baseCost: 0, baseRepRequirement: 200, mults: { hacking: 1.1 },
    });
    const world = factionsView({
      factions: [faction],
      catalog: new Map([[owned.name, owned], [future.name, future]]),
      owned: new Set([owned.name]),
      targetAugCount: 30,
      requirementView: { ...view(), augCount: 15 },
      horizonSec: 10_000,
    });
    const frontier = factionPackageFrontier(faction, [], world);
    expect(frontier.every((pkg) => pkg.purpose === "augmentations")).toBe(true);
  });

  test("does not unlock an unjoined faction for favor alone", () => {
    const faction: FactionStanding = {
      ...standing("Deep", { hacking: true, field: false, security: false }),
      joined: false,
      invited: false,
    };
    const future = aug("Future", { factions: ["Deep"], baseCost: 1e12, baseRepRequirement: 1e9 });
    const frontier = factionPackageFrontier(
      faction,
      [{
        kind: "backdoor",
        subject: "deep-server",
        target: 1,
        have: 0,
        progress: 0,
        owner: "hacking",
        reachable: true,
      }],
      factionsView({
        factions: [faction],
        catalog: new Map([[future.name, future]]),
        horizonSec: 10_000,
        moneyAvailable: 0,
      }),
    );
    expect(frontier.every((pkg) => pkg.augmentations.length > 0)).toBe(true);
  });

  test("a route-mandatory install still drains an affordable NeuroFlux at a short horizon", () => {
    const decision = drained({ horizonSec: 1, routeInstallRequired: true, targetAugCount: Infinity });
    expect(decision.nextBuy).toMatchObject({ name: NEUROFLUX });
  });

  test("a Daedalus count-finishing sweep chooses count before multiplier value", () => {
    const cheap = aug("cheap count", { baseCost: 1e6, baseRepRequirement: 0, factions: ["CyberSec"] });
    const valuable = aug("valuable but dear", {
      baseCost: 100e6,
      baseRepRequirement: 0,
      factions: ["CyberSec"],
      mults: { hacking: 10 },
    });
    const decision = drained({
      catalog: new Map([["cheap count", cheap], ["valuable but dear", valuable], ["Owned Thing", owned]]),
      routeInstallRequired: true,
      targetAugCount: 2,
      moneyGranted: 100e6,
      moneyAvailable: 100e6,
    });
    expect(decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: "cheap count" });
  });

  test("a funded cheap closure is not displaced by a smaller valuable set", () => {
    const cheapA = aug("cheap A", { baseCost: 1e6, baseRepRequirement: 0, factions: ["CyberSec"] });
    const cheapB = aug("cheap B", { baseCost: 1e6, baseRepRequirement: 0, factions: ["CyberSec"] });
    const valuable = aug("valuable singleton", {
      baseCost: 2e6,
      baseRepRequirement: 0,
      factions: ["CyberSec"],
      mults: { hacking: 100 },
    });
    const result = stepFactions(factionsView({
      factions: [standing("CyberSec", { hacking: true, field: true, security: true })],
      catalog: new Map([
        [cheapA.name, cheapA],
        [cheapB.name, cheapB],
        [valuable.name, valuable],
        ["Owned Thing", owned],
      ]),
      owned: new Set(["Owned Thing"]),
      queued: new Set(),
      routeInstallRequired: true,
      installRequested: true,
      targetAugCount: 3,
      moneyGranted: 3e6,
      moneyAvailable: 3e6,
    }), {
      ...initFactionMemory(),
      bankedAugmentations: [cheapA.name, cheapB.name],
    });
    const decision = result.decision;
    expect(new Set(result.memory.drainOrder)).toEqual(new Set([cheapA.name, cheapB.name]));
    expect(decision.action).toMatchObject({ type: "purchaseAugmentation" });
  });

  test("a mandatory funded count closure preempts an unfinished optional package", () => {
    const cheapA = aug("banked A", { baseCost: 1e6, baseRepRequirement: 0, factions: ["CyberSec"] });
    const cheapB = aug("banked B", { baseCost: 1e6, baseRepRequirement: 0, factions: ["CyberSec"] });
    const deep = aug("deep optional", {
      baseCost: 1e6,
      baseRepRequirement: 100_000,
      factions: ["CyberSec"],
      mults: { hacking: 10 },
    });
    const standingView = standing("CyberSec", { hacking: true, field: true, security: true });
    const catalog = new Map([
      [cheapA.name, cheapA],
      [cheapB.name, cheapB],
      [deep.name, deep],
      ["Owned Thing", owned],
    ]);
    const first = stepFactions(factionsView({
      factions: [standingView],
      catalog,
      owned: new Set(["Owned Thing", cheapA.name, cheapB.name]),
      moneyAvailable: 3e6,
    }), initFactionMemory());
    expect(first.decision.action).toMatchObject({ type: "workForFaction" });

    const closing = stepFactions(factionsView({
      time: 30_000,
      factions: [standingView],
      catalog,
      owned: new Set(["Owned Thing"]),
      targetAugCount: 3,
      routeInstallRequired: true,
      installRequested: true,
      moneyAvailable: 3e6,
      moneyGranted: 3e6,
    }), {
      ...first.memory,
      bankedAugmentations: [cheapA.name, cheapB.name],
    });
    expect(closing.decision.action).toMatchObject({ type: "purchaseAugmentation" });
    expect(new Set(closing.memory.drainOrder)).toEqual(new Set([cheapA.name, cheapB.name]));
  });

  test("a projected count package waits when the affordable frozen set is one slot short", () => {
    const cheap = aug("cheap count", { baseCost: 1e6, baseRepRequirement: 0, factions: ["CyberSec"] });
    const unaffordable = aug("banked but unfunded", {
      baseCost: 1e12,
      baseRepRequirement: 0,
      factions: ["CyberSec"],
    });
    const result = stepFactions(factionsView({
      factions: [standing("CyberSec", { hacking: true, field: true, security: true })],
      catalog: new Map([[cheap.name, cheap], [unaffordable.name, unaffordable], ["Owned Thing", owned]]),
      owned: new Set(["Owned Thing"]),
      queued: new Set(),
      targetAugCount: 3,
      routeInstallRequired: true,
      installRequested: true,
      moneyAvailable: 1e6,
      moneyGranted: 1e6,
    }), {
      ...initFactionMemory(),
      bankedAugmentations: [cheap.name, unaffordable.name],
    });

    expect(result.decision.recommendInstall).toBeUndefined();
    expect(result.decision.drainCeiling).toBeUndefined();
    expect(result.decision.action.type).not.toBe("purchaseAugmentation");
  });

  test("keeps publishing while the purchase is in flight, so the claim cannot blink out", () => {
    // If `drain` only appeared on the idle tick, the claim would vanish the moment
    // a purchase was decided, un-funding the very action it authorised.
    const decision = drained({ moneyGranted: 1e9 });
    expect(decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: NEUROFLUX });
    expect(decision.nextBuy).toMatchObject({ name: NEUROFLUX });
  });

  test("consumes each frozen NeuroFlux occurrence only after its level appears", () => {
    const base = factionsView({
      factions: [standing("CyberSec", { hacking: true, field: true, security: true })],
      catalog: new Map([[NEUROFLUX, nfg], ["Owned Thing", owned]]),
      owned: new Set(["Owned Thing"]),
      queued: new Set(["Owned Thing"]),
      moneyAvailable: 1e9,
      moneyGranted: 1e9,
    });
    const first = stepFactions(base, initFactionMemory());
    expect(first.memory.drainOrder?.filter((name) => name === NEUROFLUX).length).toBeGreaterThan(1);
    expect(first.memory.drainStartNeurofluxLevel).toBe(0);

    const confirmed = stepFactions({
      ...base,
      queued: new Set(["Owned Thing", NEUROFLUX]),
      priceContext: priceCtx({ queuedNonSoA: 1, neurofluxLevel: 1 }),
      moneyAvailable: 1e9 - first.decision.nextBuy!.price,
    }, first.memory);
    expect(confirmed.memory.drainOrder).toEqual(first.memory.drainOrder);
    expect(confirmed.decision.nextBuy).toMatchObject({ name: NEUROFLUX });
    expect(confirmed.decision.nextBuy!.price).toBeGreaterThan(first.decision.nextBuy!.price);
  });

  test("does not resurrect a purchase that outgrew the frozen drain ceiling", () => {
    const base = factionsView({
      factions: [standing("CyberSec", { hacking: true, field: true, security: true })],
      catalog: new Map([[NEUROFLUX, nfg], ["Owned Thing", owned]]),
      owned: new Set(["Owned Thing"]),
      queued: new Set(["Owned Thing"]),
      moneyAvailable: 1e6,
      moneyGranted: 0,
    });
    const first = stepFactions(base, initFactionMemory());
    expect(first.decision.drainCeiling).toBe(1e6);
    const escalated = stepFactions({
      ...base,
      moneyAvailable: 1e9,
      priceContext: { ...base.priceContext, neurofluxLevel: 30 },
    }, first.memory);
    expect(escalated.decision.drainCeiling).toBe(1e6);
    expect(escalated.decision.nextBuy).toBeUndefined();
  });

  test("nothing is published when the run is not ending", () => {
    // No queued augmentations means no install to drain for, and claiming money
    // here would starve the objective it is still saving up for.
    const decision = drained({ queued: new Set() });
    expect(decision.recommendInstall).toBeUndefined();
    expect(decision.nextBuy).toBeUndefined();
  });

  test("the most expensive item is bought first, whatever its value rank", () => {
    // Selection is by value, execution is by price. `dear` scores worse, so value
    // order would buy `best` first and charge the 1.9x escalation to the $500m
    // item instead of to the $1m one.
    const best = aug("best", { baseCost: 1e6, mults: { hacking: 2 }, factions: ["CyberSec"] });
    const dear = aug("dear", { baseCost: 5e8, mults: { hacking: 1.01 }, factions: ["CyberSec"] });
    const decision = drained({
      catalog: new Map([["best", best], ["dear", dear], ["Owned Thing", owned]]),
      factions: [{ ...standing("CyberSec", { hacking: true, field: true, security: true }), rep: 1e9 }],
      moneyGranted: 1e12,
      moneyAvailable: 1e12,
    });
    expect(decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: "dear" });
  });
});

describe("patience — waiting for the bankroll before committing the order", () => {
  // Buying the one augmentation today's cash covers charges the 1.9x queue
  // escalation to the dearer one, permanently. When the dearer one is already paid
  // for by money we merely have not received yet — the market book, which is
  // liquidated before every install — waiting is free and jumping the queue is not.
  const dear = aug("dear", { baseCost: 5e8, baseRepRequirement: 0, mults: { hacking: 1.01 } });
  const cheap = aug("cheap", { baseCost: 1e6, baseRepRequirement: 0, mults: { hacking: 2 } });
  const catalog = new Map([["dear", dear], ["cheap", cheap]]);

  // Income high enough that the package is reachable inside the horizon, so the
  // objective holds BOTH items and the only thing under test is whether we wait.
  function step(over: Partial<FactionsView> = {}) {
    return stepFactions(
      factionsView({
        factions: [{ ...standing("CyberSec", { hacking: true, field: true, security: true }), rep: 1e9 }],
        catalog,
        incomePerSec: 1e6,
        horizonSec: 3_600,
        moneyGranted: 1e6,
        moneyAvailable: 1e6,
        // Something already queued: the FIRST purchase of a run is deliberately
        // never held, so patience is only observable past that point.
        queued: new Set(["already queued"]),
        // A liquidation actually under way. Without this the book is money with no
        // settlement date and is deliberately not waited on — see the livelock test.
        proceedsSettling: true,
        ...over,
      }),
      initFactionMemory(),
    ).decision;
  }

  test("the objective stays in VALUE order; the purchase site reorders it", () => {
    // `cheap` scores better, so it leads the objective — and is nonetheless bought
    // second. Keeping the objective in value order matters: `nextGraft` walks it to
    // pick the most useful item to graft, and the panel presents it as a priority
    // list. Only payment is reordered.
    expect(step().objective?.augmentations).toEqual(["cheap", "dear"]);
    expect(step({ moneyGranted: 1e12, moneyAvailable: 1e12 }).action).toMatchObject({
      type: "purchaseAugmentation",
      augmentation: "dear",
    });
  });

  test("holds out for the dearer item while the book still covers it", () => {
    const decision = step({ pendingProceeds: 6e8, proceedsSettling: true });
    expect(decision.action.type).not.toBe("purchaseAugmentation");
    // ...and it still says what the money is for, so the claim keeps accumulating.
    expect(decision.nextBuy).toMatchObject({ name: "dear" });
  });

  test("buys the cheaper item once nothing is coming to cover the dearer one", () => {
    // Income alone is not a settlement date: it is exactly the open-ended wait that
    // would deadlock against the install barrier. A cheaper augmentation owned beats
    // a dearer one admired.
    const decision = step({ pendingProceeds: 0 });
    expect(decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: "cheap" });
  });

  test("a book too small to close the gap does not buy patience either", () => {
    const decision = step({ pendingProceeds: 1e7, proceedsSettling: true });
    expect(decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: "cheap" });
  });

  test("a book NOBODY IS SELLING buys no patience — the second livelock", () => {
    // `pendingProceeds` counts for planning whenever a book exists, but waiting on it
    // is only sound while it is being converted. Mid-run nothing is being sold, and
    // `factions` not finishing its objective is precisely what stops `stock` from
    // ever being asked to sell — so holding out for those proceeds would hold out for
    // ever, each feature waiting on the other.
    const stuck = step({ pendingProceeds: 6e8, proceedsSettling: false });
    expect(stuck.action).toMatchObject({ type: "purchaseAugmentation", augmentation: "cheap" });
    // The same book, now actually settling, is worth waiting for.
    const settling = step({ pendingProceeds: 6e8, proceedsSettling: true });
    expect(settling.action.type).not.toBe("purchaseAugmentation");
  });

  test("an OPEN horizon does not become infinite patience", () => {
    // `horizonSec` is Infinity when the forecast has no answer. If patience counted
    // income over it, everything would be eventually affordable and the feature
    // would hold out forever — and since `progression` refuses to install while any
    // augmentation is still purchasable, that is a livelock rather than caution.
    const decision = step({ pendingProceeds: 0, horizonSec: Infinity });
    expect(decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: "cheap" });
  });

  test("an empty queue requests liquidation before the first purchase", () => {
    // A separate liquidation signal breaks the empty-queue cycle without
    // buying a cheaper item first and escalating the intended expensive one.
    const bootstrap = step({ queued: new Set(), pendingProceeds: 6e8, proceedsSettling: false, installRequested: true });
    expect(bootstrap.action).toMatchObject({ type: "idle", reason: "waiting" });
    expect(bootstrap.liquidationNeeded).toMatchObject({ augmentation: "dear", pendingProceeds: 6e8 });
    // ...and with one item queued the hold engages, on the very same numbers.
    const held = step({ queued: new Set(["cheap"]), pendingProceeds: 6e8, proceedsSettling: true });
    expect(held.action.type).not.toBe("purchaseAugmentation");
    expect(held.liquidationNeeded).toBeUndefined();
  });

  test("the wait ends when the money lands", () => {
    const decision = step({ moneyGranted: 6e8, moneyAvailable: 6e8, pendingProceeds: 0 });
    expect(decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: "dear" });
  });

  test("reputation shortfalls mean the run is NOT over — work continues, nothing is bought", () => {
    // End-loaded purchasing: while any objective augmentation still needs
    // reputation, the endgame has not begun. The feature keeps working (or
    // idles toward it) rather than buying the cheap item early — an early buy
    // would charge the 1.9x queue escalation to everything the rest of the
    // run still plans to buy.
    //
    // `dear` must be an augmentation this cycle actually COMMITS to, which now
    // takes both a reachable reputation gate and enough value to be worth the
    // grind. Previously any unreachable gate would do, because the planner
    // extended one faction's ladder for as long as nothing else competed — it
    // would spend seven hundred seconds earning favor worth 0.4% more, and the
    // sweep stayed shut as a side effect of that grind rather than because
    // anything was still owed. A budgeted plan declines that trade, so a fixture
    // that relies on it is testing the flaw rather than the invariant.
    const decision = step({
      factions: [{ ...standing("CyberSec", { hacking: true, field: true, security: true }), rep: 1e5 }],
      catalog: new Map([
        ["dear", aug("dear", { baseCost: 5e8, baseRepRequirement: 110_000, mults: { hacking: 3 } })],
        ["cheap", aug("cheap", { baseCost: 1e6, baseRepRequirement: 0, mults: { hacking: 2 } })],
      ]),
      moneyGranted: 1e9,
      moneyAvailable: 1e9,
      pendingProceeds: 1e12,
    });
    expect(decision.action.type).not.toBe("purchaseAugmentation");
    expect(decision.recommendInstall).toBeUndefined();
  });
});

describe("the barrier and the drain converge", () => {
  // Two predicates, not one: `progression` blocks on `nextPurchasableAugmentation`
  // over probed offers and cash, while `factions` buys through `nextPurchase` over
  // the catalogue and the granted budget. They cannot match field-for-field, so what
  // has to hold is that the drain keeps buying until nothing is affordable — a
  // barrier blocking on something factions declines to buy would wedge the run. The
  // mechanism is re-planning: the batch is rebuilt each pass against the cash left.
  const seed = aug("seed", { baseCost: 1e6, baseRepRequirement: 0 });
  const dear = aug("dear", { baseCost: 4e8, baseRepRequirement: 0, mults: { hacking: 2 } });
  const mid = aug("mid", { baseCost: 2e8, baseRepRequirement: 0, mults: { hacking: 1.5 } });
  const cheap = aug("cheap", { baseCost: 1e6, baseRepRequirement: 0, mults: { hacking: 1.1 } });
  const catalog = new Map([["seed", seed], ["dear", dear], ["mid", mid], ["cheap", cheap]]);

  /** Run the drain to a standstill, spending real money at escalating prices. */
  function drainToStandstill(start: number) {
    let money = start;
    // `seed` stands in for an already-queued purchase: `shouldRecommendInstall`
    // filters the queue against the catalogue, so a sentinel name would be dropped
    // and the drain would never engage at all.
    const owned = new Set(["seed"]);
    const bought: { name: string; cost: number }[] = [];

    for (let pass = 0; pass < 12; pass++) {
      const queuedNonSoA = owned.size; // every purchase makes the next dearer
      const { decision } = stepFactions(
        factionsView({
          factions: [{ ...standing("CyberSec", { hacking: true, field: true, security: true }), rep: 1e9 }],
          catalog,
          owned: new Set(owned),
          queued: new Set(["seed"]),
          moneyGranted: money,
          moneyAvailable: money,
          pendingProceeds: 0,
          incomePerSec: 0,
          horizonSec: 60,
          priceContext: priceCtx({ queuedNonSoA }),
        }),
        initFactionMemory(),
      );
      if (decision.action.type !== "purchaseAugmentation") break;
      const name = decision.action.augmentation!;
      const cost = augCost(catalog.get(name)!, priceCtx({ queuedNonSoA })).moneyCost;
      expect(cost, `${name} was bought without the money for it`).toBeLessThanOrEqual(money);
      money -= cost;
      owned.add(name);
      bought.push({ name, cost });
    }
    return { bought, left: money };
  }

  test("it drains to a standstill, dearest first, and never overspends", () => {
    const { bought, left } = drainToStandstill(7e8);
    // `dear` is skipped because at queue depth 1 — `seed` already occupies slot 0 —
    // it costs $760m against a $700m budget, so it is unaffordable rather than
    // merely expensive. Of what IS affordable, the dearest goes first: value order
    // would have taken `cheap`, whose multiplier is the weakest of the three.
    expect(bought.map((b) => b.name)).toEqual(["mid", "cheap"]);
    expect(left).toBeGreaterThanOrEqual(0);
    // It stops because nothing is affordable, NOT because it gave up: `dear` at the
    // resulting queue depth genuinely costs more than the cash left, so the install
    // barrier — which tests the same escalated price against the same cash — cannot
    // block on it either. That agreement is what keeps the two from deadlocking.
    const dearNow = augCost(dear, priceCtx({ queuedNonSoA: 3 })).moneyCost;
    expect(dearNow).toBeGreaterThan(left);
  });

  test("more cash buys strictly more, and still in cost order", () => {
    const rich = drainToStandstill(2e9);
    expect(rich.bought.map((b) => b.name)).toEqual(["dear", "mid", "cheap"]);
    // Each purchase is dearer at its slot than the next, which is the invariant the
    // ordering exists to produce.
    const paid = rich.bought.map((b) => b.cost);
    expect(paid[0]).toBeGreaterThan(paid[2]!);
  });

  test("a drain with nothing affordable buys nothing and does not spin", () => {
    const broke = drainToStandstill(1_000);
    expect(broke.bought).toEqual([]);
    expect(broke.left).toBe(1_000);
  });
});
