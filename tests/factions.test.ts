import { describe, expect, test } from "bun:test";
import type { PlayerRequirement } from "@ns";
import {
  augCost,
  basePriceMultiplier,
  canAfford,
  closePrereqs,
  entropyCost,
  estimatedCost,
  EXACT_ORDER_LIMIT,
  MULTIPLE_AUG_MULTIPLIER,
  NEUROFLUX,
  orderPurchases,
  scoreAug,
  selectAffordableBatch,
  totalCost,
  type AugInfo,
  type PriceContext,
  type PurchaseCandidate,
} from "../shared/strategy/factions/augs.ts";
import { EXACT_SEARCH_LIMIT, foreclosedBy, selectFactions, type FactionCandidate } from "../shared/strategy/factions/objective.ts";
import {
  combinedEtaSec,
  evaluate,
  evaluateAll,
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
      why: "needs 1 manual infiltration",
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

  test("a NeuroFlux chain pays the queue multiplier ONCE, then 1.14 per level", () => {
    // The game's 1.9^queued exponent is queuedAugmentations.length — one entry
    // per NAME with a level field, so ten queued NFG levels contribute exactly
    // one. Simulate the drain's ladder the way the driver evolves the context:
    // one non-NFG aug already queued, then successive NFG purchases.
    const nfg = aug(NEUROFLUX, { baseCost: 750_000, baseRepRequirement: 500 });
    const prices: number[] = [];
    for (let level = 0; level < 5; level++) {
      const ctx = priceCtx({
        // 1 for the pre-queued non-NFG aug, +1 for NFG once any level is queued.
        queuedNonSoA: 1 + (level > 0 ? 1 : 0),
        neurofluxLevel: level,
        ...(level > 0 ? { queuedNeuroflux: true } : {}),
      });
      prices.push(augCost(nfg, ctx).moneyCost);
    }
    // First purchase joins the queue: x1.9 x1.14 = x2.166. Every later level
    // pays only its own 1.14. This is the exact ladder the sim charges
    // (sim/ns/singularity.ts priceOf); the old per-level 1.9 compounding made
    // the drain price itself out ~8 levels early.
    expect(prices[1]! / prices[0]!).toBeCloseTo(1.9 * 1.14, 10);
    expect(prices[2]! / prices[1]!).toBeCloseTo(1.14, 10);
    expect(prices[3]! / prices[2]!).toBeCloseTo(1.14, 10);
    expect(prices[4]! / prices[3]!).toBeCloseTo(1.14, 10);
  });

  test("totalCost counts NeuroFlux into the queue exponent at most once", () => {
    const nfg = aug(NEUROFLUX, { baseCost: 750_000, baseRepRequirement: 500 });
    const order = [
      { name: NEUROFLUX, aug: nfg, faction: "CyberSec" },
      { name: NEUROFLUX, aug: nfg, faction: "CyberSec" },
      { name: NEUROFLUX, aug: nfg, faction: "CyberSec" },
    ];
    // Fresh context: level 0, nothing queued. Expected:
    //   level 0 at 1.9^0, then levels 1 and 2 at 1.9^1 (NFG now queued once).
    const fresh = totalCost(order, priceCtx());
    const expectedFresh = 750_000 * (1 + 1.14 * 1.9 + 1.14 ** 2 * 1.9);
    expect(fresh).toBeCloseTo(expectedFresh, 6);
    // NFG already queued in the context: its 1.9 is already inside
    // queuedNonSoA, so no placed level may add another.
    const queued = totalCost(order, priceCtx({ queuedNonSoA: 1, neurofluxLevel: 1, queuedNeuroflux: true }));
    const expectedQueued = 750_000 * 1.9 * (1.14 + 1.14 ** 2 + 1.14 ** 3);
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

  test("the exact limit is high enough for real prerequisite-constrained sets", () => {
    // 34 augmentations have prerequisites at all; a single objective's
    // constrained portion is far below this.
    expect(EXACT_ORDER_LIMIT).toBeGreaterThanOrEqual(12);
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

  test("The Red Pill is valued for ending the BitNode, which no multiplier expresses", () => {
    expect(scoreAug(aug("The Red Pill"), {})).toBeGreaterThan(5);
  });
});

// --- objective selection ----------------------------------------------------

describe("faction selection — brute-force oracle", () => {
  function bruteForce(candidates: FactionCandidate[]): number {
    const usable = candidates.filter((c) => c.reachable && c.value > 0);
    const banned = new Map(usable.map((c) => [c.name, new Set(c.enemies)]));
    let best = 0;
    for (let mask = 0; mask < 1 << usable.length; mask++) {
      const picked: FactionCandidate[] = [];
      let ok = true;
      for (let i = 0; i < usable.length && ok; i++) {
        if ((mask & (1 << i)) === 0) continue;
        const entry = usable[i]!;
        for (const other of picked) {
          if (banned.get(entry.name)!.has(other.name) || banned.get(other.name)!.has(entry.name)) {
            ok = false;
            break;
          }
        }
        if (ok) picked.push(entry);
      }
      if (!ok) continue;
      best = Math.max(best, picked.reduce((sum, c) => sum + c.value, 0));
    }
    return best;
  }

  test("is EXACT against all 2^n subsets on seeded random graphs", () => {
    const rng = mulberry32(11);
    for (let trial = 0; trial < 60; trial++) {
      const size = 2 + Math.floor(rng() * 9); // up to 10
      const names = Array.from({ length: size }, (_, i) => `F${i}`);
      const candidates: FactionCandidate[] = names.map((name) => ({
        name,
        value: Math.round(rng() * 100) / 10,
        enemies: [],
        reachable: rng() > 0.15,
      }));
      for (let i = 0; i < size; i++) {
        for (let j = i + 1; j < size; j++) {
          if (rng() < 0.3) {
            (candidates[i]!.enemies as string[]).push(names[j]!);
          }
        }
      }
      expect(selectFactions(candidates).value).toBeCloseTo(bruteForce(candidates), 9);
    }
  });

  test("models the real city ban graph correctly", () => {
    // Sector-12/Aevum are compatible; Chongqing/New Tokyo/Ishima are
    // compatible; Volhaven excludes all five. The optimum is therefore one of
    // those three groups, never a mix.
    const city = (name: string, value: number, enemies: string[]): FactionCandidate => ({
      name,
      value,
      enemies,
      reachable: true,
    });
    const WEST = ["Sector-12", "Aevum"];
    const EAST = ["Chongqing", "New Tokyo", "Ishima"];
    const candidates: FactionCandidate[] = [
      city("Sector-12", 6, [...EAST, "Volhaven"]),
      city("Aevum", 5, [...EAST, "Volhaven"]),
      city("Chongqing", 3, [...WEST, "Volhaven"]),
      city("New Tokyo", 3, [...WEST, "Volhaven"]),
      city("Ishima", 3, [...WEST, "Volhaven"]),
      city("Volhaven", 8, [...WEST, ...EAST]),
    ];
    const result = selectFactions(candidates);
    // West = 11, East = 9, Volhaven alone = 8. The west pair wins outright,
    // and — the point of the test — a MIX is never chosen.
    expect(result.value).toBe(11);
    expect(result.chosen.sort()).toEqual(["Aevum", "Sector-12"]);
    expect(result.foreclosed.map((f) => f.name).sort()).toEqual(["Chongqing", "Ishima", "New Tokyo", "Volhaven"]);
    expect(result.approximated).toBe(false);
  });

  test("a tie is resolved deterministically, not by input order", () => {
    // Sector-12 + Aevum = 9 exactly ties the eastern trio at 3+3+3. Either is
    // optimal; what must not happen is the answer depending on iteration
    // order, because the objective would then thrash between them every tick.
    const build = (): FactionCandidate[] => [
      { name: "Sector-12", value: 5, enemies: ["Chongqing"], reachable: true },
      { name: "Aevum", value: 4, enemies: ["New Tokyo"], reachable: true },
      { name: "Chongqing", value: 5, enemies: ["Sector-12"], reachable: true },
      { name: "New Tokyo", value: 4, enemies: ["Aevum"], reachable: true },
    ];
    const forward = selectFactions(build());
    const backward = selectFactions([...build()].reverse());
    expect(forward.value).toBe(backward.value);
    expect(forward.chosen).toEqual(backward.chosen);
  });

  test("unreachable factions foreclose nothing — you never joined them", () => {
    const candidates: FactionCandidate[] = [
      { name: "A", value: 10, enemies: ["B"], reachable: false },
      { name: "B", value: 3, enemies: ["A"], reachable: true },
    ];
    const result = selectFactions(candidates);
    expect(result.chosen).toEqual(["B"]);
    expect(result.value).toBe(3);
  });

  test("foreclosedBy explains a join before it happens", () => {
    const candidates: FactionCandidate[] = [
      { name: "Sector-12", value: 5, enemies: ["Volhaven"], reachable: true },
      { name: "Volhaven", value: 8, enemies: ["Sector-12"], reachable: true },
    ];
    expect(foreclosedBy("Sector-12", candidates).map((c) => c.name)).toEqual(["Volhaven"]);
  });

  test("the exact search limit is above the real graph's largest component", () => {
    // The real ban graph's largest component is the six city factions.
    expect(EXACT_SEARCH_LIMIT).toBeGreaterThanOrEqual(6);
  });
});

// --- never attempt work a faction does not offer ------------------------------

import { stepFactions } from "../shared/strategy/factions/decide.ts";
import { factionPackageFrontier, selectFactionPackage } from "../shared/strategy/factions/packages.ts";
import { initFactionMemory } from "../shared/strategy/factions/plan.ts";
import type { FactionStanding, FactionsView } from "../shared/strategy/factions/state.ts";

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
    weights: { hacking: 1 },
    horizonSec: 3_600,
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
    expect(decision.action.why).toContain("only one activity can run");
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

  test("switches to the runner-up before an unattractive deep breakpoint", () => {
    const factions = [packageStanding("A"), packageStanding("B")];
    const catalog = new Map([
      ["A-fast", aug("A-fast", { factions: ["A"], baseCost: 0, baseRepRequirement: 100 })],
      ["A-deep", aug("A-deep", { factions: ["A"], baseCost: 0, baseRepRequirement: 1_000 })],
      ["B-next", aug("B-next", { factions: ["B"], baseCost: 0, baseRepRequirement: 200 })],
    ]);
    const world = factionsView({ factions, catalog, horizonSec: 100_000, moneyAvailable: 1e15 });
    const selection = selectFactionPackage(world, new Map(factions.map((faction) => [faction.name, []])));

    expect(selection.intent?.faction).toBe("A");
    expect(selection.intent?.repTarget).toBe(100);
    expect(selection.runnerUp?.faction).toBe("B");
  });

  test("pushes the best faction farther when switching is much worse", () => {
    const factions = [packageStanding("A"), packageStanding("B")];
    const catalog = new Map([
      ["A-fast", aug("A-fast", { factions: ["A"], baseCost: 0, baseRepRequirement: 100 })],
      ["A-deep", aug("A-deep", { factions: ["A"], baseCost: 0, baseRepRequirement: 1_000 })],
      ["B-later", aug("B-later", { factions: ["B"], baseCost: 0, baseRepRequirement: 10_000 })],
    ]);
    const world = factionsView({ factions, catalog, horizonSec: 100_000, moneyAvailable: 1e15 });
    const selection = selectFactionPackage(world, new Map(factions.map((faction) => [faction.name, []])));

    expect(selection.intent?.faction).toBe("A");
    expect(selection.intent?.repTarget).toBe(1_000);
    expect(selection.intent?.augmentations).toContain("A-deep");
  });

  test("does not count a shared augmentation again as runner-up value", () => {
    const factions = [packageStanding("A"), packageStanding("B")];
    const catalog = new Map([
      ["shared", aug("shared", { factions: ["A", "B"], baseCost: 0, baseRepRequirement: 100 })],
      ["A-unique", aug("A-unique", { factions: ["A"], baseCost: 0, baseRepRequirement: 1_000 })],
    ]);
    const world = factionsView({ factions, catalog, horizonSec: 100_000, moneyAvailable: 1e15 });
    const selection = selectFactionPackage(world, new Map(factions.map((faction) => [faction.name, []])));

    expect(selection.intent?.faction).toBe("A");
    expect(selection.intent?.repTarget).toBe(1_000);
    expect(selection.runnerUp).toBeUndefined();
  });

  test("gives The Red Pill terminal value only on the Daedalus route", () => {
    const factions = [packageStanding("Daedalus"), packageStanding("CyberSec")];
    const catalog = new Map([
      ["The Red Pill", aug("The Red Pill", { factions: ["Daedalus"], baseCost: 0, baseRepRequirement: 1_000 })],
      ["quick", aug("quick", { factions: ["CyberSec"], baseCost: 0, baseRepRequirement: 100 })],
    ]);
    const blockers = new Map(factions.map((faction) => [faction.name, []]));
    const labyrinth = selectFactionPackage(
      factionsView({ factions, catalog, route: "labyrinth", horizonSec: 100_000, moneyAvailable: 1e15 }),
      blockers,
    );
    const daedalus = selectFactionPackage(
      factionsView({ factions, catalog, route: "daedalus", horizonSec: 100_000, moneyAvailable: 1e15 }),
      blockers,
    );
    expect(labyrinth.intent?.faction).toBe("CyberSec");
    expect(daedalus.intent?.faction).toBe("Daedalus");
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

  test("keeps the pre-join stopping point when joining forecloses the runner-up", () => {
    const { firstA, firstB, catalog, first } = enemyChoice();
    expect(first.decision.objective?.intent?.repTarget).toBe(100);

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
    expect(afterJoin.decision.objective?.intent?.repTarget).toBe(100);
    expect(afterJoin.decision.objective?.intent?.augmentations).not.toContain("A-deep");
    expect(afterJoin.decision.recommendInstall?.why).toContain("favor");
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
    const afterJoin = stepFactions(
      factionsView({
        factions: [
          { ...firstA, joined: true, invited: false, rep: 100 },
          { ...firstB, invited: false },
          packageStanding("C", { rep: 1e9 }),
        ],
        catalog,
        owned: new Set(["A-fast"]),
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
        owned: new Set(["A-fast"]),
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
    expect(decision.recommendInstall).toBeDefined();
    // Unfunded, so it cannot act — but it says what the money is for.
    expect(decision.action.type).toBe("idle");
    expect(decision.nextBuy).toMatchObject({ name: NEUROFLUX });
    expect(decision.nextBuy!.price).toBeGreaterThan(0);
  });

  test("the published price is what the purchase will actually cost", () => {
    const decision = drained();
    const expected = augCost(nfg, priceCtx()).moneyCost;
    expect(decision.nextBuy!.price).toBeCloseTo(expected, 6);
  });

  test("keeps publishing while the purchase is in flight, so the claim cannot blink out", () => {
    // If `drain` only appeared on the idle tick, the claim would vanish the moment
    // a purchase was decided, un-funding the very action it authorised.
    const decision = drained({ moneyGranted: 1e9 });
    expect(decision.action).toMatchObject({ type: "purchaseAugmentation", augmentation: NEUROFLUX });
    expect(decision.nextBuy).toMatchObject({ name: NEUROFLUX });
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

  test("THE FIRST PURCHASE IS NEVER HELD — otherwise the hold cannot end", () => {
    // The livelock this closes: the market book is liquidated when `progression`
    // enters its `ending` phase, and `phaseOf` needs a non-empty install queue to
    // get there. Holding out for the book while nothing is queued waits for a
    // liquidation that the waiting itself prevents — queue stays empty, phase never
    // turns, stock never sells, the proceeds never come. Nothing else breaks the
    // cycle: `installWanted` is gated on the same empty queue, so the install
    // barrier is never even consulted.
    const bootstrap = step({ queued: new Set(), pendingProceeds: 6e8, proceedsSettling: true });
    expect(bootstrap.action).toMatchObject({ type: "purchaseAugmentation", augmentation: "cheap" });
    // ...and with one item queued the hold engages, on the very same numbers.
    const held = step({ queued: new Set(["cheap"]), pendingProceeds: 6e8, proceedsSettling: true });
    expect(held.action.type).not.toBe("purchaseAugmentation");
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
    const decision = step({
      factions: [{ ...standing("CyberSec", { hacking: true, field: true, security: true }), rep: 1e5 }],
      catalog: new Map([
        ["dear", aug("dear", { baseCost: 5e8, baseRepRequirement: 1e9, mults: { hacking: 1.01 } })],
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
